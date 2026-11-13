import { randomUUID } from "node:crypto";
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
import { sleepNightPut } from "../sleep/sleepRouteHandlers.js";
import { lockSleepNight } from "../sleep/sleepWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// A seeded tenant has the settings item (enabled, prepReminder 30 minutes before bed) and two plans: wake days
// mon to fri from 23:00 to 06:45 with the alarm, and sat and sun from 00:00 to 08:30 without it. Its time zone is
// Europe/Prague, which is at +02:00 on the dates below. 2026-10-16 is a Friday, so its night is a weekend night.

const USER = { writerKind: "user" } as const;
const NIGHT = "2026-10-16";

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
type Night = z.infer<typeof nightSchema>;

const putResponseSchema = z.object({ night: nightSchema.nullable() }).strict();

interface SleepTenant {
  tenantId: string;
  settingsDatabaseId: string;
  plansDatabaseId: string;
  nightsDatabaseId: string;
  settingsItemId: string;
  weekdays: { id: string };
  weekend: { id: string };
}

interface ExceptionRow {
  id: string;
  properties: Record<string, unknown>;
  deleted_at: string | null;
  updated_at: string;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: SleepTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** Calls the route handler as the adapter does: inside the tenant's scope, with the path parameter and the body. */
function rawPut(tenantId: string, night: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return runInTenant(tenantId, () =>
    sleepNightPut(dataPool)({ params: { night }, body, identity: { user: { id: randomUUID() } } }),
  );
}

/** The 200 answer of the route, parsed from what JSON carries so a value JSON cannot represent would be noticed. */
async function put(tenantId: string, night: string, body: unknown): Promise<Night | null> {
  const result = await rawPut(tenantId, night, body);
  expect(result.status).toBe(200);
  return putResponseSchema.parse(JSON.parse(JSON.stringify(result.body))).night;
}

async function putNight(tenantId: string, night: string, body: unknown): Promise<Night> {
  const resolved = await put(tenantId, night, body);
  if (!resolved) throw new Error(`The night ${night} did not resolve`);
  return resolved;
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
    const { rows } = await client.query<{ id: string; properties: { wakeDays: string[] } }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [plansDatabaseId],
    );
    return rows;
  });
  const plan = (day: string) => {
    const found = plans.find((row) => row.properties.wakeDays.includes(day));
    if (!found) throw new Error(`No seeded plan wakes on ${day}`);
    return { id: found.id };
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

/** Every item of the tenant's night database for `night`, trashed ones included. */
function exceptionsOf(t: SleepTenant, night: string): Promise<ExceptionRow[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<ExceptionRow>(
      `SELECT id, properties, deleted_at::text AS deleted_at, updated_at::text AS updated_at
         FROM items WHERE database_id = $1 AND properties ->> 'night' = $2 ORDER BY id`,
      [t.nightsDatabaseId, night],
    );
    return rows;
  });
}

async function soleException(t: SleepTenant, night: string): Promise<ExceptionRow> {
  const rows = await exceptionsOf(t, night);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("unreachable");
  return row;
}

function trash(t: SleepTenant, databaseId: string, itemId: string): Promise<unknown> {
  return runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId, undefined, USER));
}

function patch(t: SleepTenant, databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) {
  return runInTenant(t.tenantId, () =>
    createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, USER),
  );
}

async function planProperties(t: SleepTenant, planId: string): Promise<Record<string, unknown>> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE id = $1",
      [planId],
    );
    return rows[0]?.properties ?? {};
  });
}

