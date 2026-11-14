// Issue gh-1879: the debounced reminders resync job, the writes that enqueue it and the silent push it sends.
import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { ItemCreateHookContext } from "../chokePoint/hooks.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import {
  REMINDERS_RESYNC_DELAY_MS,
  enqueueRemindersResync,
  handleRemindersResyncTask,
  remindersResyncJobKey,
  type RemindersResyncSender,
} from "../calendar/remindersResync.js";
import { createEventInCalendar } from "../calendar/defaultCalendarCreateHook.js";
import { remindersResyncCreateHook } from "../calendar/remindersResyncHooks.js";
import * as apnsAdapter from "../push/apnsAdapter.js";
import type { ApnsTarget, PushSendResult } from "../push/pushSenders.js";
import {
  revokePushSubscriptionByProviderInvalidation,
  upsertApnsSubscription,
  upsertWebPushSubscription,
} from "../push/pushSubscriptionsStore.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createSeriesOccurrence, startTaskSeries } from "../testSupport/taskSeriesFixtures.js";

// Passthrough spy: a call reaches the real adapter (which answers not-configured without APNS_* settings) unless a
// test replaces one answer, so the default wiring of the handler to the adapter is observed without a network.
vi.mock("../push/apnsAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../push/apnsAdapter.js")>();
  return { ...actual, sendApnsBackgroundPush: vi.fn(actual.sendApnsBackgroundPush) };
});

const USER = { writerKind: "user" } as const;

interface ResyncTenant {
  tenantId: string;
  userId: string;
  databases: Record<string, string>;
}

interface ResyncJob {
  key: string | null;
  run_at: Date;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: ResyncTenant;
let other: ResyncTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

function chokePoint(t: ResyncTenant) {
  return {
    create: (databaseKey: string, properties: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).createItem(
          { databaseId: t.databases[databaseKey]!, properties },
          undefined,
          undefined,
          USER,
        ),
      ),
    patch: (databaseKey: string, itemId: string, propertiesPatch: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).updateItem(
          { databaseId: t.databases[databaseKey]!, itemId, propertiesPatch },
          undefined,
          undefined,
          USER,
        ),
      ),
    trash: (databaseKey: string, itemId: string) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).softDeleteItem(t.databases[databaseKey]!, itemId, undefined, USER),
      ),
    restore: (databaseKey: string, itemId: string) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).restoreItem(t.databases[databaseKey]!, itemId, undefined, USER),
      ),
  };
}

/** A new tenant seeded as production seeds one, with a user, so it has its calendars and the System settings item. */
async function seededTenant(): Promise<ResyncTenant> {
  const tenantId = await createTestTenant(adminPool);
  // The user first: the seeded calendars are named in the locale of the tenant's user.
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const databases: Record<string, string> = {};
  for (const moduleId of [EVENTS_MODULE_ID, TASKS_MODULE_ID, CALENDARS_MODULE_ID, PEOPLE_MODULE_ID]) {
    const database = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`The tenant has no ${moduleId} database`);
    databases[moduleId] = database.id;
  }
  const settings = await inTenant(tenantId, (client) =>
    databasesStore.getDatabaseByModuleId(client, SYSTEM_SETTINGS_MODULE_ID),
  );
  if (!settings) throw new Error("The tenant has no System settings database");
  databases[SYSTEM_SETTINGS_MODULE_ID] = settings.id;
  return { tenantId, userId: user.id, databases };
}

/** The pending `remindersResync` jobs, read through the public view of the queue schema. */
async function resyncJobs(): Promise<ResyncJob[]> {
  const { rows } = await adminPool.query<ResyncJob>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.REMINDERS_RESYNC],
  );
  return rows;
}

function resyncKey(t: ResyncTenant): string {
  return remindersResyncJobKey(t.tenantId);
}

/** Removes every pending job of the queue, so the next write is the only one that can have enqueued a resync. */
async function clearJobs(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

const jobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ tenantId: z.string() }).strict() });

