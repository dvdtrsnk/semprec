import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { prepareItemPreWriteTransforms } from "../chokePoint/hooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { DuplicateItemError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER = { writerKind: "user" } as const;

interface SleepTenant {
  tenantId: string;
  settingsId: string;
  plansId: string;
  nightsId: string;
}

interface StoredItem {
  id: string;
  properties: Record<string, unknown>;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: SleepTenant;
let other: SleepTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** A new tenant seeded as production seeds one, so it has the settings item, the two default plans and no night. */
async function seededTenant(): Promise<SleepTenant> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const databaseId = async (moduleId: string): Promise<string> => {
    const database = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`The tenant has no ${moduleId} database`);
    return database.id;
  };
  return {
    tenantId,
    settingsId: await databaseId(SLEEP_SETTINGS_MODULE_ID),
    plansId: await databaseId(SLEEP_PLANS_MODULE_ID),
    nightsId: await databaseId(SLEEP_NIGHTS_MODULE_ID),
  };
}

function chokePoint(t: SleepTenant) {
  return {
    create: (databaseId: string, properties: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, USER),
      ),
    patch: (databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, USER),
      ),
    trash: (databaseId: string, itemId: string) =>
      runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId, undefined, USER)),
    restore: (databaseId: string, itemId: string) =>
      runInTenant(t.tenantId, () => createChokePoint(dataPool).restoreItem(databaseId, itemId, undefined, USER)),
  };
}

/** The non-deleted items of one database, by id. */
async function liveItems(t: SleepTenant, databaseId: string): Promise<StoredItem[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<StoredItem>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [databaseId],
    );
    return rows;
  });
}

