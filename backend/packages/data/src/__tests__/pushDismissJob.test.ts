import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { handleNotificationFanoutTask } from "../notifications/notificationFanoutJob.js";
import type { NotificationKind } from "../notifications/notificationKinds.js";
import { resolveNotificationsBySource } from "../notifications/notificationsStore.js";
import { writeNotification } from "../notifications/notify.js";
import * as apnsAdapter from "../push/apnsAdapter.js";
import { PUSH_DISMISS_MAX_IDS_PER_JOB, enqueuePushDismiss, handlePushDismissTask } from "../push/pushDismissJob.js";
import type { PushDismissSenders, PushSendResult, PushSenders } from "../push/pushSenders.js";
import { upsertApnsSubscription, upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import * as webPushAdapter from "../push/webPushAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Passthrough spies: every call reaches the real adapter unless a test replaces one answer, so the default
// wiring of the job to the adapters can be observed without a network.
vi.mock("../push/apnsAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../push/apnsAdapter.js")>();
  return { ...actual, sendApnsBackgroundPush: vi.fn(actual.sendApnsBackgroundPush) };
});
vi.mock("../push/webPushAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../push/webPushAdapter.js")>();
  return { ...actual, sendWebPushDismiss: vi.fn(actual.sendWebPushDismiss) };
});

const jobEnvelope = z.object({
  tenantId: z.string(),
  payload: z.object({ userId: z.string(), notificationIds: z.array(z.string()) }),
});

interface DismissTenant {
  tenantId: string;
  userId: string;
  webPush: { id: string; endpoint: string };
  apns: { id: string; deviceToken: string };
}

let adminPool: Pool;
let dataPool: Pool;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** A new user of `tenantId` with one Web Push and one APNs registration. */
async function addUser(tenantId: string): Promise<DismissTenant> {
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  const endpoint = `https://push.example/${randomUUID()}`;
  const webPush = await runInTenant(tenantId, () =>
    upsertWebPushSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      endpoint,
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    }),
  );
  const deviceToken = randomUUID();
  const apns = await runInTenant(tenantId, () =>
    upsertApnsSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      platform: "ios",
      deviceToken,
      apnsEnvironment: "sandbox",
    }),
  );
  return { tenantId, userId: user.id, webPush: { id: webPush.id, endpoint }, apns: { id: apns.id, deviceToken } };
}

/** One more active Web Push and one more active APNs registration for the user of `tenant`. */
async function addDevices(tenant: DismissTenant) {
  const endpoint = `https://push.example/${randomUUID()}`;
  const webPush = await runInTenant(tenant.tenantId, () =>
    upsertWebPushSubscription(dataPool, {
      userId: tenant.userId,
      sessionId: null,
      endpoint,
      p256dh: "p256dh-key-2",
      authSecret: "auth-secret-2",
    }),
  );
  const deviceToken = randomUUID();
  const apns = await runInTenant(tenant.tenantId, () =>
    upsertApnsSubscription(dataPool, {
      userId: tenant.userId,
      sessionId: null,
      platform: "ios",
      deviceToken,
      apnsEnvironment: "production",
    }),
  );
  return { webPush: { id: webPush.id, endpoint }, apns: { id: apns.id, deviceToken } };
}

async function newTenant(): Promise<DismissTenant> {
  return addUser(await createTestTenant(adminPool));
}

/**
 * Writes one notification for `userId` through the production writer and returns its id. The default is a
 * critical Semp problem, a kind that is pushed; `heartbeat_error` is a kind that never is.
 */
function writeFor(
  tenantId: string,
  userId: string,
  sourceId: string,
  kind: NotificationKind = "semp_problem",
  sourceTable = "semp_problems",
): Promise<string> {
  return inTenant(tenantId, (client) =>
    writeNotification(client, {
      userId,
      kind,
      ...(kind === "heartbeat_error" ? { titleParams: { name: "Heartbeat" } } : {}),
      linkHref: null,
      sourceTable,
      sourceId,
      transitionInstance: randomUUID(),
      payload: { severity: "critical" },
    }),
  );
}

