import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentRun,
  createChokePoint,
  createPool,
  createUser,
  finishAgentRunWithErrorNotification,
  insertAndNotifyAgentRunEvent,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  publishSempThreadInvalidation,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createSyncServer,
  publishRealtimeMessage,
  REALTIME_CHANNEL,
  wireRealtimeHooks,
  type RealtimeMessage,
  type SyncServer,
} from "@semprec/realtime";
import { runInTenant } from "@semprec/shared";
import { createAgentRunTask } from "../agentRunTasks.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";

let adminPool: Pool;
let agentsPool: Pool;
let listener: PoolClient | undefined;

/** A `semprec_events` payload as the publisher builds it: the publisher's tenant and the message. */
interface RealtimeEnvelope<M> {
  tenantId: string | null;
  message: M;
}

/** Collects every parsed envelope NOTIFYed on the realtime channel to `client`. */
async function collectEnvelopes(client: PoolClient): Promise<RealtimeEnvelope<RealtimeMessage>[]> {
  const envelopes: RealtimeEnvelope<RealtimeMessage>[] = [];
  client.on("notification", (notification) => {
    if (notification.channel !== REALTIME_CHANNEL) return;
    envelopes.push(JSON.parse(notification.payload ?? "null") as RealtimeEnvelope<RealtimeMessage>);
  });
  await client.query(`LISTEN ${REALTIME_CHANNEL}`);
  return envelopes;
}

/** Polls until `check` holds; NOTIFY delivery is asynchronous to the writing call. */
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}

