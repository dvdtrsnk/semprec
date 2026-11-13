import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID } from "../../seed/sleepModuleKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCalendarAgendaRouteHandler } from "../agendaRouteHandler.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";

// The real read behind a spy, so a test can see which ranges the route asked the timeline for.
vi.mock("../timelineRead.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../timelineRead.js")>();
  return { ...actual, readCalendarTimeline: vi.fn(actual.readCalendarTimeline) };
});

let adminPool: Pool;
let dataPool: Pool;
let tenantId: string;

const USER = { writerKind: "user" } as const;
const FROM = "2026-10-16";

const agendaBodySchema = z
  .object({ items: z.array(z.looseObject({ id: z.string() })), nextCursor: z.string().nullable() })
  .strict();

const timelineBodySchema = z.looseObject({ items: z.array(z.looseObject({ id: z.string() })) });

interface AgendaAnswer {
  ids: string[];
  items: unknown[];
  nextCursor: string | null;
}

/** Calls the handler as the adapter does: inside the tenant's scope, with the request URL. */
async function request(query: string, tenant: string = tenantId): Promise<AgendaAnswer> {
  const result = await runInTenant(tenant, () =>
    createCalendarAgendaRouteHandler(dataPool)({ req: { url: `/api/calendar/agenda${query}` } }),
  );
  expect(result.status).toBe(200);
  // The body as JSON carries it, so a value JSON cannot represent would be noticed.
  const body = agendaBodySchema.parse(JSON.parse(JSON.stringify(result.body)));
  return { ids: body.items.map((item) => item.id), items: body.items, nextCursor: body.nextCursor };
}

/** The query parameter that asks for the page after `answer`. */
function continuing(answer: AgendaAnswer): string {
  if (answer.nextCursor === null) throw new Error("The page has no nextCursor");
  return `&cursor=${answer.nextCursor}`;
}

/**
 * The ids of the pages of one agenda, each page after the first requested with the `nextCursor` of the page
 * before. It stops after `count` pages, or sooner after a page without a `nextCursor`.
 */
async function pages(query: string, count: number): Promise<string[][]> {
  const ids: string[][] = [];
  let cursor = "";
  while (ids.length < count) {
    const answer = await request(`${query}${cursor}`);
    ids.push(answer.ids);
    if (answer.nextCursor === null) break;
    cursor = continuing(answer);
  }
  return ids;
}

/** The ranges read from the timeline since the spy was last cleared, in the order they were read. */
function rangesRead(): string[] {
  return vi.mocked(readCalendarTimeline).mock.calls.map(([, input]) => `${input.from}..${input.to}`);
}

/** A value in the encoding of a `nextCursor`, for the requests that probe what the route accepts as one. */
function cursorOf(text: string): string {
  return Buffer.from(text).toString("base64url");
}

async function create(
  moduleId: "events" | "tasks" | "people" | typeof SLEEP_NIGHTS_MODULE_ID,
  properties: Record<string, unknown>,
  tenant: string = tenantId,
): Promise<string> {
  return runInTenant(tenant, async () => {
    const database = await withTransaction(dataPool, (client) =>
      databasesStore.getDatabaseByModuleId(client, moduleId),
    );
    if (!database) throw new Error(`No ${moduleId} database`);
    const item = await createChokePoint(dataPool).createItem(
      { databaseId: database.id, properties },
      undefined,
      undefined,
      USER,
    );
    return item.id;
  });
}

/** Runs a write of the tenant's Tasks database through the choke point. */
async function inTasks<T>(write: (chokePoint: ReturnType<typeof createChokePoint>, databaseId: string) => Promise<T>) {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, "tasks"));
    if (!database) throw new Error("No tasks database");
    return write(createChokePoint(dataPool), database.id);
  });
}

async function trashTask(itemId: string): Promise<void> {
  await inTasks((chokePoint, databaseId) => chokePoint.softDeleteItem(databaseId, itemId));
}

async function moveTask(itemId: string, date: string): Promise<void> {
  await inTasks((chokePoint, databaseId) =>
    chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { date } }, undefined, undefined, USER),
  );
}

async function newTenant(): Promise<string> {
  const id = await createTestTenant(adminPool);
  await runInTenant(id, () => seedSystem(dataPool));
  return id;
}

