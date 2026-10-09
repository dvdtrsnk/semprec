import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Ajv } from "ajv";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "@semprec/data/testSupport/mcpContractServers";
import {
  withTransaction,
  upsertMcpToolRegistration,
  setProjectMcpGrantForAgentPage,
  seedSystem,
  createViewTypeRegistry,
  createAgentRun,
  getApprovalRequest,
  createUser,
  hashPassword,
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
let earliestUser: { id: string };

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createGrantedTool(connectionConfig: McpConnectionConfig, tool: ContractServerTool = SEARCH_TOOL) {
  // A raw insert: the live contract servers are `http://127.0.0.1`, which the choke point's MCP
  // connectionConfig hook refuses, and this package cannot import `itemsStore`.
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb) RETURNING id",
    [randomUUID(), mcpServersId, JSON.stringify({ name: "Contract server", active: true, connectionConfig })],
  );
  const server = { id: rows[0]!.id };
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
    const passwordHash = await hashPassword("s3cret-password");
    earliestUser = await createUser(pool, {
      email: `${randomUUID()}@example.test`,
      passwordHash,
      locale: "en",
      tenantId: getTenantZeroId(),
    });
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
      expect(contractServer.getLastToolCall()).toEqual({
        name: "search_web",
        arguments: { query: "semprec" },
        meta: null,
      });
    });

    it("maps the server's isError result to an error result", async () => {
      const contractServer = await startServer();
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", __forceError: true });

      expect(result).toEqual({ error: true, result: "contract-server-forced-error" });
    });

    it("returns a cancelled error result without calling the tool when its signal is aborted", async () => {
      const contractServer = await startServer();
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const result = await invoke({ query: "semprec" }, AbortSignal.abort());

      expect(result).toEqual({ error: true, result: "MCP tool call was cancelled before it completed" });
      expect(contractServer.getLastToolCall()).toBeNull();
    });
  });

  it("rejects an unknown registration id before touching any transport", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { projectItemId } = await createGrantedTool(contractServer.connectionConfig);

    const invoke = createMcpInvokeTool(pool, projectItemId, randomUUID());
    const result = await invoke({ query: "semprec" });

    expect(result.error).toBe(true);
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("rejects a revoked grant before touching any transport", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
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
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration } = await createGrantedTool(contractServer.connectionConfig);
    const spoofedProjectItemId = randomUUID();

    const invoke = createMcpInvokeTool(pool, spoofedProjectItemId, registration.id);
    const result = await invoke({ query: "semprec" });

    expect(result.error).toBe(true);
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("rejects arguments that don't match the tool's schema before touching any transport", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
    servers.push(contractServer);
    const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

    const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
    const result = await invoke({});

    expect(result.error).toBe(true);
    expect(result.result).toContain("search_web");
    expect(contractServer.getHandshakeCount()).toBe(0);
  });

  it("resolveMcpInvocation carries approval metadata forward without executing the call", async () => {
    const contractServer = startStdioContractServer([SEARCH_TOOL]);
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
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { server, registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec" });

      expect(result.error).toBe(false);
      expect(contractServer.getHandshakeCount()).toBe(0);

      const requestIdMatch = result.result.match(/Approval request ([0-9a-f-]{36})/i);
      expect(requestIdMatch).not.toBeNull();
      const request = await getApprovalRequest(pool, requestIdMatch![1]!);
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
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
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
      expect(contractServer.getLastToolCall()).toEqual({
        name: "search_web",
        arguments: { query: "semprec" },
        meta: null,
      });
    });

    it("writes an approval_pending notification alongside the request, one per created request, never deduped away (issue #149)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const user = earliestUser;

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const first = await invoke({ query: "semprec" });
      const firstRequestId = first.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!;

      const { rows: afterFirst } = await pool.query(
        `SELECT user_id, kind, title, source_table, source_id, transition_instance, link_href FROM notifications WHERE source_id = $1`,
        [firstRequestId],
      );
      expect(afterFirst).toMatchObject([
        {
          user_id: user.id,
          kind: "approval_pending",
          title: `"search_web" needs approval`,
          source_table: "approval_requests",
          transition_instance: firstRequestId,
          link_href: `?page=approvals&user=${user.id}`,
        },
      ]);

      // A second, independent call is a different request (a different transition) and gets its
      // own notification rather than being deduped against the first.
      const second = await invoke({ query: "semprec again" });
      const secondRequestId = second.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!;
      expect(secondRequestId).not.toBe(firstRequestId);

      const { rows: allNotifications } = await pool.query(
        `SELECT source_id FROM notifications WHERE kind = 'approval_pending'`,
      );
      expect(allNotifications.map((r: { source_id: string }) => r.source_id).sort()).toEqual(
        [firstRequestId, secondRequestId].sort(),
      );
    });

    it("notifies the user of the tenant the request is created in, with a link naming that user (issue #1018)", async () => {
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const tenantB = await createTestTenant(pool);
        const userB = await createUser(pool, {
          email: `${randomUUID()}@example.test`,
          passwordHash: "x",
          tenantId: tenantB,
        });
        const contractServer = startStdioContractServer([SEARCH_TOOL]);
        servers.push(contractServer);

        const requestId = await runInTenant(tenantB, async () => {
          await seedSystem(runtimePool, createViewTypeRegistry());
          const { rows: databases } = await runtimePool.query<{ id: string }>(
            "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
          );
          // A raw insert, for the same reason as `createGrantedTool`.
          const { rows } = await runtimePool.query<{ id: string }>(
            "INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb) RETURNING id",
            [
              randomUUID(),
              databases[0]!.id,
              JSON.stringify({
                name: "Contract server",
                active: true,
                connectionConfig: contractServer.connectionConfig,
              }),
            ],
          );
          const registration = await upsertMcpToolRegistration(runtimePool, {
            mcpServerItemId: rows[0]!.id,
            toolName: SEARCH_TOOL.name,
            toolSchema: SEARCH_TOOL.inputSchema,
            description: SEARCH_TOOL.description ?? null,
          });
          const projectItemId = randomUUID();
          await withTransaction(runtimePool, (client) =>
            setProjectMcpGrantForAgentPage(client, {
              projectItemId,
              mcpToolRegistrationId: registration.id,
              granted: true,
            }),
          );
          const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "test" });
          const result = await createApprovalGatedMcpInvokeTool(
            runtimePool,
            run.id,
            projectItemId,
            registration.id,
          )({ query: "semprec" });
          return result.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!;
        });

        const { rows } = await pool.query(
          `SELECT user_id, kind, link_href, tenant_id FROM notifications WHERE source_id = $1`,
          [requestId],
        );
        expect(rows).toEqual([
          {
            user_id: userB.id,
            kind: "approval_pending",
            link_href: `?page=approvals&user=${userB.id}`,
            tenant_id: tenantB,
          },
        ]);
        expect(rows[0].user_id).not.toBe(earliestUser.id);
      } finally {
        await runtimePool.end();
      }
    });

    it("rejects an invalid call before creating any approval request", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
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

  describe("schema compile caching (issue #696)", () => {
    it("compiles a registration's schema once across repeated invocations", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const compileSpy = vi.spyOn(Ajv.prototype, "compile");

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      await invoke({ query: "first" });
      await invoke({ query: "second" });

      expect(compileSpy).toHaveBeenCalledTimes(1);
      compileSpy.mockRestore();
    });

    it("recompiles after a re-sync changes the registration's schema, and validates against the new schema", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const first = await invoke({ query: "semprec" });
      expect(first.error).toBe(false);

      await upsertMcpToolRegistration(pool, {
        mcpServerItemId: registration.mcpServerItemId,
        toolName: registration.toolName,
        toolSchema: {
          type: "object",
          properties: { query: { type: "string" }, extra: { type: "string" } },
          required: ["query", "extra"],
        },
        description: registration.description,
      });
      const compileSpy = vi.spyOn(Ajv.prototype, "compile");

      const rejected = await invoke({ query: "semprec" });
      expect(rejected.error).toBe(true);

      const accepted = await invoke({ query: "semprec", extra: "value" });
      expect(accepted.error).toBe(false);

      expect(compileSpy).toHaveBeenCalledTimes(1);
      compileSpy.mockRestore();
    });

    it("validates correctly on both the first and second call when the schema carries an $id", async () => {
      const toolWithId: ContractServerTool = {
        name: "search_web",
        description: "Searches the web",
        inputSchema: {
          $id: "https://example.test/search-web-schema.json",
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        } as unknown as ContractServerTool["inputSchema"],
      };
      const contractServer = startStdioContractServer([toolWithId]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig, toolWithId);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const first = await invoke({ query: "first" });
      const second = await invoke({ query: "second" });

      expect(first.error).toBe(false);
      expect(second.error).toBe(false);
    });
  });
});