function resolveSource(tenantId: string, sourceId: string, sourceTable = "semp_problems") {
  return inTenant(tenantId, (client) => resolveNotificationsBySource(client, { sourceTable, sourceId }));
}

/** The queued `pushDismiss` envelopes, newest queue order, as the tenant they carry and their payload. */
async function dismissJobs() {
  return (await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.PUSH_DISMISS))
    .map((envelope) => jobEnvelope.parse(envelope))
    .sort((a, b) => a.payload.userId.localeCompare(b.payload.userId));
}

function senders(overrides: Partial<Record<keyof PushDismissSenders, PushSendResult>> = {}) {
  return {
    sendWebPushDismiss: vi
      .fn<PushDismissSenders["sendWebPushDismiss"]>()
      .mockResolvedValue(overrides.sendWebPushDismiss ?? { outcome: "delivered" }),
    sendApnsDismiss: vi
      .fn<PushDismissSenders["sendApnsDismiss"]>()
      .mockResolvedValue(overrides.sendApnsDismiss ?? { outcome: "delivered" }),
  };
}

function runDismiss(tenantId: string, payload: unknown, dismissSenders?: PushDismissSenders): Promise<void> {
  return runInTenant(tenantId, () => handlePushDismissTask(dataPool, payload, dismissSenders));
}

/** The `revoked_at` state of every push registration of `userId`, by registration id. */
async function revoked(tenant: DismissTenant, userId = tenant.userId): Promise<Record<string, boolean>> {
  const { rows } = await inTenant(tenant.tenantId, (client) =>
    client.query<{ id: string; revoked: boolean }>(
      "SELECT id, revoked_at IS NOT NULL AS revoked FROM push_subscriptions WHERE user_id = $1",
      [userId],
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.revoked]));
}

async function deliveryRows(tenant: DismissTenant) {
  const { rows } = await inTenant(tenant.tenantId, (client) =>
    client.query<{ notification_id: string; push_subscription_id: string; delivered: boolean }>(
      `SELECT notification_id, push_subscription_id, delivered_at IS NOT NULL AS delivered
         FROM push_deliveries ORDER BY notification_id, push_subscription_id`,
    ),
  );
  return rows;
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockClear();
  vi.mocked(webPushAdapter.sendWebPushDismiss).mockClear();
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("resolving notifications enqueues the pushDismiss job (issue #1826)", () => {
  it("enqueues one job for the user, naming all the pushed notifications of the source, in the tenant of the resolve", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const first = await writeFor(tenant.tenantId, tenant.userId, sourceId);
    const second = await writeFor(tenant.tenantId, tenant.userId, sourceId);

    await resolveSource(tenant.tenantId, sourceId);

    const jobs = await dismissJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.tenantId).toBe(tenant.tenantId);
    expect(jobs[0]?.payload.userId).toBe(tenant.userId);
    expect([...(jobs[0]?.payload.notificationIds ?? [])].sort()).toEqual([first, second].sort());
  });

  it("enqueues only for the tenant that resolved when another tenant has a notification of a source with the same id", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const sourceId = randomUUID();
    const ofA = await writeFor(a.tenantId, a.userId, sourceId);
    await writeFor(b.tenantId, b.userId, sourceId);

    await resolveSource(a.tenantId, sourceId);

    expect((await dismissJobs()).map((job) => ({ tenantId: job.tenantId, ...job.payload }))).toEqual([
      { tenantId: a.tenantId, userId: a.userId, notificationIds: [ofA] },
    ]);
  });

  it("names a notification that was already read, because its visible push may still be on a device", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const notificationId = await writeFor(tenant.tenantId, tenant.userId, sourceId);
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE notifications SET read_at = now() WHERE id = $1", [notificationId]),
    );

    await resolveSource(tenant.tenantId, sourceId);

    expect((await dismissJobs()).map((job) => job.payload)).toEqual([
      { userId: tenant.userId, notificationIds: [notificationId] },
    ]);
  });

  it("enqueues nothing for a kind that is never pushed", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    await writeFor(tenant.tenantId, tenant.userId, sourceId, "heartbeat_error", "project_heartbeats");

    const resolved = await resolveSource(tenant.tenantId, sourceId, "project_heartbeats");

    expect(resolved).toHaveLength(1);
    expect(await dismissJobs()).toEqual([]);
  });

  it("leaves a kind that is never pushed out of the job of a source that also has a pushed notification", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const pushed = await writeFor(tenant.tenantId, tenant.userId, sourceId, "semp_problem", "shared_source");
    await writeFor(tenant.tenantId, tenant.userId, sourceId, "heartbeat_error", "shared_source");

    const resolved = await resolveSource(tenant.tenantId, sourceId, "shared_source");

    expect(resolved).toHaveLength(2);
    expect((await dismissJobs()).map((job) => job.payload)).toEqual([
      { userId: tenant.userId, notificationIds: [pushed] },
    ]);
  });

  it("enqueues nothing when a replay finds the source already resolved, or no notification of it", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    await writeFor(tenant.tenantId, tenant.userId, sourceId);
    await resolveSource(tenant.tenantId, sourceId);
    expect(await dismissJobs()).toHaveLength(1);

    await resolveSource(tenant.tenantId, sourceId);
    await resolveSource(tenant.tenantId, randomUUID());

    expect(await dismissJobs()).toHaveLength(1);
  });

  it("enqueues the job in the resolving transaction, so a rolled-back resolve leaves none", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const notificationId = await writeFor(tenant.tenantId, tenant.userId, sourceId);
    const failure = new Error("rollback after resolving");

    await expect(
      inTenant(tenant.tenantId, async (client) => {
        await resolveNotificationsBySource(client, { sourceTable: "semp_problems", sourceId });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await dismissJobs()).toEqual([]);
    const { rows } = await adminPool.query<{ resolved: boolean }>(
      "SELECT resolved_at IS NOT NULL AS resolved FROM notifications WHERE id = $1",
      [notificationId],
    );
    expect(rows).toEqual([{ resolved: false }]);
  });
});

