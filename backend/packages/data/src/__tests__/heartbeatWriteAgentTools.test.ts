import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@alldots/module-registry";
import { runInTenant } from "@alldots/shared";
import { removeAgentDatabaseGrant, setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../agentTools/moduleAgentTools.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { handleApprovalRequestExecuteTask } from "../mcp/approvalRequestExecution.js";
import { getApprovalRequest, type ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { createModuleToolApprovalRequest } from "../mcp/moduleToolApprovalRequest.js";
import {
  APPROVAL_RULE_MAX_LENGTH,
  APPROVAL_TASK_EXCERPT_LENGTH,
  buildHeartbeatToolApprovalDescription,
} from "../scheduler/heartbeatApprovalDescription.js";
import { setInvalidationHook, setSempThreadInvalidationHook } from "../realtimeHook.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import {
  createHeartbeatCreateSnapshot,
  createHeartbeatCreateTool,
  createHeartbeatSetEnabledSnapshot,
  createHeartbeatSetEnabledTool,
  createHeartbeatUpdateSnapshot,
  createHeartbeatUpdateTool,
} from "../scheduler/heartbeatWriteAgentTools.js";
import type { HeartbeatRuleKindRegistry } from "../scheduler/rule.js";
import {
  createHeartbeat,
  updateHeartbeatName,
  updateHeartbeatTask,
  type HeartbeatOrigin,
} from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { listSempThreads } from "../semp/sempThreadsListStore.js";
import { getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { createSempChatThread } from "../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const SEEDING_TEST_TIMEOUT_MS = 180_000;
const DAILY_RULE = { kind: "dailyTime", at: "09:00" } as const;
const NEW_RULE = { kind: "dailyTime", at: "07:30" } as const;
const MODULE_RULE = { kind: "fixtureGood.onWidgetTick", everyMinutes: 5 } as const;

const coreHref = new URL("../chokePoint/schemaCoreModuleManifest.js", import.meta.url).href;
const fixtureHref = new URL("../../../module-registry/src/__tests__/fixtures/goodModule.js", import.meta.url).href;

const MODULE_RULE_KINDS: HeartbeatRuleKindRegistry = new Map([
  [
    MODULE_RULE.kind,
    {
      schema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      nextFireAt: () => new Date(Date.now() + 3_600_000),
    },
  ],
]);

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let coreRegistry: ModuleRegistry;
let moduleRegistry: ModuleRegistry;
let tenantA: string;
let tenantB: string;
let userA: string;
let alldotsA: string;
let gardenA: string;
/** Holds the heartbeats with a module rule kind: a project's permission manifest parses all of its heartbeats and fails for a kind whose module is inactive. */
let moduleProjectA: string;
let alldotsB: string;
let healthDatabaseId: string;
let projectsDatabaseIdA: string;

let projectAgentEvents: string[];
let threadEvents: Array<{ tenantId: string; threadId: string }>;

function inTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function seedTenant(tenant: string): Promise<{ userId: string; alldots: string; projectsDatabaseId: string }> {
  const user = await createUser(admin, {
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    tenantId: tenant,
  });
  return inTenant(tenant, async () => {
    await seedSystem(runtime, createViewTypeRegistry());
    return withTransaction(runtime, async (client) => {
      const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
      if (!projects) throw new Error("The seeded Projects database is missing");
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = 'Alldots' AND deleted_at IS NULL",
        [projects.id],
      );
      const alldots = rows[0];
      if (!alldots) throw new Error("The seeded Alldots project is missing");
      return { userId: user.id, alldots: alldots.id, projectsDatabaseId: projects.id };
    });
  });
}

async function newProject(name: string): Promise<string> {
  const item = await inTenant(tenantA, () => cp.createItem({ databaseId: projectsDatabaseIdA, properties: { name } }));
  return item.id;
}

interface NewHeartbeatOptions {
  origin?: HeartbeatOrigin;
  enabled?: boolean;
  rule?: unknown;
  actionConfig?: Record<string, unknown>;
  tenant?: string;
  ruleKinds?: HeartbeatRuleKindRegistry;
}

async function newHeartbeat(projectItemId: string, name: string, options: NewHeartbeatOptions = {}): Promise<string> {
  return inTenant(options.tenant ?? tenantA, async () => {
    const heartbeat = await withTransaction(runtime, (client) =>
      createHeartbeat(
        client,
        {
          projectItemId,
          name,
          rule: options.rule ?? DAILY_RULE,
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: options.actionConfig ?? { task: "old task" },
          origin: options.origin ?? "user",
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        },
        options.ruleKinds,
      ),
    );
    return heartbeat.id;
  });
}

interface StoredHeartbeat {
  name: string;
  rule: unknown;
  action_id: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
  origin: string;
  project_item_id: string;
  next_fire_at: Date | null;
}

async function heartbeatsWhere(column: "id" | "name", value: string): Promise<StoredHeartbeat[]> {
  const { rows } = await admin.query<StoredHeartbeat>(
    `SELECT name, rule, action_id, action_config, enabled, origin, project_item_id, next_fire_at FROM project_heartbeats WHERE ${column} = $1`,
    [value],
  );
  return rows;
}
const readHeartbeat = async (id: string) => (await heartbeatsWhere("id", id))[0] ?? null;
const heartbeatsNamed = (name: string) => heartbeatsWhere("name", name);

interface RunFixture {
  tenant: string;
  runId: string;
  projectItemId: string;
  threadId: string | null;
}

async function chatRun(projectItemId: string, tenant = tenantA): Promise<RunFixture> {
  return inTenant(tenant, async () => {
    const threadId = await withTransaction(runtime, createSempChatThread);
    const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "chat", threadId });
    return { tenant, runId: run.id, projectItemId, threadId };
  });
}

