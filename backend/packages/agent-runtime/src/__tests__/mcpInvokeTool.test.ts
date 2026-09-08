import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "@semprec/data/testSupport/mcpContractServers";
import {
  withTransaction,
  createItemWithClient,
  upsertMcpToolRegistration,
  setProjectMcpGrantForAgentPage,
  seedSystem,
  createViewTypeRegistry,
  createAgentRun,
  getApprovalRequest,
  type McpConnectionConfig,
  type ViewTypeRegistry,
} from "@semprec/data";
import { createApprovalGatedMcpInvokeTool, createMcpInvokeTool, resolveMcpInvocation } from "../mcpInvokeTool.js";

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

async function createGrantedTool(connectionConfig: McpConnectionConfig, tool: ContractServerTool = SEARCH_TOOL) {
  const server = await withTransaction(pool, (client) =>
    createItemWithClient(client, {
      databaseId: mcpServersId,
      properties: { name: "Contract server", active: true, connectionConfig },
    }),
  );
  const registration = await upsertMcpToolRegistration(pool, {
    mcpServerItemId: server.id,
    toolName: tool.name,
    toolSchema: tool.inputSchema,
    description: tool.description ?? null,
  });
  const projectItemId = randomUUID();
  await withTransaction(pool, (client) =>
    setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: true }),
  );
  return { server, registration, projectItemId };
}

describe("MCP invoke adapter (issue #128)", () => {
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

  describe.each([
    ["stdio", () => startStdioContractServer([SEARCH_TOOL])],
    ["sse", () => startSseContractServer([SEARCH_TOOL])],
    ["http", () => startHttpContractServer([SEARCH_TOOL])],
  ] as const)("%s transport", (_label, startServer) => {
    it("invokes the tool and returns its result", async () => {
      const contractServer = await startServer();
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const result = await invoke({ query: "semprec" });

      expect(result).toEqual({
        error: false,
        result: JSON.stringify({ name: "search_web", arguments: { query: "semprec" } }),
      });
      expect(contractServer.getLastToolCall()).toEqual({ name: "search_web", arguments: { query: "semprec" } });
    });

    it("maps the server's isError result to an error result", async () => {
      const contractServer = await startServer();
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", __forceError: true });

      expect(result).toEqual({ error: true, result: "contract-server-forced-error" });
    });
  });

  it("rejects an unknown registration id before touching any transport", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { projectItemId } = await createGrantedTool(contractServer.connectionConfig);

    const invoke = createMcpInvokeTool(pool, projectItemId, randomUUID());
    const result = await invoke({ query: "semprec" });

    expect(result.error).toBe(true);
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("rejects a revoked grant before touching any transport", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
    await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: false }),
    );

    const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
    const result = await invoke({ query: "semprec" });

    expect(result.error).toBe(true);
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("does not let a spoofed project id reach another project's grant", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration } = await createGrantedTool(contractServer.connectionConfig);
    const spoofedProjectItemId = randomUUID();

    const invoke = createMcpInvokeTool(pool, spoofedProjectItemId, registration.id);
    const result = await invoke({ query: "semprec" });

    expect(result.error).toBe(true);
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("rejects arguments that don't match the tool's schema before touching any transport", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

    const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
    const result = await invoke({});

    expect(result.error).toBe(true);
    expect(result.result).toContain("search_web");
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("resolveMcpInvocation carries approval metadata forward without executing the call", async () => {
    const contractServer = await startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

    const resolution = await resolveMcpInvocation(pool, projectItemId, registration.id, { query: "semprec" });

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.target.requiresApproval).toBe(true);
      expect(resolution.target.riskClass).toBe("unclassified");
    }
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  describe("createApprovalGatedMcpInvokeTool (issue #130)", () => {
    it("defers a tool that requires approval: no transport call, a pending request, a synthetic success result", async () => {
      const contractServer = await startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { server, registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec" });

      expect(result.error).toBe(false);
      expect(contractServer.getHandshakeCount()).toBe(0);

      const requestIdMatch = result.result.match(/Approval request ([0-9a-f-]{36})/i);
      expect(requestIdMatch).not.toBeNull();
      const request = await getApprovalRequest(pool, requestIdMatch![1]);
      expect(request).not.toBeNull();
      expect(request!.status).toBe("pending");
      expect(request!.agentRunId).toBe(run.id);
      expect(request!.toolName).toBe("search_web");
      expect(request!.riskClass).toBe("unclassified");
      expect(request!.payload).toEqual({
        mcpToolRegistrationId: registration.id,
        mcpServerItemId: server.id,
        args: { query: "semprec" },
      });
    });

    it("continues straight through to execution when the tool does not require approval", async () => {
      const contractServer = await startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      await pool.query(`UPDATE mcp_tool_registrations SET requires_approval = false WHERE id = $1`, [registration.id]);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec" });

      expect(result).toEqual({
        error: false,
        result: JSON.stringify({ name: "search_web", arguments: { query: "semprec" } }),
      });
      expect(contractServer.getLastToolCall()).toEqual({ name: "search_web", arguments: { query: "semprec" } });
    });

    it("rejects an invalid call before creating any approval request", async () => {
      const contractServer = await startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({});

      expect(result.error).toBe(true);
      expect(contractServer.getHandshakeCount()).toBe(0);
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });
  });
});