describe("enqueuePushDismiss (issue #1826)", () => {
  it("splits a list longer than one payload into jobs of at most PUSH_DISMISS_MAX_IDS_PER_JOB ids, keeping every id once", async () => {
    const tenant = await newTenant();
    const ids = Array.from({ length: PUSH_DISMISS_MAX_IDS_PER_JOB + 1 }, () => randomUUID());

    await inTenant(tenant.tenantId, (client) =>
      enqueuePushDismiss(client, { userId: tenant.userId, notificationIds: ids }),
    );

    const jobs = await dismissJobs();
    expect(jobs.map((job) => job.payload.notificationIds.length).sort((a, b) => a - b)).toEqual([
      1,
      PUSH_DISMISS_MAX_IDS_PER_JOB,
    ]);
    expect(jobs.flatMap((job) => job.payload.notificationIds).sort()).toEqual([...ids].sort());
  });

  it("enqueues nothing for an empty list", async () => {
    const tenant = await newTenant();

    await inTenant(tenant.tenantId, (client) =>
      enqueuePushDismiss(client, { userId: tenant.userId, notificationIds: [] }),
    );

    expect(await dismissJobs()).toEqual([]);
  });

  it("gives the job three attempts", async () => {
    const tenant = await newTenant();

    await inTenant(tenant.tenantId, (client) =>
      enqueuePushDismiss(client, { userId: tenant.userId, notificationIds: [randomUUID()] }),
    );

    const { rows } = await adminPool.query<{ max_attempts: number }>(
      "SELECT max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1",
      [CORE_TASK_NAMES.PUSH_DISMISS],
    );
    expect(rows).toEqual([{ max_attempts: 3 }]);
  });
});