const EVENT = { name: "Workshop", date: "2026-11-20", timeFrom: "10:00", timeTo: "23:00", alertMinutes: 15 };

/** A live seeded calendar of the tenant that is not the default, not a system one and not the last own one. */
async function ownCalendarId(t: ResyncTenant): Promise<string> {
  const { rows } = await runInTenant(t.tenantId, () =>
    dataPool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'name' = 'Work'",
      [t.databases[CALENDARS_MODULE_ID]],
    ),
  );
  if (!rows[0]) throw new Error("The seeded calendar Work is missing");
  return rows[0].id;
}

async function systemSettingsItemId(t: ResyncTenant): Promise<string> {
  const { rows } = await runInTenant(t.tenantId, () =>
    dataPool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL LIMIT 1", [
      t.databases[SYSTEM_SETTINGS_MODULE_ID],
    ]),
  );
  if (!rows[0]) throw new Error("The tenant has no System settings item");
  return rows[0].id;
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("enqueueRemindersResync and the reminders write hooks (issue gh-1879)", () => {
  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
    other = await seededTenant();
    await clearJobs();
  });

  it("enqueues one job for a change of an Event's start, keyed by the tenant, 30 seconds ahead, with only the tenant id", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    const before = Date.now();
    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { timeFrom: "11:00" });
    const after = Date.now();

    const jobs = await resyncJobs();
    expect(jobs.map((job) => job.key)).toEqual([resyncKey(tenant)]);
    const runAt = jobs[0]?.run_at.getTime() ?? 0;
    expect(runAt).toBeGreaterThanOrEqual(before + REMINDERS_RESYNC_DELAY_MS);
    expect(runAt).toBeLessThanOrEqual(after + REMINDERS_RESYNC_DELAY_MS);
    expect(REMINDERS_RESYNC_DELAY_MS).toBe(30_000);
    const payloads = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.REMINDERS_RESYNC);
    expect(payloads.map((payload) => jobEnvelope.parse(payload))).toEqual([
      { tenantId: tenant.tenantId, payload: { tenantId: tenant.tenantId } },
    ]);
  });

  it("leaves one pending job when an Event's start changes twice and moves its run time to the last change", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();
    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { timeFrom: "11:00" });
    const firstRunAt = (await resyncJobs())[0]?.run_at.getTime() ?? 0;

    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { timeFrom: "12:00" });

    const jobs = await resyncJobs();
    expect(jobs.map((job) => job.key)).toEqual([resyncKey(tenant)]);
    expect(jobs[0]?.run_at.getTime() ?? 0).toBeGreaterThan(firstRunAt);
  });

  it("enqueues nothing when only an Event's name changes", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { name: "Renamed" });
    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { place: "Prague", description: "Bring the slides" });

    expect(await resyncJobs()).toEqual([]);
  });

  it.each([
    ["date", { date: "2026-11-21" }],
    ["endDate", { endDate: "2026-11-22" }],
    ["timeFrom", { timeFrom: "09:30" }],
    ["alertMinutes", { alertMinutes: 60 }],
    ["travelMinutes", { travelMinutes: 30 }],
  ])("enqueues the resync of the tenant when an Event's %s changes, and of no other", async (_key, patch) => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, patch);

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it.each([
    ["date", { date: "2026-11-21" }],
    ["timeFrom", { timeFrom: "09:30" }],
    ["notifications", { notifications: true }],
    ["status", { status: "done" }],
  ])("enqueues the resync of the tenant when a Task's %s changes", async (_key, patch) => {
    const task = await chokePoint(tenant).create(TASKS_MODULE_ID, { name: "Call", date: "2026-11-20" });
    await clearJobs();

    await chokePoint(tenant).patch(TASKS_MODULE_ID, task.id, patch);

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues nothing when only a Task's name changes", async () => {
    const task = await chokePoint(tenant).create(TASKS_MODULE_ID, { name: "Call", date: "2026-11-20" });
    await clearJobs();

    await chokePoint(tenant).patch(TASKS_MODULE_ID, task.id, { name: "Call back" });

    expect(await resyncJobs()).toEqual([]);
  });

  it.each([
    ["an Event", EVENTS_MODULE_ID, EVENT],
    ["a Task", TASKS_MODULE_ID, { name: "Call", date: "2026-11-20", timeFrom: "09:00", notifications: true }],
  ])("enqueues the resync of the tenant when %s is created with a start", async (_name, databaseKey, properties) => {
    await chokePoint(tenant).create(databaseKey, properties);

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues nothing when a Task is created with only a name, although its status takes the default", async () => {
    const task = await chokePoint(tenant).create(TASKS_MODULE_ID, { name: "Buy milk" });

    expect(task.properties.status).toBe("notDone");
    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues the resync of the tenant when a Task is created with a status of its own", async () => {
    await chokePoint(tenant).create(TASKS_MODULE_ID, { name: "Buy milk", status: "done" });

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it.each([
    ["an Event", EVENTS_MODULE_ID, EVENT],
    ["a Task", TASKS_MODULE_ID, { name: "Call", date: "2026-11-20", notifications: true }],
  ])(
    "enqueues the resync of the tenant when %s is trashed and when it is restored",
    async (_name, databaseKey, props) => {
      const item = await chokePoint(tenant).create(databaseKey, props);
      await clearJobs();

      await chokePoint(tenant).trash(databaseKey, item.id);
      expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);

      await clearJobs();
      await chokePoint(tenant).restore(databaseKey, item.id);
      expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
    },
  );

  it("enqueues one job when a calendar with its Events is trashed, and one when it is restored", async () => {
    const calendarId = await ownCalendarId(tenant);
    await inTenant(tenant.tenantId, (client) =>
      createEventInCalendar(client, { properties: EVENT }, calendarId, { writer: USER }),
    );
    await clearJobs();

    await chokePoint(tenant).trash(CALENDARS_MODULE_ID, calendarId);
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);

    await clearJobs();
    await chokePoint(tenant).restore(CALENDARS_MODULE_ID, calendarId);
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues one job when a calendar without any Event is trashed, and one when it is restored", async () => {
    const calendarId = await ownCalendarId(tenant);
    await clearJobs();

    await chokePoint(tenant).trash(CALENDARS_MODULE_ID, calendarId);
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);

    await clearJobs();
    await chokePoint(tenant).restore(CALENDARS_MODULE_ID, calendarId);
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues one job when a task series is trashed with all its instances", async () => {
    const task = await chokePoint(tenant).create(TASKS_MODULE_ID, { name: "Review", date: "2026-11-16" });
    const seriesId = await runInTenant(tenant.tenantId, () =>
      startTaskSeries(dataPool, {
        databaseId: tenant.databases[TASKS_MODULE_ID]!,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    await runInTenant(tenant.tenantId, () =>
      createSeriesOccurrence(dataPool, {
        databaseId: tenant.databases[TASKS_MODULE_ID]!,
        seriesId,
        occurrenceDate: "2026-11-23",
        status: "notDone",
      }),
    );
    await clearJobs();

    await chokePoint(tenant).trash(TASKS_MODULE_ID, task.id);

    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues nothing when a patch repeats the values an Event already has and changes only its name", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { ...EVENT, name: "Renamed" });
    expect(await resyncJobs()).toEqual([]);

    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { date: EVENT.date });
    expect(await resyncJobs()).toEqual([]);

    // A patch that repeats one value and changes another is a change.
    await chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { date: EVENT.date, timeFrom: "11:00" });
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues nothing when a patch repeats the values a Task already has, the default status included", async () => {
    const task = await chokePoint(tenant).create(TASKS_MODULE_ID, {
      name: "Call",
      date: "2026-11-20",
      notifications: true,
    });
    await clearJobs();

    await chokePoint(tenant).patch(TASKS_MODULE_ID, task.id, { status: "notDone", date: "2026-11-20" });
    await chokePoint(tenant).patch(TASKS_MODULE_ID, task.id, { name: "Call back", notifications: true });

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing when a patch repeats a calendar's notify or the tenant's time zone", async () => {
    const calendarId = await ownCalendarId(tenant);
    const settingsId = await systemSettingsItemId(tenant);
    await chokePoint(tenant).patch(CALENDARS_MODULE_ID, calendarId, { notify: false });
    await chokePoint(tenant).patch(SYSTEM_SETTINGS_MODULE_ID, settingsId, { timezone: "Europe/London" });
    await clearJobs();

    await chokePoint(tenant).patch(CALENDARS_MODULE_ID, calendarId, { notify: false });
    await chokePoint(tenant).patch(SYSTEM_SETTINGS_MODULE_ID, settingsId, { timezone: "Europe/London" });

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues one job when a calendar's notify is turned off, and nothing when it is only renamed", async () => {
    const calendarId = await ownCalendarId(tenant);
    await clearJobs();

    await chokePoint(tenant).patch(CALENDARS_MODULE_ID, calendarId, { name: "Office" });
    expect(await resyncJobs()).toEqual([]);

    await chokePoint(tenant).patch(CALENDARS_MODULE_ID, calendarId, { notify: false });
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);
  });

  it("enqueues one job when the tenant's time zone changes, and nothing for another System settings patch", async () => {
    const settingsId = await systemSettingsItemId(tenant);
    await clearJobs();

    await chokePoint(tenant).patch(SYSTEM_SETTINGS_MODULE_ID, settingsId, { timezone: "Europe/London" });
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(tenant)]);

    await clearJobs();
    await chokePoint(tenant).patch(SYSTEM_SETTINGS_MODULE_ID, settingsId, { name: "Renamed" });
    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for writes to another database, whichever hook runs", async () => {
    const person = await chokePoint(tenant).create(PEOPLE_MODULE_ID, { name: "Alice" });
    await chokePoint(tenant).patch(PEOPLE_MODULE_ID, person.id, { name: "Alice B" });
    await chokePoint(tenant).trash(PEOPLE_MODULE_ID, person.id);
    await chokePoint(tenant).restore(PEOPLE_MODULE_ID, person.id);
    // A user-created database that names a property `date` has no reminder.
    const custom = await runInTenant(tenant.tenantId, async () => {
      const cp = createChokePoint(dataPool);
      const database = await cp.createDatabase({ name: "Log" });
      await cp.createProperty({ databaseId: database.id, key: "date", name: "Date", type: "text" });
      const item = await cp.createItem({ databaseId: database.id, properties: { date: "2026-11-20" } });
      await cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { date: "2026-11-21" } });
      await cp.softDeleteItem(database.id, item.id);
      await cp.restoreItem(database.id, item.id);
      return item;
    });

    expect(custom.id).toBeTruthy();
    expect(await resyncJobs()).toEqual([]);
  });

  it("fails a hook that runs outside a tenant instead of enqueueing a job for no tenant", async () => {
    const database = await inTenant(tenant.tenantId, (client) =>
      databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID),
    );
    if (!database) throw new Error("The tenant has no events database");
    const context = {
      database,
      item: {
        id: randomUUID(),
        databaseId: database.id,
        properties: EVENT,
        computed: {},
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
      },
      properties: EVENT,
      writer: USER,
    };

    await expect(
      runAsSystem("reminders resync test without a tenant", () =>
        withTransaction(dataPool, (client) =>
          remindersResyncCreateHook({ ...context, client } satisfies ItemCreateHookContext),
        ),
      ),
    ).rejects.toThrow("A reminders write ran without a tenant");

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for a write the Events rules refuse", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    await expect(chokePoint(tenant).patch(EVENTS_MODULE_ID, event.id, { alertMinutes: 7 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      chokePoint(tenant).create(EVENTS_MODULE_ID, { name: "Bad", date: "2026-13-01" }),
    ).rejects.toMatchObject({
      status: 400,
    });

    expect(await resyncJobs()).toEqual([]);
  });

  it("leaves no job when the transaction of a triggering write rolls back", async () => {
    const event = await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);
    await clearJobs();

    await expect(
      inTenant(tenant.tenantId, async (client) => {
        await updateItemWithClient(
          client,
          {
            databaseId: tenant.databases[EVENTS_MODULE_ID]!,
            itemId: event.id,
            propertiesPatch: { date: "2026-11-25" },
          },
          { writer: USER },
        );
        expect(
          (await client.query("SELECT 1 FROM graphile_worker.jobs WHERE key = $1", [resyncKey(tenant)])).rowCount,
        ).toBe(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await resyncJobs()).toEqual([]);
  });

  it("enqueues nothing for another tenant when this tenant's reminders change, and one per tenant for both", async () => {
    await chokePoint(other).create(EVENTS_MODULE_ID, EVENT);
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(other)]);

    await chokePoint(tenant).create(EVENTS_MODULE_ID, EVENT);

    expect((await resyncJobs()).map((job) => job.key).sort()).toEqual([resyncKey(tenant), resyncKey(other)].sort());
  });
});

