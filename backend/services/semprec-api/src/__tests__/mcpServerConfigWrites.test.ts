import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestProjectItem, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createAgentRun,
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

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const GOOD_CONFIG = { transport: "http", url: "https://mcp.example.com/mcp" };
const REFUSED_CONFIGS: Array<[string, unknown]> = [
  ["plain http", { transport: "http", url: "http://mcp.example.com/mcp" }],
  ["IP literal", { transport: "http", url: "https://127.0.0.1/mcp" }],
  ["localhost", { transport: "sse", url: "https://localhost/mcp" }],
  ["userinfo", { transport: "http", url: "https://user:pw@mcp.example.com/" }],
  ["explicit port", { transport: "http", url: "https://mcp.example.com:8443/" }],
  ["malformed shape", { transport: "carrier-pigeon" }],
];

let pool: Pool;
let mcpServersId: string;

async function itemCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
    [mcpServersId],
  );
  return Number(rows[0]!.count);
}

async function seedServer(connectionConfig: unknown): Promise<{ id: string; updatedAt: string }> {
  const { rows } = await pool.query<{ id: string; updated_at: Date }>(
    "INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb) RETURNING id, updated_at",
    [randomUUID(), mcpServersId, JSON.stringify({ name: "Seeded", connectionConfig })],
  );
  return { id: rows[0]!.id, updatedAt: rows[0]!.updated_at.toISOString() };
}

describe("mcpServers connectionConfig on every write path (issue #1029)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let mcpToken: string;
  let agentActor: AuthenticatedActor;
  const gateway = () => createGenericOperationGateway(pool);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'mcpServers'`);
    mcpServersId = rows[0]!.id;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "connect a server" });
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
    mcpServer = createServer(createMcpRequestListener(pool, gateway(), new Set(CAPABILITY_IDS)));
    mcpUrl = await listen(mcpServer);
  });

  afterEach(async () => {
    await Promise.all([server, mcpServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function restCreate(connectionConfig: unknown) {
    return fetch(`${baseUrl}/api/databases/${mcpServersId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties: { name: "S", connectionConfig } }),
    });
  }

  async function restPatch(item: { id: string; updatedAt: string }, connectionConfig: unknown) {
    return fetch(`${baseUrl}/api/items/${item.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { connectionConfig }, ifVersion: item.updatedAt }),
    });
  }

  async function mcpCreate(connectionConfig: unknown) {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "semprec.item.create",
          arguments: { databaseId: mcpServersId, properties: { name: "S", connectionConfig } },
        },
      }),
    });
    return (await res.json()) as { result?: unknown; error?: { data?: { field?: string } } };
  }

  async function expectGatewayRefusal(promise: Promise<unknown>): Promise<void> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "ValidationError", details: { field: "connectionConfig" } });
  }

  describe.each(REFUSED_CONFIGS)("refuses %s", (_label, config) => {
    it("on REST create", async () => {
      const res = await restCreate(config);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: { field: string } } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details.field).toBe("connectionConfig");
      expect(await itemCount()).toBe(0);
    });

    it("on REST PATCH, leaving the row unchanged", async () => {
      const seeded = await seedServer(GOOD_CONFIG);
      const res = await restPatch(seeded, config);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: { field: string } } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details.field).toBe("connectionConfig");
      const { rows } = await pool.query("SELECT properties FROM items WHERE id = $1", [seeded.id]);
      expect(rows[0].properties.connectionConfig).toEqual(GOOD_CONFIG);
    });

    it("on item.create and item.patch through the gateway with an agent actor", async () => {
      await expectGatewayRefusal(
        gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
          databaseId: mcpServersId,
          properties: { name: "S", connectionConfig: config },
        }),
      );
      expect(await itemCount()).toBe(0);

      const seeded = await seedServer(GOOD_CONFIG);
      await expectGatewayRefusal(
        gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
          itemId: seeded.id,
          properties: { connectionConfig: config },
          ifVersion: seeded.updatedAt,
        }),
      );
      const { rows } = await pool.query("SELECT properties FROM items WHERE id = $1", [seeded.id]);
      expect(rows[0].properties.connectionConfig).toEqual(GOOD_CONFIG);
    });

    it("on semprec.item.create over /mcp", async () => {
      const body = await mcpCreate(config);
      expect(body.result).toBeUndefined();
      expect(body.error?.data?.field).toBe("connectionConfig");
      expect(await itemCount()).toBe(0);
    });
  });

  describe("accepts a baseline remote config", () => {
    it("on REST create and PATCH", async () => {
      expect((await restCreate(GOOD_CONFIG)).status).toBe(201);
      const seeded = await seedServer({ transport: "sse", url: "https://mcp.example.com/sse" });
      expect((await restPatch(seeded, GOOD_CONFIG)).status).toBe(200);
    });

    it("through the gateway and over /mcp", async () => {
      const created = await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
        databaseId: mcpServersId,
        properties: { name: "S", connectionConfig: GOOD_CONFIG },
      });
      const seeded = await seedServer({ transport: "sse", url: "https://mcp.example.com/sse" });
      await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
        itemId: seeded.id,
        properties: { connectionConfig: GOOD_CONFIG },
        ifVersion: seeded.updatedAt,
      });
      expect(created.id).toBeDefined();
      expect((await mcpCreate(GOOD_CONFIG)).error).toBeUndefined();
    });
  });
});
