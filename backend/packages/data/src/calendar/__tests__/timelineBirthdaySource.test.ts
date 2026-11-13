import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
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
import { logger } from "../logger.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { CALENDAR_TIMELINE_SOURCES } from "../timelineSources.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

const birthdaySchema = z
  .object({
    kind: z.literal("birthday"),
    id: z.string(),
    personId: z.string(),
    personName: z.string(),
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

  async function createPerson(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId("people");
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function createEvent(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId("events");
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: id, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function trashPerson(personId: string): Promise<void> {
    const id = await databaseId("people");
    await inTenant(() => chokePoint.softDeleteItem(id, personId));
  }

  async function trashCalendar(systemKey: string): Promise<void> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z
      .array(calendarRowSchema)
      .parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const row = rows.find((entry) => entry.properties.systemKey === systemKey);
    if (!row) throw new Error(`No ${systemKey} calendar`);
    // The delete hook of issue gh-1803 refuses to trash a system calendar, so only a raw write puts one in the Trash.
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [
        id,
        row.id,
      ]);
      expect(result.rowCount).toBe(1);
    });
  }

  async function calendarId(systemKey: string): Promise<string> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z
      .array(calendarRowSchema)
      .parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const row = rows.find((entry) => entry.properties.systemKey === systemKey);
    if (!row) throw new Error(`No ${systemKey} calendar`);
    return row.id;
  }

  /**
   * Overwrites stored properties with values the write rules refuse (a birthday that is no date, issue #1795, or
   * a person without a name), so raw SQL is the only way to leave them behind.
   */
  async function storeRaw(personId: string, patch: Record<string, unknown>): Promise<void> {
    const id = await databaseId("people");
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [id, personId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(dataPool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /** The birthday entries of a range, each checked to carry exactly the documented fields. */
  const birthdays = async (from: string, to: string = from) =>
    z.array(birthdaySchema).parse((await read(from, to)).items.filter((item) => item.kind === "birthday"));

  return { createPerson, createEvent, trashPerson, trashCalendar, calendarId, storeRaw, read, birthdays };
}

describe("birthday timeline source (issue #1800)", () => {
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

  it("is listed after the core sources", () => {
    expect(CALENDAR_TIMELINE_SOURCES.map((source) => source.id).slice(0, 3)).toEqual(["events", "tasks", "birthdays"]);
  });

  it("yields an entry on 16 Oct of 2026 and 2027 for a birthday of 2000-10-16 with an unknown year", async () => {
    const w = world(await newTenant("en"));
    const jana = await w.createPerson({ name: "Jana Kovářová", birthday: "2000-10-16", birthdayYearKnown: false });
    const birthdaysCalendar = await w.calendarId("birthdays");

    const entries = await w.birthdays("2026-10-16", "2027-10-16");

    expect(entries).toEqual([
      {
        kind: "birthday",
        id: `birthday:${jana}:2026`,
        personId: jana,
        personName: "Jana Kovářová",
        title: "Birthday - Jana",
        date: "2026-10-16",
        allDay: true,
        calendarId: birthdaysCalendar,
        readOnly: true,
      },
      {
        kind: "birthday",
        id: `birthday:${jana}:2027`,
        personId: jana,
        personName: "Jana Kovářová",
        title: "Birthday - Jana",
        date: "2027-10-16",
        allDay: true,
        calendarId: birthdaysCalendar,
        readOnly: true,
      },
    ]);
  });

  it("uses only the month and day of a birthday with a known year", async () => {
    const w = world(await newTenant());
    const petr = await w.createPerson({ name: "Petr", birthday: "1987-03-04", birthdayYearKnown: true });

    const entries = await w.birthdays("2026-03-01", "2026-03-31");

    expect(entries.map(({ personId, date }) => ({ personId, date }))).toEqual([{ personId: petr, date: "2026-03-04" }]);
  });

  it("returns an entry for the day the range starts on and for the day it ends on, and none outside it", async () => {
    const w = world(await newTenant());
    const first = await w.createPerson({ name: "First", birthday: "1990-05-10" });
    const last = await w.createPerson({ name: "Last", birthday: "1990-05-12" });
    await w.createPerson({ name: "Before", birthday: "1990-05-09" });
    await w.createPerson({ name: "After", birthday: "1990-05-13" });

    const entries = await w.birthdays("2026-05-10", "2026-05-12");

    expect(entries.map(({ personId, date }) => [personId, date])).toEqual([
      [first, "2026-05-10"],
      [last, "2026-05-12"],
    ]);
  });

  it("places each entry in the right year when the range crosses a new year", async () => {
    const w = world(await newTenant());
    const december = await w.createPerson({ name: "December", birthday: "1980-12-31" });
    const newYearsDay = await w.createPerson({ name: "January", birthday: "1980-01-01" });
    const second = await w.createPerson({ name: "Second", birthday: "1980-01-05" });
    await w.createPerson({ name: "Outside", birthday: "1980-12-27" });
    await w.createPerson({ name: "Outside too", birthday: "1980-01-06" });

    const entries = await w.birthdays("2026-12-28", "2027-01-05");

    expect(entries.map(({ id, date }) => [id, date])).toEqual([
      [`birthday:${december}:2026`, "2026-12-31"],
      [`birthday:${newYearsDay}:2027`, "2027-01-01"],
      [`birthday:${second}:2027`, "2027-01-05"],
    ]);
  });

  it("yields a year-spanning range's entries of one person once per year", async () => {
    const w = world(await newTenant());
    const jana = await w.createPerson({ name: "Jana", birthday: "2000-10-16" });

    const entries = await w.birthdays("2026-01-01", "2028-12-31");

    expect(entries.map(({ id, date }) => [id, date])).toEqual([
      [`birthday:${jana}:2026`, "2026-10-16"],
      [`birthday:${jana}:2027`, "2027-10-16"],
      [`birthday:${jana}:2028`, "2028-10-16"],
    ]);
  });

  it("moves a 29 February birthday to 28 February in a year that is not a leap year", async () => {
    const w = world(await newTenant());
    const lenka = await w.createPerson({ name: "Lenka", birthday: "2000-02-29", birthdayYearKnown: false });

    expect((await w.birthdays("2027-02-01", "2027-03-31")).map(({ id, date }) => [id, date])).toEqual([
      [`birthday:${lenka}:2027`, "2027-02-28"],
    ]);
    expect((await w.birthdays("2028-02-01", "2028-03-31")).map(({ id, date }) => [id, date])).toEqual([
      [`birthday:${lenka}:2028`, "2028-02-29"],
    ]);
    expect(await w.birthdays("2027-03-01", "2027-03-31")).toEqual([]);
  });

  it("does not move the birthday of a 28 February or of a 1 March in a year that is not a leap year", async () => {
    const w = world(await newTenant());
    const february = await w.createPerson({ name: "February", birthday: "2001-02-28" });
    const march = await w.createPerson({ name: "March", birthday: "2001-03-01" });

    expect((await w.birthdays("2027-02-01", "2027-03-31")).map(({ personId, date }) => [personId, date])).toEqual([
      [february, "2027-02-28"],
      [march, "2027-03-01"],
    ]);
  });

  it("returns nothing for a trashed person", async () => {
    const w = world(await newTenant());
    const jana = await w.createPerson({ name: "Jana", birthday: "2000-10-16" });
    const petr = await w.createPerson({ name: "Petr", birthday: "2000-10-16" });

    await w.trashPerson(jana);

    expect((await w.birthdays("2026-10-16")).map((entry) => entry.personId)).toEqual([petr]);
  });

  it("returns nothing for people without a birthday and for a cleared one, and does not fail", async () => {
    const w = world(await newTenant());
    await w.createPerson({ name: "Without" });
    await w.createPerson({ name: "Null", birthday: null });
    const cleared = await w.createPerson({ name: "Cleared", birthday: "2000-10-16" });
    await w.storeRaw(cleared, { birthday: null });

    expect(await w.birthdays("2026-01-01", "2026-12-31")).toEqual([]);
  });

  it.each([
    ["a year-less date", "--10-16"],
    ["a day a month lacks", "2026-02-30"],
    ["a date with a time", "2000-10-16T10:00:00Z"],
    ["a number", 20001016],
    ["an empty string", ""],
  ])(
    "leaves out a person whose stored birthday is %s, logs the id and keeps the other entries",
    async (_name, stored) => {
      const w = world(await newTenant());
      const broken = await w.createPerson({ name: "Broken", birthday: "2000-10-16" });
      const fine = await w.createPerson({ name: "Fine", birthday: "2000-10-16" });
      await w.storeRaw(broken, { birthday: stored });
      const warn = vi.spyOn(logger, "warn");

      const entries = await w.birthdays("2026-10-16");

      expect(entries.map((entry) => entry.personId)).toEqual([fine]);
      expect(warn.mock.calls.map(([fields, message]) => [fields, message])).toEqual([
        [expect.objectContaining({ itemId: broken, property: "birthday" }), SKIP_MESSAGE],
      ]);
      // Ids and counts only: the stored value never reaches the log.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("--10-16T");
    },
  );

  it("titles the entry in Czech with the given name for a Czech user", async () => {
    const w = world(await newTenant("cs"));
    await w.createPerson({ name: "Jana Kovářová", birthday: "2000-10-16" });

    expect((await w.birthdays("2026-10-16")).map((entry) => entry.title)).toEqual(["Narozeniny – Jana"]);
  });

  it("titles the entry in English with the given name for an English user", async () => {
    const w = world(await newTenant("en"));
    await w.createPerson({ name: "Jana Kovářová", birthday: "2000-10-16" });

    expect((await w.birthdays("2026-10-16")).map((entry) => entry.title)).toEqual(["Birthday - Jana"]);
  });

  it("titles the entry in Czech for a tenant without a user and in English for another locale", async () => {
    const noUser = world(await newTenant(null));
    await noUser.createPerson({ name: "Jana Kovářová", birthday: "2000-10-16" });
    const german = world(await newTenant("de"));
    await german.createPerson({ name: "Jana Kovářová", birthday: "2000-10-16" });

    expect((await noUser.birthdays("2026-10-16")).map((entry) => entry.title)).toEqual(["Narozeniny – Jana"]);
    expect((await german.birthdays("2026-10-16")).map((entry) => entry.title)).toEqual(["Birthday - Jana"]);
  });

  it("uses the whole name when it is one word, trims it, and keeps a $ in a name literal", async () => {
    const w = world(await newTenant("en"));
    await w.createPerson({ name: "Madonna", birthday: "2000-10-16" });
    await w.createPerson({ name: "  Karel   Čapek ", birthday: "2000-10-16" });
    await w.createPerson({ name: "Cash$& Money", birthday: "2000-10-16" });

    const entries = await w.birthdays("2026-10-16");

    expect(entries.map((entry) => entry.title).sort()).toEqual([
      "Birthday - Cash$&",
      "Birthday - Karel",
      "Birthday - Madonna",
    ]);
    expect(entries.find((entry) => entry.title === "Birthday - Karel")?.personName).toBe("  Karel   Čapek ");
  });

  it("gives an empty given name to a person without a name", async () => {
    const w = world(await newTenant("en"));
    const nameless = await w.createPerson({ name: "Temporary", birthday: "2000-10-16" });
    await w.storeRaw(nameless, { name: null });

    expect(await w.birthdays("2026-10-16")).toMatchObject([
      { personId: nameless, personName: "", title: "Birthday - " },
    ]);
  });

  it("gives a null calendarId when the Birthdays calendar is in the trash", async () => {
    const w = world(await newTenant());
    await w.createPerson({ name: "Jana", birthday: "2000-10-16" });
    await w.trashCalendar("birthdays");

    expect((await w.birthdays("2026-10-16")).map((entry) => entry.calendarId)).toEqual([null]);
  });

  it("returns nothing for a tenant without a People database", async () => {
    const tenantId = await createTestTenant(adminPool);
    const w = world(tenantId);

    expect((await w.read("2026-10-16")).items).toEqual([]);
  });

  it("does not return the birthdays of another tenant", async () => {
    const mine = world(await newTenant());
    const theirs = world(await newTenant());
    const own = await mine.createPerson({ name: "Own", birthday: "2000-10-16" });
    const foreign = await theirs.createPerson({ name: "Foreign", birthday: "2000-10-16" });

    expect((await mine.birthdays("2026-10-16")).map((entry) => entry.personId)).toEqual([own]);
    expect((await theirs.birthdays("2026-10-16")).map((entry) => entry.personId)).toEqual([foreign]);
  });

  it("is read through the runtime role, which row-level security applies to", async () => {
    const role = await runAsSystem("verify birthday source role", () =>
      dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("merges birthdays before the all-day Events of their day, and returns one as it is in the compact shape", async () => {
    const w = world(await newTenant("en"));
    const jana = await w.createPerson({ name: "Jana", birthday: "2000-10-16" });
    const allDay = await w.createEvent({ name: "All day", date: "2026-10-16" });
    const timed = await w.createEvent({ name: "Timed", date: "2026-10-16", timeFrom: "09:00" });
    const nextDay = await w.createEvent({ name: "Next day", date: "2026-10-17" });

    const full = await w.read("2026-10-16", "2026-10-17");
    const compact = await w.read("2026-10-16", "2026-10-17", "compact");

    expect(full.items.map((item) => item.id)).toEqual([`birthday:${jana}:2026`, allDay, timed, nextDay]);
    expect(compact.items.map((item) => item.id)).toEqual([`birthday:${jana}:2026`, allDay, timed, nextDay]);
    expect(compact.items[0]).toEqual(full.items[0]);
    expect(Object.keys(compact.items[1] ?? {})).not.toContain("databaseId");
  });
});
