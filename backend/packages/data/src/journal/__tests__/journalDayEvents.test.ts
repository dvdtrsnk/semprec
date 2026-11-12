import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { readCalendarTimeline, readTaskTimelineItems } from "../../calendar/timelineRead.js";
import { CALENDAR_TIMELINE_SOURCES, type CalendarTimelineItem } from "../../calendar/timelineSources.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { createJournalPeriodReadRouteHandler } from "../journalRouteHandlers.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const DAY = "2026-10-16";

/** One element of `events`: exactly the fields issue #1721 lists. */
const journalEventSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string().nullable(),
    date: z.string(),
    endDate: z.string().nullable(),
    timeFrom: z.string().nullable(),
    timeTo: z.string().nullable(),
    allDay: z.boolean(),
    place: z.string().nullable(),
    project: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).strict().nullable(),
    calendarId: z.string().nullable(),
    transcript: z.object({ id: z.string(), status: z.string().nullable() }).strict().nullable(),
  })
  .strict();

const dayResponseSchema = z.object({ type: z.literal("day"), period: z.string(), events: z.array(journalEventSchema) });

const calendarSchema = z.object({ id: z.string(), properties: z.object({ isDefault: z.boolean() }) });

/** The response body as JSON carries it. */
function wire(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body));
}

async function newTenant(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "cs" });
  await runInTenant(tenantId, () => seedSystem(dataPool));
  return tenantId;
}

/** One tenant's fixture writes and Journal reads, each in that tenant's scope on the runtime-role pool. */
function world(tenantId: string) {
  const chokePoint = createChokePoint(dataPool);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantId, fn);

  async function databaseId(moduleId: string): Promise<string> {
    const database = await inTenant(() =>
      withTransaction(dataPool, (client) => getDatabaseByModuleId(client, moduleId)),
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

  /** A transcript as the transcription process writes it: `status` is its property, which a user's write may not set. */
  async function createTranscript(name: string, status: string): Promise<string> {
    const id = await databaseId("transcripts");
    const item = await inTenant(() =>
      withTransaction(dataPool, (client) =>
        createItemWithClient(
          client,
          { databaseId: id, properties: { name, status } },
          { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      ),
    );
    return item.id;
  }

  async function link(key: string, eventId: string, targetItemId: string): Promise<void> {
    const id = await databaseId("events");
    await inTenant(async () => {
      const property = (await chokePoint.listProperties(id)).find((entry) => entry.key === key);
      if (!property) throw new Error(`No events.${key}`);
      await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: eventId, targetItemId });
    });
  }

  async function trash(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => chokePoint.softDeleteItem(id, itemId));
  }

  async function defaultCalendarId(): Promise<string> {
    const id = await databaseId(CALENDARS_MODULE_ID);
    const rows = z.array(calendarSchema).parse((await inTenant(() => chokePoint.listItems(id, { limit: 50 }))).items);
    const calendar = rows.find((row) => row.properties.isDefault);
    if (!calendar) throw new Error("No default calendar");
    return calendar.id;
  }

  /** The body of `GET /api/journal/periods/:type/:period` as the handler answers it, read through `pool`. */
  async function readPeriod(type: string, period: string, pool: Pool = dataPool): Promise<unknown> {
    const result = await inTenant(() => createJournalPeriodReadRouteHandler(pool)({ params: { type, period } }));
    expect(result.status).toBe(200);
    return wire(result.body);
  }

  /** The `events` of a Journal day, each checked to carry exactly the listed fields. */
  const events = async (day: string) => dayResponseSchema.parse(await readPeriod("day", day)).events;

  /** The ids of everything the calendar timeline returns for `day`, in its order, with each item's kind. */
  const timelineOf = async (day: string) =>
    (
      await inTenant(() =>
        withTransaction(dataPool, (client) => readCalendarTimeline(client, { from: day, to: day, shape: "full" })),
      )
    ).items.map((item) => ({ id: item.id, kind: item.kind }));

  return { create, createTranscript, link, trash, defaultCalendarId, readPeriod, events, timelineOf };
}

/**
 * The fixture day of issue #1721: the all-day Conference and four timed Events on 2026-10-16, written in an
 * order that is not the expected one.
 */
async function seedFixtureDay(w: ReturnType<typeof world>) {
  const website = await w.create("projects", { name: "Website", color: "#FF9500" });
  const deepWork = await w.create("projects", { name: "Deep work" });
  const focus = await w.create("events", { name: "Focus block", date: DAY, timeFrom: "15:00" });
  await w.link("project", focus, deepWork);
  const lunch = await w.create("events", { name: "Lunch", date: DAY, timeFrom: "12:00" });
  const conference = await w.create("events", { name: "Conference", type: "event", date: DAY });
  const meeting = await w.create("events", {
    name: "Meeting with client",
    type: "meeting",
    date: DAY,
    timeFrom: "10:00",
    timeTo: "11:30",
    place: "Office",
  });
  await w.link("project", meeting, website);
  const transcript = await w.createTranscript("Meeting with client", "done");
  await w.link("transcript", meeting, transcript);
  const standup = await w.create("events", { name: "Standup", type: "standup", date: DAY, timeFrom: "09:00" });
  return { website, deepWork, conference, standup, meeting, lunch, focus, transcript };
}

