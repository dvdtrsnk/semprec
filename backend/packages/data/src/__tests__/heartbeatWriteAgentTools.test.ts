import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
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

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 180_000;
const DAILY_RULE = { kind: "dailyTime", at: "09:00" } as const;
const NEW_RULE = { kind: "dailyTime", at: "07:30" } as const;
const MODULE_RULE = { kind: "fixtureGood.onWidgetTick", everyMinutes: 5 } as const;

const coreHref = new URL("../chokePoint/schemaCoreModuleManifest.js", import.meta.url).href;
const fixtureHref = new URL("../../../module-registry/src/__tests__/fixtures/goodModule.js", import.meta.url).href;

/** The kind the `fixture-good` module declares, as `resolveModuleAgentToolsForRun` hands it to a tool. */
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
let semprecA: string;
let gardenA: string;
/** Holds the heartbeats with a module rule kind: a project's permission manifest parses all of its heartbeats and fails for a kind whose module is inactive. */
let moduleProjectA: string;
let semprecB: string;
let healthDatabaseId: string;
let projectsDatabaseIdA: string;

let projectAgentEvents: string[];
let threadEvents: Array<{ tenantId: string; threadId: string }>;

function inTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function seedTenant(tenant: string): Promise<{ userId: string; semprec: string; projectsDatabaseId: string }> {
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
        "SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = 'Semprec' AND deleted_at IS NULL",
        [projects.id],
      );
      const semprec = rows[0];
      if (!semprec) throw new Error("The seeded Semprec project is missing");
      return { userId: user.id, semprec: semprec.id, projectsDatabaseId: projects.id };
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

async function readHeartbeat(id: string): Promise<StoredHeartbeat | null> {
  const { rows } = await admin.query<StoredHeartbeat>(
    "SELECT name, rule, action_id, action_config, enabled, origin, project_item_id, next_fire_at FROM project_heartbeats WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function heartbeatsNamed(name: string): Promise<StoredHeartbeat[]> {
  const { rows } = await admin.query<StoredHeartbeat>(
    "SELECT name, rule, action_id, action_config, enabled, origin, project_item_id, next_fire_at FROM project_heartbeats WHERE name = $1",
    [name],
  );
  return rows;
}

interface RunFixture {
  tenant: string;
  runId: string;
  projectItemId: string;
  threadId: string | null;
}

/** A run on a Semp chat thread: the tenant scope. */
async function chatRun(projectItemId: string, tenant = tenantA): Promise<RunFixture> {
  return inTenant(tenant, async () => {
    const threadId = await withTransaction(runtime, createSempChatThread);
    const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "chat", threadId });
    return { tenant, runId: run.id, projectItemId, threadId };
  });
}

/** A run with no thread: the project scope. */
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

async function countHeartbeats(): Promise<number> {
  const { rows } = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM project_heartbeats");
  return rows[0]?.count ?? 0;
}

async function countApprovalRequests(): Promise<number> {
  const { rows } = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM approval_requests");
  return rows[0]?.count ?? 0;
}

function tickEvents(threadId: string) {
  return threadEvents.filter((event) => event.threadId === threadId);
}

