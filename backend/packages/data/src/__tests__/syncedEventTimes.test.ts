import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@alldots/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { createEventInCalendar } from "../calendar/defaultCalendarCreateHook.js";
import { createMaterializeEventOccurrenceRouteHandler } from "../calendar/eventOccurrenceRouteHandlers.js";
import { createRemindersFeedRouteHandler } from "../calendar/remindersFeedRouteHandler.js";
import { readCalendarTimeline } from "../calendar/timelineRead.js";
import type { CalendarTimelineEntry } from "../calendar/timelineSources.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { CALENDAR_SYNC_WRITER, SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
const SYNCED_KEYS = ["timeZone", "recurrenceRule", "exceptionDates", "recurrenceId"];
const SYNC = { writer: CALENDAR_SYNC_WRITER, allowedSystemKeys: [...SYNCED_KEYS, "seriesId"] };

/** Monday 2 November 2026, fortnightly, five times: 2 and 16 November, 30 November, 14 and 28 December. */
const FORTNIGHTLY = {
  name: "Planning",
  date: "2026-11-02",
  timeFrom: "09:00",
  timeTo: "10:00",
  recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;COUNT=5",
  exceptionDates: ["2026-11-16"],
};

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

interface Tenant {
  tenantId: string;
  userId: string;
}

async function seededTenant(): Promise<Tenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return { tenantId, userId: user.id };
}

/** Run inside the tenant scope. A writable account calendar, created the way the calendar sync creates one. */
async function setup(userId: string) {
  const cp = createChokePoint(runtime);
  const databases = await cp.listDatabases();
  const db = (moduleId: string) => {
    const row = databases.find((database) => database.ownerModuleId === moduleId);
    if (!row) throw new Error(`Missing ${moduleId}`);
    return row.id;
  };
  const events = db(EVENTS_MODULE_ID);
  const calendars = db(CALENDARS_MODULE_ID);
  const accountProperty = (await cp.listProperties(calendars)).find((property) => property.key === "account");
  if (!accountProperty) throw new Error("Missing Calendars.account");
  const account = await withTransaction(runtime, async (client) => {
    const mailbox = await createItemWithClient(client, {
      databaseId: db(MAILBOXES_MODULE_ID),
      properties: { name: "Work account", provider: "generic" },
    });
    const calendar = await createItemWithClient(
      client,
      {
        databaseId: calendars,
        properties: {
          kind: "account",
          name: null,
          color: null,
          notify: true,
          hidden: false,
          isDefault: false,
          remoteName: "Work",
          remoteColor: "#34C759",
          readOnly: false,
        },
      },
      {
        writer: CALENDAR_SYNC_WRITER,
        allowedSystemKeys: ["kind", "remoteName", "remoteColor", "readOnly"],
        systemOwnerProcess: CALENDAR_MODULE_ID,
      },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: accountProperty.id, callerItemId: calendar.id, targetItemId: mailbox.id },
      { ownerProcess: CALENDAR_MODULE_ID },
      CALENDAR_SYNC_WRITER,
    );
    return calendar;
  });

  const synced = (properties: Record<string, unknown>) =>
    withTransaction(runtime, (client) => createEventInCalendar(client, { properties }, account.id, SYNC));
  const update = (itemId: string, propertiesPatch: Record<string, unknown>, writer: WriterIdentity, keys?: string[]) =>
    withTransaction(runtime, (client) =>
      updateItemWithClient(
        client,
        { databaseId: events, itemId, propertiesPatch },
        { writer, ...(keys === undefined ? {} : { allowedSystemKeys: keys }) },
      ),
    );
  const stored = async (itemId: string) => {
    const item = await withTransaction(runtime, (client) => itemsStore.getItemById(client, events, itemId));
    if (!item) throw new Error(`Missing item ${itemId}`);
    return item.properties;
  };
  const timeline = async (from: string, to: string): Promise<CalendarTimelineEntry[]> =>
    (await withTransaction(runtime, (client) => readCalendarTimeline(client, { from, to, shape: "full" }))).items;
  const reminders = async (from: string, hours: number) => {
    const result = await createRemindersFeedRouteHandler(runtime)({
      req: { url: `/api/calendar/reminders?from=${encodeURIComponent(from)}&hours=${hours}` },
    });
    return z.array(reminderSchema).parse(JSON.parse(JSON.stringify(result.body)));
  };
  const materialize = (seriesId: string, date: string) =>
    createMaterializeEventOccurrenceRouteHandler(runtime)({
      params: { seriesId, date },
      identity: { user: { id: userId } },
    });
  return { events, account, synced, update, stored, timeline, reminders, materialize };
}

