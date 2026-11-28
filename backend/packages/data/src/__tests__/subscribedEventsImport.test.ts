import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { CALENDAR_FEED_LIMITS, handleCalendarSubscriptionSweepTask } from "../calendar/calendarSubscriptionSweep.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { logger } from "../calendar/logger.js";
import { readCalendarTimeline } from "../calendar/timelineRead.js";
import { CalendarFeedParseError, importSubscribedEvents } from "../calendar/subscribedEventsImport.js";
import { allowLoopbackOutboundForTests } from "../net/outboundAddressPolicy.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * The ICS feed import on the runtime role pool. Each case uses its own subscription calendar so cases are
 * order-independent. Tenant A is in `Europe/Prague`; tenant B in `Asia/Tokyo` and is the isolation peer.
 */

const USER = { writerKind: "user" } as const;

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
let tenantWithoutDatabase: Tenant;

const storedRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updated_at: z.date(),
  deleted_at: z.date().nullable(),
});
type StoredRow = z.infer<typeof storedRow>;

function feed(...vevents: string[]): string {
  const body = vevents.map((lines) => `BEGIN:VEVENT\r\n${lines}\r\nEND:VEVENT\r\n`).join("");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}END:VCALENDAR\r\n`;
}

const TEAM_MEETING =
  "UID:team-meeting@example.test\r\nSUMMARY:Team meeting\r\nDTSTART:20261020T090000\r\nDTEND:20261020T100000";
const LUNCH =
  "UID:lunch@example.test\r\nSUMMARY:Lunch\r\nLOCATION:Canteen\r\nDTSTART:20261021T120000\r\nDTEND:20261021T130000";

async function seededTenant(timeZone: string | null): Promise<Tenant> {
  const id = await createTestTenant(admin);
  await createUser(admin, {
    tenantId: id,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(id, () => seedSystem(runtime));
  if (timeZone !== null) {
    // Raw SQL: the tenant's zone is setup, not the write under test.
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

/** Written as the calendar module (only it may write `kind`); without an address, the sweep never requests it. */
async function subscription(tenant: Tenant): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: tenant.calendarsId,
          properties: {
            name: `Feed ${randomUUID()}`,
            color: "#8E8E93",
            kind: "subscription",
          },
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

async function storedEvents(tenant: Tenant, calendarItemId: string): Promise<Map<string, StoredRow>> {
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
  return new Map(rows.map((row) => storedRow.parse(row)).map((row) => [String(row.properties.uid), row]));
}

function live(rows: Map<string, StoredRow>): string[] {
  return [...rows.values()].filter((row) => row.deleted_at === null).map((row) => String(row.properties.uid));
}

function propertiesOf(rows: Map<string, StoredRow>, uid: string): Record<string, unknown> {
  const row = rows.get(uid);
  if (!row) throw new Error(`No stored event ${uid}`);
  return row.properties;
}

describe("the ICS feed import (issue gh-2004)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    cp = createChokePoint(runtime);
    tenantA = await seededTenant(null);
    tenantB = await seededTenant("Asia/Tokyo");
    tenantWithoutDatabase = await seededTenant(null);
    // Raw SQL: no write path removes a system database; this is a tenant without a subscribed-events module database.
    await admin.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [
      tenantWithoutDatabase.subscribedEventsId,
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime.end();
  });

  describe("creating and keeping the events of a feed", () => {
    it("creates one item per event, linked to the calendar and written by the calendar module", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      expect(result).toEqual({ created: 2, updated: 0, unchanged: 0, trashed: 0, unreadable: 0, unsupportedRules: 0 });
      const rows = await storedEvents(tenantA, calendarId);
      expect(live(rows).sort()).toEqual(["lunch@example.test", "team-meeting@example.test"]);
      expect(propertiesOf(rows, "team-meeting@example.test")).toEqual({
        uid: "team-meeting@example.test",
        title: "Team meeting",
        startsAt: "2026-10-20T09:00",
        endsAt: "2026-10-20T10:00",
        allDay: false,
      });
      expect(propertiesOf(rows, "lunch@example.test")).toMatchObject({ title: "Lunch", place: "Canteen" });
      const { rows: edges } = await runInTenant(tenantA.id, () =>
        withTransaction(runtime, (client) =>
          client.query("SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1", [calendarId]),
        ),
      );
      expect(edges[0]).toEqual({ n: 2 });
    });

    it("changes nothing on a second import of the same feed", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      const before = await storedEvents(tenantA, calendarId);
      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      expect(result).toEqual({ created: 0, updated: 0, unchanged: 2, trashed: 0, unreadable: 0, unsupportedRules: 0 });
      expect(await storedEvents(tenantA, calendarId)).toEqual(before);
    });

    it("writes only the values that changed, and clears a value the feed dropped", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      const before = await storedEvents(tenantA, calendarId);
      const changedLunch =
        "UID:lunch@example.test\r\nSUMMARY:Late lunch\r\nDTSTART:20261021T123000\r\nDTEND:20261021T130000";
      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING, changedLunch));
      expect(result).toEqual({ created: 0, updated: 1, unchanged: 1, trashed: 0, unreadable: 0, unsupportedRules: 0 });
      const after = await storedEvents(tenantA, calendarId);
      expect(after.get("team-meeting@example.test")).toEqual(before.get("team-meeting@example.test"));
      const lunch = after.get("lunch@example.test");
      expect(lunch?.id).toBe(before.get("lunch@example.test")?.id);
      expect(lunch?.properties).toEqual({
        uid: "lunch@example.test",
        title: "Late lunch",
        startsAt: "2026-10-21T12:30",
        endsAt: "2026-10-21T13:00",
        allDay: false,
        place: null,
      });
      expect(lunch?.updated_at.getTime()).toBeGreaterThan(before.get("lunch@example.test")?.updated_at.getTime() ?? 0);
    });

    it("keeps one item per UID when a feed repeats a UID, taking the first", async () => {
      const calendarId = await subscription(tenantA);
      const second = "UID:team-meeting@example.test\r\nSUMMARY:Other\r\nDTSTART:20261022T090000";
      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING, second));
      expect(result.created).toBe(1);
      expect(propertiesOf(await storedEvents(tenantA, calendarId), "team-meeting@example.test").title).toBe(
        "Team meeting",
      );
    });

    it("trashes the live rows of a UID beyond the oldest one", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING));
      const first = (await storedEvents(tenantA, calendarId)).get("team-meeting@example.test");
      // A second live row of the same UID, written as the import writes: the import never makes one itself.
      const calendarProperty = (
        await runInTenant(tenantA.id, () => cp.listProperties(tenantA.subscribedEventsId))
      ).find((property) => property.key === "calendar");
      await runInTenant(tenantA.id, () =>
        withTransaction(runtime, async (client) => {
          const duplicate = await createItemWithClient(
            client,
            {
              databaseId: tenantA.subscribedEventsId,
              properties: { uid: "team-meeting@example.test", title: "Team meeting", startsAt: "2026-10-20T09:00" },
            },
            { allowedSystemKeys: ["uid", "title", "startsAt"], systemOwnerProcess: CALENDAR_MODULE_ID },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: calendarProperty?.id ?? "", callerItemId: duplicate.id, targetItemId: calendarId },
            { ownerProcess: CALENDAR_MODULE_ID },
          );
        }),
      );
      expect(await runImport(tenantA, calendarId, feed(TEAM_MEETING))).toMatchObject({ unchanged: 1, trashed: 1 });
      const { rows } = await runInTenant(tenantA.id, () =>
        withTransaction(runtime, (client) =>
          client.query(
            `SELECT i.id FROM item_relations r JOIN items i ON i.id = r.item_b
              WHERE r.item_a = $1 AND i.database_id = $2 AND i.deleted_at IS NULL`,
            [calendarId, tenantA.subscribedEventsId],
          ),
        ),
      );
      expect(rows).toEqual([{ id: first?.id }]);
    });

    it("imports an empty calendar and keeps the events of the other calendars of the tenant", async () => {
      const first = await subscription(tenantA);
      const second = await subscription(tenantA);
      await runImport(tenantA, first, feed(TEAM_MEETING));
      await runImport(tenantA, second, feed(LUNCH));
      const result = await runImport(tenantA, first, feed());
      expect(result).toMatchObject({ created: 0, trashed: 1 });
      expect(live(await storedEvents(tenantA, first))).toEqual([]);
      expect(live(await storedEvents(tenantA, second))).toEqual(["lunch@example.test"]);
    });

    it("reads a feed with a byte order mark and bare line feeds", async () => {
      const calendarId = await subscription(tenantA);
      const body = `${String.fromCharCode(0xfeff)}${feed(TEAM_MEETING).replace(/\r\n/g, "\n")}`;
      expect(await runImport(tenantA, calendarId, body)).toMatchObject({ created: 1 });
    });

    it("logs the ids and the counts of an import and no feed content", async () => {
      const calendarId = await subscription(tenantA);
      const info = vi.spyOn(logger, "info");
      await runImport(tenantA, calendarId, feed(TEAM_MEETING));
      expect(info).toHaveBeenCalledWith(
        {
          calendarItemId: calendarId,
          created: 1,
          updated: 0,
          unchanged: 0,
          trashed: 0,
          unreadable: 0,
          unsupportedRules: 0,
        },
        "Subscribed calendar feed imported",
      );
    });

    it("logs nothing for an import whose transaction is rolled back", async () => {
      const calendarId = await subscription(tenantA);
      const info = vi.spyOn(logger, "info");
      await expect(
        runInTenant(tenantA.id, () =>
          withTransaction(runtime, async (client) => {
            await importSubscribedEvents(client, { calendarItemId: calendarId, body: feed(TEAM_MEETING) });
            throw new Error("The validators could not be stored");
          }),
        ),
      ).rejects.toThrow("The validators could not be stored");
      expect(info).not.toHaveBeenCalledWith(expect.anything(), "Subscribed calendar feed imported");
      expect(live(await storedEvents(tenantA, calendarId))).toEqual([]);
    });
  });

  describe("an event that leaves the feed", () => {
    it("moves it to the Trash, restorably, and creates a new item when its UID returns", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      const imported = await storedEvents(tenantA, calendarId);
      const lunchId = imported.get("lunch@example.test")?.id ?? "";

      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING));
      expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, trashed: 1, unreadable: 0, unsupportedRules: 0 });
      const trashed = await storedEvents(tenantA, calendarId);
      expect(trashed.get("lunch@example.test")?.deleted_at).not.toBeNull();
      expect(live(trashed)).toEqual(["team-meeting@example.test"]);
      expect(trashed.get("team-meeting@example.test")?.deleted_at).toBeNull();

      const restored = await runInTenant(tenantA.id, () =>
        cp.restoreItem(tenantA.subscribedEventsId, lunchId, undefined, USER),
      );
      expect(restored?.deletedAt).toBeNull();
      expect(live(await storedEvents(tenantA, calendarId)).sort()).toEqual([
        "lunch@example.test",
        "team-meeting@example.test",
      ]);

      // Trashed again by the next import without it; then the UID comes back and gets a new item.
      await runImport(tenantA, calendarId, feed(TEAM_MEETING));
      const second = await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      expect(second).toMatchObject({ created: 1, trashed: 0 });
      const returned = await storedEvents(tenantA, calendarId);
      expect(returned.get("lunch@example.test")?.id).not.toBe(lunchId);
      expect(returned.get("lunch@example.test")?.deleted_at).toBeNull();
      const { rows: old } = await runInTenant(tenantA.id, () =>
        withTransaction(runtime, (client) => client.query("SELECT deleted_at FROM items WHERE id = $1", [lunchId])),
      );
      expect(old).toHaveLength(1);
    });
  });

  describe("times", () => {
    it("stores 2026-10-20 09:00 America/New_York as 15:00 for a tenant in Europe/Prague and keeps the zone", async () => {
      const calendarId = await subscription(tenantA);
      const body = feed(
        "UID:ny@example.test\r\nSUMMARY:Call\r\nDTSTART;TZID=America/New_York:20261020T090000\r\nDTEND;TZID=America/New_York:20261020T103000",
      );
      await runImport(tenantA, calendarId, body);
      expect(propertiesOf(await storedEvents(tenantA, calendarId), "ny@example.test")).toMatchObject({
        startsAt: "2026-10-20T15:00",
        endsAt: "2026-10-20T16:30",
        timeZone: "America/New_York",
        allDay: false,
      });
    });

    it("converts a UTC time to the tenant's wall clock and names the zone UTC", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed("UID:utc@example.test\r\nDTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z"),
      );
      expect(propertiesOf(await storedEvents(tenantA, calendarId), "utc@example.test")).toMatchObject({
        startsAt: "2026-10-20T15:00",
        endsAt: "2026-10-20T16:00",
        timeZone: "UTC",
      });
    });

    it("converts to the zone of the tenant it is imported for", async () => {
      const calendarId = await subscription(tenantB);
      await runImport(
        tenantB,
        calendarId,
        feed("UID:utc@example.test\r\nDTSTART:20261020T130000Z\r\nDTEND:20261020T140000Z"),
      );
      expect(propertiesOf(await storedEvents(tenantB, calendarId), "utc@example.test")).toMatchObject({
        startsAt: "2026-10-20T22:00",
        endsAt: "2026-10-20T23:00",
      });
    });

    it("stores a floating time unchanged, without a zone", async () => {
      const calendarId = await subscription(tenantB);
      await runImport(tenantB, calendarId, feed(TEAM_MEETING));
      const stored = propertiesOf(await storedEvents(tenantB, calendarId), "team-meeting@example.test");
      expect(stored).toMatchObject({ startsAt: "2026-10-20T09:00", endsAt: "2026-10-20T10:00" });
      expect(stored).not.toHaveProperty("timeZone");
    });

    it("converts an end given by DURATION in the zone of the start, and an end in another zone on its own", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:duration@example.test\r\nDTSTART;TZID=America/New_York:20261020T090000\r\nDURATION:PT1H30M",
          "UID:mixed@example.test\r\nDTSTART;TZID=America/New_York:20261020T090000\r\nDTEND;TZID=Europe/London:20261020T150000",
        ),
      );
      const rows = await storedEvents(tenantA, calendarId);
      expect(propertiesOf(rows, "duration@example.test")).toMatchObject({
        startsAt: "2026-10-20T15:00",
        endsAt: "2026-10-20T16:30",
      });
      expect(propertiesOf(rows, "mixed@example.test")).toMatchObject({
        startsAt: "2026-10-20T15:00",
        endsAt: "2026-10-20T16:00",
      });
    });

    it("stores no end for an event without one, or whose end is not after its start", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:open@example.test\r\nDTSTART:20261020T090000",
          "UID:backwards@example.test\r\nDTSTART:20261020T090000\r\nDTEND:20261020T080000",
          "UID:empty@example.test\r\nDTSTART:20261020T090000\r\nDTEND:20261020T090000",
        ),
      );
      const rows = await storedEvents(tenantA, calendarId);
      for (const uid of ["open@example.test", "backwards@example.test", "empty@example.test"]) {
        expect(propertiesOf(rows, uid)).not.toHaveProperty("endsAt");
      }
    });

    it("keeps the inclusive date range of an all-day event, and a single day has no end", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:trip@example.test\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261023",
          "UID:day@example.test\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261021",
          "UID:bare@example.test\r\nDTSTART;VALUE=DATE:20261031",
          "UID:month@example.test\r\nDTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261101",
        ),
      );
      const rows = await storedEvents(tenantA, calendarId);
      // The timeline source reads wall-clock values, so a date is stored at midnight of its day.
      expect(propertiesOf(rows, "trip@example.test")).toEqual({
        uid: "trip@example.test",
        title: "Trip",
        startsAt: "2026-10-20T00:00",
        endsAt: "2026-10-22T00:00",
        allDay: true,
      });
      expect(propertiesOf(rows, "day@example.test")).toEqual({
        uid: "day@example.test",
        startsAt: "2026-10-20T00:00",
        allDay: true,
      });
      expect(propertiesOf(rows, "bare@example.test")).not.toHaveProperty("endsAt");
      expect(propertiesOf(rows, "month@example.test")).toMatchObject({ endsAt: "2026-10-31T00:00" });
    });

    it("stores events that the calendar timeline reads at the tenant's wall-clock time", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(
        tenantA,
        calendarId,
        feed(
          "UID:ny@example.test\r\nSUMMARY:Call\r\nDTSTART;TZID=America/New_York:20261020T090000\r\nDTEND;TZID=America/New_York:20261020T103000",
          "UID:trip@example.test\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261023",
        ),
      );
      const timeline = await runInTenant(tenantA.id, () =>
        withTransaction(runtime, (client) =>
          readCalendarTimeline(client, { from: "2026-10-20", to: "2026-10-22", shape: "full" }),
        ),
      );
      const items = z
        .object({
          items: z.array(
            z
              .object({
                id: z.string(),
                title: z.string(),
                calendarId: z.string().nullable(),
                allDay: z.boolean(),
                date: z.string(),
                endDate: z.string().nullable(),
                timeFrom: z.string().nullable(),
                timeTo: z.string().nullable(),
                readOnly: z.boolean(),
              })
              // The timeline holds entries of other kinds, which carry only some of these fields.
              .partial(),
          ),
        })
        .parse(timeline).items;
      const ours = items.filter((item) => item.calendarId === calendarId);
      expect(ours.find((item) => item.title === "Call")).toMatchObject({
        allDay: false,
        date: "2026-10-20",
        timeFrom: "15:00",
        timeTo: "16:30",
        readOnly: true,
      });
      expect(ours.find((item) => item.title === "Trip")).toMatchObject({
        allDay: true,
        date: "2026-10-20",
        endDate: "2026-10-22",
        timeFrom: null,
      });
    });
  });

  describe("a feed that cannot be read", () => {
    const calendarFeed = feed(TEAM_MEETING, LUNCH);
    const cases: ReadonlyArray<[string, string]> = [
      ["text that is not iCalendar", "<html><body>Sign in</body></html>"],
      ["an empty body", ""],
      ["a feed cut off inside an event", calendarFeed.slice(0, calendarFeed.indexOf("DTEND") + 3)],
      ["a feed cut off before END:VCALENDAR", calendarFeed.slice(0, calendarFeed.lastIndexOf("END:VCALENDAR"))],
      ["two calendars in one text", calendarFeed + calendarFeed],
      ["a document of another type", "BEGIN:VTODO\r\nUID:x\r\nEND:VTODO\r\n"],
    ];

    it.each(cases)("fails the import and leaves the stored events as they were for %s", async (_name, body) => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, calendarFeed);
      const before = await storedEvents(tenantA, calendarId);
      await expect(runImport(tenantA, calendarId, body)).rejects.toBeInstanceOf(CalendarFeedParseError);
      expect(await storedEvents(tenantA, calendarId)).toEqual(before);
    });

    it("does not put the text of the feed in the error message", async () => {
      const calendarId = await subscription(tenantA);
      const failure = await runImport(tenantA, calendarId, "SECRET-FEED-TEXT").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(CalendarFeedParseError);
      expect(failure instanceof Error ? failure.message : "").not.toContain("SECRET-FEED-TEXT");
    });

    it("skips an event without a UID or a readable time, counts it and keeps the rows of the others", async () => {
      const calendarId = await subscription(tenantA);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(
          TEAM_MEETING,
          "DTSTART:20261020T090000\r\nSUMMARY:No UID",
          "UID:no-start@example.test\r\nSUMMARY:No start",
          "UID:bad-start@example.test\r\nDTSTART:garbage",
          "UID:unknown-zone@example.test\r\nDTSTART;TZID=Not/AZone:20261020T090000",
          "UID:fixed-offset@example.test\r\nDTSTART;TZID=system:20261020T090000",
        ),
      );
      expect(result).toEqual({ created: 1, updated: 0, unchanged: 0, trashed: 0, unreadable: 5, unsupportedRules: 0 });
      expect(live(await storedEvents(tenantA, calendarId))).toEqual(["team-meeting@example.test"]);
    });

    it("keeps the stored row of an event whose entry in the feed became unreadable", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING, LUNCH));
      const before = await storedEvents(tenantA, calendarId);
      const result = await runImport(
        tenantA,
        calendarId,
        feed(TEAM_MEETING, "UID:lunch@example.test\r\nSUMMARY:Lunch\r\nDTSTART;TZID=Not/AZone:20261021T120000"),
      );
      expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, trashed: 0, unreadable: 1, unsupportedRules: 0 });
      expect(await storedEvents(tenantA, calendarId)).toEqual(before);
    });
  });

  describe("the work a feed costs", () => {
    it("parses thousands of events and RECURRENCE-ID overrides in time linear in the feed, not quadratic", async () => {
      // `new ICAL.Event(component)` relates every override to every event, which made this feed take over ten seconds
      // in one synchronous call. None has a start, so they are counted, not stored: the case measures the parse.
      const count = 8000;
      const events = Array.from({ length: count }, (_, index) => `UID:bare-${index}@example.test\r\nSUMMARY:Bare`);
      const overrides = Array.from(
        { length: count },
        (_, index) => `UID:bare-${index}@example.test\r\nRECURRENCE-ID:20261027T090000\r\nSUMMARY:Moved`,
      );
      const calendarId = await subscription(tenantA);
      const started = performance.now();
      const result = await runImport(tenantA, calendarId, feed(TEAM_MEETING, ...events, ...overrides));
      const elapsed = performance.now() - started;
      expect(result).toEqual({
        created: 1,
        updated: 0,
        unchanged: 0,
        trashed: 0,
        unreadable: 2 * count,
        unsupportedRules: 0,
      });
      expect(live(await storedEvents(tenantA, calendarId))).toEqual(["team-meeting@example.test"]);
      expect(elapsed).toBeLessThan(5000);
    }, 60_000);
  });

  describe("the calendar the feed belongs to", () => {
    it("fails for a calendar that does not exist, and writes nothing", async () => {
      await expect(runImport(tenantA, randomUUID(), feed(TEAM_MEETING))).rejects.toThrow("not a live calendar");
    });

    it("fails for a trashed calendar, and writes nothing", async () => {
      const calendarId = await subscription(tenantA);
      // Raw SQL: the calendar module refuses to trash a subscription calendar through the choke point.
      await admin.query("UPDATE items SET deleted_at = now() WHERE id = $1", [calendarId]);
      await expect(runImport(tenantA, calendarId, feed(TEAM_MEETING))).rejects.toThrow("not a live calendar");
      expect((await storedEvents(tenantA, calendarId)).size).toBe(0);
    });

    it("fails in a tenant that has no subscribedEvents database, and writes nothing", async () => {
      const calendarId = await subscription(tenantWithoutDatabase);
      await expect(runImport(tenantWithoutDatabase, calendarId, feed(TEAM_MEETING))).rejects.toThrow(
        "no Calendars or subscribedEvents database",
      );
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        tenantWithoutDatabase.subscribedEventsId,
      ]);
      expect(rows[0]).toEqual({ n: 0 });
    });

    it("does not reach another tenant's calendar or events", async () => {
      const calendarA = await subscription(tenantA);
      const calendarB = await subscription(tenantB);
      await runImport(tenantB, calendarB, feed(LUNCH));
      const beforeB = await storedEvents(tenantB, calendarB);
      // Tenant A's scope cannot see tenant B's calendar: it is answered as a calendar that does not exist.
      await expect(runImport(tenantA, calendarB, feed(TEAM_MEETING))).rejects.toThrow("not a live calendar");
      await runImport(tenantA, calendarA, feed(TEAM_MEETING));
      expect(await storedEvents(tenantB, calendarB)).toEqual(beforeB);
      expect(live(await storedEvents(tenantA, calendarA))).toEqual(["team-meeting@example.test"]);
    });
  });

  describe("writers other than the import", () => {
    it("keeps refusing a user write to an imported event", async () => {
      const calendarId = await subscription(tenantA);
      await runImport(tenantA, calendarId, feed(TEAM_MEETING));
      const row = (await storedEvents(tenantA, calendarId)).get("team-meeting@example.test");
      await expect(
        runInTenant(tenantA.id, () =>
          cp.updateItem(
            { databaseId: tenantA.subscribedEventsId, itemId: row?.id ?? "", propertiesPatch: { title: "Mine" } },
            undefined,
            undefined,
            USER,
          ),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });
      expect(propertiesOf(await storedEvents(tenantA, calendarId), "team-meeting@example.test").title).toBe(
        "Team meeting",
      );
    });
  });

  describe("through the hourly sweep", () => {
    let server: http.Server;
    let body: string;
    let restorePolicy: (() => void) | null = null;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/calendar" });
        res.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    afterEach(() => {
      restorePolicy?.();
      restorePolicy = null;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** Raw SQL: the write rule refuses an address with a port. */
    async function pointAtServer(calendarId: string): Promise<void> {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("The feed server has no port");
      await admin.query(
        "UPDATE items SET properties = jsonb_set(properties, '{subscriptionUrl}', to_jsonb($2::text)) WHERE id = $1",
        [calendarId, `http://127.0.0.1:${address.port}/a.ics`],
      );
    }

    it("imports the feed with the consumer that the calendar module registers, and a broken feed later changes nothing", async () => {
      const calendarId = await subscription(tenantA);
      await pointAtServer(calendarId);
      restorePolicy = allowLoopbackOutboundForTests();

      body = feed(TEAM_MEETING, LUNCH);
      await handleCalendarSubscriptionSweepTask(runtime, CALENDAR_FEED_LIMITS);
      const imported = await storedEvents(tenantA, calendarId);
      expect(live(imported).sort()).toEqual(["lunch@example.test", "team-meeting@example.test"]);
      const { rows: first } = await admin.query(
        "SELECT last_status, last_error_code FROM calendar_feed_state WHERE calendar_item_id = $1",
        [calendarId],
      );
      expect(first).toEqual([{ last_status: 200, last_error_code: null }]);

      body = feed(TEAM_MEETING).slice(0, 80);
      await handleCalendarSubscriptionSweepTask(runtime, CALENDAR_FEED_LIMITS);
      expect(await storedEvents(tenantA, calendarId)).toEqual(imported);
      const { rows: second } = await admin.query(
        "SELECT last_status, last_error_code FROM calendar_feed_state WHERE calendar_item_id = $1",
        [calendarId],
      );
      expect(second).toEqual([{ last_status: 200, last_error_code: "consumerFailed" }]);
    });
  });
});