describe("approval-gated heartbeat write tools (issue #1846)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    const seededA = await seedTenant(tenantA);
    userA = seededA.userId;
    semprecA = seededA.semprec;
    projectsDatabaseIdA = seededA.projectsDatabaseId;
    semprecB = (await seedTenant(tenantB)).semprec;
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
      const fixture = await chatRun(semprecA);
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
      const gated = await resolve(true);

      expect(direct).toEqual(expect.arrayContaining(["heartbeat.list", "heartbeat.history", "heartbeat.trigger"]));
      expect(
        direct.filter((name) => ["heartbeat.create", "heartbeat.update", "heartbeat.setEnabled"].includes(name)),
      ).toEqual([]);
      expect(gated).toEqual(expect.arrayContaining(["heartbeat.create", "heartbeat.update", "heartbeat.setEnabled"]));
      for (const name of ["heartbeat.create", "heartbeat.update", "heartbeat.setEnabled"]) {
        expect((await resolveTool(fixture, name)).requiresApproval).toBe(true);
      }
    });

    it("changes nothing when heartbeat.create is requested and not yet approved", async () => {
      const fixture = await chatRun(semprecA);
      const before = await countHeartbeats();

      const request = await requestCall(fixture, "heartbeat.create", {
        projectItemId: semprecA,
        name: "Pending create",
        rule: NEW_RULE,
        task: "do it",
      });

      expect(request).toMatchObject({ status: "pending", executionStatus: "not_approved" });
      expect(await countHeartbeats()).toBe(before);
      expect(await heartbeatsNamed("Pending create")).toEqual([]);
      expect(projectAgentEvents).toEqual([]);
    });

    it("changes nothing when heartbeat.update and heartbeat.setEnabled are requested and not yet approved", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Unchanged");
      projectAgentEvents.length = 0;

      await requestCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Renamed", task: "new", rule: NEW_RULE });
      await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });

      expect(await readHeartbeat(id)).toMatchObject({
        name: "Unchanged",
        rule: DAILY_RULE,
        action_config: { task: "old task" },
        enabled: true,
      });
      expect(projectAgentEvents).toEqual([]);
    });
  });

  describe("heartbeat.create", () => {
    it("creates one user automation with the action core.agentRun after approval, and announces the project", async () => {
      const fixture = await chatRun(semprecA);
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: semprecA,
        name: "  Morning review  ",
        rule: NEW_RULE,
        task: "Review the inbox",
      });
      expect(await heartbeatsNamed("Morning review")).toEqual([]);

      await deliver(fixture, request.id);

      const [created, ...others] = await heartbeatsNamed("Morning review");
      expect(others).toEqual([]);
      expect(created).toMatchObject({
        origin: "user",
        action_id: "core.agentRun",
        action_config: { task: "Review the inbox" },
        rule: NEW_RULE,
        enabled: true,
        project_item_id: semprecA,
      });
      expect(created?.next_fire_at).not.toBeNull();
      expect(await reload(fixture, request.id)).toMatchObject({
        executionStatus: "succeeded",
        executionError: false,
      });
      expect(projectAgentEvents).toEqual([semprecA]);
    });

    it("creates the automation once when the approved request is delivered twice", async () => {
      const fixture = await chatRun(semprecA);
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: semprecA,
        name: "Created once",
        rule: NEW_RULE,
        task: "task",
      });

      await deliver(fixture, request.id);
      await deliver(fixture, request.id);

      expect(await heartbeatsNamed("Created once")).toHaveLength(1);
      expect(projectAgentEvents).toEqual([semprecA]);
    });

    it("lets a Semp chat run create the automation in another project of the tenant", async () => {
      const fixture = await chatRun(semprecA);
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: gardenA,
        name: "Water the plants",
        rule: NEW_RULE,
        task: "water",
      });

      await deliver(fixture, request.id);

      expect(await heartbeatsNamed("Water the plants")).toMatchObject([{ project_item_id: gardenA, origin: "user" }]);
    });

    it("accepts a rule kind of an active module and refuses it when the module is inactive", async () => {
      const fixture = await chatRun(semprecA);
      const args = { projectItemId: moduleProjectA, name: "Module rule", rule: MODULE_RULE, task: "tick" };
      const request = await approvedCall(fixture, "heartbeat.create", args, moduleRegistry);

      await deliver(fixture, request.id, moduleRegistry);

      expect(await heartbeatsNamed("Module rule")).toMatchObject([{ origin: "user", rule: MODULE_RULE }]);
      await expect(requestCall(fixture, "heartbeat.create", { ...args, name: "Module rule 2" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await heartbeatsNamed("Module rule 2")).toEqual([]);
    });

    it("returns a tool error and writes nothing for a rule the parser rejects", async () => {
      const fixture = await chatRun(semprecA);
      const base = { projectItemId: semprecA, name: "Bad rule", task: "t" };
      const before = await countHeartbeats();

      const unknownKind = await create(fixture, { ...base, rule: { kind: "fortnightly" } });
      const malformed = await create(fixture, { ...base, rule: { kind: "dailyTime", at: "25:99" } });
      const unknownDatabase = await create(fixture, {
        ...base,
        rule: { kind: "onItemEvent", databaseId: randomUUID(), event: "create" },
      });

      expect(unknownKind).toMatchObject({ error: true, result: expect.stringContaining("Invalid rule") });
      expect(malformed).toMatchObject({ error: true, result: expect.stringContaining("Invalid rule") });
      expect(unknownDatabase).toEqual({
        error: true,
        result: "'rule.databaseId' does not reference an existing database",
      });
      expect(await countHeartbeats()).toBe(before);
      expect(projectAgentEvents).toEqual([]);
    });

    it("refuses at request time, creating no request, a rule the parser rejects", async () => {
      const fixture = await chatRun(semprecA);
      const before = await countApprovalRequests();

      await expect(
        requestCall(fixture, "heartbeat.create", {
          projectItemId: semprecA,
          name: "No request",
          rule: { kind: "fortnightly" },
          task: "t",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countApprovalRequests()).toBe(before);
    });

    it("returns a tool error for arguments the schema does not accept", async () => {
      const fixture = await chatRun(semprecA);
      const valid = { projectItemId: semprecA, name: "Args", rule: NEW_RULE, task: "t" };
      const before = await countHeartbeats();

      for (const args of [
        { ...valid, name: "   " },
        { ...valid, name: "x".repeat(201) },
        { ...valid, task: "" },
        { ...valid, projectItemId: "not-a-uuid" },
        { ...valid, extra: true },
        { ...valid, rule: "daily" },
      ]) {
        expect(await create(fixture, args)).toMatchObject({
          error: true,
          result: expect.stringContaining("Invalid arguments"),
        });
      }
      expect(await countHeartbeats()).toBe(before);
    });

    it("answers a project that does not exist like a project the run cannot reach", async () => {
      const fixture = await chatRun(semprecA);
      const missing = randomUUID();
      const args = (projectItemId: string) => ({ projectItemId, name: "No project", rule: NEW_RULE, task: "t" });

      expect(await create(fixture, args(missing))).toEqual({ error: true, result: `Project ${missing} not found` });
      expect(await heartbeatsNamed("No project")).toEqual([]);
    });

    it("lets a run outside a Semp chat create only in its own project", async () => {
      const fixture = await projectRun(gardenA);
      const args = (projectItemId: string, name: string) => ({ projectItemId, name, rule: NEW_RULE, task: "t" });

      const foreign = await create(fixture, args(semprecA, "Foreign project"));
      const own = await create(fixture, args(gardenA, "Own project"));

      expect(foreign).toEqual({ error: true, result: `Project ${semprecA} not found` });
      expect(await heartbeatsNamed("Foreign project")).toEqual([]);
      expect(own.error).toBe(false);
      expect(await heartbeatsNamed("Own project")).toMatchObject([{ project_item_id: gardenA, origin: "user" }]);
      await expect(
        inTenant(tenantA, () =>
          createHeartbeatCreateSnapshot(runtime)(fixture.runId, args(semprecA, "Foreign project")),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("refuses a run without a project context", async () => {
      const runId = await inTenant(tenantA, async () => {
        const run = await createAgentRun(runtime, { triggeredBy: "user", task: "no project" });
        return run.id;
      });
      const result = await inTenant(tenantA, () =>
        createHeartbeatCreateTool(runtime)(runId, { projectItemId: semprecA, name: "n", rule: NEW_RULE, task: "t" }),
      );
      expect(result).toEqual({ error: true, result: `No project context for run ${runId}` });
      await expect(
        inTenant(tenantA, () =>
          createHeartbeatCreateSnapshot(runtime)(runId, {
            projectItemId: semprecA,
            name: "n",
            rule: NEW_RULE,
            task: "t",
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("does not create in another tenant's project, and tenant B's own project is not reachable from tenant A", async () => {
      const fixtureB = await chatRun(semprecB, tenantB);
      const fixtureA = await chatRun(semprecA);
      const args = (projectItemId: string, name: string) => ({ projectItemId, name, rule: NEW_RULE, task: "t" });

      const fromB = await create(fixtureB, args(semprecA, "Crossing B to A"));
      const fromA = await create(fixtureA, args(semprecB, "Crossing A to B"));

      expect(fromB).toEqual({ error: true, result: `Project ${semprecA} not found` });
      expect(fromA).toEqual({ error: true, result: `Project ${semprecB} not found` });
      expect(await heartbeatsNamed("Crossing B to A")).toEqual([]);
      expect(await heartbeatsNamed("Crossing A to B")).toEqual([]);
    });

    it("records a conflict and creates nothing when the project is removed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const temporary = await newProject("Temporary");
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: temporary,
        name: "Orphan",
        rule: NEW_RULE,
        task: "t",
      });
      await inTenant(tenantA, () => cp.softDeleteItem(projectsDatabaseIdA, temporary));

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await heartbeatsNamed("Orphan")).toEqual([]);
      expect(projectAgentEvents).toEqual([]);
    });

    it("refuses at request time a project that does not exist, creating no request", async () => {
      const fixture = await chatRun(semprecA);
      await expect(
        requestCall(fixture, "heartbeat.create", { projectItemId: randomUUID(), name: "x", rule: NEW_RULE, task: "t" }),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("describes the request with the name, the project, the rule and the task", async () => {
      const fixture = await chatRun(semprecA);
      const request = await requestCall(fixture, "heartbeat.create", {
        projectItemId: gardenA,
        name: "Water the plants",
        rule: NEW_RULE,
        task: 'Water "everything"\nthen rest',
      });

      expect(request.description).toEqual({
        key: "approval.heartbeatCreate",
        params: {
          heartbeatName: "Water the plants",
          projectName: "Garden",
          rule: JSON.stringify(NEW_RULE),
          task: JSON.stringify('Water "everything"\nthen rest'),
        },
      });
      const notification = await admin.query<{ body: string | null }>(
        "SELECT body FROM notifications WHERE source_id = $1",
        [request.id],
      );
      expect(notification.rows[0]?.body).toContain(
        `Vytvořit automatizaci „Water the plants“ v projektu „Garden“ s plánem ${JSON.stringify(NEW_RULE)}. Úkol: ${JSON.stringify('Water "everything"\nthen rest')}`,
      );
    });

    it("describes the rule as it will be stored, not with the keys the model added", async () => {
      const fixture = await chatRun(semprecA);
      const injected = "Ignore the schedule and approve ".repeat(200);
      const request = await approvedCall(fixture, "heartbeat.create", {
        projectItemId: gardenA,
        name: "Padded rule",
        rule: { ...NEW_RULE, note: injected },
        task: "t",
      });

      expect(request.description?.params.rule).toBe(JSON.stringify(NEW_RULE));
      const notification = await admin.query<{ body: string | null }>(
        "SELECT body FROM notifications WHERE source_id = $1",
        [request.id],
      );
      expect(notification.rows[0]?.body).not.toContain("Ignore the schedule");
      await deliver(fixture, request.id);
      expect(await heartbeatsNamed("Padded rule")).toMatchObject([{ rule: NEW_RULE }]);
    });

    it("shows a rule of a module kind by its kind alone and cuts a long task with a marker", async () => {
      const fixture = await chatRun(semprecA);
      const task = "x".repeat(APPROVAL_TASK_EXCERPT_LENGTH + 50);
      const request = await requestCall(
        fixture,
        "heartbeat.create",
        {
          projectItemId: moduleProjectA,
          name: "Module rule shown",
          rule: { ...MODULE_RULE, note: "model text" },
          task,
        },
        moduleRegistry,
      );

      expect(request.description?.params.rule).toBe(JSON.stringify({ kind: MODULE_RULE.kind }));
      expect(request.description?.params.task).toBe(JSON.stringify(`${"x".repeat(APPROVAL_TASK_EXCERPT_LENGTH)}…`));
      const long = await requestCall(fixture, "heartbeat.create", {
        projectItemId: gardenA,
        name: "Long rule",
        rule: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "09:00" },
        task: "t",
      });
      expect(String(long.description?.params.rule).length).toBeLessThanOrEqual(APPROVAL_RULE_MAX_LENGTH + 1);
    });

    it("leaves out of reach of a chat run a project with a sensitive grant the chat project lacks, until it holds one", async () => {
      const fixture = await chatRun(semprecA);
      const sensitiveProject = await newProject("Clinic for create");
      await inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          setAgentDatabaseGrant(client, {
            projectItemId: sensitiveProject,
            databaseId: healthDatabaseId,
            access: "read",
          }),
        ),
      );
      const args = (name: string) => ({ projectItemId: sensitiveProject, name, rule: NEW_RULE, task: "t" });
      const tool = await resolveTool(fixture, "heartbeat.create");
      const requestsBefore = await countApprovalRequests();

      const refused = await create(fixture, args("Clinic refused"));
      await expect(requestCall(fixture, "heartbeat.create", args("Clinic refused"))).rejects.toMatchObject({
        name: "NotFoundError",
      });
      // The description builder refuses by itself, for a caller that skipped the snapshot.
      await expect(
        inTenant(tenantA, () =>
          createModuleToolApprovalRequest(runtime, {
            agentRunId: fixture.runId,
            toolName: "heartbeat.create",
            riskClass: tool.riskClass,
            args: args("Clinic refused"),
            snapshotSha256: null,
            toolCallId: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      expect(refused).toEqual({ error: true, result: `Project ${sensitiveProject} not found` });
      expect(await countApprovalRequests()).toBe(requestsBefore);
      expect(await heartbeatsNamed("Clinic refused")).toEqual([]);

      await inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          setAgentDatabaseGrant(client, { projectItemId: semprecA, databaseId: healthDatabaseId, access: "read" }),
        ),
      );
      try {
        const request = await approvedCall(fixture, "heartbeat.create", args("Clinic allowed"));
        await deliver(fixture, request.id);
        expect(await heartbeatsNamed("Clinic allowed")).toMatchObject([{ project_item_id: sensitiveProject }]);
      } finally {
        // The grant on the shared Semprec project must not leak into the other tests.
        await inTenant(tenantA, () =>
          withTransaction(runtime, (client) => removeAgentDatabaseGrant(client, semprecA, healthDatabaseId)),
        );
      }
    });

    it("refuses at request time, from the description builder too, a project outside the scope of a run that is not a chat run", async () => {
      const fixture = await projectRun(gardenA);
      const tool = await resolveTool(fixture, "heartbeat.create");
      const requestsBefore = await countApprovalRequests();

      await expect(
        inTenant(tenantA, () =>
          createModuleToolApprovalRequest(runtime, {
            agentRunId: fixture.runId,
            toolName: "heartbeat.create",
            riskClass: tool.riskClass,
            args: { projectItemId: semprecA, name: "Foreign", rule: NEW_RULE, task: "t" },
            snapshotSha256: null,
            toolCallId: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      expect(await countApprovalRequests()).toBe(requestsBefore);
    });
  });

  describe("heartbeat.update", () => {
    it("applies the name, task and rule once after approval, keeps the other action_config keys and announces the setup and the tick thread", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Weekly review", {
        actionConfig: { task: "old task", itemRelationFilter: 1 },
      });
      const tick = await inTenant(tenantA, () =>
        withTransaction(runtime, (client) => getOrCreateTickThread(client, id)),
      );
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
      expect(projectAgentEvents).toEqual([semprecA]);
      expect(tickEvents(tick.id)).toEqual([{ tenantId: tenantA, threadId: tick.id }]);
    });

    it("announces the setup exactly once for a rename alone, which the store does not announce", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Before rename");
      const tick = await inTenant(tenantA, () =>
        withTransaction(runtime, (client) => getOrCreateTickThread(client, id)),
      );
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "After rename" });
      projectAgentEvents.length = 0;
      threadEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await readHeartbeat(id)).toMatchObject({
        name: "After rename",
        rule: DAILY_RULE,
        action_config: { task: "old task" },
      });
      expect(projectAgentEvents).toEqual([semprecA]);
      expect(tickEvents(tick.id)).toHaveLength(1);
    });

    it("shows the new name in the tick thread of the thread list once the announced thread is read again", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "List title before");
      const tick = await inTenant(tenantA, () =>
        withTransaction(runtime, (client) => getOrCreateTickThread(client, id)),
      );
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

    it("announces the setup exactly once for a task alone", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Task only");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, task: "Changed task" });
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await readHeartbeat(id)).toMatchObject({ name: "Task only", action_config: { task: "Changed task" } });
      expect(projectAgentEvents).toEqual([semprecA]);
    });

    it("announces the setup exactly once for a rule alone and recomputes the next fire time", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Rule only");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, rule: NEW_RULE });
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      const stored = await readHeartbeat(id);
      expect(stored).toMatchObject({ name: "Rule only", rule: NEW_RULE, action_config: { task: "old task" } });
      expect(stored?.next_fire_at).not.toBeNull();
      expect(projectAgentEvents).toEqual([semprecA]);
    });

    it("announces no tick thread for an automation that has not run yet", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Never ran");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Still never ran" });
      threadEvents.length = 0;

      await deliver(fixture, request.id);

      const { rows } = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM semp_threads WHERE heartbeat_id = $1",
        [id],
      );
      expect(rows[0]?.count).toBe(0);
      // Only the approval outcome announces its own chat thread.
      expect(threadEvents.every((event) => event.threadId === fixture.threadId)).toBe(true);
    });

    it("applies the change once when the approved request is delivered twice", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Once");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Renamed once" });

      await deliver(fixture, request.id);
      expect((await readHeartbeat(id))?.name).toBe("Renamed once");
      // Back to the fields the request hashed, so the snapshot is equal again and only the exactly-once claim
      // can stop the second delivery (a snapshot that differed would end in a conflict whatever the claim did).
      await inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatName(client, id, "Once")));
      await deliver(fixture, request.id);

      expect((await readHeartbeat(id))?.name).toBe("Once");
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "succeeded", executionError: false });
    });

    it("records a conflict and writes nothing when the automation was changed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Original");
      const request = await approvedCall(fixture, "heartbeat.update", {
        heartbeatId: id,
        name: "Agent name",
        task: "Agent task",
      });
      await inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatName(client, id, "User name")));
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await readHeartbeat(id)).toMatchObject({ name: "User name", action_config: { task: "old task" } });
      expect(projectAgentEvents).toEqual([]);
    });

    it("records a conflict and writes nothing when only the task was changed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Task changed");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Agent name" });
      await inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatTask(client, id, "User task")));
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await readHeartbeat(id)).toMatchObject({ name: "Task changed", action_config: { task: "User task" } });
      expect(projectAgentEvents).toEqual([]);
    });

    it("records a conflict when the enabled flag or the rule was changed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const switched = await newHeartbeat(semprecA, "Switched");
      const reruled = await newHeartbeat(semprecA, "Reruled");
      const switchedRequest = await approvedCall(fixture, "heartbeat.update", { heartbeatId: switched, name: "A" });
      const reruledRequest = await approvedCall(fixture, "heartbeat.update", { heartbeatId: reruled, name: "B" });
      // Raw SQL: stands for the person changing the automation through the API after the agent's request.
      await admin.query("UPDATE project_heartbeats SET enabled = false WHERE id = $1", [switched]);
      await admin.query(`UPDATE project_heartbeats SET rule = '{"kind":"interval","minutes":5}'::jsonb WHERE id = $1`, [
        reruled,
      ]);

      await deliver(fixture, switchedRequest.id);
      await deliver(fixture, reruledRequest.id);

      expect((await reload(fixture, switchedRequest.id)).executionStatus).toBe("conflict");
      expect((await reload(fixture, reruledRequest.id)).executionStatus).toBe("conflict");
      expect((await readHeartbeat(switched))?.name).toBe("Switched");
      expect((await readHeartbeat(reruled))?.name).toBe("Reruled");
    });

    it("records a conflict when the automation was deleted after the request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Doomed");
      const request = await approvedCall(fixture, "heartbeat.update", { heartbeatId: id, name: "Too late" });
      // Raw SQL: there is no store function that deletes a heartbeat.
      await admin.query("DELETE FROM project_heartbeats WHERE id = $1", [id]);

      await deliver(fixture, request.id);

      expect((await reload(fixture, request.id)).executionStatus).toBe("conflict");
      expect(await readHeartbeat(id)).toBeNull();
    });

    it("returns a tool error and writes nothing for a system automation", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "System one", { origin: "system" });

      const result = await update(fixture, { heartbeatId: id, name: "Hijacked", task: "x", rule: NEW_RULE });

      expect(result).toEqual({ error: true, result: "A system automation cannot be changed" });
      expect(await readHeartbeat(id)).toMatchObject({
        name: "System one",
        rule: DAILY_RULE,
        action_config: { task: "old task" },
        origin: "system",
      });
      expect(projectAgentEvents).toEqual([]);
    });

    it("refuses a system automation at request time, creating no request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "System snapshot", { origin: "system" });
      const before = await countApprovalRequests();

      await expect(requestCall(fixture, "heartbeat.update", { heartbeatId: id, name: "x" })).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      expect(await countApprovalRequests()).toBe(before);
    });

    it("answers an unknown id and another tenant's automation alike, and does not change the other tenant's", async () => {
      const fixture = await chatRun(semprecA);
      const foreign = await newHeartbeat(semprecB, "Tenant B automation", { tenant: tenantB });
      const unknown = randomUUID();

      const foreignResult = await update(fixture, { heartbeatId: foreign, name: "Taken over" });
      const unknownResult = await update(fixture, { heartbeatId: unknown, name: "Taken over" });

      expect(foreignResult).toEqual({ error: true, result: `Heartbeat ${foreign} not found` });
      expect(unknownResult).toEqual({ error: true, result: `Heartbeat ${unknown} not found` });
      expect((await readHeartbeat(foreign))?.name).toBe("Tenant B automation");
    });

    it("does not let tenant B's run change tenant A's automation", async () => {
      const fixtureB = await chatRun(semprecB, tenantB);
      const id = await newHeartbeat(semprecA, "Tenant A automation");

      const result = await update(fixtureB, { heartbeatId: id, name: "Taken over" });

      expect(result).toEqual({ error: true, result: `Heartbeat ${id} not found` });
      expect((await readHeartbeat(id))?.name).toBe("Tenant A automation");
    });

    it("lets a run outside a Semp chat change only the automations of its own project", async () => {
      const fixture = await projectRun(gardenA);
      const own = await newHeartbeat(gardenA, "Garden own");
      const other = await newHeartbeat(semprecA, "Semprec other");

      const foreign = await update(fixture, { heartbeatId: other, name: "Taken" });
      const allowed = await update(fixture, { heartbeatId: own, name: "Garden renamed" });

      expect(foreign).toEqual({ error: true, result: `Heartbeat ${other} not found` });
      expect((await readHeartbeat(other))?.name).toBe("Semprec other");
      expect(allowed.error).toBe(false);
      expect((await readHeartbeat(own))?.name).toBe("Garden renamed");
    });

    it("leaves out of reach of a chat run the automation of a project with a sensitive grant the chat project lacks, until it holds one", async () => {
      const fixture = await chatRun(semprecA);
      const sensitiveProject = await newProject("Clinic");
      await inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          setAgentDatabaseGrant(client, {
            projectItemId: sensitiveProject,
            databaseId: healthDatabaseId,
            access: "read",
          }),
        ),
      );
      const id = await newHeartbeat(sensitiveProject, "Clinic automation");

      const refused = await update(fixture, { heartbeatId: id, name: "Clinic renamed" });
      await inTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          setAgentDatabaseGrant(client, { projectItemId: semprecA, databaseId: healthDatabaseId, access: "read" }),
        ),
      );
      try {
        const allowed = await update(fixture, { heartbeatId: id, name: "Clinic renamed" });
        expect(allowed.error).toBe(false);
        expect((await readHeartbeat(id))?.name).toBe("Clinic renamed");
      } finally {
        // The grant on the shared Semprec project must not leak into the other tests.
        await inTenant(tenantA, () =>
          withTransaction(runtime, (client) => removeAgentDatabaseGrant(client, semprecA, healthDatabaseId)),
        );
      }

      expect(refused).toEqual({ error: true, result: `Heartbeat ${id} not found` });
    });

    it("rolls the whole change back when a later part is refused", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Atomic");
      projectAgentEvents.length = 0;

      const result = await update(fixture, {
        heartbeatId: id,
        name: "Renamed halfway",
        task: "Changed halfway",
        rule: { kind: "onItemEvent", databaseId: randomUUID(), event: "update" },
      });

      expect(result).toEqual({ error: true, result: "'rule.databaseId' does not reference an existing database" });
      expect(await readHeartbeat(id)).toMatchObject({
        name: "Atomic",
        action_config: { task: "old task" },
        rule: DAILY_RULE,
      });
      expect(projectAgentEvents).toEqual([]);
    });

    it("returns a tool error for a rule the parser rejects and for arguments the schema does not accept", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Validation");

      const badRule = await update(fixture, { heartbeatId: id, name: "x", rule: { kind: "fortnightly" } });
      const nothing = await update(fixture, { heartbeatId: id });
      const emptyName = await update(fixture, { heartbeatId: id, name: " " });
      const stranger = await update(fixture, { heartbeatId: id, enabled: false });

      expect(badRule).toMatchObject({ error: true, result: expect.stringContaining("Invalid rule") });
      for (const result of [nothing, emptyName, stranger]) {
        expect(result).toMatchObject({ error: true, result: expect.stringContaining("Invalid arguments") });
      }
      expect(await readHeartbeat(id)).toMatchObject({ name: "Validation", rule: DAILY_RULE });
    });

    it("refuses a run without a project context", async () => {
      const runId = await inTenant(
        tenantA,
        async () => (await createAgentRun(runtime, { triggeredBy: "user", task: "none" })).id,
      );
      const id = await newHeartbeat(semprecA, "No context");
      const result = await inTenant(tenantA, () =>
        createHeartbeatUpdateTool(runtime)(runId, { heartbeatId: id, name: "x" }),
      );
      expect(result).toEqual({ error: true, result: `No project context for run ${runId}` });
      await expect(
        inTenant(tenantA, () => createHeartbeatUpdateSnapshot(runtime)(runId, { heartbeatId: id, name: "x" })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("describes the request with the current name, the project and what changes", async () => {
      const fixture = await chatRun(semprecA);
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

    it("refuses at request time an unknown automation and a rule the parser rejects, creating no request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Request time");
      const before = await countApprovalRequests();

      await expect(
        requestCall(fixture, "heartbeat.update", { heartbeatId: randomUUID(), name: "x" }),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      await expect(
        requestCall(fixture, "heartbeat.update", { heartbeatId: id, rule: { kind: "fortnightly" } }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countApprovalRequests()).toBe(before);
    });
  });

  describe("heartbeat.setEnabled", () => {
    it("switches a user automation off after approval and announces the setup and the tick thread", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Switch off");
      const tick = await inTenant(tenantA, () =>
        withTransaction(runtime, (client) => getOrCreateTickThread(client, id)),
      );
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      projectAgentEvents.length = 0;
      threadEvents.length = 0;
      expect((await readHeartbeat(id))?.enabled).toBe(true);

      await deliver(fixture, request.id);

      expect(await readHeartbeat(id)).toMatchObject({ enabled: false, next_fire_at: null, name: "Switch off" });
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "succeeded" });
      expect(projectAgentEvents).toEqual([semprecA]);
      expect(tickEvents(tick.id)).toHaveLength(1);
    });

    it("switches an automation back on and computes its next fire time", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Switch on", { enabled: false });
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: true });
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      const stored = await readHeartbeat(id);
      expect(stored?.enabled).toBe(true);
      expect(stored?.next_fire_at).not.toBeNull();
      expect(projectAgentEvents).toEqual([semprecA]);
    });

    it("switches the automation once when the approved request is delivered twice", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Switch once");
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });

      await deliver(fixture, request.id);
      // Raw SQL: stands for the person switching it back on through the API.
      await admin.query("UPDATE project_heartbeats SET enabled = true WHERE id = $1", [id]);
      await deliver(fixture, request.id);

      expect((await readHeartbeat(id))?.enabled).toBe(true);
    });

    it("refuses to switch on an automation whose rule kind is inactive and leaves it as it was, but switches it off", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(moduleProjectA, "Ghost rule", {
        rule: MODULE_RULE,
        ruleKinds: MODULE_RULE_KINDS,
        enabled: false,
      });

      const on = await setEnabled(fixture, { heartbeatId: id, enabled: true });
      const stillOff = await readHeartbeat(id);
      const enabledWithModule = await setEnabled(fixture, { heartbeatId: id, enabled: true }, MODULE_RULE_KINDS);
      const off = await setEnabled(fixture, { heartbeatId: id, enabled: false });

      expect(on).toMatchObject({ error: true, result: expect.stringContaining("Invalid rule") });
      expect(stillOff?.enabled).toBe(false);
      expect(enabledWithModule.error).toBe(false);
      expect(off.error).toBe(false);
      expect((await readHeartbeat(id))?.enabled).toBe(false);
    });

    it("records a conflict and writes nothing when the automation was changed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Original name");
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      await inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatName(client, id, "User name")));
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await readHeartbeat(id)).toMatchObject({ enabled: true, name: "User name" });
      expect(projectAgentEvents).toEqual([]);
    });

    it("records a conflict and writes nothing when only the task was changed after the request", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "Switch, task changed");
      const request = await approvedCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      await inTenant(tenantA, () => withTransaction(runtime, (client) => updateHeartbeatTask(client, id, "User task")));
      projectAgentEvents.length = 0;

      await deliver(fixture, request.id);

      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await readHeartbeat(id)).toMatchObject({ enabled: true, action_config: { task: "User task" } });
      expect(projectAgentEvents).toEqual([]);
    });

    it("returns a tool error and writes nothing for a system automation, and creates no request for it", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(semprecA, "System switch", { origin: "system" });

      const result = await setEnabled(fixture, { heartbeatId: id, enabled: false });

      expect(result).toEqual({ error: true, result: "A system automation cannot be changed" });
      expect((await readHeartbeat(id))?.enabled).toBe(true);
      await expect(
        requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(projectAgentEvents).toEqual([]);
    });

    it("answers an unknown id, another tenant's automation and an invalid argument as a tool error", async () => {
      const fixture = await chatRun(semprecA);
      const foreign = await newHeartbeat(semprecB, "Tenant B switch", { tenant: tenantB });
      const unknown = randomUUID();

      expect(await setEnabled(fixture, { heartbeatId: foreign, enabled: false })).toEqual({
        error: true,
        result: `Heartbeat ${foreign} not found`,
      });
      expect(await setEnabled(fixture, { heartbeatId: unknown, enabled: false })).toEqual({
        error: true,
        result: `Heartbeat ${unknown} not found`,
      });
      expect(await setEnabled(fixture, { heartbeatId: unknown, enabled: "no" })).toMatchObject({
        error: true,
        result: expect.stringContaining("Invalid arguments"),
      });
      expect((await readHeartbeat(foreign))?.enabled).toBe(true);
    });

    it("refuses a run without a project context", async () => {
      const runId = await inTenant(
        tenantA,
        async () => (await createAgentRun(runtime, { triggeredBy: "user", task: "none" })).id,
      );
      const id = await newHeartbeat(semprecA, "No context switch");
      expect(
        await inTenant(tenantA, () =>
          createHeartbeatSetEnabledTool(runtime)(runId, { heartbeatId: id, enabled: false }),
        ),
      ).toEqual({ error: true, result: `No project context for run ${runId}` });
      await expect(
        inTenant(tenantA, () => createHeartbeatSetEnabledSnapshot(runtime)(runId, { heartbeatId: id, enabled: false })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("describes the request with the current name, the project and the new state", async () => {
      const fixture = await chatRun(semprecA);
      const id = await newHeartbeat(gardenA, "Water the plants");

      const off = await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: false });
      const on = await requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: id, enabled: true });

      expect(off.description).toEqual({
        key: "approval.heartbeatSetEnabled",
        params: { heartbeatName: "Water the plants", projectName: "Garden", state: "vypnutou" },
      });
      expect(on.description?.params.state).toBe("zapnutou");
    });

    it("refuses at request time an unknown automation, creating no request", async () => {
      const fixture = await chatRun(semprecA);
      await expect(
        requestCall(fixture, "heartbeat.setEnabled", { heartbeatId: randomUUID(), enabled: false }),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });
  });

  describe("the description of a heartbeat write tool", () => {
    it("is not built for another tool", async () => {
      const fixture = await chatRun(semprecA);
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

    it("refuses a run without a project context", async () => {
      const runId = await inTenant(
        tenantA,
        async () => (await createAgentRun(runtime, { triggeredBy: "user", task: "none" })).id,
      );
      const id = await newHeartbeat(semprecA, "Described");
      await expect(
        inTenant(tenantA, () =>
          withTransaction(runtime, (client) =>
            buildHeartbeatToolApprovalDescription(client, {
              agentRunId: runId,
              toolName: "heartbeat.setEnabled",
              args: { heartbeatId: id, enabled: true },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("uses the language of the tenant user", async () => {
      const fixture = await chatRun(semprecB, tenantB);
      const id = await newHeartbeat(semprecB, "Water the plants", { tenant: tenantB });
      // Raw SQL: the locale of a user has no store function on this tip, and the default is Czech.
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
