import { ModuleRegistry } from "@semprec/module-registry";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  getAgentRun,
  hashPassword,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type ChokePoint,
} from "@semprec/data";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, currentTenantScope, runAsSystem, runInTenant, type CapabilityId } from "@semprec/shared";
import { createMcpRequestListener } from "../mcpHandler.js";
import { SESSION_COOKIE_NAME } from "../../authHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
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

const PASSWORD = "s3cret-password";
const ALL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(CAPABILITY_IDS);
const NO_CAPABILITIES: ReadonlySet<CapabilityId> = new Set();

let pool: Pool;
let chokePoint: ChokePoint;
let gateway: GenericOperationGateway;

async function authHeader(): Promise<{ Authorization: string }> {
  const email = `${randomUUID()}@example.com`;
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/**
 * Tenant zero's user, created on first use. A minted credential's run names its actor, and a run's
 * actor must be its own tenant's user (`agent_runs_actor_user_id_tenant_fkey`, issue #1066).
 */
async function tenantZeroUserId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
  return rows[0]?.id ?? (await createTenantZeroUser(pool)).id;
}

async function startServer(
  grantedCapabilities: ReadonlySet<CapabilityId>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(
    await createMcpRequestListener(pool, gateway, grantedCapabilities, new ModuleRegistry(() => new Set())),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(baseUrl: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createMcpRequestListener (issue #220)", () => {
  let servers: Server[] = [];

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    gateway = createGenericOperationGateway(pool, testMetadataResolver);
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects a non-POST method with 405 and Allow: POST", async () => {
    const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
    servers.push(server);

    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects an unauthenticated request", async () => {
    const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
    servers.push(server);

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects a web-session cookie with no Authorization header", async () => {
    const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
    servers.push(server);

    const email = `${randomUUID()}@example.com`;
    const user = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "web", ip: "127.0.0.1" });

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns a JSON-RPC parse-error for a malformed body, with HTTP 200", async () => {
    const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
    servers.push(server);

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32700);
  });

  describe("initialize", () => {
    const initialize = (protocolVersion: unknown) => ({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "c", version: "1" } },
    });

    it("returns the same initialize result for a human session and a real run credential", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const human = await authHeader();
      const sessionRows = await pool.query<{ id: string }>("SELECT id FROM sessions");
      const callerSessionId = sessionRows.rows[0]?.id;
      if (!callerSessionId || sessionRows.rows.length !== 1) throw new Error("Expected the caller session");
      await authHeader();
      const userId = await tenantZeroUserId();
      const projectItemId = await createTestProjectItem(pool);
      const credential = await withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
      );
      const request = initialize("2025-06-18");
      const snapshot = async () => {
        const { rows } = await pool.query<{
          items: unknown;
          databases: unknown;
          properties: unknown;
          users: unknown;
          runs: unknown;
          credentials: unknown;
          sessions: unknown;
        }>(`
          SELECT
            (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb) FROM items i) AS items,
            (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb) FROM databases d) AS databases,
            (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) FROM properties p) AS properties,
            (SELECT coalesce(jsonb_agg(to_jsonb(u) - 'password_hash' ORDER BY u.id), '[]'::jsonb) FROM users u) AS users,
            (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM agent_runs r) AS runs,
            (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) FROM agent_run_mcp_credentials c) AS credentials,
            (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM sessions s) AS sessions
        `);
        if (!rows[0]) throw new Error("Missing persistence snapshot");
        return rows[0];
      };
      const before = await snapshot();

      const humanResponse = await rpc(baseUrl, human, request);
      const afterHuman = await snapshot();
      const runResponse = await rpc(baseUrl, { Authorization: `Bearer ${credential.token}` }, request);
      const afterRun = await snapshot();

      expect(humanResponse.status).toBe(200);
      expect(runResponse.status).toBe(200);
      const humanBody: unknown = await humanResponse.json();
      const runBody: unknown = await runResponse.json();
      expect(humanBody).toMatchObject({
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "semprec" } },
      });
      expect(runBody).toEqual(humanBody);
      expect(afterHuman.items).toEqual(before.items);
      expect(afterHuman.databases).toEqual(before.databases);
      expect(afterHuman.properties).toEqual(before.properties);
      expect(afterHuman.users).toEqual(before.users);
      expect(afterHuman.runs).toEqual(before.runs);
      expect(JSON.stringify(afterHuman.credentials) === JSON.stringify(before.credentials)).toBe(true);
      // Authentication is allowed to touch the caller's session timestamps and no other fields.
      const stableSessions = (value: unknown): unknown => {
        if (!Array.isArray(value)) throw new Error("Expected session snapshot array");
        return value.map((row: unknown) => {
          if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("Invalid session row");
          if (!("id" in row) || typeof row.id !== "string") throw new Error("Missing session id");
          return row.id === callerSessionId
            ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "last_seen_at" && key !== "expires_at"))
            : row;
        });
      };
      expect(
        JSON.stringify(stableSessions(afterHuman.sessions)) === JSON.stringify(stableSessions(before.sessions)),
      ).toBe(true);
      // The run credential's client named its own run (issue #1788); nothing else changed.
      const withClientName = (value: unknown): unknown => {
        if (!Array.isArray(value)) throw new Error("Expected run snapshot array");
        return value.map((row: unknown) => {
          if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("Invalid run row");
          if (!("id" in row) || typeof row.id !== "string") throw new Error("Missing run id");
          return row.id === credential.run.id ? { ...row, mcp_client_name: "c" } : row;
        });
      };
      expect(
        JSON.stringify(afterRun) === JSON.stringify({ ...afterHuman, runs: withClientName(afterHuman.runs) }),
      ).toBe(true);
      expect(await getAgentRun(pool, credential.run.id)).toMatchObject({ mcpClientName: "c" });
    });

    it.each(["2025-06-18", "2025-03-26", "2024-11-05"])("echoes the supported version %s", async (version) => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), initialize(version));
      const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
      ) {
        throw new Error("API package version is missing");
      }

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.id).toBe(7);
      expect(body.result).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "semprec", version: manifest.version },
      });
    });

    it("answers the newest version for an unsupported one", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), initialize("1999-01-01"));

      const body = (await res.json()) as JsonRpcResponse;
      expect((body.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    });

    it.each([
      ["missing params", undefined],
      ["null params", null],
      ["non-object params", "x"],
      ["non-string protocolVersion", { protocolVersion: 5 }],
      ["missing protocolVersion", {}],
    ])("answers -32602 for %s", async (_label, params) => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), { jsonrpc: "2.0", id: 1, method: "initialize", params });

      const body = (await res.json()) as JsonRpcResponse;
      expect(body.error?.code).toBe(-32602);
    });

    it("is rejected without credentials exactly like tools/list", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, {}, initialize("2025-06-18"));
      const list = await rpc(baseUrl, {}, { jsonrpc: "2.0", id: 7, method: "tools/list" });

      expect(res.status).toBe(401);
      expect(list.status).toBe(res.status);
      expect(await list.json()).toEqual(await res.json());
    });

    it("succeeds for a human session and writes nothing", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const headers = await authHeader();
      const count = async () =>
        (await pool.query<{ n: string }>("SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM sessions) AS n"))
          .rows[0]?.n;
      const before = await count();

      const res = await rpc(baseUrl, headers, initialize("2025-06-18"));

      expect(res.status).toBe(200);
      expect(await count()).toBe(before);
    });

    describe("client name of a run credential (issue #1788)", () => {
      const initializeAs = (clientInfo: unknown) => ({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          ...(clientInfo === undefined ? {} : { clientInfo }),
        },
      });

      async function mintRun(): Promise<{ headers: { Authorization: string }; runId: string }> {
        const userId = await tenantZeroUserId();
        const projectItemId = await createTestProjectItem(pool);
        const minted = await withTransaction(pool, (client) =>
          mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
        );
        return { headers: { Authorization: `Bearer ${minted.token}` }, runId: minted.run.id };
      }

      async function storedName(runId: string): Promise<string | null> {
        const run = await getAgentRun(pool, runId);
        if (!run) throw new Error("The run is missing");
        return run.mcpClientName;
      }

      it("stores the client's name on the credential's run and answers the handshake", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();
        const other = await mintRun();

        const res = await rpc(baseUrl, headers, initializeAs({ name: "Claude Desktop", version: "1.2.3" }));

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({
          id: 7,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "semprec" } },
        });
        expect(await storedName(runId)).toBe("Claude Desktop");
        expect(await storedName(other.runId)).toBeNull();
      });

      it("replaces the name with the one of a second initialize", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();
        await rpc(baseUrl, headers, initializeAs({ name: "Claude Desktop" }));

        const res = await rpc(baseUrl, headers, initializeAs({ name: "Cursor" }));

        expect(res.status).toBe(200);
        expect(await storedName(runId)).toBe("Cursor");
      });

      it("stores a name longer than 64 characters cut to 64", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();

        const res = await rpc(baseUrl, headers, initializeAs({ name: `${"n".repeat(64)}tail` }));

        expect(res.status).toBe(200);
        expect(await storedName(runId)).toBe("n".repeat(64));
      });

      it.each([
        ["control characters", "\u0000\u0007\u009f"],
        ["whitespace", " \t\n "],
      ])("leaves NULL for a name of only %s", async (_label, name) => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();

        const res = await rpc(baseUrl, headers, initializeAs({ name }));

        expect(res.status).toBe(200);
        expect(await storedName(runId)).toBeNull();
      });

      it.each([
        ["no clientInfo", undefined],
        ["a null clientInfo", null],
        ["a clientInfo that is no object", "Claude Desktop"],
        ["a clientInfo without a name", { version: "1" }],
        ["a name that is no string", { name: 42 }],
      ])("writes nothing for %s and answers the handshake", async (_label, clientInfo) => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();
        await rpc(baseUrl, headers, initializeAs({ name: "Earlier Client" }));

        const res = await rpc(baseUrl, headers, initializeAs(clientInfo));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
        expect(await storedName(runId)).toBe("Earlier Client");
      });

      it("writes nothing when the handshake is refused for its params", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { headers, runId } = await mintRun();

        const res = await rpc(baseUrl, headers, {
          jsonrpc: "2.0",
          id: 7,
          method: "initialize",
          params: { clientInfo: { name: "Claude Desktop" } },
        });

        expect(await res.json()).toMatchObject({ error: { code: -32602 } });
        expect(await storedName(runId)).toBeNull();
      });

      it("names no run for a human session and answers the handshake", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const named = await mintRun();
        const unnamed = await mintRun();
        await rpc(baseUrl, named.headers, initializeAs({ name: "Earlier Client" }));

        const res = await rpc(baseUrl, await authHeader(), initializeAs({ name: "Claude Desktop" }));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "semprec" } },
        });
        expect(await storedName(named.runId)).toBe("Earlier Client");
        expect(await storedName(unnamed.runId)).toBeNull();
      });
    });
  });

  describe("notifications", () => {
    it.each(["notifications/initialized", "notifications/anything"])("%s answers 202 with no body", async (method) => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const headers = await authHeader();
      const before = await rpc(baseUrl, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const beforeBody: unknown = await before.json();

      const res = await rpc(baseUrl, headers, { jsonrpc: "2.0", method });

      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");

      const list = await rpc(baseUrl, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const afterBody: unknown = await list.json();
      expect(beforeBody).toMatchObject({
        result: { tools: expect.arrayContaining([expect.objectContaining({ name: "semprec.item.create" })]) },
      });
      expect(afterBody).toEqual(beforeBody);
    });

    it("rejects an unauthenticated notification", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, {}, { jsonrpc: "2.0", method: "notifications/initialized" });

      expect(res.status).toBe(401);
    });
  });

  describe("tools/list", () => {
    it("returns every operation prefixed 'semprec.' for the granted capabilities", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), { jsonrpc: "2.0", id: 1, method: "tools/list" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const tools = (body.result as { tools: { name: string }[] }).tools;
      expect(tools.some((t) => t.name === "semprec.item.create")).toBe(true);
      expect(tools.some((t) => t.name === "semprec.item.delete")).toBe(true);
      expect(tools.some((t) => t.name === "semprec.relation.list")).toBe(true);
      expect(tools.some((t) => t.name === "semprec.page.restoreVersion")).toBe(true);
      expect(tools.every((t) => t.name.startsWith("semprec."))).toBe(true);
    });

    it("returns no tools when no capability is granted", async () => {
      const { server, baseUrl } = await startServer(NO_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), { jsonrpc: "2.0", id: 1, method: "tools/list" });

      const body = (await res.json()) as JsonRpcResponse;
      expect((body.result as { tools: unknown[] }).tools).toEqual([]);
    });
  });

  describe("tools/call", () => {
    it("returns -32601 for an unknown tool name, indistinguishable from a real-but-ungranted one", async () => {
      const { server: grantedServer, baseUrl: grantedBaseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(grantedServer);
      const { server: noneServer, baseUrl: noneBaseUrl } = await startServer(NO_CAPABILITIES);
      servers.push(noneServer);
      const headers = await authHeader();

      const unknownRes = await rpc(grantedBaseUrl, headers, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.not.a.real.operation", arguments: {} },
      });
      const ungrantedRes = await rpc(noneBaseUrl, headers, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.get", arguments: { itemId: randomUUID() } },
      });

      const unknownBody = (await unknownRes.json()) as JsonRpcResponse;
      const ungrantedBody = (await ungrantedRes.json()) as JsonRpcResponse;
      expect(unknownBody.error?.code).toBe(-32601);
      expect(ungrantedBody.error?.code).toBe(-32601);
    });

    it("executes a granted, valid, non-destructive tool and returns its real output", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const database = await chokePoint.createDatabase({ name: "MCP DB" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });

      const res = await rpc(baseUrl, await authHeader(), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.create", arguments: { databaseId: database.id, properties: { title: "hi" } } },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const content = (body.result as { content: { type: string; text: string }[] }).content;
      const created = JSON.parse(content[0]!.text) as { id: string; properties: Record<string, unknown> };
      expect(created.properties).toMatchObject({ title: "hi" });
      expect(await chokePoint.findItem(created.id)).not.toBeNull();
    });

    it("executes a granted destructive tool directly for an MCP actor — no approval gate, since MCP actors never carry runId", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const database = await chokePoint.createDatabase({ name: "MCP DB 2" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });

      const res = await rpc(baseUrl, await authHeader(), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.delete", arguments: { itemId: item.id } },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.error).toBeUndefined();
      expect(await chokePoint.findItem(item.id)).toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(0);
    });

    it("returns -32602 for input that fails the operation's zod validation", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await authHeader(), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.get", arguments: {} },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.error?.code).toBe(-32602);
    });
  });

  describe("restricted MCP run-credentials (issue #220, AC34/44/47)", () => {
    async function credentialHeader(capabilities: CapabilityId[]): Promise<{ Authorization: string }> {
      const userId = await tenantZeroUserId();
      const projectItemId = await createTestProjectItem(pool);
      const minted = await withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities, userId }),
      );
      return { Authorization: `Bearer ${minted.token}` };
    }

    it("restricts tools/list to the credential's own capabilities, not the full process grant", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await credentialHeader(["core.item.write"]), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });

      const body = (await res.json()) as JsonRpcResponse;
      const tools = (body.result as { tools: { name: string }[] }).tools;
      expect(tools.some((t) => t.name === "semprec.item.create")).toBe(true);
      expect(tools.some((t) => t.name === "semprec.item.get")).toBe(false);
    });

    it("never widens capabilities beyond what the process itself grants", async () => {
      const { server, baseUrl } = await startServer(NO_CAPABILITIES);
      servers.push(server);

      const res = await rpc(baseUrl, await credentialHeader([...CAPABILITY_IDS]), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });

      const body = (await res.json()) as JsonRpcResponse;
      expect((body.result as { tools: unknown[] }).tools).toEqual([]);
    });

    it("routes a destructive tool call through the approval gate for a restricted-credential actor, unlike a plain session", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const database = await chokePoint.createDatabase({ name: "MCP credential DB" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });

      const res = await rpc(baseUrl, await credentialHeader(["core.item.write"]), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.delete", arguments: { itemId: item.id } },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.error?.code).toBe(-32001);
      expect(await chokePoint.findItem(item.id)).not.toBeNull();
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM approval_requests`);
      expect(rows[0].count).toBe(1);
    });

    it("executes a granted non-destructive tool for a restricted-credential actor", async () => {
      const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
      servers.push(server);
      const database = await chokePoint.createDatabase({ name: "MCP credential DB 2" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });

      const res = await rpc(baseUrl, await credentialHeader(["core.item.write"]), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.create", arguments: { databaseId: database.id, properties: { title: "hi" } } },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      const content = (body.result as { content: { type: string; text: string }[] }).content;
      const created = JSON.parse(content[0]!.text) as { id: string };
      expect(await chokePoint.findItem(created.id)).not.toBeNull();
    });

    describe("tenant resolution", () => {
      /** Mints a credential for tenant zero's user and returns the token plus its run id. */
      async function mintCredential(): Promise<{ token: string; runId: string }> {
        const userId = await tenantZeroUserId();
        const projectItemId = await createTestProjectItem(pool);
        const minted = await withTransaction(pool, (client) =>
          mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
        );
        return { token: minted.token, runId: minted.run.id };
      }

      async function listTools(baseUrl: string, token: string): Promise<{ status: number; body: unknown }> {
        const res = await rpc(
          baseUrl,
          { Authorization: `Bearer ${token}` },
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
        );
        return { status: res.status, body: await res.json() };
      }

      it("executes a tools/call inside the credential's tenant scope", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const { token } = await mintCredential();
        const { rows } = await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM agent_run_mcp_credentials`);
        const scopes: unknown[] = [];
        const invoke = gateway.invoke.bind(gateway);
        vi.spyOn(gateway, "invoke").mockImplementation((...args) => {
          scopes.push(currentTenantScope());
          return invoke(...args);
        });

        const res = await rpc(
          baseUrl,
          { Authorization: `Bearer ${token}` },
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "semprec.database.list", arguments: {} },
          },
        );

        expect(res.status).toBe(200);
        expect(scopes).toEqual([{ kind: "tenant", tenantId: rows[0]!.tenant_id }]);
      });

      it("answers the unknown-token 401 for an expired credential, a finished run and a suspended tenant", async () => {
        const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
        servers.push(server);
        const unknown = await listTools(baseUrl, "not-a-real-token");
        expect(unknown.status).toBe(401);

        const expired = await mintCredential();
        await pool.query(
          `UPDATE agent_run_mcp_credentials SET expires_at = now() - interval '1 minute' WHERE agent_run_id = $1`,
          [expired.runId],
        );
        const finished = await mintCredential();
        await pool.query(`UPDATE agent_runs SET status = 'done', finished_at = now() WHERE id = $1`, [finished.runId]);
        const suspended = await mintCredential();
        const live = await mintCredential();
        expect((await listTools(baseUrl, live.token)).status).toBe(200);

        expect(await listTools(baseUrl, expired.token)).toEqual(unknown);
        expect(await listTools(baseUrl, finished.token)).toEqual(unknown);

        await pool.query(`UPDATE tenants SET status = 'suspended'`);
        try {
          expect(await listTools(baseUrl, suspended.token)).toEqual(unknown);
        } finally {
          await pool.query(`UPDATE tenants SET status = 'active'`);
        }
        expect((await listTools(baseUrl, suspended.token)).status).toBe(200);
      });
    });
  });
});

