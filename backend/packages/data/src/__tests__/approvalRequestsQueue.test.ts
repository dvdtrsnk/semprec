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
  type ApprovalDescription,
  type ApprovalRequestSourceKind,
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

/** The locale the reads of this file are made in; an item thread's title is written in it. */
const LOCALE = "en";

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

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

/**
 * A pending request of `run` for an outbound MCP tool: `send_email` unless `options` names another
 * tool. `options.description` is the description snapshot stored with it.
 */
async function requestOf(run: AgentRunRow, options: { toolName?: string; description?: ApprovalDescription } = {}) {
  return createPendingApprovalRequest(pool, {
    agentRunId: run.id,
    toolName: options.toolName ?? "send_email",
    riskClass: "outbound",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    description: options.description,
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

/** A heartbeat called `name` and its tick thread, both through their production writers. */
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

/** `hops` delegated runs below `root`, each the parent of the next; returns the lowest one. */
async function delegateBelow(root: AgentRunRow, hops: number): Promise<AgentRunRow> {
  let run = root;
  for (let hop = 0; hop < hops; hop += 1) {
    run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "delegated", parentRunId: run.id });
  }
  return run;
}

describe("listApprovalRequestsQueue (issue #132)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    ownerId = await createUser();
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

    const payload = {
      mcpToolRegistrationId: randomUUID(),
      mcpServerItemId: randomUUID(),
      args: { to: "a@b.com", apiKey: "secret" },
    };
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "write",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
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
      projectItemId: projectItem.id,
      projectName: "Renovate the kitchen",
      reason: null,
      description: null,
      breaksLinks: [],
      endsInheritance: [],
      source: THREADLESS_CHAT_SOURCE,
    });
    expect(await toApprovalRequestDecisionView(pool, created, LOCALE)).toEqual({
      id: created.id,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      executionStatus: "not_approved",
      conflictReason: null,
      toolName: "send_email",
      riskClass: "write",
      riskLevel: "write",
      requestedAt: created.requestedAt,
      agentRunId: run.id,
      safeSummary: rows[0]!.safeSummary,
      reason: null,
      description: null,
      breaksLinks: [],
      endsInheritance: [],
      source: THREADLESS_CHAT_SOURCE,
    });
  });

  it("carries the value links a request would end on the queue entry and on the decision view alike (issue #1758)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
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
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "relation.set",
      riskClass: "breaksLink",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      description: { key: "approval.breaksLink", params: {}, breaksLinks, endsInheritance },
    });

    const [entry] = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
    const view = await toApprovalRequestDecisionView(pool, created, LOCALE);

    expect(entry).toMatchObject({ riskLevel: "breaksLink", breaksLinks, endsInheritance });
    expect(view).toMatchObject({ riskLevel: "breaksLink", breaksLinks, endsInheritance });
  });

  it("surfaces the agent-supplied reason on the queue entry and on the decision view, null when absent", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const base = {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "write" as const,
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    };
    const withReason = await createPendingApprovalRequest(pool, { ...base, reason: "Customer asked for a quote" });
    const withoutReason = await createPendingApprovalRequest(pool, base);

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
    expect(rows.find((row) => row.id === withReason.id)!.reason).toBe("Customer asked for a quote");
    expect(rows.find((row) => row.id === withoutReason.id)!.reason).toBeNull();

    expect((await toApprovalRequestDecisionView(pool, withReason, LOCALE)).reason).toBe("Customer asked for a quote");
    expect((await toApprovalRequestDecisionView(pool, withoutReason, LOCALE)).reason).toBeNull();
  });

  it("exposes conflictReason on the decision view as a key only, null unless conflicted", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const base = {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "write" as const,
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { secret: "arg-value" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    };
    const pending = await createPendingApprovalRequest(pool, base);
    expect((await toApprovalRequestDecisionView(pool, pending, LOCALE)).conflictReason).toBeNull();

    // Terminalizing requires the `queued` state a decided request is in while its execution is pending.
    const changed = await createPendingApprovalRequest(pool, base);
    const archived = await createPendingApprovalRequest(pool, base);
    await pool.query(`UPDATE approval_requests SET execution_status = 'queued' WHERE id = ANY($1)`, [
      [changed.id, archived.id],
    ]);
    await withTransaction(pool, (client) =>
      terminalizeApprovalRequestAsConflict(client, changed.id, { currentResource: { name: "resource-value" } }),
    );
    await withTransaction(pool, (client) =>
      terminalizeApprovalRequestAsConflict(client, archived.id, { reason: "database_archived" }),
    );

    const changedView = await toApprovalRequestDecisionView(
      pool,
      (await getApprovalRequest(pool, changed.id))!,
      LOCALE,
    );
    const archivedView = await toApprovalRequestDecisionView(
      pool,
      (await getApprovalRequest(pool, archived.id))!,
      LOCALE,
    );
    expect(changedView.conflictReason).toEqual({ key: "approval.conflict.changed" });
    expect(archivedView.conflictReason).toEqual({ key: "approval.conflict.archived" });
    expect(JSON.stringify(changedView)).not.toContain("resource-value");
    expect(JSON.stringify(changedView)).not.toContain("arg-value");
  });

  it("summarizes a generic-operation-originated request with its operationName, never mcp fields (issue #220)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = {
      operationName: "item.delete",
      canonicalInput: { itemId: randomUUID() },
      actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: run.actorUserId },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "item.delete",
      riskClass: "destructive",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.safeSummary).toEqual({
      kind: "genericOperation",
      operationName: "item.delete",
      argKeys: ["itemId"],
    });
  });

  it("summarizes a module-tool-originated request with its tool name and argument keys only (issue #1791)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "gated.apply",
      riskClass: "destructive",
      payload: { moduleToolName: "gated.apply", args: { target: "private-value", count: 2 } },
      resourceSnapshot: { kind: "module_tool", resourceId: "gated.apply", sha256: null },
      description: { key: "approval.moduleTool", params: { toolName: "gated.apply" } },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
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
    const view = await toApprovalRequestDecisionView(pool, created, LOCALE);

    // The payload is stored as jsonb, which keeps keys ordered by length and then by bytes.
    const summary = { kind: "moduleTool", toolName: "gated.apply", argKeys: ["count", "target"] };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.safeSummary).toEqual(summary);
    expect(paged.rows.map((row) => row.safeSummary)).toEqual([summary]);
    expect(view.safeSummary).toEqual(summary);
    expect(rows[0]!.riskLevel).toBe("irreversible");
    expect(view.riskLevel).toBe("irreversible");
    expect(rows[0]!.description).toEqual({ key: "approval.moduleTool", params: { toolName: "gated.apply" } });
    expect(JSON.stringify([rows, paged.rows, view])).not.toContain("private-value");
  });

  it.each([
    ["item.delete", "write"],
    ["property.delete", "irreversible"],
    ["database.archive", "write"],
    ["view.delete", "irreversible"],
    ["relation.delete", "irreversible"],
  ] as const)("derives riskLevel for a generic %s request: %s", async (operationName, riskLevel) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: operationName,
      riskClass: "destructive",
      payload: {
        operationName,
        canonicalInput: {},
        actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: run.actorUserId },
        resourceSnapshot,
      },
      resourceSnapshot,
    });
    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
    expect(rows[0]!.riskLevel).toBe(riskLevel);
    expect((await toApprovalRequestDecisionView(pool, created, LOCALE)).riskLevel).toBe(riskLevel);
  });

  it.each([
    ["destructive", "irreversible"],
    ["outbound", "outbound"],
    ["breaksLink", "breaksLink"],
    ["unclassified", "write"],
  ] as const)("derives riskLevel for an MCP request of class %s: %s", async (riskClass, riskLevel) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "some_tool",
      riskClass,
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
    expect(rows[0]!.riskLevel).toBe(riskLevel);
    expect((await toApprovalRequestDecisionView(pool, created, LOCALE)).riskLevel).toBe(riskLevel);
  });

  describe("MCP server and tool names", () => {
    const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };

    async function seedMcpRequest(source: "user" | "heartbeat" | "supervisor" | "mcp") {
      await seedSystem(pool, createViewTypeRegistry());
      const database = await withTransaction(pool, (client) =>
        databasesStore.getDatabaseByModuleId(client, "mcpServers"),
      );
      if (!database) throw new Error("mcpServers database was not seeded");
      const server = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, { databaseId: database.id, properties: { name: "Search server" } }),
      );
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: server.id,
        toolName: "search_web",
        toolSchema: { type: "object" },
      });
      const run = await createAgentRun(pool, { triggeredBy: source, task: "test" });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "search_web",
        riskClass: "write",
        payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { q: "x" } },
        resourceSnapshot,
      });
      return { database, server, created };
    }

    it("names the server and the tool in the listed summary, whatever the run's trigger", async () => {
      for (const source of ["user", "heartbeat", "supervisor", "mcp"] as const) {
        await resetDatabase(pool);
        ownerId = await createUser();
        await seedMcpRequest(source);
        const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.safeSummary).toMatchObject({
          kind: "mcpInvoke",
          mcpServerName: "Search server",
          mcpToolName: "search_web",
          argKeys: ["q"],
        });
      }
    });

    it("names them in the decision view too", async () => {
      const { created } = await seedMcpRequest("user");
      const view = await toApprovalRequestDecisionView(pool, created, LOCALE);
      expect(view.safeSummary).toMatchObject({ mcpServerName: "Search server", mcpToolName: "search_web" });
    });

    it("resolves multiple distinct server and tool names in one query per batch", async () => {
      const { database } = await seedMcpRequest("user");
      const server = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, { databaseId: database.id, properties: { name: "Second server" } }),
      );
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: server.id,
        toolName: "second_tool",
        toolSchema: { type: "object" },
      });
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "second_tool",
        riskClass: "write",
        payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: {} },
        resourceSnapshot,
      });

      await withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          const rows = await listApprovalRequestsQueue(client, ownerId, LOCALE);
          expect(rows.map((row) => row.safeSummary)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ mcpServerName: "Search server", mcpToolName: "search_web" }),
              expect.objectContaining({ mcpServerName: "Second server", mcpToolName: "second_tool" }),
            ]),
          );
          expect(rows).toHaveLength(2);
          const statements = query.mock.calls
            .map(([sql]) => sql)
            .filter((sql): sql is string => typeof sql === "string");
          expect(statements).toHaveLength(5);
          expect(statements.filter((sql) => sql.includes("FROM mcp_tool_registrations WHERE id = ANY"))).toHaveLength(
            1,
          );
          expect(statements.filter((sql) => sql.includes("FROM items WHERE id = ANY"))).toHaveLength(1);
        } finally {
          query.mockRestore();
        }
      });
    });

    it("yields a null server name, with the tool name kept, once the server item is deleted", async () => {
      const { database, server } = await seedMcpRequest("user");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, database.id, server.id));
      const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
      expect(rows[0]!.safeSummary).toMatchObject({ mcpServerName: null, mcpToolName: "search_web" });
    });

    it("yields a null tool name when the registration row is gone", async () => {
      await seedMcpRequest("user");
      // Raw delete: no store function removes a registration, and the read must survive one vanishing.
      await pool.query(`DELETE FROM mcp_tool_registrations`);
      const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);
      expect(rows[0]!.safeSummary).toMatchObject({ mcpServerName: "Search server", mcpToolName: null });
    });
  });

  it("never includes argument values, only their keys", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = {
      mcpToolRegistrationId: randomUUID(),
      mcpServerItemId: randomUUID(),
      args: { password: "hunter2" },
    };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "login",
      riskClass: "outbound",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);

    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(rows[0]!.safeSummary.argKeys).toEqual(["password"]);
  });

  it("returns null project fields for a run with no project (e.g. the supervisor's own run)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "noop",
      riskClass: "read",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);

    expect(rows[0]!.projectItemId).toBeNull();
    expect(rows[0]!.projectName).toBeNull();
  });

  it("orders oldest request first and excludes decided requests", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
    const first = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "first",
      riskClass: "read",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const second = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "second",
      riskClass: "read",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const decided = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "third",
      riskClass: "read",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    await decideApprovalRequest(pool, decided.id, "approved", ownerId);

    const rows = await listApprovalRequestsQueue(pool, ownerId, LOCALE);

    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("returns an empty array when there are no pending requests", async () => {
    expect(await listApprovalRequestsQueue(pool, ownerId, LOCALE)).toEqual([]);
  });

  describe("source (issue #1766)", () => {
    /** The sources the queue lists in `locale`, by request id. */
    async function listedSources(locale = LOCALE): Promise<Map<string, ApprovalRequestSource>> {
      const rows = await listApprovalRequestsQueue(pool, ownerId, locale);
      return new Map(rows.map((row) => [row.id, row.source]));
    }

    /** The statements `listApprovalRequestsQueue` runs, read inside one transaction. */
    async function listedStatements(): Promise<string[]> {
      return withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          await listApprovalRequestsQueue(client, ownerId, LOCALE);
          return query.mock.calls.map(([sql]) => sql).filter((sql): sql is string => typeof sql === "string");
        } finally {
          query.mockRestore();
        }
      });
    }

    const readsOf = (statements: string[], table: string): number =>
      statements.filter((sql) => sql.includes(`FROM ${table} WHERE id = ANY`)).length;

    it("is chat with the thread's id and title for a chat thread, for its own run and for a delegated run", async () => {
      const threadId = await chatThread("Trip to Brno");
      const session = await createAgentRun(pool, { triggeredBy: "user", unit: "session", task: "chat", threadId });
      const delegated = await delegateBelow(session, 1);
      expect(delegated.threadId).toBe(threadId);
      // A Semp chat run asking to call an outbound MCP tool: the request payload is an MCP invoke.
      const own = await requestOf(session);
      const fromDelegated = await requestOf(delegated);

      const expected: ApprovalRequestSource = {
        kind: "chat",
        threadId,
        threadTitle: "Trip to Brno",
        heartbeatId: null,
        heartbeatName: null,
        mcpClientName: null,
      };
      const sources = await listedSources();
      expect(sources.get(own.id)).toEqual(expected);
      expect(sources.get(fromDelegated.id)).toEqual(expected);
      expect((await toApprovalRequestDecisionView(pool, fromDelegated, LOCALE)).source).toEqual(expected);
    });

    it("is chat with a null title for a chat thread that has no title yet", async () => {
      const threadId = await chatThread();
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId }));

      expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, threadId });
    });

    it("is chat for an item thread, titled from the Inbox item's text in the caller's locale", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const { threadId } = await itemThread({ text: "Buy milk" });
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId }));

      const english = { ...THREADLESS_CHAT_SOURCE, threadId, threadTitle: "Edit: Buy milk" };
      expect((await listedSources("en")).get(created.id)).toEqual(english);
      expect((await listedSources("cs")).get(created.id)).toEqual({ ...english, threadTitle: "Úprava: Buy milk" });
      expect((await toApprovalRequestDecisionView(pool, created, "cs")).source.threadTitle).toBe("Úprava: Buy milk");
    });

    it("keeps an item thread's source with a null title once its Inbox item is in the trash", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const { threadId, inboxDatabaseId, inboxItemId } = await itemThread({ text: "Buy milk" });
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId }));
      expect((await listedSources()).get(created.id)?.threadTitle).toBe("Edit: Buy milk");

      expect(await inTenantZero(() => chokePoint.softDeleteItem(inboxDatabaseId, inboxItemId))).not.toBeNull();

      expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, threadId });
    });

    it("gives an item thread a null title when its Inbox item has no text", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const { threadId } = await itemThread({});
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId }));

      expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, threadId });
    });

    it("is tick with the heartbeat for a tick thread, also when a chat run started the heartbeat", async () => {
      const tick = await tickThread("Sunday planning");
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread("Trip to Brno"),
      });
      const heartbeatRun = {
        triggeredBy: "heartbeat" as const,
        task: "Plan the week",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
      };
      const scheduled = await requestOf(await createAgentRun(pool, heartbeatRun));
      const startedFromChat = await requestOf(await createAgentRun(pool, { ...heartbeatRun, parentRunId: chatRun.id }));

      const expected: ApprovalRequestSource = {
        kind: "tick",
        threadId: tick.threadId,
        threadTitle: "Sunday planning",
        heartbeatId: tick.heartbeatId,
        heartbeatName: "Sunday planning",
        mcpClientName: null,
      };
      const sources = await listedSources();
      expect(sources.get(scheduled.id)).toEqual(expected);
      expect(sources.get(startedFromChat.id)).toEqual(expected);
      expect((await toApprovalRequestDecisionView(pool, startedFromChat, LOCALE)).source).toEqual(expected);
      // A run that has a thread is not followed to its root: the chat run above it is never read.
      expect(readsOf(await listedStatements(), "agent_runs")).toBe(1);
    });

    it("is mcp with a null client name for a run without a thread whose root run an MCP client started", async () => {
      const root = await createAgentRun(pool, { triggeredBy: "mcp", task: "MCP run-credential session" });
      const own = await requestOf(root);
      const fromDelegated = await requestOf(await delegateBelow(root, 2));

      const expected: ApprovalRequestSource = { ...THREADLESS_CHAT_SOURCE, kind: "mcp" };
      const sources = await listedSources();
      expect(sources.get(own.id)).toEqual(expected);
      expect(sources.get(fromDelegated.id)).toEqual(expected);
      expect((await toApprovalRequestDecisionView(pool, fromDelegated, LOCALE)).source).toEqual(expected);
    });

    it("is tick with the root run's heartbeat for a run without a thread whose root run a heartbeat started", async () => {
      const tick = await tickThread("Sunday planning");
      const root = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "Plan the week",
        heartbeatId: tick.heartbeatId,
      });
      expect(root.threadId).toBeNull();
      const own = await requestOf(root);
      const fromDelegated = await requestOf(await delegateBelow(root, 1));

      const expected: ApprovalRequestSource = {
        ...THREADLESS_CHAT_SOURCE,
        kind: "tick",
        heartbeatId: tick.heartbeatId,
        heartbeatName: "Sunday planning",
      };
      const sources = await listedSources();
      expect(sources.get(own.id)).toEqual(expected);
      expect(sources.get(fromDelegated.id)).toEqual(expected);
    });

    it("is tick with null heartbeat fields for a heartbeat-triggered run that names no heartbeat", async () => {
      const created = await requestOf(await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" }));

      expect((await listedSources()).get(created.id)).toEqual({ ...THREADLESS_CHAT_SOURCE, kind: "tick" });
    });

    it("is chat for a run without a thread whose root run a person or a supervisor started", async () => {
      const belowUser = await requestOf(
        await delegateBelow(await createAgentRun(pool, { triggeredBy: "user", task: "chat" }), 1),
      );
      const supervisorRoot = await requestOf(await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" }));

      const sources = await listedSources();
      expect(sources.get(belowUser.id)).toEqual(THREADLESS_CHAT_SOURCE);
      expect(sources.get(supervisorRoot.id)).toEqual(THREADLESS_CHAT_SOURCE);
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
      expect(readsOf(await listedStatements(), "agent_runs")).toBe(1 + AGENT_RUN_ROOT_MAX_HOPS);
    });

    it("ends the walk of a parent cycle at the hop limit", async () => {
      const first = await createAgentRun(pool, { triggeredBy: "supervisor", task: "first" });
      const second = await delegateBelow(first, 1);
      // Raw SQL: no production write changes `parent_run_id` after the insert, so none can close a cycle.
      await pool.query("UPDATE agent_runs SET parent_run_id = $2 WHERE id = $1", [first.id, second.id]);
      const created = await requestOf(second);

      expect((await listedSources()).get(created.id)).toEqual(THREADLESS_CHAT_SOURCE);
      expect(readsOf(await listedStatements(), "agent_runs")).toBe(1 + AGENT_RUN_ROOT_MAX_HOPS);
    });

    it("runs the same number of statements for twice as many requests of every kind of source", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const seedOneOfEach = async (label: string): Promise<void> => {
        const chat = await chatThread(`Chat ${label}`);
        await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: chat }));
        const item = await itemThread({ text: `Item ${label}` });
        await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: item.threadId }));
        const tick = await tickThread(`Tick ${label}`);
        await requestOf(
          await createAgentRun(pool, {
            triggeredBy: "heartbeat",
            task: "tick",
            projectItemId: tick.projectItemId,
            heartbeatId: tick.heartbeatId,
            threadId: tick.threadId,
          }),
        );
        const legacyTick = await tickThread(`Legacy tick ${label}`);
        await requestOf(
          await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick", heartbeatId: legacyTick.heartbeatId }),
        );
        await requestOf(await delegateBelow(await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" }), 1));
      };

      await seedOneOfEach("one");
      const once = await listedStatements();
      await seedOneOfEach("two");
      const twice = await listedStatements();

      expect((await listApprovalRequestsQueue(pool, ownerId, LOCALE)).map((row) => row.source.kind)).toEqual([
        "chat",
        "chat",
        "tick",
        "tick",
        "mcp",
        "chat",
        "chat",
        "tick",
        "tick",
        "mcp",
      ]);
      expect(twice).toHaveLength(once.length);
      for (const statements of [once, twice]) {
        expect(readsOf(statements, "semp_threads")).toBe(1);
        expect(readsOf(statements, "project_heartbeats")).toBe(1);
        // The requests' runs, then the one level of parents the delegated run has.
        expect(readsOf(statements, "agent_runs")).toBe(2);
      }
    });
  });

  describe("getApprovalRequestSourceKind (issue #1787)", () => {
    /** A run of the tick thread of a new heartbeat, below `parentRunId` when one is given. */
    async function tickRun(parentRunId?: string): Promise<AgentRunRow> {
      const tick = await tickThread("Sunday planning");
      return createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "Plan the week",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
        parentRunId,
      });
    }

    it("is chat for a run of a chat thread or an item thread, and for a run delegated below one", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const session = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread(),
      });
      const delegated = await delegateBelow(session, 1);
      const { threadId } = await itemThread({ text: "Buy milk" });
      const aboutItem = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId });

      expect(await getApprovalRequestSourceKind(pool, session.id)).toBe("chat");
      expect(await getApprovalRequestSourceKind(pool, delegated.id)).toBe("chat");
      expect(await getApprovalRequestSourceKind(pool, aboutItem.id)).toBe("chat");
    });

    it("is tick for a run of a tick thread, also when a chat run started the heartbeat", async () => {
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: await chatThread(),
      });

      expect(await getApprovalRequestSourceKind(pool, (await tickRun()).id)).toBe("tick");
      expect(await getApprovalRequestSourceKind(pool, (await tickRun(chatRun.id)).id)).toBe("tick");
    });

    it("takes the kind of a run without a thread from the trigger of its root run", async () => {
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "MCP run-credential session" });
      const heartbeatRoot = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" });
      const userRoot = await createAgentRun(pool, { triggeredBy: "user", task: "chat" });
      const supervisorRoot = await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" });

      expect(await getApprovalRequestSourceKind(pool, mcpRoot.id)).toBe("mcp");
      expect(await getApprovalRequestSourceKind(pool, (await delegateBelow(mcpRoot, 2)).id)).toBe("mcp");
      expect(await getApprovalRequestSourceKind(pool, heartbeatRoot.id)).toBe("tick");
      expect(await getApprovalRequestSourceKind(pool, (await delegateBelow(heartbeatRoot, 1)).id)).toBe("tick");
      expect(await getApprovalRequestSourceKind(pool, (await delegateBelow(userRoot, 1)).id)).toBe("chat");
      expect(await getApprovalRequestSourceKind(pool, supervisorRoot.id)).toBe("chat");
    });

    it("is null for a run that does not exist", async () => {
      expect(await getApprovalRequestSourceKind(pool, randomUUID())).toBeNull();
    });

    it("derives the kind the queue shows for a request of the same run, for every shape of source", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const item = await itemThread({ text: "Buy milk" });
      const runs = [
        await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: await chatThread() }),
        await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: item.threadId }),
        await tickRun(),
        await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" }),
        await delegateBelow(await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" }), 1),
        await createAgentRun(pool, { triggeredBy: "user", task: "chat" }),
      ];
      const requestIds: string[] = [];
      for (const run of runs) requestIds.push((await requestOf(run)).id);

      const listedKindById = new Map(
        (await listApprovalRequestsQueue(pool, ownerId, LOCALE)).map((row) => [row.id, row.source.kind]),
      );
      const derived: Array<ApprovalRequestSourceKind | null> = [];
      for (const run of runs) derived.push(await getApprovalRequestSourceKind(pool, run.id));

      expect(derived).toEqual(["chat", "chat", "tick", "tick", "mcp", "chat"]);
      expect(requestIds.map((id) => listedKindById.get(id))).toEqual(derived);
    });

    it("answers a run of another tenant like a run that does not exist, under the runtime role", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(pool);
      // A tick run below a chat run: its kind is `tick` only when its thread is read, and `chat` by its root run.
      const chatRun = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: await chatThread() });
      const runOfA = await tickRun(chatRun.id);
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const kindIn = (tenantId: string, runId: string) =>
          runInTenant(tenantId, () => getApprovalRequestSourceKind(runtimePool, runId));

        expect(await kindIn(tenantA, runOfA.id)).toBe("tick");
        expect(await kindIn(tenantB, runOfA.id)).toBeNull();
        expect(await kindIn(tenantB, randomUUID())).toBeNull();
      } finally {
        await runtimePool.end();
      }
    });
  });

  describe("paged list (issue #1785)", () => {
    type PageInput = Omit<ListApprovalRequestsPageInput, "ownerUserId">;

    /** One page of the owner's list; `input` overrides the pending list, newest first, of every source. */
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

    /** The ids of every page of the list, read by following `nextCursor` until it is null. */
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

    const userRun = () => createAgentRun(pool, { triggeredBy: "user", task: "test" });

    function encodeCursor(text: string): string {
      return Buffer.from(text).toString("base64url");
    }

    it("lists pending requests newest or oldest first, with exactly the fields of the unpaged queue", async () => {
      const run = await userRun();
      const first = await requestOf(run);
      const second = await requestOf(run);
      const third = await requestOf(run);
      const decided = await requestOf(run);
      await decideApprovalRequest(pool, decided.id, "approved", ownerId);

      const newestFirst = await page({ order: "desc" });
      expect(newestFirst.rows.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
      expect(newestFirst.nextCursor).toBeNull();

      const oldestFirst = await page({ order: "asc" });
      expect(oldestFirst.rows).toEqual(await listApprovalRequestsQueue(pool, ownerId, LOCALE));
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
      const decidedAt = async (id: string) => (await getApprovalRequest(pool, id))?.decidedAt;

      const newestFirst = await page({ status: "decided", order: "desc" });
      expect(newestFirst.nextCursor).toBeNull();
      expect(newestFirst.rows.map((row) => row.id)).toEqual([conflicted.id, approved.id, rejected.id]);
      expect(newestFirst.rows).toEqual([
        expect.objectContaining({
          id: conflicted.id,
          toolName: "send_email",
          source: THREADLESS_CHAT_SOURCE,
          status: "approved",
          decidedAt: await decidedAt(conflicted.id),
          executionStatus: "conflict",
          conflictReason: { key: "approval.conflict.archived" },
        }),
        expect.objectContaining({
          id: approved.id,
          status: "approved",
          decidedAt: await decidedAt(approved.id),
          executionStatus: "queued",
          conflictReason: null,
        }),
        expect.objectContaining({
          id: rejected.id,
          status: "rejected",
          decidedAt: await decidedAt(rejected.id),
          executionStatus: "not_approved",
          conflictReason: null,
        }),
      ]);
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
      // Raw SQL: only the one-time cutover of issue #89 rejects a request without a decision time, and it
      // does nothing on a database that it has already migrated, as this one is.
      await pool.query("UPDATE approval_requests SET decided_at = NULL WHERE id = $1", [broken.id]);

      expect(await pageIds({ status: "decided" })).toEqual([decided.id]);
      expect(await pageIds({ status: "pending" })).toEqual([]);
    });

    it("filters by the derived source kind: chat keeps chat and item threads and delegated runs, and no tick or MCP request", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const chat = await chatThread("Trip to Brno");
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: chat,
      });
      const item = await itemThread({ text: "Buy milk" });
      const tick = await tickThread("Sunday planning");
      const tickRun = {
        triggeredBy: "heartbeat" as const,
        task: "tick",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
      };
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
      const heartbeatRoot = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "tick",
        heartbeatId: (await tickThread("Legacy tick")).heartbeatId,
      });
      const userRoot = await userRun();
      const atHopLimit = await delegateBelow(mcpRoot, AGENT_RUN_ROOT_MAX_HOPS);

      const ofChat = await requestOf(chatRun);
      const ofChatDelegated = await requestOf(await delegateBelow(chatRun, 1));
      const ofItem = await requestOf(
        await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: item.threadId }),
      );
      const ofTick = await requestOf(await createAgentRun(pool, tickRun));
      const ofTickFromChat = await requestOf(await createAgentRun(pool, { ...tickRun, parentRunId: chatRun.id }));
      const ofMcp = await requestOf(mcpRoot);
      const ofMcpDelegated = await requestOf(await delegateBelow(mcpRoot, 2));
      const ofMcpAtHopLimit = await requestOf(atHopLimit);
      const beyondHopLimit = await requestOf(await delegateBelow(atHopLimit, 1));
      const ofHeartbeatRoot = await requestOf(heartbeatRoot);
      const belowHeartbeatRoot = await requestOf(await delegateBelow(heartbeatRoot, 1));
      const ofBareHeartbeat = await requestOf(await createAgentRun(pool, { triggeredBy: "heartbeat", task: "tick" }));
      const ofUserRoot = await requestOf(userRoot);
      const belowUserRoot = await requestOf(await delegateBelow(userRoot, 1));
      const ofSupervisorRoot = await requestOf(
        await createAgentRun(pool, { triggeredBy: "supervisor", task: "sweep" }),
      );

      const chatIds = [ofChat, ofChatDelegated, ofItem, beyondHopLimit, ofUserRoot, belowUserRoot, ofSupervisorRoot];
      const tickIds = [ofTick, ofTickFromChat, ofHeartbeatRoot, belowHeartbeatRoot, ofBareHeartbeat];
      const mcpIds = [ofMcp, ofMcpDelegated, ofMcpAtHopLimit];
      const idsOf = (requests: Array<{ id: string }>) => requests.map((request) => request.id).sort();
      const filtered = async (sourceKinds: ApprovalRequestSourceKind[]) =>
        (await page({ sourceKinds, order: "asc" })).rows;

      const ofKindChat = await filtered(["chat"]);
      expect(ofKindChat.map((row) => row.id).sort()).toEqual(idsOf(chatIds));
      expect(ofKindChat.map((row) => row.source.kind)).toEqual(chatIds.map(() => "chat"));
      expect((await filtered(["tick"])).map((row) => row.id).sort()).toEqual(idsOf(tickIds));
      expect((await filtered(["mcp"])).map((row) => row.id).sort()).toEqual(idsOf(mcpIds));
      expect((await filtered(["mcp", "tick"])).map((row) => row.id).sort()).toEqual(idsOf([...mcpIds, ...tickIds]));

      // The kind the query filters by is the kind each row shows.
      const all = (await page({ order: "asc" })).rows;
      expect(all).toHaveLength(chatIds.length + tickIds.length + mcpIds.length);
      for (const kind of ["chat", "tick", "mcp"] as const) {
        expect((await filtered([kind])).map((row) => row.id)).toEqual(
          all.filter((row) => row.source.kind === kind).map((row) => row.id),
        );
      }
    });

    it("counts the pending requests the list returns for every combination of source kinds (issue #1786)", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const chat = await chatThread("Trip to Brno");
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "chat",
        threadId: chat,
      });
      const item = await itemThread({ text: "Buy milk" });
      const tick = await tickThread("Sunday planning");
      const tickRun = {
        triggeredBy: "heartbeat" as const,
        task: "tick",
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        threadId: tick.threadId,
      };
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
      const heartbeatRoot = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "tick",
        heartbeatId: (await tickThread("Legacy tick")).heartbeatId,
      });
      const atHopLimit = await delegateBelow(mcpRoot, AGENT_RUN_ROOT_MAX_HOPS);
      await requestOf(chatRun);
      await requestOf(await delegateBelow(chatRun, 1));
      await requestOf(await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: item.threadId }));
      await requestOf(await createAgentRun(pool, tickRun));
      await requestOf(await createAgentRun(pool, { ...tickRun, parentRunId: chatRun.id }));
      await requestOf(mcpRoot);
      await requestOf(await delegateBelow(mcpRoot, 2));
      await requestOf(atHopLimit);
      // Beyond the hop limit the root run is not reached, so the request is a chat request.
      await requestOf(await delegateBelow(atHopLimit, 1));
      await requestOf(heartbeatRoot);
      await requestOf(await delegateBelow(heartbeatRoot, 1));
      await requestOf(await userRun());
      // A decided request is in neither the list nor the count.
      await decideApprovalRequest(pool, (await requestOf(await userRun())).id, "approved", ownerId);

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
      expect(await count(null)).toBe(12);
      expect([await count(["chat"]), await count(["tick"]), await count(["mcp"])]).toEqual([5, 4, 3]);
    });

    it("searches thread titles, heartbeat names, tool names and description values without regard to case or diacritics", async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const inChat = await requestOf(
        await createAgentRun(pool, {
          triggeredBy: "user",
          task: "chat",
          threadId: await chatThread("Dovolená v Brně"),
        }),
        { toolName: "tool_a" },
      );
      const item = await itemThread({ text: "Koupit mléko" });
      const inItem = await requestOf(
        await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: item.threadId }),
        { toolName: "tool_b" },
      );
      const tick = await tickThread("Týdenní plánování");
      const inTick = await requestOf(
        await createAgentRun(pool, {
          triggeredBy: "heartbeat",
          task: "tick",
          projectItemId: tick.projectItemId,
          heartbeatId: tick.heartbeatId,
          threadId: tick.threadId,
        }),
        { toolName: "tool_c" },
      );
      const heartbeatRoot = await createAgentRun(pool, {
        triggeredBy: "heartbeat",
        task: "tick",
        heartbeatId: (await tickThread("Noční úklid")).heartbeatId,
      });
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

      expect(await search("dovolena")).toEqual([inChat.id]);
      expect(await search("BRNE")).toEqual([inChat.id]);
      expect(await search("mleko")).toEqual([inItem.id]);
      expect(await search("tydenni planovani")).toEqual([inTick.id]);
      expect(await search("nocni")).toEqual([belowHeartbeat.id]);
      expect(await search("other")).toEqual([untitledChatBelowHeartbeat.id]);
      expect(await search("odeslat_zpravu")).toEqual([byTool.id]);
      expect(await search("nalada")).toEqual([byDescription.id]);
      expect(await search("Deník")).toEqual([byDescription.id]);
      // An underscore in the text matches an underscore only, not any character: `toolbox` stays out.
      expect(await search("tool_")).toEqual([inChat.id, inItem.id, inTick.id, belowHeartbeat.id]);
      expect(await search("tool")).toHaveLength(5);
      expect(await search("odeslat zpravu")).toEqual([]);

      // Not searched: argument values of the payload, and the key and the parameter names of the description.
      expect(await search("a@b.com")).toEqual([]);
      expect(await search("propertyDelete")).toEqual([]);
      expect(await search("propertyName")).toEqual([]);

      // A text that folding leaves empty is no filter.
      expect(await search("\u0301")).toHaveLength(8);

      // An Inbox item in the trash gives its thread no text to match.
      expect(
        await inTenantZero(() => chokePoint.softDeleteItem(item.inboxDatabaseId, item.inboxItemId)),
      ).not.toBeNull();
      expect(await search("mleko")).toEqual([]);
    });

    it("treats a percent sign and a backslash in the search text as themselves", async () => {
      const description = (itemName: string): ApprovalDescription => ({
        key: "approval.itemDelete",
        params: { itemName, databaseKey: "tasks" },
      });
      const withPercent = await requestOf(await userRun(), { description: description("100% bavlna") });
      await requestOf(await userRun(), { description: description("1000 kusů") });
      const withBackslash = await requestOf(await userRun(), { description: description("C:\\temp") });
      await requestOf(await userRun(), { description: description("C:temp") });

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
      const first = await page({ limit: 2 });
      expect(first.nextCursor).toEqual(expect.any(String));
      // A page that holds the last rows exactly has no cursor.
      expect((await page({ limit: 5 })).nextCursor).toBeNull();
      expect(await drain({ limit: 5 })).toHaveLength(1);
    });

    it("pages through the decided list by decision time", async () => {
      const run = await userRun();
      const first = await requestOf(run);
      const second = await requestOf(run);
      const third = await requestOf(run);
      // Decided in an order that is neither the order in which the requests were made nor its reverse,
      // so the pages below follow the decisions and no order by request time.
      for (const request of [second, third, first]) {
        await decideApprovalRequest(pool, request.id, "rejected", ownerId);
      }
      await requestOf(run);

      const pages = await drain({ status: "decided", limit: 2 });
      expect(pages).toEqual([[first.id, third.id], [second.id]]);
    });

    it("fills a page with matching requests when other requests lie between them", async () => {
      const mcpRoot = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
      const userRoot = await userRun();
      const ofMcp = [];
      for (let index = 0; index < 3; index += 1) {
        ofMcp.push((await requestOf(mcpRoot)).id);
        await requestOf(userRoot);
      }

      const pages = await drain({ sourceKinds: ["mcp"], order: "asc", limit: 2 });
      expect(pages).toEqual([[ofMcp[0], ofMcp[1]], [ofMcp[2]]]);
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
      // Another account's run lives in that account's own tenant: a run's actor must be its own
      // tenant's user (agent_runs_actor_user_id_tenant_fkey, issue #1066). This pool bypasses row-level
      // security, so only the owner condition of the query keeps these rows out.
      const foreignTenant = await createTestTenant(pool);
      const foreignUser = await createRawUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: foreignTenant,
      });
      await withTenantTransaction(pool, foreignTenant, async (client) => {
        const foreignRun = await createAgentRun(client, { triggeredBy: "user", task: "other", userId: foreignUser.id });
        for (const decision of [null, "approved"] as const) {
          const request = await createPendingApprovalRequest(client, {
            agentRunId: foreignRun.id,
            toolName: "send_email",
            riskClass: "outbound",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          });
          if (decision) await decideApprovalRequest(client, request.id, decision, foreignUser.id);
        }
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

  describe("attachLiveStepApprovals (issue #1887)", () => {
    /** A pending request on a run of `ownerUserId`; its arguments and the later result hold values that must never leak. */
    async function pendingRequestOf(ownerUserId: string, client: Queryable = pool) {
      const run = await createAgentRun(client, { triggeredBy: "user", task: "test", userId: ownerUserId });
      return createPendingApprovalRequest(client, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: {
          mcpToolRegistrationId: randomUUID(),
          mcpServerItemId: randomUUID(),
          args: { to: "argument-value@example.com" },
        },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
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
      const steps = requestIds.map(waitingStep);
      const [message] = await attachLiveStepApprovals(pool, [{ id: randomUUID(), steps }], userId);
      return { steps, attached: message?.steps ?? [] };
    }

    it("returns approved and succeeded for a request that was approved and executed", async () => {
      const request = await pendingRequestOf(ownerId);
      await decideApprovalRequest(pool, request.id, "approved", ownerId);
      await claimApprovalRequestExecution(pool, request.id);
      await markApprovalRequestExecutionSucceeded(pool, request.id, { sentTo: "result-value@example.com" });

      const { attached } = await approvalsOf([request.id]);

      expect(attached[0]?.approval).toEqual({ status: "approved", executionStatus: "succeeded", conflictReason: null });
    });

    it("returns not_approved while the request is pending and rejected after the rejection", async () => {
      const request = await pendingRequestOf(ownerId);

      expect((await approvalsOf([request.id])).attached[0]?.approval).toEqual({
        status: "pending",
        executionStatus: "not_approved",
        conflictReason: null,
      });

      await decideApprovalRequest(pool, request.id, "rejected", ownerId);

      expect((await approvalsOf([request.id])).attached[0]?.approval).toEqual({
        status: "rejected",
        executionStatus: "not_approved",
        conflictReason: null,
      });
    });

    it("returns queued for an approved request that has not been executed yet", async () => {
      const request = await pendingRequestOf(ownerId);
      await decideApprovalRequest(pool, request.id, "approved", ownerId);

      expect((await approvalsOf([request.id])).attached[0]?.approval).toEqual({
        status: "approved",
        executionStatus: "queued",
        conflictReason: null,
      });
    });

    it("returns the conflictReason key of a conflicted request and none of its details", async () => {
      const request = await pendingRequestOf(ownerId);
      await decideApprovalRequest(pool, request.id, "approved", ownerId);
      await withTransaction(pool, (client) =>
        terminalizeApprovalRequestAsConflict(client, request.id, { currentResource: { name: "resource-value" } }),
      );

      const { attached } = await approvalsOf([request.id]);

      expect(attached[0]?.approval).toEqual({
        status: "approved",
        executionStatus: "conflict",
        conflictReason: { key: "approval.conflict.changed" },
      });
      expect(JSON.stringify(attached)).not.toContain("resource-value");
    });

    it("reads the requests of a page with one approval request lookup, not one per step", async () => {
      const requests = await Promise.all([1, 2, 3, 4, 5].map(() => pendingRequestOf(ownerId)));
      const messages = [
        { id: randomUUID(), steps: requests.slice(0, 3).map((request) => waitingStep(request.id)) },
        { id: randomUUID(), steps: requests.slice(3).map((request) => waitingStep(request.id)) },
      ];

      await withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          const attached = await attachLiveStepApprovals(client, messages, ownerId);

          expect(attached.flatMap((message) => message.steps ?? []).map((step) => step.approval?.status)).toEqual([
            "pending",
            "pending",
            "pending",
            "pending",
            "pending",
          ]);
          const statements = query.mock.calls
            .map(([sql]) => sql)
            .filter((sql): sql is string => typeof sql === "string");
          expect(statements).toHaveLength(1);
          expect(statements[0]).toContain("FROM approval_requests");
        } finally {
          query.mockRestore();
        }
      });
    });

    it("does not query at all for a page whose steps hold no approval request", async () => {
      await withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          await attachLiveStepApprovals(
            client,
            [{ id: randomUUID(), steps: [waitingStep(undefined)] }, { id: randomUUID() }],
            ownerId,
          );

          expect(query).not.toHaveBeenCalled();
        } finally {
          query.mockRestore();
        }
      });
    });

    it("gives a missing request and a request of another user the same null, and still reads the caller's own", async () => {
      // The other user lives in a tenant of its own (one user per tenant). This pool bypasses row-level
      // security, so only the owner condition of the query keeps the foreign request out.
      const foreignTenant = await createTestTenant(pool);
      const otherUserId = (
        await createRawUser(pool, {
          email: `${randomUUID()}@example.com`,
          passwordHash: "unused",
          tenantId: foreignTenant,
        })
      ).id;
      const own = await pendingRequestOf(ownerId);
      const foreign = await withTenantTransaction(pool, foreignTenant, (client) =>
        pendingRequestOf(otherUserId, client),
      );

      const { attached } = await approvalsOf([own.id, foreign.id, randomUUID()]);

      expect(attached[0]?.approval).toMatchObject({ status: "pending" });
      expect(attached[1]).toHaveProperty("approval", null);
      expect(attached[2]).toHaveProperty("approval", null);
      expect(attached[1]?.approval).toEqual(attached[2]?.approval);
      // The same request is readable for its owner, so the null above comes from the owner condition.
      expect((await approvalsOf([foreign.id], otherUserId)).attached[0]?.approval).toMatchObject({ status: "pending" });
    });

    it("returns only the three fields and neither the payload, the arguments nor the execution result", async () => {
      const request = await pendingRequestOf(ownerId);
      await decideApprovalRequest(pool, request.id, "approved", ownerId);
      await claimApprovalRequestExecution(pool, request.id);
      await markApprovalRequestExecutionSucceeded(pool, request.id, { sentTo: "result-value@example.com" });

      const { attached } = await approvalsOf([request.id]);

      expect(Object.keys(attached[0]?.approval ?? {}).sort()).toEqual(["conflictReason", "executionStatus", "status"]);
      const json = JSON.stringify(attached);
      expect(json).not.toContain("argument-value");
      expect(json).not.toContain("result-value");
      expect(json).not.toContain("payload");
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