describe("GET /api/calendar/agenda (issue #1762)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await newTenant();
    vi.mocked(readCalendarTimeline).mockClear();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("returns the 5 nearest items forward from 16 Oct 2026 with a cursor, and the next page continues without a duplicate or a gap", async () => {
    await create("tasks", { name: "The day before", date: "2026-10-15" });
    // 16 October in the timeline's order inside a day: all-day Event, Task without a time, timed Event, timed Task.
    const allDay = await create("events", { name: "All day", date: FROM });
    const untimedTask = await create("tasks", { name: "Untimed", date: FROM });
    const timedEvent = await create("events", { name: "Timed", date: FROM, timeFrom: "09:00", timeTo: "10:00" });
    const timedTask = await create("tasks", { name: "Timed task", date: FROM, timeFrom: "08:00" });
    // The page of 5 ends in the middle of 17 October.
    const nextDayEvent = await create("events", { name: "Next day", date: "2026-10-17" });
    const nextDayTask = await create("tasks", { name: "Next day task", date: "2026-10-17" });
    // 18 October is empty.
    const later = await create("events", { name: "Later", date: "2026-10-19", timeFrom: "10:00" });
    const earlier = await create("events", { name: "Earlier", date: "2026-10-19", timeFrom: "08:00" });
    // 30 November is in the second window of 31 days.
    const secondWindow = await create("tasks", { name: "Second window", date: "2026-11-30" });

    const first = await request(`?from=${FROM}&direction=forward&limit=5`);

    expect(first.ids).toEqual([allDay, untimedTask, timedEvent, timedTask, nextDayEvent]);

    const second = await request(`?from=${FROM}&direction=forward&limit=5${continuing(first)}`);

    expect(second.ids).toEqual([nextDayTask, earlier, later, secondWindow]);
  });

  it("returns the items in the full shape of the calendar timeline", async () => {
    await create("events", { name: "Standup", date: FROM, timeFrom: "09:00", timeTo: "09:30", place: "Office" });
    await create("tasks", { name: "Pay rent", date: "2026-10-18" });

    const agenda = await request(`?from=${FROM}&direction=forward`);

    const timeline = await runInTenant(tenantId, () =>
      createCalendarTimelineRouteHandler(dataPool)({
        req: { url: `/api/calendar/timeline?from=${FROM}&to=2026-10-18` },
      }),
    );
    // A seeded tenant's timeline also holds its sleep nights, which are not agenda items.
    const expected = timelineBodySchema
      .parse(JSON.parse(JSON.stringify(timeline.body)))
      .items.filter((item) => item.kind === "event" || item.kind === "task");
    expect(expected).toHaveLength(2);
    expect(agenda.items).toEqual(expected);
  });

  it("leaves out the birthdays, holidays and sleep nights of the timeline from every page and from the cursor", async () => {
    // Derived entries on days without a stored item (18 October, a night of 22 October) and on days with one (28 October).
    await create("people", { name: "Jana", birthday: "1990-10-18" });
    await create(SLEEP_NIGHTS_MODULE_ID, { night: "2026-10-22", bedTime: "23:30" });
    const first = await create("events", { name: "First", date: "2026-10-17" });
    const holidayTask = await create("tasks", { name: "On a holiday", date: "2026-10-28" });
    const last = await create("tasks", { name: "Last", date: "2026-11-02" });

    // The range holds all three derived kinds, so their absence below is the route's doing and not an empty fixture.
    const timeline = await runInTenant(tenantId, () =>
      createCalendarTimelineRouteHandler(dataPool)({
        req: { url: `/api/calendar/timeline?from=${FROM}&to=2026-11-02` },
      }),
    );
    const kinds = new Set(
      z
        .looseObject({ items: z.array(z.looseObject({ kind: z.string() })) })
        .parse(JSON.parse(JSON.stringify(timeline.body)))
        .items.map((item) => item.kind),
    );
    expect([...kinds].sort()).toEqual(["birthday", "event", "holiday", "sleep", "task"]);

    const stored = [first, holidayTask, last];
    for (const direction of ["forward", "backward"]) {
      const from = direction === "forward" ? FROM : "2026-11-02";
      const expected = direction === "forward" ? stored : [...stored].reverse();
      const whole = await request(`?from=${from}&direction=${direction}&limit=200`);
      expect(whole.ids).toEqual(expected);
      expect(whole.items.map((item) => (item as { kind: string }).kind).sort()).toEqual(["event", "task", "task"]);

      // One item per page, so every cursor is taken from a page boundary.
      const answers: AgendaAnswer[] = [];
      let cursor = "";
      do {
        const answer = await request(`?from=${from}&direction=${direction}&limit=1${cursor}`);
        answers.push(answer);
        cursor = answer.nextCursor === null ? "" : continuing(answer);
      } while (cursor !== "");
      expect(answers.flatMap((answer) => answer.ids)).toEqual(expected);
      // A page with items ends on its last item, and an empty page names no item: no cursor names a derived entry.
      for (const answer of answers) {
        if (answer.nextCursor === null) continue;
        const [, id] = Buffer.from(answer.nextCursor, "base64url").toString("utf8").split("|");
        expect(id).toBe(answer.ids.at(-1) ?? "");
      }
    }
  });

  it("leaves out the days without an entry", async () => {
    const first = await create("tasks", { name: "First", date: FROM });
    const fifthDay = await create("events", { name: "Fifth day", date: "2026-10-20" });
    const secondWindow = await create("tasks", { name: "Second window", date: "2026-12-01" });

    const answer = await request(`?from=${FROM}&direction=forward`);

    expect(answer.ids).toEqual([first, fifthDay, secondWindow]);
  });

  it("continues in the next window after a full page that ends with the last item of a window", async () => {
    const first = await create("tasks", { name: "First", date: FROM });
    const second = await create("tasks", { name: "Second", date: "2026-10-17" });
    const secondWindow = await create("tasks", { name: "Second window", date: "2026-12-01" });

    expect(await pages(`?from=${FROM}&direction=forward&limit=2`, 2)).toEqual([[first, second], [secondWindow]]);
  });

  it("returns earlier days from the nearest backwards, with the order inside a day unchanged", async () => {
    await create("tasks", { name: "The day after", date: "2026-10-17" });
    const allDay = await create("events", { name: "All day", date: FROM });
    const untimedTask = await create("tasks", { name: "Untimed", date: FROM });
    const timedEvent = await create("events", { name: "Timed", date: FROM, timeFrom: "09:00" });
    const twoDaysBackTask = await create("tasks", { name: "Two days back", date: "2026-10-14" });
    const twoDaysBackEvent = await create("events", { name: "Two days back", date: "2026-10-14", timeFrom: "07:00" });
    const sixDaysBack = await create("events", { name: "Six days back", date: "2026-10-10" });
    // 1 September is in the second window of 31 days going backward.
    const secondWindow = await create("tasks", { name: "Second window", date: "2026-09-01" });

    const first = await request(`?from=${FROM}&direction=backward&limit=4`);

    expect(first.ids).toEqual([allDay, untimedTask, timedEvent, twoDaysBackTask]);

    const second = await request(`?from=${FROM}&direction=backward&limit=4${continuing(first)}`);

    expect(second.ids).toEqual([twoDaysBackEvent, sixDaysBack, secondWindow]);
  });

  it("returns an Event of several days once going forward: on from when it began before, else on its first day", async () => {
    const began = await create("events", { name: "Began before", date: "2026-10-14", endDate: "2026-10-20" });
    const onFrom = await create("tasks", { name: "On from", date: FROM });
    // 10 to 20 November lies across the first two windows, which meet between 15 and 16 November.
    const across = await create("events", { name: "Across windows", date: "2026-11-10", endDate: "2026-11-20" });
    const during = await create("tasks", { name: "During", date: "2026-11-18" });

    expect((await request(`?from=${FROM}&direction=forward`)).ids).toEqual([began, onFrom, across, during]);

    // One item a page, so pages start on days that an Event shown on an earlier page still covers.
    expect(await pages(`?from=${FROM}&direction=forward&limit=1`, 5)).toEqual([
      [began],
      [onFrom],
      [across],
      [during],
      [],
    ]);
  });

  it("returns an Event of several days once going backward: on from when it ends after, else on its last day", async () => {
    const endsAfter = await create("events", { name: "Ends after", date: "2026-10-14", endDate: "2026-10-20" });
    const dayBefore = await create("tasks", { name: "Day before", date: "2026-10-15" });
    // 10 to 20 September lies across the first two windows going backward, which meet between 16 and 15 September.
    const across = await create("events", { name: "Across windows", date: "2026-09-10", endDate: "2026-09-20" });
    const during = await create("tasks", { name: "During", date: "2026-09-12" });

    expect((await request(`?from=${FROM}&direction=backward`)).ids).toEqual([endsAfter, dayBefore, across, during]);
  });

  it("scans 366 days and returns a cursor that continues on the day after", async () => {
    // 16 October 2027 is the 366th day of the scan, 17 October 2027 the first day after it.
    const lastScanned = await create("tasks", { name: "Last scanned day", date: "2027-10-16" });
    const dayAfter = await create("tasks", { name: "Day after the horizon", date: "2027-10-17" });

    const first = await request(`?from=${FROM}&direction=forward`);

    expect(first.ids).toEqual([lastScanned]);

    const second = await request(`?from=${FROM}&direction=forward${continuing(first)}`);

    expect(second.ids).toEqual([dayAfter]);
    expect(second.nextCursor).not.toBeNull();
  });

  it("continues backward from the day before the 366 scanned days", async () => {
    // 16 October 2025 is the 366th day of the backward scan, 15 October 2025 the first day after it.
    const lastScanned = await create("tasks", { name: "Last scanned day", date: "2025-10-16" });
    const dayAfter = await create("tasks", { name: "Day after the horizon", date: "2025-10-15" });

    const first = await request(`?from=${FROM}&direction=backward`);

    expect(first.ids).toEqual([lastScanned]);

    const second = await request(`?from=${FROM}&direction=backward${continuing(first)}`);

    expect(second.ids).toEqual([dayAfter]);
  });

  it("ends five years from from: the last page is full, has no cursor, and nothing after that day is returned", async () => {
    const lastDay = await create("tasks", { name: "Five years on", date: "2031-10-16" });
    await create("tasks", { name: "A day too late", date: "2031-10-17" });

    expect(await pages(`?from=${FROM}&direction=forward&limit=1`, 10)).toEqual([[], [], [], [], [lastDay]]);
  });

  it("returns a cursor on the last day of the agenda while an item of that day is left", async () => {
    const first = await create("tasks", { name: "A first", date: "2031-10-16" });
    const second = await create("tasks", { name: "B second", date: "2031-10-16" });
    const lastDay = `?from=${FROM}&direction=forward&limit=1&cursor=${cursorOf("2031-10-16|")}`;

    const page = await request(lastDay);

    expect(page.ids).toEqual([first]);
    expect(await request(`?from=${FROM}&direction=forward&limit=1${continuing(page)}`)).toMatchObject({
      ids: [second],
      nextCursor: null,
    });
  });

  it("reads the timeline in windows of 31 days and stops reading when the page is full", async () => {
    await create("tasks", { name: "On from", date: FROM });

    await request(`?from=${FROM}&direction=forward&limit=1`);
    expect(rangesRead()).toEqual(["2026-10-16..2026-11-15"]);

    vi.mocked(readCalendarTimeline).mockClear();
    await request(`?from=${FROM}&direction=backward&limit=1`);
    expect(rangesRead()).toEqual(["2026-09-16..2026-10-16"]);
  });

  it("reads 366 days, the last window shorter, when the page does not fill", async () => {
    await request(`?from=${FROM}&direction=forward`);

    expect(rangesRead()).toEqual([
      "2026-10-16..2026-11-15",
      "2026-11-16..2026-12-16",
      "2026-12-17..2027-01-16",
      "2027-01-17..2027-02-16",
      "2027-02-17..2027-03-19",
      "2027-03-20..2027-04-19",
      "2027-04-20..2027-05-20",
      "2027-05-21..2027-06-20",
      "2027-06-21..2027-07-21",
      "2027-07-22..2027-08-21",
      "2027-08-22..2027-09-21",
      "2027-09-22..2027-10-16",
    ]);
  });

  it("ends without a cursor on the last calendar date going forward and on the first going backward", async () => {
    // The sleep source of the timeline cannot resolve a night beside the first or the last calendar date, so the
    // tenant does not show sleep; the agenda lists no sleep night either way.
    await hideSleepInCalendar(dataPool, tenantId);
    expect(await request("?from=9999-12-01&direction=forward")).toEqual({ ids: [], items: [], nextCursor: null });
    expect(await request("?from=9999-12-31&direction=forward")).toEqual({ ids: [], items: [], nextCursor: null });
    expect(await request("?from=0000-01-31&direction=backward")).toEqual({ ids: [], items: [], nextCursor: null });
  });

  it("returns 50 items when no limit is given", async () => {
    const tasks: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      tasks.push(await create("tasks", { name: `Task ${String(index).padStart(2, "0")}`, date: FROM }));
    }

    const first = await request(`?from=${FROM}&direction=forward`);

    expect(first.ids).toEqual(tasks.slice(0, 50));

    const second = await request(`?from=${FROM}&direction=forward${continuing(first)}`);

    expect(second.ids).toEqual(tasks.slice(50));
  });

  it("accepts the limits 1 and 200", async () => {
    const first = await create("tasks", { name: "First", date: FROM });
    const second = await create("tasks", { name: "Second", date: FROM });

    expect((await request(`?from=${FROM}&direction=forward&limit=1`)).ids).toEqual([first]);
    expect((await request(`?from=${FROM}&direction=forward&limit=200`)).ids).toEqual([first, second]);
  });

  it("continues from the next day when the item the cursor names is gone", async () => {
    const first = await create("tasks", { name: "A first", date: FROM });
    const sameDay = await create("tasks", { name: "B same day", date: FROM });
    const nextDay = await create("tasks", { name: "C next day", date: "2026-10-17" });
    const page = await request(`?from=${FROM}&direction=forward&limit=1`);
    expect(page.ids).toEqual([first]);

    // While the item is there, the next page continues after it on its day.
    expect((await request(`?from=${FROM}&direction=forward${continuing(page)}`)).ids).toEqual([sameDay, nextDay]);

    await trashTask(first);

    expect((await request(`?from=${FROM}&direction=forward${continuing(page)}`)).ids).toEqual([nextDay]);
  });

  it("continues from the next day when the item the cursor names moved to a later day", async () => {
    const first = await create("tasks", { name: "A first", date: FROM });
    const nextDay = await create("tasks", { name: "B next day", date: "2026-10-17" });
    const dayAfter = await create("tasks", { name: "C day after", date: "2026-10-18" });
    const page = await request(`?from=${FROM}&direction=forward&limit=1`);
    expect(page.ids).toEqual([first]);

    await moveTask(first, "2026-10-19");

    // The item is in the window the page reads, on another day than the cursor's: nothing before it is left out.
    expect((await request(`?from=${FROM}&direction=forward${continuing(page)}`)).ids).toEqual([
      nextDay,
      dayAfter,
      first,
    ]);
  });

  it("accepts a cursor on from, one on the last day of the agenda and one of 1024 characters", async () => {
    const onFrom = await create("tasks", { name: "On from", date: FROM });
    const nextDay = await create("tasks", { name: "Next day", date: "2026-10-17" });
    const lastDay = await create("tasks", { name: "Five years on", date: "2031-10-16" });

    const fromStart = await request(`?from=${FROM}&direction=forward&limit=1&cursor=${cursorOf(`${FROM}|`)}`);
    expect(fromStart.ids).toEqual([onFrom]);

    const fromEnd = await request(`?from=${FROM}&direction=forward&cursor=${cursorOf("2031-10-16|")}`);
    expect(fromEnd).toMatchObject({ ids: [lastDay], nextCursor: null });

    // 768 bytes are 1024 characters; the id names no item, so the page starts on the next day.
    const longest = cursorOf(`${FROM}|${"x".repeat(757)}`);
    expect(longest).toHaveLength(1024);
    expect((await request(`?from=${FROM}&direction=forward&limit=1&cursor=${longest}`)).ids).toEqual([nextDay]);
  });

  it.each([
    ["a missing from", "?direction=forward", "from"],
    ["a from that is no date", "?from=abc&direction=forward", "from"],
    ["a from that does not exist", "?from=2026-02-30&direction=forward", "from"],
    ["a from with a time", `?from=${FROM}T10:00&direction=forward`, "from"],
    ["no query string", "", "from"],
    ["a missing direction", `?from=${FROM}`, "direction"],
    ["an unknown direction", `?from=${FROM}&direction=sideways`, "direction"],
    ["a direction in another case", `?from=${FROM}&direction=Forward`, "direction"],
    ["the limit 0", `?from=${FROM}&direction=forward&limit=0`, "limit"],
    ["the limit 201", `?from=${FROM}&direction=forward&limit=201`, "limit"],
    ["a limit of four digits", `?from=${FROM}&direction=forward&limit=0050`, "limit"],
    ["a negative limit", `?from=${FROM}&direction=forward&limit=-1`, "limit"],
    ["a limit that is no whole number", `?from=${FROM}&direction=forward&limit=1.5`, "limit"],
    ["a limit that is no number", `?from=${FROM}&direction=forward&limit=abc`, "limit"],
    ["an empty limit", `?from=${FROM}&direction=forward&limit=`, "limit"],
    ["an empty cursor", `?from=${FROM}&direction=forward&cursor=`, "cursor"],
    // Node's decoder would drop the `*` and read the valid cursor around it.
    [
      "a cursor with a character outside base64url",
      `?from=${FROM}&direction=forward&cursor=${cursorOf(`${FROM}|`).replace("MjAy", "MjAy*")}`,
      "cursor",
    ],
    ["a cursor of another shape", `?from=${FROM}&direction=forward&cursor=${cursorOf("garbage")}`, "cursor"],
    ["a cursor without a separator", `?from=${FROM}&direction=forward&cursor=${cursorOf(FROM)}`, "cursor"],
    [
      "a cursor whose day does not exist",
      `?from=${FROM}&direction=forward&cursor=${cursorOf("2026-02-30|")}`,
      "cursor",
    ],
    [
      "a cursor of more than 1024 characters",
      `?from=${FROM}&direction=forward&cursor=${cursorOf(`${FROM}|${"x".repeat(758)}`)}`,
      "cursor",
    ],
    ["a forward cursor before from", `?from=${FROM}&direction=forward&cursor=${cursorOf("2026-10-15|")}`, "cursor"],
    ["a backward cursor after from", `?from=${FROM}&direction=backward&cursor=${cursorOf("2026-10-17|")}`, "cursor"],
    [
      "a forward cursor after the end of the agenda",
      `?from=${FROM}&direction=forward&cursor=${cursorOf("2031-10-17|")}`,
      "cursor",
    ],
    [
      "a backward cursor before the end of the agenda",
      `?from=${FROM}&direction=backward&cursor=${cursorOf("2021-10-15|")}`,
      "cursor",
    ],
  ])("refuses %s with 400 validation_failed", async (_name, query, field) => {
    await expect(request(query)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field },
    });
  });

  it("refuses a request without a URL like one without a query string", async () => {
    await expect(
      runInTenant(tenantId, () => createCalendarAgendaRouteHandler(dataPool)({ req: {} })),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "from" } });
  });

  it("never returns another tenant's items, in either direction", async () => {
    const otherTenantId = await newTenant();
    const own = [
      await create("events", { name: "Own event", date: FROM }),
      await create("tasks", { name: "Own task", date: FROM }),
    ];
    const foreign = [
      await create("events", { name: "Foreign event", date: FROM }, otherTenantId),
      await create("tasks", { name: "Foreign task", date: FROM }, otherTenantId),
    ];

    for (const direction of ["forward", "backward"]) {
      expect((await request(`?from=${FROM}&direction=${direction}`)).ids).toEqual(own);
      // The other tenant's items are on that day for it, so their absence above is isolation and not an empty day.
      expect((await request(`?from=${FROM}&direction=${direction}`, otherTenantId)).ids).toEqual(foreign);
    }
  });

  it("answers a cursor that names another tenant's item like one that names an unknown item", async () => {
    const otherTenantId = await newTenant();
    const foreign = await create("tasks", { name: "Foreign task", date: FROM }, otherTenantId);
    await create("tasks", { name: "Own task", date: FROM });
    const nextDay = await create("tasks", { name: "Own next day", date: "2026-10-17" });
    const query = (id: string): string => `?from=${FROM}&direction=forward&cursor=${cursorOf(`${FROM}|${id}`)}`;

    const foreignAnswer = await request(query(foreign));

    expect(foreignAnswer.ids).toEqual([nextDay]);
    expect(foreignAnswer).toEqual(await request(query(randomUUID())));
  });
});
