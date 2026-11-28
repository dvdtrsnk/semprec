import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@alldots/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { logger } from "../logger.js";
import { importSubscribedEvents } from "../subscribedEventsImport.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

/**
 * The import's own writes are the fixtures, and every read goes through `readCalendarTimeline` on the runtime
 * role pool. Tenant A is in the default zone `Europe/Prague`, tenant B in `Asia/Tokyo`.
 */

const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

interface Tenant {
  id: string;
  calendarsId: string;
  subscribedEventsId: string;
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let tenantA: Tenant;
let tenantB: Tenant;

const storedRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updated_at: z.date(),
  deleted_at: z.date().nullable(),
});
type StoredRow = z.infer<typeof storedRow>;

const entry = z.object({
  id: z.string(),
  databaseId: z.string(),
  title: z.string(),
  date: z.string(),
  endDate: z.string().nullable(),
  timeFrom: z.string().nullable(),
  timeTo: z.string().nullable(),
  allDay: z.boolean(),
  calendarId: z.string().nullable(),
  readOnly: z.boolean(),
});
type Entry = z.infer<typeof entry>;

function feed(...vevents: string[]): string {
  const body = vevents.map((lines) => `BEGIN:VEVENT\r\n${lines}\r\nEND:VEVENT\r\n`).join("");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}END:VCALENDAR\r\n`;
}

/** A weekly Tuesday meeting at 09:00 in the tenant's own wall clock (a floating time), the master of a series. */
function weekly(extra = "", rule = "FREQ=WEEKLY"): string {
  return `UID:weekly@example.test\r\nSUMMARY:Weekly\r\nDTSTART:20261020T090000\r\nDTEND:20261020T100000\r\nRRULE:${rule}${extra === "" ? "" : `\r\n${extra}`}`;
}

function override(original: string, start: string, title = "Moved"): string {
  return `UID:weekly@example.test\r\nSUMMARY:${title}\r\nRECURRENCE-ID:${original}\r\nDTSTART:${start}\r\nDTEND:${start.slice(0, 9)}${String(Number(start.slice(9, 11)) + 1).padStart(2, "0")}${start.slice(11)}`;
}

async function seededTenant(timeZone: string | null): Promise<Tenant> {
  const id = await createTestTenant(admin);
  await createUser(admin, {
    tenantId: id,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(id, () => seedSystem(runtime));
  // The sleep nights of a seeded tenant have their own tests; these keep to events.
  await hideSleepInCalendar(runtime, id);
  if (timeZone !== null) {
    // Raw SQL as the superuser: the tenant's zone is a setting row the test needs set, not a write it examines.
    await admin.query(
      `UPDATE items SET properties = properties || jsonb_build_object('timezone', $2::text)
        WHERE tenant_id = $1 AND database_id = (SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'systemSettings')`,
      [id, timeZone],
    );
  }
  const databases = await runInTenant(id, () => cp.listDatabases());
  const calendars = databases.find((row) => row.ownerModuleId === CALENDARS_MODULE_ID);
  const subscribedEvents = databases.find((row) => row.ownerModuleId === SUBSCRIBED_EVENTS_MODULE_ID);
  if (!calendars || !subscribedEvents) throw new Error("Missing a calendar database");
  return { id, calendarsId: calendars.id, subscribedEventsId: subscribedEvents.id };
}

/** A subscription calendar without an address, written as the calendar module writes it (only it may write `kind`). */
async function subscription(tenant: Tenant): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: tenant.calendarsId,
          properties: { name: `Feed ${randomUUID()}`, color: "#8E8E93", kind: "subscription" },
        },
        { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
      ),
    ),
  );
  return item.id;
}

function runImport(tenant: Tenant, calendarItemId: string, body: string) {
  return runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) => importSubscribedEvents(client, { calendarItemId, body })),
  );
}

async function storedRows(tenant: Tenant, calendarItemId: string): Promise<StoredRow[]> {
  const { rows } = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      client.query(
        `SELECT i.id, i.properties, i.updated_at, i.deleted_at
           FROM item_relations r
           JOIN items i ON i.id = r.item_b
          WHERE r.item_a = $1 AND i.database_id = $2
          ORDER BY i.created_at, i.id`,
        [calendarItemId, tenant.subscribedEventsId],
      ),
    ),
  );
  return rows.map((row) => storedRow.parse(row));
}

function masterOf(rows: StoredRow[], uid = "weekly@example.test"): StoredRow {
  const row = rows.find(
    (candidate) =>
      candidate.deleted_at === null && candidate.properties.uid === uid && candidate.properties.recurrenceId == null,
  );
  if (!row) throw new Error(`No master row of ${uid}`);
  return row;
}

function overrideRowsOf(rows: StoredRow[]): StoredRow[] {
  return rows.filter((row) => typeof row.properties.recurrenceId === "string");
}

function timelineOf(tenant: Tenant, from: string, to: string, calendarItemId?: string): Promise<Entry[]> {
  return runInTenant(tenant.id, async () => {
    const timeline = await withTransaction(runtime, (client) =>
      readCalendarTimeline(client, { from, to, shape: "full" }),
    );
    const entries = z.array(z.looseObject({ databaseId: z.string().optional() })).parse(timeline.items);
    return z
      .array(entry)
      .parse(entries.filter((candidate) => candidate.databaseId === tenant.subscribedEventsId))
      .filter((candidate) => calendarItemId === undefined || candidate.calendarId === calendarItemId);
  });
}

function shown(entries: Entry[]): string[] {
  return entries.map((item) => `${item.date} ${item.timeFrom}-${item.timeTo} ${item.title}`);
}

describe("recurring subscribed events (issue gh-1966)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    cp = createChokePoint(runtime);
    tenantA = await seededTenant(null);
    tenantB = await seededTenant("Asia/Tokyo");
  });

  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime.end();
  });

  describe("a weekly series", () => {
    it("appears once a week inside the requested range and nowhere outside it", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(tenantA, calendarId, feed(weekly()));
      expect(result).toEqual({ created: 1, updated: 0, unchanged: 0, trashed: 0, unreadable: 0, unsupportedRules: 0 });
      const master = masterOf(await storedRows(tenantA, calendarId));
      expect(master.properties).toMatchObject({ recurrenceRule: "FREQ=WEEKLY", startsAt: "2026-10-20T09:00" });

      const inRange = await timelineOf(tenantA, "2026-10-26", "2026-11-08", calendarId);
      expect(shown(inRange)).toEqual(["2026-10-27 09:00-10:00 Weekly", "2026-11-03 09:00-10:00 Weekly"]);
      expect(inRange.map((item) => item.id)).toEqual([`${master.id}@2026-10-27`, `${master.id}@2026-11-03`]);
      for (const item of inRange) {
        expect(item).toMatchObject({ readOnly: true, calendarId, databaseId: tenantA.subscribedEventsId });
      }
      expect(await timelineOf(tenantA, "2026-10-01", "2026-10-19", calendarId)).toEqual([]);
      expect(shown(await timelineOf(tenantA, "2030-06-04", "2030-06-10", calendarId))).toEqual([
        "2030-06-04 09:00-10:00 Weekly",
      ]);
    });

    it("stops a COUNT=3 series after exactly three occurrences", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("", "FREQ=WEEKLY;COUNT=3")));
      expect(shown(await timelineOf(tenantA, "2026-01-01", "2027-12-31", calendarId))).toEqual([
        "2026-10-20 09:00-10:00 Weekly",
        "2026-10-27 09:00-10:00 Weekly",
        "2026-11-03 09:00-10:00 Weekly",
      ]);
    });

    it("gives a series that has ended no entry in a later range", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("", "FREQ=WEEKLY;UNTIL=20261103T090000")));
      expect(shown(await timelineOf(tenantA, "2026-11-01", "2026-11-30", calendarId))).toEqual([
        "2026-11-03 09:00-10:00 Weekly",
      ]);
      expect(await timelineOf(tenantA, "2026-11-04", "2026-12-31", calendarId)).toEqual([]);
    });

    it("gives an unbounded daily series the days of the range, and at most one hundred of them", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("", "FREQ=DAILY")));
      expect(await timelineOf(tenantA, "2026-11-01", "2026-11-30", calendarId)).toHaveLength(30);
      const wide = await timelineOf(tenantA, "2026-10-20", "2027-05-07", calendarId);
      expect(wide).toHaveLength(100);
      expect(wide.at(0)?.date).toBe("2026-10-20");
      expect(wide.at(-1)?.date).toBe("2027-01-27");
    });

    it("expands an all-day series with its days, an excluded day and an override of a day", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:trip@example.test\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261022\r\nRRULE:FREQ=WEEKLY\r\nEXDATE;VALUE=DATE:20261103",
          "UID:trip@example.test\r\nSUMMARY:Short trip\r\nRECURRENCE-ID;VALUE=DATE:20261110\r\nDTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112",
        ),
      );
      const master = masterOf(await storedRows(tenantA, calendarId), "trip@example.test");
      expect(master.properties).toMatchObject({ exceptionDates: '["2026-11-03T00:00"]', allDay: true });
      const entries = await timelineOf(tenantA, "2026-10-26", "2026-11-17", calendarId);
      expect(entries.map((item) => [item.date, item.endDate, item.title, item.allDay])).toEqual([
        ["2026-10-27", "2026-10-28", "Trip", true],
        ["2026-11-11", null, "Short trip", true],
        ["2026-11-17", "2026-11-18", "Trip", true],
      ]);
    });
  });

  describe("excluded dates and overrides", () => {
    it("leaves out an occurrence that EXDATE lists, and keeps the others", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("EXDATE:20261103T090000")));
      const master = masterOf(await storedRows(tenantA, calendarId));
      expect(master.properties.exceptionDates).toBe('["2026-11-03T09:00"]');
      expect(shown(await timelineOf(tenantA, "2026-10-26", "2026-11-17", calendarId))).toEqual([
        "2026-10-27 09:00-10:00 Weekly",
        "2026-11-10 09:00-10:00 Weekly",
        "2026-11-17 09:00-10:00 Weekly",
      ]);
    });

    it("shows an overridden occurrence with the override's time and title, as a row of its own", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000", "Moved")));
      const rows = await storedRows(tenantA, calendarId);
      const overrideRow = overrideRowsOf(rows)[0];
      expect(overrideRowsOf(rows)).toHaveLength(1);
      expect(overrideRow?.properties).toMatchObject({
        uid: "weekly@example.test",
        recurrenceId: "2026-11-03T09:00",
        startsAt: "2026-11-04T10:30",
        title: "Moved",
      });
      expect(overrideRow?.properties.recurrenceRule).toBeUndefined();
      const entries = await timelineOf(tenantA, "2026-10-26", "2026-11-10", calendarId);
      expect(shown(entries)).toEqual([
        "2026-10-27 09:00-10:00 Weekly",
        "2026-11-04 10:30-11:30 Moved",
        "2026-11-10 09:00-10:00 Weekly",
      ]);
      expect(entries[1]).toMatchObject({ id: overrideRow?.id, readOnly: true });
    });

    it("replaces the occurrence also when the override was moved out of the range", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261216T103000")));
      expect(shown(await timelineOf(tenantA, "2026-11-01", "2026-11-08", calendarId))).toEqual([]);
      expect(shown(await timelineOf(tenantA, "2026-12-16", "2026-12-16", calendarId))).toEqual([
        "2026-12-16 10:30-11:30 Moved",
      ]);
    });

    it("shows an override whose series is not in the feed as an event of its own", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(override("20261103T090000", "20261104T103000")));
      expect(shown(await timelineOf(tenantA, "2026-11-01", "2026-11-08", calendarId))).toEqual([
        "2026-11-04 10:30-11:30 Moved",
      ]);
    });

    it("lets an override replace the occurrence only in its own calendar, though two calendars share the UID", async () => {
      const first = await subscription(tenantA);
      const second = await subscription(tenantA);
      await runImport(tenantA, first, feed(weekly(), override("20261103T090000", "20261104T103000")));
      await runImport(tenantA, second, feed(weekly()));
      expect(shown(await timelineOf(tenantA, "2026-11-03", "2026-11-03", first))).toEqual([]);
      expect(shown(await timelineOf(tenantA, "2026-11-03", "2026-11-03", second))).toEqual([
        "2026-11-03 09:00-10:00 Weekly",
      ]);
    });

    it("shows the occurrence again once its override is gone from the feed, and trashes the override row", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000")));
      const result = await runImport(tenantA, calendarId, feed(weekly()));
      expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1, trashed: 1 });
      const rows = await storedRows(tenantA, calendarId);
      expect(overrideRowsOf(rows).map((row) => row.deleted_at !== null)).toEqual([true]);
      expect(shown(await timelineOf(tenantA, "2026-11-01", "2026-11-08", calendarId))).toEqual([
        "2026-11-03 09:00-10:00 Weekly",
      ]);
    });

    it("shows the occurrence again once EXDATE is gone from the feed, changing only the master row", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("EXDATE:20261103T090000")));
      const result = await runImport(tenantA, calendarId, feed(weekly()));
      expect(result).toMatchObject({ updated: 1, unchanged: 0, trashed: 0 });
      expect(masterOf(await storedRows(tenantA, calendarId)).properties.exceptionDates ?? null).toBeNull();
      expect(shown(await timelineOf(tenantA, "2026-11-03", "2026-11-03", calendarId))).toHaveLength(1);
    });
  });

  describe("a series that crosses a daylight-saving change", () => {
    const NEW_YORK =
      "UID:ny@example.test\r\nSUMMARY:Stand-up\r\nDTSTART;TZID=America/New_York:20270302T090000\r\nDTEND;TZID=America/New_York:20270302T100000\r\nRRULE:FREQ=WEEKLY";

    it("keeps 09:00 in New York, and so moves the Prague time with the changes of both zones", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(NEW_YORK));
      const master = masterOf(await storedRows(tenantA, calendarId), "ny@example.test");
      expect(master.properties).toMatchObject({ startsAt: "2027-03-02T15:00", timeZone: "America/New_York" });
      const entries = await timelineOf(tenantA, "2027-03-01", "2027-04-06", calendarId);
      // The United States change on 14 March and Europe on 28 March: 15:00 in Prague, 14:00 in between, 15:00 again.
      expect(shown(entries)).toEqual([
        "2027-03-02 15:00-16:00 Stand-up",
        "2027-03-09 15:00-16:00 Stand-up",
        "2027-03-16 14:00-15:00 Stand-up",
        "2027-03-23 14:00-15:00 Stand-up",
        "2027-03-30 15:00-16:00 Stand-up",
        "2027-04-06 15:00-16:00 Stand-up",
      ]);
      for (const item of entries) {
        const inNewYork = DateTime.fromISO(`${item.date}T${item.timeFrom}`, { zone: "Europe/Prague" }).setZone(
          "America/New_York",
        );
        expect(inNewYork.toFormat("HH:mm")).toBe("09:00");
      }
    });

    it("excludes an EXDATE given in the series' own zone by its Prague wall-clock time", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(`${NEW_YORK}\r\nEXDATE;TZID=America/New_York:20270316T090000`));
      expect(masterOf(await storedRows(tenantA, calendarId), "ny@example.test").properties.exceptionDates).toBe(
        '["2027-03-16T14:00"]',
      );
      expect(shown(await timelineOf(tenantA, "2027-03-09", "2027-03-23", calendarId))).toEqual([
        "2027-03-09 15:00-16:00 Stand-up",
        "2027-03-23 14:00-15:00 Stand-up",
      ]);
    });

    it("replaces an occurrence by a RECURRENCE-ID given in the series' own zone", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          NEW_YORK,
          "UID:ny@example.test\r\nSUMMARY:Late stand-up\r\nRECURRENCE-ID;TZID=America/New_York:20270316T090000\r\nDTSTART;TZID=America/New_York:20270316T110000\r\nDTEND;TZID=America/New_York:20270316T113000",
        ),
      );
      const overrideRow = overrideRowsOf(await storedRows(tenantA, calendarId))[0];
      expect(overrideRow?.properties).toMatchObject({ recurrenceId: "2027-03-16T14:00", startsAt: "2027-03-16T16:00" });
      expect(shown(await timelineOf(tenantA, "2027-03-16", "2027-03-16", calendarId))).toEqual([
        "2027-03-16 16:00-16:30 Late stand-up",
      ]);
    });

    it("shows the series in the zone of a tenant that is elsewhere", async () => {
      const calendarId = await subscription(tenantB);
      await runImport(tenantB, calendarId, feed(NEW_YORK));
      // 09:00 in New York on 2 March 2027 is 23:00 in Tokyo, and Tokyo has no daylight saving: the Tokyo time moves an
      // hour earlier when the United States change on 14 March, and an hour of the event ends after midnight.
      expect(shown(await timelineOf(tenantB, "2027-03-02", "2027-03-17", calendarId))).toEqual([
        "2027-03-02 23:00-00:00 Stand-up",
        "2027-03-09 23:00-00:00 Stand-up",
        "2027-03-16 22:00-23:00 Stand-up",
      ]);
    });
  });

  describe("a rule that is not expanded", () => {
    const UNSUPPORTED = weekly("", "FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1");

    it("imports the feed, counts the rule in the log without feed content, and shows the event once at its start", async () => {
      const calendarId = await subscription(tenantA);
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      const result = await runImport(
        tenantA,
        calendarId,
        feed(UNSUPPORTED, "UID:lunch@example.test\r\nSUMMARY:Lunch\r\nDTSTART:20261021T120000"),
      );
      expect(result).toEqual({ created: 2, updated: 0, unchanged: 0, trashed: 0, unreadable: 0, unsupportedRules: 1 });
      expect(info).toHaveBeenCalledWith(
        {
          calendarItemId: calendarId,
          created: 2,
          updated: 0,
          unchanged: 0,
          trashed: 0,
          unreadable: 0,
          unsupportedRules: 1,
        },
        "Subscribed calendar feed imported",
      );
      const master = masterOf(await storedRows(tenantA, calendarId));
      const entries = await timelineOf(tenantA, "2026-10-01", "2027-03-31", calendarId);
      expect(entries.map((item) => [item.id, item.date, item.title])).toEqual([
        [master.id, "2026-10-20", "Weekly"],
        [expect.any(String), "2026-10-21", "Lunch"],
      ]);
    });

    // ical.js keeps a part it does not model (RSCALE, SKIP, an X- part) only as a field of its rule, and writes the rule
    // back without it, so a rule judged on that text alone would read as a plain `FREQ=YEARLY`.
    it.each([
      ["RSCALE", "RSCALE=HEBREW;FREQ=YEARLY", "RSCALE=HEBREW"],
      ["SKIP", "RSCALE=GREGORIAN;SKIP=FORWARD;FREQ=MONTHLY", "SKIP=FORWARD"],
      ["an X- part", "FREQ=WEEKLY;X-FOO=bar", "X-FOO=bar"],
      ["a part without a value", "FREQ=WEEKLY;FOO", "FOO="],
      ["a value ical.js cannot read (UNTIL)", "FREQ=WEEKLY;UNTIL=garbage", "UNTIL=garb-ag-e"],
    ])(
      "shows the event once and counts the rule when it has %s that ical.js does not write back",
      async (_name, rule, stored) => {
        const calendarId = await subscription(tenantA);
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const result = await runImport(tenantA, calendarId, feed(weekly("", rule)));
        expect(result).toEqual({
          created: 1,
          updated: 0,
          unchanged: 0,
          trashed: 0,
          unreadable: 0,
          unsupportedRules: 1,
        });
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({ calendarItemId: calendarId, unsupportedRules: 1 }),
          "Subscribed calendar feed imported",
        );
        const master = masterOf(await storedRows(tenantA, calendarId));
        expect(master.properties.recurrenceRule).toContain(stored);
        const entries = await timelineOf(tenantA, "2026-10-01", "2027-12-31", calendarId);
        expect(entries.map((item) => [item.id, item.date, item.title])).toEqual([[master.id, "2026-10-20", "Weekly"]]);
      },
    );

    it("does not count a trailing semicolon of a rule as a part, and expands the rule", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(tenantA, calendarId, feed(weekly("", "FREQ=WEEKLY;COUNT=2;")));
      expect(result).toMatchObject({ created: 1, unsupportedRules: 0 });
      expect(masterOf(await storedRows(tenantA, calendarId)).properties.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=2");
      expect(shown(await timelineOf(tenantA, "2026-10-01", "2026-12-31", calendarId))).toEqual([
        "2026-10-20 09:00-10:00 Weekly",
        "2026-10-27 09:00-10:00 Weekly",
      ]);
    });

    it("writes nothing when a feed with such a rule is imported again", async () => {
      const calendarId = await subscription(tenantA);
      const body = feed(weekly("", "RSCALE=HEBREW;FREQ=YEARLY"));
      await runImport(tenantA, calendarId, body);
      const before = await storedRows(tenantA, calendarId);
      expect(await runImport(tenantA, calendarId, body)).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });

    it("shows no entry of it in a range that does not hold its start", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(UNSUPPORTED));
      expect(await timelineOf(tenantA, "2026-11-01", "2026-12-31", calendarId)).toEqual([]);
    });

    it("shows the event once when the stored time zone is not a zone the server knows", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly()));
      const master = masterOf(await storedRows(tenantA, calendarId));
      // Raw SQL as the superuser: the import checks the zone, so no write path stores a name the server does not know.
      await admin.query(
        'UPDATE items SET properties = properties || \'{"timeZone": "Not/AZone"}\'::jsonb WHERE id = $1',
        [master.id],
      );
      const entries = await timelineOf(tenantA, "2026-10-01", "2026-12-31", calendarId);
      expect(entries.map((item) => [item.id, item.date])).toEqual([[master.id, "2026-10-20"]]);
    });
  });

  // `ICAL.parse` takes these values as they are, and ical.js throws a plain Error only when the value is read.
  describe("an EXDATE or RECURRENCE-ID value that cannot be read", () => {
    const LUNCH = "UID:lunch@example.test\r\nSUMMARY:Lunch\r\nDTSTART:20261021T120000";

    it("imports the other events of the feed and counts the VEVENT as unreadable, for an EXDATE", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(tenantA, calendarId, feed(weekly("EXDATE:garbage"), LUNCH));
      expect(result).toEqual({ created: 1, updated: 0, unchanged: 0, trashed: 0, unreadable: 1, unsupportedRules: 0 });
      expect((await storedRows(tenantA, calendarId)).map((row) => row.properties.uid)).toEqual(["lunch@example.test"]);
    });

    it("imports the other events of the feed and counts the VEVENT as unreadable, for a RECURRENCE-ID", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(weekly(), override("garbage", "20261104T103000"), LUNCH),
      );
      expect(result).toEqual({ created: 2, updated: 0, unchanged: 0, trashed: 0, unreadable: 1, unsupportedRules: 0 });
      const rows = await storedRows(tenantA, calendarId);
      expect(rows.map((row) => row.properties.uid).sort()).toEqual(["lunch@example.test", "weekly@example.test"]);
      expect(overrideRowsOf(rows)).toEqual([]);
    });

    it("keeps the stored row of a master whose EXDATE became unreadable", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly("EXDATE:20261110T090000"), LUNCH));
      const before = await storedRows(tenantA, calendarId);
      const result = await runImport(tenantA, calendarId, feed(weekly("EXDATE:garbage"), LUNCH));
      expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, trashed: 0, unreadable: 1, unsupportedRules: 0 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });

    it("counts a value that is one of several of an EXDATE as the unreadable one", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(tenantA, calendarId, feed(weekly("EXDATE:20261110T090000,garbage"), LUNCH));
      expect(result).toMatchObject({ created: 1, unreadable: 1 });
    });
  });

  describe("importing again", () => {
    it("writes nothing for an unchanged feed of a series, an exception and an override", async () => {
      const calendarId = await subscription(tenantA);
      const body = feed(weekly("EXDATE:20261110T090000"), override("20261103T090000", "20261104T103000"));
      await runImport(tenantA, calendarId, body);
      const before = await storedRows(tenantA, calendarId);
      expect(before).toHaveLength(2);

      const result = await runImport(tenantA, calendarId, body);
      expect(result).toEqual({ created: 0, updated: 0, unchanged: 2, trashed: 0, unreadable: 0, unsupportedRules: 0 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });

    it("updates only the row of the override that changed", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000")));
      const before = await storedRows(tenantA, calendarId);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(weekly(), override("20261103T090000", "20261104T113000")),
      );
      expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 1, trashed: 0 });
      const after = await storedRows(tenantA, calendarId);
      expect(after).toHaveLength(2);
      expect(masterOf(after)).toEqual(masterOf(before));
      expect(overrideRowsOf(after)[0]?.properties.startsAt).toBe("2026-11-04T11:30");
    });

    it("keeps a master and its override as two rows of one UID, and a second override as a third", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000")));
      const result = await runImport(
        tenantA,
        calendarId,
        feed(
          weekly(),
          override("20261103T090000", "20261104T103000"),
          override("20261110T090000", "20261110T150000", "Later"),
        ),
      );
      expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 2, trashed: 0 });
      const rows = (await storedRows(tenantA, calendarId)).filter((row) => row.deleted_at === null);
      expect(rows.map((row) => row.properties.recurrenceId ?? null).sort()).toEqual([
        "2026-11-03T09:00",
        "2026-11-10T09:00",
        null,
      ]);
    });

    it("keeps the first of two overrides for one occurrence", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          weekly(),
          override("20261103T090000", "20261104T103000", "First"),
          override("20261103T090000", "20261105T103000", "Second"),
        ),
      );
      expect(overrideRowsOf(await storedRows(tenantA, calendarId)).map((row) => row.properties.title)).toEqual([
        "First",
      ]);
    });

    it("gives a row stored before the series was read its rule in one update, and then writes nothing", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed("UID:weekly@example.test\r\nSUMMARY:Weekly\r\nDTSTART:20261020T090000\r\nDTEND:20261020T100000"),
      );
      expect(await runImport(tenantA, calendarId, feed(weekly()))).toMatchObject({ updated: 1, unchanged: 0 });
      expect(await runImport(tenantA, calendarId, feed(weekly()))).toMatchObject({ updated: 0, unchanged: 1 });
      expect(masterOf(await storedRows(tenantA, calendarId)).properties.recurrenceRule).toBe("FREQ=WEEKLY");
    });
  });

  describe("values the import cannot read", () => {
    it("keeps the stored row of an override whose own time it can no longer read, and counts it", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000")));
      const before = await storedRows(tenantA, calendarId);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(
          weekly(),
          "UID:weekly@example.test\r\nSUMMARY:Moved\r\nRECURRENCE-ID:20261103T090000\r\nDTSTART;TZID=Not/AZone:20261104T103000",
        ),
      );
      expect(result).toMatchObject({ unchanged: 1, trashed: 0, unreadable: 1 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });

    it("counts an override whose RECURRENCE-ID names an unknown zone and stores nothing for it", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(
          weekly(),
          "UID:weekly@example.test\r\nSUMMARY:Moved\r\nRECURRENCE-ID;TZID=Not/AZone:20261103T090000\r\nDTSTART:20261104T103000",
        ),
      );
      expect(result).toMatchObject({ created: 1, unreadable: 1 });
      expect(overrideRowsOf(await storedRows(tenantA, calendarId))).toEqual([]);
    });

    it("keeps the stored series of an event whose EXDATE names an unknown zone, and counts it", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly()));
      const before = await storedRows(tenantA, calendarId);
      const result = await runImport(tenantA, calendarId, feed(weekly("EXDATE;TZID=Not/AZone:20261103T090000")));
      expect(result).toMatchObject({ unchanged: 0, updated: 0, trashed: 0, unreadable: 1 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });

    it("keeps the stored master of an event that became unreadable, and the stored override of the same UID", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly(), override("20261103T090000", "20261104T103000")));
      const before = await storedRows(tenantA, calendarId);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:weekly@example.test\r\nSUMMARY:Weekly\r\nDTSTART;TZID=Not/AZone:20261020T090000\r\nRRULE:FREQ=WEEKLY",
          override("20261103T090000", "20261104T103000"),
        ),
      );
      expect(result).toMatchObject({ unchanged: 1, trashed: 0, unreadable: 1 });
      expect(await storedRows(tenantA, calendarId)).toEqual(before);
    });
  });

  describe("stored values the timeline cannot read", () => {
    /** Raw SQL as the superuser: the choke point stores only text in these properties, so no write path makes these. */
    async function storeRaw(tenant: Tenant, itemId: string, patch: Record<string, unknown>): Promise<void> {
      await withTenantTransaction(admin, tenant.id, async (client) => {
        const result = await client.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
          itemId,
          JSON.stringify(patch),
        ]);
        expect(result.rowCount).toBe(1);
      });
    }

    it.each([
      ["a recurrenceRule that is not text", { recurrenceRule: 7 }, "recurrenceRule"],
      ["exceptionDates that is not text", { exceptionDates: 7 }, "exceptionDates"],
      ["exceptionDates that is not JSON", { exceptionDates: "[2026" }, "exceptionDates"],
      ["exceptionDates that is not a list of strings", { exceptionDates: '{"a": 1}' }, "exceptionDates"],
      ["exceptionDates that holds a number", { exceptionDates: "[1]" }, "exceptionDates"],
    ])("leaves out an entry with %s and logs only its ids", async (_name, patch, property) => {
      // A tenant of its own: a row that an earlier case made invalid would log again in this read.
      const tenant = await seededTenant(null);
      const calendarId = await subscription(tenant);
      await runImport(
        tenant,
        calendarId,
        feed(weekly(), "UID:lunch@example.test\r\nSUMMARY:Lunch\r\nDTSTART:20261021T120000"),
      );
      const master = masterOf(await storedRows(tenant, calendarId));
      await storeRaw(tenant, master.id, patch);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const entries = await timelineOf(tenant, "2026-10-19", "2026-10-25", calendarId);
      expect(entries.map((item) => item.title)).toEqual(["Lunch"]);
      expect(warn.mock.calls).toEqual([
        [{ itemId: master.id, databaseId: tenant.subscribedEventsId, property }, SKIP_MESSAGE],
      ]);
    });

    it("reads an empty or null exceptionDates as no exception", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly()));
      const master = masterOf(await storedRows(tenantA, calendarId));
      for (const value of [null, ""]) {
        await storeRaw(tenantA, master.id, { exceptionDates: value });
        expect(await timelineOf(tenantA, "2026-10-20", "2026-10-20", calendarId)).toHaveLength(1);
      }
    });
  });

  describe("the calendar and the tenant", () => {
    it("leaves out the series of a calendar that is in the Trash", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(weekly()));
      // Raw SQL as the superuser: the calendar module refuses to trash a subscription calendar through the choke point.
      await admin.query("UPDATE items SET deleted_at = now() WHERE id = $1", [calendarId]);
      expect(await timelineOf(tenantA, "2026-10-20", "2026-12-31", calendarId)).toEqual([]);
    });

    it("does not show the series of one tenant to another, and keeps a UID that two tenants share apart", async () => {
      // Tenants of their own: the reads below are not narrowed to a calendar.
      const first = await seededTenant(null);
      const second = await seededTenant("Asia/Tokyo");
      const calendarA = await subscription(first);
      const calendarB = await subscription(second);
      await runImport(first, calendarA, feed(weekly(), override("20261103T090000", "20261104T103000")));
      await runImport(second, calendarB, feed(weekly()));
      expect(shown(await timelineOf(second, "2026-11-01", "2026-11-08"))).toEqual(["2026-11-03 09:00-10:00 Weekly"]);
      expect(shown(await timelineOf(first, "2026-11-01", "2026-11-08"))).toEqual(["2026-11-04 10:30-11:30 Moved"]);
      expect((await timelineOf(second, "2026-10-01", "2026-12-31")).map((item) => item.calendarId)).toEqual(
        Array(11).fill(calendarB),
      );
    });
  });

  it("reads with a number of statements that does not grow with the number of series", async () => {
    const tenant = await seededTenant(null);
    const calendarId = await subscription(tenant);
    const series = (index: number) =>
      `UID:series-${index}@example.test\r\nSUMMARY:Series ${index}\r\nDTSTART:2026110${index}T100000\r\nRRULE:FREQ=DAILY;COUNT=3`;
    // The orphan override is a row with an item id, which adds the lookup of tentative invitations to every read.
    const orphan = override("20261102T100000", "20261102T120000");
    await runImport(tenant, calendarId, feed(series(1), orphan));
    const count = () =>
      runInTenant(tenant.id, () =>
        withTransaction(runtime, async (client) => {
          let queries = 0;
          const counted: PoolClient = new Proxy(client, {
            get(target, property, receiver) {
              const value: unknown = Reflect.get(target, property, receiver);
              if (property !== "query" || typeof value !== "function") return value;
              return (...args: unknown[]): unknown => {
                queries += 1;
                return Reflect.apply(value, target, args);
              };
            },
          });
          const timeline = await readCalendarTimeline(counted, { from: "2026-11-01", to: "2026-11-09", shape: "full" });
          const inDatabase = z
            .array(z.looseObject({ databaseId: z.string().optional() }))
            .parse(timeline.items)
            .filter((item) => item.databaseId === tenant.subscribedEventsId);
          return { queries, items: inDatabase.length };
        }),
      );

    const one = await count();
    await runImport(tenant, calendarId, feed(series(1), series(2), series(3), series(4), orphan));
    const four = await count();
    expect(one.items).toBe(4);
    expect(four.items).toBeGreaterThan(one.items);
    expect(four.queries).toBe(one.queries);
  });
});
