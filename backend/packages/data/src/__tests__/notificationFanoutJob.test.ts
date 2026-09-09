import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { writeNotification } from "../notifications/notify.js";
import { handleNotificationFanoutTask, notificationFanoutJobKey } from "../notifications/notificationFanoutJob.js";
import { upsertApnsSubscription, upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import type { PushSenders } from "../push/pushSenders.js";

let pool: Pool;

async function createTestUser(): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, { email: `${Math.random()}@example.test`, passwordHash });
  return user.id;
}

async function writeTestNotification(userId: string, sourceId: string): Promise<string> {
  await withTransaction(pool, (client) =>
    writeNotification(client, {
      userId,
      kind: "heartbeat_error",
      titleParams: { name: "Daily digest" },
      linkHref: "?page=heartbeats",
      sourceTable: "project_heartbeats",
      sourceId,
      transitionInstance: "job-1",
    }),
  );
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM notifications WHERE source_id = $1`, [sourceId]);
  return rows[0]!.id;
}

interface FanoutJobRow {
  key: string;
  payload: { notificationId: string };
}

async function fanoutJobs(): Promise<FanoutJobRow[]> {
  const { rows } = await pool.query<FanoutJobRow>(
    `SELECT j.key, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'notificationFanout'`,
  );
  return rows;
}

describe("notificationFanout job (issue #151)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enqueues one notification-level fanout job when writeNotification actually inserts a row", async () => {
    const userId = await createTestUser();
    const notificationId = await writeTestNotification(userId, "hb-fanout-enqueue");

    const jobs = await fanoutJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.key).toBe(notificationFanoutJobKey(notificationId));
    expect(jobs[0]!.payload).toEqual({ notificationId });
  });

  it("does not enqueue a second job when the same transition replays", async () => {
    const userId = await createTestUser();
    const write = () =>
      withTransaction(pool, (client) =>
        writeNotification(client, {
          userId,
          kind: "heartbeat_error",
          titleParams: { name: "Replay" },
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-fanout-replay",
          transitionInstance: "job-1",
        }),
      );
    await write();
    await write();

    const jobs = await fanoutJobs();
    expect(jobs).toHaveLength(1);
  });

  it("dispatches to every active registration and marks each delivered", async () => {
    const userId = await createTestUser();
    const webPush = await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-1",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const apns = await upsertApnsSubscription(pool, {
      userId,
      sessionId: null,
      platform: "ios",
      deviceToken: "device-token-1",
      apnsEnvironment: "sandbox",
    });

    const notificationId = await writeTestNotification(userId, "hb-fanout-dispatch");

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const sendApns = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const senders: PushSenders = { sendWebPush, sendApns };

    await handleNotificationFanoutTask(pool, { notificationId }, senders);

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(sendWebPush).toHaveBeenCalledWith(
      { endpoint: "https://push.example/web-1", p256dh: "p256dh-key", authSecret: "auth-secret" },
      { notificationId, title: expect.any(String), linkHref: "?page=heartbeats" },
    );
    expect(sendApns).toHaveBeenCalledTimes(1);
    expect(sendApns).toHaveBeenCalledWith(
      { deviceToken: "device-token-1", apnsEnvironment: "sandbox" },
      { notificationId, title: expect.any(String), linkHref: "?page=heartbeats" },
    );

    const { rows } = await pool.query(
      `SELECT push_subscription_id, delivered_at FROM push_deliveries WHERE notification_id = $1`,
      [notificationId],
    );
    expect(rows).toHaveLength(2);
    const deliveredIds = rows.filter((row) => row.delivered_at !== null).map((row) => row.push_subscription_id);
    expect(deliveredIds.sort()).toEqual([webPush.id, apns.id].sort());
  });

  it("never dispatches an already-revoked registration", async () => {
    const userId = await createTestUser();
    await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-revoked",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    await pool.query(`UPDATE push_subscriptions SET revoked_at = now() WHERE endpoint = $1`, [
      "https://push.example/web-revoked",
    ]);

    const notificationId = await writeTestNotification(userId, "hb-fanout-revoked");
    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const sendApns = vi.fn().mockResolvedValue({ outcome: "delivered" });

    await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns });

    expect(sendWebPush).not.toHaveBeenCalled();
    const { rows } = await pool.query(`SELECT id FROM push_deliveries WHERE notification_id = $1`, [notificationId]);
    expect(rows).toHaveLength(0);
  });

  it("never resends a pair that already delivered, across job retries", async () => {
    const userId = await createTestUser();
    await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-idempotent",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const notificationId = await writeTestNotification(userId, "hb-fanout-idempotent");

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const sendApns = vi.fn();
    const senders: PushSenders = { sendWebPush, sendApns };

    await handleNotificationFanoutTask(pool, { notificationId }, senders);
    await handleNotificationFanoutTask(pool, { notificationId }, senders); // simulated job retry

    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("retries only the still-pending registration after a transient failure, leaving the delivered one alone", async () => {
    const userId = await createTestUser();
    await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-ok",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    await upsertApnsSubscription(pool, {
      userId,
      sessionId: null,
      platform: "ios",
      deviceToken: "device-token-flaky",
      apnsEnvironment: "sandbox",
    });
    const notificationId = await writeTestNotification(userId, "hb-fanout-transient");

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const sendApns = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "transient-failure", error: "network blip" })
      .mockResolvedValueOnce({ outcome: "delivered" });
    const senders: PushSenders = { sendWebPush, sendApns };

    await expect(handleNotificationFanoutTask(pool, { notificationId }, senders)).rejects.toThrow(/transient/);
    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(sendApns).toHaveBeenCalledTimes(1);

    await handleNotificationFanoutTask(pool, { notificationId }, senders);
    expect(sendWebPush).toHaveBeenCalledTimes(1); // already delivered — never dispatched again
    expect(sendApns).toHaveBeenCalledTimes(2); // the still-pending registration is retried
  });

  it("revokes only the reported registration on a permanent failure and never retries it", async () => {
    const userId = await createTestUser();
    const dead = await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-dead",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const alive = await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-alive",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const notificationId = await writeTestNotification(userId, "hb-fanout-permanent");

    const sendWebPush = vi
      .fn()
      .mockImplementation((target: { endpoint: string }) =>
        Promise.resolve(
          target.endpoint === "https://push.example/web-dead"
            ? { outcome: "permanent-failure", error: "gone" }
            : { outcome: "delivered" },
        ),
      );
    const sendApns = vi.fn();

    await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns });

    const { rows } = await pool.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM push_subscriptions WHERE id = ANY($1::uuid[])`,
      [[dead.id, alive.id]],
    );
    const byId = new Map(rows.map((row) => [row.id, row.revoked_at]));
    expect(byId.get(dead.id)).not.toBeNull();
    expect(byId.get(alive.id)).toBeNull();

    sendWebPush.mockClear();
    await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns });
    expect(sendWebPush).not.toHaveBeenCalled(); // both pairs already resolved (one delivered, one permanently failed)
  });

  it("is a no-op when the notification id no longer resolves to a row", async () => {
    const sendWebPush = vi.fn();
    const sendApns = vi.fn();
    await expect(
      handleNotificationFanoutTask(
        pool,
        { notificationId: "00000000-0000-0000-0000-000000000000" },
        {
          sendWebPush,
          sendApns,
        },
      ),
    ).resolves.toBeUndefined();
    expect(sendWebPush).not.toHaveBeenCalled();
    expect(sendApns).not.toHaveBeenCalled();
  });
});
