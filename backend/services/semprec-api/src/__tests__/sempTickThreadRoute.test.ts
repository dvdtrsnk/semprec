import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getOrCreateTickThread,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createSempChatThread,
  createUser,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

const PASSWORD = "tick-thread-password";

/** A tenant with a user and a seeded system, and that user's bearer header. */
async function tenantSession(): Promise<{ tenant: string; headers: { Authorization: string } }> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  return { tenant, headers: { Authorization: `Bearer ${session.token}` } };
}

describe("GET /api/semp/threads/:id for a tick thread (issue #1562)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-tick-test-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });

  it("returns the heartbeat header and active run of a tick thread, neither for a chat thread, and 404 across tenants", async () => {
    const owner = await tenantSession();
    const other = await tenantSession();
    const fixture = await runInTenant(owner.tenant, async () => {
      const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      const project = await createChokePoint(pool).createItem({
        databaseId: projects!.id,
        properties: { name: "Weekly review" },
      });
      return withTransaction(pool, async (client) => {
        const heartbeat = await createHeartbeat(client, {
          projectItemId: project.id,
          name: "Sunday planning",
          rule: { kind: "weekly", days: ["sun"], at: "21:00" },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "Plan the week" },
        });
        const tick = await getOrCreateTickThread(client, heartbeat.id);
        const chat = await createSempChatThread(client);
        return { projectId: project.id, heartbeatId: heartbeat.id, tickId: tick.id, chatId: chat };
      });
    });

    const read = (id: string, headers: { Authorization: string }) =>
      fetch(`${baseUrl}/api/semp/threads/${id}`, { headers });

    const idle = await read(fixture.tickId, owner.headers);
    expect(idle.status).toBe(200);
    expect(await idle.json()).toMatchObject({
      id: fixture.tickId,
      kind: "tick",
      heartbeat: {
        id: fixture.heartbeatId,
        name: "Sunday planning",
        rule: { kind: "weekly", days: ["sun"], at: "21:00" },
        enabled: true,
        projectItemId: fixture.projectId,
        projectName: "Weekly review",
        canTrigger: true,
      },
      activeRun: null,
    });

    const run = await runInTenant(owner.tenant, () =>
      createAgentRun(pool, {
        projectItemId: fixture.projectId,
        heartbeatId: fixture.heartbeatId,
        threadId: fixture.tickId,
        triggeredBy: "heartbeat",
        task: "Plan the week",
      }),
    );
    const running = await read(fixture.tickId, owner.headers);
    expect(await running.json()).toMatchObject({ activeRun: { agentRunId: run.id, startedAt: run.startedAt } });

    const chat = await read(fixture.chatId, owner.headers);
    expect(chat.status).toBe(200);
    const chatBody: unknown = await chat.json();
    expect(chatBody).toMatchObject({ id: fixture.chatId, kind: "chat" });
    expect(chatBody).not.toHaveProperty("heartbeat");
    expect(chatBody).not.toHaveProperty("activeRun");

    const foreign = await read(fixture.tickId, other.headers);
    const missing = await read(randomUUID(), other.headers);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});
