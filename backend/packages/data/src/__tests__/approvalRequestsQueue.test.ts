import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestProjectItem,
  createTestTenant,
  getOrCreateTickThread,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser as createRawUser } from "../auth/usersStore.js";
import { ValidationError } from "../errors.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { AGENT_RUN_ROOT_MAX_HOPS, createAgentRun, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import {
  claimApprovalRequestExecution,
  countPendingApprovalRequests,
  createPendingApprovalRequest,
  decideApprovalRequest,
  getApprovalRequest,
  markApprovalRequestExecutionSucceeded,
  parseApprovalRequestListCursor,
  terminalizeApprovalRequestAsConflict,
  type ApprovalRequest,
  type ApprovalRequestSourceKind,
  type CreatePendingApprovalRequestInput,
  type ListApprovalRequestsPageInput,
} from "../mcp/approvalRequestsStore.js";
import {
  attachLiveStepApprovals,
  getApprovalRequestSourceKind,
  listApprovalRequestsQueue,
  listApprovalRequestsQueuePage,
  toApprovalRequestDecisionView,
  type ApprovalRequestSource,
} from "../mcp/approvalRequestsQueue.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { createSempChatThread, sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import type { SempReplyStep } from "../semp/sempReplySteps.js";

const LOCALE = "en";
const RESOURCE_SNAPSHOT = { kind: "test", resourceId: "test", sha256: null };

/** The source of a run that has no thread and whose root run a person started. */
const THREADLESS_CHAT_SOURCE: ApprovalRequestSource = {
  kind: "chat",
  threadId: null,
  threadTitle: null,
  heartbeatId: null,
  heartbeatName: null,
  mcpClientName: null,
};

let pool: Pool;
let chokePoint: ChokePoint;
let ownerId: string;

/**
 * A pending request of `run`: by default for the outbound MCP tool `send_email` with one argument;
 * `input` replaces any of its fields.
 */
async function requestOf(
  run: AgentRunRow,
  input: Partial<Omit<CreatePendingApprovalRequestInput, "agentRunId">> = {},
  client: Queryable = pool,
): Promise<ApprovalRequest> {
  return createPendingApprovalRequest(client, {
    toolName: "send_email",
    riskClass: "outbound",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } },
    resourceSnapshot: RESOURCE_SNAPSHOT,
    ...input,
    agentRunId: run.id,
  });
}

const mcpPayload = (args: Record<string, unknown> = {}) => ({
  mcpToolRegistrationId: randomUUID(),
  mcpServerItemId: randomUUID(),
  args,
});

const userRun = (input: { threadId?: string; parentRunId?: string } = {}) =>
  createAgentRun(pool, { triggeredBy: "user", task: "chat", ...input });

const listQueue = (locale = LOCALE) => listApprovalRequestsQueue(pool, ownerId, locale);

const decisionView = (request: ApprovalRequest, locale = LOCALE) =>
  toApprovalRequestDecisionView(pool, request, locale);

async function storedView(id: string) {
  const request = await getApprovalRequest(pool, id);
  if (!request) throw new Error(`approval request ${id} not found`);
  return decisionView(request);
}

/** The SQL statements `read` sends through one client. */
async function statementsDuring(read: (client: Queryable) => Promise<unknown>): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const query = vi.spyOn(client, "query");
    try {
      await read(client);
      return query.mock.calls.map(([sql]) => sql).filter((sql): sql is string => typeof sql === "string");
    } finally {
      query.mockRestore();
    }
  });
}

async function chatThread(title?: string): Promise<string> {
  const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
  if (title !== undefined) {
    // Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway.
    await pool.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, title]);
  }
  return threadId;
}

async function tickThread(name: string) {
  const projectItemId = await createTestProjectItem(pool);
  return withTransaction(pool, async (client) => {
    const heartbeat = await createHeartbeat(client, {
      projectItemId,
      name,
      rule: { kind: "weekly", days: ["sun"], at: "21:00" },
      actionId: CORE_AGENT_RUN_ACTION_ID,
      actionConfig: { task: "Plan the week" },
    });
    return {
      projectItemId,
      heartbeatId: heartbeat.id,
      threadId: (await getOrCreateTickThread(client, heartbeat.id)).id,
    };
  });
}

/** A heartbeat run on the tick thread of a new heartbeat named `name`. */
async function tickRun(name = "Sunday planning", parentRunId?: string) {
  const tick = await tickThread(name);
  const run = await createAgentRun(pool, {
    triggeredBy: "heartbeat",
    task: "Plan the week",
    projectItemId: tick.projectItemId,
    heartbeatId: tick.heartbeatId,
    threadId: tick.threadId,
    parentRunId,
  });
  return { tick, run };
}

/** A heartbeat run without a thread, naming a new heartbeat called `name`. */
async function threadlessHeartbeatRun(name: string): Promise<AgentRunRow> {
  const { heartbeatId } = await tickThread(name);
  return createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick", heartbeatId });
}

/**
 * An Inbox item with `properties` and the item thread a first message about it creates. The
 * system databases must be seeded first.
 */
async function itemThread(properties: Record<string, unknown>) {
  const inbox = await withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "inbox"));
  if (!inbox) throw new Error("Inbox database was not seeded");
  return inTenantZero(async () => {
    const item = await chokePoint.createItem({
      databaseId: inbox.id,
      properties: { date: "2026-01-01", time: "12:00", ...properties },
    });
    const turn = await withTransaction(pool, (client) =>
      sendSempMessage(client, {
        subject: { inboxItemId: item.id },
        text: "Make it a task",
        context: [],
        hasContext: false,
      }),
    );
    return { inboxDatabaseId: inbox.id, inboxItemId: item.id, threadId: turn.threadId };
  });
}

async function delegateBelow(root: AgentRunRow, hops: number): Promise<AgentRunRow> {
  let run = root;
  for (let hop = 0; hop < hops; hop += 1) {
    run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "delegated", parentRunId: run.id });
  }
  return run;
}

async function foreignTenantUser(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(pool);
  const user = await createRawUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId });
  return { tenantId, userId: user.id };
}

