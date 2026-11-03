import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createAgentRun,
  createChokePoint,
  createPool,
  createUser,
  finishAgentRunWithErrorNotification,
  insertAndNotifyAgentRunEvent,
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
import { REALTIME_CHANNEL, wireRealtimeHooks, type RealtimeMessage } from "@semprec/realtime";
import { runInTenant } from "@semprec/shared";

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
