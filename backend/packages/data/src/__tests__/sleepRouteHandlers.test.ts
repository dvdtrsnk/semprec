import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { loadSleepNights, sleepNightsGet } from "../sleep/sleepRouteHandlers.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// A seeded tenant has the settings item (enabled, prepReminder 30 minutes before bed, goal 480 minutes, sound
// morning, snooze on, muteSemp on, showInCalendar on) and two plans: wake days mon to fri from 23:00 to 06:45
// with the alarm, and sat and sun from 00:00 to 08:30 without it. Its time zone is Europe/Prague, which is at
// +02:00 on the dates below. 2026-10-15 is a Thursday.

const USER = { writerKind: "user" } as const;
const RANGE = "?from=2026-10-15&to=2026-10-16";

const nightSchema = z
  .object({
    night: z.string(),
    planId: z.string().nullable(),
    planName: z.string().nullable(),
    bedTime: z.string(),
    wakeTime: z.string(),
    alarm: z.boolean(),
    changed: z.boolean(),
    bedAt: z.string(),
    wakeAt: z.string(),
    durationMinutes: z.number(),
    prepReminderAt: z.string().nullable(),
  })
  .strict();

const responseSchema = z
  .object({
    enabled: z.boolean(),
    showInCalendar: z.boolean(),
    muteSemp: z.boolean(),
    alarmSound: z.string(),
    alarmSnooze: z.boolean(),
    timezone: z.string(),
    planCount: z.number(),
    goalMinutes: z.number(),
    nights: z.array(nightSchema),
  })
  .strict();

type SleepResponse = z.infer<typeof responseSchema>;

interface SleepTenant {
  tenantId: string;
  settingsDatabaseId: string;
  plansDatabaseId: string;
  nightsDatabaseId: string;
  settingsItemId: string;
  /** The seeded plans by wake days: `weekdays` is mon to fri, `weekend` is sat and sun. */
  weekdays: { id: string; name: string };
  weekend: { id: string; name: string };
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: SleepTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** Calls the route handler as the adapter does: inside the tenant's scope, with the request URL. */
function request(tenantId: string, query: string): Promise<{ status: number; body: unknown }> {
  return runInTenant(tenantId, () => sleepNightsGet(dataPool)({ req: { url: `/api/sleep/nights${query}` } }));
}

/** The 200 answer of the route, parsed from what JSON carries so a value JSON cannot represent would be noticed. */
async function read(tenantId: string, query: string): Promise<SleepResponse> {
  const result = await request(tenantId, query);
  expect(result.status).toBe(200);
  return responseSchema.parse(JSON.parse(JSON.stringify(result.body)));
}

async function seededTenant(): Promise<SleepTenant> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const databaseId = async (moduleId: string): Promise<string> => {
    const database = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`The tenant has no ${moduleId} database`);
    return database.id;
  };
  const settingsDatabaseId = await databaseId(SLEEP_SETTINGS_MODULE_ID);
  const plansDatabaseId = await databaseId(SLEEP_PLANS_MODULE_ID);
  const plans = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; properties: { name: string; wakeDays: string[] } }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [plansDatabaseId],
    );
    return rows;
  });
  const plan = (day: string) => {
    const found = plans.find((row) => row.properties.wakeDays.includes(day));
    if (!found) throw new Error(`No seeded plan wakes on ${day}`);
    return { id: found.id, name: found.properties.name };
  };
  const settings = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
      settingsDatabaseId,
    ]);
    return rows;
  });
  return {
    tenantId,
    settingsDatabaseId,
    plansDatabaseId,
    nightsDatabaseId: await databaseId(SLEEP_NIGHTS_MODULE_ID),
    settingsItemId: settings[0]?.id ?? "",
    weekdays: plan("mon"),
    weekend: plan("sat"),
  };
}

function create(t: SleepTenant, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(t.tenantId, async () => {
    const item = await createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, USER);
    return item.id;
  });
}

function trash(t: SleepTenant, databaseId: string, itemId: string): Promise<unknown> {
  return runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId, undefined, USER));
}

function patch(t: SleepTenant, databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) {
  return runInTenant(t.tenantId, () =>
    createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, USER),
  );
}

