import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import {
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import {
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createUser as createAuthUser } from "../auth/usersStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrantForAgentPage } from "../mcp/mcpAgentPageGrants.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  claimApprovalRequestExecution,
  createPendingApprovalRequest,
  getApprovalRequest,
  recordApprovalRequestOutcome,
} from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { approvalConflictReason } from "../mcp/approvalConflictReason.js";
import { handleApprovalRequestExecuteTask } from "../mcp/approvalRequestExecution.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";

const SEARCH_TOOL: ContractServerTool = {
  name: "search_web",
  description: "Searches the web",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

let pool: Pool;
let mcpServersId: string;
let servers: McpContractServer[] = [];
let soleTenantAdminId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function createSoleTenantAdmin(): Promise<string> {
  const tenantId = getTenantZeroId();
  const user = await createAuthUser(pool, {
    email: "admin@example.test",
    passwordHash: "unused",
    tenantId,
    role: "admin",
  });
  return user.id;
}

async function createGrantedTool(contractServer: McpContractServer) {
  // The contract server is a stdio config, which only a human admin of the sole tenant may store.
  const adminId = soleTenantAdminId;
  const server = await withTransaction(pool, (client) =>
    createItemWithClient(
      client,
      {
        databaseId: mcpServersId,
        properties: { name: "Contract server", active: true, connectionConfig: contractServer.connectionConfig },
      },
      { humanWriterUserId: adminId },
    ),
  );
  const registration = await upsertMcpToolRegistration(pool, {
    mcpServerItemId: server.id,
    toolName: SEARCH_TOOL.name,
    toolSchema: SEARCH_TOOL.inputSchema,
    description: SEARCH_TOOL.description ?? null,
  });
  const projectItemId = randomUUID();
  await withTransaction(pool, (client) =>
    setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: true }),
  );
  return { server, registration, projectItemId };
}

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
}

