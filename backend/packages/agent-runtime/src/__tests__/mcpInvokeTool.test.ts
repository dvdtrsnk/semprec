import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Ajv } from "ajv";
import {
  createRuntimeRolePool,
  createTestTenant,
  getOrCreateTickThread,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, runInTenant, type AuthenticatedActor } from "@semprec/shared";
import {
  allowLoopbackOutboundForTests,
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "@semprec/data/testSupport/mcpContractServers";
import {
  ApprovalRequiredError,
  CORE_AGENT_RUN_ACTION_ID,
  withTransaction,
  upsertMcpToolRegistration,
  setProjectMcpGrantForAgentPage,
  seedSystem,
  createViewTypeRegistry,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createSempChatThread,
  getApprovalRequest,
  setInvalidationHook,
  setSempThreadInvalidationHook,
  createUser,
  hashPassword,
  type AgentRunRow,
  type CollectionMetadataResolver,
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
    const tenantId = getTenantZeroId();
    // A `stdio` spawn needs an admin of tenant zero (issue #1033).
    earliestUser = await createUser(pool, {
      email: `${randomUUID()}@example.test`,
      passwordHash,
      locale: "en",
      tenantId,
      role: "admin",
    });
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
  });

  // The sse/http contract servers listen on loopback, which the default outbound policy refuses.
  let restoreOutboundPolicy: () => void;
  beforeAll(() => {
    restoreOutboundPolicy = allowLoopbackOutboundForTests();
  });

  afterAll(async () => {
    restoreOutboundPolicy();
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
      const { server, registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);

      const invoke = createMcpInvokeTool(pool, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", __forceError: true });

      expect(result).toEqual({
        error: true,
        result: "contract-server-forced-error",
        failure: { failureKind: "toolError", mcpServerItemId: server.id },
      });
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
    it.each([true, 123])("rejects non-string MCP reason %s reaching the wrapper", async (reason) => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      expect((await invoke({ query: "test", semprecReason: reason })).error).toBe(true);
      const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(rows[0]?.count).toBe("0");
      expect(contractServer.getHandshakeCount()).toBe(0);
    });
    it("stores 500 non-BMP reason characters and rejects 501 without another request", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const reason = "😀".repeat(500);
      const accepted = await invoke({ query: "test", semprecReason: reason });
      expect(accepted.error).toBe(false);
      expect(accepted.approvalRequestId).toBeDefined();
      expect((await getApprovalRequest(pool, accepted.approvalRequestId!))?.reason).toBe(reason);
      const rejected = await invoke({ query: "test", semprecReason: "😀".repeat(501) });
      expect(rejected.error).toBe(true);
      const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(rows[0]?.count).toBe("1");
      expect(contractServer.getHandshakeCount()).toBe(0);
    });
    it("does not trust an argument hint when no server snapshot exists", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: false,
        }),
      );
      const result = await invoke({ query: "test", mcpServerItemId: randomUUID() });
      expect(result.failure).toEqual({ failureKind: "unavailable" });
      expect(contractServer.getHandshakeCount()).toBe(0);
      const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(rows[0]?.count).toBe("0");
    });

    it("rejects malformed trusted server metadata without echoing it", () => {
      expect(() =>
        createApprovalGatedMcpInvokeTool(pool, randomUUID(), randomUUID(), randomUUID(), {}, "bad-id"),
      ).toThrow("Invalid MCP server item id");
    });
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
      expect(result.approvalRequestId).toBe(requestIdMatch![1]);
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

    it("snapshots a registration risk class outside the closed set as unclassified, and keeps a known one", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);

      const riskClassOf = async (): Promise<string> => {
        const result = await invoke({ query: "semprec" });
        const id = result.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!;
        return (await getApprovalRequest(pool, id))!.riskClass;
      };

      await pool.query("UPDATE mcp_tool_registrations SET risk_class = 'high' WHERE id = $1", [registration.id]);
      expect(await riskClassOf()).toBe("unclassified");

      await pool.query("UPDATE mcp_tool_registrations SET risk_class = 'outbound' WHERE id = $1", [registration.id]);
      expect(await riskClassOf()).toBe("outbound");
    });

    it("stores semprecReason on the request and strips it from the stored args (issue #1420)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { server, registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", semprecReason: "To find your notes." });

      expect(result.error).toBe(false);
      const request = await getApprovalRequest(pool, result.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!);
      expect(request!.reason).toBe("To find your notes.");
      expect(request!.payload).toEqual({
        mcpToolRegistrationId: registration.id,
        mcpServerItemId: server.id,
        args: { query: "semprec" },
      });
    });

    it("stores the tool call id on the request and returns the same request for a redelivered call (issue #1618)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      // No public writer creates a chat thread with a historical activity timestamp.
      const thread = await withTransaction(pool, (client) =>
        client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, last_activity_at) VALUES ('chat', '2020-01-01') RETURNING id",
        ),
      );
      const threadId = thread.rows[0]!.id;
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", threadId });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const first = await invoke({ query: "semprec" }, undefined, { toolCallId: "call_1" });
      const again = await invoke({ query: "semprec" }, undefined, { toolCallId: "call_1" });
      const without = await invoke({ query: "semprec" });

      expect(again.approvalRequestId).toBe(first.approvalRequestId);
      expect((await getApprovalRequest(pool, first.approvalRequestId!))!.toolCallId).toBe("call_1");
      expect((await getApprovalRequest(pool, without.approvalRequestId!))!.toolCallId).toBeNull();
      const activity = await withTransaction(pool, (client) =>
        client.query<{ last_activity_at: Date; requested_at: Date }>(
          "SELECT t.last_activity_at, r.requested_at FROM semp_threads t JOIN approval_requests r ON r.id = $2 WHERE t.id = $1",
          [threadId, without.approvalRequestId],
        ),
      );
      expect(activity.rows).toHaveLength(1);
      expect(activity.rows[0]!.last_activity_at.getTime()).toBe(activity.rows[0]!.requested_at.getTime());
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM approval_requests WHERE agent_run_id = $1", [
        run.id,
      ]);
      expect(rows[0].n).toBe(2);
    });

    it("stores an mcpInvoke description with only the server and tool names (issue #1683)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const result = await createApprovalGatedMcpInvokeTool(
        pool,
        run.id,
        projectItemId,
        registration.id,
      )({
        query: "secret-value",
      });

      const request = await getApprovalRequest(pool, result.approvalRequestId!);
      expect(request!.description).toEqual({
        key: "approval.mcpInvoke",
        params: { serverName: "Contract server", toolName: registration.toolName },
      });
      expect(JSON.stringify(request!.description)).not.toContain("secret-value");
    });

    it("creates no request and returns an error for a semprecReason over 500 characters (issue #1420)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", semprecReason: "x".repeat(501) });

      expect(result.error).toBe(true);
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });

    it("normalizes a null semprecReason to an absent reason", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", semprecReason: null });
      expect(result.error).toBe(false);
      const request = await getApprovalRequest(pool, result.approvalRequestId!);
      expect(request?.reason).toBeNull();
      expect(request?.payload).toMatchObject({ args: { query: "semprec" } });
      expect(JSON.stringify(request?.payload)).not.toContain("semprecReason");
    });

    it("does not send semprecReason to the MCP server when the tool needs no approval (issue #1420)", async () => {
      const contractServer = startStdioContractServer([SEARCH_TOOL]);
      servers.push(contractServer);
      const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
      await pool.query(`UPDATE mcp_tool_registrations SET requires_approval = false WHERE id = $1`, [registration.id]);
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await invoke({ query: "semprec", semprecReason: "why" });

      expect(result.error).toBe(false);
      expect(contractServer.getLastToolCall()).toMatchObject({ name: "search_web", arguments: { query: "semprec" } });
      expect(JSON.stringify(contractServer.getLastToolCall())).not.toContain("semprecReason");
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
      const first = await invoke({ query: "private-argument-sentinel" });
      const firstRequestId = first.result.match(/Approval request ([0-9a-f-]{36})/i)![1]!;

      const { rows: afterFirst } = await pool.query(
        `SELECT user_id, kind, title, body, source_table, source_id, transition_instance, link_href FROM notifications WHERE source_id = $1`,
        [firstRequestId],
      );
      expect(afterFirst).toMatchObject([
        {
          user_id: user.id,
          kind: "approval_pending",
          title: "Semp needs approval",
          body: `Call "search_web" on MCP server "Contract server". Semp cannot undo this action.`,
          source_table: "approval_requests",
          transition_instance: firstRequestId,
          // The run has no thread and a person started it, which is a chat source.
          link_href: `?page=semp-chats&tab=semp&approvalRequestId=${firstRequestId}`,
        },
      ]);
      expect(JSON.stringify(afterFirst)).not.toContain("private-argument-sentinel");

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

    it("notifies the user of the tenant the request is created in, with a link that names the request and no user (issues #1018, #1787)", async () => {
      const runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
      try {
        const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
        const userB = await runInTenant(tenantB, () =>
          createUser(pool, {
            email: `${randomUUID()}@example.test`,
            passwordHash: "x",
            tenantId: tenantB,
          }),
        );
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

        const { rows } = await pool.query<{
          user_id: string;
          kind: string;
          link_href: string | null;
          tenant_id: string;
        }>(`SELECT user_id, kind, link_href, tenant_id FROM notifications WHERE source_id = $1`, [requestId]);
        expect(rows).toEqual([
          {
            user_id: userB.id,
            kind: "approval_pending",
            link_href: `?page=semp-chats&tab=semp&approvalRequestId=${requestId}`,
            tenant_id: tenantB,
          },
        ]);
        expect(rows[0]?.user_id).not.toBe(earliestUser.id);
        expect(rows[0]?.link_href).not.toContain(userB.id);
      } finally {
        await runtimePool.end();
      }
    });

    describe("realtime announcements (issue #1789)", () => {
      let approvalAnnouncements: Array<{ approvalRequestId: string; userId: string | undefined }>;
      let threadAnnouncements: Array<{ tenantId: string; threadId: string }>;

      beforeEach(() => {
        approvalAnnouncements = [];
        threadAnnouncements = [];
        setInvalidationHook((event) => {
          if (event.scope === "approvalRequest")
            approvalAnnouncements.push({ approvalRequestId: event.approvalRequestId, userId: event.userId });
        });
        setSempThreadInvalidationHook((event) => threadAnnouncements.push(event));
      });

      afterEach(() => {
        setInvalidationHook(() => {});
        setSempThreadInvalidationHook(() => {});
      });

      it("announces a deferred call to the owner of the run and to the thread of the run", async () => {
        const contractServer = startStdioContractServer([SEARCH_TOOL]);
        servers.push(contractServer);
        const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
        const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
        const run = await createAgentRun(pool, {
          projectItemId,
          triggeredBy: "user",
          unit: "session",
          task: "chat",
          threadId,
        });

        const result = await createApprovalGatedMcpInvokeTool(
          pool,
          run.id,
          projectItemId,
          registration.id,
        )({
          query: "semprec",
        });

        expect(approvalAnnouncements).toEqual([
          { approvalRequestId: result.approvalRequestId, userId: run.actorUserId },
        ]);
        expect(threadAnnouncements).toEqual([{ tenantId: getTenantZeroId(), threadId }]);
      });

      it("announces only the request when the run has no thread, and a redelivered tool call only once", async () => {
        const contractServer = startStdioContractServer([SEARCH_TOOL]);
        servers.push(contractServer);
        const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
        const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
        const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);

        const first = await invoke({ query: "semprec" }, undefined, { toolCallId: "call_1" });
        const redelivered = await invoke({ query: "semprec" }, undefined, { toolCallId: "call_1" });

        expect(redelivered.approvalRequestId).toBe(first.approvalRequestId);
        expect(approvalAnnouncements).toEqual([
          { approvalRequestId: first.approvalRequestId, userId: run.actorUserId },
        ]);
        expect(threadAnnouncements).toEqual([]);
      });

      it("announces nothing for a call that creates no request", async () => {
        const contractServer = startStdioContractServer([SEARCH_TOOL]);
        servers.push(contractServer);
        const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
        const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });

        const result = await createApprovalGatedMcpInvokeTool(
          pool,
          run.id,
          projectItemId,
          registration.id,
        )({
          query: "semprec",
          semprecReason: "x".repeat(501),
        });

        expect(result.error).toBe(true);
        expect(approvalAnnouncements).toEqual([]);
        expect(threadAnnouncements).toEqual([]);
      });
    });

    describe("approval notification link (issue #1787)", () => {
      const SOURCES = [
        ["a Semp chat", "chat", "?page=semp-chats&tab=semp&approvalRequestId="],
        ["an automatic task tick", "tick", "?page=inbox&approvalRequestId="],
        ["an MCP client", "mcp", "?page=inbox&approvalRequestId="],
      ] as const;

      const metadataResolver: CollectionMetadataResolver = {
        resolve: () => ({
          icon: null,
          color: null,
          overviewOrder: null,
          switcherOrder: null,
          clientVisible: true,
          overviewHidden: false,
        }),
        collectionFilter: () => undefined,
        overviewHideable: () => false,
      };

      /** A run of `projectItemId` with the given source, made by the production writers of threads, heartbeats and runs. */
      async function runOfSource(source: (typeof SOURCES)[number][1], projectItemId: string): Promise<AgentRunRow> {
        if (source === "chat") {
          const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
          return createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat", threadId });
        }
        if (source === "mcp") {
          return createAgentRun(pool, { projectItemId, triggeredBy: "mcp", task: "MCP run-credential session" });
        }
        const tick = await withTransaction(pool, async (client) => {
          const heartbeat = await createHeartbeat(client, {
            projectItemId,
            name: "Sunday planning",
            rule: { kind: "weekly", days: ["sun"], at: "21:00" },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "Plan the week" },
          });
          return { heartbeatId: heartbeat.id, threadId: (await getOrCreateTickThread(client, heartbeat.id)).id };
        });
        return createAgentRun(pool, { projectItemId, triggeredBy: "heartbeat", task: "Plan the week", ...tick });
      }

      /** The link of the one `approval_pending` notification about `requestId`. */
      async function linkOf(requestId: string): Promise<string | null> {
        const { rows } = await pool.query<{ link_href: string | null }>(
          `SELECT link_href FROM notifications
           WHERE kind = 'approval_pending' AND source_table = 'approval_requests' AND source_id = $1`,
          [requestId],
        );
        const row = rows[0];
        if (!row || rows.length !== 1) throw new Error(`Expected one notification, found ${rows.length}`);
        return row.link_href;
      }

      it.each(SOURCES)(
        "links an MCP request and a generic-operation request raised by %s to the same destination, each naming its own request",
        async (_label, source, destination) => {
          const contractServer = startStdioContractServer([SEARCH_TOOL]);
          servers.push(contractServer);
          const { registration, projectItemId } = await createGrantedTool(contractServer.connectionConfig);
          const run = await runOfSource(source, projectItemId);

          const mcp = await createApprovalGatedMcpInvokeTool(
            pool,
            run.id,
            projectItemId,
            registration.id,
          )({ query: "semprec" });
          if (mcp.approvalRequestId === undefined) throw new Error("Expected an MCP approval request");
          const mcpLink = await linkOf(mcp.approvalRequestId);
          expect(mcpLink).toBe(`${destination}${mcp.approvalRequestId}`);
          expect(mcpLink).not.toContain(run.actorUserId);

          const chokePoint = createChokePoint(pool);
          const database = await chokePoint.createDatabase({ name: "Tasks" });
          const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
          const actor: AuthenticatedActor = {
            userId: run.actorUserId,
            runId: run.id,
            agentProjectItemId: projectItemId,
          };
          const genericRequestId = await createGenericOperationGateway(pool, metadataResolver)
            .invoke("item.delete", actor, new Set(CAPABILITY_IDS), { itemId: item.id })
            .then(
              () => {
                throw new Error("Expected a generic-operation approval request");
              },
              (error: unknown) => {
                if (error instanceof ApprovalRequiredError) return error.details.approvalRequestId;
                throw error;
              },
            );
          expect(await linkOf(genericRequestId)).toBe(`${destination}${genericRequestId}`);
        },
      );
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

    it("refuses a foreign registration like a missing one without approval side effects", async () => {
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      let failure: { error: unknown } | undefined;
      try {
        const tenantB = await createTestTenant(pool);
        await runInTenant(tenantB, () =>
          createUser(pool, { email: `${randomUUID()}@example.test`, passwordHash: "x", tenantId: tenantB }),
        );
        const contractServer = startStdioContractServer([SEARCH_TOOL]);
        servers.push(contractServer);
        const { registration, server } = await createGrantedTool(contractServer.connectionConfig);
        const ownFixture = await runInTenant(tenantB, async () => {
          await seedSystem(runtimePool, createViewTypeRegistry());
          const serverId = randomUUID();
          const projectItemId = await withTransaction(runtimePool, async (client) => {
            const databases = await client.query<{ id: string }>(
              "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
            );
            expect(databases.rows).toHaveLength(1);
            const projects = await client.query<{ id: string }>(
              "SELECT id FROM items WHERE properties->>'name' = 'Semprec'",
            );
            expect(projects.rows).toHaveLength(1);
            await client.query("INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)", [
              serverId,
              databases.rows[0]!.id,
              JSON.stringify({ name: "Own server", active: true, connectionConfig: contractServer.connectionConfig }),
            ]);
            return projects.rows[0]!.id;
          });
          const own = await upsertMcpToolRegistration(runtimePool, {
            mcpServerItemId: serverId,
            toolName: SEARCH_TOOL.name,
            toolSchema: SEARCH_TOOL.inputSchema,
          });
          await withTransaction(runtimePool, (client) =>
            setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: own.id, granted: true }),
          );
          return { own, serverId, projectItemId };
        });
        const { own: ownRegistration, serverId: ownServerId, projectItemId } = ownFixture;
        await runInTenant(getTenantZeroId(), () =>
          withTransaction(runtimePool, (client) =>
            setProjectMcpGrantForAgentPage(client, {
              projectItemId,
              mcpToolRegistrationId: registration.id,
              granted: true,
            }),
          ),
        );
        const run = await runInTenant(tenantB, () =>
          createAgentRun(runtimePool, { projectItemId, triggeredBy: "user", task: "foreign" }),
        );
        const invoke = (id: string) =>
          runInTenant(tenantB, () =>
            createApprovalGatedMcpInvokeTool(runtimePool, run.id, projectItemId, id)({ query: "test" }),
          );
        const own = await invoke(ownRegistration.id);
        expect(own.error).toBe(false);
        expect(own.approvalRequestId).toBeTruthy();
        const snapshot = async () => {
          const rows = await pool.query<{
            registrations: unknown;
            servers: unknown;
            grants: unknown;
            requests: unknown;
            notifications: unknown;
          }>(
            `SELECT
              (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM mcp_tool_registrations r WHERE r.id = ANY($1::uuid[]) AND r.tenant_id = ANY($5::uuid[])) registrations,
              (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM items i WHERE i.id = ANY($2::uuid[]) AND i.tenant_id = ANY($5::uuid[])) servers,
              (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.project_item_id, g.mcp_tool_registration_id) FROM project_mcp_grants g WHERE g.mcp_tool_registration_id = ANY($1::uuid[]) AND g.tenant_id = ANY($5::uuid[])) grants,
              (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_requests a WHERE a.tenant_id = ANY($5::uuid[]) AND (a.agent_run_id = $3::uuid OR a.tenant_id = $4::uuid)) requests,
              (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM notifications n WHERE n.tenant_id = ANY($5::uuid[]) AND n.source_table = 'approval_requests') notifications`,
            [
              [registration.id, ownRegistration.id],
              [server.id, ownServerId],
              run.id,
              getTenantZeroId(),
              [getTenantZeroId(), tenantB],
            ],
          );
          if (rows.rows.length !== 1) throw new Error("Missing snapshot");
          return rows.rows[0]!;
        };
        const afterOwn = await snapshot();
        expect(afterOwn.registrations).toHaveLength(2);
        expect(afterOwn.servers).toHaveLength(2);
        expect(afterOwn.grants).toHaveLength(3);
        expect(afterOwn.requests).toHaveLength(1);
        expect(afterOwn.notifications).toHaveLength(1);
        const foreign = await invoke(registration.id);
        const missing = await invoke(randomUUID());
        expect(foreign.error).toBe(true);
        expect(foreign).toEqual(missing);
        expect(await snapshot()).toEqual(afterOwn);
        expect(contractServer.getHandshakeCount()).toBe(0);
      } catch (error) {
        failure = { error };
      }
      try {
        await runtimePool.end();
      } catch (error) {
        if (failure)
          throw new AggregateError([failure.error, error], "Foreign registration cleanup failed", { cause: error });
        throw error;
      }
      if (failure) throw failure.error;
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