describe("semprec-agents realtime wiring (issue #1383)", () => {
  beforeEach(async () => {
    adminPool ??= getTestPool();
    agentsPool ??= createPool(process.env.TEST_DATABASE_URL!);
    await resetDatabase(adminPool);
    await runInTenant(getTenantZeroId(), () => seedSystem(agentsPool));
    // The same wiring call `serve.ts` makes over the agents process's own pool.
    wireRealtimeHooks(agentsPool);
    listener = await adminPool.connect();
  });

  afterEach(() => {
    listener?.release(true);
    listener = undefined;
  });

  afterAll(async () => {
    await agentsPool?.end();
    await adminPool?.end();
  });

  it("publishes an item invalidation of the writing tenant from a choke-point write, and no other tenant's", async () => {
    const tenantId = getTenantZeroId();
    const otherTenantId = await createTestTenant(adminPool);
    const envelopes = await collectEnvelopes(listener!);

    const item = await runInTenant(tenantId, async () => {
      const { rows } = await agentsPool.query<{ id: string }>(
        `SELECT id FROM databases WHERE owner_module_id = 'projects'`,
      );
      return createChokePoint(agentsPool).createItem({ databaseId: rows[0]!.id, properties: {} });
    });

    await waitUntil(() =>
      envelopes.some((e) => e.message.type === "invalidation" && "itemId" in e.message && e.message.itemId === item.id),
    );
    const matching = envelopes.filter(
      (e) => e.message.type === "invalidation" && "itemId" in e.message && e.message.itemId === item.id,
    );
    expect(matching.length).toBeGreaterThan(0);
    for (const envelope of matching) {
      expect(envelope.tenantId).toBe(tenantId);
      expect(envelope.message).toMatchObject({ type: "invalidation", scope: "item", op: "create" });
    }
    // The listener-side tenant filter the socket fan-out applies matches only the writing tenant.
    expect(envelopes.filter((e) => e.tenantId === otherTenantId)).toEqual([]);
  });

  it("publishes a runtime-role write for its tenant while refusing the other tenant's database", async () => {
    const tenantId = getTenantZeroId();
    const otherTenantId = await createTestTenant(adminPool);
    const envelopes = await collectEnvelopes(listener!);
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      wireRealtimeHooks(runtimePool);
      const { rows } = await runInTenant(tenantId, () =>
        runtimePool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'"),
      );
      expect(rows).toHaveLength(1);
      const databaseId = rows[0]!.id;
      const item = await runInTenant(tenantId, () =>
        createChokePoint(runtimePool).createItem({ databaseId, properties: {} }),
      );
      await waitUntil(() =>
        envelopes.some(
          (e) => e.message.type === "invalidation" && "itemId" in e.message && e.message.itemId === item.id,
        ),
      );
      const countItems = () =>
        runInTenant(tenantId, () =>
          runtimePool.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE database_id = $1", [
            databaseId,
          ]),
        );
      const beforeRefusal = (await countItems()).rows[0]!.count;
      await expect(
        runInTenant(otherTenantId, () => createChokePoint(runtimePool).createItem({ databaseId, properties: {} })),
      ).rejects.toThrow();
      expect((await countItems()).rows[0]!.count).toBe(beforeRefusal);
      const visible = await runInTenant(otherTenantId, () =>
        runtimePool.query<{ id: string }>("SELECT id FROM items WHERE id = $1", [item.id]),
      );
      expect(visible.rows).toEqual([]);
      const published = envelopes.filter(
        (e) => e.message.type === "invalidation" && "itemId" in e.message && e.message.itemId === item.id,
      );
      expect(published).toHaveLength(1);
      expect(published[0]!.tenantId).toBe(tenantId);
    } finally {
      wireRealtimeHooks(agentsPool);
      await runtimePool.end();
    }
  });

  it("publishes an agent_run_event for an event inserted by an agent run", async () => {
    const tenantId = getTenantZeroId();
    const envelopes = await collectEnvelopes(listener!);

    const event = await runInTenant(tenantId, async () => {
      await createUser(agentsPool, { email: "owner@example.test", passwordHash: "unused", tenantId });
      const run = await createAgentRun(agentsPool, { triggeredBy: "heartbeat", task: "publish me" });
      return insertAndNotifyAgentRunEvent(agentsPool, run.id, "turn_start", { kind: "turn_start" });
    });

    await waitUntil(() => envelopes.some((e) => e.message.type === "agent_run_event"));
    const published = envelopes.find((e) => e.message.type === "agent_run_event")!;
    expect(published.tenantId).toBe(tenantId);
    expect(published.message).toMatchObject({ type: "agent_run_event", eventId: String(event.id) });
  });

  it("delivers the agents item write to its tenant socket and not another tenant socket", async () => {
    const tenantId = getTenantZeroId();
    const otherTenantId = await createTestTenant(adminPool);
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    const server = createServer();
    let sync: SyncServer | undefined;
    let owner: WebSocket | undefined;
    let other: WebSocket | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const ownerUser = await runInTenant(tenantId, () =>
        createUser(runtimePool, { email: "socket-owner@example.test", passwordHash: "unused", tenantId }),
      );
      sync = await createSyncServer(runtimePool, {
        authenticate: async (req) => {
          const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
          if (token === "owner") return { tenantId, userId: ownerUser.id, sessionId: "owner" };
          if (token === "other") return { tenantId: otherTenantId, userId: randomUUID(), sessionId: "other" };
          return null;
        },
        revalidateSession: async () => true,
      });
      const runningSync = sync;
      server.on("upgrade", (req, socket, head) => runningSync.handleUpgrade(req, socket, head));
      await new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        controller.signal.addEventListener("abort", () => reject(new Error("Socket server startup timed out")), {
          once: true,
        });
        const onError = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        server.once("error", onError);
        server.listen({ port: 0, host: "127.0.0.1", signal: controller.signal }, () => {
          clearTimeout(timer);
          server.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing socket server address");
      owner = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync?token=owner`);
      other = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync?token=other`);
      const clients = [owner, other];
      const opened = await Promise.allSettled(
        clients.map(
          (client) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Socket open timed out")), 3000);
              client.addEventListener(
                "open",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
              client.addEventListener(
                "error",
                () => {
                  clearTimeout(timer);
                  reject(new Error("Socket open failed"));
                },
                { once: true },
              );
            }),
        ),
      );
      const openErrors: unknown[] = opened.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (openErrors.length) throw new AggregateError(openErrors, "Socket open failed");
      const ownFrames: unknown[] = [];
      const otherFrames: unknown[] = [];
      owner.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const parsed: unknown = JSON.parse(event.data);
          ownFrames.push(parsed);
        }
      });
      other.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const parsed: unknown = JSON.parse(event.data);
          otherFrames.push(parsed);
        }
      });
      wireRealtimeHooks(runtimePool);
      const cp = createChokePoint(runtimePool);
      const database = await runInTenant(tenantId, () => cp.createDatabase({ name: "Agent socket evidence" }));
      await runInTenant(tenantId, () =>
        cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" }),
      );
      const target = await runInTenant(tenantId, () =>
        cp.createItem({ databaseId: database.id, properties: { name: "approval target" } }),
      );
      const projects = await runInTenant(tenantId, () =>
        withTransaction(runtimePool, (client) =>
          client.query<{ id: string }>("SELECT id FROM items WHERE properties->>'name' = 'Semprec'"),
        ),
      );
      if (projects.rows.length !== 1) throw new Error("Missing Semprec project");
      const run = await runInTenant(tenantId, () =>
        createAgentRun(runtimePool, {
          projectItemId: projects.rows[0]!.id,
          triggeredBy: "user",
          task: "socket evidence",
        }),
      );
      await runInTenant(tenantId, () => insertAgentRunEvent(runtimePool, run.id, "turn_start", { kind: "turn_start" }));
      owner.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await waitUntil(() =>
        ownFrames.some(
          (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "agent:event",
        ),
      );
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              "item_create",
              { databaseId: database.id, properties: { name: "socket-created" } },
              { id: "create-call" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("item_delete", { itemId: target.id }, { id: "delete-call" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      const gateway = {
        model: faux.getModel(),
        streamFn: faux.provider.streamSimple.bind(faux.provider),
        isBudgetRefusal: () => false,
      };
      const registry = await loadFullModuleRegistry();
      await runInTenant(tenantId, () =>
        createAgentRunTask(
          runtimePool,
          registry,
          gateway,
          createInFlightAgentRuns(),
        )({ agentRunId: run.id }, { job: { id: "socket" } }),
      );
      const created = await runInTenant(tenantId, () =>
        withTransaction(runtimePool, (client) =>
          client.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = 'socket-created'",
            [database.id],
          ),
        ),
      );
      expect(created.rows).toHaveLength(1);
      const item = created.rows[0]!;
      const requests = await runInTenant(tenantId, () =>
        withTransaction(runtimePool, (client) =>
          client.query<{ id: string }>(
            "SELECT id FROM approval_requests WHERE agent_run_id = $1 AND tool_call_id = 'delete-call'",
            [run.id],
          ),
        ),
      );
      expect(requests.rows).toHaveLength(1);
      const requestId = requests.rows[0]!.id;
      await waitUntil(() =>
        ownFrames.some(
          (frame) => typeof frame === "object" && frame !== null && "itemId" in frame && frame.itemId === item.id,
        ),
      );
      await waitUntil(() =>
        ownFrames.some(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "notification" &&
            "notification" in frame &&
            typeof frame.notification === "object" &&
            frame.notification !== null &&
            "sourceId" in frame.notification &&
            frame.notification.sourceId === requestId,
        ),
      );
      expect(
        ownFrames.filter(
          (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "agent:event",
        ).length,
      ).toBeGreaterThan(1);
      await waitUntil(() =>
        ownFrames.some(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "agent:event" &&
            "event" in frame &&
            typeof frame.event === "object" &&
            frame.event !== null &&
            "payload" in frame.event &&
            typeof frame.event.payload === "object" &&
            frame.event.payload !== null &&
            "toolCallId" in frame.event.payload &&
            frame.event.payload.toolCallId === "delete-call",
        ),
      );
      const sentinel = randomUUID();
      await runInTenant(otherTenantId, () =>
        publishRealtimeMessage(runtimePool, { type: "invalidation", scope: "schema", databaseId: sentinel }),
      );
      await waitUntil(() =>
        otherFrames.some(
          (frame) =>
            typeof frame === "object" && frame !== null && "databaseId" in frame && frame.databaseId === sentinel,
        ),
      );
      expect(ownFrames).toContainEqual(expect.objectContaining({ type: "invalidate", scope: "item", itemId: item.id }));
      expect(otherFrames).toEqual([{ type: "invalidate", scope: "schema", databaseId: sentinel }]);
    } catch (error) {
      failure = { error };
    }
    owner?.close();
    other?.close();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        await sync?.close();
      },
      async () => {
        if (server.listening)
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      },
      () => runtimePool.end(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    wireRealtimeHooks(agentsPool);
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Socket test cleanup failed",
      );
    if (failure) throw failure.error;
  });

  it("publishes the notification created when an agent run fails", async () => {
    const tenantId = getTenantZeroId();
    const otherTenantId = await createTestTenant(adminPool);
    const envelopes = await collectEnvelopes(listener!);
    const { userId, notificationId } = await runInTenant(tenantId, async () => {
      const user = await createUser(agentsPool, { email: "owner@example.test", passwordHash: "unused", tenantId });
      const run = await createAgentRun(agentsPool, { triggeredBy: "heartbeat", task: "fail" });
      await withTransaction(agentsPool, (client) =>
        finishAgentRunWithErrorNotification(client, run.id, "failed", "interrupted"),
      );
      const { rows } = await agentsPool.query<{ id: string }>(
        "SELECT id FROM notifications WHERE source_table = 'agent_runs' AND source_id = $1",
        [run.id],
      );
      expect(rows).toHaveLength(1);
      return { userId: user.id, notificationId: rows[0]!.id };
    });

    await waitUntil(() =>
      envelopes.some((e) => e.message.type === "notification_created" && e.message.notificationId === notificationId),
    );
    const published = envelopes.filter(
      (e) => e.message.type === "notification_created" && e.message.notificationId === notificationId,
    );
    expect(published).toEqual([{ tenantId, message: { type: "notification_created", userId, notificationId } }]);
    expect(published.filter((e) => e.tenantId === otherTenantId)).toEqual([]);
  });

  it("publishes a sempThread invalidation of the given tenant after commit from an agents-style write (issue #1395)", async () => {
    const tenantId = getTenantZeroId();
    const otherTenantId = await createTestTenant(adminPool);
    const envelopes = await collectEnvelopes(listener!);
    const rolledBackThreadId = randomUUID();
    const threadId = randomUUID();

    await runInTenant(tenantId, async () => {
      await expect(
        withTransaction(agentsPool, async (client) => {
          publishSempThreadInvalidation(client, tenantId, rolledBackThreadId);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      await withTransaction(agentsPool, async (client) => {
        publishSempThreadInvalidation(client, tenantId, threadId);
      });
    });

    await waitUntil(() => envelopes.some((e) => e.message.type === "invalidation" && e.message.scope === "sempThread"));
    const published = envelopes.filter((e) => e.message.type === "invalidation" && e.message.scope === "sempThread");
    expect(published.map((e) => e.message)).toEqual([{ type: "invalidation", scope: "sempThread", threadId }]);
    expect(published[0]!.tenantId).toBe(tenantId);
    expect(envelopes.filter((e) => e.tenantId === otherTenantId)).toEqual([]);
  });

  it("serve.ts wires the hooks after the runtime role check and before the queue runtime exists", () => {
    const source = readFileSync(new URL("../serve.ts", import.meta.url), "utf8");
    const roleCheck = source.indexOf("await assertRuntimeRole(pool)");
    const wiring = source.indexOf("wireRealtimeHooks(pool);");
    const queueRuntime = source.indexOf("await createAgentsQueueRuntime(");
    expect(roleCheck).toBeGreaterThan(-1);
    expect(wiring).toBeGreaterThan(roleCheck);
    expect(queueRuntime).toBeGreaterThan(wiring);
  });
});
