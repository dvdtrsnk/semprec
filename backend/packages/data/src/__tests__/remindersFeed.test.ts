import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { createMaterializeEventOccurrenceRouteHandler } from "../calendar/eventOccurrenceRouteHandlers.js";
import { logger } from "../calendar/logger.js";
import { createRemindersFeedRouteHandler } from "../calendar/remindersFeedRouteHandler.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const DAY = "2026-10-16";
/** Midnight UTC of `DAY`, written as the route's query takes it. */
const FROM = "2026-10-16T00:00:00Z";
const SKIP_MESSAGE = "Reminders feed left out an item";

const reminderSchema = z
  .object({
    key: z.string(),
    itemId: z.string(),
    kind: z.enum(["event", "task"]),
    title: z.string(),
    fireAt: z.string(),
    startsAt: z.string(),
  })
  .strict();

type Reminder = z.infer<typeof reminderSchema>;

const calendarRowSchema = z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() });

async function newTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(dataPool));
  return { tenantId, userId: user.id };
}

/** One tenant's fixture writes and feed reads, each in that tenant's scope on the runtime-role pool. */
function world(tenantId: string, userId: string) {
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

  async function update(moduleId: string, itemId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() =>
      chokePoint.updateItem({ databaseId: id, itemId, propertiesPatch }, undefined, undefined, USER),
    );
  }

  async function trash(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => chokePoint.softDeleteItem(id, itemId));
  }

  /** Moves an Event to `calendarId`, or with `null` removes its calendar edge. */
  async function setCalendar(eventId: string, calendarId: string | null): Promise<void> {
    const id = await databaseId("events");
    await inTenant(async () => {
      const property = (await chokePoint.listProperties(id)).find((entry) => entry.key === "calendar");
      if (!property) throw new Error("No events.calendar");
      await chokePoint.setRelation(
        { relationPropertyId: property.id, callerItemId: eventId, targetItemId: calendarId },
        USER,
      );
    });
  }

  /** The id of the seeded calendar named `name`. */
  async function calendar(name: string): Promise<string> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z
      .array(calendarRowSchema)
      .parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const row = rows.find((candidate) => candidate.properties.name === name);
    if (!row) throw new Error(`No calendar ${name}`);
    return row.id;
  }

  /** Writes stored values the write rules refuse, so raw SQL on the admin pool inside the tenant is the only way. */
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

  async function setZone(timezone: string): Promise<void> {
    await inTenant(async () => {
      const settingsDatabaseId = await withTransaction(dataPool, (client) => getSystemSettingsDatabaseId(client));
      const itemId = await withTransaction(dataPool, (client) => getSystemSettingsItemId(client));
      await chokePoint.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    });
  }

  /** Moves calendars to the Trash by raw SQL, the one way to leave an Event's edge on a calendar that is not live. */
  async function trashCalendarsRaw(calendarIds: string[]): Promise<void> {
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("UPDATE items SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
        calendarIds,
      ]);
      expect(result.rowCount).toBe(calendarIds.length);
    });
  }

  const materialize = (seriesId: string, date: string) =>
    inTenant(() =>
      createMaterializeEventOccurrenceRouteHandler(dataPool)({
        params: { seriesId, date },
        identity: { user: { id: userId } },
      }),
    ).then((result) => result.item.id);

  /** The feed for `query` (the part after `/api/calendar/reminders`), checked to carry exactly the documented fields. */
  async function feed(query: string = `?from=${encodeURIComponent(FROM)}`): Promise<Reminder[]> {
    const result = await inTenant(() =>
      createRemindersFeedRouteHandler(dataPool)({ req: { url: `/api/calendar/reminders${query}` } }),
    );
    expect(result.status).toBe(200);
    // The body as JSON carries it, so a value JSON cannot represent would be noticed.
    return z.array(reminderSchema).parse(JSON.parse(JSON.stringify(result.body)));
  }

  /** The error the feed throws for `query`. */
  async function refusal(query: string): Promise<unknown> {
    return feed(query).then(
      () => {
        throw new Error(`The feed accepted ${query}`);
      },
      (error: unknown) => error,
    );
  }

  const itemIds = async (query?: string): Promise<string[]> => (await feed(query)).map((entry) => entry.itemId);

  return {
    databaseId,
    create,
    update,
    trash,
    setCalendar,
    calendar,
    storeRaw,
    trashCalendarsRaw,
    setZone,
    materialize,
    feed,
    refusal,
    itemIds,
    inTenant,
  };
}