describe("handlePushDismissTask (issue #1826)", () => {
  it("sends the ids to the Web Push and the APNs registration of the user, and writes no push_deliveries row", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const notificationId = await writeFor(tenant.tenantId, tenant.userId, sourceId);
    const fanoutSenders: PushSenders = {
      sendWebPush: vi.fn().mockResolvedValue({ outcome: "delivered" }),
      sendApns: vi.fn().mockResolvedValue({ outcome: "delivered" }),
    };
    await runInTenant(tenant.tenantId, () => handleNotificationFanoutTask(dataPool, { notificationId }, fanoutSenders));
    const ledgerBefore = await deliveryRows(tenant);
    expect(ledgerBefore).toHaveLength(2);
    const dismissSenders = senders();

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [notificationId] }, dismissSenders);

    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledTimes(1);
    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledWith(
      { endpoint: tenant.webPush.endpoint, p256dh: "p256dh-key", authSecret: "auth-secret" },
      [notificationId],
    );
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(1);
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledWith(
      { deviceToken: tenant.apns.deviceToken, apnsEnvironment: "sandbox" },
      [notificationId],
    );
    expect(await deliveryRows(tenant)).toEqual(ledgerBefore);
    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: false, [tenant.apns.id]: false });
  });

  it("sends to every active registration of the user, one send per Web Push endpoint and APNs device token, and skips a revoked one", async () => {
    const tenant = await newTenant();
    const second = await addDevices(tenant);
    const third = await addDevices(tenant);
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE push_subscriptions SET revoked_at = now() WHERE id = ANY($1)", [
        [third.webPush.id, third.apns.id],
      ]),
    );
    const notificationId = randomUUID();
    const dismissSenders = senders();

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [notificationId] }, dismissSenders);

    expect(dismissSenders.sendApnsDismiss.mock.calls.map(([target, ids]) => [target.deviceToken, ids])).toEqual(
      expect.arrayContaining([
        [tenant.apns.deviceToken, [notificationId]],
        [second.apns.deviceToken, [notificationId]],
      ]),
    );
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(2);
    expect(dismissSenders.sendWebPushDismiss.mock.calls.map(([target]) => target.endpoint).sort()).toEqual(
      [tenant.webPush.endpoint, second.webPush.endpoint].sort(),
    );
    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledTimes(2);
  });

  it("revokes only the dead APNs registration and still reaches the user's other APNs registration", async () => {
    const tenant = await newTenant();
    const second = await addDevices(tenant);
    const dismissSenders = senders();
    dismissSenders.sendApnsDismiss.mockImplementation(async (target) =>
      target.deviceToken === tenant.apns.deviceToken
        ? { outcome: "permanent-failure", error: "BadDeviceToken" }
        : { outcome: "delivered" },
    );

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders);

    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(2);
    expect(await revoked(tenant)).toEqual({
      [tenant.webPush.id]: false,
      [tenant.apns.id]: true,
      [second.webPush.id]: false,
      [second.apns.id]: false,
    });
  });

  it("skips a registration that was revoked and sends to the one that is still active", async () => {
    const tenant = await newTenant();
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE push_subscriptions SET revoked_at = now() WHERE id = $1", [tenant.webPush.id]),
    );
    const dismissSenders = senders();

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders);

    expect(dismissSenders.sendWebPushDismiss).not.toHaveBeenCalled();
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a user who has no registration", async () => {
    const tenantId = await createTestTenant(adminPool);
    const user = await createUser(adminPool, {
      tenantId,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    const dismissSenders = senders();

    await runDismiss(tenantId, { userId: user.id, notificationIds: [randomUUID()] }, dismissSenders);

    expect(dismissSenders.sendWebPushDismiss).not.toHaveBeenCalled();
    expect(dismissSenders.sendApnsDismiss).not.toHaveBeenCalled();
  });

  it("revokes a Web Push registration the provider reports dead and still reaches the APNs one", async () => {
    const tenant = await newTenant();
    const dismissSenders = senders({ sendWebPushDismiss: { outcome: "permanent-failure", error: "gone" } });

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders);

    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(1);
    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: true, [tenant.apns.id]: false });
  });

  it("revokes an APNs registration the provider reports dead and still reaches the Web Push one", async () => {
    const tenant = await newTenant();
    const dismissSenders = senders({ sendApnsDismiss: { outcome: "permanent-failure", error: "BadDeviceToken" } });

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders);

    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledTimes(1);
    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: false, [tenant.apns.id]: true });
  });

  it("neither revokes nor fails for a channel the server has no credentials for", async () => {
    const tenant = await newTenant();
    const dismissSenders = senders({
      sendWebPushDismiss: { outcome: "not-configured", reason: "no VAPID" },
      sendApnsDismiss: { outcome: "not-configured", reason: "no APNS" },
    });

    await expect(
      runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders),
    ).resolves.toBeUndefined();

    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledTimes(1);
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(1);
    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: false, [tenant.apns.id]: false });
  });

  it("fails the job on a transient failure after trying the other registration, and revokes nothing", async () => {
    const tenant = await newTenant();
    const failure = new Error("503 from the push service");
    const dismissSenders = senders({ sendWebPushDismiss: { outcome: "transient-failure", error: failure } });

    const outcome = runDismiss(
      tenant.tenantId,
      { userId: tenant.userId, notificationIds: [randomUUID()] },
      dismissSenders,
    );

    await expect(outcome).rejects.toThrow(/1 transient failure\(s\)/);
    await expect(outcome).rejects.toMatchObject({ errors: [failure] });
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledTimes(1);
    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: false, [tenant.apns.id]: false });
  });

  it("revokes the dead registration and still fails the job when the other one fails transiently", async () => {
    const tenant = await newTenant();
    const dismissSenders = senders({
      sendWebPushDismiss: { outcome: "permanent-failure", error: "gone" },
      sendApnsDismiss: { outcome: "transient-failure", error: new Error("timeout") },
    });

    await expect(
      runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [randomUUID()] }, dismissSenders),
    ).rejects.toThrow(/transient/);

    expect(await revoked(tenant)).toEqual({ [tenant.webPush.id]: true, [tenant.apns.id]: false });
  });

  it.each([
    ["a payload that is not an object", "nope"],
    ["a user id that is not a UUID", { userId: "user-1", notificationIds: [randomUUID()] }],
    ["no notification ids", { userId: randomUUID(), notificationIds: [] }],
    ["a notification id that is not a UUID", { userId: randomUUID(), notificationIds: ["n1"] }],
    [
      "more ids than one payload carries",
      {
        userId: randomUUID(),
        notificationIds: Array.from({ length: PUSH_DISMISS_MAX_IDS_PER_JOB + 1 }, () => randomUUID()),
      },
    ],
  ])("fails the job without sending for %s", async (_name, payload) => {
    const tenant = await newTenant();
    const dismissSenders = senders();

    await expect(runDismiss(tenant.tenantId, payload, dismissSenders)).rejects.toBeInstanceOf(z.ZodError);

    expect(dismissSenders.sendWebPushDismiss).not.toHaveBeenCalled();
    expect(dismissSenders.sendApnsDismiss).not.toHaveBeenCalled();
  });

  it("sends through the adapters by default: a silent background push with the ids, and the Web Push dismiss", async () => {
    const tenant = await newTenant();
    const notificationId = randomUUID();
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockResolvedValue({ outcome: "delivered" });
    vi.mocked(webPushAdapter.sendWebPushDismiss).mockResolvedValue({ outcome: "delivered" });

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [notificationId] });

    expect(apnsAdapter.sendApnsBackgroundPush).toHaveBeenCalledTimes(1);
    expect(apnsAdapter.sendApnsBackgroundPush).toHaveBeenCalledWith(
      { deviceToken: tenant.apns.deviceToken, apnsEnvironment: "sandbox" },
      { dismiss: [notificationId] },
    );
    expect(webPushAdapter.sendWebPushDismiss).toHaveBeenCalledTimes(1);
    expect(webPushAdapter.sendWebPushDismiss).toHaveBeenCalledWith(
      { endpoint: tenant.webPush.endpoint, p256dh: "p256dh-key", authSecret: "auth-secret" },
      [notificationId],
    );
  });

  it("sends a background push to each APNs device token of the user by default", async () => {
    const tenant = await newTenant();
    const second = await addDevices(tenant);
    const notificationId = randomUUID();
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockResolvedValue({ outcome: "delivered" });
    vi.mocked(webPushAdapter.sendWebPushDismiss).mockResolvedValue({ outcome: "delivered" });

    await runDismiss(tenant.tenantId, { userId: tenant.userId, notificationIds: [notificationId] });

    expect(
      vi
        .mocked(apnsAdapter.sendApnsBackgroundPush)
        .mock.calls.map(([target]) => target.deviceToken)
        .sort(),
    ).toEqual([tenant.apns.deviceToken, second.apns.deviceToken].sort());
    for (const [, payload] of vi.mocked(apnsAdapter.sendApnsBackgroundPush).mock.calls) {
      expect(payload).toEqual({ dismiss: [notificationId] });
    }
    expect(webPushAdapter.sendWebPushDismiss).toHaveBeenCalledTimes(2);
  });

  it("reaches only the registrations of its own tenant, whatever user the payload names", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const notificationId = randomUUID();
    const foreign = senders();

    await runDismiss(b.tenantId, { userId: a.userId, notificationIds: [notificationId] }, foreign);

    expect(foreign.sendWebPushDismiss).not.toHaveBeenCalled();
    expect(foreign.sendApnsDismiss).not.toHaveBeenCalled();
    expect(await revoked(a)).toEqual({ [a.webPush.id]: false, [a.apns.id]: false });

    const own = senders({ sendWebPushDismiss: { outcome: "permanent-failure", error: "gone" } });
    await runDismiss(a.tenantId, { userId: a.userId, notificationIds: [notificationId] }, own);

    expect(own.sendWebPushDismiss.mock.calls.map(([target]) => target.endpoint)).toEqual([a.webPush.endpoint]);
    expect(own.sendApnsDismiss.mock.calls.map(([target]) => target.deviceToken)).toEqual([a.apns.deviceToken]);
    expect(await revoked(a)).toEqual({ [a.webPush.id]: true, [a.apns.id]: false });
    expect(await revoked(b)).toEqual({ [b.webPush.id]: false, [b.apns.id]: false });
  });
});