/** Entries of one series or Event, in timeline order, as `date time-time`. */
function shown(entries: CalendarTimelineEntry[], ids: (id: string) => boolean): string[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "event" || !(ids(entry.id) || ("seriesId" in entry && ids(entry.seriesId)))) return [];
    return [`${entry.date} ${entry.timeFrom ?? ""}-${entry.timeTo ?? ""}`];
  });
}

describe("synced Event times and recurrence", () => {
  let tenant: Tenant;
  let foreign: Tenant;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const inTenant = <T>(fn: () => Promise<T>, which: Tenant = tenant): Promise<T> => runInTenant(which.tenantId, fn);

  it("seeds the provider fields on Events as system-owned with no owner process", async () => {
    const properties = await inTenant(() =>
      withTenantTransaction(runtime, tenant.tenantId, async (client: PoolClient) => {
        const { rows } = await client.query<{ key: string; type: string; owner: string; owner_process: string | null }>(
          `SELECT p.key, p.type, p.owner, p.owner_process
           FROM properties p JOIN databases d ON d.id = p.database_id
          WHERE d.owner_module_id = $1 AND p.key = ANY($2::text[])
          ORDER BY p.key`,
          [EVENTS_MODULE_ID, SYNCED_KEYS],
        );
        return rows;
      }),
    );
    expect(properties).toEqual([
      { key: "exceptionDates", type: "json", owner: "system", owner_process: null },
      { key: "recurrenceId", type: "text", owner: "system", owner_process: null },
      { key: "recurrenceRule", type: "text", owner: "system", owner_process: null },
      { key: "timeZone", type: "text", owner: "system", owner_process: null },
    ]);
  });

  it("shows a 09:00 New York Event at 15:00 Prague time in the timeline and the reminders feed", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const morning = await f.synced({
        name: "Standup",
        date: "2026-11-24",
        timeFrom: "09:00",
        timeTo: "10:00",
        alertMinutes: 15,
        timeZone: "America/New_York",
      });
      // 20:00 in New York is the next day in Prague: the timeline of that next day shows it, the day before does not.
      const evening = await f.synced({
        name: "Late call",
        date: "2026-11-24",
        timeFrom: "20:00",
        timeTo: "21:00",
        timeZone: "America/New_York",
      });
      const tuesday = await f.timeline("2026-11-24", "2026-11-24");
      expect(shown(tuesday, (id) => id === morning.id)).toEqual(["2026-11-24 15:00-16:00"]);
      expect(shown(tuesday, (id) => id === evening.id)).toEqual([]);
      expect(shown(await f.timeline("2026-11-25", "2026-11-25"), (id) => id === evening.id)).toEqual([
        "2026-11-25 02:00-03:00",
      ]);

      expect(await f.reminders("2026-11-24T12:00:00Z", 6)).toEqual([
        {
          key: `${morning.id}:2026-11-24T13:45:00.000Z`,
          itemId: morning.id,
          kind: "event",
          title: "Standup",
          fireAt: "2026-11-24T13:45:00.000Z",
          startsAt: "2026-11-24T14:00:00.000Z",
        },
      ]);
    });
  });

  it("expands a raw rule without its exception dates and lets an override replace its occurrence", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const series = await f.synced(FORTNIGHTLY);
      const isSeries = (id: string) => id === series.id || id.startsWith(`${series.id}@`);
      expect(shown(await f.timeline("2026-11-01", "2026-12-31"), isSeries)).toEqual([
        "2026-11-02 09:00-10:00",
        "2026-11-30 09:00-10:00",
        "2026-12-14 09:00-10:00",
        "2026-12-28 09:00-10:00",
      ]);

      const override = await f.synced({
        name: "Planning (moved)",
        date: "2026-12-14",
        timeFrom: "11:00",
        timeTo: "12:00",
        seriesId: series.id,
        recurrenceId: "2026-12-14T09:00",
      });
      const entries = await f.timeline("2026-11-01", "2026-12-31");
      expect(shown(entries, (id) => isSeries(id) || id === override.id)).toEqual([
        "2026-11-02 09:00-10:00",
        "2026-11-30 09:00-10:00",
        "2026-12-14 11:00-12:00",
        "2026-12-28 09:00-10:00",
      ]);
      const replaced = entries.find((entry) => entry.id === override.id);
      expect(replaced).toMatchObject({ seriesId: series.id, occurrenceDate: "2026-12-14", overridden: true });
      expect(entries.some((entry) => entry.id === `${series.id}@2026-12-14`)).toBe(false);

      // The reminders feed lists the raw rule's occurrences too, as the timeline names them.
      await f.update(series.id, { alertMinutes: 10 }, USER);
      expect((await f.reminders("2026-11-30T07:00:00Z", 2)).map((entry) => entry.itemId)).toEqual([
        `${series.id}@2026-11-30`,
      ]);
      expect(await f.reminders("2026-11-16T07:00:00Z", 2)).toEqual([]);
    });
  });

  it("expands a raw rule in the series' zone and shows the occurrences in the tenant's", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const series = await f.synced({
        name: "Sync",
        date: "2026-11-23",
        timeFrom: "09:00",
        timeTo: "09:30",
        timeZone: "America/New_York",
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      });
      expect(shown(await f.timeline("2026-11-01", "2026-12-31"), (id) => id.startsWith(series.id))).toEqual([
        "2026-11-23 15:00-15:30",
        "2026-11-30 15:00-15:30",
        "2026-12-07 15:00-15:30",
      ]);
    });
  });

  it("keeps the raw rule on a title edit and clears it when the editor sets a simple rule", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const series = await f.synced(FORTNIGHTLY);
      await f.update(series.id, { name: "Planning sync" }, USER);
      expect(await f.stored(series.id)).toMatchObject({
        name: "Planning sync",
        recurrenceRule: FORTNIGHTLY.recurrenceRule,
        exceptionDates: FORTNIGHTLY.exceptionDates,
      });

      await f.update(series.id, { recurrence: { kind: "weekdays", days: ["mon"] } }, USER);
      expect(await f.stored(series.id)).toMatchObject({
        recurrence: { kind: "weekdays", days: ["mon"] },
        recurrenceRule: null,
        exceptionDates: null,
      });
      expect(
        shown(await f.timeline("2026-11-01", "2026-11-30"), (id) => id.startsWith(series.id)).map((entry) =>
          entry.slice(0, 10),
        ),
      ).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
    });
  });

  it("materializes an occurrence of a synced series as an override naming its original start", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const series = await f.synced({ ...FORTNIGHTLY, timeZone: "America/New_York" });
      const created = await f.materialize(series.id, "2026-11-30");
      expect(created.status).toBe(201);
      expect(created.item.properties).toMatchObject({
        seriesId: series.id,
        occurrenceDate: "2026-11-30",
        recurrenceId: "2026-11-30T09:00",
        timeZone: "America/New_York",
        date: "2026-11-30",
        timeFrom: "09:00",
      });
      expect(created.item.properties.recurrenceRule).toBeUndefined();
      expect((await f.materialize(series.id, "2026-11-30")).status).toBe(200);
      const entries = await f.timeline("2026-11-30", "2026-11-30");
      expect(shown(entries, (id) => id.startsWith(series.id) || id === created.item.id)).toEqual([
        "2026-11-30 15:00-16:00",
      ]);
      expect(entries.find((entry) => entry.id === created.item.id)).toMatchObject({ overridden: true });

      // An excluded date and a day the rule skips have no occurrence.
      for (const date of ["2026-11-16", "2026-11-23"]) {
        expect(await rejection(f.materialize(series.id, date))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "date" },
        });
      }
    });
  });

  it("materializes an occurrence of a simple series in an account calendar as an override too", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const series = await f.synced({ name: "Gym", date: "2026-11-02", timeFrom: "18:00" });
      await f.update(series.id, { recurrence: { kind: "weekdays", days: ["mon"] } }, USER);
      const created = await f.materialize(series.id, "2026-11-09");
      expect(created.item.properties).toMatchObject({ seriesId: series.id, recurrenceId: "2026-11-09T18:00" });
      expect(created.item.properties.timeZone).toBeUndefined();
    });
  });

  it.each([
    ["a user", USER],
    ["an agent", AGENT],
  ])("refuses %s writing a provider field", async (_label, writer) => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const event = await f.synced({ name: "Dinner", date: "2026-11-24", timeFrom: "19:00" });
      expect(await rejection(f.update(event.id, { timeZone: "Europe/London" }, writer))).toMatchObject({
        status: 403,
        code: "owner_violation",
      });
      expect((await f.stored(event.id)).timeZone).toBeUndefined();
    });
  });

  it("admits only the calendar sync among system writers naming the provider fields", async () => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const event = await f.synced({ name: "Dinner", date: "2026-11-24", timeFrom: "19:00" });
      expect(
        await rejection(f.update(event.id, { timeZone: "Europe/London" }, SYSTEM_WRITER, ["timeZone"])),
      ).toMatchObject({ status: 403, code: "owner_violation", details: { field: "timeZone" } });
      expect(
        await rejection(f.update(event.id, { recurrenceRule: null }, SYSTEM_WRITER, ["recurrenceRule"])),
      ).toMatchObject({ status: 403, code: "owner_violation" });
      expect((await f.stored(event.id)).timeZone).toBeUndefined();

      await f.update(event.id, { timeZone: "Europe/London" }, CALENDAR_SYNC_WRITER, ["timeZone"]);
      expect((await f.stored(event.id)).timeZone).toBe("Europe/London");
    });
  });

  it.each([
    ["an unknown zone", { timeZone: "Mars/Olympus" }, "timeZone"],
    ["a fixed offset", { timeZone: "UTC+2" }, "timeZone"],
    [
      "exception dates that are not local starts",
      { recurrenceRule: "FREQ=DAILY", exceptionDates: ["2026-11-24T09:00Z"] },
      "exceptionDates",
    ],
    [
      "a raw rule next to a simple one",
      { recurrenceRule: "FREQ=DAILY", recurrence: { kind: "weekdays", days: ["mon"] } },
      "recurrenceRule",
    ],
    ["an original start without a series", { recurrenceId: "2026-11-24T09:00" }, "recurrenceId"],
  ])("refuses the calendar sync storing %s", async (_label, values, field) => {
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      expect(
        await rejection(f.synced({ name: "Bad", date: "2026-11-24", timeFrom: "09:00", ...values })),
      ).toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field },
      });
    });
  });

  it("keeps another tenant's synced series out of the timeline", async () => {
    const foreignSeries = await inTenant(async () => (await setup(foreign.userId)).synced(FORTNIGHTLY), foreign);
    await inTenant(async () => {
      const f = await setup(tenant.userId);
      const entries = await f.timeline("2026-11-01", "2026-12-31");
      expect(entries.some((entry) => entry.id.startsWith(foreignSeries.id))).toBe(false);
      expect(await rejection(f.materialize(foreignSeries.id, "2026-11-30"))).toMatchObject({ status: 404 });
    });
  });
});
