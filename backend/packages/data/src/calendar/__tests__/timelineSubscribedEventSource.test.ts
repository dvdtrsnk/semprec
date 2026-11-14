import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
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
import { readCalendarTimeline } from "../timelineRead.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";
import { CALENDAR_TIMELINE_SOURCES, type CalendarTimelineContext } from "../timelineSources.js";
import { readSubscribedEventTimelineItems } from "../timelineSubscribedEventSource.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";
/** The properties the calendar module writes on a subscribed event, which it may write as the system owner. */
const SUBSCRIBED_EVENT_KEYS = ["uid", "title", "startsAt", "endsAt", "timeZone", "allDay", "place"];

const timelineItem = z.object({
  kind: z.string(),
  id: z.string(),
  databaseId: z.string(),
  title: z.string(),
  type: z.string().nullable(),
  date: z.string(),
  endDate: z.string().nullable(),
  timeFrom: z.string().nullable(),
  timeTo: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  hasEnd: z.boolean(),
  allDay: z.boolean(),
  calendarId: z.string().nullable(),
  status: z.string().nullable(),
  place: z.string().nullable(),
  project: z.null(),
  people: z.array(z.unknown()),
  tasks: z.array(z.unknown()).nullable(),
  counts: z.object({ open: z.number(), total: z.number() }).nullable(),
  updatedAt: z.string(),
  readOnly: z.boolean(),
});
const compactItem = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  calendarId: z.string().nullable(),
  allDay: z.boolean(),
  date: z.string(),
  endDate: z.string().nullable(),
  timeFrom: z.string().nullable(),
  status: z.string().nullable(),
  counts: z.null(),
  updatedAt: z.string(),
  readOnly: z.boolean(),
});
const itemRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });

async function newTenant(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "cs" });
  await runInTenant(tenantId, () => seedSystem(dataPool));
  // The sleep nights of a seeded tenant have their own tests (issue #1806); these keep to events.
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

  async function calendarNamed(name: string): Promise<string> {
    const calendars = await databaseId(CALENDARS_MODULE_ID);
    const rows = z.array(itemRow).parse((await inTenant(() => chokePoint.listItems(calendars, { limit: 50 }))).items);
    const row = rows.find((candidate) => candidate.properties.name === name);
    if (!row) throw new Error(`No calendar ${name}`);
    return row.id;
  }

  /** A calendar of the `subscription` kind, which only the calendar module writes. */
  async function createSubscriptionCalendar(name: string): Promise<string> {
    const calendars = await databaseId(CALENDARS_MODULE_ID);
    const item = await inTenant(() =>
      withTransaction(dataPool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: calendars,
            properties: {
              name,
              color: "#FF9500",
              notify: false,
              hidden: false,
              isDefault: false,
              kind: "subscription",
            },
          },
          { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      ),
    );
    return item.id;
  }

  /** A calendar of the user's own, which the user may move to the Trash. */
  async function createOwnCalendar(name: string): Promise<string> {
    const calendars = await databaseId(CALENDARS_MODULE_ID);
    const item = await inTenant(() =>
      chokePoint.createItem(
        { databaseId: calendars, properties: { name, color: "#FF9500", notify: false } },
        undefined,
        undefined,
        USER,
      ),
    );
    return item.id;
  }

  /** The write the feed import makes: the system writer with the calendar module's owner process, and the calendar edge. */
  async function createSubscribedEvent(
    properties: Record<string, unknown>,
    calendarId: string | null,
  ): Promise<string> {
    const subscribedEvents = await databaseId(SUBSCRIBED_EVENTS_MODULE_ID);
    return inTenant(async () => {
      const calendarProperty = (await chokePoint.listProperties(subscribedEvents)).find((p) => p.key === "calendar");
      if (!calendarProperty) throw new Error("No SubscribedEvents.calendar");
      return withTransaction(dataPool, async (client) => {
        const item = await createItemWithClient(
          client,
          { databaseId: subscribedEvents, properties },
          { allowedSystemKeys: SUBSCRIBED_EVENT_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
        );
        if (calendarId !== null) {
          await createRelationWithClient(
            client,
            { relationPropertyId: calendarProperty.id, callerItemId: item.id, targetItemId: calendarId },
            { ownerProcess: CALENDAR_MODULE_ID },
          );
        }
        return item.id;
      });
    });
  }

  async function createEvent(properties: Record<string, unknown>): Promise<string> {
    const events = await databaseId("events");
    const item = await inTenant(() =>
      chokePoint.createItem({ databaseId: events, properties }, undefined, undefined, USER),
    );
    return item.id;
  }

  async function trash(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => chokePoint.softDeleteItem(id, itemId));
  }

  /** Overwrites stored properties with values the write rules would refuse. */
  async function storeRaw(itemId: string, patch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(SUBSCRIBED_EVENTS_MODULE_ID);
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [id, itemId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(dataPool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /** The subscribed events of a range, in the order the timeline returns them; derived entries have no `databaseId`. */
  async function subscribed(from: string, to: string = from) {
    const subscribedEvents = await databaseId(SUBSCRIBED_EVENTS_MODULE_ID);
    const entries = z.array(z.looseObject({ databaseId: z.string().optional() })).parse((await read(from, to)).items);
    return z.array(timelineItem).parse(entries.filter((entry) => entry.databaseId === subscribedEvents));
  }

  return {
    inTenant,
    databaseId,
    calendarNamed,
    createSubscriptionCalendar,
    createOwnCalendar,
    createSubscribedEvent,
    createEvent,
    trash,
    storeRaw,
    read,
    subscribed,
  };
}

describe("calendar timeline source of subscribed events (issue gh-2005)", () => {
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
    await dataPool?.end();
    await adminPool?.end();
  });

  it("is listed among the timeline sources", () => {
    expect(CALENDAR_TIMELINE_SOURCES.map((source) => source.id)).toContain("subscribedEvents");
  });

  it("shows a stored event at the wall-clock time the import stored, read-only, with its calendar", async () => {
    const w = world(await newTenant());
    const feed = await w.createSubscriptionCalendar("Feed");
    // The feed says 2026-10-20 09:00 America/New_York; the import stores it in the tenant's zone, Europe/Prague.
    const startsAt = DateTime.fromISO("2026-10-20T09:00", { zone: "America/New_York" })
      .setZone("Europe/Prague")
      .toFormat("yyyy-MM-dd'T'HH:mm");
    const id = await w.createSubscribedEvent(
      {
        uid: "event-1@example.com",
        title: "Quarterly review",
        startsAt,
        endsAt: "2026-10-20T16:00",
        timeZone: "America/New_York",
        allDay: false,
        place: "Room 4",
      },
      feed,
    );

    const [item, ...rest] = await w.subscribed("2026-10-20");
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      kind: "event",
      id,
      databaseId: await w.databaseId(SUBSCRIBED_EVENTS_MODULE_ID),
      title: "Quarterly review",
      type: null,
      date: "2026-10-20",
      endDate: null,
      timeFrom: "15:00",
      timeTo: "16:00",
      effectiveTo: "16:00",
      hasEnd: true,
      allDay: false,
      calendarId: feed,
      status: null,
      place: "Room 4",
      project: null,
      people: [],
      tasks: null,
      counts: null,
      readOnly: true,
    });
    expect(Date.parse(item?.updatedAt ?? "")).not.toBeNaN();
  });

  it("returns an entry without an end with no timeTo and the end of its day as effectiveTo", async () => {
    const w = world(await newTenant());
    await w.createSubscribedEvent({ title: "Open end", startsAt: "2026-10-20T15:00", allDay: false }, null);

    const [item] = await w.subscribed("2026-10-20");
    expect(item).toMatchObject({ timeFrom: "15:00", timeTo: null, hasEnd: false, effectiveTo: "23:59", endDate: null });
  });

  it("returns a timed entry that ends on a later day once, with its range and the end time on that day", async () => {
    const w = world(await newTenant());
    const id = await w.createSubscribedEvent(
      { title: "Overnight", startsAt: "2026-10-20T22:00", endsAt: "2026-10-21T02:30", allDay: false },
      null,
    );

    for (const [from, to] of [
      ["2026-10-20", "2026-10-20"],
      ["2026-10-21", "2026-10-21"],
      ["2026-10-19", "2026-10-22"],
    ] as const) {
      const items = await w.subscribed(from, to);
      expect(
        items.map((item) => item.id),
        `${from}..${to}`,
      ).toEqual([id]);
      expect(items[0]).toMatchObject({
        date: "2026-10-20",
        endDate: "2026-10-21",
        timeFrom: "22:00",
        timeTo: "02:30",
        effectiveTo: "02:30",
      });
    }
    expect(await w.subscribed("2026-10-19")).toEqual([]);
    expect(await w.subscribed("2026-10-22")).toEqual([]);
  });

  it("returns an all-day entry that spans two days once for a range with only its second day", async () => {
    const w = world(await newTenant());
    const id = await w.createSubscribedEvent(
      { title: "Conference", startsAt: "2026-10-20T00:00", endsAt: "2026-10-21T00:00", allDay: true },
      null,
    );

    const [item, ...rest] = await w.subscribed("2026-10-21");
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id,
      date: "2026-10-20",
      endDate: "2026-10-21",
      allDay: true,
      timeFrom: null,
      timeTo: null,
      hasEnd: false,
      effectiveTo: null,
      readOnly: true,
    });
    expect((await w.subscribed("2026-10-20", "2026-10-21")).map((entry) => entry.id)).toEqual([id]);
    expect(await w.subscribed("2026-10-19")).toEqual([]);
    expect(await w.subscribed("2026-10-22")).toEqual([]);
  });

  it("returns an all-day entry that ends on its first day with no endDate", async () => {
    const w = world(await newTenant());
    await w.createSubscribedEvent(
      { title: "Holiday", startsAt: "2026-10-20T00:00", endsAt: "2026-10-20T23:59", allDay: true },
      null,
    );

    expect((await w.subscribed("2026-10-20"))[0]).toMatchObject({ endDate: null, allDay: true, timeFrom: null });
  });

  it("does not return a trashed subscribed event and returns the live one beside it", async () => {
    const w = world(await newTenant());
    const trashed = await w.createSubscribedEvent({ title: "Gone", startsAt: "2026-10-20T10:00", allDay: false }, null);
    const live = await w.createSubscribedEvent({ title: "Here", startsAt: "2026-10-20T11:00", allDay: false }, null);
    await w.trash(SUBSCRIBED_EVENTS_MODULE_ID, trashed);

    expect((await w.subscribed("2026-10-20")).map((item) => item.id)).toEqual([live]);
  });

  it("does not return a subscribed event of a calendar in the Trash and returns one of a live calendar", async () => {
    const w = world(await newTenant());
    const club = await w.createOwnCalendar("Club");
    const feed = await w.createSubscriptionCalendar("Feed");
    const ofTrashedCalendar = await w.createSubscribedEvent(
      { title: "Of club", startsAt: "2026-10-20T10:00", allDay: false },
      club,
    );
    const ofLiveCalendar = await w.createSubscribedEvent(
      { title: "Of feed", startsAt: "2026-10-20T11:00", allDay: false },
      feed,
    );
    expect((await w.subscribed("2026-10-20")).map((item) => item.id)).toEqual([ofTrashedCalendar, ofLiveCalendar]);

    await w.trash(CALENDARS_MODULE_ID, club);
    const items = await w.subscribed("2026-10-20");
    expect(items.map((item) => item.id)).toEqual([ofLiveCalendar]);
    expect(items[0]?.calendarId).toBe(feed);
  });

  it("returns an event without a calendar edge with a null calendarId", async () => {
    const w = world(await newTenant());
    const id = await w.createSubscribedEvent({ title: "Loose", startsAt: "2026-10-20T10:00", allDay: false }, null);

    expect((await w.subscribed("2026-10-20")).map((item) => [item.id, item.calendarId])).toEqual([[id, null]]);
  });

  it("orders an entry among the timed Events by timeFrom, and all-day entries before timed ones", async () => {
    const w = world(await newTenant());
    const early = await w.createEvent({ name: "Early event", date: "2026-10-20", timeFrom: "10:00" });
    const late = await w.createEvent({ name: "Late event", date: "2026-10-20", timeFrom: "16:00" });
    const allDayEvent = await w.createEvent({ name: "Stored all-day", date: "2026-10-20" });
    const middle = await w.createSubscribedEvent(
      { title: "Subscribed middle", startsAt: "2026-10-20T13:00", allDay: false },
      null,
    );
    const allDaySubscribed = await w.createSubscribedEvent(
      { title: "Subscribed all-day", startsAt: "2026-10-20T00:00", allDay: true },
      null,
    );

    const ids = (await w.read("2026-10-20")).items.map((item) => item.id);
    // All-day entries first (by title), then timed ones by start time.
    expect(ids).toEqual([allDayEvent, allDaySubscribed, early, middle, late]);
  });

  it("carries readOnly and the calendar in the compact shape", async () => {
    const w = world(await newTenant());
    const feed = await w.createSubscriptionCalendar("Feed");
    const id = await w.createSubscribedEvent(
      { title: "Compact", startsAt: "2026-10-20T15:00", endsAt: "2026-10-20T16:00", allDay: false },
      feed,
    );

    const timeline = await w.read("2026-10-20", "2026-10-20", "compact");
    const compact = z.array(compactItem).parse(timeline.items);
    expect(compact).toEqual([
      expect.objectContaining({
        id,
        kind: "event",
        title: "Compact",
        calendarId: feed,
        allDay: false,
        date: "2026-10-20",
        endDate: null,
        timeFrom: "15:00",
        status: null,
        counts: null,
        readOnly: true,
      }),
    ]);
  });

  describe("a stored value that is not valid", () => {
    const VALID_END = "2026-10-20T16:00";

    it.each([
      ["a start that is not a date", { startsAt: "not a date" }, "startsAt"],
      ["a start without a time", { startsAt: "2026-10-20" }, "startsAt"],
      ["a start with an offset", { startsAt: "2026-10-20T15:00+02:00" }, "startsAt"],
      ["a start that is not a string", { startsAt: 42 }, "startsAt"],
      ["a start on a day that does not exist", { startsAt: "2026-02-30T10:00", endsAt: null }, "startsAt"],
      ["a start with a time that does not exist", { startsAt: "2026-10-20T25:00" }, "startsAt"],
      ["an end that is not a date", { endsAt: "garbage" }, "endsAt"],
      ["an end before the start", { endsAt: "2026-10-20T09:00" }, "endsAt"],
      ["an all-day flag that is not a boolean", { allDay: "yes" }, "allDay"],
    ])("leaves out an entry with %s, logs only its ids and returns the others", async (_name, patch, property) => {
      const w = world(await newTenant());
      const good = await w.createSubscribedEvent({ title: "Good", startsAt: "2026-10-20T11:00", allDay: false }, null);
      const bad = await w.createSubscribedEvent(
        { title: "Bad", startsAt: "2026-10-20T10:00", endsAt: VALID_END, allDay: false },
        null,
      );
      await w.storeRaw(bad, patch);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      // The range covers 30 February as text, so the row is a candidate whatever its stored day.
      const items = await w.subscribed("2026-02-01", "2026-12-31");

      expect(items.map((item) => item.id)).toEqual([good]);
      const subscribedEvents = await w.databaseId(SUBSCRIBED_EVENTS_MODULE_ID);
      expect(warn.mock.calls).toEqual([[{ itemId: bad, databaseId: subscribedEvents, property }, SKIP_MESSAGE]]);
    });

    it("does not select an entry whose start is empty or null, and does not log it", async () => {
      const w = world(await newTenant());
      const empty = await w.createSubscribedEvent({ title: "Empty", startsAt: "2026-10-20T10:00" }, null);
      const nothing = await w.createSubscribedEvent({ title: "Null", startsAt: "2026-10-20T10:00" }, null);
      await w.storeRaw(empty, { startsAt: "" });
      await w.storeRaw(nothing, { startsAt: null });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      expect(await w.subscribed("2026-01-01", "2026-12-31")).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("answers 200 with the other entries when the route reads an invalid start", async () => {
      const tenantId = await newTenant();
      const w = world(tenantId);
      const good = await w.createSubscribedEvent({ title: "Good", startsAt: "2026-10-20T11:00", allDay: false }, null);
      const bad = await w.createSubscribedEvent({ title: "Bad", startsAt: "2026-10-20T10:00", allDay: false }, null);
      await w.storeRaw(bad, { startsAt: "not a date" });
      vi.spyOn(logger, "warn").mockImplementation(() => {});

      const result = await runInTenant(tenantId, () =>
        createCalendarTimelineRouteHandler(dataPool)({
          req: { url: "/api/calendar/timeline?from=2026-10-20&to=2026-10-20" },
        }),
      );

      expect(result.status).toBe(200);
      const body = z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(JSON.stringify(result.body)));
      expect(body.items.map((item) => item.id)).toEqual([good]);
    });
  });

  it("returns only the reading tenant's entries", async () => {
    const first = world(await newTenant());
    const second = world(await newTenant());
    const ofFirst = await first.createSubscribedEvent({ title: "First", startsAt: "2026-10-20T10:00" }, null);
    const ofSecond = await second.createSubscribedEvent({ title: "Second", startsAt: "2026-10-20T10:00" }, null);

    expect((await first.subscribed("2026-10-20")).map((item) => item.id)).toEqual([ofFirst]);
    expect((await second.subscribed("2026-10-20")).map((item) => item.id)).toEqual([ofSecond]);
  });

  it("returns nothing for a tenant without the subscribed events database", async () => {
    const tenantId = await createTestTenant(adminPool);
    const context: CalendarTimelineContext = {
      from: "2026-10-20",
      to: "2026-10-20",
      timezone: "Europe/Prague",
      today: "2026-10-20",
      now: { date: "2026-10-20", time: "12:00" },
      at: new Date("2026-10-20T10:00:00Z"),
    };
    const items = await runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) => readSubscribedEventTimelineItems(client, context)),
    );
    expect(items).toEqual([]);
  });

  it("reads with a number of statements that does not grow with the number of rows", async () => {
    const w = world(await newTenant());
    const feed = await w.createSubscriptionCalendar("Feed");
    const busyDay = "2026-10-21";
    await w.createSubscribedEvent({ title: "Quiet 0", startsAt: "2026-10-20T10:00", allDay: false }, feed);
    for (let index = 0; index < 6; index += 1) {
      await w.createSubscribedEvent(
        {
          title: `Busy ${index}`,
          startsAt: `${busyDay}T1${index}:00`,
          endsAt: `${busyDay}T1${index}:30`,
          allDay: false,
        },
        feed,
      );
    }

    const subscribedEvents = await w.databaseId(SUBSCRIBED_EVENTS_MODULE_ID);
    /** The number of statements one read sends and the number of subscribed events it returns. */
    const count = (date: string) =>
      w.inTenant(() =>
        withTransaction(dataPool, async (client) => {
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
          const timeline = await readCalendarTimeline(counted, { from: date, to: date, shape: "full" });
          const items = z.array(timelineItem).parse(timeline.items);
          return { queries, items: items.filter((item) => item.databaseId === subscribedEvents).length };
        }),
      );

    const quiet = await count("2026-10-20");
    const busy = await count(busyDay);
    expect(quiet.items).toBe(1);
    expect(busy.items).toBe(6);
    expect(busy.queries).toBe(quiet.queries);
  });
});