/** A pool that hands out clients of `pool` and records the text of every statement they send. */
function observed(pool: Pool): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(pool, {
    get(target, key, receiver) {
      if (key !== "connect") return Reflect.get(target, key, receiver);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, property, original) {
            if (property !== "query") return Reflect.get(inner, property, original);
            return new Proxy(inner.query.bind(inner), {
              apply(fn, receiverValue, args: unknown[]) {
                if (typeof args[0] === "string") statements.push(args[0]);
                return Reflect.apply(fn, receiverValue, args);
              },
            });
          },
        });
      };
    },
  });
  return { pool: proxy, statements };
}

describe("journal day events (issue #1721)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("verify journal day events role", () =>
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

  it("lists the five events of 2026-10-16 in the timeline's order: the all-day Conference, then 09:00, 10:00, 12:00 and 15:00", async () => {
    const w = world(await newTenant());
    const fixture = await seedFixtureDay(w);

    const events = await w.events(DAY);

    expect(events.map((event) => [event.id, event.title, event.allDay, event.timeFrom])).toEqual([
      [fixture.conference, "Conference", true, null],
      [fixture.standup, "Standup", false, "09:00"],
      [fixture.meeting, "Meeting with client", false, "10:00"],
      [fixture.lunch, "Lunch", false, "12:00"],
      [fixture.focus, "Focus block", false, "15:00"],
    ]);
  });

  it("gives the meeting its project, place, timeTo and done transcript, and Standup a null project", async () => {
    const w = world(await newTenant());
    const fixture = await seedFixtureDay(w);
    const calendarId = await w.defaultCalendarId();

    const events = await w.events(DAY);

    expect(events.find((event) => event.id === fixture.meeting)).toEqual({
      id: fixture.meeting,
      title: "Meeting with client",
      type: "meeting",
      date: DAY,
      endDate: null,
      timeFrom: "10:00",
      timeTo: "11:30",
      allDay: false,
      place: "Office",
      project: { id: fixture.website, name: "Website", color: "#FF9500" },
      calendarId,
      transcript: { id: fixture.transcript, status: "done" },
    });
    expect(events.find((event) => event.id === fixture.standup)).toEqual({
      id: fixture.standup,
      title: "Standup",
      type: "standup",
      date: DAY,
      endDate: null,
      timeFrom: "09:00",
      // The Events write rule gives a timed Event without an end one that is an hour later.
      timeTo: "10:00",
      allDay: false,
      place: null,
      project: null,
      calendarId,
      transcript: null,
    });
    expect(events.find((event) => event.id === fixture.focus)).toMatchObject({
      project: { id: fixture.deepWork, name: "Deep work", color: null },
      transcript: null,
    });
  });

  it("leaves a Task with a time and a derived birthday entry out of events, although the timeline has both on the day", async () => {
    const w = world(await newTenant());
    const fixture = await seedFixtureDay(w);
    const task = await w.create("tasks", { name: "Send invoice", date: DAY, timeFrom: "08:00" });
    const person = await w.create("people", { name: "Jana Kovářová" });
    // No birthday can be stored or generated yet: `People.birthday` is issue #1795 and the birthday source is
    // issue #1800, which gives its entries a kind of their own. This stand-in is shaped like such an entry as
    // far as today's item type allows: a derived, read-only, all-day entry of the one kind that is not `event`.
    const birthday: CalendarTimelineItem = {
      kind: "task",
      id: `birthday:${person}:2026`,
      databaseId: randomUUID(),
      title: "Birthday - Jana",
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
      updatedAt: "2026-10-16T00:00:00.000Z",
      readOnly: true,
    };
    const tasksSource = CALENDAR_TIMELINE_SOURCES.find((source) => source.id === "tasks");
    if (!tasksSource) throw new Error("No tasks source");
    // Restored by `vi.restoreAllMocks()` in `afterEach`.
    vi.spyOn(tasksSource, "readItems").mockImplementation(async (client, context) => [
      ...(await readTaskTimelineItems(client, context)),
      birthday,
    ]);

    const events = await w.events(DAY);
    const timeline = await w.timelineOf(DAY);

    // Both are on the day for the timeline, so their absence from `events` is the Journal's choice of kind.
    expect(timeline).toContainEqual({ id: task, kind: "task" });
    expect(timeline).toContainEqual({ id: birthday.id, kind: "task" });
    expect(events.map((event) => event.id)).toEqual([
      fixture.conference,
      fixture.standup,
      fixture.meeting,
      fixture.lunch,
      fixture.focus,
    ]);
  });

  it("keeps the timeline's choice and order of Events: a trashed one is out, a multi-day one is in, another day's is out", async () => {
    const w = world(await newTenant());
    const trip = await w.create("events", { name: "Trip", date: "2026-10-15", endDate: "2026-10-17" });
    const onTheDay = await w.create("events", { name: "On the day", date: DAY, timeFrom: "09:00" });
    const trashed = await w.create("events", { name: "Trashed", date: DAY, timeFrom: "10:00" });
    await w.trash("events", trashed);
    await w.create("events", { name: "Next day", date: "2026-10-17", timeFrom: "09:00" });

    const events = await w.events(DAY);

    expect(events.map((event) => [event.id, event.date, event.endDate])).toEqual([
      [trip, "2026-10-15", "2026-10-17"],
      [onTheDay, DAY, null],
    ]);
    expect(events.map((event) => event.id)).toEqual((await w.timelineOf(DAY)).map((item) => item.id));
  });

  it("answers an empty list for a day without events, and no events key for a week, month, quarter or year", async () => {
    const w = world(await newTenant());
    await w.create("events", { name: "Another day", date: "2026-10-17" });

    expect(await w.events(DAY)).toEqual([]);
    for (const [type, period] of [
      ["week", "2026-W42"],
      ["month", "2026-10"],
      ["quarter", "2026-Q4"],
      ["year", "2026"],
    ] as const) {
      expect(await w.readPeriod(type, period), type).not.toHaveProperty("events");
    }
  });

  it("fails a day read with the timeline's error instead of answering without events, and reads no timeline for a week", async () => {
    const w = world(await newTenant());
    const eventsSource = CALENDAR_TIMELINE_SOURCES.find((source) => source.id === "events");
    if (!eventsSource) throw new Error("No events source");
    const failure = new Error("events source failed");
    // Restored by `vi.restoreAllMocks()` in `afterEach`.
    const readItems = vi.spyOn(eventsSource, "readItems").mockRejectedValue(failure);

    await expect(w.readPeriod("day", DAY)).rejects.toBe(failure);
    expect(readItems).toHaveBeenCalledTimes(1);
    expect(await w.readPeriod("week", "2026-W42")).toMatchObject({ type: "week", period: "2026-W42" });
    expect(readItems).toHaveBeenCalledTimes(1);
  });

  it("reads the transcript state with one statement and sends as many statements for six events as for one", async () => {
    const w = world(await newTenant());
    const busyDay = "2026-10-20";
    const project = await w.create("projects", { name: "Project" });
    async function seedDay(date: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const event = await w.create("events", { name: `Event ${index}`, date, timeFrom: "09:00" });
        await w.link("project", event, project);
        await w.link("transcript", event, await w.createTranscript(`Transcript ${index}`, "done"));
      }
    }
    await seedDay(DAY, 1);
    await seedDay(busyDay, 6);

    /** The statements one day read sends and the events it answers. */
    async function read(day: string) {
      const { pool, statements } = observed(dataPool);
      const { events } = dayResponseSchema.parse(await w.readPeriod("day", day, pool));
      return { statements, events };
    }
    /** The statements that select a transcript; only the timeline's transcript lookup names a `transcript_id`. */
    const transcriptReads = (statements: string[]) => statements.filter((sql) => sql.includes("transcript_id")).length;

    const quiet = await read(DAY);
    const busy = await read(busyDay);

    expect(quiet.events.map((event) => [event.project?.id, event.transcript?.status])).toEqual([[project, "done"]]);
    expect(busy.events.map((event) => [event.project?.id, event.transcript?.status])).toEqual(
      Array.from({ length: 6 }, () => [project, "done"]),
    );
    expect(transcriptReads(quiet.statements)).toBe(1);
    expect(transcriptReads(busy.statements)).toBe(1);
    expect(busy.statements.length).toBe(quiet.statements.length);
  });

  it("never answers another tenant's events, projects or transcripts", async () => {
    async function seed(name: string) {
      const w = world(await newTenant());
      const project = await w.create("projects", { name: `${name} project` });
      const event = await w.create("events", { name: `${name} event`, date: DAY, timeFrom: "10:00" });
      const transcript = await w.createTranscript(`${name} transcript`, "done");
      await w.link("project", event, project);
      await w.link("transcript", event, transcript);
      return { w, project, event, transcript };
    }
    const a = await seed("A");
    const b = await seed("B");

    for (const [own, foreign] of [
      [a, b],
      [b, a],
    ] as const) {
      const events = await own.w.events(DAY);
      expect(events.map((event) => [event.id, event.project?.id, event.transcript?.id])).toEqual([
        [own.event, own.project, own.transcript],
      ]);
      const text = JSON.stringify(await own.w.readPeriod("day", DAY));
      for (const id of [foreign.event, foreign.project, foreign.transcript]) expect(text).not.toContain(id);
    }
  });
});
