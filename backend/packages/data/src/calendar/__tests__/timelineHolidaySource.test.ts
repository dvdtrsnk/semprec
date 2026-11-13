import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { CALENDAR_TIMELINE_SOURCES } from "../timelineSources.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;

const holidaySchema = z
  .object({
    kind: z.literal("holiday"),
    id: z.string(),
    title: z.string(),
    date: z.string(),
    allDay: z.literal(true),
    calendarId: z.string().nullable(),
    readOnly: z.literal(true),
  })
  .strict();

const calendarRowSchema = z.object({
  id: z.string(),
  properties: z.object({ systemKey: z.string().optional() }),
});

/** A tenant seeded the way a new one is, with one user of `locale` unless it is `null`. */
async function newTenant(locale: string | null = "cs"): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  if (locale !== null) {
    await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale });
  }
  await runInTenant(tenantId, () => seedSystem(dataPool));
  // The sleep nights of a seeded tenant have their own tests (issue #1806); these keep to their own entries.
  await hideSleepInCalendar(dataPool, tenantId);
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

  async function create(moduleId: string, properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId(moduleId);
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function holidaysCalendar(): Promise<{ id: string; databaseId: string }> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z
      .array(calendarRowSchema)
      .parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const row = rows.find((entry) => entry.properties.systemKey === "holidaysCz");
    if (!row) throw new Error("No holidaysCz calendar");
    return { id: row.id, databaseId: id };
  }

  /**
   * Puts the holidays calendar in the Trash with a raw write: the delete hook of issue gh-1803 refuses to trash a
   * system calendar, so a trashed one is a state only a write that skips the hooks reaches.
   */
  async function trashHolidaysCalendar(): Promise<void> {
    const calendar = await holidaysCalendar();
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [
        calendar.databaseId,
        calendar.id,
      ]);
      expect(result.rowCount).toBe(1);
    });
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(dataPool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /** The holiday entries of a range, each checked to carry exactly the documented fields. */
  const holidays = async (from: string, to: string = from) =>
    z.array(holidaySchema).parse((await read(from, to)).items.filter((item) => item.kind === "holiday"));

  return { create, holidaysCalendar, trashHolidaysCalendar, read, holidays };
}