/** A statement that the write rules of the sleep module (issue gh-1784) would refuse, run as the superuser. */
async function rawSql(t: SleepTenant, sql: string, parameters: unknown[]): Promise<void> {
  await withTenantTransaction(adminPool, t.tenantId, async (client) => {
    await client.query(sql, parameters);
  });
}

describe("GET /api/sleep/nights (issue gh-1809)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("answers the settings, the zone, the plan count and the nights of the default plans", async () => {
    const body = await read(tenant.tenantId, RANGE);

    expect(body).toEqual({
      enabled: true,
      showInCalendar: true,
      muteSemp: true,
      alarmSound: "morning",
      alarmSnooze: true,
      timezone: "Europe/Prague",
      planCount: 2,
      goalMinutes: 480,
      nights: [
        {
          night: "2026-10-15",
          planId: tenant.weekdays.id,
          planName: tenant.weekdays.name,
          bedTime: "23:00",
          wakeTime: "06:45",
          alarm: true,
          changed: false,
          bedAt: "2026-10-15T23:00:00+02:00",
          wakeAt: "2026-10-16T06:45:00+02:00",
          durationMinutes: 465,
          prepReminderAt: "2026-10-15T22:30:00+02:00",
        },
        {
          night: "2026-10-16",
          planId: tenant.weekend.id,
          planName: tenant.weekend.name,
          bedTime: "00:00",
          wakeTime: "08:30",
          alarm: false,
          changed: false,
          bedAt: "2026-10-17T00:00:00+02:00",
          wakeAt: "2026-10-17T08:30:00+02:00",
          durationMinutes: 510,
          prepReminderAt: "2026-10-16T23:30:00+02:00",
        },
      ],
    });
  });

  it("answers enabled false with the nights computed as before when the plan is switched off", async () => {
    const before = await read(tenant.tenantId, RANGE);
    await patch(tenant, tenant.settingsDatabaseId, tenant.settingsItemId, { enabled: false });

    const after = await read(tenant.tenantId, RANGE);

    expect(after.enabled).toBe(false);
    expect(after.nights).toEqual(before.nights);
    expect(after.nights).toHaveLength(2);
  });

  it("answers the settings the item holds and a null reminder when the preparation reminder is off", async () => {
    await patch(tenant, tenant.settingsDatabaseId, tenant.settingsItemId, {
      prepReminder: false,
      showInCalendar: false,
      muteSemp: false,
      alarmSnooze: false,
      alarmSound: "piano",
      goalMinutes: 540,
    });

    const body = await read(tenant.tenantId, RANGE);

    expect(body).toMatchObject({
      showInCalendar: false,
      muteSemp: false,
      alarmSnooze: false,
      alarmSound: "piano",
      goalMinutes: 540,
    });
    expect(body.nights.map((night) => night.prepReminderAt)).toEqual([null, null]);
  });

  it("applies the exceptions on both ends of the range and marks the nights changed", async () => {
    await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-15", bedTime: "22:00", alarm: false });
    await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-16", wakeTime: "09:15" });

    const { nights } = await read(tenant.tenantId, RANGE);

    expect(nights.map((night) => [night.night, night.changed, night.bedTime, night.wakeTime, night.alarm])).toEqual([
      ["2026-10-15", true, "22:00", "06:45", false],
      ["2026-10-16", true, "00:00", "09:15", false],
    ]);
  });

  it("leaves out a night exception of the range that was deleted", async () => {
    const exceptionId = await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-15", bedTime: "21:00" });
    await trash(tenant, tenant.nightsDatabaseId, exceptionId);

    const { nights } = await read(tenant.tenantId, RANGE);

    expect(nights[0]).toMatchObject({ night: "2026-10-15", changed: false, bedTime: "23:00" });
  });

  it("ignores the exceptions of the nights next to the range", async () => {
    await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-14", bedTime: "21:00" });
    await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-17", bedTime: "21:30" });

    const { nights } = await read(tenant.tenantId, RANGE);

    expect(nights.map((night) => [night.night, night.changed, night.bedTime])).toEqual([
      ["2026-10-15", false, "23:00"],
      ["2026-10-16", false, "00:00"],
    ]);
  });

  it("counts and uses only the non-deleted plans", async () => {
    await trash(tenant, tenant.plansDatabaseId, tenant.weekend.id);

    const body = await read(tenant.tenantId, RANGE);

    expect(body.planCount).toBe(1);
    // The weekend plan is gone and no exception names the night, so the night of 2026-10-16 is left out.
    expect(body.nights.map((night) => [night.night, night.planId])).toEqual([["2026-10-15", tenant.weekdays.id]]);
  });

  it("reads a plan that holds only the keys the write rules require", async () => {
    await trash(tenant, tenant.plansDatabaseId, tenant.weekdays.id);
    const bare = await create(tenant, tenant.plansDatabaseId, { name: "Bare", bedTime: "22:00", wakeTime: "06:00" });
    const friday = await create(tenant, tenant.plansDatabaseId, {
      name: "Friday only",
      bedTime: "21:30",
      wakeTime: "05:30",
      wakeDays: ["fri"],
    });

    const body = await read(tenant.tenantId, RANGE);

    // `Bare` has no wake days, so it matches no night. `Friday only` has no alarm and no position: the alarm is off.
    expect(body.planCount).toBe(3);
    expect(body.nights.map((night) => night.planId)).not.toContain(bare);
    expect(body.nights[0]).toMatchObject({
      night: "2026-10-15",
      planId: friday,
      planName: "Friday only",
      bedTime: "21:30",
      alarm: false,
    });
  });

  it("reads the wall-clock times in the time zone of the tenant", async () => {
    await withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
      await client.query(
        'UPDATE items SET properties = properties || \'{"timezone": "America/New_York"}\' WHERE id = $1',
        [await getSystemSettingsItemId(client)],
      );
    });

    const body = await read(tenant.tenantId, "?from=2026-10-15&to=2026-10-15");

    expect(body.timezone).toBe("America/New_York");
    expect(body.nights[0]).toMatchObject({
      bedAt: "2026-10-15T23:00:00-04:00",
      wakeAt: "2026-10-16T06:45:00-04:00",
      prepReminderAt: "2026-10-15T22:30:00-04:00",
    });
  });

  it("answers a range of 62 nights and refuses one of 63", async () => {
    const full = await read(tenant.tenantId, "?from=2026-09-01&to=2026-11-01");
    expect(full.nights).toHaveLength(62);

    await expect(request(tenant.tenantId, "?from=2026-09-01&to=2026-11-02")).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "to" },
    });
  });

  it("answers a range of one night", async () => {
    const body = await read(tenant.tenantId, "?from=2026-10-16&to=2026-10-16");

    expect(body.nights.map((night) => night.night)).toEqual(["2026-10-16"]);
  });

  it.each([
    ["from after to", "?from=2026-10-17&to=2026-10-16", "from"],
    ["a from that is no date", "?from=abc&to=2026-10-16", "from"],
    ["a from that does not exist", "?from=2026-02-30&to=2026-03-01", "from"],
    ["a from with a time", "?from=2026-10-15T10:00&to=2026-10-16", "from"],
    ["a to that is no date", "?from=2026-10-15&to=16.10.2026", "to"],
    ["a to that does not exist", "?from=2026-10-15&to=2026-13-01", "to"],
    ["an empty to", "?from=2026-10-15&to=", "to"],
    ["a missing from", "?to=2026-10-16", "from"],
    ["a missing to", "?from=2026-10-15", "to"],
    ["no query string", "", "from"],
  ])("refuses %s with 400 validation_failed", async (_name, query, field) => {
    await expect(request(tenant.tenantId, query)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field },
    });
  });

  it("refuses a request without a URL like one without a query string", async () => {
    await expect(runInTenant(tenant.tenantId, () => sleepNightsGet(dataPool)({ req: {} }))).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "from" },
    });
  });

  it("refuses a bad range before it reads anything, also for a tenant without a sleep module", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(inTenant(bare, (client) => loadSleepNights(client, { from: "x", to: "y" }))).rejects.toMatchObject({
      status: 400,
      details: { field: "from" },
    });
  });

  it("answers 404 for a tenant that has no sleep module", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(request(bare, RANGE)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("answers 404 for a tenant whose settings item was deleted", async () => {
    await rawSql(tenant, "UPDATE items SET deleted_at = now() WHERE id = $1", [tenant.settingsItemId]);

    await expect(request(tenant.tenantId, RANGE)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("fails when the tenant has two settings items", async () => {
    await rawSql(tenant, `INSERT INTO items (database_id, properties) VALUES ($1, '{"enabled": true}')`, [
      tenant.settingsDatabaseId,
    ]);

    await expect(request(tenant.tenantId, RANGE)).rejects.toThrow("Expected one sleep settings item, found 2");
  });

  it("fails with a ZodError when the settings item holds a value of the wrong type", async () => {
    await rawSql(tenant, `UPDATE items SET properties = properties || '{"enabled": "yes"}' WHERE id = $1`, [
      tenant.settingsItemId,
    ]);

    await expect(request(tenant.tenantId, RANGE)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("fails with a ZodError when a stored plan has no bedtime", async () => {
    await rawSql(tenant, `UPDATE items SET properties = properties - 'bedTime' WHERE id = $1`, [tenant.weekdays.id]);

    await expect(request(tenant.tenantId, RANGE)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("answers from the state at its start when a plan edit commits between its settings read and its plans read", async () => {
    // Wraps the connection the route reads on: right after the statement that reads the settings item, a plan
    // edit commits on another connection. Under READ COMMITTED the plans statement would see the edit.
    let edited = false;
    const interleavingPool = {
      connect: async () => {
        const client = await dataPool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        client.query = (async (...args: unknown[]) => {
          const result = await query(...args);
          if (!edited && typeof args[0] === "string" && args[0].includes("FROM items")) {
            edited = true;
            await patch(tenant, tenant.plansDatabaseId, tenant.weekdays.id, { bedTime: "21:00" });
          }
          return result;
        }) as typeof client.query;
        return client;
      },
    } as unknown as Pool;

    const result = await runInTenant(tenant.tenantId, () =>
      sleepNightsGet(interleavingPool)({ req: { url: `/api/sleep/nights${RANGE}` } }),
    );

    expect(edited).toBe(true);
    const old = responseSchema.parse(JSON.parse(JSON.stringify(result.body)));
    expect(old.nights.map((night) => night.bedTime)).toEqual(["23:00", "00:00"]);
    const next = await read(tenant.tenantId, RANGE);
    expect(next.nights.map((night) => night.bedTime)).toEqual(["21:00", "00:00"]);
  });

  it("shows a tenant only its own plans, exceptions and settings, through the runtime role", async () => {
    const other = await seededTenant();
    await trash(other, other.plansDatabaseId, other.weekdays.id);
    await trash(other, other.plansDatabaseId, other.weekend.id);
    const nightShift = await create(other, other.plansDatabaseId, {
      name: "Night shift",
      bedTime: "08:00",
      wakeTime: "16:00",
      wakeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      position: 0,
    });
    await create(other, other.nightsDatabaseId, { night: "2026-10-16", bedTime: "07:00" });
    await patch(other, other.settingsDatabaseId, other.settingsItemId, { goalMinutes: 540 });
    await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-15", bedTime: "21:17" });

    const own = await read(tenant.tenantId, RANGE);
    const foreign = await read(other.tenantId, RANGE);

    expect(own.planCount).toBe(2);
    expect(own.goalMinutes).toBe(480);
    expect(own.nights.map((night) => night.planId)).toEqual([tenant.weekdays.id, tenant.weekend.id]);
    expect(own.nights.map((night) => night.bedTime)).toEqual(["21:17", "00:00"]);
    expect(foreign.planCount).toBe(1);
    expect(foreign.goalMinutes).toBe(540);
    expect(foreign.nights.map((night) => night.planId)).toEqual([nightShift, nightShift]);
    expect(foreign.nights.map((night) => night.bedTime)).toEqual(["08:00", "07:00"]);
    const foreignText = JSON.stringify(foreign);
    expect([tenant.weekdays.id, tenant.weekend.id, "21:17"].filter((value) => foreignText.includes(value))).toEqual([]);
    const ownText = JSON.stringify(own);
    expect(
      [nightShift, other.weekdays.id, other.weekend.id, "Night shift"].filter((value) => ownText.includes(value)),
    ).toEqual([]);
  });
});
