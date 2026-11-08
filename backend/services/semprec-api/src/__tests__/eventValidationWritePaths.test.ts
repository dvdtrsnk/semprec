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
};

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z.object({ id: z.string(), updatedAt: z.string() }).passthrough();
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

/**
 * One refusal as each transport carries it. The three envelopes differ by design (an HTTP body, a thrown
 * `ValidationError`, a JSON-RPC error); what must be identical is the category and the `details`.
 */
interface Refusal {
  category: string;
  details: Record<string, unknown>;
}

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

describe("Events validation errors are the same through REST, the agent gateway and MCP (issue #1663)", () => {
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
    eventsId = rows[0]!.id;

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

  async function restRefusal(method: string, path: string, body: unknown): Promise<Refusal> {
    const response = await rest(method, path, body);
    expect(response.status).toBe(400);
    const parsed = restError.parse(response.body);
    return { category: parsed.error.code, details: parsed.error.details };
  }

  async function gatewayRefusal(operation: "item.create" | "item.patch", input: unknown): Promise<Refusal> {
    const error: unknown = await gateway()
      .invoke(operation, agentActor, new Set(CAPABILITY_IDS), input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
    return { category: error.code, details: z.record(z.string(), z.unknown()).parse(error.details) };
  }

  /** MCP carries a `ValidationError` as JSON-RPC `-32602` (invalid params) with its details as `data`. */
  async function mcpRefusal(name: string, args: unknown): Promise<Refusal> {
    const parsed = mcpError.parse(await mcpCall(name, args));
    expect(parsed.error.code).toBe(-32602);
    return { category: "validation_failed", details: parsed.error.data };
  }

  async function createVia(path: "rest" | "gateway" | "mcp", properties: Record<string, unknown>) {
    if (path === "rest") {
      const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties });
      expect(created.status).toBe(201);
      return itemBody.parse(created.body);
    }
    if (path === "gateway") {
      return itemBody.parse(
        await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
          databaseId: eventsId,
          properties,
        }),
      );
    }
    const text = mcpResult
      .parse(await mcpCall("semprec.item.create", { databaseId: eventsId, properties }))
      .result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text));
  }

  it("refuses a create with timeTo 24:30 with the same category and details on every path, writing nothing", async () => {
    const name = "Too late";
    const properties = { name, date: "2026-10-16", timeFrom: "23:00", timeTo: "24:30" };
    const refusals = [
      await restRefusal("POST", `/api/databases/${eventsId}/items`, { properties }),
      await gatewayRefusal("item.create", { databaseId: eventsId, properties }),
      await mcpRefusal("semprec.item.create", { databaseId: eventsId, properties }),
    ];
    for (const refusal of refusals) {
      expect(refusal).toEqual({ category: "validation_failed", details: { field: "timeTo" } });
    }
    expect(await eventsNamed(name)).toBe(0);
  });

  it("refuses an agent item.patch and an MCP patch of timeFrom 11:45 on 10:00–11:30 exactly as REST does", async () => {
    const event = { date: "2026-10-16", timeFrom: "10:00", timeTo: "11:30" };
    const refusals: Refusal[] = [];
    for (const path of ["rest", "gateway", "mcp"] as const) {
      const item = await createVia(path, { name: `Meeting ${path}`, ...event });
      const before = await stored(item.id);
      const patch = { itemId: item.id, properties: { timeFrom: "11:45" }, ifVersion: item.updatedAt };
      refusals.push(
        path === "rest"
          ? await restRefusal("PATCH", `/api/items/${item.id}`, {
              properties: patch.properties,
              ifVersion: patch.ifVersion,
            })
          : path === "gateway"
            ? await gatewayRefusal("item.patch", patch)
            : await mcpRefusal("semprec.item.patch", patch),
      );
      expect(await stored(item.id)).toEqual(before);
    }
    for (const refusal of refusals) {
      expect(refusal).toEqual({ category: "validation_failed", details: { field: "timeTo" } });
    }
  });

  it("names endDate on every path when a patch moves the start of a two-day Event past its end", async () => {
    const refusals: Refusal[] = [];
    for (const path of ["rest", "gateway", "mcp"] as const) {
      const item = await createVia(path, { name: `Weekend ${path}`, date: "2026-10-24", endDate: "2026-10-25" });
      const before = await stored(item.id);
      const patch = { itemId: item.id, properties: { date: "2026-10-26" }, ifVersion: item.updatedAt };
      refusals.push(
        path === "rest"
          ? await restRefusal("PATCH", `/api/items/${item.id}`, {
              properties: patch.properties,
              ifVersion: patch.ifVersion,
            })
          : path === "gateway"
            ? await gatewayRefusal("item.patch", patch)
            : await mcpRefusal("semprec.item.patch", patch),
      );
      expect(await stored(item.id)).toEqual(before);
    }
    for (const refusal of refusals) {
      expect(refusal).toEqual({ category: "validation_failed", details: { field: "endDate" } });
    }
  });
});