describe("approval request decide+execute (issue #131)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    soleTenantAdminId = await createSoleTenantAdmin();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await seedSystem(pool, viewTypeRegistry);
    mcpServersId = await databaseIdFor("mcpServers");
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("executes the deferred call once a pending request is approved, recording the outcome", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration, projectItemId } = await createGrantedTool(contractServer);
    // No production chat-thread creator exists on this tip.
    const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const run = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "test",
      projectItemId,
      threadId: thread.rows[0]!.id,
    });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    const decided = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );
    expect(decided!.request.status).toBe("approved");
    expect(contractServer.getHandshakeCount()).toBe(0);

    await drainQueue();

    expect(contractServer.getLastToolCall()).toEqual({
      name: "search_web",
      arguments: { query: "semprec" },
      meta: { idempotencyKey: request.id },
    });
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executedAt).not.toBeNull();
    expect(finished!.executionError).toBe(false);
    expect(finished!.executionResult).toBe(JSON.stringify({ name: "search_web", arguments: { query: "semprec" } }));
    const messages = await pool.query<{ system_key: string; context: unknown }>(
      "SELECT system_key, context FROM semp_messages WHERE thread_id = $1",
      [thread.rows[0]!.id],
    );
    expect(messages.rows).toEqual([
      {
        system_key: "approval.outcome.executed",
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
    await inTenantZero(() =>
      enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: request.id }),
    );
    await drainQueue();
    expect(
      (
        await pool.query<{ system_key: string; context: unknown }>(
          "SELECT system_key, context FROM semp_messages WHERE thread_id = $1",
          [thread.rows[0]!.id],
        )
      ).rows,
    ).toEqual(messages.rows);
  });

  it("never executes a rejected request", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: userId,
        }),
      ),
    );
    await drainQueue();

    expect(contractServer.getHandshakeCount()).toBe(0);
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.status).toBe("rejected");
    expect(finished!.executedAt).toBeNull();
  });

  it("a retried decision does not create a second decision or a second execution", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration, projectItemId } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", projectItemId });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;
    const otherUser = await createUser();

    const first = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );
    expect(first!.outcome).toBe("decided");
    const retry = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: userId,
        }),
      ),
    );
    expect(retry!.outcome).toBe("unchanged");
    expect(retry!.request.status).toBe("approved");
    expect(retry!.request.decidedBy).toBe(userId);
    const { rows: jobs } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
        FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'approvalExecute' AND j.payload->'payload'->>'approvalRequestId' = $1`,
      [request.id],
    );
    expect(jobs[0]!.count).toBe(1);

    const foreignRetry = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: otherUser,
        }),
      ),
    );
    expect(foreignRetry).toBeNull();

    await drainQueue();

    expect(contractServer.getHandshakeCount()).toBe(1);
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.status).toBe("approved");
    expect(finished!.decidedBy).toBe(userId);
  });

  it("settles a stale claim (older than 10 minutes) as conflict without calling the tool", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    // No production chat-thread creator exists on this tip.
    const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", threadId: thread.rows[0]!.id });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );
    // Simulate an earlier delivery that claimed the request and then died before recording an
    // outcome, then age the claim past the 10-minute staleness threshold.
    await withTransaction(pool, (client) => claimApprovalRequestExecution(client, request.id));
    await pool.query(`UPDATE approval_requests SET executed_at = now() - interval '11 minutes' WHERE id = $1`, [
      request.id,
    ]);

    await drainQueue();

    expect(contractServer.getLastToolCall()).toBeNull();
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("conflict");
    expect(finished!.executionError).toBe(true);
    expect(finished!.executionResult).toEqual({
      text: "The deferred MCP tool call was claimed by an earlier delivery that never recorded its outcome; the tool may or may not have run.",
      outcomeKind: "staleClaim",
    });
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toEqual({
      key: "approval.conflict.other",
    });
    const messages = await pool.query<{ system_key: string; context: unknown }>(
      "SELECT system_key, context FROM semp_messages WHERE thread_id = $1",
      [thread.rows[0]!.id],
    );
    expect(messages.rows).toEqual([
      {
        system_key: "approval.outcome.conflict",
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
  });

  it("does not post a discarded MCP outcome after a concurrent stale settlement", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration, projectItemId } = await createGrantedTool(contractServer);
    // No production chat-thread creator exists on this tip.
    const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const run = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "test",
      projectItemId,
      threadId: thread.rows[0]!.id,
    });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: run.actorUserId,
        }),
      ),
    );
    let reached!: () => void;
    let release!: () => void;
    const atOutcome = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    const observed = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client: PoolClient = await target.connect();
          return new Proxy(client, {
            get(clientTarget, key, clientReceiver) {
              if (key !== "query") {
                const value: unknown = Reflect.get(clientTarget, key, clientReceiver);
                return typeof value === "function" ? value.bind(clientTarget) : value;
              }
              return async (...args: unknown[]) => {
                if (
                  !paused &&
                  typeof args[0] === "string" &&
                  args[0].includes("SET execution_error = $2, execution_result_jsonb")
                ) {
                  paused = true;
                  reached();
                  await gate;
                }
                return Reflect.apply(clientTarget.query.bind(clientTarget), clientTarget, args);
              };
            },
          });
        };
      },
    });
    const first = inTenantZero(() => handleApprovalRequestExecuteTask(observed, { approvalRequestId: request.id }));
    try {
      await atOutcome;
      expect(contractServer.getLastToolCall()?.name).toBe(SEARCH_TOOL.name);
      // Age only the claimed fixture so a second real handler can settle the unknown outcome.
      const aged = await pool.query(
        "UPDATE approval_requests SET executed_at = now() - interval '11 minutes' WHERE id = $1 AND status = 'approved' AND execution_status = 'queued' AND executed_at IS NOT NULL",
        [request.id],
      );
      expect(aged.rowCount).toBe(1);
      await inTenantZero(() => handleApprovalRequestExecuteTask(pool, { approvalRequestId: request.id }));
    } finally {
      release();
      await first;
    }
    await contractServer.waitForChildExit();
    expect((await getApprovalRequest(pool, request.id))?.executionStatus).toBe("conflict");
    const messages = await pool.query<{ system_key: string; context: unknown }>(
      "SELECT system_key, context FROM semp_messages WHERE thread_id = $1",
      [thread.rows[0]!.id],
    );
    expect(messages.rows).toEqual([
      {
        system_key: "approval.outcome.conflict",
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
  });

  it("fails retriably without calling the tool when a claim is less than 10 minutes old", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );
    const claimed = await withTransaction(pool, (client) => claimApprovalRequestExecution(client, request.id));

    await drainQueue();

    expect(contractServer.getLastToolCall()).toBeNull();
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("queued");
    expect(finished!.executedAt).toEqual(claimed!.executedAt);
    expect(finished!.executionResult).toBeNull();
  });

  it("recordApprovalRequestOutcome never overwrites a row that is no longer queued", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );
    await withTransaction(pool, (client) => claimApprovalRequestExecution(client, request.id));
    await withTransaction(pool, (client) =>
      recordApprovalRequestOutcome(client, request.id, { error: true, result: "conflict-outcome" }),
    );
    const settled = await getApprovalRequest(pool, request.id);
    expect(settled!.executionStatus).toBe("conflict");

    const wroteAgain = await withTransaction(pool, (client) =>
      recordApprovalRequestOutcome(client, request.id, { error: false, result: "should-not-write" }),
    );
    expect(wroteAgain).toBe(false);
    const unchanged = await getApprovalRequest(pool, request.id);
    expect(unchanged!.executionResult).toBe(settled!.executionResult);
    expect(unchanged!.executionStatus).toBe("conflict");
  });

  const NO_LONGER_AVAILABLE_MESSAGE =
    "This MCP tool is no longer available to the requesting project: its grant was revoked, or its registration or server is inactive.";

  async function approveAndSetUp(args: Record<string, unknown> = { query: "semprec" }) {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration, projectItemId } = await createGrantedTool(contractServer);
    // No production chat-thread creator exists on this tip.
    const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const run = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "test",
      projectItemId,
      threadId: thread.rows[0]!.id,
    });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const userId = run.actorUserId;

    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      ),
    );

    return { contractServer, server, registration, projectItemId, request, threadId: thread.rows[0]!.id };
  }

  it("records a conflict and calls no tool when the project's grant was revoked after approval", async () => {
    const { contractServer, server, registration, projectItemId, request } = await approveAndSetUp();

    await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, {
        projectItemId,
        mcpToolRegistrationId: registration.id,
        granted: false,
      }),
    );

    await drainQueue();

    expect(contractServer.getLastToolCall()).toBeNull();
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("conflict");
    expect(finished!.executionError).toBe(true);
    expect(finished!.executionResult).toEqual({
      text: NO_LONGER_AVAILABLE_MESSAGE,
      outcomeKind: "toolUnavailable",
      failure: { failureKind: "unavailable", mcpServerItemId: server.id },
    });
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toEqual({
      key: "approval.conflict.toolUnavailable",
    });
    await inTenantZero(() =>
      enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: request.id }),
    );
    await drainQueue();
    expect(contractServer.getHandshakeCount()).toBe(0);
    expect((await getApprovalRequest(pool, request.id))?.executionResult).toEqual(finished!.executionResult);
  });

  it("records a conflict and calls no tool when the tool registration was deactivated after approval", async () => {
    const { contractServer, server, registration, request } = await approveAndSetUp();

    await pool.query(`UPDATE mcp_tool_registrations SET active = false WHERE id = $1`, [registration.id]);

    await drainQueue();

    expect(contractServer.getLastToolCall()).toBeNull();
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("conflict");
    expect(finished!.executionError).toBe(true);
    expect(finished!.executionResult).toEqual({
      text: NO_LONGER_AVAILABLE_MESSAGE,
      outcomeKind: "toolUnavailable",
      failure: { failureKind: "unavailable", mcpServerItemId: server.id },
    });
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toEqual({
      key: "approval.conflict.toolUnavailable",
    });
  });

  it("records a conflict and calls no tool when the server item was set inactive after approval", async () => {
    const { contractServer, server, request } = await approveAndSetUp();

    await pool.query(`UPDATE items SET properties = jsonb_set(properties, '{active}', 'false') WHERE id = $1`, [
      server.id,
    ]);

    await drainQueue();

    expect(contractServer.getLastToolCall()).toBeNull();
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("conflict");
    expect(finished!.executionError).toBe(true);
    expect(finished!.executionResult).toEqual({
      text: NO_LONGER_AVAILABLE_MESSAGE,
      outcomeKind: "toolUnavailable",
      failure: { failureKind: "unavailable", mcpServerItemId: server.id },
    });
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toEqual({
      key: "approval.conflict.toolUnavailable",
    });
  });

  it("executes normally when grant, registration and server are unchanged at execution time", async () => {
    const { contractServer, request } = await approveAndSetUp();

    await drainQueue();

    expect(contractServer.getLastToolCall()).toEqual({
      name: "search_web",
      arguments: { query: "semprec" },
      meta: { idempotencyKey: request.id },
    });
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("succeeded");
    expect(finished!.executionError).toBe(false);
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toBeNull();
  });

  it("records a callFailed outcome kind when the tool call itself errors", async () => {
    const { request, server, threadId } = await approveAndSetUp({ query: "semprec", __forceError: true });

    await drainQueue();

    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executionStatus).toBe("conflict");
    expect(finished!.executionResult).toMatchObject({
      outcomeKind: "callFailed",
      failure: { failureKind: "toolError", mcpServerItemId: server.id },
    });
    expect(approvalConflictReason(finished!.executionStatus, finished!.executionResult)).toEqual({
      key: "approval.outcome.failed",
    });
    const messages = await pool.query<{ system_key: string; context: unknown }>(
      "SELECT system_key, context FROM semp_messages WHERE thread_id = $1",
      [threadId],
    );
    expect(messages.rows).toEqual([
      {
        system_key: "approval.outcome.conflict",
        context: [{ kind: "approvalRequest", approvalRequestId: request.id }],
      },
    ]);
  });
});
