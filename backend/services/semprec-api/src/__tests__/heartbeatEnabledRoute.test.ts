import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createHeartbeat,
  createSetHeartbeatEnabledRouteHandler,
  createViewTypeRegistry,
  seedSystem,
  sweepDueHeartbeats,
  withTransaction,
  createUser,
  getHeartbeat,
  hasWaitingHeartbeatFireJob,
  hashPassword,
  login,
  LocalFsBlobStorageWriter,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
describe("heartbeat enabled route", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  it("disables without a provider and fails closed on missing or failed enable provider", async () => {
    await runInTenant(tenant, async () => {
      await seedSystem(runtime, createViewTypeRegistry());
      const cp = createChokePoint(runtime);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
      if (!db) throw new Error("Missing projects database");
      const project = await cp.createItem({ databaseId: db.id, properties: { name: "Project" } });
      const heartbeat = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "User",
          rule: { kind: "interval", minutes: 5 },
          actionId: "noop",
          origin: "user",
        }),
      );
      const handler = createSetHeartbeatEnabledRouteHandler(runtime);
      expect(await handler({ params: { id: heartbeat.id }, body: { enabled: false } })).toEqual({
        status: 200,
        body: { id: heartbeat.id, enabled: false, nextFireAt: null },
      });
      await expect(handler({ params: { id: heartbeat.id }, body: { enabled: true } })).rejects.toThrow(
        "not configured",
      );
      const failure = new Error("registry failure");
      const broken = createSetHeartbeatEnabledRouteHandler(runtime, {
        heartbeatRuleKinds: async () => {
          throw failure;
        },
      });
      await expect(broken({ params: { id: heartbeat.id }, body: { enabled: true } })).rejects.toBe(failure);
      const result = await runtime.query<{ enabled: boolean; next_fire_at: Date | null }>(
        "SELECT enabled, next_fire_at FROM project_heartbeats WHERE id = $1",
        [heartbeat.id],
      );
      expect(result.rows).toEqual([{ enabled: false, next_fire_at: null }]);
      const handlerWithRules = createSetHeartbeatEnabledRouteHandler(runtime, {
        heartbeatRuleKinds: async () => new Map(),
      });
      const beforeEnable = Date.now();
      const enabled = await handlerWithRules({ params: { id: heartbeat.id }, body: { enabled: true } });
      const afterEnable = Date.now();
      expect(enabled.body.enabled).toBe(true);
      const nextFireAt = Date.parse(enabled.body.nextFireAt ?? "");
      expect(nextFireAt).toBeGreaterThanOrEqual(beforeEnable + 5 * 60_000);
      expect(nextFireAt).toBeLessThanOrEqual(afterEnable + 5 * 60_000);
      expect(await hasWaitingHeartbeatFireJob(runtime, heartbeat.id)).toBe(false);
      const event = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "Event",
          rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
          actionId: "noop",
          enabled: false,
          origin: "user",
        }),
      );
      expect(await handlerWithRules({ params: { id: event.id }, body: { enabled: true } })).toEqual({
        status: 200,
        body: { id: event.id, enabled: true, nextFireAt: null },
      });
      const system = await withTransaction(runtime, (client) =>
        createHeartbeat(client, {
          projectItemId: project.id,
          name: "System",
          rule: { kind: "interval", minutes: 5 },
          actionId: "noop",
          origin: "system",
        }),
      );
      await expect(handlerWithRules({ params: { id: system.id }, body: { enabled: false } })).rejects.toMatchObject({
        status: 403,
        code: "owner_violation",
      });
      expect(await withTransaction(runtime, (client) => getHeartbeat(client, system.id))).toEqual(system);
    });
  });

  it("does not queue missed interval fires after re-enabling", async () => {
    await runInTenant(tenant, async () => {
      await seedSystem(runtime, createViewTypeRegistry());
      const cp = createChokePoint(runtime);
      const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
      if (!db) throw new Error("Missing projects database");
      const project = await cp.createItem({ databaseId: db.id, properties: { name: "Project" } });
      // Simulate an old schedule without changing the database clock or waiting for an interval.
      vi.useFakeTimers({ toFake: ["Date"] });
      const heartbeat = await (async () => {
        try {
          vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
          return await withTransaction(runtime, (client) =>
            createHeartbeat(client, {
              projectItemId: project.id,
              name: "Past schedule",
              rule: { kind: "interval", minutes: 5 },
              actionId: "noop",
              origin: "user",
            }),
          );
        } finally {
          vi.useRealTimers();
        }
      })();
      expect(heartbeat.nextFireAt).toBe("2020-01-01T00:05:00.000Z");
      const handler = createSetHeartbeatEnabledRouteHandler(runtime, { heartbeatRuleKinds: async () => new Map() });
      await handler({ params: { id: heartbeat.id }, body: { enabled: false } });
      const enabled = await handler({ params: { id: heartbeat.id }, body: { enabled: true } });
      expect(Date.parse(enabled.body.nextFireAt ?? "")).toBeGreaterThan(Date.now());
      const sweep = await withTransaction(runtime, (client) => sweepDueHeartbeats(client));
      expect(sweep.fired.map((item) => item.id)).not.toContain(heartbeat.id);
      expect(await hasWaitingHeartbeatFireJob(runtime, heartbeat.id)).toBe(false);
    });
  });

  it("uses current module definitions through the actual dispatcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-heartbeat-route-"));
    let server: ReturnType<typeof createServer> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const modulePath = join(directory, "rule.mjs");
      await writeFile(
        modulePath,
        `export const manifest = { id: 'fixtureRule', version: '1.0.0', name: 'Fixture Rule', removable: true, systemProject: false, databases: [], capabilities: [], agentTools: [], heartbeatRuleKinds: [{kind:'fixtureRule.once', schemaExport:'ruleSchema', nextFireAtExport:'nextFireAt'}] };\nexport const ruleSchema = { safeParse: value => ({success:true, data:value}) };\nexport function nextFireAt() { return new Date('2031-01-01T00:00:00.000Z'); }\n`,
      );
      const active = new Set(["schemaCore", "fixtureRule"]);
      const registry = new ModuleRegistry(() => active);
      await registry.loadModule(
        new URL("../../../../packages/data/src/chokePoint/schemaCoreModuleManifest.ts", import.meta.url).href,
      );
      await registry.loadModule(pathToFileURL(modulePath).href);
      const passwordHash = await hashPassword("test-password");
      const user = await runAsSystem("heartbeat test user", () =>
        createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash }),
      );
      const session = await login(admin, {
        email: user.email,
        password: "test-password",
        platform: "ios",
        ip: "127.0.0.1",
      });
      const definitions = await registry.getHeartbeatRuleKindDefinitions();
      const kinds = new Map(
        definitions.map((entry) => [entry.kind, { schema: entry.schema, nextFireAt: entry.nextFireAt }]),
      );
      const heartbeat = await runInTenant(tenant, async () => {
        await seedSystem(runtime, createViewTypeRegistry());
        const cp = createChokePoint(runtime);
        const db = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
        if (!db) throw new Error("Missing projects database");
        const project = await cp.createItem({ databaseId: db.id, properties: { name: "Project" } });
        return withTransaction(runtime, (client) =>
          createHeartbeat(
            client,
            {
              projectItemId: project.id,
              name: "Custom",
              rule: { kind: "fixtureRule.once" },
              actionId: "noop",
              enabled: false,
              origin: "user",
            },
            kinds,
          ),
        );
      });
      const systemHeartbeat = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          createHeartbeat(client, {
            projectItemId: heartbeat.projectItemId,
            name: "System",
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
            origin: "system",
          }),
        ),
      );
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "http://localhost",
        setupToken: "unused",
        moduleRegistry: registry,
        blobStorage: new LocalFsBlobStorageWriter(directory),
        maxFileSizeBytes: 1024,
      });
      server = createServer(dispatch);
      const owned = server;
      await new Promise<void>((resolve, reject) => {
        owned.once("error", reject);
        owned.listen(0, "127.0.0.1", resolve);
      });
      const address = owned.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const patch = (body: unknown, id = heartbeat.id) =>
        fetch(`http://127.0.0.1:${address.port}/api/heartbeats/${id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const enabled = await patch({ enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.headers.get("cache-control")).toBe("no-store");
      expect(await enabled.json()).toEqual({ id: heartbeat.id, enabled: true, nextFireAt: "2031-01-01T00:00:00.000Z" });
      expect((await patch({ enabled: false, name: "unexpected" })).status).toBe(400);
      const systemResponse = await patch({ enabled: false }, systemHeartbeat.id);
      expect(systemResponse.status).toBe(403);
      expect(await systemResponse.json()).toMatchObject({ error: { code: "owner_violation" } });
      expect(
        await runInTenant(tenant, () => withTransaction(runtime, (client) => getHeartbeat(client, systemHeartbeat.id))),
      ).toEqual(systemHeartbeat);
      active.delete("fixtureRule");
      const disabledWithoutProvider = await runInTenant(tenant, () =>
        createSetHeartbeatEnabledRouteHandler(runtime)({ params: { id: heartbeat.id }, body: { enabled: false } }),
      );
      expect(disabledWithoutProvider).toEqual({
        status: 200,
        body: { id: heartbeat.id, enabled: false, nextFireAt: null },
      });
      const disabled = await patch({ enabled: false });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({ id: heartbeat.id, enabled: false, nextFireAt: null });
      expect((await patch({ enabled: true })).status).toBe(500);
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    if (server) {
      const owned = server;
      try {
        await new Promise<void>((resolve, reject) => owned.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (failure && cleanupErrors.length)
      throw new AggregateError([failure.error, ...cleanupErrors], "Heartbeat test and cleanup failed", {
        cause: failure.error,
      });
    if (failure) throw failure.error;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Heartbeat test cleanup failed");
  });
});
