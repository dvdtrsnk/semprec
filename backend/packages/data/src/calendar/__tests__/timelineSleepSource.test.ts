import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../../seed/sleepModuleKeys.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { logger } from "../logger.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { CALENDAR_TIMELINE_SOURCES } from "../timelineSources.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

const sleepSchema = z
  .object({
    kind: z.literal("sleep"),
    id: z.string(),
    night: z.string(),
    planId: z.string().nullable(),
    bedTime: z.string(),
    wakeTime: z.string(),
    alarm: z.boolean(),
    changed: z.boolean(),
    bedAt: z.string(),
    wakeAt: z.string(),
    prepReminderAt: z.string().nullable(),
    readOnly: z.literal(false),
  })
  .strict();

const rowSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });

/** A tenant seeded the way a new one is: the default plans, the settings item with sleep on and shown in the calendar. */
async function newTenant(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "cs" });
  await runInTenant(tenantId, () => seedSystem(dataPool));
  return tenantId;
}

/** One tenant's fixture writes and timeline reads, each in that tenant's scope on the runtime-role pool. */
function world(tenantId: string) {
  const chokePoint = createChokePoint(dataPool);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantId, fn);

  async function databaseId(moduleId: string): Promise<string> {
    const database = await inTenant(() =>
      withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
    );
    if (!database) throw new Error(`No ${moduleId} database`);
    return database.id;
  }

  async function rows(moduleId: string) {
    const id = await databaseId(moduleId);
    return z.array(rowSchema).parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
  }

  async function settingsId(): Promise<string> {
    const [settings] = await rows(SLEEP_SETTINGS_MODULE_ID);
    if (!settings) throw new Error("No sleep settings item");
    return settings.id;
  }

  async function planId(name: string): Promise<string> {
    const plan = (await rows(SLEEP_PLANS_MODULE_ID)).find((row) => row.properties.bedTime === name);
    if (!plan) throw new Error(`No plan with bedtime ${name}`);
    return plan.id;
  }

  async function updateSettings(patch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(SLEEP_SETTINGS_MODULE_ID);
    const itemId = await settingsId();
    await inTenant(() =>
      chokePoint.updateItem({ databaseId: id, itemId, propertiesPatch: patch }, undefined, undefined, USER),
    );
  }

  async function createNightException(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId(SLEEP_NIGHTS_MODULE_ID);
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  /** Inserts a second settings item behind the write rules, which allow one per tenant. */
  async function createSettings(properties: Record<string, unknown>): Promise<void> {
    const id = await databaseId(SLEEP_SETTINGS_MODULE_ID);
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)", [
        id,
        JSON.stringify(properties),
      ]);
      expect(result.rowCount).toBe(1);
    });
  }

  async function createEvent(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId("events");
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function createTask(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId("tasks");
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function trash(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => chokePoint.softDeleteItem(id, itemId));
  }

  /** Overwrites stored properties with values the write rules would refuse, or removes an item the API protects. */
  async function storeRaw(moduleId: string, itemId: string, patch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(moduleId);
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [id, itemId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  async function deleteRaw(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [id, itemId]);
      expect(result.rowCount).toBe(1);
    });
  }

  async function setZone(timezone: string): Promise<void> {
    await inTenant(async () => {
      const settingsDatabaseId = await withTransaction(dataPool, (client) => getSystemSettingsDatabaseId(client));
      const itemId = await withTransaction(dataPool, (client) => getSystemSettingsItemId(client));
      await chokePoint.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    });
  }

  async function hideSleepCalendar(): Promise<void> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const calendar = (await rows(CALENDARS_MODULE_ID)).find((row) => row.properties.systemKey === "sleep");
    if (!calendar) throw new Error("No sleep calendar");
    await inTenant(() =>
      chokePoint.updateItem(
        { databaseId: id, itemId: calendar.id, propertiesPatch: { hidden: true } },
        undefined,
        undefined,
        USER,
      ),
    );
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(dataPool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /** The sleep entries of a range, each checked to carry exactly the documented fields. */
  const nights = async (from: string, to: string = from) =>
    z.array(sleepSchema).parse((await read(from, to)).items.filter((item) => item.kind === "sleep"));

  return {
    rows,
    settingsId,
    planId,
    updateSettings,
    createNightException,
    createSettings,
    createEvent,
    createTask,
    trash,
    storeRaw,
    deleteRaw,
    setZone,
    hideSleepCalendar,
    read,
    nights,
  };
}

