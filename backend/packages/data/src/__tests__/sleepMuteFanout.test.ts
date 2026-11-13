import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { logger } from "../notifications/logger.js";
import { handleNotificationFanoutTask } from "../notifications/notificationFanoutJob.js";
import type { NotificationKind } from "../notifications/notificationKinds.js";
import { writeNotification } from "../notifications/notify.js";
import { upsertApnsSubscription, upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import type { PushSenders } from "../push/pushSenders.js";
import { setNotificationCreatedHook, type NotificationCreatedEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { findSleepMuteUntil } from "../sleep/sleepMuteWindow.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Passthrough spies: every call reaches the real function unless a test makes one call fail, and a test can see
// whether the fan-out job asked for the sleep window at all.
vi.mock("../sleep/sleepMuteWindow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sleep/sleepMuteWindow.js")>();
  return { ...actual, findSleepMuteUntil: vi.fn(actual.findSleepMuteUntil) };
});
vi.mock("@semprec/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/queue")>();
  return { ...actual, enqueueJob: vi.fn(actual.enqueueJob) };
});

// A seeded tenant has the default plans: wake days mon to fri from 23:00 to 06:45, sat and sun from 00:00 to 08:30,
// with `enabled` and `muteSemp` true. Its time zone is Europe/Prague, which is at +02:00 on the dates below.

/** Saturday 02:00: inside the night 2026-10-16, which the weekend plan runs from 00:00 to 08:30. */
const AT_0200 = new Date("2026-10-17T02:00:00+02:00");
/** The wake time of the night 2026-10-16. */
const AT_0830 = new Date("2026-10-17T08:30:00+02:00");
const AT_0900 = new Date("2026-10-17T09:00:00+02:00");
/** Friday 23:45: after the wake time of the night 2026-10-15 and before the midnight bedtime of the night 2026-10-16. */
const AT_2345 = new Date("2026-10-16T23:45:00+02:00");

const USER = { writerKind: "user" } as const;
const HOURS_48_MS = 48 * 60 * 60 * 1000;

const SLEEP_CHECK_FAILED = "Sleep window check failed; the push is sent without it";

const jobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ notificationId: z.string() }) });
const jobPayload = z.object({ notificationId: z.string() });

interface SleepTenant {
  tenantId: string;
  userId: string;
  webPushId: string;
  apnsId: string;
}

interface FanoutJob {
  key: string | null;
  runAt: string;
  maxAttempts: number;
}

let adminPool: Pool;
let dataPool: Pool;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** A tenant with a user and one web push and one APNs registration, without any system database. */
async function bareTenant(): Promise<SleepTenant> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  const webPush = await runInTenant(tenantId, () =>
    upsertWebPushSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      endpoint: `https://push.example/${randomUUID()}`,
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    }),
  );
  const apns = await runInTenant(tenantId, () =>
    upsertApnsSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      platform: "ios",
      deviceToken: randomUUID(),
      apnsEnvironment: "sandbox",
    }),
  );
  return { tenantId, userId: user.id, webPushId: webPush.id, apnsId: apns.id };
}

/** `bareTenant` seeded as a new tenant is, so it has the sleep module with its default settings and plans. */
async function sleepTenant(): Promise<SleepTenant> {
  const tenant = await bareTenant();
  await runInTenant(tenant.tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return tenant;
}

async function sleepDatabaseId(tenant: SleepTenant, moduleId: string): Promise<string> {
  const database = await inTenant(tenant.tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`The tenant has no ${moduleId} database`);
  return database.id;
}

/** The live items of one sleep database, read through the choke point as the runtime role. */
async function sleepItems(tenant: SleepTenant, moduleId: string) {
  const databaseId = await sleepDatabaseId(tenant, moduleId);
  return runInTenant(
    tenant.tenantId,
    async () => (await createChokePoint(dataPool).listItems(databaseId, { limit: 50 })).items,
  );
}

async function patchSleepItem(
  tenant: SleepTenant,
  moduleId: string,
  itemId: string,
  propertiesPatch: Record<string, unknown>,
): Promise<void> {
  const databaseId = await sleepDatabaseId(tenant, moduleId);
  await runInTenant(tenant.tenantId, () =>
    createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, USER),
  );
}

async function patchSettings(tenant: SleepTenant, propertiesPatch: Record<string, unknown>): Promise<void> {
  const [settings] = await sleepItems(tenant, SLEEP_SETTINGS_MODULE_ID);
  if (!settings) throw new Error("The seed left no sleep settings item");
  await patchSleepItem(tenant, SLEEP_SETTINGS_MODULE_ID, settings.id, propertiesPatch);
}