describe("upcoming reminders feed (issue gh-1858)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("verify reminders feed role", () =>
      dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
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

  async function newWorld() {
    const { tenantId, userId } = await newTenant();
    return world(tenantId, userId);
  }

  describe("what is listed", () => {
    it("lists a 10:00 meeting with alertMinutes 15 and travelMinutes 30 at 09:15 in Europe/Prague", async () => {
      const w = await newWorld();
      const meeting = await w.create("events", {
        name: "Meeting",
        date: DAY,
        timeFrom: "10:00",
        alertMinutes: 15,
        travelMinutes: 30,
      });

      // 09:15 on the wall clock of Prague, where 16 October 2026 is UTC+2.
      expect(await w.feed()).toEqual([
        {
          key: `${meeting}:2026-10-16T07:15:00.000Z`,
          itemId: meeting,
          kind: "event",
          title: "Meeting",
          fireAt: "2026-10-16T07:15:00.000Z",
          startsAt: "2026-10-16T08:00:00.000Z",
        },
      ]);
    });

    it("reads the zone of the tenant, not a fixed one", async () => {
      const w = await newWorld();
      await w.setZone("America/New_York");
      const meeting = await w.create("events", { name: "Meeting", date: DAY, timeFrom: "10:00", alertMinutes: 15 });

      // 09:45 on the wall clock of New York, where 16 October 2026 is UTC-4.
      expect(await w.feed()).toEqual([
        expect.objectContaining({
          itemId: meeting,
          fireAt: "2026-10-16T13:45:00.000Z",
          startsAt: "2026-10-16T14:00:00.000Z",
        }),
      ]);
    });

    it("lists an all-day Event 15 minutes before 09:00 and gives it 09:00 as its start", async () => {
      const w = await newWorld();
      const allDay = await w.create("events", { name: "Holiday", date: DAY, alertMinutes: 15, travelMinutes: 30 });

      expect(await w.feed()).toEqual([
        expect.objectContaining({
          itemId: allDay,
          fireAt: "2026-10-16T06:45:00.000Z",
          startsAt: "2026-10-16T07:00:00.000Z",
        }),
      ]);
    });

    it("lists a Task with notifications on and timeFrom 14:00 at 14:00 local", async () => {
      const w = await newWorld();
      const task = await w.create("tasks", { name: "Call back", date: DAY, timeFrom: "14:00", notifications: true });

      expect(await w.feed()).toEqual([
        {
          key: `${task}:2026-10-16T12:00:00.000Z`,
          itemId: task,
          kind: "task",
          title: "Call back",
          fireAt: "2026-10-16T12:00:00.000Z",
          startsAt: "2026-10-16T12:00:00.000Z",
        },
      ]);
    });

    it("lists a Task without a time at 09:00 local, its start", async () => {
      const w = await newWorld();
      const task = await w.create("tasks", { name: "Pay", date: DAY, notifications: true });

      expect(await w.feed()).toEqual([
        expect.objectContaining({
          itemId: task,
          kind: "task",
          fireAt: "2026-10-16T07:00:00.000Z",
          startsAt: "2026-10-16T07:00:00.000Z",
        }),
      ]);
    });

    it("leaves out a Task with notifications off, a done Task, a wontDo Task and an Event without an alert", async () => {
      const w = await newWorld();
      await w.create("tasks", { name: "Quiet", date: DAY, timeFrom: "14:00", notifications: false });
      await w.create("tasks", { name: "Unset", date: DAY, timeFrom: "14:00" });
      await w.create("tasks", { name: "Done", date: DAY, timeFrom: "14:00", notifications: true, status: "done" });
      await w.create("tasks", { name: "Dropped", date: DAY, timeFrom: "14:00", notifications: true, status: "wontDo" });
      await w.create("events", { name: "No alert", date: DAY, timeFrom: "10:00" });
      const listed = await w.create("tasks", { name: "Open", date: DAY, timeFrom: "15:00", notifications: true });

      expect(await w.itemIds()).toEqual([listed]);
    });

    it("lists an Event whose alert moves its fire time into the window although its day is after it", async () => {
      const w = await newWorld();
      // 09:00 on 17 October less 1440 minutes is 09:00 on 16 October: 07:00Z, inside a window of 12 hours from midnight.
      const dayAfter = await w.create("events", { name: "Tomorrow", date: "2026-10-17", alertMinutes: 1440 });
      const beyond = await w.create("events", { name: "Later", date: "2026-10-19", alertMinutes: 1440 });
      const query = `?from=${encodeURIComponent(FROM)}&hours=12`;

      const ids = await w.itemIds(query);

      expect(ids).toEqual([dayAfter]);
      expect(ids).not.toContain(beyond);
    });

    it("lists the entries in the window [from, from + hours): its first instant in, its end instant out", async () => {
      const w = await newWorld();
      // 09:00 Prague is 07:00Z; the window of 3 hours from 04:00Z ends at 07:00Z.
      const atStart = await w.create("tasks", { name: "At start", date: DAY, timeFrom: "06:00", notifications: true });
      const atEnd = await w.create("tasks", { name: "At end", date: DAY, timeFrom: "09:00", notifications: true });
      const before = await w.create("tasks", { name: "Before", date: DAY, timeFrom: "05:59", notifications: true });
      const query = (hours: number) => `?from=${encodeURIComponent("2026-10-16T04:00:00Z")}&hours=${hours}`;

      expect(await w.itemIds(query(3))).toEqual([atStart]);
      expect(await w.itemIds(query(4))).toEqual([atStart, atEnd]);
      expect(await w.itemIds(query(1))).not.toContain(before);
    });

    it("takes an offset in `from` as an instant", async () => {
      const w = await newWorld();
      const task = await w.create("tasks", { name: "Offset", date: DAY, timeFrom: "14:00", notifications: true });

      // 13:00+02:00 is 11:00Z, two hours before the 12:00Z reminder.
      expect(await w.itemIds(`?from=${encodeURIComponent("2026-10-16T13:00:00+02:00")}&hours=3`)).toEqual([task]);
      expect(await w.itemIds(`?from=${encodeURIComponent("2026-10-16T13:00:00+02:00")}&hours=1`)).toEqual([]);
    });

    it("defaults to 48 hours and accepts 1 and 168", async () => {
      const w = await newWorld();
      const inside = await w.create("tasks", {
        name: "Inside",
        date: "2026-10-17",
        timeFrom: "23:00",
        notifications: true,
      });
      const outside = await w.create("tasks", {
        name: "Outside",
        date: "2026-10-18",
        timeFrom: "23:00",
        notifications: true,
      });
      const week = await w.create("tasks", {
        name: "Week",
        date: "2026-10-22",
        timeFrom: "23:00",
        notifications: true,
      });

      expect(await w.itemIds()).toEqual([inside]);
      expect(await w.itemIds(`?from=${encodeURIComponent(FROM)}&hours=1`)).toEqual([]);
      expect(await w.itemIds(`?from=${encodeURIComponent(FROM)}&hours=168`)).toEqual([inside, outside, week]);
    });

    it("orders the entries by fireAt and then key, and keeps no more than 200", async () => {
      const w = await newWorld();
      const [later, earlier] = [
        await w.create("tasks", { name: "Later", date: DAY, timeFrom: "16:00", notifications: true }),
        await w.create("tasks", { name: "Earlier", date: DAY, timeFrom: "15:00", notifications: true }),
      ];
      const sameTime = [
        await w.create("events", { name: "Tie one", date: DAY, timeFrom: "17:00", alertMinutes: 0 }),
        await w.create("events", { name: "Tie two", date: DAY, timeFrom: "17:00", alertMinutes: 0 }),
      ].sort();

      const answer = await w.feed();

      expect(answer.map((entry) => entry.itemId)).toEqual([earlier, later, ...sameTime]);
      // The two that fire together are ordered by key, which starts with the item id.
      expect(answer.slice(2).map((entry) => entry.key)).toEqual(
        answer
          .slice(2)
          .map((entry) => entry.key)
          .sort(),
      );

      // 201 Tasks fire at the same instant: the 200 whose keys sort first remain.
      const tasks = await w.databaseId("tasks");
      const created = await w.inTenant(() =>
        withTransaction(dataPool, async (client) => {
          const ids: string[] = [];
          for (let index = 0; index < 201; index += 1) {
            const item = await createItemWithClient(client, {
              databaseId: tasks,
              properties: { name: `Burst ${index}`, date: "2026-10-17", timeFrom: "08:00", notifications: true },
            });
            ids.push(item.id);
          }
          return ids;
        }),
      );
      const burst = (await w.feed(`?from=${encodeURIComponent("2026-10-17T00:00:00Z")}&hours=24`)).filter((entry) =>
        created.includes(entry.itemId),
      );
      expect(burst).toHaveLength(200);
      expect(burst.map((entry) => entry.itemId)).toEqual([...created].sort().slice(0, 200));
      expect((await w.feed(`?from=${encodeURIComponent("2026-10-17T00:00:00Z")}&hours=24`)).length).toBe(200);
    });
  });

  describe("calendars", () => {
    it("leaves out the Events of a calendar whose notify is false and keeps those of a merely hidden one", async () => {
      const w = await newWorld();
      const muted = await w.create("calendars", { name: "Muted", notify: false });
      const hidden = await w.create("calendars", { name: "Hidden", notify: true, hidden: true });
      const mutedAndHidden = await w.create("calendars", { name: "Both", notify: false, hidden: true });
      const inMuted = await w.create("events", { name: "In muted", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      const inHidden = await w.create("events", { name: "In hidden", date: DAY, timeFrom: "10:30", alertMinutes: 15 });
      const inBoth = await w.create("events", { name: "In both", date: DAY, timeFrom: "11:00", alertMinutes: 15 });
      const inDefault = await w.create("events", {
        name: "In default",
        date: DAY,
        timeFrom: "11:30",
        alertMinutes: 15,
      });
      await w.setCalendar(inMuted, muted);
      await w.setCalendar(inHidden, hidden);
      await w.setCalendar(inBoth, mutedAndHidden);

      expect(await w.itemIds()).toEqual([inHidden, inDefault]);
    });

    it("keeps the Events of a calendar that has no notify value", async () => {
      const w = await newWorld();
      const unset = await w.create("calendars", { name: "Unset" });
      const event = await w.create("events", { name: "In unset", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      await w.setCalendar(event, unset);

      expect(await w.itemIds()).toEqual([event]);
    });

    it("mutes an Event without a calendar edge through the default calendar", async () => {
      const w = await newWorld();
      const event = await w.create("events", { name: "No edge", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      await w.setCalendar(event, null);
      expect(await w.itemIds()).toEqual([event]);

      await w.update("calendars", await w.calendar("Personal"), { notify: false });

      expect(await w.itemIds()).toEqual([]);
    });

    it("does not mute a Task by the notify of its calendar", async () => {
      const w = await newWorld();
      // The seeded Tasks calendar has notify false; a Task is never in that calendar's way.
      const task = await w.create("tasks", { name: "Task", date: DAY, timeFrom: "14:00", notifications: true });

      expect(await w.itemIds()).toEqual([task]);
    });

    it("lists an Event that has no calendar edge when the tenant has no live default calendar", async () => {
      const w = await newWorld();
      const event = await w.create("events", { name: "No calendar", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      await w.setCalendar(event, null);
      // Raw SQL: which calendars may be deleted is decided by other calendar issues, so the default calendar is
      // stored as trashed directly instead of through a delete those rules may refuse.
      await w.trashCalendarsRaw([await w.calendar("Personal")]);

      expect(await w.itemIds()).toEqual([event]);
    });

    it("lists an Event whose calendar edge points at a calendar in the Trash", async () => {
      const w = await newWorld();
      const calendar = await w.create("calendars", { name: "Gone", notify: false });
      const event = await w.create("events", { name: "In gone", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      await w.setCalendar(event, calendar);
      // Raw SQL: deleting a calendar through the choke point trashes its Events too, so this is the one way to
      // leave an edge on a calendar that is no longer live.
      await w.trashCalendarsRaw([calendar]);

      expect(await w.itemIds()).toEqual([event]);
    });
  });

  describe("trashed items and occurrences", () => {
    it("leaves out a trashed Event and a trashed Task", async () => {
      const w = await newWorld();
      const trashedEvent = await w.create("events", {
        name: "Trashed",
        date: DAY,
        timeFrom: "10:00",
        alertMinutes: 15,
      });
      const trashedTask = await w.create("tasks", {
        name: "Trashed",
        date: DAY,
        timeFrom: "14:00",
        notifications: true,
      });
      const liveEvent = await w.create("events", { name: "Live", date: DAY, timeFrom: "11:00", alertMinutes: 15 });
      await w.trash("events", trashedEvent);
      await w.trash("tasks", trashedTask);

      expect(await w.itemIds()).toEqual([liveEvent]);
    });

    it("shows a moved materialized occurrence at its new fireAt, named by its occurrence date, and no virtual occurrence", async () => {
      const w = await newWorld();
      const series = await w.create("events", {
        name: "Standup",
        date: "2026-10-12",
        timeFrom: "09:00",
        alertMinutes: 5,
        recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
      });
      const occurrence = await w.materialize(series, DAY);
      // Before it is moved the occurrence fires 5 minutes before 09:00 on its own day; the other days of the rule,
      // virtual occurrences, are not listed, and neither is the series row.
      const wholeWeek = `?from=${encodeURIComponent("2026-10-13T00:00:00Z")}&hours=168`;
      expect(await w.feed(wholeWeek)).toEqual([
        expect.objectContaining({
          key: `${occurrence}@${DAY}:2026-10-16T06:55:00.000Z`,
          itemId: occurrence,
          title: "Standup",
          fireAt: "2026-10-16T06:55:00.000Z",
          startsAt: "2026-10-16T07:00:00.000Z",
        }),
      ]);

      await w.update("events", occurrence, { date: "2026-10-17", timeFrom: "13:00", timeTo: "14:00" });

      // The occurrence keeps its rule date in the key and shows its new fire time.
      expect(await w.feed(wholeWeek)).toEqual([
        expect.objectContaining({
          key: `${occurrence}@${DAY}:2026-10-17T10:55:00.000Z`,
          itemId: occurrence,
          fireAt: "2026-10-17T10:55:00.000Z",
          startsAt: "2026-10-17T11:00:00.000Z",
        }),
      ]);
    });

    it("leaves out a cancelled occurrence, which is an occurrence in the Trash", async () => {
      const w = await newWorld();
      const series = await w.create("events", {
        name: "Standup",
        date: "2026-10-12",
        timeFrom: "09:00",
        alertMinutes: 5,
        recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
      });
      const occurrence = await w.materialize(series, DAY);
      await w.trash("events", occurrence);

      expect(await w.itemIds(`?from=${encodeURIComponent("2026-10-13T00:00:00Z")}&hours=168`)).toEqual([]);
    });

    const SERIES = {
      name: "Standup",
      date: DAY,
      timeFrom: "09:00",
      alertMinutes: 5,
      recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
    };

    it("leaves out the row of a recurring series, whose first occurrence is virtual until it is materialized", async () => {
      const w = await newWorld();
      const series = await w.create("events", SERIES);
      const plain = await w.create("events", { name: "Plain", date: DAY, timeFrom: "11:00", alertMinutes: 5 });

      expect(await w.itemIds()).toEqual([plain]);
      expect(await w.itemIds()).not.toContain(series);
    });

    it("leaves out a cancelled first occurrence and the series row it came from", async () => {
      const w = await newWorld();
      const series = await w.create("events", SERIES);
      const first = await w.materialize(series, DAY);
      await w.trash("events", first);

      const ids = await w.itemIds();
      expect(ids).toEqual([]);
      expect(ids).not.toContain(series);
    });

    it("shows a moved first occurrence once, at its new fireAt, and not the series row", async () => {
      const w = await newWorld();
      const series = await w.create("events", SERIES);
      const first = await w.materialize(series, DAY);
      await w.update("events", first, { date: "2026-10-17", timeFrom: "13:00", timeTo: "14:00" });

      const wholeWeek = `?from=${encodeURIComponent(FROM)}&hours=168`;
      expect(await w.feed(wholeWeek)).toEqual([
        expect.objectContaining({
          key: `${first}@${DAY}:2026-10-17T10:55:00.000Z`,
          itemId: first,
          fireAt: "2026-10-17T10:55:00.000Z",
        }),
      ]);
    });

    it("lists the first occurrence once it is materialized, under its own row and not the series row", async () => {
      const w = await newWorld();
      const series = await w.create("events", SERIES);
      const first = await w.materialize(series, DAY);

      expect(await w.feed()).toEqual([
        expect.objectContaining({ key: `${first}@${DAY}:2026-10-16T06:55:00.000Z`, itemId: first }),
      ]);
    });
  });

  describe("stored values that cannot be read", () => {
    it("leaves out an Event whose date is no calendar date and lists the others", async () => {
      const w = await newWorld();
      const unreadable = await w.create("events", {
        name: "Unreadable",
        date: DAY,
        timeFrom: "10:00",
        alertMinutes: 15,
      });
      const readable = await w.create("events", { name: "Readable", date: DAY, timeFrom: "11:00", alertMinutes: 15 });
      // Raw SQL: the Events write rules refuse a date with a time of day or an unreadable one.
      await w.storeRaw("events", unreadable, { date: "2026-10-16T10:00:00" });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      expect(await w.itemIds()).toEqual([readable]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: unreadable, property: "date" }),
        "Calendar timeline left out an item with an invalid stored value",
      );
    });

    it("leaves out an Event whose alertMinutes is no number, as an Event without an alert", async () => {
      const w = await newWorld();
      const text = await w.create("events", { name: "Text alert", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      const readable = await w.create("events", { name: "Readable", date: DAY, timeFrom: "11:00", alertMinutes: 15 });
      // Raw SQL: the reminder values rule refuses a value that is no number.
      await w.storeRaw("events", text, { alertMinutes: "15" });

      expect(await w.itemIds()).toEqual([readable]);
    });

    it("treats a travelMinutes that is no number as none", async () => {
      const w = await newWorld();
      const event = await w.create("events", { name: "Event", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      // Raw SQL: the reminder values rule refuses a value that is no number.
      await w.storeRaw("events", event, { travelMinutes: "30" });

      expect(await w.feed()).toEqual([expect.objectContaining({ itemId: event, fireAt: "2026-10-16T07:45:00.000Z" })]);
    });

    it("leaves out, with a log line that carries its id, an Event whose alert leaves no representable instant", async () => {
      const w = await newWorld();
      const huge = await w.create("events", { name: "Huge", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      const readable = await w.create("events", { name: "Readable", date: DAY, timeFrom: "11:00", alertMinutes: 15 });
      // Raw SQL: the reminder values rule allows a few alert lengths only.
      await w.storeRaw("events", huge, { alertMinutes: 1e300 });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      expect(await w.itemIds()).toEqual([readable]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: huge, errorName: "ValidationError", code: "validation_failed" }),
        SKIP_MESSAGE,
      );
    });
  });

  describe("request validation", () => {
    async function expectInvalid(w: Awaited<ReturnType<typeof newWorld>>, query: string, field: string) {
      const error = await w.refusal(query);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
    }

    it.each([["0"], ["169"], ["200"], ["-1"], ["1.5"], ["abc"], [""], ["1e1"], ["0048"]])(
      "answers 400 validation_failed on hours for hours=%s",
      async (hours) => {
        const w = await newWorld();
        await expectInvalid(w, `?from=${encodeURIComponent(FROM)}&hours=${hours}`, "hours");
      },
    );

    it.each([
      ["a missing from", ""],
      ["an empty from", "?from="],
      ["a word", "?from=tomorrow"],
      ["a date without a time", "?from=2026-10-16"],
      ["a date and time without an offset", `?from=${encodeURIComponent("2026-10-16T00:00:00")}`],
      ["an offset written with an unencoded plus", "?from=2026-10-16T00:00:00+02:00"],
      ["an hour that does not exist", `?from=${encodeURIComponent("2026-10-16T25:00:00Z")}`],
      ["a day that does not exist", `?from=${encodeURIComponent("2026-02-30T00:00:00Z")}`],
    ])("answers 400 validation_failed on from for %s", async (_name, query) => {
      const w = await newWorld();
      await expectInvalid(w, query, "from");
    });

    it("answers 400 on from for an instant whose window leaves the supported dates", async () => {
      const w = await newWorld();
      await expectInvalid(w, `?from=${encodeURIComponent("9999-12-31T23:59:59Z")}`, "from");
    });

    it("names from when from and hours are both invalid", async () => {
      const w = await newWorld();
      await expectInvalid(w, "?hours=0", "from");
    });

    it("answers a request without a url like one without a from", async () => {
      const w = await newWorld();
      const error = await w.inTenant(() =>
        createRemindersFeedRouteHandler(dataPool)({ req: {} }).catch((caught: unknown) => caught),
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "from" } });
    });

    it("answers an empty list for a tenant that has nothing in the window", async () => {
      const w = await newWorld();

      expect(await w.feed()).toEqual([]);
    });
  });

  describe("tenants", () => {
    it("shows each tenant its own reminders and never another tenant's", async () => {
      const [first, second] = [await newWorld(), await newWorld()];
      const own = await first.create("events", { name: "Mine", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      const ownTask = await first.create("tasks", { name: "Mine", date: DAY, timeFrom: "14:00", notifications: true });
      const foreign = await second.create("events", { name: "Theirs", date: DAY, timeFrom: "10:00", alertMinutes: 15 });
      const foreignTask = await second.create("tasks", {
        name: "Theirs",
        date: DAY,
        timeFrom: "14:00",
        notifications: true,
      });

      expect(await first.itemIds()).toEqual([own, ownTask]);
      expect(await second.itemIds()).toEqual([foreign, foreignTask]);
    });
  });
});