describe("listApprovalRequestsQueue", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    ownerId = (await createTenantZeroUser(pool)).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns pending requests joined with their source project's name and agent run", async () => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    await chokePoint.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "title" });
    const projectItem = await chokePoint.createItem({
      databaseId: projects.id,
      properties: { name: "Renovate the kitchen" },
    });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", projectItemId: projectItem.id });
    const payload = mcpPayload({ to: "a@b.com", apiKey: "secret" });
    const created = await requestOf(run, { riskClass: "write", payload });

    const rows = await listQueue();

    const shared = {
      id: created.id,
      toolName: "send_email",
      riskClass: "write",
      riskLevel: "write",
      requestedAt: created.requestedAt,
      safeSummary: {
        kind: "mcpInvoke",
        mcpToolRegistrationId: payload.mcpToolRegistrationId,
        mcpServerItemId: payload.mcpServerItemId,
        mcpServerName: null,
        mcpToolName: null,
        argKeys: ["to", "apiKey"],
      },
      agentRunId: run.id,
      reason: null,
      description: null,
      breaksLinks: [],
      endsInheritance: [],
      source: THREADLESS_CHAT_SOURCE,
    };
    expect(rows).toEqual([{ ...shared, projectItemId: projectItem.id, projectName: "Renovate the kitchen" }]);
    expect(await decisionView(created)).toEqual({
      ...shared,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      executionStatus: "not_approved",
      conflictReason: null,
    });
  });

  it("carries the value links a request would end on the queue entry and on the decision view alike", async () => {
    const breaksLinks = [
      {
        itemId: randomUUID(),
        itemName: "a.pdf",
        propertyKey: "project",
        sourceItemId: randomUUID(),
        sourceItemName: "Plan trip",
        sourceDatabaseKey: "tasks",
        newValueName: "Alpha",
      },
    ];
    const endsInheritance = [{ itemId: randomUUID(), propertyKey: "project", sourceName: "a.pdf" }];
    const created = await requestOf(await userRun(), {
      toolName: "relation.set",
      riskClass: "breaksLink",
      payload: mcpPayload(),
      description: { key: "approval.breaksLink", params: {}, breaksLinks, endsInheritance },
    });

    const expected = { riskLevel: "breaksLink", breaksLinks, endsInheritance };
    expect((await listQueue())[0]).toMatchObject(expected);
    expect(await decisionView(created)).toMatchObject(expected);
  });

  it("surfaces the agent-supplied reason on the queue entry and on the decision view, null when absent", async () => {
    const run = await userRun();
    const withReason = await requestOf(run, { reason: "Customer asked for a quote" });
    const withoutReason = await requestOf(run);

    const reasons = new Map((await listQueue()).map((row) => [row.id, row.reason]));
    expect([reasons.get(withReason.id), reasons.get(withoutReason.id)]).toEqual(["Customer asked for a quote", null]);
    expect((await decisionView(withReason)).reason).toBe("Customer asked for a quote");
    expect((await decisionView(withoutReason)).reason).toBeNull();
  });

  it("exposes conflictReason on the decision view as a key only, null unless conflicted", async () => {
    const run = await userRun();
    const input = { payload: mcpPayload({ secret: "arg-value" }) };
    const pending = await requestOf(run, input);
    expect((await decisionView(pending)).conflictReason).toBeNull();

    // Terminalizing requires the `queued` state a decided request is in while its execution is pending.
    const changed = await requestOf(run, input);
    const archived = await requestOf(run, input);
    await pool.query(`UPDATE approval_requests SET execution_status = 'queued' WHERE id = ANY($1)`, [
      [changed.id, archived.id],
    ]);
    await withTransaction(pool, async (client) => {
      await terminalizeApprovalRequestAsConflict(client, changed.id, { currentResource: { name: "resource-value" } });
      await terminalizeApprovalRequestAsConflict(client, archived.id, { reason: "database_archived" });
    });

    const changedView = await storedView(changed.id);
    expect(changedView.conflictReason).toEqual({ key: "approval.conflict.changed" });
    expect((await storedView(archived.id)).conflictReason).toEqual({ key: "approval.conflict.archived" });
    expect(JSON.stringify(changedView)).not.toContain("resource-value");
    expect(JSON.stringify(changedView)).not.toContain("arg-value");
  });

  it("summarizes a generic-operation-originated request with its operationName, never mcp fields", async () => {
    const run = await userRun();
    await requestOf(run, {
      toolName: "item.delete",
      riskClass: "destructive",
      payload: {
        operationName: "item.delete",
        canonicalInput: { itemId: randomUUID() },
        actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: run.actorUserId },
        resourceSnapshot: RESOURCE_SNAPSHOT,
      },
    });

    expect((await listQueue()).map((row) => row.safeSummary)).toEqual([
      { kind: "genericOperation", operationName: "item.delete", argKeys: ["itemId"] },
    ]);
  });

  it("summarizes a module-tool-originated request with its tool name and argument keys only", async () => {
    const created = await requestOf(await userRun(), {
      toolName: "gated.apply",
      riskClass: "destructive",
      payload: { moduleToolName: "gated.apply", args: { target: "private-value", count: 2 } },
      resourceSnapshot: { kind: "module_tool", resourceId: "gated.apply", sha256: null },
      description: { key: "approval.moduleTool", params: { toolName: "gated.apply" } },
    });

    const rows = await listQueue();
    const paged = await withTransaction(pool, (client) =>
      listApprovalRequestsQueuePage(client, {
        ownerUserId: ownerId,
        status: "pending",
        sourceKinds: null,
        search: null,
        order: "asc",
        cursor: null,
        limit: 10,
        locale: LOCALE,
      }),
    );
    const view = await decisionView(created);

    // The payload is stored as jsonb, which keeps keys ordered by length and then by bytes.
    const summary = { kind: "moduleTool", toolName: "gated.apply", argKeys: ["count", "target"] };
    expect(rows.map((row) => row.safeSummary)).toEqual([summary]);
    expect(paged.rows.map((row) => row.safeSummary)).toEqual([summary]);
    expect(view.safeSummary).toEqual(summary);
    expect([rows[0]?.riskLevel, view.riskLevel]).toEqual(["irreversible", "irreversible"]);
    expect(rows[0]?.description).toEqual({ key: "approval.moduleTool", params: { toolName: "gated.apply" } });
    expect(JSON.stringify([rows, paged.rows, view])).not.toContain("private-value");
  });

  it.each([
    ["a generic item.delete", "destructive", "item.delete", "write"],
    ["a generic property.delete", "destructive", "property.delete", "irreversible"],
    ["a generic database.archive", "destructive", "database.archive", "write"],
    ["a generic view.delete", "destructive", "view.delete", "irreversible"],
    ["a generic relation.delete", "destructive", "relation.delete", "irreversible"],
    ["an MCP", "destructive", null, "irreversible"],
    ["an MCP", "outbound", null, "outbound"],
    ["an MCP", "breaksLink", null, "breaksLink"],
    ["an MCP", "unclassified", null, "write"],
  ] as const)("derives riskLevel for %s request of class %s: %s", async (_, riskClass, operationName, riskLevel) => {
    const run = await userRun();
    const created = await requestOf(run, {
      toolName: operationName ?? "some_tool",
      riskClass,
      payload:
        operationName === null
          ? mcpPayload()
          : {
              operationName,
              canonicalInput: {},
              actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: run.actorUserId },
              resourceSnapshot: RESOURCE_SNAPSHOT,
            },
    });

    expect((await listQueue())[0]?.riskLevel).toBe(riskLevel);
    expect((await decisionView(created)).riskLevel).toBe(riskLevel);
  });

  describe("MCP server and tool names", () => {
    async function mcpServer(name: string) {
      const database = await withTransaction(pool, (client) =>
        databasesStore.getDatabaseByModuleId(client, "mcpServers"),
      );
      if (!database) throw new Error("mcpServers database was not seeded");
      const server = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, { databaseId: database.id, properties: { name } }),
      );
      return { database, server };
    }

    async function seedMcpRequest(
      source: "user" | "heartbeat" | "supervisor" | "mcp",
      serverName = "Search server",
      toolName = "search_web",
    ) {
      const { database, server } = await mcpServer(serverName);
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: server.id,
        toolName,
        toolSchema: { type: "object" },
      });
      const run = await createAgentRun(pool, { triggeredBy: source, task: "test" });
      const created = await requestOf(run, {
        toolName,
        riskClass: "write",
        payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { q: "x" } },
      });
      return { database, server, created };
    }

    beforeEach(async () => {
      await seedSystem(pool, createViewTypeRegistry());
    });

    it("names the server and the tool in the listed summary and the decision view, whatever the run's trigger", async () => {
      for (const source of ["user", "heartbeat", "supervisor", "mcp"] as const) {
        await resetDatabase(pool);
        await seedSystem(pool, createViewTypeRegistry());
        ownerId = (await createTenantZeroUser(pool)).id;
        const { created } = await seedMcpRequest(source);
        const named = { mcpServerName: "Search server", mcpToolName: "search_web" };
        expect((await listQueue()).map((row) => row.safeSummary)).toEqual([
          expect.objectContaining({ kind: "mcpInvoke", ...named, argKeys: ["q"] }),
        ]);
        expect((await decisionView(created)).safeSummary).toMatchObject(named);
      }
    });

    it("resolves multiple distinct server and tool names in one query per batch", async () => {
      await seedMcpRequest("user");
      await seedMcpRequest("user", "Second server", "second_tool");

      const statements = await statementsDuring(async (client) => {
        const rows = await listApprovalRequestsQueue(client, ownerId, LOCALE);
        expect(rows.map((row) => row.safeSummary)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ mcpServerName: "Search server", mcpToolName: "search_web" }),
            expect.objectContaining({ mcpServerName: "Second server", mcpToolName: "second_tool" }),
          ]),
        );
        expect(rows).toHaveLength(2);
      });

      expect(statements).toHaveLength(5);
      expect(statements.filter((sql) => sql.includes("FROM mcp_tool_registrations WHERE id = ANY"))).toHaveLength(1);
      expect(statements.filter((sql) => sql.includes("FROM items WHERE id = ANY"))).toHaveLength(1);
    });

    it.each([
      [
        "a null server name, with the tool name kept, once the server item is deleted",
        async ({ database, server }: Awaited<ReturnType<typeof seedMcpRequest>>) => {
          await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, database.id, server.id));
        },
        { mcpServerName: null, mcpToolName: "search_web" },
      ],
      [
        "a null tool name when the registration row is gone",
        async () => {
          // Raw delete: no store function removes a registration, and the read must survive one vanishing.
          await pool.query(`DELETE FROM mcp_tool_registrations`);
        },
        { mcpServerName: "Search server", mcpToolName: null },
      ],
    ])("yields %s", async (_, remove, names) => {
      await remove(await seedMcpRequest("user"));
      expect((await listQueue())[0]?.safeSummary).toMatchObject(names);
    });
  });

  it("never includes argument values, only their keys", async () => {
    await requestOf(await userRun(), { toolName: "login", payload: mcpPayload({ password: "hunter2" }) });

    const rows = await listQueue();

    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(rows[0]?.safeSummary.argKeys).toEqual(["password"]);
  });

  it("returns null project fields for a run with no project (e.g. the supervisor's own run)", async () => {
    await requestOf(await createAgentRun(pool, { triggeredBy: "supervisor", task: "test" }), { riskClass: "read" });

    expect((await listQueue())[0]).toMatchObject({ projectItemId: null, projectName: null });
  });

  it("returns an empty array without pending requests, then orders the oldest request first and excludes decided ones", async () => {
    expect(await listQueue()).toEqual([]);
    const run = await userRun();
    const first = await requestOf(run, { toolName: "first" });
    const second = await requestOf(run, { toolName: "second" });
    const decided = await requestOf(run, { toolName: "third" });
    await decideApprovalRequest(pool, decided.id, "approved", ownerId);

    expect((await listQueue()).map((row) => row.id)).toEqual([first.id, second.id]);
  });

  describe("source", () => {
    async function listedSources(locale = LOCALE): Promise<Map<string, ApprovalRequestSource>> {
      return new Map((await listQueue(locale)).map((row) => [row.id, row.source]));
    }

    /** `requests` all have `expected` as their source in the queue, and the first one also on its decision view. */
    async function expectSources(requests: ApprovalRequest[], expected: ApprovalRequestSource): Promise<void> {
      const sources = await listedSources();
      for (const request of requests) expect(sources.get(request.id)).toEqual(expected);
      const [first] = requests;
      if (first) expect((await decisionView(first)).source).toEqual(expected);
    }

    const agentRunReads = async (): Promise<number> =>
      readsOf(await statementsDuring((client) => listApprovalRequestsQueue(client, ownerId, LOCALE)), "agent_runs");

    it("is chat with the thread's id and title for a chat thread, for its own run and for a delegated run", async () => {
      const threadId = await chatThread("Trip to Brno");
      const session = await createAgentRun(pool, { triggeredBy: "user", unit: "session", task: "chat", threadId });
      const delegated = await delegateBelow(session, 1);
      expect(delegated.threadId).toBe(threadId);

      await expectSources([await requestOf(delegated), await requestOf(session)], {
        ...THREADLESS_CHAT_SOURCE,
        threadId,
        threadTitle: "Trip to Brno",
      });
    });

    it("is chat with a null title for a chat thread that has no title yet", async () => {
      const threadId = await chatThread();
      await expectSources([await requestOf(await userRun({ threadId }))], { ...THREADLESS_CHAT_SOURCE, threadId });
    });

    describe("of an item thread", () => {
      beforeEach(async () => {
        await seedSystem(pool, createViewTypeRegistry());
      });

      it("is chat, titled from the Inbox item's text in the caller's locale", async () => {
        const { threadId } = await itemThread({ text: "Buy milk" });
        const created = await requestOf(await userRun({ threadId }));

        const english = { ...THREADLESS_CHAT_SOURCE, threadId, threadTitle: "Edit: Buy milk" };
        expect((await listedSources("en")).get(created.id)).toEqual(english);
        expect((await listedSources("cs")).get(created.id)).toEqual({ ...english, threadTitle: "Úprava: Buy milk" });
        expect((await decisionView(created, "cs")).source.threadTitle).toBe("Úprava: Buy milk");
      });

      it("keeps a null title once its Inbox item is in the trash", async () => {
        const { threadId, inboxDatabaseId, inboxItemId } = await itemThread({ text: "Buy milk" });
        const created = await requestOf(await userRun({ threadId }));
        expect((await listedSources()).get(created.id)?.threadTitle).toBe("Edit: Buy milk");

        expect(await inTenantZero(() => chokePoint.softDeleteItem(inboxDatabaseId, inboxItemId))).not.toBeNull();

        expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, threadId });
      });

      it("has a null title when its Inbox item has no text", async () => {
        const { threadId } = await itemThread({});
        await expectSources([await requestOf(await userRun({ threadId }))], { ...THREADLESS_CHAT_SOURCE, threadId });
      });
    });

    it("is tick with the heartbeat for a tick thread, also when a chat run started the heartbeat", async () => {
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread("Trip to Brno"),
      });
      const { tick, run } = await tickRun();
      const startedFromChat = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "Plan the week",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
        parentRunId: chatRun.id,
      });

      await expectSources([await requestOf(startedFromChat), await requestOf(run)], {
        kind: "tick",
        threadId: tick.threadId,
        threadTitle: "Sunday planning",
        heartbeatId: tick.heartbeatId,
        heartbeatName: "Sunday planning",
        mcpClientName: null,
      });
      // A run that has a thread is not followed to its root: the chat run above it is never read.
      expect(await agentRunReads()).toBe(1);
    });

    it("is mcp with a null client name for a run without a thread whose root run an MCP client started", async () => {
      const root = await createAgentRun(pool, { triggeredBy: "mcp", task: "MCP run-credential session" });
      await expectSources([await requestOf(await delegateBelow(root, 2)), await requestOf(root)], {
        ...THREADLESS_CHAT_SOURCE,
        kind: "mcp",
      });
    });

    it("is tick with the root run's heartbeat for a run without a thread whose root run a heartbeat started", async () => {
      const tick = await tickThread("Sunday planning");
      const root = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "Plan the week",
        heartbeatId: tick.heartbeatId,
      });
      expect(root.threadId).toBeNull();

      await expectSources([await requestOf(root), await requestOf(await delegateBelow(root, 1))], {
        ...THREADLESS_CHAT_SOURCE,
        kind: "tick",
        heartbeatId: tick.heartbeatId,
        heartbeatName: "Sunday planning",
      });
    });

    it("is tick with null heartbeat fields for a heartbeat-triggered run that names no heartbeat", async () => {
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" }));
      expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, kind: "tick" });
    });

    it("is chat for a run without a thread whose root run a person or a supervisor started", async () => {
      await expectSources(
        [
          await requestOf(await delegateBelow(await userRun(), 1)),
          await requestOf(await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" })),
        ],
        THREADLESS_CHAT_SOURCE,
      );
    });

    it("follows the parent chain up to the hop limit and takes the kind of the last run it reached beyond it", async () => {
      const root = await createAgentRun(pool, { triggeredBy: "mcp", task: "MCP run-credential session" });
      const atLimit = await delegateBelow(root, AGENT_RUN_ROOT_MAX_HOPS);
      const reachesRoot = await requestOf(atLimit);
      const stopsBelowRoot = await requestOf(await delegateBelow(atLimit, 1));

      const sources = await listedSources();
      expect(sources.get(reachesRoot.id)?.kind).toBe("mcp");
      expect(sources.get(stopsBelowRoot.id)).toEqual(THREADLESS_CHAT_SOURCE);
      // One read of the requests' runs and one per level of the chain, up to the limit.
      expect(await agentRunReads()).toBe(1 + AGENT_RUN_ROOT_MAX_HOPS);
    });

    it("ends the walk of a parent cycle at the hop limit", async () => {
      const first = await createAgentRun(pool, { triggeredBy: "supervisor", task: "first" });
      const second = await delegateBelow(first, 1);
      // Raw SQL: no production write changes `parent_run_id` after the insert, so none can close a cycle.
      await pool.query("UPDATE agent_runs SET parent_run_id = $2 WHERE id = $1", [first.id, second.id]);
      const created = await requestOf(second);

      expect((await listedSources()).get(created.id)).toEqual(THREADLESS_CHAT_SOURCE);
      expect(await agentRunReads()).toBe(1 + AGENT_RUN_ROOT_MAX_HOPS);
    });

    it("runs the same number of statements for twice as many requests of every kind of source", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const seedOneOfEach = async (label: string): Promise<void> => {
        await requestOf(await userRun({ threadId: await chatThread(`Chat ${label}`) }));
        await requestOf(await userRun({ threadId: (await itemThread({ text: `Item ${label}` })).threadId }));
        await requestOf((await tickRun(`Tick ${label}`)).run);
        await requestOf(await threadlessHeartbeatRun(`Legacy tick ${label}`));
        await requestOf(await delegateBelow(await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" }), 1));
      };
      const listedStatements = () => statementsDuring((client) => listApprovalRequestsQueue(client, ownerId, LOCALE));

      await seedOneOfEach("one");
      const once = await listedStatements();
      await seedOneOfEach("two");
      const twice = await listedStatements();

      const kinds = ["chat", "chat", "tick", "tick", "mcp"];
      expect((await listQueue()).map((row) => row.source.kind)).toEqual([...kinds, ...kinds]);
      expect(twice).toHaveLength(once.length);
      for (const statements of [once, twice]) {
        expect(readsOf(statements, "semp_threads")).toBe(1);
        expect(readsOf(statements, "project_heartbeats")).toBe(1);
        // The requests' runs, then the one level of parents the delegated run has.
        expect(readsOf(statements, "agent_runs")).toBe(2);
      }
    });
  });

  describe("getApprovalRequestSourceKind", () => {
    it("derives the kind the queue shows for a request of the same run, for every shape of source", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const chatSession = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread(),
      });
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "MCP run-credential session" });
      const heartbeatRoot = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" });
      const cases: Array<[AgentRunRow, ApprovalRequestSourceKind]> = [
        [chatSession, "chat"],
        [await delegateBelow(chatSession, 1), "chat"],
        [await userRun({ threadId: (await itemThread({ text: "Buy milk" })).threadId }), "chat"],
        [(await tickRun()).run, "tick"],
        // A chat run started the heartbeat: the tick thread decides.
        [(await tickRun("Sunday planning", chatSession.id)).run, "tick"],
        [mcpRoot, "mcp"],
        [await delegateBelow(mcpRoot, 2), "mcp"],
        [heartbeatRoot, "tick"],
        [await delegateBelow(heartbeatRoot, 1), "tick"],
        [await delegateBelow(await userRun(), 1), "chat"],
        [await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" }), "chat"],
      ];
      const requestIds: string[] = [];
      for (const [run] of cases) requestIds.push((await requestOf(run)).id);

      const derived: Array<ApprovalRequestSourceKind | null> = [];
      for (const [run] of cases) derived.push(await getApprovalRequestSourceKind(pool, run.id));
      const listedKindById = new Map((await listQueue()).map((row) => [row.id, row.source.kind]));

      expect(derived).toEqual(cases.map(([, kind]) => kind));
      expect(requestIds.map((id) => listedKindById.get(id))).toEqual(derived);
    });

    it("answers a run of another tenant like a run that does not exist, under the runtime role", async () => {
      const tenantB = await createTestTenant(pool);
      // A tick run below a chat run: its kind is `tick` only when its thread is read, and `chat` by its root run.
      const chatRun = await userRun({ threadId: await chatThread() });
      const { run: runOfA } = await tickRun("Sunday planning", chatRun.id);
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const kindIn = (tenantId: string, runId: string) =>
          runInTenant(tenantId, () => getApprovalRequestSourceKind(runtimePool, runId));

        expect(await kindIn(getTenantZeroId(), runOfA.id)).toBe("tick");
        expect(await kindIn(tenantB, runOfA.id)).toBeNull();
        expect(await kindIn(tenantB, randomUUID())).toBeNull();
        expect(await getApprovalRequestSourceKind(pool, randomUUID())).toBeNull();
      } finally {
        await runtimePool.end();
      }
    });
  });

  describe("paged list", () => {
    type PageInput = Omit<ListApprovalRequestsPageInput, "ownerUserId">;

    function page(input: Partial<PageInput> = {}) {
      return withTransaction(pool, (client) =>
        listApprovalRequestsQueuePage(client, {
          ownerUserId: ownerId,
          status: "pending",
          sourceKinds: null,
          search: null,
          order: "desc",
          cursor: null,
          limit: 50,
          locale: LOCALE,
          ...input,
        }),
      );
    }

    async function pageIds(input: Partial<PageInput> = {}): Promise<string[]> {
      return (await page(input)).rows.map((row) => row.id);
    }

    async function drain(input: Partial<PageInput>): Promise<string[][]> {
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const result: Awaited<ReturnType<typeof page>> = await page({
          ...input,
          cursor: cursor === null ? null : parseApprovalRequestListCursor(cursor),
        });
        pages.push(result.rows.map((row) => row.id));
        cursor = result.nextCursor;
      } while (cursor !== null);
      return pages;
    }

    const encodeCursor = (text: string): string => Buffer.from(text).toString("base64url");

    it("lists pending requests newest or oldest first, with exactly the fields of the unpaged queue", async () => {
      const run = await userRun();
      const first = await requestOf(run);
      const second = await requestOf(run);
      const third = await requestOf(run);
      await decideApprovalRequest(pool, (await requestOf(run)).id, "approved", ownerId);

      const newestFirst = await page({ order: "desc" });
      expect(newestFirst.rows.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
      expect(newestFirst.nextCursor).toBeNull();

      const oldestFirst = await page({ order: "asc" });
      expect(oldestFirst.rows).toEqual(await listQueue());
      expect(oldestFirst.rows.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
    });

    it("lists decided requests by decision time, each with its status, decision time, execution status and conflict reason", async () => {
      const run = await userRun();
      const approved = await requestOf(run);
      const rejected = await requestOf(run);
      const conflicted = await requestOf(run);
      const pending = await requestOf(run);
      // The second request is decided before the first: the order of the decisions is neither the order
      // in which the requests were made nor its reverse, so no order by request time gives the lists below.
      await decideApprovalRequest(pool, rejected.id, "rejected", ownerId);
      await decideApprovalRequest(pool, approved.id, "approved", ownerId);
      await decideApprovalRequest(pool, conflicted.id, "approved", ownerId);
      await withTransaction(pool, (client) =>
        terminalizeApprovalRequestAsConflict(client, conflicted.id, { reason: "database_archived" }),
      );
      const decided = async (
        request: ApprovalRequest,
        status: string,
        executionStatus: string,
        conflictReason: { key: string } | null = null,
      ) =>
        expect.objectContaining({
          id: request.id,
          status,
          decidedAt: (await getApprovalRequest(pool, request.id))?.decidedAt,
          executionStatus,
          conflictReason,
        });

      const newestFirst = await page({ status: "decided", order: "desc" });
      expect(newestFirst.nextCursor).toBeNull();
      expect(newestFirst.rows).toEqual([
        await decided(conflicted, "approved", "conflict", { key: "approval.conflict.archived" }),
        await decided(approved, "approved", "queued"),
        await decided(rejected, "rejected", "not_approved"),
      ]);
      expect(newestFirst.rows[0]).toMatchObject({ toolName: "send_email", source: THREADLESS_CHAT_SOURCE });
      expect(newestFirst.rows.every((row) => "decidedAt" in row && row.decidedAt !== null)).toBe(true);

      expect(await pageIds({ status: "decided", order: "asc" })).toEqual([rejected.id, approved.id, conflicted.id]);
      expect(await pageIds({ status: "pending" })).toEqual([pending.id]);
    });

    it("leaves a decided request that has no decision time out of both lists", async () => {
      const run = await userRun();
      const decided = await requestOf(run);
      const broken = await requestOf(run);
      await decideApprovalRequest(pool, decided.id, "approved", ownerId);
      await decideApprovalRequest(pool, broken.id, "rejected", ownerId);
      // Raw SQL: no production writer leaves a request without a decision time.
      await pool.query("UPDATE approval_requests SET decided_at = NULL WHERE id = $1", [broken.id]);

      expect(await pageIds({ status: "decided" })).toEqual([decided.id]);
      expect(await pageIds({ status: "pending" })).toEqual([]);
    });

    it("filters by the derived source kind and counts the pending requests the list returns for every combination of kinds", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread("Trip to Brno"),
      });
      const item = await itemThread({ text: "Buy milk" });
      const { tick, run: ofTickRun } = await tickRun();
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
      const heartbeatRoot = await threadlessHeartbeatRun("Legacy tick");
      const userRoot = await userRun();
      const atHopLimit = await delegateBelow(mcpRoot, AGENT_RUN_ROOT_MAX_HOPS);
      const tickFromChat = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "tick",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
        parentRunId: chatRun.id,
      });

      const requestsOf = async (runs: AgentRunRow[]) => {
        const ids: string[] = [];
        for (const run of runs) ids.push((await requestOf(run)).id);
        return ids.sort();
      };
      const chatIds = await requestsOf([
        chatRun,
        await delegateBelow(chatRun, 1),
        await userRun({ threadId: item.threadId }),
        // Beyond the hop limit the root run is not reached, so the request is a chat request.
        await delegateBelow(atHopLimit, 1),
        userRoot,
        await delegateBelow(userRoot, 1),
        await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" }),
      ]);
      const tickIds = await requestsOf([
        ofTickRun,
        tickFromChat,
        heartbeatRoot,
        await delegateBelow(heartbeatRoot, 1),
        await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" }),
      ]);
      const mcpIds = await requestsOf([mcpRoot, await delegateBelow(mcpRoot, 2), atHopLimit]);
      await decideApprovalRequest(pool, (await requestOf(await userRun())).id, "approved", ownerId);
      const filtered = async (sourceKinds: ApprovalRequestSourceKind[]) =>
        (await page({ sourceKinds, order: "asc" })).rows;

      const ofKindChat = await filtered(["chat"]);
      expect(ofKindChat.map((row) => row.id).sort()).toEqual(chatIds);
      expect(ofKindChat.map((row) => row.source.kind)).toEqual(chatIds.map(() => "chat"));
      expect((await filtered(["tick"])).map((row) => row.id).sort()).toEqual(tickIds);
      expect((await filtered(["mcp"])).map((row) => row.id).sort()).toEqual(mcpIds);
      expect((await filtered(["mcp", "tick"])).map((row) => row.id).sort()).toEqual([...mcpIds, ...tickIds].sort());
      const all = (await page({ order: "asc" })).rows;
      expect(all).toHaveLength(chatIds.length + tickIds.length + mcpIds.length);
      for (const kind of ["chat", "tick", "mcp"] as const) {
        expect((await filtered([kind])).map((row) => row.id)).toEqual(
          all.filter((row) => row.source.kind === kind).map((row) => row.id),
        );
      }

      const count = (sourceKinds: ApprovalRequestSourceKind[] | null) =>
        withTransaction(pool, (client) => countPendingApprovalRequests(client, { ownerUserId: ownerId, sourceKinds }));
      const combinations: Array<ApprovalRequestSourceKind[] | null> = [
        null,
        ["chat"],
        ["tick"],
        ["mcp"],
        ["chat", "tick"],
        ["chat", "mcp"],
        ["tick", "mcp"],
        ["chat", "tick", "mcp"],
      ];
      for (const sourceKinds of combinations) {
        const listed = await drain({ sourceKinds });
        expect(await count(sourceKinds), JSON.stringify(sourceKinds)).toBe(listed.flat().length);
      }
      expect([await count(null), await count(["chat"]), await count(["tick"]), await count(["mcp"])]).toEqual([
        15, 7, 5, 3,
      ]);
    });

    it("searches thread titles, heartbeat names, tool names and description values without regard to case or diacritics", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const inChat = await requestOf(await userRun({ threadId: await chatThread("Dovolená v Brně") }), {
        toolName: "tool_a",
      });
      const item = await itemThread({ text: "Koupit mléko" });
      const inItem = await requestOf(await userRun({ threadId: item.threadId }), { toolName: "tool_b" });
      const inTick = await requestOf((await tickRun("Týdenní plánování")).run, { toolName: "tool_c" });
      const heartbeatRoot = await threadlessHeartbeatRun("Noční úklid");
      const belowHeartbeat = await requestOf(await delegateBelow(heartbeatRoot, 1), { toolName: "tool_d" });
      // A run below the same heartbeat run that has a chat thread: its source is the thread, not the heartbeat.
      const untitledChatBelowHeartbeat = await requestOf(
        await createAgentRun(pool, {
          triggeredBy: "supervisor",
          task: "delegated",
          parentRunId: heartbeatRoot.id,
          threadId: await chatThread(),
        }),
        { toolName: "other" },
      );
      const byTool = await requestOf(await userRun(), { toolName: "Odeslat_Zprávu" });
      await requestOf(await userRun(), { toolName: "toolbox" });
      const byDescription = await requestOf(await userRun(), {
        toolName: "property.delete",
        description: {
          key: "approval.propertyDelete",
          params: { propertyName: "Nálada", databaseKey: "journal", databaseName: "Deník", affectedCount: 3 },
        },
      });
      const search = (text: string) => pageIds({ search: text, order: "asc" });

      const found: Array<[string, string[]]> = [
        ["dovolena", [inChat.id]],
        ["BRNE", [inChat.id]],
        ["mleko", [inItem.id]],
        ["tydenni planovani", [inTick.id]],
        ["nocni", [belowHeartbeat.id]],
        ["other", [untitledChatBelowHeartbeat.id]],
        ["odeslat_zpravu", [byTool.id]],
        ["nalada", [byDescription.id]],
        ["Deník", [byDescription.id]],
        // An underscore in the text matches an underscore only, not any character: `toolbox` stays out.
        ["tool_", [inChat.id, inItem.id, inTick.id, belowHeartbeat.id]],
        ["odeslat zpravu", []],
        // Not searched: argument values of the payload, and the key and the parameter names of the description.
        ["a@b.com", []],
        ["propertyDelete", []],
        ["propertyName", []],
      ];
      for (const [text, ids] of found) expect(await search(text), text).toEqual(ids);
      expect(await search("tool")).toHaveLength(5);
      expect(await search("\u0301")).toHaveLength(8);

      // An Inbox item in the trash gives its thread no text to match.
      expect(
        await inTenantZero(() => chokePoint.softDeleteItem(item.inboxDatabaseId, item.inboxItemId)),
      ).not.toBeNull();
      expect(await search("mleko")).toEqual([]);
    });

    it("treats a percent sign and a backslash in the search text as themselves", async () => {
      const described = async (itemName: string) =>
        requestOf(await userRun(), {
          description: { key: "approval.itemDelete", params: { itemName, databaseKey: "tasks" } },
        });
      const withPercent = await described("100% bavlna");
      await described("1000 kusů");
      const withBackslash = await described("C:\\temp");
      await described("C:temp");

      expect(await pageIds({ search: "100%" })).toEqual([withPercent.id]);
      expect(await pageIds({ search: "100" })).toHaveLength(2);
      expect(await pageIds({ search: "c:\\temp" })).toEqual([withBackslash.id]);
      expect(await pageIds({ search: "c:" })).toHaveLength(2);
    });

    it("pages through the list without duplicates or gaps, also across requests of one instant", async () => {
      const run = await userRun();
      const requests = [];
      for (let index = 0; index < 5; index += 1) requests.push(await requestOf(run));
      // Raw SQL: only concurrent inserts give two requests one `requested_at`, and the tie-break needs it every time.
      await pool.query("UPDATE approval_requests SET requested_at = $2 WHERE id = ANY($1::uuid[])", [
        requests.slice(1, 4).map((request) => request.id),
        "2026-03-01T10:00:00.123456Z",
      ]);

      for (const order of ["desc", "asc"] as const) {
        const whole = await pageIds({ order });
        expect([...whole].sort()).toEqual(requests.map((request) => request.id).sort());
        const pages = await drain({ order, limit: 2 });
        expect(pages.map((ids) => ids.length)).toEqual([2, 2, 1]);
        expect(pages.flat()).toEqual(whole);
      }
      expect((await page({ limit: 2 })).nextCursor).toEqual(expect.any(String));
      expect((await page({ limit: 5 })).nextCursor).toBeNull();
      expect(await drain({ limit: 5 })).toHaveLength(1);
    });

    it("pages through the decided list by decision time", async () => {
      const run = await userRun();
      const first = await requestOf(run);
      const second = await requestOf(run);
      const third = await requestOf(run);
      // Decided in neither request order nor its reverse, so the pages follow the decisions.
      for (const request of [second, third, first]) await decideApprovalRequest(pool, request.id, "rejected", ownerId);
      await requestOf(run);

      expect(await drain({ status: "decided", limit: 2 })).toEqual([[first.id, third.id], [second.id]]);
    });

    it("fills a page with matching requests when other requests lie between them", async () => {
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
      const userRoot = await userRun();
      const ofMcp = [];
      for (let index = 0; index < 3; index += 1) {
        ofMcp.push((await requestOf(mcpRoot)).id);
        await requestOf(userRoot);
      }

      expect(await drain({ sourceKinds: ["mcp"], order: "asc", limit: 2 })).toEqual([[ofMcp[0], ofMcp[1]], [ofMcp[2]]]);
    });

    it("returns an empty last page for a cursor that lies beyond every row", async () => {
      await requestOf(await userRun());
      const beyond = parseApprovalRequestListCursor(encodeCursor(`2000-01-01T00:00:00.000000Z|${randomUUID()}`));

      expect(await page({ cursor: beyond })).toEqual({ rows: [], nextCursor: null });
    });

    it("never lists a request of another account, pending or decided", async () => {
      const own = await requestOf(await userRun());
      const ownDecided = await requestOf(await userRun());
      await decideApprovalRequest(pool, ownDecided.id, "approved", ownerId);
      // Another account's run lives in that account's own tenant. This pool bypasses row-level security, so
      // only the owner condition of the query keeps these rows out.
      const foreign = await foreignTenantUser();
      await withTenantTransaction(pool, foreign.tenantId, async (client) => {
        const foreignRun = await createAgentRun(client, { triggeredBy: "user", task: "other", userId: foreign.userId });
        await requestOf(foreignRun, {}, client);
        const decided = await requestOf(foreignRun, {}, client);
        await decideApprovalRequest(client, decided.id, "approved", foreign.userId);
      });

      expect(await pageIds({ status: "pending" })).toEqual([own.id]);
      expect(await pageIds({ status: "decided" })).toEqual([ownDecided.id]);
      expect(await pageIds({ search: "send_email" })).toEqual([own.id]);
      expect(await pageIds({ sourceKinds: ["chat"] })).toEqual([own.id]);
    });

    it("has an index for each of the two lists and the unaccent extension the search folds text with", async () => {
      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'approval_requests' AND indexname = ANY($1::text[])
          ORDER BY indexname`,
        [["approval_requests_tenant_decided_idx", "approval_requests_tenant_status_requested_idx"]],
      );
      expect(indexes.rows).toEqual([
        {
          indexname: "approval_requests_tenant_decided_idx",
          indexdef:
            "CREATE INDEX approval_requests_tenant_decided_idx ON public.approval_requests USING btree (tenant_id, decided_at DESC) WHERE (status <> 'pending'::text)",
        },
        {
          indexname: "approval_requests_tenant_status_requested_idx",
          indexdef:
            "CREATE INDEX approval_requests_tenant_status_requested_idx ON public.approval_requests USING btree (tenant_id, status, requested_at DESC)",
        },
      ]);
      const extension = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'unaccent'",
      );
      expect(extension.rows).toEqual([{ extname: "unaccent" }]);
    });

    describe("parseApprovalRequestListCursor", () => {
      const id = "3f2b8c1e-5d47-4a9b-8e6f-0c1d2e3f4a5b";

      it("decodes the instant and the id of a cursor", () => {
        expect(parseApprovalRequestListCursor(encodeCursor(`2026-03-01T10:00:00.123456Z|${id}`))).toEqual({
          at: "2026-03-01T10:00:00.123456Z",
          id,
        });
      });

      it.each([
        ["an empty value", ""],
        ["a character outside base64url", "abc$"],
        ["text of another shape", encodeCursor("not a cursor")],
        ["an instant without microseconds", encodeCursor(`2026-03-01T10:00:00.123Z|${id}`)],
        ["an id that is no UUID", encodeCursor("2026-03-01T10:00:00.123456Z|not-a-uuid")],
        ["a day that is no calendar day", encodeCursor(`2026-02-30T10:00:00.123456Z|${id}`)],
        ["an hour that is no hour", encodeCursor(`2026-03-01T25:00:00.123456Z|${id}`)],
        ["year zero", encodeCursor(`0000-03-01T10:00:00.123456Z|${id}`)],
        ["more than 128 characters", "A".repeat(129)],
      ])("refuses %s", (_label, value) => {
        let thrown: unknown;
        try {
          parseApprovalRequestListCursor(value);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ValidationError);
        expect(thrown).toMatchObject({ details: { field: "cursor" } });
      });
    });
  });

  describe("attachLiveStepApprovals", () => {
    /** A pending request on a run of `ownerUserId`; its arguments and the later result hold values that must never leak. */
    async function pendingRequestOf(ownerUserId: string, client: Queryable = pool) {
      const run = await createAgentRun(client, { triggeredBy: "user", task: "test", userId: ownerUserId });
      return requestOf(run, { payload: mcpPayload({ to: "argument-value@example.com" }) }, client);
    }

    /** The stored step of a call that is waiting for `approvalRequestId`, as the projector writes it. */
    function waitingStep(approvalRequestId: string | undefined): SempReplyStep {
      return {
        kind: "tool",
        toolCallId: randomUUID(),
        toolName: "send_email",
        label: { key: "agentStep.title.namedTool", params: { toolName: "send_email" } },
        detail: { key: "agentStep.summary.approvalRequested", params: {} },
        status: approvalRequestId === undefined ? "ok" : "wait",
        startedAt: "2026-11-01T10:00:00.000Z",
        durationMs: 12,
        ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
      };
    }

    async function approvalsOf(requestIds: Array<string | undefined>, userId = ownerId) {
      const [message] = await attachLiveStepApprovals(
        pool,
        [{ id: randomUUID(), steps: requestIds.map(waitingStep) }],
        userId,
      );
      return message?.steps ?? [];
    }

    const approve = (id: string) => decideApprovalRequest(pool, id, "approved", ownerId);

    it.each([
      ["pending", async () => {}, { status: "pending", executionStatus: "not_approved", conflictReason: null }],
      [
        "rejected",
        async (id: string) => {
          await decideApprovalRequest(pool, id, "rejected", ownerId);
        },
        { status: "rejected", executionStatus: "not_approved", conflictReason: null },
      ],
      [
        "approved and not executed yet",
        approve,
        { status: "approved", executionStatus: "queued", conflictReason: null },
      ],
      [
        "approved and executed",
        async (id: string) => {
          await approve(id);
          await claimApprovalRequestExecution(pool, id);
          await markApprovalRequestExecutionSucceeded(pool, id, { sentTo: "result-value@example.com" });
        },
        { status: "approved", executionStatus: "succeeded", conflictReason: null },
      ],
      [
        "approved and conflicted",
        async (id: string) => {
          await approve(id);
          await withTransaction(pool, (client) =>
            terminalizeApprovalRequestAsConflict(client, id, { currentResource: { name: "resource-value" } }),
          );
        },
        { status: "approved", executionStatus: "conflict", conflictReason: { key: "approval.conflict.changed" } },
      ],
    ])(
      "returns only the status, execution status and conflict reason key of a request %s, and none of its payload, arguments, result or conflict details",
      async (_, settle, approval) => {
        const request = await pendingRequestOf(ownerId);
        await settle(request.id);

        const attached = await approvalsOf([request.id]);

        expect(attached[0]?.approval).toEqual(approval);
        const json = JSON.stringify(attached);
        for (const secret of ["argument-value", "result-value", "resource-value", "payload"]) {
          expect(json).not.toContain(secret);
        }
      },
    );

    it("reads the requests of a page with one approval request lookup, not one per step", async () => {
      const requests = await Promise.all([1, 2, 3, 4, 5].map(() => pendingRequestOf(ownerId)));
      const messages = [
        { id: randomUUID(), steps: requests.slice(0, 3).map((request) => waitingStep(request.id)) },
        { id: randomUUID(), steps: requests.slice(3).map((request) => waitingStep(request.id)) },
      ];

      const statements = await statementsDuring(async (client) => {
        const attached = await attachLiveStepApprovals(client, messages, ownerId);
        expect(attached.flatMap((message) => message.steps ?? []).map((step) => step.approval?.status)).toEqual(
          requests.map(() => "pending"),
        );
      });

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("FROM approval_requests");
    });

    it("does not query at all for a page whose steps hold no approval request", async () => {
      const statements = await statementsDuring((client) =>
        attachLiveStepApprovals(
          client,
          [{ id: randomUUID(), steps: [waitingStep(undefined)] }, { id: randomUUID() }],
          ownerId,
        ),
      );
      expect(statements).toEqual([]);
    });

    it("gives a missing request and a request of another user the same null, and still reads the caller's own", async () => {
      // The other user lives in a tenant of its own. This pool bypasses row-level security, so only the owner
      // condition of the query keeps the foreign request out.
      const other = await foreignTenantUser();
      const own = await pendingRequestOf(ownerId);
      const foreign = await withTenantTransaction(pool, other.tenantId, (client) =>
        pendingRequestOf(other.userId, client),
      );

      const attached = await approvalsOf([own.id, foreign.id, randomUUID()]);

      expect(attached[0]?.approval).toMatchObject({ status: "pending" });
      expect(attached[1]).toHaveProperty("approval", null);
      expect(attached[2]).toHaveProperty("approval", null);
      // The same request is readable for its owner, so the null above comes from the owner condition.
      expect((await approvalsOf([foreign.id], other.userId))[0]?.approval).toMatchObject({ status: "pending" });
    });

    it("leaves a step without an approval request and a message without steps as they are, and the input unchanged", async () => {
      const request = await pendingRequestOf(ownerId);
      const plain = waitingStep(undefined);
      const waiting = waitingStep(request.id);
      const stored = structuredClone([plain, waiting]);
      const messages = [{ id: randomUUID(), steps: [plain, waiting] }, { id: randomUUID() }];

      const attached = await attachLiveStepApprovals(pool, messages, ownerId);

      expect(attached[0]?.steps?.[0]).toEqual(plain);
      expect(attached[0]?.steps?.[0]).not.toHaveProperty("approval");
      expect(attached[0]?.steps?.[1]).toMatchObject({ ...waiting, approval: { status: "pending" } });
      expect(attached[1]).toEqual({ id: messages[1]?.id });
      expect(attached[1]).not.toHaveProperty("steps");
      expect(messages[0]?.steps).toEqual(stored);
    });
  });
});

function readsOf(statements: string[], table: string): number {
  return statements.filter((sql) => sql.includes(`FROM ${table} WHERE id = ANY`)).length;
}