describe("the MCP client name under the runtime role (issue #1788)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    server = createServer(
      await createMcpRequestListener(
        runtimePool,
        createGenericOperationGateway(runtimePool, testMetadataResolver),
        ALL_CAPABILITIES,
        new ModuleRegistry(() => new Set()),
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await runtimePool?.end();
    await adminPool?.end();
  });

  it("lets a run credential name its own run only, in its own tenant", async () => {
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    // A tenant has one user, so both runs of tenant A act for the same one.
    async function createUserOf(tenantId: string): Promise<string> {
      const user = await createUser(adminPool, {
        tenantId,
        email: `${randomUUID()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
      });
      return user.id;
    }
    async function mintIn(tenantId: string, userId: string): Promise<{ token: string; runId: string }> {
      return runInTenant(tenantId, async () => {
        const projectItemId = await createTestProjectItem(runtimePool);
        const minted = await withTransaction(runtimePool, (client) =>
          mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
        );
        return { token: minted.token, runId: minted.run.id };
      });
    }
    const initializeWith = (token: string, name: string) =>
      rpc(
        baseUrl,
        { Authorization: `Bearer ${token}` },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name } },
        },
      );
    async function storedName(tenantId: string, runId: string): Promise<string | null> {
      const run = await runInTenant(tenantId, () => getAgentRun(runtimePool, runId));
      if (!run) throw new Error("The run is missing in its own tenant");
      return run.mcpClientName;
    }
    const userA = await createUserOf(tenantA);
    const own = await mintIn(tenantA, userA);
    const sibling = await mintIn(tenantA, userA);
    const foreign = await mintIn(tenantB, await createUserOf(tenantB));
    expect((await initializeWith(foreign.token, "Tenant B Client")).status).toBe(200);

    const res = await initializeWith(own.token, "Claude Desktop");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    expect(await storedName(tenantA, own.runId)).toBe("Claude Desktop");
    expect(await storedName(tenantA, sibling.runId)).toBeNull();
    expect(await storedName(tenantB, foreign.runId)).toBe("Tenant B Client");
    // Tenant A's scope does not show tenant B's run at all.
    expect(await runInTenant(tenantA, () => getAgentRun(runtimePool, foreign.runId))).toBeNull();
  });
});