describe("the remindersResync handler (issue gh-1879)", () => {
  interface Registration {
    id: string;
    deviceToken: string;
  }

  interface PushedTenant extends ResyncTenant {
    ios: Registration[];
    macos: Registration;
    revokedIos: Registration;
  }

  function sender(answers: Record<string, PushSendResult> = {}) {
    const calls: Array<{ target: ApnsTarget; data: unknown }> = [];
    const send: RemindersResyncSender = async (target, data) => {
      calls.push({ target, data });
      return answers[target.deviceToken] ?? { outcome: "delivered" };
    };
    return { send, calls };
  }

  async function register(
    t: ResyncTenant,
    platform: "ios" | "macos",
    environment: "sandbox" | "production" = "sandbox",
  ): Promise<Registration> {
    const deviceToken = randomUUID();
    const row = await runInTenant(t.tenantId, () =>
      upsertApnsSubscription(dataPool, {
        userId: t.userId,
        sessionId: null,
        platform,
        deviceToken,
        apnsEnvironment: environment,
      }),
    );
    return { id: row.id, deviceToken };
  }

  /** A tenant whose user has two active iOS registrations, a macOS one, a revoked iOS one and a Web Push one. */
  async function pushedTenant(): Promise<PushedTenant> {
    const t = await seededTenant();
    const ios = [await register(t, "ios", "sandbox"), await register(t, "ios", "production")];
    const macos = await register(t, "macos");
    const revokedIos = await register(t, "ios");
    await withTransaction(dataPool, (client) =>
      runInTenant(t.tenantId, () =>
        revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: revokedIos.deviceToken }),
      ),
    );
    await runInTenant(t.tenantId, () =>
      upsertWebPushSubscription(dataPool, {
        userId: t.userId,
        sessionId: null,
        endpoint: `https://push.example/${randomUUID()}`,
        p256dh: "p256dh-key",
        authSecret: "auth-secret",
      }),
    );
    return { ...t, ios, macos, revokedIos };
  }

  function run(t: ResyncTenant, payload: unknown, send: RemindersResyncSender): Promise<void> {
    return runInTenant(t.tenantId, () => handleRemindersResyncTask(dataPool, payload, send));
  }

  async function revokedTokens(): Promise<string[]> {
    const { rows } = await adminPool.query<{ device_token: string }>(
      "SELECT device_token FROM push_subscriptions WHERE revoked_at IS NOT NULL AND channel = 'apns' ORDER BY device_token",
    );
    return rows.map((row) => row.device_token);
  }

  async function tableCounts(): Promise<{ notifications: number; deliveries: number }> {
    const { rows } = await adminPool.query<{ notifications: number; deliveries: number }>(
      "SELECT (SELECT count(*) FROM notifications)::int AS notifications, (SELECT count(*) FROM push_deliveries)::int AS deliveries",
    );
    return rows[0] ?? { notifications: -1, deliveries: -1 };
  }

  let pushed: PushedTenant;

  beforeEach(async () => {
    await resetDatabase(adminPool);
    pushed = await pushedTenant();
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends exactly one silent push {kind: remindersResync} per active iOS APNs registration and nothing else", async () => {
    const { send, calls } = sender();

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls.map((call) => call.target.deviceToken).sort()).toEqual(
      pushed.ios.map((registration) => registration.deviceToken).sort(),
    );
    expect(calls.map((call) => call.data)).toEqual([{ kind: "remindersResync" }, { kind: "remindersResync" }]);
    const touched = calls.map((call) => call.target.deviceToken);
    expect(touched).not.toContain(pushed.macos.deviceToken);
    expect(touched).not.toContain(pushed.revokedIos.deviceToken);
  });

  it("sends one silent push after two changes of an Event's start have been drained from the queue", async () => {
    const single = await seededTenant();
    const device = await register(single, "ios");
    await clearJobs();
    // Only `Date` is faked, which puts the run time of the job in the past of the database clock: the job is due.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    const event = await chokePoint(single).create(EVENTS_MODULE_ID, EVENT);
    await chokePoint(single).patch(EVENTS_MODULE_ID, event.id, { timeFrom: "11:00" });
    await chokePoint(single).patch(EVENTS_MODULE_ID, event.id, { timeFrom: "12:00" });
    expect((await resyncJobs()).map((job) => job.key)).toEqual([resyncKey(single)]);
    const { send, calls } = sender();

    await runOnce(
      { pgPool: adminPool },
      {
        [CORE_TASK_NAMES.REMINDERS_RESYNC]: registerTask(CORE_TASK_NAMES.REMINDERS_RESYNC, (payload) =>
          handleRemindersResyncTask(dataPool, payload, send),
        ),
      },
    );

    expect(calls.map((call) => [call.target.deviceToken, call.data])).toEqual([
      [device.deviceToken, { kind: "remindersResync" }],
    ]);
    expect(await resyncJobs()).toEqual([]);
  });

  it("writes no notifications row and no push_deliveries row", async () => {
    const before = await tableCounts();

    await run(pushed, { tenantId: pushed.tenantId }, sender().send);

    expect(await tableCounts()).toEqual(before);
  });

  it("revokes the registration that APNs answers permanently and still pushes to the others", async () => {
    const [first, second] = pushed.ios;
    const { send, calls } = sender({
      [first!.deviceToken]: { outcome: "permanent-failure", error: new Error("410 Unregistered") },
    });

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([first!.deviceToken, pushed.revokedIos.deviceToken].sort());
    expect(await revokedTokens()).not.toContain(second!.deviceToken);
  });

  it("fails the job after trying every registration when one answer is transient, and revokes nothing more", async () => {
    const [first] = pushed.ios;
    const { send, calls } = sender({ [first!.deviceToken]: { outcome: "transient-failure", error: new Error("503") } });

    await expect(run(pushed, { tenantId: pushed.tenantId }, send)).rejects.toBeInstanceOf(AggregateError);

    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([pushed.revokedIos.deviceToken]);
  });

  it("neither revokes nor fails when APNs is not configured, and tries every registration", async () => {
    const { send, calls } = sender({
      [pushed.ios[0]!.deviceToken]: { outcome: "not-configured", reason: "no key" },
      [pushed.ios[1]!.deviceToken]: { outcome: "not-configured", reason: "no key" },
    });

    await run(pushed, { tenantId: pushed.tenantId }, send);

    expect(calls).toHaveLength(2);
    expect(await revokedTokens()).toEqual([pushed.revokedIos.deviceToken]);
  });

  it("completes and attempts no push for a tenant whose user has no registered device", async () => {
    const bare = await seededTenant();
    const { send, calls } = sender();

    await run(bare, { tenantId: bare.tenantId }, send);

    expect(calls).toEqual([]);
  });

  it("completes and attempts no push for a user with only macOS, Web Push and revoked registrations", async () => {
    const t = await seededTenant();
    await register(t, "macos");
    const revoked = await register(t, "ios");
    await withTransaction(dataPool, (client) =>
      runInTenant(t.tenantId, () =>
        revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: revoked.deviceToken }),
      ),
    );
    const { send, calls } = sender();

    await run(t, { tenantId: t.tenantId }, send);

    expect(calls).toEqual([]);
  });

  it("completes and attempts no push for a tenant that has no user", async () => {
    const tenantId = await createTestTenant(adminPool);
    const { send, calls } = sender();

    await runInTenant(tenantId, () => handleRemindersResyncTask(dataPool, { tenantId }, send));

    expect(calls).toEqual([]);
  });

  it("pushes only to the registrations of its own tenant", async () => {
    const stranger = await pushedTenant();
    const { send, calls } = sender();

    await run(pushed, { tenantId: pushed.tenantId }, send);

    const touched = calls.map((call) => call.target.deviceToken);
    for (const registration of stranger.ios) expect(touched).not.toContain(registration.deviceToken);
  });

  it("sends nothing when the payload names another tenant than the job runs in", async () => {
    const stranger = await pushedTenant();
    const { send, calls } = sender();

    await run(pushed, { tenantId: stranger.tenantId }, send);

    expect(calls).toEqual([]);
  });

  it("sends nothing when it runs outside a tenant scope", async () => {
    const { send, calls } = sender();

    await runAsSystem("reminders resync test without a tenant", () =>
      handleRemindersResyncTask(dataPool, { tenantId: pushed.tenantId }, send),
    );

    expect(calls).toEqual([]);
  });

  it.each([
    ["an empty object", {}],
    ["a payload with another key", { tenantId: randomUUID(), userId: randomUUID() }],
    ["a tenant id that is not a uuid", { tenantId: "tenant" }],
  ])("fails the job for a payload that is %s", async (_name, payload) => {
    const { send, calls } = sender();

    await expect(run(pushed, payload, send)).rejects.toThrow();

    expect(calls).toEqual([]);
  });

  it("is wired to the APNs background push by default and revokes what that answers with 410", async () => {
    vi.mocked(apnsAdapter.sendApnsBackgroundPush).mockImplementation(async (target) =>
      target.deviceToken === pushed.ios[0]!.deviceToken
        ? { outcome: "permanent-failure", error: new Error("410 Unregistered") }
        : { outcome: "delivered" },
    );

    await runInTenant(pushed.tenantId, () => handleRemindersResyncTask(dataPool, { tenantId: pushed.tenantId }));

    expect(
      vi
        .mocked(apnsAdapter.sendApnsBackgroundPush)
        .mock.calls.map(([target, data]) => [target.deviceToken, data])
        .sort(),
    ).toEqual(pushed.ios.map((registration) => [registration.deviceToken, { kind: "remindersResync" }]).sort());
    expect(await revokedTokens()).toContain(pushed.ios[0]!.deviceToken);
  });
});

describe("enqueueRemindersResync (issue gh-1879)", () => {
  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
    await clearJobs();
  });

  it("is the job of the tenant under the key reminders-resync:<tenantId>", async () => {
    await inTenant(tenant.tenantId, (client) => enqueueRemindersResync(client, tenant.tenantId));

    expect((await resyncJobs()).map((job) => job.key)).toEqual([`reminders-resync:${tenant.tenantId}`]);
  });

  it("leaves no job when its own transaction rolls back", async () => {
    await expect(
      inTenant(tenant.tenantId, async (client) => {
        await enqueueRemindersResync(client, tenant.tenantId);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await resyncJobs()).toEqual([]);
  });
});
