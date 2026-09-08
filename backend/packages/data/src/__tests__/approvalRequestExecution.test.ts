import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient } from "../chokePoint/chokePoint.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrantForAgentPage } from "../mcp/mcpAgentPageGrants.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest, getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
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

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}

async function createGrantedTool(contractServer: McpContractServer) {
  const server = await withTransaction(pool, (client) =>
    createItemWithClient(client, {
      databaseId: mcpServersId,
      properties: { name: "Contract server", active: true, connectionConfig: contractServer.connectionConfig },
    }),
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
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
    });
    const userId = await createUser();

    const decided = await withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: request.id,
        decision: "approved",
        decidedByUserId: userId,
      }),
    );
    expect(decided!.status).toBe("approved");
    expect(contractServer.getHandshakeCount()).toBe(0);

    await drainQueue();

    expect(contractServer.getLastToolCall()).toEqual({ name: "search_web", arguments: { query: "semprec" } });
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.executedAt).not.toBeNull();
    expect(finished!.executionError).toBe(false);
    expect(finished!.executionResult).toBe(JSON.stringify({ name: "search_web", arguments: { query: "semprec" } }));
  });

  it("never executes a rejected request", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
    });
    const userId = await createUser();

    await withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: request.id,
        decision: "rejected",
        decidedByUserId: userId,
      }),
    );
    await drainQueue();

    expect(contractServer.getHandshakeCount()).toBe(0);
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.status).toBe("rejected");
    expect(finished!.executedAt).toBeNull();
  });

  it("a retried decision does not create a second decision or a second execution", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { server, registration } = await createGrantedTool(contractServer);
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: SEARCH_TOOL.name,
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { query: "semprec" } },
    });
    const userId = await createUser();
    const otherUser = await createUser();

    await withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: request.id,
        decision: "approved",
        decidedByUserId: userId,
      }),
    );
    const retry = await withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: request.id,
        decision: "rejected",
        decidedByUserId: otherUser,
      }),
    );
    expect(retry).toBeNull();

    await drainQueue();

    expect(contractServer.getHandshakeCount()).toBe(1);
    const finished = await getApprovalRequest(pool, request.id);
    expect(finished!.status).toBe("approved");
    expect(finished!.decidedBy).toBe(userId);
  });
});