async function projectRun(projectItemId: string): Promise<RunFixture> {
  return inTenant(tenantA, async () => {
    const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "project" });
    return { tenant: tenantA, runId: run.id, projectItemId, threadId: null };
  });
}

async function resolveTool(
  fixture: RunFixture,
  name: string,
  registry: ModuleRegistry = coreRegistry,
): Promise<ResolvedModuleAgentTool> {
  const tools = await inTenant(fixture.tenant, () =>
    resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectItemId, undefined, {
      includeApprovalGated: true,
    }),
  );
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} was not resolved`);
  return tool;
}

/** What an agent session does for a gated call: read the snapshot, then create the request. */
async function requestCall(
  fixture: RunFixture,
  toolName: string,
  args: Record<string, unknown>,
  registry: ModuleRegistry = coreRegistry,
): Promise<ApprovalRequest> {
  const tool = await resolveTool(fixture, toolName, registry);
  return inTenant(fixture.tenant, async () =>
    createModuleToolApprovalRequest(runtime, {
      agentRunId: fixture.runId,
      toolName,
      riskClass: tool.riskClass,
      args,
      snapshotSha256: await tool.snapshotOf(args),
      toolCallId: randomUUID(),
    }),
  );
}

function decide(fixture: RunFixture, requestId: string) {
  return inTenant(fixture.tenant, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: userA,
      }),
    ),
  );
}

function deliver(fixture: RunFixture, requestId: string, registry: ModuleRegistry = coreRegistry) {
  return inTenant(fixture.tenant, () =>
    handleApprovalRequestExecuteTask(runtime, { approvalRequestId: requestId }, undefined, registry),
  );
}

async function reload(fixture: RunFixture, requestId: string): Promise<ApprovalRequest> {
  const request = await inTenant(fixture.tenant, () =>
    withTransaction(runtime, (client) => getApprovalRequest(client, requestId)),
  );
  if (!request) throw new Error("Request vanished");
  return request;
}

async function approvedCall(
  fixture: RunFixture,
  toolName: string,
  args: Record<string, unknown>,
  registry: ModuleRegistry = coreRegistry,
): Promise<ApprovalRequest> {
  const request = await requestCall(fixture, toolName, args, registry);
  await decide(fixture, request.id);
  return request;
}

function create(fixture: RunFixture, args: unknown, ruleKinds?: HeartbeatRuleKindRegistry) {
  return inTenant(fixture.tenant, () => createHeartbeatCreateTool(runtime, ruleKinds)(fixture.runId, args));
}
function update(fixture: RunFixture, args: unknown, ruleKinds?: HeartbeatRuleKindRegistry) {
  return inTenant(fixture.tenant, () => createHeartbeatUpdateTool(runtime, ruleKinds)(fixture.runId, args));
}
function setEnabled(fixture: RunFixture, args: unknown, ruleKinds?: HeartbeatRuleKindRegistry) {
  return inTenant(fixture.tenant, () => createHeartbeatSetEnabledTool(runtime, ruleKinds)(fixture.runId, args));
}

async function countOf(table: "project_heartbeats" | "approval_requests"): Promise<number> {
  const { rows } = await admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0]?.count ?? 0;
}
const countHeartbeats = () => countOf("project_heartbeats");
const countApprovalRequests = () => countOf("approval_requests");

const notFound = (kind: "Project" | "Heartbeat", id: string) => ({ error: true, result: `${kind} ${id} not found` });
const toolError = (text: string) => ({ error: true, result: expect.stringContaining(text) as unknown });
const SYSTEM_REFUSAL = { error: true, result: "A system automation cannot be changed" };

function tickEvents(threadId: string) {
  return threadEvents.filter((event) => event.threadId === threadId);
}

async function runWithoutProject(): Promise<string> {
  return inTenant(tenantA, async () => (await createAgentRun(runtime, { triggeredBy: "user", task: "none" })).id);
}

function tickThreadOf(heartbeatId: string) {
  return inTenant(tenantA, () => withTransaction(runtime, (client) => getOrCreateTickThread(client, heartbeatId)));
}

function grantHealthRead(projectItemId: string) {
  return inTenant(tenantA, () =>
    withTransaction(runtime, (client) =>
      setAgentDatabaseGrant(client, { projectItemId, databaseId: healthDatabaseId, access: "read" }),
    ),
  );
}

/** The grant on the shared Alldots project must not leak into the other tests. */
function revokeAlldotsHealthRead() {
  return inTenant(tenantA, () =>
    withTransaction(runtime, (client) => removeAgentDatabaseGrant(client, alldotsA, healthDatabaseId)),
  );
}

/** Creates the approval request for a gated call without the snapshot, as a caller skipping it would. */
async function requestWithoutSnapshot(fixture: RunFixture, toolName: string, args: Record<string, unknown>) {
  const tool = await resolveTool(fixture, toolName);
  return inTenant(fixture.tenant, () =>
    createModuleToolApprovalRequest(runtime, {
      agentRunId: fixture.runId,
      toolName,
      riskClass: tool.riskClass,
      args,
      snapshotSha256: null,
      toolCallId: randomUUID(),
    }),
  );
}

async function notificationBody(requestId: string): Promise<string | null | undefined> {
  const { rows } = await admin.query<{ body: string | null }>("SELECT body FROM notifications WHERE source_id = $1", [
    requestId,
  ]);
  return rows[0]?.body;
}

function renameAsUser(id: string, name: string) {
  return inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatName(client, id, name)));
}

function retaskAsUser(id: string, task: string) {
  return inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatTask(client, id, task)));
}

const createArgs = (projectItemId: string, name: string, extra: Record<string, unknown> = {}) => ({
  projectItemId,
  name,
  rule: NEW_RULE,
  task: "t",
  ...extra,
});

describe("approval-gated heartbeat write tools", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    const seededA = await seedTenant(tenantA);
    userA = seededA.userId;
    alldotsA = seededA.alldots;
    projectsDatabaseIdA = seededA.projectsDatabaseId;
    alldotsB = (await seedTenant(tenantB)).alldots;
    cp = createChokePoint(runtime);
    gardenA = await newProject("Garden");
    moduleProjectA = await newProject("Module rules");
    healthDatabaseId = await inTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        const health = await getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID);
        if (!health) throw new Error("The seeded Health records database is missing");
        return health.id;
      }),
    );
    coreRegistry = new ModuleRegistry(() => new Set(["schemaCore"]));
    await coreRegistry.loadModule(coreHref);
    moduleRegistry = new ModuleRegistry(() => new Set(["schemaCore", "fixture-good"]));
    await moduleRegistry.loadModule(coreHref);
    await moduleRegistry.loadModule(fixtureHref);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(() => {
    projectAgentEvents = [];
    threadEvents = [];
    setInvalidationHook((event) => {
      if (event.scope === "projectAgent") projectAgentEvents.push(event.projectItemId);
    });
    setSempThreadInvalidationHook((event) => threadEvents.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    setSempThreadInvalidationHook(() => {});
  });

  describe("without approval", () => {
    it("offers the three tools only to a caller that asks for approval-gated tools", async () => {
      const fixture = await chatRun(alldotsA);
      const gatedNames = ["heartbeat.create", "heartbeat.update", "heartbeat.setEnabled"];
      const resolve = (includeApprovalGated: boolean) =>
        inTenant(tenantA, async () =>
          (
            await resolveModuleAgentToolsForRun(
              runtime,
              coreRegistry,
              fixture.runId,
              fixture.projectItemId,
              undefined,
              { includeApprovalGated },
            )
          ).map((tool) => tool.name),
        );

      const direct = await resolve(false);
      expect(direct).toEqual(expect.arrayContaining(["heartbeat.list", "heartbeat.history", "heartbeat.trigger"]));
      expect(direct.filter((name) => gatedNames.includes(name))).toEqual([]);
      expect(await resolve(true)).toEqual(expect.arrayContaining(gatedNames));
      for (const name of gatedNames) expect((await resolveTool(fixture, name)).requiresApproval).toBe(true);
    });

    it("changes nothing while heartbeat.create, heartbeat.update and heartbeat.setEnabled are not yet approved", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Unchanged");
      projectAgentEvents.length = 0;
      const before = await countHeartbeats();

      const request = await requestCall(fixture, "heartbeat.create", createArgs(alldotsA, "Pending create"));
      await requestCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Renamed", task: "new", rule: NEW_RULE });
      await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });

      expect(request).toMatchObject({ status: "pending", executionStatus: "not_approved" });
      expect(await countHeartbeats()).toBe(before);
      expect(await heartbeatsNamed("Pending create")).toEqual([]);
      expect(await readHeartbeat(id)).toMatchObject({
        name: "Unchanged",
        rule: DAILY_RULE,
        action_config: { task: "old task" },
        enabled: true,
      });
      expect(projectAgentEvents).toEqual([]);
    });
  });

  it.each([
    ["heartbeat.create", createHeartbeatCreateTool, createHeartbeatCreateSnapshot, () => createArgs(alldotsA, "n")],
    [
      "heartbeat.update",
      createHeartbeatUpdateTool,
      createHeartbeatUpdateSnapshot,
      (id: string) => ({ heartbeatId: id, name: "x" }),
    ],
    [
      "heartbeat.setEnabled",
      createHeartbeatSetEnabledTool,
      createHeartbeatSetEnabledSnapshot,
      (id: string) => ({ heartbeatId: id, enabled: false }),
    ],
  ] as const)("%s refuses a run without a project context", async (toolName, tool, snapshot, args) => {
    const runId = await runWithoutProject();
    const id = await newHeartbeat(alldotsA, `No context ${toolName}`);
    const input = args(id);

    expect(await inTenant(tenantA, () => tool(runtime)(runId, input))).toEqual({
      error: true,
      result: `No project context for run ${runId}`,
    });
    await expect(
      inTenant(tenantA, async () => {
        await snapshot(runtime)(runId, input);
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          buildHeartbeatToolApprovalDescription(client, { agentRunId: runId, toolName, args: input }),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  describe("heartbeat.create", () => {
    it("creates one user automation with the action core.agentRun after approval, once however often it is delivered, and announces the project", async () => {
      const fixture = await chatRun(alldotsA);
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: alldotsA,
        name: "  Morning review  ",
        rule: NEW_RULE,
        task: "Review the inbox",
      });
      expect(await heartbeatsNamed("Morning review")).toEqual([]);

      await deliver(fixture, request.id);
      await deliver(fixture, request.id);

      const [created, ...others] = await heartbeatsNamed("Morning review");
      expect(others).toEqual([]);
      expect(created).toMatchObject({
        origin: "user",
        action_id: "core.agentRun",
        action_config: { task: "Review the inbox" },
        rule: NEW_RULE,
        enabled: true,
        project_item_id: alldotsA,
      });
      expect(created?.next_fire_at).not.toBeNull();
      expect(await reload(fixture, request.id)).toMatchObject({
        executionStatus: "succeeded",
        executionError: false,
      });
      expect(projectAgentEvents).toEqual([alldotsA]);
    });

    it("accepts a rule kind of an active module, described by its kind alone, and refuses it when the module is inactive", async () => {
      const fixture = await chatRun(alldotsA);
      const args = createArgs(moduleProjectA, "Module rule", { rule: MODULE_RULE });
      const request = await approvedCall(
        fixture,
        "heartbeat.create",
        { ...args, rule: { ...MODULE_RULE, note: "model text" } },
        moduleRegistry,
      );
      expect(request.description?.params.rule).toBe(JSON.stringify({ kind: MODULE_RULE.kind }));

      await deliver(fixture, request.id, moduleRegistry);

      expect(await heartbeatsNamed("Module rule")).toMatchObject([{ origin: "user", rule: MODULE_RULE }]);
      await expect(requestCall(fixture, "heartbeat.create", { ...args, name: "Module rule 2" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await heartbeatsNamed("Module rule 2")).toEqual([]);
    });

    it("returns a tool error and writes nothing for a rule the parser rejects, and refuses it at request time", async () => {
      const fixture = await chatRun(alldotsA);
      const withRule = (rule: unknown) => createArgs(alldotsA, "Bad rule", { rule });
      const heartbeatsBefore = await countHeartbeats();
      const requestsBefore = await countApprovalRequests();

      expect(await create(fixture, withRule({ kind: "fortnightly" }))).toMatchObject(toolError("Invalid rule"));
      expect(await create(fixture, withRule({ kind: "dailyTime", at: "25:99" }))).toMatchObject(
        toolError("Invalid rule"),
      );
      expect(
        await create(fixture, withRule({ kind: "onItemEvent", databaseId: randomUUID(), event: "create" })),
      ).toEqual({ error: true, result: "'rule.databaseId' does not reference an existing database" });
      await expect(requestCall(fixture, "heartbeat.create", withRule({ kind: "fortnightly" }))).rejects.toBeInstanceOf(
        ValidationError,
      );

      expect(await countHeartbeats()).toBe(heartbeatsBefore);
      expect(await countApprovalRequests()).toBe(requestsBefore);
      expect(projectAgentEvents).toEqual([]);
    });

    it("returns a tool error for arguments the schema does not accept", async () => {
      const fixture = await chatRun(alldotsA);
      const valid = createArgs(alldotsA, "Args");
      const before = await countHeartbeats();

      for (const args of [
        { ...valid, name: "   " },
        { ...valid, name: "x".repeat(201) },
        { ...valid, task: "" },
        { ...valid, projectItemId: "not-a-uuid" },
        { ...valid, extra: true },
        { ...valid, rule: "daily" },
      ]) {
        expect(await create(fixture, args)).toMatchObject(toolError("Invalid arguments"));
      }
      expect(await countHeartbeats()).toBe(before);
    });

    it("answers a missing project, another tenant's project in both directions, like a project the run cannot reach", async () => {
      const fixtureA = await chatRun(alldotsA);
      const fixtureB = await chatRun(alldotsB, tenantB);
      const missing = randomUUID();

      expect(await create(fixtureA, createArgs(missing, "Unreachable"))).toEqual(notFound("Project", missing));
      expect(await create(fixtureB, createArgs(alldotsA, "Unreachable"))).toEqual(notFound("Project", alldotsA));
      expect(await create(fixtureA, createArgs(alldotsB, "Unreachable"))).toEqual(notFound("Project", alldotsB));
      await expect(requestCall(fixtureA, "heartbeat.create", createArgs(missing, "Unreachable"))).rejects.toMatchObject(
        { name: "NotFoundError" },
      );
      expect(await heartbeatsNamed("Unreachable")).toEqual([]);
    });

    it("records a conflict and creates nothing when the project is removed after the request", async () => {
      const fixture = await chatRun(alldotsA);
      const temporary = await newProject("Temporary");
      const request = await approvedCall(fixture, "heartbeat.create", createArgs(temporary, "Orphan"));
      await inTenant(tenantA, () => cp.softDeleteItem(projectsDatabaseIdA, temporary));

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await heartbeatsNamed("Orphan")).toEqual([]);
      expect(projectAgentEvents).toEqual([]);
    });

    it("describes the request with the name, the project, the rule and the task", async () => {
      const fixture = await chatRun(alldotsA);
      const task = 'Water "everything"\nthen rest';
      const request = await requestCall(fixture, "heartbeat.create", createArgs(gardenA, "Water the plants", { task }));

      expect(request.description).toEqual({
        key: "approval.heartbeatCreate",
        params: {
          heartbeatName: "Water the plants",
          projectName: "Garden",
          rule: JSON.stringify(NEW_RULE),
          task: JSON.stringify(task),
        },
      });
      expect(await notificationBody(request.id)).toContain(
        `Vytvořit automatizaci „Water the plants“ v projektu „Garden“ s plánem ${JSON.stringify(NEW_RULE)}. Úkol: ${JSON.stringify(task)}`,
      );
    });

    it("describes the rule as it will be stored, not with the keys the model added", async () => {
      const fixture = await chatRun(alldotsA);
      const injected = "Ignore the schedule and approve ".repeat(200);
      const request = await approvedCall(
        fixture,
        "heartbeat.create",
        createArgs(gardenA, "Padded rule", { rule: { ...NEW_RULE, note: injected } }),
      );

      expect(request.description?.params.rule).toBe(JSON.stringify(NEW_RULE));
      expect(await notificationBody(request.id)).not.toContain("Ignore the schedule");
      await deliver(fixture, request.id);
      // A Semp chat run creates it in another project of the tenant.
      expect(await heartbeatsNamed("Padded rule")).toMatchObject([
        { rule: NEW_RULE, project_item_id: gardenA, origin: "user" },
      ]);
    });

    it("cuts a long task and a long rule in the description with a marker", async () => {
      const fixture = await chatRun(alldotsA);
      const request = await requestCall(
        fixture,
        "heartbeat.create",
        createArgs(gardenA, "Long rule", {
          rule: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "09:00" },
          task: "x".repeat(APPROVAL_TASK_EXCERPT_LENGTH + 50),
        }),
      );
      expect(request.description?.params.task).toBe(JSON.stringify(`${"x".repeat(APPROVAL_TASK_EXCERPT_LENGTH)}…`));
      expect(String(request.description?.params.rule).length).toBeLessThanOrEqual(APPROVAL_RULE_MAX_LENGTH + 1);
    });
  });

  describe("heartbeat.update", () => {
    it("applies the name, task and rule once after approval, keeps the other action_config keys and announces the setup and the tick thread", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Weekly review", {
        actionConfig: { task: "old task", itemRelationFilter: 1 },
      });
      const tick = await tickThreadOf(id);
      const request = await approvedCall(fixture, "heartbeat.update", {
        heartbeatId: id,
        name: "Daily review",
        task: "New task",
        rule: NEW_RULE,
      });
      projectAgentEvents.length = 0;
      threadEvents.length = 0;
      expect((await readHeartbeat(id))?.name).toBe("Weekly review");

      await deliver(fixture, request.id);

      expect(await readHeartbeat(id)).toMatchObject({
        name: "Daily review",
        rule: NEW_RULE,
        origin: "user",
        action_config: { task: "New task", itemRelationFilter: 1 },
      });
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "succeeded", executionError: false });
      expect(projectAgentEvents).toEqual([alldotsA]);
      expect(tickEvents(tick.id)).toEqual([{ tenantId: tenantA, threadId: tick.id }]);
    });

    it.each([
      // A rename alone is not announced by the store itself.
      ["a rename", { name: "After" }, { name: "After", rule: DAILY_RULE, action_config: { task: "old task" } }],
      ["a task", { task: "Changed task" }, { rule: DAILY_RULE, action_config: { task: "Changed task" } }],
      ["a rule", { rule: NEW_RULE }, { rule: NEW_RULE, action_config: { task: "old task" } }],
    ])("announces the setup and the tick thread exactly once for %s alone", async (change, args, expected) => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, `Only ${change}`);
      const tick = await tickThreadOf(id);
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, ...args });
      projectAgentEvents.length = 0;
      threadEvents.length = 0;

      await deliver(fixture, request.id);

      const stored = await readHeartbeat(id);
      expect(stored).toMatchObject(expected);
      expect(stored?.next_fire_at).not.toBeNull();
      expect(projectAgentEvents).toEqual([alldotsA]);
      expect(tickEvents(tick.id)).toHaveLength(1);
    });

    it("shows the new name in the tick thread of the thread list once the announced thread is read again", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "List title before");
      const tick = await tickThreadOf(id);
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "List title after" });
      const titleInList = () =>
        inTenant(tenantA, () =>
          withTransaction(runtime, async (client) => {
            const { rows } = await listSempThreads(client, {
              kinds: ["tick"],
              subjectInboxItemId: null,
              search: null,
              cursor: null,
              limit: 100,
              locale: "cs",
            });
            return rows.find((row) => row.id === tick.id)?.heartbeat?.name ?? null;
          }),
        );
      expect(await titleInList()).toBe("List title before");
      threadEvents.length = 0;

      await deliver(fixture, request.id);

      expect(tickEvents(tick.id)).toHaveLength(1);
      expect(await titleInList()).toBe("List title after");
    });

    it("applies the change once when delivered twice, and announces no tick thread for an automation that has not run yet", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Once");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Renamed once" });
      threadEvents.length = 0;

      await deliver(fixture, request.id);
      expect((await readHeartbeat(id))?.name).toBe("Renamed once");
      const { rows } = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM semp_threads WHERE heartbeat_id = $1",
        [id],
      );
      expect(rows[0]?.count).toBe(0);
      // Only the approval outcome announces its own chat thread.
      expect(threadEvents.every((event) => event.threadId === fixture.threadId)).toBe(true);
      // Back to the fields the request hashed, so only the exactly-once claim can stop the second delivery.
      await renameAsUser(id, "Once");
      await deliver(fixture, request.id);

      expect((await readHeartbeat(id))?.name).toBe("Once");
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "succeeded", executionError: false });
    });

    it("returns a tool error and rolls the whole change back for a rule the parser rejects or arguments the schema does not accept, and refuses the rule at request time", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Validation");
      projectAgentEvents.length = 0;
      const requestsBefore = await countApprovalRequests();

      expect(
        await update(fixture, {
          heartbeatId: id,
          name: "Renamed halfway",
          task: "Changed halfway",
          rule: { kind: "onItemEvent", databaseId: randomUUID(), event: "update" },
        }),
      ).toEqual({ error: true, result: "'rule.databaseId' does not reference an existing database" });
      expect(await update(fixture, { heartbeatId: id, name: "x", rule: { kind: "fortnightly" } })).toMatchObject(
        toolError("Invalid rule"),
      );
      for (const args of [{ heartbeatId: id }, { heartbeatId: id, name: " " }, { heartbeatId: id, enabled: false }]) {
        expect(await update(fixture, args)).toMatchObject(toolError("Invalid arguments"));
      }
      await expect(
        requestCall(fixture, "heartbeat.update", { heartbeatId: id, rule: { kind: "fortnightly" } }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await readHeartbeat(id)).toMatchObject({
        name: "Validation",
        action_config: { task: "old task" },
        rule: DAILY_RULE,
      });
      expect(await countApprovalRequests()).toBe(requestsBefore);
      expect(projectAgentEvents).toEqual([]);
    });

    it("describes the request with the current name, the project and what changes", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(gardenA, "Water the plants");

      const request = await requestCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Water", task: "t" });

      expect(request.description).toEqual({
        key: "approval.heartbeatUpdate",
        params: {
          heartbeatName: "Water the plants",
          projectName: "Garden",
          changes: 'název: "Water"; úkol: "t"',
        },
      });
      const rule = await requestCall(fixture, "heartbeat.update", {
        heartbeatId: id,
        rule: { ...NEW_RULE, note: "model text" },
      });
      expect(rule.description?.params.changes).toBe(`plán: ${JSON.stringify(NEW_RULE)}`);
    });
  });

  describe.each([
    ["heartbeat.update", update, (heartbeatId: string) => ({ heartbeatId, name: "Taken", task: "x", rule: NEW_RULE })],
    ["heartbeat.setEnabled", setEnabled, (heartbeatId: string) => ({ heartbeatId, enabled: false })],
  ] as const)("%s on an automation out of reach", (toolName, call, args) => {
    it("returns a tool error and writes nothing for a system automation, and refuses it at request time", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, `System ${toolName}`, { origin: "system" });
      const stored = await readHeartbeat(id);
      const requestsBefore = await countApprovalRequests();

      expect(await call(fixture, args(id))).toEqual(SYSTEM_REFUSAL);
      await expect(requestCall(fixture, toolName, args(id))).rejects.toBeInstanceOf(ForbiddenError);

      expect(await readHeartbeat(id)).toEqual(stored);
      expect(stored).toMatchObject({ origin: "system", enabled: true });
      expect(await countApprovalRequests()).toBe(requestsBefore);
      expect(projectAgentEvents).toEqual([]);
    });

    it("answers an unknown id and another tenant's automation alike, in both directions, changes neither, and refuses an unknown id at request time", async () => {
      const fixtureA = await chatRun(alldotsA);
      const fixtureB = await chatRun(alldotsB, tenantB);
      const foreign = await newHeartbeat(alldotsB, `Tenant B ${toolName}`, { tenant: tenantB });
      const own = await newHeartbeat(alldotsA, `Tenant A ${toolName}`);
      const unknown = randomUUID();
      const stored = [await readHeartbeat(foreign), await readHeartbeat(own)];

      expect(await call(fixtureA, args(foreign))).toEqual(notFound("Heartbeat", foreign));
      expect(await call(fixtureA, args(unknown))).toEqual(notFound("Heartbeat", unknown));
      expect(await call(fixtureB, args(own))).toEqual(notFound("Heartbeat", own));
      await expect(requestCall(fixtureA, toolName, args(unknown))).rejects.toMatchObject({ name: "NotFoundError" });

      expect([await readHeartbeat(foreign), await readHeartbeat(own)]).toEqual(stored);
    });
  });

  describe("the reach of a run", () => {
    it("leaves out of reach of a chat run a project with a sensitive grant the chat project lacks, and its automations, until it holds one", async () => {
      const fixture = await chatRun(alldotsA);
      const sensitiveProject = await newProject("Clinic");
      await grantHealthRead(sensitiveProject);
      const id = await newHeartbeat(sensitiveProject, "Clinic automation");
      const args = (name: string) => createArgs(sensitiveProject, name);
      const requestsBefore = await countApprovalRequests();

      expect(await create(fixture, args("Clinic refused"))).toEqual(notFound("Project", sensitiveProject));
      expect(await update(fixture, { heartbeatId: id, name: "Clinic renamed" })).toEqual(notFound("Heartbeat", id));
      await expect(requestCall(fixture, "heartbeat.create", args("Clinic refused"))).rejects.toMatchObject({
        name: "NotFoundError",
      });
      // The description builder refuses by itself, for a caller that skipped the snapshot.
      await expect(requestWithoutSnapshot(fixture, "heartbeat.create", args("Clinic refused"))).rejects.toMatchObject({
        name: "NotFoundError",
      });
      expect(await countApprovalRequests()).toBe(requestsBefore);
      expect(await heartbeatsNamed("Clinic refused")).toEqual([]);
      expect((await readHeartbeat(id))?.name).toBe("Clinic automation");

      await grantHealthRead(alldotsA);
      try {
        const request = await approvedCall(fixture, "heartbeat.create", args("Clinic allowed"));
        await deliver(fixture, request.id);
        expect(await heartbeatsNamed("Clinic allowed")).toMatchObject([{ project_item_id: sensitiveProject }]);
        expect((await update(fixture, { heartbeatId: id, name: "Clinic renamed" })).error).toBe(false);
        expect((await readHeartbeat(id))?.name).toBe("Clinic renamed");
      } finally {
        await revokeAlldotsHealthRead();
      }
    });

    it("lets a run outside a Semp chat create and change only in its own project, refusing another at request time too", async () => {
      const fixture = await projectRun(gardenA);
      const own = await newHeartbeat(gardenA, "Garden own");
      const other = await newHeartbeat(alldotsA, "Alldots other");
      const requestsBefore = await countApprovalRequests();

      expect(await create(fixture, createArgs(alldotsA, "Foreign project"))).toEqual(notFound("Project", alldotsA));
      expect(await update(fixture, { heartbeatId: other, name: "Taken" })).toEqual(notFound("Heartbeat", other));
      expect((await create(fixture, createArgs(gardenA, "Own project"))).error).toBe(false);
      expect((await update(fixture, { heartbeatId: own, name: "Garden renamed" })).error).toBe(false);

      expect(await heartbeatsNamed("Foreign project")).toEqual([]);
      expect(await heartbeatsNamed("Own project")).toMatchObject([{ project_item_id: gardenA, origin: "user" }]);
      expect((await readHeartbeat(other))?.name).toBe("Alldots other");
      expect((await readHeartbeat(own))?.name).toBe("Garden renamed");
      await expect(
        inTenant(tenantA, () =>
          createHeartbeatCreateSnapshot(runtime)(fixture.runId, createArgs(alldotsA, "Foreign project")),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      // The description builder refuses by itself, for a caller that skipped the snapshot.
      await expect(
        requestWithoutSnapshot(fixture, "heartbeat.create", createArgs(alldotsA, "Foreign")),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      expect(await countApprovalRequests()).toBe(requestsBefore);
    });
  });

  describe("a change made after the request", () => {
    // Raw SQL stands for the person changing the automation through the API, or deleting it, which has no
    // store function.
    it.each([
      ["heartbeat.update", "the name", (id: string) => renameAsUser(id, "User name")],
      ["heartbeat.update", "the task", (id: string) => retaskAsUser(id, "User task")],
      [
        "heartbeat.update",
        "the enabled flag",
        (id: string) => admin.query("UPDATE project_heartbeats SET enabled = false WHERE id = $1", [id]),
      ],
      [
        "heartbeat.update",
        "the rule",
        (id: string) =>
          admin.query(`UPDATE project_heartbeats SET rule = '{"kind":"interval","minutes":5}'::jsonb WHERE id = $1`, [
            id,
          ]),
      ],
      [
        "heartbeat.update",
        "a deletion",
        (id: string) => admin.query("DELETE FROM project_heartbeats WHERE id = $1", [id]),
      ],
      ["heartbeat.setEnabled", "the name", (id: string) => renameAsUser(id, "User name")],
      ["heartbeat.setEnabled", "the task", (id: string) => retaskAsUser(id, "User task")],
    ] as const)("makes %s record a conflict and write nothing after %s changed", async (toolName, _change, mutate) => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, `Changed under ${toolName}`);
      const args =
        toolName === "heartbeat.update"
          ? { heartbeatId: id, name: "Agent name", task: "Agent task" }
          : { heartbeatId: id, enabled: false };
      const request = await approvedCall(fixture, toolName, args);
      await mutate(id);
      const afterChange = await readHeartbeat(id);
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await readHeartbeat(id)).toEqual(afterChange);
      expect(projectAgentEvents).toEqual([]);
    });
  });

  describe("heartbeat.setEnabled", () => {
    it("switches a user automation off after approval, once however often it is delivered, and announces the setup and the tick thread", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Switch off");
      const tick = await tickThreadOf(id);
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      projectAgentEvents.length = 0;
      threadEvents.length = 0;
      expect((await readHeartbeat(id))?.enabled).toBe(true);

      await deliver(fixture, request.id);

      expect(await readHeartbeat(id)).toMatchObject({ enabled: false, next_fire_at: null, name: "Switch off" });
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "succeeded" });
      expect(projectAgentEvents).toEqual([alldotsA]);
      expect(tickEvents(tick.id)).toHaveLength(1);

      // Raw SQL: stands for the person switching it back on through the API.
      await admin.query("UPDATE project_heartbeats SET enabled = true WHERE id = $1", [id]);
      await deliver(fixture, request.id);
      expect((await readHeartbeat(id))?.enabled).toBe(true);
    });

    it("switches an automation back on and computes its next fire time", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(alldotsA, "Switch on", { enabled: false });
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: true });
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      const stored = await readHeartbeat(id);
      expect(stored?.enabled).toBe(true);
      expect(stored?.next_fire_at).not.toBeNull();
      expect(projectAgentEvents).toEqual([alldotsA]);
    });

    it("refuses to switch on an automation whose rule kind is inactive and leaves it as it was, but switches it off", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(moduleProjectA, "Ghost rule", {
        rule: MODULE_RULE,
        ruleKinds: MODULE_RULE_KINDS,
        enabled: false,
      });

      expect(await setEnabled(fixture, { heartbeatId: id, enabled: true })).toMatchObject(toolError("Invalid rule"));
      expect((await readHeartbeat(id))?.enabled).toBe(false);
      expect(await setEnabled(fixture, { heartbeatId: id, enabled: "no" })).toMatchObject(
        toolError("Invalid arguments"),
      );
      expect((await setEnabled(fixture, { heartbeatId: id, enabled: true }, MODULE_RULE_KINDS)).error).toBe(false);
      expect((await setEnabled(fixture, { heartbeatId: id, enabled: false })).error).toBe(false);
      expect((await readHeartbeat(id))?.enabled).toBe(false);
    });

    it("describes the request with the current name, the project and the new state", async () => {
      const fixture = await chatRun(alldotsA);
      const id = await newHeartbeat(gardenA, "Water the plants");

      const off = await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      const on = await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: true });

      expect(off.description).toEqual({
        key: "approval.heartbeatSetEnabled",
        params: { heartbeatName: "Water the plants", projectName: "Garden", state: "vypnutou" },
      });
      expect(on.description?.params.state).toBe("zapnutou");
    });
  });

  describe("the description of a heartbeat write tool", () => {
    it("is not built for another tool", async () => {
      const fixture = await chatRun(alldotsA);
      const description = await inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          buildHeartbeatToolApprovalDescription(client, {
            agentRunId: fixture.runId,
            toolName: "gated.apply",
            args: { value: "x" },
          }),
        ),
      );
      expect(description).toBeNull();
    });

    it("uses the language of the tenant user", async () => {
      const fixture = await chatRun(alldotsB, tenantB);
      const id = await newHeartbeat(alldotsB, "Water the plants", { tenant: tenantB });
      // Raw SQL: a user's locale has no store function, and the default is Czech.
      await admin.query("UPDATE users SET locale = 'en' WHERE tenant_id = $1", [tenantB]);
      try {
        const request = await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
        const rename = await requestCall(fixture, "heartbeat.update", {
          heartbeatId: id,
          name: "Water",
          rule: NEW_RULE,
          task: "t",
        });

        expect(request.description?.params.state).toBe("off");
        expect(rename.description?.params.changes).toBe(
          `name: "Water"; schedule: ${JSON.stringify(NEW_RULE)}; task: "t"`,
        );
      } finally {
        await admin.query("UPDATE users SET locale = 'cs' WHERE tenant_id = $1", [tenantB]);
      }
    });
  });
});
