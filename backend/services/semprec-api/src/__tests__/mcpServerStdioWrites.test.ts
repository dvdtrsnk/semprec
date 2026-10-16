import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createAgentRun,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
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

const STDIO_CONFIG = { transport: "stdio", command: "my-mcp-server" };
const REMOTE_CONFIG = { transport: "http", url: "https://mcp.example.com/mcp" };

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

async function storedConfig(id: string): Promise<unknown> {
  const { rows } = await pool.query("SELECT properties FROM items WHERE id = $1", [id]);
  return rows[0].properties.connectionConfig;
}

describe("stdio MCP servers are confined to a human admin (issue #1030)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let userId: string;
  let agentActor: AuthenticatedActor;
  const gateway = () => createGenericOperationGateway(pool);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  const setRole = (role: "admin" | "member") => pool.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'mcpServers'`);
    mcpServersId = rows[0]!.id;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      role: "admin",
    });
    userId = user.id;
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "connect a server" });
    agentActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };

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

  const restCreate = (connectionConfig: unknown) =>
    fetch(`${baseUrl}/api/databases/${mcpServersId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties: { name: "S", connectionConfig } }),
    });

  const restPatch = (item: { id: string; updatedAt: string }, connectionConfig: unknown) =>
    fetch(`${baseUrl}/api/items/${item.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { connectionConfig }, ifVersion: item.updatedAt }),
    });

  async function mcpCreate(connectionConfig: unknown) {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers,
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
    return (await res.json()) as { result?: unknown; error?: { message?: string; data?: { field?: string } } };
  }

  // The REST error body carries `{ error: { code, details } }` and no message.
  async function expectRestRefusal(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { field: string } } };
    expect(body).toEqual({ error: { code: "validation_failed", details: { field: "connectionConfig" } } });
  }

  it("lets an admin human store a stdio config over REST", async () => {
    const res = await restCreate(STDIO_CONFIG);
    expect(res.status).toBe(201);
    expect(await itemCount()).toBe(1);
  });

  it("lets an admin human switch a server to stdio over REST PATCH", async () => {
    const seeded = await seedServer(REMOTE_CONFIG);
    const res = await restPatch(seeded, STDIO_CONFIG);
    expect(res.status).toBe(200);
    expect(await storedConfig(seeded.id)).toEqual(STDIO_CONFIG);
  });

  it("refuses a REST-session actor that is acting for an agent", async () => {
    const actor: AuthenticatedActor = { ...agentActor, userId, restSession: true };
    await expect(
      gateway().invoke("item.create", actor, new Set(CAPABILITY_IDS), {
        databaseId: mcpServersId,
        properties: { name: "S", connectionConfig: STDIO_CONFIG },
      }),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await itemCount()).toBe(0);
  });

  it("refuses every other writer with the same message and writes nothing", async () => {
    const adminMessage = "A stdio MCP server can only be configured by an administrator";

    await setRole("member");
    await expectRestRefusal(await restCreate(STDIO_CONFIG));
    expect(await itemCount()).toBe(0);

    const seeded = await seedServer(REMOTE_CONFIG);
    await expectRestRefusal(await restPatch(seeded, STDIO_CONFIG));
    expect(await storedConfig(seeded.id)).toEqual(REMOTE_CONFIG);

    await setRole("admin");
    let agentError: unknown;
    try {
      await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
        databaseId: mcpServersId,
        properties: { name: "S", connectionConfig: STDIO_CONFIG },
      });
    } catch (err) {
      agentError = err;
    }
    expect(agentError).toMatchObject({ name: "ValidationError", details: { field: "connectionConfig" } });

    const mcp = await mcpCreate(STDIO_CONFIG);
    expect(mcp.result).toBeUndefined();
    expect(mcp.error?.data?.field).toBe("connectionConfig");

    expect(await itemCount()).toBe(1); // only the seeded row
    expect((agentError as Error).message).toBe(adminMessage);
    expect(mcp.error?.message).toBe(adminMessage);
  });

  it("refuses an admin's agent-acted item.patch to stdio", async () => {
    const seeded = await seedServer(REMOTE_CONFIG);
    await expect(
      gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
        itemId: seeded.id,
        properties: { connectionConfig: STDIO_CONFIG },
        ifVersion: seeded.updatedAt,
      }),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await storedConfig(seeded.id)).toEqual(REMOTE_CONFIG);
  });

  it("accepts a remote config from a member, an agent and an /mcp client", async () => {
    await setRole("member");
    expect((await restCreate(REMOTE_CONFIG)).status).toBe(201);
    const created = await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
      databaseId: mcpServersId,
      properties: { name: "S", connectionConfig: REMOTE_CONFIG },
    });
    expect(created.id).toBeDefined();
    expect((await mcpCreate(REMOTE_CONFIG)).error).toBeUndefined();
  });
});
