import { ModuleRegistry } from "@semprec/module-registry";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  ValidationError,
  createAgentRun,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { createMcpRequestListener } from "../mcp/mcpHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
  collectionFilter: () => undefined,
};

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z
  .object({ id: z.string(), updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
  .passthrough();
const storedRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
const restError = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).strict(),
});
const mcpResult = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});
const mcpError = z.object({
  error: z.object({ code: z.number(), message: z.string(), data: z.record(z.string(), z.unknown()) }).strict(),
});

/** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`; the body has no message. */
interface RestRefusal {
  status: number;
  code: string;
  details: Record<string, unknown>;
}

/** A refusal as the agent gateway exposes it: the `ValidationError` it throws. */
interface GatewayRefusal {
  code: string;
  status: number;
  message: string;
  details: Record<string, unknown>;
}

/** A refusal as MCP exposes it: a JSON-RPC error's code, message and `data`. It carries no category string. */
interface McpRefusal {
  rpcCode: number;
  message: string;
  data: Record<string, unknown>;
}

const TRANSPORTS = ["rest", "gateway", "mcp"] as const;
type Transport = (typeof TRANSPORTS)[number];

/** The values issue #1714 refuses: a label, the field named, and the reminder values of the write. */
const REFUSALS: Array<[string, string, Record<string, unknown>]> = [
  ["alertMinutes 7", "alertMinutes", { alertMinutes: 7 }],
  ["alertMinutes -5", "alertMinutes", { alertMinutes: -5 }],
  ["alertMinutes 15.5", "alertMinutes", { alertMinutes: 15.5 }],
  ["alertMinutes as the string 15", "alertMinutes", { alertMinutes: "15" }],
  ["alertMinutes true", "alertMinutes", { alertMinutes: true }],
  ["travelMinutes 20", "travelMinutes", { travelMinutes: 20 }],
  ["travelMinutes 0", "travelMinutes", { travelMinutes: 0 }],
  ["travelMinutes 30.5", "travelMinutes", { travelMinutes: 30.5 }],
  ["travelMinutes as the string 30", "travelMinutes", { travelMinutes: "30" }],
  ["travelMinutes false", "travelMinutes", { travelMinutes: false }],
];

/** The values issue #1714 accepts: a label and the reminder values of the write, which are stored as sent. */
const PASSES: Array<[string, Record<string, unknown>]> = [
  ["alertMinutes 0 and travelMinutes 30", { alertMinutes: 0, travelMinutes: 30 }],
  ["alertMinutes 5 and travelMinutes 15", { alertMinutes: 5, travelMinutes: 15 }],
  ["alertMinutes 15 and travelMinutes 60", { alertMinutes: 15, travelMinutes: 60 }],
  ["alertMinutes 60", { alertMinutes: 60 }],
  ["alertMinutes 1440", { alertMinutes: 1440 }],
  ["null for both keys", { alertMinutes: null, travelMinutes: null }],
];

let pool: Pool;
let eventsId: string;

async function stored(itemId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    "SELECT properties, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
    [eventsId, itemId],
  );
  return storedRow.parse(rows[0]);
}

async function eventsNamed(name: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND properties->>'name' = $2",
    [eventsId, name],
  );
  return rows[0]?.count ?? -1;
}

/**
 * Synthetic legacy state: the reminder-values hooks refuse a value outside the allowed sets on every write, so only a
 * row stored before issue #1714 holds one; no write path can produce it, so it is written with raw SQL.
 */
async function storeLegacy(itemId: string, legacy: Record<string, unknown>): Promise<void> {
  const result = await pool.query(
    "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
    [eventsId, itemId, JSON.stringify(legacy)],
  );
  expect(result.rowCount).toBe(1);
}