async function storedProperties(t: SleepTenant, databaseId: string, itemId: string): Promise<Record<string, unknown>> {
  const item = (await liveItems(t, databaseId)).find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} is not stored`);
  return item.properties;
}

/**
 * Creates an item through the choke point in a transaction that stays open until `release` is called: `created`
 * resolves once the item is inserted and its create hooks have run, `first` resolves when the transaction has ended.
 */
function holdCreateOpen(t: SleepTenant, databaseId: string, properties: Record<string, unknown>) {
  let signalCreated: () => void = () => {};
  const created = new Promise<void>((resolve) => {
    signalCreated = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runInTenant(t.tenantId, () =>
    withTransaction(dataPool, async (client) => {
      await createItemWithClient(client, { databaseId, properties }, { writer: USER });
      signalCreated();
      await released;
    }),
  );
  return { created, release, first };
}

/**
 * Waits until a transaction of this database waits for an advisory lock. `pg_locks` is the server's own view of
 * that wait, so no timing guess stands in for it.
 */
async function waitForAdvisoryLockWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No transaction waited for an advisory lock");
}

/**
 * Waits until a backend waits for a lock and returns the statements of all backends that wait. `pg_stat_activity`
 * is the server's own view of that wait, so no timing guess stands in for it.
 */
async function waitingStatements(): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if (rows.length > 0) return rows.map((row) => row.query);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No backend waited for a lock");
}

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

async function expectValidationFailure(write: Promise<unknown>, field: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
}

async function expectDuplicate(write: Promise<unknown>, field: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(DuplicateItemError);
  expect(error).toMatchObject({ status: 409, code: "duplicate_item", details: { field } });
}

/**
 * The seeded settings item carries `systemActive`, which the choke point refuses to trash, so a tenant without a
 * live settings item is a state only a raw `UPDATE` produces.
 */
async function trashSeededSettings(t: SleepTenant): Promise<void> {
  const result = await inTenant(t.tenantId, (client) =>
    client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND deleted_at IS NULL", [t.settingsId]),
  );
  expect(result.rowCount).toBe(1);
}

/** The title of a settings item; the seeded one has none, but a user write needs one. */
const SETTINGS_NAME = "Sleep settings";

const PLAN = { name: "Short nights", wakeDays: ["tue"], bedTime: "23:30", wakeTime: "06:00", alarm: true, position: 2 };

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
  tenant = await seededTenant();
  other = await seededTenant();
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("sleep settings values (issue gh-1784)", () => {
  const REFUSED: Array<[string, string, unknown]> = [
    ["goalMinutes 485", "goalMinutes", 485],
    ["goalMinutes null", "goalMinutes", null],
    ["goalMinutes as text", "goalMinutes", "480"],
    ["prepReminderMinutes 20", "prepReminderMinutes", 20],
    ["alarmSound gong", "alarmSound", "gong"],
    ["enabled as text", "enabled", "yes"],
    ["prepReminder as a number", "prepReminder", 1],
    ["muteSemp null", "muteSemp", null],
    ["alarmSnooze as text", "alarmSnooze", "true"],
    ["showInCalendar as text", "showInCalendar", "no"],
  ];

  it.each(REFUSED)("refuses a patch with %s and keeps the stored item", async (_label, field, value) => {
    const [settings] = await liveItems(tenant, tenant.settingsId);
    const patched = chokePoint(tenant).patch(tenant.settingsId, settings!.id, { [field]: value });

    await expectValidationFailure(patched, field);
    expect(await storedProperties(tenant, tenant.settingsId, settings!.id)).toEqual(settings!.properties);
  });

  it.each(REFUSED)("refuses a create with %s and stores nothing", async (_label, field, value) => {
    await trashSeededSettings(tenant);

    await expectValidationFailure(
      chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, [field]: value }),
      field,
    );

    expect(await liveItems(tenant, tenant.settingsId)).toEqual([]);
  });

  it.each([
    ["goalMinutes", [420, 450, 480, 510, 540]],
    ["prepReminderMinutes", [15, 30, 45, 60]],
    ["alarmSound", ["morning", "birds", "piano", "vibrateOnly"]],
    ["enabled", [true, false]],
    ["prepReminder", [true, false]],
    ["muteSemp", [true, false]],
    ["alarmSnooze", [true, false]],
    ["showInCalendar", [true, false]],
  ])("accepts every allowed value of %s", async (field, values) => {
    const [settings] = await liveItems(tenant, tenant.settingsId);
    for (const value of values) {
      await chokePoint(tenant).patch(tenant.settingsId, settings!.id, { [field]: value });
      expect((await storedProperties(tenant, tenant.settingsId, settings!.id))[field]).toBe(value);
    }
  });
});

describe("one sleep settings item (issue gh-1784)", () => {
  it("refuses a second settings item with 409 duplicate_item and stores nothing", async () => {
    const before = await liveItems(tenant, tenant.settingsId);
    expect(before).toHaveLength(1);

    await expectDuplicate(
      chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, enabled: false, goalMinutes: 420 }),
      "sleepSettings",
    );

    expect(await liveItems(tenant, tenant.settingsId)).toEqual(before);
  });

  it("creates the settings item when the tenant has none and then refuses the next one", async () => {
    await trashSeededSettings(tenant);

    const created = await chokePoint(tenant).create(tenant.settingsId, {
      name: SETTINGS_NAME,
      enabled: true,
      goalMinutes: 540,
    });

    expect(await storedProperties(tenant, tenant.settingsId, created.id)).toEqual({
      name: SETTINGS_NAME,
      enabled: true,
      goalMinutes: 540,
    });
    await expectDuplicate(
      chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, enabled: false }),
      "sleepSettings",
    );
    expect(await liveItems(tenant, tenant.settingsId)).toHaveLength(1);
  });

  it("lets exactly one of two concurrent creates win while no settings item is live", async () => {
    await trashSeededSettings(tenant);

    const outcomes = await Promise.allSettled([
      chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, goalMinutes: 420 }),
      chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, goalMinutes: 540 }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DuplicateItemError);
    expect(await liveItems(tenant, tenant.settingsId)).toHaveLength(1);
  });

  it("holds a second creator of the settings item behind the first until it commits, then refuses it", async () => {
    await trashSeededSettings(tenant);
    const { created, release, first } = holdCreateOpen(tenant, tenant.settingsId, { name: SETTINGS_NAME });
    try {
      await created;
      const second = refusal(chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, goalMinutes: 540 }));
      await waitForAdvisoryLockWaiter();
      // Neither creator can see the other's row yet; only the lock keeps the second one out.
      expect(await liveItems(tenant, tenant.settingsId)).toEqual([]);

      release();
      await first;

      const error = await second;
      expect(error).toBeInstanceOf(DuplicateItemError);
      expect(error).toMatchObject({ details: { field: "sleepSettings" } });
      expect(await liveItems(tenant, tenant.settingsId)).toHaveLength(1);
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });

  it("does not hold a creator of the settings item of another tenant behind the open transaction", async () => {
    await trashSeededSettings(tenant);
    await trashSeededSettings(other);
    const { created, release, first } = holdCreateOpen(tenant, tenant.settingsId, { name: SETTINGS_NAME });
    try {
      await created;

      const second = await chokePoint(other).create(other.settingsId, { name: SETTINGS_NAME });

      expect((await liveItems(other, other.settingsId)).map((item) => item.id)).toEqual([second.id]);
    } finally {
      release();
      await first;
    }
  });

  it("does not count a settings item of another tenant", async () => {
    await trashSeededSettings(tenant);

    await chokePoint(tenant).create(tenant.settingsId, { name: SETTINGS_NAME, enabled: true });

    expect(await liveItems(other, other.settingsId)).toHaveLength(1);
    expect(await liveItems(tenant, tenant.settingsId)).toHaveLength(1);
  });
});

describe("sleep plan values (issue gh-1784)", () => {
  const CREATE_REFUSED: Array<[string, string, Record<string, unknown>]> = [
    ["no name", "name", { ...PLAN, name: undefined }],
    ["an empty name", "name", { ...PLAN, name: "" }],
    ["a blank name", "name", { ...PLAN, name: "   " }],
    ["a duplicated wake day", "wakeDays", { ...PLAN, wakeDays: ["mon", "mon"] }],
    ["an unknown wake day", "wakeDays", { ...PLAN, wakeDays: ["funday"] }],
    ["wakeDays that is no array", "wakeDays", { ...PLAN, wakeDays: "mon" }],
    ["no bedTime", "bedTime", { ...PLAN, bedTime: undefined }],
    ["a null bedTime", "bedTime", { ...PLAN, bedTime: null }],
    ["an empty bedTime", "bedTime", { ...PLAN, bedTime: "" }],
    ["bedTime 7:5", "bedTime", { ...PLAN, bedTime: "7:5" }],
    ["bedTime 25:00", "bedTime", { ...PLAN, bedTime: "25:00" }],
    ["bedTime 24:00", "bedTime", { ...PLAN, bedTime: "24:00" }],
    ["bedTime that is no text", "bedTime", { ...PLAN, bedTime: 2300 }],
    ["no wakeTime", "wakeTime", { ...PLAN, wakeTime: undefined }],
    ["a null wakeTime", "wakeTime", { ...PLAN, wakeTime: null }],
    ["wakeTime 24:00", "wakeTime", { ...PLAN, wakeTime: "24:00" }],
    ["wakeTime noon", "wakeTime", { ...PLAN, wakeTime: "noon" }],
    ["alarm as text", "alarm", { ...PLAN, alarm: "yes" }],
    ["a null alarm", "alarm", { ...PLAN, alarm: null }],
    ["position -1", "position", { ...PLAN, position: -1 }],
    ["position 1.5", "position", { ...PLAN, position: 1.5 }],
    ["position as text", "position", { ...PLAN, position: "1" }],
  ];

  it.each(CREATE_REFUSED)("refuses a create with %s and stores nothing", async (_label, field, properties) => {
    const before = await liveItems(tenant, tenant.plansId);

    await expectValidationFailure(chokePoint(tenant).create(tenant.plansId, properties), field);

    expect(await liveItems(tenant, tenant.plansId)).toEqual(before);
  });

  it("stores bedTime 6:45 as 06:45 and wakeTime 7:05 as 07:05 on create", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, { ...PLAN, bedTime: "6:45", wakeTime: "7:05" });

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toMatchObject({
      bedTime: "06:45",
      wakeTime: "07:05",
    });
  });

  it("accepts the edge times 00:00 and 23:59", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, { ...PLAN, bedTime: "0:00", wakeTime: "23:59" });

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toMatchObject({
      bedTime: "00:00",
      wakeTime: "23:59",
    });
  });

  it("accepts a plan with wakeDays []", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, { ...PLAN, wakeDays: [] });

    expect((await storedProperties(tenant, tenant.plansId, created.id)).wakeDays).toEqual([]);
  });

  it("accepts a plan with only a name and the two times", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, {
      name: "Bare",
      bedTime: "22:00",
      wakeTime: "6:00",
    });

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toEqual({
      name: "Bare",
      bedTime: "22:00",
      wakeTime: "06:00",
    });
  });

  it("accepts every weekday and position 0", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, {
      ...PLAN,
      wakeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      position: 0,
    });

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toMatchObject({
      wakeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      position: 0,
    });
  });

  it("stores a patched bedTime 6:45 as 06:45 and leaves the other values", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, PLAN);

    await chokePoint(tenant).patch(tenant.plansId, created.id, { bedTime: "6:45" });

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toEqual({ ...PLAN, bedTime: "06:45" });
  });

  const PATCH_REFUSED: Array<[string, string, Record<string, unknown>]> = [
    ["a blank name", "name", { name: " " }],
    ["a duplicated wake day", "wakeDays", { wakeDays: ["sat", "sat"] }],
    ["bedTime 7:5", "bedTime", { bedTime: "7:5" }],
    ["bedTime 25:00", "bedTime", { bedTime: "25:00" }],
    ["bedTime 24:00", "bedTime", { bedTime: "24:00" }],
    ["a null wakeTime", "wakeTime", { wakeTime: null }],
    ["an empty wakeTime", "wakeTime", { wakeTime: "" }],
    ["alarm as text", "alarm", { alarm: "yes" }],
    ["position -1", "position", { position: -1 }],
  ];

  it.each(PATCH_REFUSED)("refuses a patch with %s and keeps the stored plan", async (_label, field, patch) => {
    const created = await chokePoint(tenant).create(tenant.plansId, PLAN);

    await expectValidationFailure(chokePoint(tenant).patch(tenant.plansId, created.id, patch), field);

    expect(await storedProperties(tenant, tenant.plansId, created.id)).toEqual(PLAN);
  });

  it("judges a patch over the merged plan: a stored plan without wakeTime refuses an unrelated rename", async () => {
    const created = await chokePoint(tenant).create(tenant.plansId, PLAN);
    // A plan without a wake time cannot be written; only a raw update produces the state a legacy row would hold.
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE items SET properties = properties - 'wakeTime' WHERE id = $1", [created.id]),
    );

    await expectValidationFailure(
      chokePoint(tenant).patch(tenant.plansId, created.id, { name: "Renamed" }),
      "wakeTime",
    );

    expect((await storedProperties(tenant, tenant.plansId, created.id)).name).toBe(PLAN.name);
  });
});

describe("sleep night values (issue gh-1784)", () => {
  const CREATE_REFUSED: Array<[string, string, Record<string, unknown>]> = [
    ["no night", "night", { bedTime: "23:00" }],
    ["night 2026-13-01", "night", { night: "2026-13-01" }],
    ["night 2026-02-30", "night", { night: "2026-02-30" }],
    ["night 2026-1-5", "night", { night: "2026-1-5" }],
    ["a null night", "night", { night: null }],
    ["a night that is no text", "night", { night: 20261016 }],
    ["bedTime 7:5", "bedTime", { night: "2026-10-16", bedTime: "7:5" }],
    ["bedTime 25:00", "bedTime", { night: "2026-10-16", bedTime: "25:00" }],
    ["bedTime 24:00", "bedTime", { night: "2026-10-16", bedTime: "24:00" }],
    ["wakeTime that is no text", "wakeTime", { night: "2026-10-16", wakeTime: 700 }],
    ["alarm as text", "alarm", { night: "2026-10-16", alarm: "yes" }],
    ["alarm 1", "alarm", { night: "2026-10-16", alarm: 1 }],
  ];

  it.each(CREATE_REFUSED)("refuses a create with %s and stores nothing", async (_label, field, properties) => {
    await expectValidationFailure(chokePoint(tenant).create(tenant.nightsId, properties), field);

    expect(await liveItems(tenant, tenant.nightsId)).toEqual([]);
  });

  it("stores bedTime 6:45 as 06:45 and keeps null times and a null alarm", async () => {
    const created = await chokePoint(tenant).create(tenant.nightsId, {
      night: "2026-10-16",
      bedTime: "6:45",
      wakeTime: null,
      alarm: null,
    });

    expect(await storedProperties(tenant, tenant.nightsId, created.id)).toEqual({
      night: "2026-10-16",
      bedTime: "06:45",
      wakeTime: null,
      alarm: null,
    });
  });

  it("accepts a night with a date alone and one with all values", async () => {
    const bare = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });
    const full = await chokePoint(tenant).create(tenant.nightsId, {
      night: "2026-10-17",
      bedTime: "23:15",
      wakeTime: "7:00",
      alarm: false,
    });

    expect(await storedProperties(tenant, tenant.nightsId, bare.id)).toEqual({ night: "2026-10-16" });
    expect(await storedProperties(tenant, tenant.nightsId, full.id)).toEqual({
      night: "2026-10-17",
      bedTime: "23:15",
      wakeTime: "07:00",
      alarm: false,
    });
  });

  it("accepts a leap day", async () => {
    const created = await chokePoint(tenant).create(tenant.nightsId, { night: "2028-02-29" });

    expect((await storedProperties(tenant, tenant.nightsId, created.id)).night).toBe("2028-02-29");
  });

  const PATCH_REFUSED: Array<[string, string, Record<string, unknown>]> = [
    ["night 2026-13-01", "night", { night: "2026-13-01" }],
    ["a null night", "night", { night: null }],
    ["bedTime 7:5", "bedTime", { bedTime: "7:5" }],
    ["wakeTime 25:00", "wakeTime", { wakeTime: "25:00" }],
    ["alarm as text", "alarm", { alarm: "yes" }],
  ];

  it.each(PATCH_REFUSED)("refuses a patch with %s and keeps the stored night", async (_label, field, patch) => {
    const created = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", bedTime: "23:00" });

    await expectValidationFailure(chokePoint(tenant).patch(tenant.nightsId, created.id, patch), field);

    expect(await storedProperties(tenant, tenant.nightsId, created.id)).toEqual({
      night: "2026-10-16",
      bedTime: "23:00",
    });
  });

  it("stores a patched wakeTime as HH:MM and keeps a patched null bedTime and alarm null", async () => {
    const created = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", bedTime: "23:00" });

    await chokePoint(tenant).patch(tenant.nightsId, created.id, { wakeTime: "07:05", bedTime: null, alarm: null });

    expect(await storedProperties(tenant, tenant.nightsId, created.id)).toEqual({
      night: "2026-10-16",
      bedTime: null,
      wakeTime: "07:05",
      alarm: null,
    });
  });
});

describe("one exception per night (issue gh-1784)", () => {
  it("refuses a second exception for a night with 409 duplicate_item naming night, and stores nothing", async () => {
    const first = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", bedTime: "23:00" });

    await expectDuplicate(
      chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", wakeTime: "9:00" }),
      "night",
    );

    expect(await liveItems(tenant, tenant.nightsId)).toEqual([
      { id: first.id, properties: { night: "2026-10-16", bedTime: "23:00" } },
    ]);
  });

  it("allows exceptions for different nights", async () => {
    await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });
    await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-17" });

    expect(await liveItems(tenant, tenant.nightsId)).toHaveLength(2);
  });

  it("does not count a trashed exception, so the night can be taken again", async () => {
    const first = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });
    await chokePoint(tenant).trash(tenant.nightsId, first.id);

    const second = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", alarm: true });

    expect((await liveItems(tenant, tenant.nightsId)).map((item) => item.id)).toEqual([second.id]);
  });

  it("does not count the exception of the same night in another tenant", async () => {
    await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });

    const created = await chokePoint(other).create(other.nightsId, { night: "2026-10-16" });

    expect((await liveItems(other, other.nightsId)).map((item) => item.id)).toEqual([created.id]);
  });

  it("refuses a patch that moves a night onto a date with a live exception and keeps both", async () => {
    const taken = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", bedTime: "23:00" });
    const moving = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-17", wakeTime: "9:00" });

    await expectDuplicate(chokePoint(tenant).patch(tenant.nightsId, moving.id, { night: "2026-10-16" }), "night");

    expect(await storedProperties(tenant, tenant.nightsId, taken.id)).toEqual({
      night: "2026-10-16",
      bedTime: "23:00",
    });
    expect(await storedProperties(tenant, tenant.nightsId, moving.id)).toEqual({
      night: "2026-10-17",
      wakeTime: "09:00",
    });
  });

  it("moves a night onto a free date and onto the date of a trashed exception", async () => {
    const trashed = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-18" });
    await chokePoint(tenant).trash(tenant.nightsId, trashed.id);
    const moving = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-17" });

    await chokePoint(tenant).patch(tenant.nightsId, moving.id, { night: "2026-10-19" });
    await chokePoint(tenant).patch(tenant.nightsId, moving.id, { night: "2026-10-18" });

    expect((await storedProperties(tenant, tenant.nightsId, moving.id)).night).toBe("2026-10-18");
  });

  it("takes the night lookup only when the patch names night", async () => {
    // Restoring a trashed duplicate is not checked (the issue's decision), which leaves two live exceptions.
    const first = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });
    await chokePoint(tenant).trash(tenant.nightsId, first.id);
    const second = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16" });
    await chokePoint(tenant).restore(tenant.nightsId, first.id);
    expect(await liveItems(tenant, tenant.nightsId)).toHaveLength(2);

    await chokePoint(tenant).patch(tenant.nightsId, first.id, { bedTime: "22:00" });
    expect((await storedProperties(tenant, tenant.nightsId, first.id)).bedTime).toBe("22:00");

    await expectDuplicate(chokePoint(tenant).patch(tenant.nightsId, first.id, { night: "2026-10-16" }), "night");
    expect((await storedProperties(tenant, tenant.nightsId, second.id)).night).toBe("2026-10-16");
  });

  it("holds a second creator of the night behind the first until it commits, then refuses it", async () => {
    const { created, release, first } = holdCreateOpen(tenant, tenant.nightsId, { night: "2026-10-16" });
    try {
      await created;
      const second = refusal(chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-16", alarm: true }));
      await waitForAdvisoryLockWaiter();
      // Neither creator can see the other's row yet; only the lock keeps the second one out.
      expect(await liveItems(tenant, tenant.nightsId)).toEqual([]);

      release();
      await first;

      const error = await second;
      expect(error).toBeInstanceOf(DuplicateItemError);
      expect(error).toMatchObject({ details: { field: "night" } });
      expect(await liveItems(tenant, tenant.nightsId)).toHaveLength(1);
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });

  it("does not hold a creator of the same night in another tenant behind the open transaction", async () => {
    const { created, release, first } = holdCreateOpen(tenant, tenant.nightsId, { night: "2026-10-16" });
    try {
      await created;

      // Resolves while the first tenant's transaction still holds its lock.
      const second = await chokePoint(other).create(other.nightsId, { night: "2026-10-16" });

      expect((await liveItems(other, other.nightsId)).map((item) => item.id)).toEqual([second.id]);
    } finally {
      release();
      await first;
    }
  });

  it("does not hold a creator of a different night behind the open transaction", async () => {
    const { created, release, first } = holdCreateOpen(tenant, tenant.nightsId, { night: "2026-10-16" });
    let second: Promise<{ id: string }> | undefined;
    try {
      await created;

      // The night lock of another night is not in its way. The one lock it waits for is the tenant's single
      // `sleep.resync` job (issue gh-1838), which the open transaction enqueued.
      second = chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-17" });
      expect(await waitingStatements()).toEqual([expect.stringContaining("graphile_worker.add_job")]);
      release();
      await first;

      await second;
      expect((await liveItems(tenant, tenant.nightsId)).map((item) => item.properties.night).sort()).toEqual([
        "2026-10-16",
        "2026-10-17",
      ]);
    } finally {
      release();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
    }
  });

  it("holds a patch that moves onto a night behind a creator of that night, then refuses it", async () => {
    const moving = await chokePoint(tenant).create(tenant.nightsId, { night: "2026-10-17" });
    const { created, release, first } = holdCreateOpen(tenant, tenant.nightsId, { night: "2026-10-16" });
    try {
      await created;
      const patched = refusal(chokePoint(tenant).patch(tenant.nightsId, moving.id, { night: "2026-10-16" }));
      await waitForAdvisoryLockWaiter();

      release();
      await first;

      const error = await patched;
      expect(error).toBeInstanceOf(DuplicateItemError);
      expect((await storedProperties(tenant, tenant.nightsId, moving.id)).night).toBe("2026-10-17");
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });
});

describe("the sleep pre-write transform and its proposal preparation (issue gh-1784)", () => {
  it.each([SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID])(
    "is registered with a preparation for %s",
    async (moduleId) => {
      const prepared = await prepareItemPreWriteTransforms(moduleId, { stored: null, patch: { name: "x" } });

      expect(prepared).toEqual({ patch: { name: "x" }, deferredKeys: [] });
    },
  );

  it("prepares the times of a proposed patch as the write stores them", async () => {
    const prepared = await prepareItemPreWriteTransforms(SLEEP_PLANS_MODULE_ID, {
      stored: null,
      patch: { bedTime: "6:45", wakeTime: "23:59", name: "x" },
    });

    expect(prepared).toEqual({ patch: { bedTime: "06:45", wakeTime: "23:59", name: "x" }, deferredKeys: [] });
  });

  it("keeps a null night time null when it prepares a proposed patch", async () => {
    const prepared = await prepareItemPreWriteTransforms(SLEEP_NIGHTS_MODULE_ID, {
      stored: null,
      patch: { bedTime: null },
    });

    expect(prepared).toEqual({ patch: { bedTime: null }, deferredKeys: [] });
  });

  it.each(["7:5", "25:00", "24:00"])("refuses the proposed time %s naming the key", async (value) => {
    await expectValidationFailure(
      prepareItemPreWriteTransforms(SLEEP_PLANS_MODULE_ID, { stored: null, patch: { wakeTime: value } }),
      "wakeTime",
    );
  });
});
