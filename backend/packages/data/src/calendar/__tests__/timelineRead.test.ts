import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { wallClockToInstant } from "../../calendarTime.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { logger } from "../logger.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { CALENDAR_TIMELINE_SOURCES, type CalendarTimelineItem } from "../timelineSources.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const DAY = "2026-10-16";
/** Sets the server clock to noon of `day` in the seeded zone, so a completion made next has that `completedOn`. */
function completedOn(day: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${day}T10:00:00Z`));
}
const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

const fullItemSchema = z
  .object({
    kind: z.enum(["event", "task"]),
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
    project: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).strict().nullable(),
    people: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    transcript: z.object({ id: z.string(), status: z.string().nullable() }).strict().nullable(),
    attendance: z.null(),
    hostEvent: z.null(),
    tasks: z.array(z.unknown()).nullable(),
    counts: z.object({ open: z.number(), total: z.number() }).strict().nullable(),
    carriedFrom: z.string().nullable(),
    updatedAt: z.string(),
    readOnly: z.boolean(),
  })
  .strict();

const calendarSchema = z.object({
  id: z.string(),
  properties: z.object({ isDefault: z.boolean(), systemKey: z.string().optional() }),
});

async function newTenant(locale: string | null = "cs"): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  if (locale !== null) {
    await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale });
  }
  await runInTenant(tenantId, () => seedSystem(dataPool));
  // The sleep nights of a seeded tenant have their own tests (issue #1806); these keep to Events and Tasks.
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

  async function link(
    moduleId: string,
    key: string,
    itemId: string,
    targetItemId: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const id = await databaseId(moduleId);
    const edge = await inTenant(async () => {
      const property = (await chokePoint.listProperties(id)).find((entry) => entry.key === key);
      if (!property) throw new Error(`No ${moduleId}.${key}`);
      return chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: itemId,
        targetItemId,
        ...(metadata === undefined ? {} : { metadata }),
      });
    });
    return edge.id;
  }

  /** A transcript as the transcription process writes it: `status` is its property, which a user's write may not set. */
  async function createTranscript(properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId("transcripts");
    const item = await inTenant(() =>
      withTransaction(dataPool, (client) =>
        createItemWithClient(
          client,
          { databaseId: id, properties },
          { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    );
    return item.id;
  }

  /**
   * Moves an Event to `calendarId`, or with `null` removes its calendar edge: the user's single-valued set.
   * A new Event is linked to the default calendar by its create hook (issue #1761).
   */
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

  /**
   * Overwrites stored properties with values the write rules refuse (issues #1536 and #1663) or no longer
   * produce, so raw SQL is the only way to store them. Runs on the admin pool inside the tenant.
   */
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

  async function updatedAt(moduleId: string, itemId: string): Promise<string> {
    const id = await databaseId(moduleId);
    const item = await inTenant(() => chokePoint.getItem(id, itemId));
    if (!item) throw new Error("Item missing");
    return item.updatedAt;
  }

  async function calendars(): Promise<{ defaultId: string; tasksId: string; workId: string }> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z.array(calendarSchema).parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const defaultId = rows.find((row) => row.properties.isDefault)?.id;
    const tasksId = rows.find((row) => row.properties.systemKey === "tasks")?.id;
    const workId = rows.find((row) => !row.properties.isDefault && row.properties.systemKey === undefined)?.id;
    if (!defaultId || !tasksId || !workId) throw new Error("Seeded calendars are missing");
    return { defaultId, tasksId, workId };
  }

  /** The number of relation edges the tenant has, and the number `itemId` sits on. */
  async function edgeCounts(itemId: string): Promise<{ all: number; ofItem: number }> {
    const { rows } = await inTenant(() =>
      dataPool.query<{ all: number; of_item: number }>(
        `SELECT count(*)::int AS all, (count(*) FILTER (WHERE item_a = $1 OR item_b = $1))::int AS of_item
           FROM item_relations`,
        [itemId],
      ),
    );
    if (!rows[0]) throw new Error("No count row");
    return { all: rows[0].all, ofItem: rows[0].of_item };
  }

  async function setZone(timezone: string): Promise<void> {
    await inTenant(async () => {
      const settingsDatabaseId = await withTransaction(dataPool, (client) => getSystemSettingsDatabaseId(client));
      const itemId = await withTransaction(dataPool, (client) => getSystemSettingsItemId(client));
      await chokePoint.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    });
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(dataPool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /**
   * The stored Events and Tasks of a range, each checked to carry exactly the documented fields. The derived
   * entries of the birthday and holiday sources (issues #1800 and #1804) have their own tests; a range of these
   * tests can hold a public holiday.
   */
  const items = async (from: string, to: string = from) =>
    z
      .array(fullItemSchema)
      .parse((await read(from, to)).items.filter((item) => item.kind === "event" || item.kind === "task"));

  return {
    databaseId,
    create,
    update,
    trash,
    link,
    createTranscript,
    setCalendar,
    storeRaw,
    updatedAt,
    calendars,
    edgeCounts,
    setZone,
    read,
    items,
    inTenant,
  };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

describe("calendar timeline read (issue #1717)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("verify calendar timeline role", () =>
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("returns the Events and Tasks of 16 Oct 2026 in group order with calendar, project and people, without the wontDo Task", async () => {
    const w = world(await newTenant());
    const { defaultId, tasksId } = await w.calendars();
    const project = await w.create("projects", { name: "Website", color: "#FF9500" });
    const jana = await w.create("people", { name: "Jana Kovářová" });
    const petr = await w.create("people", { name: "Petr Novák" });
    const standup = await w.create("events", {
      name: "Standup",
      type: "standup",
      date: DAY,
      timeFrom: "09:00",
      timeTo: "09:30",
    });
    const meeting = await w.create("events", {
      name: "Meeting with client",
      type: "meeting",
      date: DAY,
      timeFrom: "10:00",
      timeTo: "11:00",
      place: "Office",
    });
    await w.link("events", "project", meeting, project);
    await w.link("events", "people", meeting, jana);
    await w.link("events", "people", meeting, petr);
    const invoice = await w.create("tasks", { name: "Send invoice", date: DAY, timeFrom: "08:00" });
    await w.link("tasks", "project", invoice, project);
    await w.link("tasks", "people", invoice, jana);
    completedOn(DAY);
    await w.update("tasks", invoice, { status: "done" });
    const rent = await w.create("tasks", { name: "Pay rent", date: DAY });
    const skipped = await w.create("tasks", { name: "Call plumber", date: DAY, status: "wontDo" });
    const eventsId = await w.databaseId("events");
    const tasksDatabaseId = await w.databaseId("tasks");

    const timeline = await w.read(DAY);
    const items = z.array(fullItemSchema).parse(timeline.items);

    expect({ timezone: timeline.timezone, from: timeline.from, to: timeline.to }).toEqual({
      timezone: "Europe/Prague",
      from: DAY,
      to: DAY,
    });
    // Tasks without a time, then timed Events by start, then timed Tasks, although the Task starts first.
    expect(items.map((item) => item.id)).toEqual([rent, standup, meeting, invoice]);
    expect(items.map((item) => item.id)).not.toContain(skipped);
    expect(items[0]).toEqual({
      kind: "task",
      id: rent,
      databaseId: tasksDatabaseId,
      title: "Pay rent",
      type: null,
      date: DAY,
      endDate: null,
      timeFrom: null,
      timeTo: null,
      effectiveTo: null,
      hasEnd: false,
      allDay: true,
      calendarId: tasksId,
      status: "notDone",
      place: null,
      project: null,
      people: [],
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: null,
      counts: null,
      carriedFrom: null,
      updatedAt: await w.updatedAt("tasks", rent),
      readOnly: false,
    });
    expect(items[1]).toEqual({
      kind: "event",
      id: standup,
      databaseId: eventsId,
      title: "Standup",
      type: "standup",
      date: DAY,
      endDate: null,
      timeFrom: "09:00",
      timeTo: "09:30",
      effectiveTo: "09:30",
      hasEnd: true,
      allDay: false,
      calendarId: defaultId,
      status: null,
      place: null,
      project: null,
      people: [],
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: [],
      counts: { open: 0, total: 0 },
      carriedFrom: null,
      updatedAt: await w.updatedAt("events", standup),
      readOnly: false,
    });
    const meetingItem = items[2];
    expect({ ...meetingItem, people: [...(meetingItem?.people ?? [])].sort(byId) }).toEqual({
      kind: "event",
      id: meeting,
      databaseId: eventsId,
      title: "Meeting with client",
      type: "meeting",
      date: DAY,
      endDate: null,
      timeFrom: "10:00",
      timeTo: "11:00",
      effectiveTo: "11:00",
      hasEnd: true,
      allDay: false,
      calendarId: defaultId,
      status: null,
      place: "Office",
      project: { id: project, name: "Website", color: "#FF9500" },
      people: [
        { id: jana, name: "Jana Kovářová" },
        { id: petr, name: "Petr Novák" },
      ].sort(byId),
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: [],
      counts: { open: 0, total: 0 },
      carriedFrom: null,
      updatedAt: await w.updatedAt("events", meeting),
      readOnly: false,
    });
    expect(items[3]).toEqual({
      kind: "task",
      id: invoice,
      databaseId: tasksDatabaseId,
      title: "Send invoice",
      type: null,
      date: DAY,
      endDate: null,
      timeFrom: "08:00",
      timeTo: null,
      // A Task has no default length: without an end it ends at its start.
      effectiveTo: "08:00",
      hasEnd: false,
      allDay: false,
      calendarId: tasksId,
      status: "done",
      place: null,
      project: { id: project, name: "Website", color: "#FF9500" },
      people: [{ id: jana, name: "Jana Kovářová" }],
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: null,
      counts: null,
      carriedFrom: null,
      updatedAt: await w.updatedAt("tasks", invoice),
      readOnly: false,
    });
  });

  it("orders days first, then all-day Events, Tasks without a time, timed Events and timed Tasks, then timeFrom, title and id", async () => {
    const w = world(await newTenant());
    const nextDay = "2026-10-17";
    const nextDayEvent = await w.create("events", { name: "Next day all-day", date: nextDay });
    const noonTask = await w.create("tasks", { name: "Noon task", date: DAY, timeFrom: "12:00" });
    const earlyTask = await w.create("tasks", { name: "Early task", date: DAY, timeFrom: "07:00" });
    const lateEvent = await w.create("events", { name: "Late event", date: DAY, timeFrom: "14:00" });
    const twins = [
      await w.create("events", { name: "Early event", date: DAY, timeFrom: "09:00" }),
      await w.create("events", { name: "Early event", date: DAY, timeFrom: "09:00" }),
    ].sort();
    // Later than its twins by title only.
    const laterTitle = await w.create("events", { name: "Early meeting", date: DAY, timeFrom: "09:00" });
    const untimedTask = await w.create("tasks", { name: "Untimed task", date: DAY });
    const zeta = await w.create("events", { name: "Zeta all-day", date: DAY });
    const alpha = await w.create("events", { name: "Alpha all-day", date: DAY });

    expect((await w.items(DAY, nextDay)).map((item) => item.id)).toEqual([
      alpha,
      zeta,
      untimedTask,
      ...twins,
      laterTitle,
      lateEvent,
      earlyTask,
      noonTask,
      nextDayEvent,
    ]);
  });

  it("compares titles in Czech for a Czech user and for a tenant without a user, and in English for an English user", async () => {
    const titles = ["Hokej", "Chata", "Cesta", "Čaj"];
    const sorted = (locale: string) => {
      const collator = new Intl.Collator(locale);
      return [...titles].sort((a, b) => collator.compare(a, b));
    };
    const czech = sorted("cs");
    const english = sorted("en");
    // The fixture must tell the two orders apart, or the assertions below would hold for either.
    expect(czech).not.toEqual(english);

    for (const [locale, expected] of [
      ["cs", czech],
      [null, czech],
      ["en", english],
    ] as const) {
      const w = world(await newTenant(locale));
      for (const name of titles) await w.create("events", { name, date: DAY });
      expect(
        (await w.items(DAY)).map((item) => item.title),
        String(locale),
      ).toEqual(expected);
    }
  });

  it("returns a multi-day Event once, with its range, for every range that touches its days and for no other", async () => {
    const w = world(await newTenant());
    const trip = await w.create("events", { name: "Trip", date: "2026-10-24", endDate: "2026-10-25" });

    const lastDayOnly = await w.items("2026-10-25");
    expect(lastDayOnly.map((item) => item.id)).toEqual([trip]);
    expect(lastDayOnly[0]).toMatchObject({ date: "2026-10-24", endDate: "2026-10-25", allDay: true });
    expect((await w.items("2026-10-24")).map((item) => item.id)).toEqual([trip]);
    expect((await w.items("2026-10-20", "2026-10-31")).map((item) => item.id)).toEqual([trip]);
    expect(await w.items("2026-10-23")).toEqual([]);
    expect(await w.items("2026-10-26")).toEqual([]);
  });

  it("returns a Task on its own day only, whatever its status except wontDo", async () => {
    const w = world(await newTenant());
    const open = await w.create("tasks", { name: "Open", date: DAY });
    const done = await w.create("tasks", { name: "Done", date: DAY });
    completedOn(DAY);
    await w.update("tasks", done, { status: "done" });
    await w.create("tasks", { name: "Dropped", date: DAY, status: "wontDo" });
    await w.create("tasks", { name: "Unscheduled" });

    const day = await w.items(DAY);
    expect(day.map((item) => [item.id, item.status])).toEqual([
      [done, "done"],
      [open, "notDone"],
    ]);
    expect(await w.items("2026-10-15")).toEqual([]);
    expect(await w.items("2026-10-17")).toEqual([]);
    expect((await w.items("2026-10-01", "2026-10-31")).map((item) => item.id)).toEqual([done, open]);
  });

  it("leaves out a trashed Event and a trashed Task", async () => {
    const w = world(await newTenant());
    const keptEvent = await w.create("events", { name: "Kept event", date: DAY });
    const trashedEvent = await w.create("events", { name: "Trashed event", date: DAY });
    const keptTask = await w.create("tasks", { name: "Kept task", date: DAY });
    const trashedTask = await w.create("tasks", { name: "Trashed task", date: DAY });
    await w.trash("events", trashedEvent);
    await w.trash("tasks", trashedTask);

    expect((await w.items(DAY)).map((item) => item.id)).toEqual([keptEvent, keptTask]);
  });

  it("gives an Event its calendar edge, an Event without one the default calendar, and writes no edge", async () => {
    const w = world(await newTenant());
    const { defaultId, workId } = await w.calendars();
    const inWork = await w.create("events", { name: "In work", date: DAY });
    await w.setCalendar(inWork, workId);
    const withoutEdge = await w.create("events", { name: "Without an edge", date: DAY });
    await w.setCalendar(withoutEdge, null);
    const before = await w.edgeCounts(withoutEdge);
    expect(before.ofItem).toBe(0);

    const items = await w.items(DAY);

    expect(items.map((item) => [item.id, item.calendarId])).toEqual([
      [inWork, workId],
      [withoutEdge, defaultId],
    ]);
    expect(await w.edgeCounts(withoutEdge)).toEqual(before);
  });

  it("returns the items of hidden calendars with their calendarId, for the client to hide", async () => {
    const w = world(await newTenant());
    const { tasksId, workId } = await w.calendars();
    await w.update(CALENDARS_MODULE_ID, workId, { hidden: true });
    await w.update(CALENDARS_MODULE_ID, tasksId, { hidden: true });
    const event = await w.create("events", { name: "In a hidden calendar", date: DAY });
    await w.setCalendar(event, workId);
    const task = await w.create("tasks", { name: "Task", date: DAY });

    expect((await w.items(DAY)).map((item) => [item.id, item.calendarId])).toEqual([
      [event, workId],
      [task, tasksId],
    ]);
  });

  it("returns null calendar ids while the tenant has no calendars database", async () => {
    const tenantId = await newTenant();
    const w = world(tenantId);
    const event = await w.create("events", { name: "Older event", date: DAY });
    const task = await w.create("tasks", { name: "Older task", date: DAY });
    const calendarsId = await w.databaseId(CALENDARS_MODULE_ID);
    const eventsId = await w.databaseId("events");
    const projectsId = await w.databaseId("projects");
    // The shape of a tenant seeded before issue #1600, as `calendars.test.ts` builds it: the calendars database
    // is locked and system-owned and no public path removes it or the locked Events relation, so this is raw
    // SQL on the admin pool in the tenant's scope; the database and its partition go through the store's drop.
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const calendarsDatabase = await databasesStore.getDatabase(client, calendarsId);
      if (!calendarsDatabase) throw new Error("Calendars database missing");
      const { rows } = await client.query<{ id: string; definition: string }>(
        "SELECT id, config->>'relationDefinitionId' AS definition FROM properties WHERE database_id = $1 AND key = 'calendar'",
        [eventsId],
      );
      const relation = rows[0];
      if (!relation) throw new Error("Events.calendar missing");
      await client.query("DELETE FROM item_relations WHERE relation_definition_id = $1", [relation.definition]);
      await client.query("DELETE FROM relation_definitions WHERE id = $1", [relation.definition]);
      await client.query("DELETE FROM properties WHERE id = $1", [relation.id]);
      await client.query("DELETE FROM items WHERE database_id = $1", [calendarsId]);
      await client.query("DELETE FROM properties WHERE database_id = $1", [calendarsId]);
      await client.query("DELETE FROM views WHERE database_id = $1", [calendarsId]);
      await databasesStore.dropDatabaseWithPartition(client, calendarsId);
      await client.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [
        projectsId,
        calendarsDatabase.ownerProjectItemId,
      ]);
    });
    const calendarsAfter = await w.inTenant(() =>
      withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID)),
    );
    const eventKeys = (await w.inTenant(() => createChokePoint(dataPool).listProperties(eventsId))).map(
      (property) => property.key,
    );
    expect(calendarsAfter).toBeNull();
    expect(eventKeys).not.toContain("calendar");
    expect(eventKeys).toContain("project");

    expect((await w.items(DAY)).map((item) => [item.id, item.calendarId])).toEqual([
      [event, null],
      [task, null],
    ]);
  });

  it("returns null calendar ids when neither the default nor the tasks calendar is live", async () => {
    const tenantId = await newTenant();
    const w = world(tenantId);
    const { defaultId, tasksId } = await w.calendars();
    const event = await w.create("events", { name: "Event", date: DAY });
    await w.setCalendar(event, null);
    const task = await w.create("tasks", { name: "Task", date: DAY });
    // Raw SQL: which calendars may be deleted is decided by later calendar issues, so the trashed default and
    // system calendar are stored directly instead of through a delete those issues may refuse.
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query("UPDATE items SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
        [defaultId, tasksId],
      ]);
      expect(result.rowCount).toBe(2);
    });

    expect((await w.items(DAY)).map((item) => [item.id, item.calendarId])).toEqual([
      [event, null],
      [task, null],
    ]);
  });

  it("leaves a trashed project and a trashed person out of an item", async () => {
    const w = world(await newTenant());
    const project = await w.create("projects", { name: "Trashed project" });
    const kept = await w.create("people", { name: "Kept" });
    const gone = await w.create("people", { name: "Gone" });
    const event = await w.create("events", { name: "Event", date: DAY });
    await w.link("events", "project", event, project);
    await w.link("events", "people", event, kept);
    await w.link("events", "people", event, gone);
    expect((await w.items(DAY))[0]).toMatchObject({ project: { id: project }, people: expect.any(Array) });
    await w.trash("projects", project);
    await w.trash("people", gone);

    expect((await w.items(DAY)).map((item) => [item.id, item.project, item.people])).toEqual([
      [event, null, [{ id: kept, name: "Kept" }]],
    ]);
  });

  it("gives each Event its own transcript with the stored status, and null to an Event without one and to a Task", async () => {
    const w = world(await newTenant());
    const recorded = await w.create("events", { name: "Recorded", date: DAY, timeFrom: "10:00" });
    const running = await w.create("events", { name: "Running", date: DAY, timeFrom: "11:00" });
    const plain = await w.create("events", { name: "Plain", date: DAY, timeFrom: "12:00" });
    const task = await w.create("tasks", { name: "Task", date: DAY, timeFrom: "13:00" });
    const done = await w.createTranscript({ name: "Recording", status: "done" });
    const processing = await w.createTranscript({ name: "Being transcribed", status: "processing" });
    await w.link("events", "transcript", recorded, done);
    // The same relation written from its other side, `Transcripts.event`.
    await w.link("transcripts", "event", processing, running);

    expect((await w.items(DAY)).map((item) => [item.id, item.transcript])).toEqual([
      [recorded, { id: done, status: "done" }],
      [running, { id: processing, status: "processing" }],
      [plain, null],
      [task, null],
    ]);
  });

  it("returns a null status for a transcript that stores none", async () => {
    const w = world(await newTenant());
    const event = await w.create("events", { name: "Event", date: DAY });
    const transcript = await w.createTranscript({ name: "Without a status" });
    await w.link("events", "transcript", event, transcript);

    expect((await w.items(DAY)).map((item) => [item.id, item.transcript])).toEqual([
      [event, { id: transcript, status: null }],
    ]);
  });

  it("gives an Event with several transcripts the first live one by the addedAt of their edges", async () => {
    const w = world(await newTenant());
    const event = await w.create("events", { name: "Meeting in three parts", date: DAY });
    const second = await w.createTranscript({ name: "Part 2", status: "processing" });
    const third = await w.createTranscript({ name: "Part 3", status: "error" });
    const first = await w.createTranscript({ name: "Part 1", status: "done" });
    // The order of the edges is neither the order the transcripts were created in nor the order they were linked in.
    await w.link("events", "transcript", event, second, { addedAt: "2026-10-16T10:30:00.000Z" });
    await w.link("events", "transcript", event, third, { addedAt: "2026-10-16T11:00:00.000Z" });
    await w.link("events", "transcript", event, first, { addedAt: "2026-10-16T10:00:00.000Z" });
    const transcript = async () => (await w.items(DAY)).map((item) => [item.id, item.transcript]);

    expect(await transcript()).toEqual([[event, { id: first, status: "done" }]]);
    await w.trash("transcripts", first);
    expect(await transcript()).toEqual([[event, { id: second, status: "processing" }]]);
    await w.trash("transcripts", second);
    await w.trash("transcripts", third);
    expect(await transcript()).toEqual([[event, null]]);
  });

  it("orders the transcripts of an Event by edge id when their edges carry no addedAt", async () => {
    const w = world(await newTenant());
    const event = await w.create("events", { name: "Meeting in four parts", date: DAY });
    const edges: { edgeId: string; transcript: string }[] = [];
    for (const status of ["recording", "processing", "done", "error"]) {
      const transcript = await w.createTranscript({ name: `Part ${status}`, status });
      edges.push({ edgeId: await w.link("events", "transcript", event, transcript), transcript });
    }
    // Edge ids are lowercase UUIDs of one length, so this comparison is the statement's order of `id::text`.
    const expected = [...edges].sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1))[0];
    if (!expected) throw new Error("No edge");

    expect((await w.items(DAY)).map((item) => item.transcript?.id)).toEqual([expected.transcript]);
  });

  it("returns an empty title and empty names for rows without a name, and a null colour for a project without one", async () => {
    const w = world(await newTenant());
    const project = await w.create("projects", { name: "Project" });
    const person = await w.create("people", { name: "Person" });
    const event = await w.create("events", { name: "Event", date: DAY });
    await w.link("events", "project", event, project);
    await w.link("events", "people", event, person);
    // Rows without a title: a system writer may store one, a user's write may not.
    for (const [moduleId, id] of [
      ["projects", project],
      ["people", person],
      ["events", event],
    ] as const) {
      await w.storeRaw(moduleId, id, { name: null });
    }

    expect((await w.items(DAY)).map((item) => [item.id, item.title, item.project, item.people])).toEqual([
      [event, "", { id: project, name: "", color: null }, [{ id: person, name: "" }]],
    ]);
  });

  it.each([
    ["events", "date", { date: "abc" }, DAY, DAY],
    ["events", "date", { date: "2026-02-30" }, "2026-02-28", "2026-03-01"],
    ["events", "endDate", { endDate: "soon" }, DAY, DAY],
    ["events", "timeFrom", { timeFrom: "25:00" }, DAY, DAY],
    ["events", "timeTo", { timeTo: "9am" }, DAY, DAY],
    ["tasks", "date", { date: "abc", effectiveDate: "abc" }, DAY, DAY],
    ["tasks", "timeFrom", { timeFrom: "noon" }, DAY, DAY],
    ["tasks", "timeTo", { timeTo: "late" }, DAY, DAY],
  ] as const)(
    "leaves out an item of %s whose stored %s is not valid (%j), logs its id and still returns the others",
    async (moduleId, property, patch, from, to) => {
      const w = world(await newTenant());
      const valid = await w.create(moduleId, { name: "Valid", date: from });
      const broken = await w.create(moduleId, { name: "Broken", date: from, timeFrom: "10:00", timeTo: "11:00" });
      await w.storeRaw(moduleId, broken, patch);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const items = await w.items(from, to);

      expect(items.map((item) => item.id)).toEqual([valid]);
      expect(warn.mock.calls).toEqual([
        [{ itemId: broken, databaseId: await w.databaseId(moduleId), property }, SKIP_MESSAGE],
      ]);
    },
  );

  it("reports an Event whose stored date still carries a time only for a range that holds its day", async () => {
    const w = world(await newTenant());
    const legacy = await w.create("events", { name: "Legacy", date: DAY });
    await w.storeRaw("events", legacy, { date: `${DAY}T08:00:00.000Z` });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(await w.items("2026-10-17", "2026-10-31")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    expect(await w.items(DAY)).toEqual([]);
    expect(warn.mock.calls).toEqual([
      [{ itemId: legacy, databaseId: await w.databaseId("events"), property: "date" }, SKIP_MESSAGE],
    ]);
  });

  it("reads endDate, type and place from an Event only and status from a Task only, whatever else a row holds", async () => {
    const w = world(await newTenant());
    const task = await w.create("tasks", { name: "Task", date: DAY });
    const event = await w.create("events", { name: "Event", date: DAY });
    // Keys of the other kind, which neither schema has and no write stores.
    await w.storeRaw("tasks", task, { endDate: "soon", type: "meeting", place: "Office" });
    await w.storeRaw("events", event, { status: "done" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect((await w.items(DAY)).map((item) => [item.id, item.endDate, item.type, item.place, item.status])).toEqual([
      [event, null, null, null, null],
      [task, null, null, null, "notDone"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("derives effectiveTo and hasEnd from the stored end and the time module's defaults", async () => {
    const w = world(await newTenant());
    const untilMidnight = await w.create("events", {
      name: "Until midnight",
      date: DAY,
      timeFrom: "22:00",
      timeTo: "24:00",
    });
    const overnight = await w.create("events", {
      name: "Overnight",
      date: DAY,
      endDate: "2026-10-17",
      timeFrom: "20:00",
      timeTo: "02:00",
    });
    const withoutEnd = await w.create("events", { name: "Without an end", date: DAY, timeFrom: "10:00" });
    // An Event stored before the default end of issue #1598: every write now stores an end for a timed Event.
    await w.storeRaw("events", withoutEnd, { timeTo: null });
    const boundedTask = await w.create("tasks", { name: "Bounded", date: DAY, timeFrom: "15:00", timeTo: "15:45" });

    const byItem = new Map((await w.items(DAY)).map((item) => [item.id, item]));
    const ends = (id: string) => {
      const item = byItem.get(id);
      return item && { timeTo: item.timeTo, effectiveTo: item.effectiveTo, hasEnd: item.hasEnd, allDay: item.allDay };
    };

    expect(ends(untilMidnight)).toEqual({ timeTo: "24:00", effectiveTo: "24:00", hasEnd: true, allDay: false });
    expect(ends(overnight)).toEqual({ timeTo: "02:00", effectiveTo: "02:00", hasEnd: true, allDay: false });
    expect(ends(withoutEnd)).toEqual({ timeTo: null, effectiveTo: "23:59", hasEnd: false, allDay: false });
    expect(ends(boundedTask)).toEqual({ timeTo: "15:45", effectiveTo: "15:45", hasEnd: true, allDay: false });
  });

  it("returns a stored time that the tenant zone skips on a daylight-saving day unchanged as effectiveTo", async () => {
    const w = world(await newTenant());
    // Europe/Prague has no 02:00-02:59 on 29 Mar 2026, so the instant of a stored time in that hour reads an
    // hour later; the timeline must not report that shifted time.
    const gapDay = "2026-03-29";
    expect(wallClockToInstant(gapDay, "02:30", "Europe/Prague").toFormat("HH:mm")).toBe("03:30");
    const task = await w.create("tasks", { name: "Starts in the gap", date: gapDay, timeFrom: "02:30" });
    const boundedTask = await w.create("tasks", {
      name: "Ends in the gap",
      date: gapDay,
      timeFrom: "01:30",
      timeTo: "02:45",
    });
    const event = await w.create("events", {
      name: "Ends in the gap",
      date: gapDay,
      timeFrom: "01:00",
      timeTo: "02:30",
    });

    const timeline = await w.read(gapDay);
    const items = z.array(fullItemSchema).parse(timeline.items);

    expect(timeline.timezone).toBe("Europe/Prague");
    expect(items.map((item) => [item.id, item.timeFrom, item.timeTo, item.effectiveTo, item.hasEnd])).toEqual([
      [event, "01:00", "02:30", "02:30", true],
      [boundedTask, "01:30", "02:45", "02:45", true],
      [task, "02:30", null, "02:30", false],
    ]);
  });

  it("reports today and now in the tenant zone: 17 Oct in Europe/Prague at 23:30 UTC on 16 Oct", async () => {
    const w = world(await newTenant());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:30:00Z"));

    const prague = await w.read(DAY);
    expect({ timezone: prague.timezone, today: prague.today, now: prague.now }).toEqual({
      timezone: "Europe/Prague",
      today: "2026-10-17",
      now: { date: "2026-10-17", time: "01:30" },
    });

    await w.setZone("America/New_York");
    const newYork = await w.read(DAY);
    expect({ timezone: newYork.timezone, today: newYork.today, now: newYork.now }).toEqual({
      timezone: "America/New_York",
      today: "2026-10-16",
      now: { date: "2026-10-16", time: "19:30" },
    });
  });

  it("returns only the compact fields for shape compact, in the same order as the full shape", async () => {
    const w = world(await newTenant());
    const { defaultId, tasksId } = await w.calendars();
    const event = await w.create("events", { name: "Event", date: DAY, timeFrom: "09:00", place: "Office" });
    const task = await w.create("tasks", { name: "Task", date: DAY });

    const compact = await w.read(DAY, DAY, "compact");

    expect(compact.items).toEqual([
      {
        id: task,
        kind: "task",
        title: "Task",
        calendarId: tasksId,
        allDay: true,
        date: DAY,
        endDate: null,
        timeFrom: null,
        status: "notDone",
        counts: null,
        attendance: null,
        updatedAt: await w.updatedAt("tasks", task),
        readOnly: false,
      },
      {
        id: event,
        kind: "event",
        title: "Event",
        calendarId: defaultId,
        allDay: false,
        date: DAY,
        endDate: null,
        timeFrom: "09:00",
        status: null,
        counts: { open: 0, total: 0 },
        attendance: null,
        updatedAt: await w.updatedAt("events", event),
        readOnly: false,
      },
    ]);
    expect((await w.items(DAY)).map((item) => item.id)).toEqual([task, event]);
  });

  it("never returns another tenant's items, projects, people or transcripts", async () => {
    async function seed(name: string) {
      const w = world(await newTenant());
      const project = await w.create("projects", { name: `${name} project` });
      const person = await w.create("people", { name: `${name} person` });
      const event = await w.create("events", { name: `${name} event`, date: DAY });
      const task = await w.create("tasks", { name: `${name} task`, date: DAY });
      const transcript = await w.createTranscript({ name: `${name} transcript`, status: "done" });
      await w.link("events", "project", event, project);
      await w.link("events", "people", event, person);
      await w.link("events", "transcript", event, transcript);
      await w.link("tasks", "project", task, project);
      return { w, project, person, event, task, transcript };
    }
    const a = await seed("A");
    const b = await seed("B");

    for (const [own, foreign] of [
      [a, b],
      [b, a],
    ] as const) {
      const items = await own.w.items("2026-10-01", "2026-10-31");
      expect(items.map((item) => item.id).sort()).toEqual([own.event, own.task].sort());
      const text = JSON.stringify(await own.w.read("2026-10-01", "2026-10-31"));
      for (const id of [foreign.event, foreign.task, foreign.project, foreign.person, foreign.transcript]) {
        expect(text).not.toContain(id);
      }
      for (const id of [own.event, own.task, own.project, own.person, own.transcript]) expect(text).toContain(id);
    }
  });

  it("sends the same number of queries for one item per database as for many", async () => {
    const w = world(await newTenant());
    const busyDay = "2026-10-20";
    const project = await w.create("projects", { name: "Project" });
    const people = [await w.create("people", { name: "First" }), await w.create("people", { name: "Second" })];
    async function seedDay(date: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        for (const moduleId of ["events", "tasks"]) {
          const item = await w.create(moduleId, { name: `${moduleId} ${index}`, date });
          await w.link(moduleId, "project", item, project);
          for (const person of people) await w.link(moduleId, "people", item, person);
        }
      }
    }
    await seedDay(DAY, 1);
    await seedDay(busyDay, 6);

    /** The number of statements one read sends and the number of items it returns. */
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
          const items = z.array(fullItemSchema).parse(timeline.items);
          expect(items.every((item) => item.project?.id === project && item.people.length === 2)).toBe(true);
          return { queries, items: items.length };
        }),
      );

    const quiet = await count(DAY);
    const busy = await count(busyDay);
    expect(quiet.items).toBe(2);
    expect(busy.items).toBe(12);
    expect(quiet.queries).toBeGreaterThan(0);
    expect(busy.queries).toBe(quiet.queries);
  });

  it("reads the transcripts of all the Events of a range with one statement, whatever their number", async () => {
    const w = world(await newTenant());
    const busyDay = "2026-10-20";
    async function seedDay(date: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const event = await w.create("events", { name: `Event ${index}`, date });
        const transcript = await w.createTranscript({ name: `Transcript ${index}`, status: "done" });
        await w.link("events", "transcript", event, transcript);
      }
    }
    await seedDay(DAY, 1);
    await seedDay(busyDay, 6);

    /** The text of every statement one read sends, and the items it returns. */
    const observe = (date: string) =>
      w.inTenant(() =>
        withTransaction(dataPool, async (client) => {
          const statements: string[] = [];
          const observed: PoolClient = new Proxy(client, {
            get(target, property, receiver) {
              const value: unknown = Reflect.get(target, property, receiver);
              if (property !== "query" || typeof value !== "function") return value;
              return (...args: unknown[]): unknown => {
                statements.push(typeof args[0] === "string" ? args[0] : "");
                return Reflect.apply(value, target, args);
              };
            },
          });
          const timeline = await readCalendarTimeline(observed, { from: date, to: date, shape: "full" });
          return { statements, items: z.array(fullItemSchema).parse(timeline.items) };
        }),
      );
    /** The statements that select a transcript; only the transcript lookup names a `transcript_id`. */
    const transcriptReads = (statements: string[]) => statements.filter((sql) => sql.includes("transcript_id")).length;

    const quiet = await observe(DAY);
    const busy = await observe(busyDay);

    expect(quiet.items.map((item) => item.transcript?.status)).toEqual(["done"]);
    expect(busy.items.map((item) => item.transcript?.status)).toEqual(Array.from({ length: 6 }, () => "done"));
    expect(transcriptReads(quiet.statements)).toBe(1);
    expect(transcriptReads(busy.statements)).toBe(1);
    expect(busy.statements.length).toBe(quiet.statements.length);
  });

  it("lists the core sources as events, then tasks, before the derived sources", () => {
    expect(CALENDAR_TIMELINE_SOURCES.slice(0, 2).map((source) => source.id)).toEqual(["events", "tasks"]);
  });

  it("merges whatever a listed source returns, in the timeline's order, and gives it the shared context", async () => {
    const w = world(await newTenant());
    const timed = await w.create("events", { name: "Timed event", date: DAY, timeFrom: "09:00" });
    const tasksSource = CALENDAR_TIMELINE_SOURCES.find((source) => source.id === "tasks");
    if (!tasksSource) throw new Error("No tasks source");
    const derived: CalendarTimelineItem = {
      kind: "task",
      id: "derived:1",
      databaseId: randomUUID(),
      title: "Derived",
      type: null,
      date: DAY,
      endDate: null,
      timeFrom: null,
      timeTo: null,
      effectiveTo: null,
      hasEnd: false,
      allDay: true,
      calendarId: null,
      status: null,
      place: null,
      project: null,
      people: [],
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: null,
      counts: null,
      carriedFrom: null,
      updatedAt: "2026-10-16T00:00:00.000Z",
      readOnly: true,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:15:00Z"));
    // Restored by `vi.restoreAllMocks()` in `afterEach`. The two derived items differ in their id only.
    const readItems = vi.spyOn(tasksSource, "readItems").mockResolvedValue([{ ...derived, id: "derived:2" }, derived]);

    const items = await w.items(DAY);

    expect(items.map((item) => [item.id, item.readOnly])).toEqual([
      ["derived:1", true],
      ["derived:2", true],
      [timed, false],
    ]);
    expect(readItems.mock.calls.map(([, context]) => context)).toEqual([
      {
        from: DAY,
        to: DAY,
        timezone: "Europe/Prague",
        today: DAY,
        now: { date: DAY, time: "12:15" },
        at: new Date("2026-10-16T10:15:00Z"),
      },
    ]);
  });

  it("returns an empty timeline for a tenant whose system databases are not seeded", async () => {
    const tenantId = await createTestTenant(adminPool);

    const timeline = await runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) => readCalendarTimeline(client, { from: DAY, to: DAY, shape: "full" })),
    );

    expect({ timezone: timeline.timezone, from: timeline.from, to: timeline.to, items: timeline.items }).toEqual({
      timezone: "Europe/Prague",
      from: DAY,
      to: DAY,
      items: [],
    });
  });
});