describe("PUT /api/sleep/nights/:night (issue gh-1835)", () => {
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

  it("creates the exception for a changed wake time and keeps the weekend plan as it was", async () => {
    const before = await planProperties(tenant, tenant.weekend.id);

    const night = await putNight(tenant.tenantId, NIGHT, { wakeTime: "07:30" });

    expect(night).toMatchObject({
      night: NIGHT,
      planId: tenant.weekend.id,
      bedTime: "00:00",
      wakeTime: "07:30",
      alarm: false,
      changed: true,
      bedAt: "2026-10-17T00:00:00+02:00",
      wakeAt: "2026-10-17T07:30:00+02:00",
    });
    expect((await soleException(tenant, NIGHT)).properties).toEqual({ night: NIGHT, wakeTime: "07:30" });
    expect(await planProperties(tenant, tenant.weekend.id)).toEqual(before);
    expect(before).toMatchObject({ bedTime: "00:00", wakeTime: "08:30" });
  });

  it("patches the one exception for a second field, keeping the first and computing the reminder from the new bedtime", async () => {
    await put(tenant.tenantId, NIGHT, { wakeTime: "07:30" });

    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "23:30" });

    expect(night).toMatchObject({
      bedTime: "23:30",
      wakeTime: "07:30",
      changed: true,
      bedAt: "2026-10-16T23:30:00+02:00",
      prepReminderAt: "2026-10-16T23:00:00+02:00",
    });
    expect((await soleException(tenant, NIGHT)).properties).toEqual({
      night: NIGHT,
      wakeTime: "07:30",
      bedTime: "23:30",
    });
  });

  it("puts a bedtime after midnight on the next calendar day", async () => {
    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "01:30" });

    expect(night.bedAt).toBe("2026-10-17T01:30:00+02:00");
  });

  it("overrides the alarm of the plan with true and with false", async () => {
    expect(await putNight(tenant.tenantId, NIGHT, { alarm: true })).toMatchObject({ alarm: true, changed: true });
    expect(await putNight(tenant.tenantId, NIGHT, { alarm: false })).toMatchObject({ alarm: false, changed: true });
    expect((await soleException(tenant, NIGHT)).properties).toMatchObject({ alarm: false });
  });

  it("stores a time that omits the leading zero in the zero-padded form", async () => {
    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "6:45" });

    expect(night.bedTime).toBe("06:45");
    expect((await soleException(tenant, NIGHT)).properties).toMatchObject({ bedTime: "06:45" });
  });

  it("writes nothing when every provided field equals the stored one, also in the unpadded spelling", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "06:45", alarm: true });
    const before = await soleException(tenant, NIGHT);

    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "6:45", alarm: true });

    expect(night).toMatchObject({ bedTime: "06:45", alarm: true });
    expect(await soleException(tenant, NIGHT)).toEqual(before);
  });

  it("writes nothing for an empty body and answers the night as it resolves", async () => {
    await put(tenant.tenantId, NIGHT, { wakeTime: "07:30" });
    const before = await soleException(tenant, NIGHT);

    const night = await putNight(tenant.tenantId, NIGHT, {});

    expect(night).toMatchObject({ wakeTime: "07:30", changed: true });
    expect(await soleException(tenant, NIGHT)).toEqual(before);
  });

  it("resets a night to its plan with every field null and keeps the exception with all fields null", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "23:30", wakeTime: "07:30", alarm: true });
    const created = await soleException(tenant, NIGHT);

    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: null, wakeTime: null, alarm: null });

    expect(night).toMatchObject({ planId: tenant.weekend.id, bedTime: "00:00", wakeTime: "08:30", alarm: false });
    expect(night.changed).toBe(false);
    const kept = await soleException(tenant, NIGHT);
    expect(kept.id).toBe(created.id);
    expect(kept.deleted_at).toBeNull();
    expect(kept.properties).toEqual({ night: NIGHT, bedTime: null, wakeTime: null, alarm: null });
  });

  it("makes one field follow the plan again with null and leaves the others as they are", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "23:30", wakeTime: "07:30" });

    const night = await putNight(tenant.tenantId, NIGHT, { wakeTime: null });

    expect(night).toMatchObject({ bedTime: "23:30", wakeTime: "08:30", changed: true });
  });

  it("creates no item for a night without one when every field is null", async () => {
    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: null, wakeTime: null, alarm: null });

    expect(night).toMatchObject({ planId: tenant.weekend.id, changed: false });
    expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
  });

  it("creates no item for a night without one when the body is empty", async () => {
    await putNight(tenant.tenantId, NIGHT, {});

    expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
  });

  it("creates the item with the null fields of the body beside the non-null ones", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "22:15", wakeTime: null });

    expect((await soleException(tenant, NIGHT)).properties).toEqual({ night: NIGHT, bedTime: "22:15", wakeTime: null });
  });

  it("answers a night without a plan from 23:00 and 07:00 with the changed field, and planId null", async () => {
    await trash(tenant, tenant.plansDatabaseId, tenant.weekdays.id);
    await trash(tenant, tenant.plansDatabaseId, tenant.weekend.id);

    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "22:00" });

    expect(night).toMatchObject({
      planId: null,
      planName: null,
      bedTime: "22:00",
      wakeTime: "07:00",
      alarm: false,
      changed: true,
      bedAt: "2026-10-16T22:00:00+02:00",
      wakeAt: "2026-10-17T07:00:00+02:00",
    });
  });

  it("answers null and creates no item for a night without a plan when every field is null", async () => {
    await trash(tenant, tenant.plansDatabaseId, tenant.weekdays.id);
    await trash(tenant, tenant.plansDatabaseId, tenant.weekend.id);

    expect(await put(tenant.tenantId, NIGHT, { bedTime: null })).toBeNull();
    expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
  });

  it("accepts an exception for a night in the past and one in the future", async () => {
    expect(await putNight(tenant.tenantId, "1999-01-01", { wakeTime: "09:00" })).toMatchObject({
      night: "1999-01-01",
      wakeTime: "09:00",
      changed: true,
    });
    expect(await putNight(tenant.tenantId, "2099-12-31", { wakeTime: "09:00" })).toMatchObject({
      night: "2099-12-31",
      wakeTime: "09:00",
      changed: true,
    });
  });

  it("does not step the times in 5 or 15 minutes", async () => {
    expect(await putNight(tenant.tenantId, NIGHT, { bedTime: "23:07" })).toMatchObject({ bedTime: "23:07" });
  });

  it("ignores a deleted exception of the night and creates a new one", async () => {
    await put(tenant.tenantId, NIGHT, { wakeTime: "07:30" });
    const old = await soleException(tenant, NIGHT);
    await trash(tenant, tenant.nightsDatabaseId, old.id);

    const night = await putNight(tenant.tenantId, NIGHT, { bedTime: "22:00" });

    expect(night).toMatchObject({ bedTime: "22:00", wakeTime: "08:30" });
    const rows = await exceptionsOf(tenant, NIGHT);
    expect(rows.filter((row) => row.deleted_at === null)).toHaveLength(1);
    expect(rows.filter((row) => row.deleted_at !== null).map((row) => row.id)).toEqual([old.id]);
  });

  it("patches an exception that was created through the generic API", async () => {
    const created = await runInTenant(tenant.tenantId, () =>
      createChokePoint(dataPool).createItem(
        { databaseId: tenant.nightsDatabaseId, properties: { night: NIGHT, bedTime: "21:00" } },
        undefined,
        undefined,
        USER,
      ),
    );

    const night = await putNight(tenant.tenantId, NIGHT, { wakeTime: "07:30" });

    expect(night).toMatchObject({ bedTime: "21:00", wakeTime: "07:30" });
    expect((await soleException(tenant, NIGHT)).id).toBe(created.id);
  });

  it("leaves one item when two PUTs for the same night run at once, and applies both of them", async () => {
    // A holder takes the per-night lock; the test lets it go only after both PUTs wait for that lock, so the two
    // requests really overlap. Without the lock in the handler the second PUT would create after the first one
    // committed and be refused with 409 duplicate_item by the create hook, so the test requires both to succeed.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
      await lockSleepNight(client, NIGHT);
      signalLocked();
      await released;
    });
    let settled: Promise<PromiseSettledResult<unknown>[]>;
    try {
      await locked;
      settled = Promise.allSettled([
        rawPut(tenant.tenantId, NIGHT, { bedTime: "23:30" }),
        rawPut(tenant.tenantId, NIGHT, { wakeTime: "07:30" }),
      ]);
      await waitFor(async () => (await sessionsWaitingForNightLock()) === 2, "both PUTs to wait for the night lock");
    } finally {
      release();
      await holder;
    }
    const results = await settled;

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await soleException(tenant, NIGHT)).properties).toMatchObject({ bedTime: "23:30", wakeTime: "07:30" });
  });

  it("writes nothing when a field the exception does not hold is sent as null", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "21:00" });
    const before = await soleException(tenant, NIGHT);

    const night = await putNight(tenant.tenantId, NIGHT, { wakeTime: null });

    expect(night).toMatchObject({ bedTime: "21:00", wakeTime: "08:30", changed: true });
    // The row keeps its properties, without a wakeTime key, and its version.
    expect(await soleException(tenant, NIGHT)).toEqual(before);
    expect(before.properties).toEqual({ night: NIGHT, bedTime: "21:00" });
  });

  describe("a generic update of an exception that names night", () => {
    /** Holds the lock of `NIGHT` in an open transaction until `release` is called. */
    async function holdNightLock(): Promise<{ release: () => Promise<void> }> {
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let signalLocked: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const holder = withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
        await lockSleepNight(client, NIGHT);
        signalLocked();
        await gate;
      });
      await locked;
      return {
        release: async () => {
          letGo();
          await holder;
        },
      };
    }

    /** Whether another backend can lock the row at once; a row that a transaction holds fails `NOWAIT`. */
    async function rowIsFree(itemId: string): Promise<boolean> {
      try {
        await withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
          await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE NOWAIT", [itemId]);
        });
        return true;
      } catch (thrown) {
        if (z.object({ code: z.literal("55P03") }).safeParse(thrown).success) return false;
        throw thrown;
      }
    }

    it("waits for the lock of the night before it locks the row, as the PUT does", async () => {
      await put(tenant.tenantId, NIGHT, { bedTime: "23:30" });
      const exception = await soleException(tenant, NIGHT);
      const holder = await holdNightLock();
      let rowFreeWhileWaiting: boolean;
      let update: Promise<unknown>;
      try {
        update = patch(tenant, tenant.nightsDatabaseId, exception.id, { night: NIGHT, wakeTime: "07:30" });
        await waitFor(async () => (await sessionsWaitingForNightLock()) === 1, "the update to wait for the night lock");
        // An update that locked the row first would hold it here while it waits for the lock, and a PUT that holds
        // the lock and waits for the row would deadlock with it.
        rowFreeWhileWaiting = await rowIsFree(exception.id);
      } finally {
        await holder.release();
      }
      await update;

      expect(rowFreeWhileWaiting).toBe(true);
      expect((await soleException(tenant, NIGHT)).properties).toEqual({
        night: NIGHT,
        bedTime: "23:30",
        wakeTime: "07:30",
      });
    });

    it("does not wait for the lock of the night when the patch leaves night alone", async () => {
      await put(tenant.tenantId, NIGHT, { bedTime: "23:30" });
      const exception = await soleException(tenant, NIGHT);
      const holder = await holdNightLock();
      try {
        const outcome = await Promise.race([
          patch(tenant, tenant.nightsDatabaseId, exception.id, { wakeTime: "07:30" }).then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("waited"), 5_000)),
        ]);
        expect(outcome).toBe("done");
      } finally {
        await holder.release();
      }
    });

    it("refuses a night that is not a date with 400 naming night", async () => {
      await put(tenant.tenantId, NIGHT, { bedTime: "23:30" });
      const exception = await soleException(tenant, NIGHT);

      await expect(patch(tenant, tenant.nightsDatabaseId, exception.id, { night: "2026-13-01" })).rejects.toMatchObject(
        { status: 400, code: "validation_failed", details: { field: "night" } },
      );
      expect((await soleException(tenant, NIGHT)).properties).toEqual({ night: NIGHT, bedTime: "23:30" });
    });

    it("ends neither of a PUT and an update naming night that overlap with a deadlock", async () => {
      for (let day = 1; day <= 6; day += 1) {
        const night = `2026-11-0${day}`;
        await put(tenant.tenantId, night, { bedTime: "23:30" });
        const exception = await soleException(tenant, night);

        const results = await Promise.allSettled([
          rawPut(tenant.tenantId, night, { wakeTime: "07:30" }),
          patch(tenant, tenant.nightsDatabaseId, exception.id, { night, alarm: true }),
          rawPut(tenant.tenantId, night, { alarm: true }),
          patch(tenant, tenant.nightsDatabaseId, exception.id, { night, bedTime: "22:45" }),
        ]);

        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
        expect((await soleException(tenant, night)).properties).toEqual({
          night,
          bedTime: "22:45",
          wakeTime: "07:30",
          alarm: true,
        });
      }
    });
  });

  it("refuses an impossible date with 400 naming night, and writes nothing", async () => {
    await expect(rawPut(tenant.tenantId, "2026-13-01", { wakeTime: "07:30" })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "night" },
    });
    await expect(rawPut(tenant.tenantId, "2026-02-30", { wakeTime: "07:30" })).rejects.toMatchObject({
      status: 400,
      details: { field: "night" },
    });
    await expect(rawPut(tenant.tenantId, "tomorrow", {})).rejects.toMatchObject({
      status: 400,
      details: { field: "night" },
    });
    expect(await exceptionsOf(tenant, "2026-13-01")).toEqual([]);
  });

  it.each([
    ["a wake time of 7:5", { wakeTime: "7:5" }, "wakeTime"],
    ["a bedtime of 25:00", { bedTime: "25:00" }, "bedTime"],
    ["a bedtime of 24:00", { bedTime: "24:00" }, "bedTime"],
    ["an empty wake time", { wakeTime: "" }, "wakeTime"],
    ["a numeric bedtime", { bedTime: 2300 }, "bedTime"],
    ["a string alarm", { alarm: "true" }, "alarm"],
    ["an alarm of 1", { alarm: 1 }, "alarm"],
    ["a key that is not a field", { wakeTime: "07:30", note: "x" }, "note"],
    ["a null body", null, "body"],
    ["an array body", [], "body"],
    ["a string body", "07:30", "body"],
  ])("refuses %s with 400 validation_failed naming %s, and writes nothing", async (_name, body, field) => {
    await expect(rawPut(tenant.tenantId, NIGHT, body)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field },
    });
    expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
  });

  it("refuses a bad body before it reads anything, also for a tenant without a sleep module", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(rawPut(bare, NIGHT, { wakeTime: "7:5" })).rejects.toMatchObject({
      status: 400,
      details: { field: "wakeTime" },
    });
  });

  it("answers 404 for a tenant that has no sleep module", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(rawPut(bare, NIGHT, { wakeTime: "07:30" })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("rolls the write back when the night cannot be resolved afterwards", async () => {
    // A tenant whose settings item was deleted: the read of the resolved night answers 404 after the write. The
    // choke point refuses to delete the system-active settings item, so the state is made with SQL.
    await withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
      await client.query("UPDATE items SET deleted_at = now() WHERE id = $1", [tenant.settingsItemId]);
    });

    await expect(rawPut(tenant.tenantId, NIGHT, { wakeTime: "07:30" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
  });

  it("changes only the exception of its own tenant for the same night, through the runtime role", async () => {
    const other = await seededTenant();
    await put(other.tenantId, NIGHT, { bedTime: "21:17", wakeTime: "06:11" });
    const otherBefore = await soleException(other, NIGHT);

    const own = await putNight(tenant.tenantId, NIGHT, { wakeTime: "07:30" });

    expect(own).toMatchObject({ bedTime: "00:00", wakeTime: "07:30", planId: tenant.weekend.id });
    expect(JSON.stringify(own)).not.toContain("21:17");
    expect(JSON.stringify(own)).not.toContain(other.weekend.id);
    expect(await soleException(other, NIGHT)).toEqual(otherBefore);
    expect((await soleException(tenant, NIGHT)).properties).toEqual({ night: NIGHT, wakeTime: "07:30" });
    const foreign = await putNight(other.tenantId, NIGHT, {});
    expect(foreign).toMatchObject({ bedTime: "21:17", wakeTime: "06:11", planId: other.weekend.id });
    expect(JSON.stringify(foreign)).not.toContain(tenant.weekend.id);
  });

  it("updates the version of the exception on a change and keeps a plan edit visible in the answer", async () => {
    await put(tenant.tenantId, NIGHT, { bedTime: "23:30" });
    const created = await soleException(tenant, NIGHT);
    await patch(tenant, tenant.plansDatabaseId, tenant.weekend.id, { wakeTime: "09:00" });

    const night = await putNight(tenant.tenantId, NIGHT, { alarm: true });

    expect(night).toMatchObject({ bedTime: "23:30", wakeTime: "09:00", alarm: true });
    const changed = await soleException(tenant, NIGHT);
    expect(changed.id).toBe(created.id);
    expect(changed.updated_at).not.toBe(created.updated_at);
  });
});

/** The sessions of the test database that wait for a per-night advisory lock. */
async function sessionsWaitingForNightLock(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%sleepNight:%'`,
  );
  return rows[0]?.n ?? 0;
}

/** Polls `condition` until it holds, and fails with `what` after 10 seconds. */
async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