/** Writes one night exception as the user does and returns its id. */
async function addNight(tenant: SleepTenant, properties: Record<string, unknown>): Promise<string> {
  const databaseId = await sleepDatabaseId(tenant, SLEEP_NIGHTS_MODULE_ID);
  const night = await runInTenant(tenant.tenantId, () =>
    createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, USER),
  );
  return night.id;
}

async function trashSleepItem(tenant: SleepTenant, moduleId: string, itemId: string): Promise<void> {
  const databaseId = await sleepDatabaseId(tenant, moduleId);
  await runInTenant(tenant.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId));
}

async function setTimezone(tenant: SleepTenant, timezone: string): Promise<void> {
  const { databaseId, itemId } = await inTenant(tenant.tenantId, async (client) => ({
    databaseId: await getSystemSettingsDatabaseId(client),
    itemId: await getSystemSettingsItemId(client),
  }));
  await runInTenant(tenant.tenantId, () =>
    createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch: { timezone } }),
  );
}

function muteUntil(tenant: SleepTenant, at: Date): Promise<Date | null> {
  return inTenant(tenant.tenantId, (client) => findSleepMuteUntil(client, at));
}

/** Writes one notification for the tenant's user and returns its id. The default is a critical Semp problem, which the default preferences push. */
function writePush(
  tenant: SleepTenant,
  kind: NotificationKind = "semp_problem",
  payload: Record<string, unknown> = { severity: "critical" },
): Promise<string> {
  return inTenant(tenant.tenantId, (client) =>
    writeNotification(client, {
      userId: tenant.userId,
      kind,
      linkHref: "?page=mailbox",
      sourceTable: "sleep_mute_fanout_test",
      sourceId: randomUUID(),
      transitionInstance: "job-1",
      payload,
    }),
  );
}

function deliveredSenders() {
  return {
    sendWebPush: vi.fn<PushSenders["sendWebPush"]>().mockResolvedValue({ outcome: "delivered" }),
    sendApns: vi.fn<PushSenders["sendApns"]>().mockResolvedValue({ outcome: "delivered" }),
  };
}

/** Runs the fan-out job of `notificationId` in the tenant with the clock at `at`. */
function fanOut(tenant: SleepTenant, notificationId: string, at: Date, senders: PushSenders): Promise<void> {
  return runInTenant(tenant.tenantId, () =>
    handleNotificationFanoutTask(dataPool, { notificationId }, { ...senders, now: () => at }),
  );
}

/**
 * Drains the queue once with the fan-out handler as its only task, as a worker does: each job runs in the tenant
 * of its envelope. The n-th run reads `clock[n]`; a run beyond the list fails. Returns the key and run time of
 * each job that ran. A deferred job is due at once for the queue, because the dates of this file lie in the past.
 */
async function drainFanoutQueue(clock: readonly Date[], senders: PushSenders) {
  const runs: { key: string | null; runAt: string }[] = [];
  const task = registerTask(CORE_TASK_NAMES.NOTIFICATION_FANOUT, async (payload, helpers) => {
    const at = clock[runs.length];
    if (!at) throw new Error("The fan-out job ran more often than the test expects");
    runs.push({ key: helpers.job.key, runAt: helpers.job.run_at.toISOString() });
    await handleNotificationFanoutTask(
      dataPool,
      { notificationId: jobPayload.parse(payload).notificationId },
      { ...senders, now: () => at },
    );
  });
  await runOnce({ pgPool: adminPool }, { [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: task });
  return runs;
}

/** Every queued `notificationFanout` job, read through graphile-worker's public `jobs` view, ordered by key. */
async function fanoutJobs(): Promise<FanoutJob[]> {
  const { rows } = await adminPool.query<{ key: string | null; run_at: Date; max_attempts: number }>(
    "SELECT key, run_at, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.NOTIFICATION_FANOUT],
  );
  return rows.map((row) => ({ key: row.key, runAt: row.run_at.toISOString(), maxAttempts: row.max_attempts }));
}

/** The queued jobs that hold the push of `notificationId` until a wake time, ordered by key. */
async function deferredJobs(notificationId: string): Promise<FanoutJob[]> {
  const prefix = `notification-fanout-deferred:${notificationId}:`;
  return (await fanoutJobs()).filter((job) => job.key?.startsWith(prefix));
}

function deferredJob(notificationId: string, wakeAt: Date): FanoutJob {
  return {
    key: `notification-fanout-deferred:${notificationId}:${wakeAt.toISOString()}`,
    runAt: wakeAt.toISOString(),
    maxAttempts: 10,
  };
}

/** The `push_deliveries` rows of a notification as the runtime role sees them in the tenant, by registration id. */
async function deliveries(tenant: SleepTenant, notificationId: string) {
  const { rows } = await inTenant(tenant.tenantId, (client) =>
    client.query<{ push_subscription_id: string; delivered: boolean }>(
      `SELECT push_subscription_id, delivered_at IS NOT NULL AS delivered
         FROM push_deliveries WHERE notification_id = $1 ORDER BY push_subscription_id`,
      [notificationId],
    ),
  );
  return rows.map((row) => ({ registrationId: row.push_subscription_id, delivered: row.delivered }));
}

function deliveredToBoth(tenant: SleepTenant) {
  return [tenant.webPushId, tenant.apnsId].sort().map((registrationId) => ({ registrationId, delivered: true }));
}

async function notificationCount(tenant: SleepTenant, notificationId: string): Promise<number> {
  const { rows } = await inTenant(tenant.tenantId, (client) =>
    client.query<{ id: string }>("SELECT id FROM notifications WHERE id = $1", [notificationId]),
  );
  return rows.length;
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
  // Back to the passthrough, without the calls and any unused failure of an earlier test.
  vi.mocked(findSleepMuteUntil).mockReset();
  vi.mocked(enqueueJob).mockReset();
});