describe("Events reminder values are judged alike through REST, the agent gateway and MCP (issue #1714)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let mcpToken: string;
  let agentActor: AuthenticatedActor;
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'events' AND system",
    );
    eventsId = rows[0]?.id ?? "";
    if (!eventsId) throw new Error("Events database not seeded");

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "plan a meeting" });
    agentActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    mcpToken = (
      await withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.write"], userId: user.id }),
      )
    ).token;

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    baseUrl = await listen(server);
    mcpServer = createServer(
      await createMcpRequestListener(pool, gateway(), new Set(CAPABILITY_IDS), new ModuleRegistry(() => new Set())),
    );
    mcpUrl = await listen(mcpServer);
  });

  afterEach(async () => {
    await Promise.all([server, mcpServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function mcpCall(name: string, args: unknown): Promise<unknown> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  async function restRefusal(method: string, path: string, body: unknown): Promise<RestRefusal> {
    const response = await rest(method, path, body);
    const parsed = restError.parse(response.body);
    return { status: response.status, code: parsed.error.code, details: parsed.error.details };
  }

  async function gatewayRefusal(operation: "item.create" | "item.patch", input: unknown): Promise<GatewayRefusal> {
    const error: unknown = await gateway()
      .invoke(operation, agentActor, new Set(CAPABILITY_IDS), input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      details: z.record(z.string(), z.unknown()).parse(error.details),
    };
  }

  /** MCP carries a `ValidationError` as JSON-RPC `-32602` (invalid params): its message, and its details as `data`. */
  async function mcpRefusal(name: string, args: unknown): Promise<McpRefusal> {
    const parsed = mcpError.parse(await mcpCall(name, args));
    return { rpcCode: parsed.error.code, message: parsed.error.message, data: parsed.error.data };
  }

  /**
   * Every exposed part of the three refusals: REST and the gateway carry the same category and status, MCP the
   * gateway's message, and all three the same details naming `field`. MCP's category is not exposed, so it is not
   * compared.
   */
  function expectSameRefusal(refusals: { rest: RestRefusal; gateway: GatewayRefusal; mcp: McpRefusal }, field: string) {
    expect(refusals.rest).toEqual({ status: 400, code: "validation_failed", details: { field } });
    expect(refusals.gateway).toEqual({
      code: "validation_failed",
      status: 400,
      message: expect.any(String),
      details: { field },
    });
    expect(refusals.mcp).toEqual({ rpcCode: -32602, message: refusals.gateway.message, data: { field } });
  }

  function mcpItem(response: unknown) {
    const text = mcpResult.parse(response).result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text));
  }

  async function createVia(path: Transport, properties: Record<string, unknown>) {
    if (path === "rest") {
      const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties });
      expect(created.status).toBe(201);
      return itemBody.parse(created.body);
    }
    const input = { databaseId: eventsId, properties };
    if (path === "gateway") {
      return itemBody.parse(await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), input));
    }
    return mcpItem(await mcpCall("semprec.item.create", input));
  }

  /** The item a write path answers a patch with; REST must answer 200. */
  async function patchVia(
    path: Transport,
    item: { id: string; updatedAt: string },
    properties: Record<string, unknown>,
  ) {
    const input = { itemId: item.id, properties, ifVersion: item.updatedAt };
    if (path === "rest") {
      const patched = await rest("PATCH", `/api/items/${item.id}`, { properties, ifVersion: item.updatedAt });
      expect(patched.status).toBe(200);
      return itemBody.parse(patched.body);
    }
    if (path === "gateway") {
      return itemBody.parse(await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), input));
    }
    return mcpItem(await mcpCall("semprec.item.patch", input));
  }

  it.each(REFUSALS)(
    "refuses a create with %s on %s alike through REST, the agent gateway and MCP, writing nothing",
    async (label, field, values) => {
      const name = `Refused: ${label}`;
      const properties = { name, date: "2026-10-16", ...values };
      const refusals = {
        rest: await restRefusal("POST", `/api/databases/${eventsId}/items`, { properties }),
        gateway: await gatewayRefusal("item.create", { databaseId: eventsId, properties }),
        mcp: await mcpRefusal("semprec.item.create", { databaseId: eventsId, properties }),
      };
      expectSameRefusal(refusals, field);
      expect(await eventsNamed(name)).toBe(0);
    },
  );

  it.each(REFUSALS)(
    "refuses a patch with %s on %s alike through REST, the agent item.patch and MCP, keeping every row",
    async (label, field, values) => {
      const base = { date: "2026-10-16", alertMinutes: 15, travelMinutes: 30 };
      const targets = {
        rest: await createVia("rest", { name: `${label} rest`, ...base }),
        gateway: await createVia("gateway", { name: `${label} gateway`, ...base }),
        mcp: await createVia("mcp", { name: `${label} mcp`, ...base }),
      };
      const before = {
        rest: await stored(targets.rest.id),
        gateway: await stored(targets.gateway.id),
        mcp: await stored(targets.mcp.id),
      };
      const refusals = {
        rest: await restRefusal("PATCH", `/api/items/${targets.rest.id}`, {
          properties: values,
          ifVersion: targets.rest.updatedAt,
        }),
        gateway: await gatewayRefusal("item.patch", {
          itemId: targets.gateway.id,
          properties: values,
          ifVersion: targets.gateway.updatedAt,
        }),
        mcp: await mcpRefusal("semprec.item.patch", {
          itemId: targets.mcp.id,
          properties: values,
          ifVersion: targets.mcp.updatedAt,
        }),
      };
      expectSameRefusal(refusals, field);
      for (const path of TRANSPORTS) {
        expect(await stored(targets[path].id)).toEqual(before[path]);
      }
    },
  );

  it.each(PASSES)("accepts a create with %s through REST, the agent gateway and MCP", async (label, values) => {
    for (const path of TRANSPORTS) {
      const item = await createVia(path, { name: `${label} ${path}`, date: "2026-10-16", ...values });
      expect((await stored(item.id)).properties).toMatchObject(values);
    }
  });

  it.each(PASSES)("accepts a patch to %s through REST, the agent item.patch and MCP", async (label, values) => {
    for (const path of TRANSPORTS) {
      const item = await createVia(path, { name: `${label} ${path}`, date: "2026-10-16" });
      const patched = await patchVia(path, item, values);
      expect(patched.properties).toMatchObject(values);
      expect((await stored(item.id)).properties).toMatchObject(values);
    }
  });

  it("clears alertMinutes with a null patch through REST, the agent item.patch and MCP, keeping travelMinutes", async () => {
    for (const path of TRANSPORTS) {
      const item = await createVia(path, {
        name: `Cleared ${path}`,
        date: "2026-10-16",
        alertMinutes: 15,
        travelMinutes: 30,
      });
      const patched = await patchVia(path, item, { alertMinutes: null });
      expect(patched.properties).toMatchObject({ alertMinutes: null, travelMinutes: 30 });
      expect((await stored(item.id)).properties).toMatchObject({ alertMinutes: null, travelMinutes: 30 });
    }
  });

  it("accepts a patch of only name on an Event whose stored values are outside the allowed sets", async () => {
    for (const path of TRANSPORTS) {
      const item = await createVia(path, { name: `Legacy ${path}`, date: "2026-10-16" });
      await storeLegacy(item.id, { alertMinutes: 7, travelMinutes: 20 });
      const patched = await patchVia(path, item, { name: `Renamed ${path}` });
      expect(patched.properties).toMatchObject({ name: `Renamed ${path}`, alertMinutes: 7, travelMinutes: 20 });
      expect((await stored(item.id)).properties).toMatchObject({
        name: `Renamed ${path}`,
        alertMinutes: 7,
        travelMinutes: 20,
      });
    }
  });
});
