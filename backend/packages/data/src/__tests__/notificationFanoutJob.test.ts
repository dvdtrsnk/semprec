import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { writeNotification } from "../notifications/notify.js";
import {
  handleNotificationFanoutTask,
  notificationFanoutJobKey,
  pushInterruptionLevelFor,
} from "../notifications/notificationFanoutJob.js";
import type { NotificationKind, NotificationKindPolicy } from "../notifications/notificationKinds.js";
import {
  patchNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from "../notifications/notificationPreferencesStore.js";
import { upsertApnsSubscription, upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import type { PushSenders } from "../push/pushSenders.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";

let pool: Pool;

/** Tenant zero's user: a tenant-zero notification may only name its own tenant's user (issue #1066). */
async function createTestUser(): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, {
    email: `${Math.random()}@example.test`,
    passwordHash,
    tenantId: getTenantZeroId(),
  });
  return user.id;
}

/**
 * Writes one notification and returns its id. The default is a critical Semp problem
 * (`semp_problem`, severity in its payload), which the default preferences push; pass a warning
 * problem or an approval to test the other rules.
 */
async function writeTestNotification(
  userId: string,
  sourceId: string,
  kind: NotificationKind = "semp_problem",
  sourceTable = "semp_problems",
  payload: Record<string, unknown> = { severity: "critical" },
): Promise<string> {
  await withTransaction(pool, (client) =>
    writeNotification(client, {
      userId,
      kind,
      linkHref: "?page=mailbox",
      sourceTable,
      sourceId,
      transitionInstance: "job-1",
      payload,
    }),
  );
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM notifications WHERE source_id = $1`, [sourceId]);
  return rows[0]!.id;
}

async function countRows(text: string, values: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(text, values);
  return Number(rows[0]!.count);
}

interface FanoutJobRow {
  key: string;
  // Issue #167: `enqueueJob` wraps every job payload in a `{ traceId, payload }` envelope before
  // it reaches `graphile_worker`'s own `jobs` table.
  payload: unknown;
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
    expect(jobs[0]!.payload).toMatchObject({ traceId: expect.any(String), payload: { notificationId } });
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
      {
        notificationId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "time-sensitive",
      },
    );
    expect(sendApns).toHaveBeenCalledTimes(1);
    expect(sendApns).toHaveBeenCalledWith(
      { deviceToken: "device-token-1", apnsEnvironment: "sandbox" },
      {
        notificationId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "time-sensitive",
      },
    );

    const { rows } = await pool.query(
      `SELECT push_subscription_id, delivered_at FROM push_deliveries WHERE notification_id = $1`,
      [notificationId],
    );
    expect(rows).toHaveLength(2);
    const deliveredIds = rows.filter((row) => row.delivered_at !== null).map((row) => row.push_subscription_id);
    expect(deliveredIds.sort()).toEqual([webPush.id, apns.id].sort());
  });

  it("sends the body rendered at write time in the recipient's locale, beside the title (issue #1773)", async () => {
    const userId = await createTestUser();
    await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-body",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId,
        kind: "approval_pending",
        linkHref: `?page=approvals&user=${userId}`,
        sourceTable: "approval_requests",
        sourceId: "approval-body-push",
        transitionInstance: "approval-body-push",
        bodyKey: "approval.viewDelete",
        bodyParams: { viewName: "Open tasks", databaseName: "Tasks" },
        bodySuffixKey: "notification.body.cannotUndo",
      }),
    );

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() });

    expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
      notificationId,
      title: "Semp potřebuje schválení",
      body: "Smazat pohled „Open tasks“ z „Tasks“. Semp tuto akci nedokáže vrátit zpět.",
      linkHref: `?page=approvals&user=${userId}`,
      interruptionLevel: "time-sensitive",
    });
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

  it("marks a not-configured registration permanently failed without revoking it, and still delivers the other one (issue #703)", async () => {
    const userId = await createTestUser();
    const notConfigured = await upsertWebPushSubscription(pool, {
      userId,
      sessionId: null,
      endpoint: "https://push.example/web-not-configured",
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    });
    const configured = await upsertApnsSubscription(pool, {
      userId,
      sessionId: null,
      platform: "ios",
      deviceToken: "device-token-configured",
      apnsEnvironment: "sandbox",
    });
    const notificationId = await writeTestNotification(userId, "hb-fanout-not-configured");

    const sendWebPush = vi.fn().mockResolvedValue({
      outcome: "not-configured",
      reason: "Web Push delivery requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT to be set",
    });
    const sendApns = vi.fn().mockResolvedValue({ outcome: "delivered" });
    const senders: PushSenders = { sendWebPush, sendApns };

    await expect(handleNotificationFanoutTask(pool, { notificationId }, senders)).resolves.toBeUndefined();

    const { rows } = await pool.query<{
      push_subscription_id: string;
      failed_permanently_at: Date | null;
      delivered_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT push_subscription_id, failed_permanently_at, delivered_at, last_error FROM push_deliveries WHERE notification_id = $1`,
      [notificationId],
    );
    const byId = new Map(rows.map((row) => [row.push_subscription_id, row]));

    const notConfiguredRow = byId.get(notConfigured.id)!;
    expect(notConfiguredRow.failed_permanently_at).not.toBeNull();
    expect(notConfiguredRow.delivered_at).toBeNull();
    expect(notConfiguredRow.last_error).toMatch(/VAPID_PUBLIC_KEY/);

    const configuredRow = byId.get(configured.id)!;
    expect(configuredRow.delivered_at).not.toBeNull();

    const { rows: subscriptionRows } = await pool.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM push_subscriptions WHERE id = $1`,
      [notConfigured.id],
    );
    expect(subscriptionRows[0]!.revoked_at).toBeNull();
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

  describe("honors preferences and sets the interruption level (issue #1443)", () => {
    async function addWebPushRegistration(userId: string, label: string): Promise<void> {
      await upsertWebPushSubscription(pool, {
        userId,
        sessionId: null,
        endpoint: `https://push.example/${label}`,
        p256dh: "p256dh-key",
        authSecret: "auth-secret",
      });
    }

    async function setPreferences(userId: string, patch: NotificationPreferencesPatch): Promise<void> {
      await withTransaction(pool, (client) => patchNotificationPreferences(client, userId, patch));
    }

    it("stores an approval and sends nothing when approvals are switched off", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "approvals-off");
      await setPreferences(userId, { approvals: false });
      const notificationId = await writeTestNotification(
        userId,
        "approval-off",
        "approval_pending",
        "approval_requests",
        {},
      );

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      const sendApns = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns });

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(sendApns).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM notifications WHERE id = $1`, [notificationId])).toBe(1);
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [notificationId])).toBe(
        0,
      );
    });

    it("sends an approval as time-sensitive while approvals are switched on", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "approvals-on");
      const notificationId = await writeTestNotification(
        userId,
        "approval-on",
        "approval_pending",
        "approval_requests",
        {},
      );

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
        notificationId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "time-sensitive",
      });
    });

    it("drops a warning problem at the default critical level and sends a critical one time-sensitive with the summary on", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "problems-critical");
      await setPreferences(userId, { problemsLevel: "critical", problemsSummary: true });
      const warningId = await writeTestNotification(userId, "problem-warning", "semp_problem", "semp_problems", {
        severity: "warning",
      });
      const criticalId = await writeTestNotification(userId, "problem-critical");

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      const senders: PushSenders = { sendWebPush, sendApns: vi.fn() };

      await handleNotificationFanoutTask(pool, { notificationId: warningId }, senders);
      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [warningId])).toBe(0);

      await handleNotificationFanoutTask(pool, { notificationId: criticalId }, senders);
      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
        notificationId: criticalId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "time-sensitive",
      });
    });

    it("sends a critical problem as active when the summary is switched off", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "summary-off");
      await setPreferences(userId, { problemsSummary: false });
      const notificationId = await writeTestNotification(userId, "problem-summary-off");

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
        notificationId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "active",
      });
    });

    it("never pushes an info kind, even when the problems level is all", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "info-kind");
      await setPreferences(userId, { problemsLevel: "all" });
      await seedSystem(pool);
      const projectItemId = await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, "projects");
        if (!database) throw new Error("Missing projects database");
        return (await createItemWithClient(client, { databaseId: database.id, properties: { name: "Project" } })).id;
      });
      const notificationId = await writeTestNotification(
        userId,
        "info-resolved",
        "agent_guidance_drift_resolved",
        "agent_guidance_drift_findings",
        { projectItemId },
      );

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM notifications WHERE id = $1`, [notificationId])).toBe(1);
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [notificationId])).toBe(
        0,
      );
    });

    it("applies the defaults to a user with no preferences row, and a read does not create one", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "no-row");
      const criticalId = await writeTestNotification(userId, "no-row-critical");
      const warningId = await writeTestNotification(userId, "no-row-warning", "semp_problem", "semp_problems", {
        severity: "warning",
      });

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      const senders: PushSenders = { sendWebPush, sendApns: vi.fn() };
      await handleNotificationFanoutTask(pool, { notificationId: criticalId }, senders);
      await handleNotificationFanoutTask(pool, { notificationId: warningId }, senders);

      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
        notificationId: criticalId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "time-sensitive",
      });
      expect(await countRows(`SELECT count(*) FROM notification_preferences WHERE user_id = $1`, [userId])).toBe(0);
    });

    it("honors a preference changed after the notification was enqueued", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "changed-after-enqueue");
      const notificationId = await writeTestNotification(userId, "changed-after-enqueue");
      expect(await fanoutJobs()).toHaveLength(1);

      await setPreferences(userId, { problemsLevel: "off" });

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM notifications WHERE id = $1`, [notificationId])).toBe(1);
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [notificationId])).toBe(
        0,
      );
    });

    it("reads a semp_problem's severity from its payload, so a warning passes at the all level as passive (issue #1466)", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "payload-warning");
      await setPreferences(userId, { problemsLevel: "all" });
      const warningId = await writeTestNotification(userId, "payload-warning", "semp_problem", "semp_problems", {
        severity: "warning",
      });

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await handleNotificationFanoutTask(pool, { notificationId: warningId }, { sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
        notificationId: warningId,
        title: expect.any(String),
        body: null,
        linkHref: "?page=mailbox",
        interruptionLevel: "passive",
      });
    });

    it("fails the job, sends nothing and claims no delivery when a semp_problem payload has no severity (issue #1466)", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "payload-missing");
      const notificationId = await writeTestNotification(
        userId,
        "payload-missing",
        "semp_problem",
        "semp_problems",
        {},
      );

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await expect(
        handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() }),
      ).rejects.toThrow("has no severity in its payload");

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [notificationId])).toBe(
        0,
      );
    });

    it("fails the job, sends nothing and claims no delivery when a semp_problem payload names a severity no problem has (issue #1466)", async () => {
      const userId = await createTestUser();
      await addWebPushRegistration(userId, "payload-info");
      const notificationId = await writeTestNotification(userId, "payload-info", "semp_problem", "semp_problems", {
        severity: "info",
      });

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await expect(
        handleNotificationFanoutTask(pool, { notificationId }, { sendWebPush, sendApns: vi.fn() }),
      ).rejects.toThrow("Unknown payload.severity");

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countRows(`SELECT count(*) FROM push_deliveries WHERE notification_id = $1`, [notificationId])).toBe(
        0,
      );
    });
  });
});

/**
 * Pure rule table for `pushInterruptionLevelFor`. No kind uses the invites or reminders category yet,
 * so their switches can only be tested on synthetic policies here; the invitation and reminder kinds
 * that add a real policy will test them end to end through the job.
 */
describe("pushInterruptionLevelFor (issue #1443)", () => {
  const defaults: NotificationPreferences = {
    approvals: true,
    invites: true,
    reminders: true,
    problemsLevel: "critical",
    problemsSummary: true,
    badgeApprovals: true,
    badgeInvites: true,
    badgeInbox: false,
    updatedAt: null,
  };
  const approvals: NotificationKindPolicy = { category: "approvals", push: true };
  const invites: NotificationKindPolicy = { category: "invites", push: true };
  const reminders: NotificationKindPolicy = { category: "reminders", push: true };
  const critical: NotificationKindPolicy = { category: "problems", severity: "critical", push: true };
  const warning: NotificationKindPolicy = { category: "problems", severity: "warning", push: true };
  const info: NotificationKindPolicy = { category: "problems", severity: "info", push: false };

  it("sends an approval as time-sensitive only while the approvals switch is on", () => {
    expect(pushInterruptionLevelFor(approvals, defaults)).toBe("time-sensitive");
    expect(pushInterruptionLevelFor(approvals, { ...defaults, approvals: false })).toBeNull();
  });

  it("follows the invites and reminders switches and sends them active", () => {
    expect(pushInterruptionLevelFor(invites, defaults)).toBe("active");
    expect(pushInterruptionLevelFor(invites, { ...defaults, invites: false })).toBeNull();
    expect(pushInterruptionLevelFor(reminders, defaults)).toBe("active");
    expect(pushInterruptionLevelFor(reminders, { ...defaults, reminders: false })).toBeNull();
  });

  it("never pushes an info policy, whatever the problems level", () => {
    for (const problemsLevel of ["off", "critical", "all"] as const) {
      expect(pushInterruptionLevelFor(info, { ...defaults, problemsLevel })).toBeNull();
    }
  });

  it("honors the push flag on its own, even when the category switch is on", () => {
    const approvalsWithoutPush: NotificationKindPolicy = { category: "approvals", push: false };
    expect(pushInterruptionLevelFor(approvalsWithoutPush, defaults)).toBeNull();
  });

  it("sends no problem at all when the problems level is off", () => {
    const off = { ...defaults, problemsLevel: "off" as const };
    expect(pushInterruptionLevelFor(critical, off)).toBeNull();
    expect(pushInterruptionLevelFor(warning, off)).toBeNull();
  });

  it("passes only critical problems at the critical level, time-sensitive with the summary on and active with it off", () => {
    expect(pushInterruptionLevelFor(warning, defaults)).toBeNull();
    expect(pushInterruptionLevelFor(critical, defaults)).toBe("time-sensitive");
    expect(pushInterruptionLevelFor(critical, { ...defaults, problemsSummary: false })).toBe("active");
  });

  it("passes critical and warning problems at the all level, warning passive with the summary on and active with it off", () => {
    const all = { ...defaults, problemsLevel: "all" as const };
    expect(pushInterruptionLevelFor(critical, all)).toBe("time-sensitive");
    expect(pushInterruptionLevelFor(warning, all)).toBe("passive");
    expect(pushInterruptionLevelFor(critical, { ...all, problemsSummary: false })).toBe("active");
    expect(pushInterruptionLevelFor(warning, { ...all, problemsSummary: false })).toBe("active");
  });
});