afterEach(() => {
  setNotificationCreatedHook(() => {});
  vi.restoreAllMocks();
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("findSleepMuteUntil (issue #1794)", () => {
  it("is null before the bedtime, the wake time from the bedtime on and null again from the wake time on", async () => {
    const tenant = await sleepTenant();

    expect(await muteUntil(tenant, new Date("2026-10-16T23:59:59.999+02:00"))).toBeNull();
    expect(await muteUntil(tenant, new Date("2026-10-17T00:00:00.000+02:00"))).toEqual(AT_0830);
    expect(await muteUntil(tenant, new Date("2026-10-17T08:29:59.999+02:00"))).toEqual(AT_0830);
    expect(await muteUntil(tenant, AT_0830)).toBeNull();
  });

  it("reads the plan times in the tenant's time zone", async () => {
    const tenant = await sleepTenant();
    await setTimezone(tenant, "America/New_York");

    // 20:00 on Friday in New York: four hours before the midnight bedtime there.
    expect(await muteUntil(tenant, AT_0200)).toBeNull();
    expect(await muteUntil(tenant, new Date("2026-10-17T02:00:00-04:00"))).toEqual(
      new Date("2026-10-17T08:30:00-04:00"),
    );
  });

  it("returns tonight's wake time while last night's window is still open", async () => {
    const tenant = await sleepTenant();
    // Last night (23:00 on Thursday) now ends at 23:30 on Friday, and tonight starts at 22:00 on Friday.
    await addNight(tenant, { night: "2026-10-15", wakeTime: "23:30" });
    await addNight(tenant, { night: "2026-10-16", bedTime: "22:00" });

    expect(await muteUntil(tenant, new Date("2026-10-16T23:00:00+02:00"))).toEqual(AT_0830);
    // Tonight alone, once last night is over.
    expect(await muteUntil(tenant, new Date("2026-10-16T23:30:00+02:00"))).toEqual(AT_0830);
    // Last night alone, before tonight starts.
    expect(await muteUntil(tenant, new Date("2026-10-16T21:00:00+02:00"))).toEqual(
      new Date("2026-10-16T23:30:00+02:00"),
    );
  });

  it("gives a night without a plan the base window when its exception sets only the alarm, and no window without the exception", async () => {
    const tenant = await sleepTenant();
    for (const plan of await sleepItems(tenant, SLEEP_PLANS_MODULE_ID)) {
      await trashSleepItem(tenant, SLEEP_PLANS_MODULE_ID, plan.id);
    }
    expect(await muteUntil(tenant, AT_0200)).toBeNull();

    await addNight(tenant, { night: "2026-10-16", alarm: true });

    expect(await muteUntil(tenant, AT_0200)).toEqual(new Date("2026-10-17T07:00:00+02:00"));
  });

  it("ignores a night exception in the trash", async () => {
    const tenant = await sleepTenant();
    const nightId = await addNight(tenant, { night: "2026-10-16", wakeTime: "09:00" });
    const at0845 = new Date("2026-10-17T08:45:00+02:00");
    expect(await muteUntil(tenant, at0845)).toEqual(AT_0900);

    await trashSleepItem(tenant, SLEEP_NIGHTS_MODULE_ID, nightId);

    expect(await muteUntil(tenant, at0845)).toBeNull();
  });

  it.each([{ switchedOff: "enabled" }, { switchedOff: "muteSemp" }])(
    "is null inside the window when $switchedOff is false",
    async ({ switchedOff }) => {
      const tenant = await sleepTenant();
      expect(await muteUntil(tenant, AT_0200)).toEqual(AT_0830);

      await patchSettings(tenant, { [switchedOff]: false });

      expect(await muteUntil(tenant, AT_0200)).toBeNull();
    },
  );

  it("is null for a tenant that has no sleep database", async () => {
    const tenant = await bareTenant();

    expect(await muteUntil(tenant, AT_0200)).toBeNull();
  });

  it("is null for a tenant whose settings are on but which has neither a plans nor a nights database", async () => {
    const tenant = await bareTenant();
    // Store functions, as the seed uses them: no production write creates the settings database alone.
    await inTenant(tenant.tenantId, async (client) => {
      const database = await databasesStore.createDatabase(client, {
        name: null,
        key: SLEEP_SETTINGS_MODULE_ID,
        system: true,
        ownerModuleId: SLEEP_SETTINGS_MODULE_ID,
      });
      await itemsStore.insertItem(client, {
        databaseId: database.id,
        properties: { enabled: true, muteSemp: true },
      });
    });

    expect(await muteUntil(tenant, AT_0200)).toBeNull();
  });

  it("throws for a tenant with two settings items", async () => {
    const tenant = await sleepTenant();
    const databaseId = await sleepDatabaseId(tenant, SLEEP_SETTINGS_MODULE_ID);
    // The store function, so the fixture stays possible once a write hook refuses a second settings item.
    await inTenant(tenant.tenantId, (client) =>
      itemsStore.insertItem(client, { databaseId, properties: { enabled: false, muteSemp: false } }),
    );

    await expect(muteUntil(tenant, AT_0200)).rejects.toThrow("Expected one sleep settings item, found 2");
  });

  it("throws for a stored plan whose wake days are not a list", async () => {
    const tenant = await sleepTenant();
    const databaseId = await sleepDatabaseId(tenant, SLEEP_PLANS_MODULE_ID);
    // The store function, so the fixture stays possible once a write hook validates plan values.
    await inTenant(tenant.tenantId, (client) =>
      itemsStore.insertItem(client, {
        databaseId,
        properties: { name: "Broken", wakeDays: "sat", bedTime: "00:00", wakeTime: "08:30", alarm: false, position: 2 },
      }),
    );

    await expect(muteUntil(tenant, AT_0200)).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("notificationFanout job inside the sleep window (issue #1794)", () => {
  it("holds a push at 02:00 until the 08:30 wake time: the row and the realtime event exist, nothing is claimed or sent", async () => {
    const tenant = await sleepTenant();
    const created: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => created.push(event));
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();

    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(created).toEqual([{ userId: tenant.userId, notificationId }]);
    expect(await notificationCount(tenant, notificationId)).toBe(1);
    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    expect(await deliveries(tenant, notificationId)).toEqual([]);
    expect(await deferredJobs(notificationId)).toEqual([
      {
        key: `notification-fanout-deferred:${notificationId}:2026-10-17T06:30:00.000Z`,
        runAt: "2026-10-17T06:30:00.000Z",
        maxAttempts: 10,
      },
    ]);
    // The job written with the notification and the deferred one: both name the notification and the tenant.
    const envelopes = (await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.NOTIFICATION_FANOUT)).map(
      (envelope) => jobEnvelope.parse(envelope),
    );
    expect(envelopes).toEqual([
      { tenantId: tenant.tenantId, payload: { notificationId } },
      { tenantId: tenant.tenantId, payload: { notificationId } },
    ]);
  });

  it("sends a held push once to each registration when the deferred job runs at 08:30", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    await fanOut(tenant, notificationId, AT_0200, senders);

    await fanOut(tenant, notificationId, AT_0830, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(senders.sendWebPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notificationId, interruptionLevel: "time-sensitive" }),
    );
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    // No further hold was queued by the run that sent.
    expect(await deferredJobs(notificationId)).toEqual([deferredJob(notificationId, AT_0830)]);

    // A second run after the wake time finds both deliveries settled.
    await fanOut(tenant, notificationId, AT_0900, senders);
    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
  });

  it("runs the held push through the queue: the job at 02:00 queues the deferred job, which sends once in the tenant", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();

    const runs = await drainFanoutQueue([AT_0200, AT_0830], senders);

    expect(runs).toEqual([
      { key: `notification-fanout:${notificationId}`, runAt: expect.any(String) },
      {
        key: `notification-fanout-deferred:${notificationId}:2026-10-17T06:30:00.000Z`,
        runAt: "2026-10-17T06:30:00.000Z",
      },
    ]);
    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    expect(await fanoutJobs()).toEqual([]);
  });

  it("holds again under the same key when the deferred job starts a moment before the wake time by the job's clock, and sends once on the next run", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    const deferred = {
      key: `notification-fanout-deferred:${notificationId}:2026-10-17T06:30:00.000Z`,
      runAt: "2026-10-17T06:30:00.000Z",
    };

    const runs = await drainFanoutQueue([AT_0200, new Date("2026-10-17T08:29:59.999+02:00"), AT_0830], senders);

    expect(runs).toEqual([
      { key: `notification-fanout:${notificationId}`, runAt: expect.any(String) },
      deferred,
      deferred,
    ]);
    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    expect(await fanoutJobs()).toEqual([]);
  });

  it.each([{ switchedOff: "muteSemp" }, { switchedOff: "enabled" }])(
    "sends at once at 02:00 when $switchedOff is false",
    async ({ switchedOff }) => {
      const tenant = await sleepTenant();
      await patchSettings(tenant, { [switchedOff]: false });
      const notificationId = await writePush(tenant);
      const senders = deliveredSenders();

      await fanOut(tenant, notificationId, AT_0200, senders);

      expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
      expect(senders.sendApns).toHaveBeenCalledTimes(1);
      expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
      expect(await deferredJobs(notificationId)).toEqual([]);
    },
  );

  it("defers the 08:30 run to 09:00 when the night's wake time was moved to 09:00 after the hold, and sends once at 09:00", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    await fanOut(tenant, notificationId, AT_0200, senders);
    await addNight(tenant, { night: "2026-10-16", wakeTime: "09:00" });

    await fanOut(tenant, notificationId, AT_0830, senders);

    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    expect(await deliveries(tenant, notificationId)).toEqual([]);
    expect(await deferredJobs(notificationId)).toEqual([
      deferredJob(notificationId, AT_0830),
      deferredJob(notificationId, AT_0900),
    ]);

    await fanOut(tenant, notificationId, AT_0900, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
  });

  it("sends at once at 23:45, before the midnight bedtime", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();

    await fanOut(tenant, notificationId, AT_2345, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    expect(await deferredJobs(notificationId)).toEqual([]);
  });

  it("sends an approval at 02:00 at once, without asking for the sleep window", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant, "approval_pending", {});
    const senders = deliveredSenders();

    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    expect(await deferredJobs(notificationId)).toEqual([]);
    expect(findSleepMuteUntil).not.toHaveBeenCalled();
  });

  it("does not defer a push that the preferences drop", async () => {
    const tenant = await sleepTenant();
    // A warning problem is not pushed at the default problems level.
    const notificationId = await writePush(tenant, "semp_problem", { severity: "warning" });
    const senders = deliveredSenders();

    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    expect(await deferredJobs(notificationId)).toEqual([]);
    expect(findSleepMuteUntil).not.toHaveBeenCalled();
  });

  it("sends at once when the sleep data cannot be resolved, and logs the notification id and the error's name only", async () => {
    const tenant = await sleepTenant();
    const databaseId = await sleepDatabaseId(tenant, SLEEP_NIGHTS_MODULE_ID);
    // The store function, so the fixture stays possible once a write hook validates night values.
    await inTenant(tenant.tenantId, (client) =>
      itemsStore.insertItem(client, { databaseId, properties: { night: "2026-10-16", wakeTime: "25:99" } }),
    );
    await expect(muteUntil(tenant, AT_0200)).rejects.toThrow("Invalid calendar time: '25:99'");
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(tenant, notificationId)).toEqual(deliveredToBoth(tenant));
    expect(await deferredJobs(notificationId)).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[{ notificationId, errorName: "ValidationError" }, SLEEP_CHECK_FAILED]]);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(senders.sendWebPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Something needs your attention", linkHref: "?page=mailbox" }),
    );
    expect(logged).not.toContain("Something needs your attention");
    expect(logged).not.toContain("?page=mailbox");
    expect(logged).not.toContain("25:99");
  });

  it("sends at once when the sleep check fails with a value that is not an error, and logs its type", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.mocked(findSleepMuteUntil).mockRejectedValueOnce("sleep read failed");

    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(senders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(senders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deferredJobs(notificationId)).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[{ notificationId, errorName: "string" }, SLEEP_CHECK_FAILED]]);
  });

  it("fails the job without sending when the deferred job cannot be enqueued, and holds on the next run", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("injected enqueue failure"));

    await expect(fanOut(tenant, notificationId, AT_0200, senders)).rejects.toThrow("injected enqueue failure");

    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    expect(await deliveries(tenant, notificationId)).toEqual([]);
    expect(await deferredJobs(notificationId)).toEqual([]);
    // The failure is the job's, not a failed sleep check.
    expect(errorLog).not.toHaveBeenCalled();

    // The queue runs the failed job again.
    await fanOut(tenant, notificationId, AT_0200, senders);

    expect(await deferredJobs(notificationId)).toEqual([deferredJob(notificationId, AT_0830)]);
    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
  });

  it("queues one deferred job when the original job runs twice", async () => {
    const tenant = await sleepTenant();
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();

    await fanOut(tenant, notificationId, AT_0200, senders);
    await fanOut(tenant, notificationId, new Date("2026-10-17T02:00:05+02:00"), senders);

    expect(await deferredJobs(notificationId)).toEqual([deferredJob(notificationId, AT_0830)]);
    // The job written with the notification and the one deferred job.
    expect(await fanoutJobs()).toHaveLength(2);
    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    expect(await deliveries(tenant, notificationId)).toEqual([]);
  });

  it("holds by the notification's own tenant: another tenant's switched-off mute and later wake time change nothing", async () => {
    const quiet = await sleepTenant();
    const awake = await sleepTenant();
    await patchSettings(awake, { muteSemp: false });
    await addNight(awake, { night: "2026-10-16", wakeTime: "10:00" });
    const quietNotification = await writePush(quiet);
    const awakeNotification = await writePush(awake);
    const quietSenders = deliveredSenders();
    const awakeSenders = deliveredSenders();

    await fanOut(quiet, quietNotification, AT_0200, quietSenders);
    await fanOut(awake, awakeNotification, AT_0200, awakeSenders);

    expect(quietSenders.sendWebPush).not.toHaveBeenCalled();
    expect(quietSenders.sendApns).not.toHaveBeenCalled();
    expect(await deliveries(quiet, quietNotification)).toEqual([]);
    expect(await deferredJobs(quietNotification)).toEqual([deferredJob(quietNotification, AT_0830)]);
    expect(awakeSenders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(awakeSenders.sendApns).toHaveBeenCalledTimes(1);
    expect(await deliveries(awake, awakeNotification)).toEqual(deliveredToBoth(awake));
    expect(await deferredJobs(awakeNotification)).toEqual([]);
  });

  it("reads the real time when no clock is passed", async () => {
    const tenant = await sleepTenant();
    // One plan for every wake day from 12:00 to 23:59 of the next day: every instant lies in the window of the
    // night named yesterday or today, whatever the time of this run.
    const plans = await sleepItems(tenant, SLEEP_PLANS_MODULE_ID);
    const [everyDay, ...others] = plans;
    if (!everyDay) throw new Error("The seed left no sleep plan");
    for (const plan of others) await patchSleepItem(tenant, SLEEP_PLANS_MODULE_ID, plan.id, { wakeDays: [] });
    await patchSleepItem(tenant, SLEEP_PLANS_MODULE_ID, everyDay.id, {
      wakeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      bedTime: "12:00",
      wakeTime: "23:59",
    });
    const notificationId = await writePush(tenant);
    const senders = deliveredSenders();
    const before = Date.now();

    await runInTenant(tenant.tenantId, () => handleNotificationFanoutTask(dataPool, { notificationId }, senders));

    expect(senders.sendWebPush).not.toHaveBeenCalled();
    expect(senders.sendApns).not.toHaveBeenCalled();
    const [deferred, ...more] = await deferredJobs(notificationId);
    expect(more).toEqual([]);
    const runAt = Date.parse(deferred?.runAt ?? "");
    expect(runAt).toBeGreaterThan(before);
    expect(runAt).toBeLessThanOrEqual(before + HOURS_48_MS);
  });
});
