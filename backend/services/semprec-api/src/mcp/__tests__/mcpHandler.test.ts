import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  login,
  mintMcpRunCredential,
  seedSystem,
  type ChokePoint,
} from "@semprec/data";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, type CapabilityId } from "@semprec/shared";
import { createMcpRequestListener } from "../mcpHandler.js";

const PASSWORD = "s3cret-password";
const ALL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(CAPABILITY_IDS);
const NO_CAPABILITIES: ReadonlySet<CapabilityId> = new Set();

let pool: Pool;
let chokePoint: ChokePoint;
let gateway: GenericOperationGateway;

async function authHeader(): Promise<{ Authorization: string }> {
  const email = `${randomUUID()}@example.com`;
  const user = await createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

async function startServer(
  grantedCapabilities: ReadonlySet<CapabilityId>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createMcpRequestListener(pool, gateway, grantedCapabilities));
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
    gateway = createGenericOperationGateway(pool);
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects a non-POST method with 404", async () => {
    const { server, baseUrl } = await startServer(ALL_CAPABILITIES);
    servers.push(server);

    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });

    expect(res.status).toBe(404);
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
      // `mintMcpRunCredential` attributes the run to the sole account (single-tenant), so one must exist.
      await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: await hashPassword(PASSWORD) });
      const minted = await mintMcpRunCredential(pool, { projectItemId: randomUUID(), capabilities });
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
  });
});