describe("the pushDismiss job through the queue (issue #1826)", () => {
  const noop = registerTask(CORE_TASK_NAMES.NOTIFICATION_FANOUT, async () => {});

  it("sends a resolved notification's dismiss to every registration of its user", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    const notificationId = await writeFor(tenant.tenantId, tenant.userId, sourceId);
    await resolveSource(tenant.tenantId, sourceId);
    const dismissSenders = senders();

    await runOnce(
      { pgPool: adminPool },
      {
        [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: noop,
        [CORE_TASK_NAMES.PUSH_DISMISS]: registerTask(CORE_TASK_NAMES.PUSH_DISMISS, (payload) =>
          handlePushDismissTask(dataPool, payload, dismissSenders),
        ),
      },
    );

    expect(dismissSenders.sendWebPushDismiss).toHaveBeenCalledWith(expect.anything(), [notificationId]);
    expect(dismissSenders.sendApnsDismiss).toHaveBeenCalledWith(expect.anything(), [notificationId]);
    expect(await dismissJobs()).toEqual([]);
  });

  it("keeps a job whose send failed transiently queued for a retry, with the failure recorded", async () => {
    const tenant = await newTenant();
    const sourceId = randomUUID();
    await writeFor(tenant.tenantId, tenant.userId, sourceId);
    await resolveSource(tenant.tenantId, sourceId);
    const dismissSenders = senders({ sendApnsDismiss: { outcome: "transient-failure", error: new Error("503") } });

    await runOnce(
      { pgPool: adminPool },
      {
        [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: noop,
        [CORE_TASK_NAMES.PUSH_DISMISS]: registerTask(CORE_TASK_NAMES.PUSH_DISMISS, (payload) =>
          handlePushDismissTask(dataPool, payload, dismissSenders),
        ),
      },
    );

    const { rows } = await adminPool.query<{ attempts: number; max_attempts: number; last_error: string | null }>(
      "SELECT attempts, max_attempts, last_error FROM graphile_worker.jobs WHERE task_identifier = $1",
      [CORE_TASK_NAMES.PUSH_DISMISS],
    );
    expect(rows).toEqual([{ attempts: 1, max_attempts: 3, last_error: expect.stringMatching(/transient failure/) }]);
  });
});
