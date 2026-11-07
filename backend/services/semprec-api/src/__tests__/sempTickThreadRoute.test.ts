import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleRegistry } from "@semprec/module-registry";
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
  resolveModuleRuleKinds,
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

describe("GET /api/semp/threads/:id with a module-declared heartbeat rule (issue #1562)", () => {
  it("returns the header while the declaring module is active and refuses it once the module is inactive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-tick-route-rule-"));
    let routeServer: Server | undefined;
    let routePool: Pool | undefined;
    const routeAdmin = getTestPool();
    try {
      await resetDatabase(routeAdmin);
      routePool = await createRuntimeRolePool(routeAdmin, "semprec_data");
      const modulePath = join(directory, "rule.mjs");
      await writeFile(
        modulePath,
        `export const manifest = { id: 'fixtureRule', version: '1.0.0', name: 'Fixture Rule', removable: true, systemProject: false, databases: [], capabilities: [], agentTools: [], heartbeatRuleKinds: [{ kind: 'fixtureRule.once', schemaExport: 'ruleSchema', nextFireAtExport: 'nextFireAt' }] };\nexport const ruleSchema = { safeParse: (value) => ({ success: true, data: value }) };\nexport function nextFireAt() { return new Date('2031-01-01T00:00:00.000Z'); }\n`,
      );
      const active = new Set(["schemaCore", "fixtureRule"]);
      const registry = new ModuleRegistry(() => active);
      await registry.loadModule(
        new URL("../../../../packages/data/src/chokePoint/schemaCoreModuleManifest.ts", import.meta.url).href,
      );
      await registry.loadModule(pathToFileURL(modulePath).href);
      const dispatch = await createDispatcher(routePool, {
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "https://example.test",
        setupToken: "test",
        moduleRegistry: registry,
        blobStorage: new LocalFsBlobStorageWriter(join(directory, "blobs")),
        maxFileSizeBytes: 1024,
      });
      routeServer = createServer(dispatch);
      await new Promise<void>((resolve) => routeServer!.listen(0, "127.0.0.1", resolve));
      const address = routeServer.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const tenant = await createTestTenant(routeAdmin);
      const email = `${randomUUID()}@example.test`;
      await createUser(routeAdmin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
      const session = await login(routeAdmin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      const rule = { kind: "fixtureRule.once", at: "2031-01-01" };
      const fixture = await runInTenant(tenant, async () => {
        await seedSystem(routePool!, createViewTypeRegistry());
        const projects = await withTransaction(routePool!, (client) => getDatabaseByModuleId(client, "projects"));
        const project = await createChokePoint(routePool!).createItem({
          databaseId: projects!.id,
          properties: { name: "Module review" },
        });
        const kinds = await resolveModuleRuleKinds(registry);
        return withTransaction(routePool!, async (client) => {
          const heartbeat = await createHeartbeat(
            client,
            {
              projectItemId: project.id,
              name: "Module rule",
              rule,
              actionId: CORE_AGENT_RUN_ACTION_ID,
              actionConfig: { task: "Run the module rule" },
            },
            kinds,
          );
          const tick = await getOrCreateTickThread(client, heartbeat.id);
          return { heartbeatId: heartbeat.id, tickId: tick.id };
        });
      });
      const read = () =>
        fetch(`http://127.0.0.1:${address.port}/api/semp/threads/${fixture.tickId}`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });

      const shown = await read();
      expect(shown.status).toBe(200);
      expect(await shown.json()).toMatchObject({
        kind: "tick",
        heartbeat: { id: fixture.heartbeatId, name: "Module rule", rule, canTrigger: true },
        activeRun: null,
      });

      // The registry is resolved per request: once the module is inactive its rule kind is unknown.
      active.delete("fixtureRule");
      const refused = await read();
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({ error: { code: "internal_error" } });
    } finally {
      if (routeServer) await new Promise<void>((resolve) => routeServer!.close(() => resolve()));
      await routePool?.end();
      await routeAdmin.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