describe("public holiday timeline source (issue #1804)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("is listed after the birthday source", () => {
    expect(CALENDAR_TIMELINE_SOURCES.map((source) => source.id).slice(0, 4)).toEqual([
      "events",
      "tasks",
      "birthdays",
      "holidays",
    ]);
  });

  it("returns the holiday of 28 Oct 2026 as an all-day, read-only entry of the holidays calendar", async () => {
    const w = world(await newTenant("en"));
    const calendar = await w.holidaysCalendar();

    expect(await w.holidays("2026-10-28")).toEqual([
      {
        kind: "holiday",
        id: "holiday:cz:2026-10-28",
        title: "Independence Day of Czechoslovakia",
        date: "2026-10-28",
        allDay: true,
        calendarId: calendar.id,
        readOnly: true,
      },
    ]);
  });

  it("returns Good Friday on 3 Apr 2026 and Easter Monday on 6 Apr 2026, and nothing between them", async () => {
    const w = world(await newTenant("en"));

    const entries = await w.holidays("2026-04-03", "2026-04-06");

    expect(entries.map(({ id, title }) => [id, title])).toEqual([
      ["holiday:cz:2026-04-03", "Good Friday"],
      ["holiday:cz:2026-04-06", "Easter Monday"],
    ]);
  });

  it("returns the holidays on both ends of a range and none outside it", async () => {
    const w = world(await newTenant());

    expect((await w.holidays("2026-05-01", "2026-05-08")).map((entry) => entry.date)).toEqual([
      "2026-05-01",
      "2026-05-08",
    ]);
    expect((await w.holidays("2026-05-02", "2026-05-07")).map((entry) => entry.date)).toEqual([]);
  });

  it("returns a holiday of each year when the range crosses a new year", async () => {
    const w = world(await newTenant());

    const entries = await w.holidays("2026-12-23", "2027-01-02");

    expect(entries.map((entry) => entry.date)).toEqual(["2026-12-24", "2026-12-25", "2026-12-26", "2027-01-01"]);
  });

  it("returns the holidays of every year of a range that spans several", async () => {
    const w = world(await newTenant());

    const entries = await w.holidays("2026-10-28", "2028-10-28");

    expect(entries.filter((entry) => entry.date.endsWith("-10-28")).map((entry) => entry.date)).toEqual([
      "2026-10-28",
      "2027-10-28",
      "2028-10-28",
    ]);
  });

  it("returns nothing for a day that is no holiday", async () => {
    const w = world(await newTenant());

    expect(await w.holidays("2026-10-29")).toEqual([]);
  });

  it("returns holidays in the years 2016 and 2100 and none in the years outside them", async () => {
    const w = world(await newTenant());

    expect((await w.holidays("2016-12-24")).map((entry) => entry.id)).toEqual(["holiday:cz:2016-12-24"]);
    expect((await w.holidays("2100-12-24")).map((entry) => entry.id)).toEqual(["holiday:cz:2100-12-24"]);
    expect(await w.holidays("2015-12-24")).toEqual([]);
    expect(await w.holidays("2101-12-24")).toEqual([]);
    expect((await w.holidays("2015-12-24", "2016-01-02")).map((entry) => entry.id)).toEqual(["holiday:cz:2016-01-01"]);
    expect((await w.holidays("2100-12-26", "2101-01-02")).map((entry) => entry.id)).toEqual(["holiday:cz:2100-12-26"]);
  });

  it("names the holiday in Czech for a Czech user and for a tenant without a user", async () => {
    const czech = world(await newTenant("cs"));
    const noUser = world(await newTenant(null));

    expect((await czech.holidays("2026-10-28")).map((entry) => entry.title)).toEqual([
      "Den vzniku samostatného československého státu",
    ]);
    expect((await noUser.holidays("2026-04-03")).map((entry) => entry.title)).toEqual(["Velký pátek"]);
  });

  it("names the holiday in English for an English user and for a locale without a catalog", async () => {
    const english = world(await newTenant("en"));
    const german = world(await newTenant("de"));

    expect((await english.holidays("2026-12-24")).map((entry) => entry.title)).toEqual(["Christmas Eve"]);
    expect((await german.holidays("2026-12-24")).map((entry) => entry.title)).toEqual(["Christmas Eve"]);
  });

  it("names every holiday of 2026 in both languages", async () => {
    const czech = world(await newTenant("cs"));
    const english = world(await newTenant("en"));

    for (const w of [czech, english]) {
      const titles = (await w.holidays("2026-01-01", "2026-12-31")).map((entry) => entry.title);
      expect(titles).toHaveLength(13);
      // A key missing from the catalog would resolve to the key itself.
      expect(titles.filter((title) => title.startsWith("calendar.holiday."))).toEqual([]);
      expect(new Set(titles).size).toBe(13);
    }
  });

  it("gives a null calendarId when the holidays calendar is in the trash", async () => {
    const w = world(await newTenant());
    await w.trashHolidaysCalendar();

    expect((await w.holidays("2026-10-28")).map((entry) => entry.calendarId)).toEqual([null]);
  });

  it("gives a null calendarId to a tenant without a calendars database", async () => {
    const w = world(await createTestTenant(adminPool));

    expect((await w.holidays("2026-10-28")).map((entry) => entry.calendarId)).toEqual([null]);
  });

  it("gives each tenant its own holidays calendar", async () => {
    const mine = world(await newTenant());
    const theirs = world(await newTenant());

    const own = (await mine.holidays("2026-10-28")).map((entry) => entry.calendarId);
    const foreign = (await theirs.holidays("2026-10-28")).map((entry) => entry.calendarId);

    expect(own).toEqual([(await mine.holidaysCalendar()).id]);
    expect(foreign).toEqual([(await theirs.holidaysCalendar()).id]);
    expect(own).not.toEqual(foreign);
  });

  it("merges a holiday before the birthdays and all-day Events of its day, and returns one as it is in the compact shape", async () => {
    const w = world(await newTenant("en"));
    const jana = await w.create("people", { name: "Jana", birthday: "2000-10-28" });
    const allDay = await w.create("events", { name: "All day", date: "2026-10-28" });
    const timed = await w.create("events", { name: "Timed", date: "2026-10-28", timeFrom: "09:00" });

    const full = await w.read("2026-10-28");
    const compact = await w.read("2026-10-28", "2026-10-28", "compact");

    const ids = [`holiday:cz:2026-10-28`, `birthday:${jana}:2026`, allDay, timed];
    expect(full.items.map((item) => item.id)).toEqual(ids);
    expect(compact.items.map((item) => item.id)).toEqual(ids);
    expect(compact.items[0]).toEqual(full.items[0]);
  });
});