describe("sleep timeline source (issue #1806)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("is listed after the other derived sources", () => {
    expect(CALENDAR_TIMELINE_SOURCES.map((source) => source.id)).toEqual([
      "events",
      "tasks",
      "birthdays",
      "holidays",
      "sleep",
    ]);
  });

  it("returns the nights 2026-10-15 and 2026-10-16 for the timeline of 16 Oct 2026", async () => {
    const w = world(await newTenant());
    const weekdays = await w.planId("23:00");
    const weekend = await w.planId("00:00");

    expect(await w.nights("2026-10-16")).toEqual([
      {
        kind: "sleep",
        id: "sleep:2026-10-15",
        night: "2026-10-15",
        planId: weekdays,
        bedTime: "23:00",
        wakeTime: "06:45",
        alarm: true,
        changed: false,
        bedAt: "2026-10-15T23:00:00+02:00",
        wakeAt: "2026-10-16T06:45:00+02:00",
        prepReminderAt: "2026-10-15T22:30:00+02:00",
        readOnly: false,
      },
      {
        kind: "sleep",
        id: "sleep:2026-10-16",
        night: "2026-10-16",
        planId: weekend,
        bedTime: "00:00",
        wakeTime: "08:30",
        alarm: false,
        changed: false,
        bedAt: "2026-10-17T00:00:00+02:00",
        wakeAt: "2026-10-17T08:30:00+02:00",
        prepReminderAt: "2026-10-16T23:30:00+02:00",
        readOnly: false,
      },
    ]);
  });

  it("includes the night that began the evening before a range and the night that begins on its last day", async () => {
    const w = world(await newTenant());

    expect((await w.nights("2026-10-18", "2026-10-19")).map((night) => night.night)).toEqual([
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
  });

  it("looks one day back across a month and a year boundary", async () => {
    const w = world(await newTenant());

    expect((await w.nights("2026-11-01")).map((night) => night.night)).toEqual(["2026-10-31", "2026-11-01"]);
    expect((await w.nights("2027-01-01")).map((night) => night.night)).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("marks only the night with an exception as changed and keeps the other nights on the plan", async () => {
    const w = world(await newTenant());
    await w.createNightException({ night: "2026-10-15", bedTime: "23:30" });

    const nights = await w.nights("2026-10-16", "2026-10-20");

    expect(nights.map(({ night, changed, bedTime }) => [night, changed, bedTime])).toEqual([
      ["2026-10-15", true, "23:30"],
      ["2026-10-16", false, "00:00"],
      ["2026-10-17", false, "00:00"],
      ["2026-10-18", false, "23:00"],
      ["2026-10-19", false, "23:00"],
      ["2026-10-20", false, "23:00"],
    ]);
    expect(nights[0]).toMatchObject({ bedAt: "2026-10-15T23:30:00+02:00", wakeTime: "06:45", alarm: true });
  });

  it("applies the exception of the last night of a multi-day range", async () => {
    const w = world(await newTenant());
    await w.createNightException({ night: "2026-10-20", bedTime: "22:15" });

    const nights = await w.nights("2026-10-16", "2026-10-20");

    expect(nights.map(({ night, changed }) => [night, changed])).toEqual([
      ["2026-10-15", false],
      ["2026-10-16", false],
      ["2026-10-17", false],
      ["2026-10-18", false],
      ["2026-10-19", false],
      ["2026-10-20", true],
    ]);
    expect(nights[5]).toMatchObject({ bedTime: "22:15", bedAt: "2026-10-20T22:15:00+02:00" });
  });

  it("overrides the wake time and the alarm of a night from its exception", async () => {
    const w = world(await newTenant());
    await w.createNightException({ night: "2026-10-20", wakeTime: "05:30", alarm: false });

    expect(await w.nights("2026-10-21")).toMatchObject([
      { night: "2026-10-20", changed: true, bedTime: "23:00", wakeTime: "05:30", alarm: false },
      { night: "2026-10-21" },
    ]);
  });

  it("ignores an exception of a night outside the nights of the range and a trashed one", async () => {
    const w = world(await newTenant());
    await w.createNightException({ night: "2026-10-13", bedTime: "21:00" });
    const trashed = await w.createNightException({ night: "2026-10-15", bedTime: "22:00" });
    await w.trash(SLEEP_NIGHTS_MODULE_ID, trashed);

    expect((await w.nights("2026-10-16")).map(({ night, changed }) => [night, changed])).toEqual([
      ["2026-10-15", false],
      ["2026-10-16", false],
    ]);
  });

  it("does not mark a night as changed for an exception that overrides nothing", async () => {
    const w = world(await newTenant());
    await w.createNightException({ night: "2026-10-15" });

    expect((await w.nights("2026-10-16")).map(({ night, changed }) => [night, changed])).toEqual([
      ["2026-10-15", false],
      ["2026-10-16", false],
    ]);
  });

  it("follows a plan that is edited and drops a trashed plan", async () => {
    const w = world(await newTenant());
    const weekdays = await w.planId("23:00");
    const plans = await w.rows(SLEEP_PLANS_MODULE_ID);
    const weekend = plans.find((plan) => plan.id !== weekdays);
    if (!weekend) throw new Error("No weekend plan");
    await w.trash(SLEEP_PLANS_MODULE_ID, weekend.id);

    const nights = await w.nights("2026-10-16", "2026-10-17");

    // Only the weekday plan is left, so the nights before a Saturday and a Sunday morning have no plan.
    expect(nights.map((night) => night.night)).toEqual(["2026-10-15"]);
  });

  it.each([
    ["sleep is switched off", { enabled: false }],
    ["the calendar does not show sleep", { showInCalendar: false }],
    ["both are off", { enabled: false, showInCalendar: false }],
  ])("returns no sleep entry when %s", async (_name, patch) => {
    const w = world(await newTenant());
    await w.updateSettings(patch);

    expect(await w.nights("2026-10-16", "2026-10-20")).toEqual([]);
    const timeline = await w.read("2026-10-16", "2026-10-20");
    expect(timeline.items.filter((item) => item.kind === "sleep")).toEqual([]);
  });

  it("returns the nights again when sleep is switched back on and shown", async () => {
    const w = world(await newTenant());
    await w.updateSettings({ enabled: false });
    await w.updateSettings({ enabled: true });

    expect((await w.nights("2026-10-16")).map((night) => night.night)).toEqual(["2026-10-15", "2026-10-16"]);
  });

  it("returns the same nights when the Sleep calendar is hidden", async () => {
    const w = world(await newTenant());
    const before = await w.nights("2026-10-16");
    await w.hideSleepCalendar();

    expect(await w.nights("2026-10-16")).toEqual(before);
  });

  it("leaves the nights out, without failing, when the tenant has no settings item", async () => {
    const w = world(await newTenant());
    await w.deleteRaw(SLEEP_SETTINGS_MODULE_ID, await w.settingsId());

    expect(await w.nights("2026-10-16")).toEqual([]);
  });

  it("leaves the nights out and logs the count when the tenant has two settings items", async () => {
    const w = world(await newTenant());
    await w.createSettings({ name: "Second", enabled: true, showInCalendar: true });
    const warn = vi.spyOn(logger, "warn");

    expect(await w.nights("2026-10-16")).toEqual([]);

    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([expect.objectContaining({ count: 2 })]);
  });

  it("returns nothing for a tenant without the sleep databases", async () => {
    const w = world(await createTestTenant(adminPool));

    expect((await w.read("2026-10-16")).items).toEqual([]);
  });

  it("takes the reminder from the settings: off, a different lead time, and a lead time it cannot use", async () => {
    const w = world(await newTenant());

    await w.updateSettings({ prepReminder: false });
    expect((await w.nights("2026-10-16")).map((night) => night.prepReminderAt)).toEqual([null, null]);

    await w.updateSettings({ prepReminder: true, prepReminderMinutes: 45 });
    expect((await w.nights("2026-10-16")).map((night) => night.prepReminderAt)).toEqual([
      "2026-10-15T22:15:00+02:00",
      "2026-10-16T23:15:00+02:00",
    ]);

    const settingsId = await w.settingsId();
    for (const minutes of [-5, 1.5, 1441, 1e15, "30", null]) {
      await w.storeRaw(SLEEP_SETTINGS_MODULE_ID, settingsId, { prepReminderMinutes: minutes });
      const warn = vi.spyOn(logger, "warn");
      expect(
        (await w.nights("2026-10-16")).map((night) => night.prepReminderAt),
        String(minutes),
      ).toEqual([null, null]);
      // One line per read, with the ids and the property name and never the value.
      expect(
        warn.mock.calls.map(([fields]) => fields),
        String(minutes),
      ).toEqual([{ itemId: settingsId, databaseId: expect.any(String), property: "prepReminderMinutes" }]);
      warn.mockRestore();
    }
  });

  it("does not log a lead time that is unusable while the reminder is off", async () => {
    const w = world(await newTenant());
    await w.storeRaw(SLEEP_SETTINGS_MODULE_ID, await w.settingsId(), {
      prepReminder: false,
      prepReminderMinutes: 2000,
    });
    const warn = vi.spyOn(logger, "warn");

    expect((await w.nights("2026-10-16")).map((night) => night.prepReminderAt)).toEqual([null, null]);

    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the wall-clock times in the tenant time zone across the change to winter time", async () => {
    const w = world(await newTenant());

    expect(await w.nights("2026-10-25")).toMatchObject([
      { night: "2026-10-24", bedAt: "2026-10-25T00:00:00+02:00", wakeAt: "2026-10-25T08:30:00+01:00" },
      { night: "2026-10-25", bedAt: "2026-10-25T23:00:00+01:00", wakeAt: "2026-10-26T06:45:00+01:00" },
    ]);
  });

  it("reads the wall-clock times in the tenant time zone across the change to summer time", async () => {
    const w = world(await newTenant());

    expect(await w.nights("2027-03-28")).toMatchObject([
      { night: "2027-03-27", bedAt: "2027-03-28T00:00:00+01:00", wakeAt: "2027-03-28T08:30:00+02:00" },
      { night: "2027-03-28", bedAt: "2027-03-28T23:00:00+02:00", wakeAt: "2027-03-29T06:45:00+02:00" },
    ]);
  });

  it("follows the zone the tenant sets", async () => {
    const w = world(await newTenant());
    await w.setZone("America/New_York");

    expect(await w.nights("2026-10-16")).toMatchObject([
      { night: "2026-10-15", bedAt: "2026-10-15T23:00:00-04:00", wakeAt: "2026-10-16T06:45:00-04:00" },
      { night: "2026-10-16", bedAt: "2026-10-17T00:00:00-04:00", wakeAt: "2026-10-17T08:30:00-04:00" },
    ]);
  });

  it.each([
    ["a bedtime that is no time", "bedTime", "25:61"],
    ["a bedtime with seconds", "bedTime", "23:00:00"],
    ["a wake time that is a number", "wakeTime", 645],
    ["wake days that are no list", "wakeDays", "mon"],
    ["a position that is a string", "position", "first"],
    ["an alarm that is a string", "alarm", "yes"],
  ])("leaves out a plan with %s, logs its id and keeps the other plan", async (_name, key, value) => {
    const w = world(await newTenant());
    const weekdays = await w.planId("23:00");
    await w.storeRaw(SLEEP_PLANS_MODULE_ID, weekdays, { [key]: value });
    const warn = vi.spyOn(logger, "warn");

    const nights = await w.nights("2026-10-16");

    // Without the weekday plan the Thursday night has none; the weekend plan still gives the Friday night.
    expect(nights.map((night) => night.night)).toEqual(["2026-10-16"]);
    expect(warn.mock.calls.map(([fields, message]) => [fields, message])).toEqual([
      [expect.objectContaining({ itemId: weekdays, property: key }), SKIP_MESSAGE],
    ]);
  });

  it.each([
    ["a night that is no date", { night: "2026-13-45", bedTime: "21:00" }, "night"],
    ["a bedtime that is no time", { night: "2026-10-15", bedTime: "9pm" }, "bedTime"],
    ["an alarm that is a string", { night: "2026-10-15", alarm: "yes" }, "alarm"],
  ])("leaves out a night exception with %s, logs its id and keeps the plan", async (_name, stored, property) => {
    const w = world(await newTenant());
    const exception = await w.createNightException({ night: "2026-10-15", bedTime: "22:00" });
    await w.storeRaw(SLEEP_NIGHTS_MODULE_ID, exception, stored);
    const warn = vi.spyOn(logger, "warn");

    const nights = await w.nights("2026-10-16");

    expect(nights.map(({ night, changed, bedTime }) => [night, changed, bedTime])).toEqual([
      ["2026-10-15", false, "23:00"],
      ["2026-10-16", false, "00:00"],
    ]);
    // An exception whose `night` is no date is not in the range either, so the log applies to the other two.
    const expected =
      property === "night" ? [] : [[expect.objectContaining({ itemId: exception, property }), SKIP_MESSAGE]];
    expect(warn.mock.calls.map(([fields, message]) => [fields, message])).toEqual(expected);
  });

  it("orders a night after the timed Tasks of its day and before the next day, and returns it as it is in the compact shape", async () => {
    const w = world(await newTenant());
    const event = await w.createEvent({ name: "Event", date: "2026-10-15", timeFrom: "09:00" });
    const task = await w.createTask({ name: "Task", date: "2026-10-15", timeFrom: "10:00" });
    const nextDay = await w.createEvent({ name: "Next day", date: "2026-10-16" });

    const full = await w.read("2026-10-15", "2026-10-16");
    const compact = await w.read("2026-10-15", "2026-10-16", "compact");

    // The night 2026-10-14 is the night before the range that ends inside it.
    const ids = ["sleep:2026-10-14", event, task, "sleep:2026-10-15", nextDay, "sleep:2026-10-16"];
    expect(full.items.map((item) => item.id)).toEqual(ids);
    expect(compact.items.map((item) => item.id)).toEqual(full.items.map((item) => item.id));
    expect(compact.items.find((item) => item.id === "sleep:2026-10-15")).toEqual(
      full.items.find((item) => item.id === "sleep:2026-10-15"),
    );
  });

  it("does not return the plans or exceptions of another tenant", async () => {
    const mine = world(await newTenant());
    const theirs = world(await newTenant());
    await theirs.createNightException({ night: "2026-10-15", bedTime: "21:00" });
    const theirWeekdays = await theirs.planId("23:00");

    const own = await mine.nights("2026-10-16");
    const foreign = await theirs.nights("2026-10-16");

    expect(own.map(({ changed, bedTime }) => [changed, bedTime])).toEqual([
      [false, "23:00"],
      [false, "00:00"],
    ]);
    expect(own.map((night) => night.planId)).not.toContain(theirWeekdays);
    expect(foreign.map(({ changed, bedTime }) => [changed, bedTime])).toEqual([
      [true, "21:00"],
      [false, "00:00"],
    ]);
  });
});
