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
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@semprec$/;

const CREATE = { name: "Client meeting", date: "2026-10-16", timeFrom: "9:00" };
const PATCH = { timeFrom: "8:30" };

const storedRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
const itemBody = z.object({ id: z.string(), updatedAt: z.string() }).passthrough();
const createdIdentity = z
  .object({ id: z.string(), properties: z.object({ icalUid: z.unknown(), icalSequence: z.unknown() }).passthrough() })
  .passthrough();
const mcpEnvelope = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});

let pool: Pool;
let eventsId: string;

async function stored(itemId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    "SELECT properties, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
    [eventsId, itemId],
  );
  return storedRow.parse(rows[0]);
}

/** The values the Events transforms own, which every write path must store identically. */
function transformed(properties: Record<string, unknown>) {
  const { date, endDate, timeFrom, timeTo, time, icalSequence } = properties;
  return { date, endDate: endDate ?? null, timeFrom, timeTo, time, icalSequence };
}

describe("Events writes through REST, the agent gateway and MCP (issues #1598, #1599)", () => {
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

  async function mcp(name: string, args: unknown): Promise<z.infer<typeof itemBody>> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = mcpEnvelope.parse(await res.json()).result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text));
  }

  /**
   * Issue #1599: the identity a create returned and stored, read before any later write of the Event, so a
   * missing initial sequence cannot be hidden by the patch transform's bump.
   */
  async function expectCreationIdentity(returned: unknown, path: string): Promise<void> {
    const created = createdIdentity.parse(returned);
    expect(created.properties.icalUid, path).toMatch(UID_PATTERN);
    expect(created.properties.icalSequence, path).toBe(0);
    const row = await stored(created.id);
    expect(row.properties.icalUid, path).toBe(created.properties.icalUid);
    expect(row.properties.icalSequence, path).toBe(0);
  }

  async function viaRest(): Promise<string> {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties: CREATE });
    expect(created.status).toBe(201);
    await expectCreationIdentity(created.body, "REST");
    const item = itemBody.parse(created.body);
    const patched = await rest("PATCH", `/api/items/${item.id}`, { properties: PATCH, ifVersion: item.updatedAt });
    expect(patched.status).toBe(200);
    return item.id;
  }

  /** The generic operation gateway invoked with an agent actor; the agent-runtime tool wrapper is not exercised here. */
  async function viaAgentGateway(): Promise<string> {
    const returned = await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
      databaseId: eventsId,
      properties: CREATE,
    });
    await expectCreationIdentity(returned, "agent gateway");
    const created = itemBody.parse(returned);
    await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
      itemId: created.id,
      properties: PATCH,
      ifVersion: created.updatedAt,
    });
    return created.id;
  }

  async function viaMcp(): Promise<string> {
    const created = await mcp("semprec.item.create", { databaseId: eventsId, properties: CREATE });
    await expectCreationIdentity(created, "MCP");
    await mcp("semprec.item.patch", { itemId: created.id, properties: PATCH, ifVersion: created.updatedAt });
    return created.id;
  }

  it("stores the same normalized times and identity whichever path writes the Event", async () => {
    const ids = [await viaRest(), await viaAgentGateway(), await viaMcp()];
    const rows = await Promise.all(ids.map(stored));
    const expected = {
      date: "2026-10-16",
      endDate: null,
      timeFrom: "08:30",
      timeTo: "10:00",
      time: "08:30–10:00",
      icalSequence: 1,
    };
    for (const row of rows) {
      expect(transformed(row.properties)).toEqual(expected);
      expect(row.properties.icalUid).toMatch(UID_PATTERN);
    }
    expect(new Set(rows.map((row) => row.properties.icalUid)).size).toBe(3);
  });

  it.each([
    ["icalUid", "forged@example.com"],
    ["icalSequence", 9],
  ])("answers a REST PATCH of %s with 403 and leaves the Event unchanged", async (key, value) => {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties: CREATE });
    const item = itemBody.parse(created.body);
    const before = await stored(item.id);
    const response = await rest("PATCH", `/api/items/${item.id}`, {
      properties: { [key]: value },
      ifVersion: item.updatedAt,
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "owner_violation", details: { field: key } } });
    expect(await stored(item.id)).toEqual(before);
  });
});
