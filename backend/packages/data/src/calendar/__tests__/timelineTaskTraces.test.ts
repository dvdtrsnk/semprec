import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { rolloverTaskWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createTaskHostEventPutRouteHandler } from "../../tasks/taskHostEventRouteHandlers.js";
import { logger } from "../logger.js";
import { readCalendarTimeline } from "../timelineRead.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";
import type {
  CalendarTaskTraceOutcome,
  CalendarTaskTraceTimelineItem,
  CalendarTimelineEntry,
  CalendarTimelineItem,
} from "../timelineSources.js";

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

const identity = { user: { id: randomUUID() } };
const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

/** 13 October 2026, 10:00 in the seeded zone (Europe/Prague, UTC+2). */
const ON_THIRTEENTH = "2026-10-13T08:00:00.000Z";
/** 16 October 2026, 10:00 in the seeded zone. */
const ON_SIXTEENTH = "2026-10-16T08:00:00.000Z";
/** 17 October 2026, 10:00 in the seeded zone. */
const ON_SEVENTEENTH = "2026-10-17T08:00:00.000Z";

async function seededTenant(): Promise<SeededTenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
  return runInTenant(id, () =>
    withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
      if (!tasks || !events) throw new Error("Tasks or Events not seeded");
      return { id, tasksId: tasks.id, eventsId: events.id };
    }),
  );
}

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

const isTrace = (entry: CalendarTimelineEntry): entry is CalendarTaskTraceTimelineItem => entry.kind === "trace";
const isTask = (entry: CalendarTimelineEntry): entry is CalendarTimelineItem => entry.kind === "task";

/** The trace the timeline is expected to return. */
function trace(
  taskId: string,
  day: string,
  outcome: CalendarTaskTraceOutcome,
  options: { firstDay?: string; sinceTime?: { from: string | null; to: string | null } | null } = {},
): CalendarTaskTraceTimelineItem {
  return {
    kind: "trace",
    id: `trace:${taskId}:${day}`,
    taskId,
    day,
    firstDay: options.firstDay ?? "2026-10-13",
    sinceTime: options.sinceTime ?? null,
    outcome,
    readOnly: true,
  };
}

const CARRIED: CalendarTaskTraceOutcome = { kind: "carried" };
const TEN_TO_ELEVEN = { from: "10:00", to: "11:00" };

/** One tenant's fixture writes and timeline reads, each in that tenant's scope on the runtime-role pool. */
function world(tenant: SeededTenant) {
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant.id, fn);

  async function task(name: string, properties: Record<string, unknown> = {}): Promise<string> {
    const item = await inTenant(() =>
      cp.createItem({ databaseId: tenant.tasksId, properties: { name, date: "2026-10-13", ...properties } }),
    );
    return item.id;
  }

  async function event(name: string, properties: Record<string, unknown> = {}): Promise<string> {
    const item = await inTenant(() =>
      cp.createItem({ databaseId: tenant.eventsId, properties: { name, date: "2026-10-18", ...properties } }),
    );
    return item.id;
  }

  /**
   * A task planned on 13 October (10:00 to 11:00 unless the properties say otherwise) that the nightly move has carried
   * to 16 October without times: the server clock is left on 16 October.
   */
  async function carriedTask(name: string, properties: Record<string, unknown> = {}): Promise<string> {
    setClock(ON_THIRTEENTH);
    const id = await task(name, { timeFrom: "10:00", timeTo: "11:00", ...properties });
    setClock(ON_SIXTEENTH);
    await inTenant(() =>
      withTransaction(pool, (client) =>
        rolloverTaskWithClient(client, { databaseId: tenant.tasksId, itemId: id, date: "2026-10-16" }),
      ),
    );
    return id;
  }

  const update = (taskId: string, propertiesPatch: Record<string, unknown>) =>
    inTenant(() => cp.updateItem({ databaseId: tenant.tasksId, itemId: taskId, propertiesPatch }));

  const storedTask = async (taskId: string) => {
    const item = await inTenant(() => cp.getItem(tenant.tasksId, taskId));
    if (!item) throw new Error("Task missing");
    return item;
  };

  /** Overwrites stored properties that no write path produces, with raw SQL on the admin pool inside the tenant. */
  async function storeRaw(itemId: string, patch: Record<string, unknown>): Promise<void> {
    await withTenantTransaction(admin, tenant.id, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [tenant.tasksId, itemId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  /** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt`. */
  const put = (taskId: string, eventId: string) =>
    inTenant(() => createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }));

  const read = (from: string, to: string) =>
    inTenant(() => withTransaction(pool, (client) => readCalendarTimeline(client, { from, to, shape: "full" })));

  const readCompact = (from: string, to: string) =>
    inTenant(() => withTransaction(pool, (client) => readCalendarTimeline(client, { from, to, shape: "compact" })));

  /** The entries of a range without the sleep nights, which the seeded sleep plan puts on every day. */
  const entries = async (from: string, to: string) =>
    (await read(from, to)).items.filter((entry) => entry.kind !== "sleep");

  return { tenant, task, event, carriedTask, update, storedTask, storeRaw, put, read, readCompact, entries, inTenant };
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  pool = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("test:role", () =>
    pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  cp = createChokePoint(pool);
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(ON_SIXTEENTH);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("calendar timeline: carry-over and traces (issue gh-1884)", () => {
  it("returns a first-day trace at its time, all-day traces and the live task with carriedFrom", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");
    expect((await w.storedTask(taskId)).properties).toMatchObject({
      date: "2026-10-16",
      since: "2026-10-13",
      sinceTime: TEN_TO_ELEVEN,
    });

    const items = await w.entries("2026-10-13", "2026-10-16");

    expect(items.map((entry) => entry.id)).toEqual([
      `trace:${taskId}:2026-10-13`,
      `trace:${taskId}:2026-10-14`,
      `trace:${taskId}:2026-10-15`,
      taskId,
    ]);
    expect(items.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-13", CARRIED, { sinceTime: TEN_TO_ELEVEN }),
      trace(taskId, "2026-10-14", CARRIED),
      trace(taskId, "2026-10-15", CARRIED),
    ]);
    expect(items.filter(isTask)).toMatchObject([
      { id: taskId, date: "2026-10-16", status: "notDone", allDay: true, carriedFrom: "2026-10-13" },
    ]);
  });

  it("reports outcome doneOn on every trace once the task is done, and carriedFrom only on its completion day", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");
    await w.update(taskId, { status: "done" });
    expect((await w.storedTask(taskId)).properties.completedOn).toBe("2026-10-16");

    const onCompletionDay = await w.entries("2026-10-13", "2026-10-16");

    const done: CalendarTaskTraceOutcome = { kind: "doneOn", date: "2026-10-16" };
    expect(onCompletionDay.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-13", done, { sinceTime: TEN_TO_ELEVEN }),
      trace(taskId, "2026-10-14", done),
      trace(taskId, "2026-10-15", done),
    ]);
    expect(onCompletionDay.filter(isTask)).toMatchObject([
      { id: taskId, date: "2026-10-16", status: "done", carriedFrom: "2026-10-13" },
    ]);

    // The next day the task is done on a day earlier than today: the traces stay, the live entry carries nothing.
    setClock(ON_SEVENTEENTH);
    const nextDay = await w.entries("2026-10-13", "2026-10-17");
    expect(nextDay.filter(isTrace).map((entry) => [entry.day, entry.outcome])).toEqual([
      ["2026-10-13", done],
      ["2026-10-14", done],
      ["2026-10-15", done],
    ]);
    expect(nextDay.filter(isTask)).toMatchObject([{ id: taskId, date: "2026-10-16", carriedFrom: null }]);
  });

  it("keeps since and the traces of 13 to 15 October when the task is moved to 20 October at 9:00", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");
    await w.update(taskId, { date: "2026-10-20", timeFrom: "09:00" });
    expect((await w.storedTask(taskId)).properties).toMatchObject({
      date: "2026-10-20",
      timeFrom: "09:00",
      since: "2026-10-13",
      sinceTime: TEN_TO_ELEVEN,
    });

    const items = await w.entries("2026-10-13", "2026-10-20");

    // Today is 16 October: neither it nor the days up to the new date are traced.
    expect(items.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-13", CARRIED, { sinceTime: TEN_TO_ELEVEN }),
      trace(taskId, "2026-10-14", CARRIED),
      trace(taskId, "2026-10-15", CARRIED),
    ]);
    expect(items.filter(isTask)).toMatchObject([
      { id: taskId, date: "2026-10-20", timeFrom: "09:00", carriedFrom: "2026-10-13" },
    ]);
  });

  it("returns a task dated 20 October and completed on 16 October as done on 16 October, without traces", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Send invoice", { date: "2026-10-20" });
    await w.update(taskId, { status: "done" });
    expect((await w.storedTask(taskId)).properties).toMatchObject({ date: "2026-10-20", completedOn: "2026-10-16" });

    const items = await w.entries("2026-10-13", "2026-10-20");

    expect(items.filter(isTrace)).toEqual([]);
    expect(items.filter(isTask)).toMatchObject([{ id: taskId, date: "2026-10-16", status: "done", carriedFrom: null }]);
    expect((await w.entries("2026-10-20", "2026-10-20")).map((entry) => entry.id)).not.toContain(taskId);
  });

  it("ends the chain of a task planned for 20 October at its completion day, 16 October, not at its planned day", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");
    await w.update(taskId, { date: "2026-10-20", timeFrom: "09:00" });
    await w.update(taskId, { status: "done" });
    expect((await w.storedTask(taskId)).properties).toMatchObject({
      date: "2026-10-20",
      since: "2026-10-13",
      completedOn: "2026-10-16",
    });
    // Two days later 19 October is over, so a chain that ran to the planned day would trace 16, 17 and 18 October too.
    setClock("2026-10-18T08:00:00.000Z");

    const items = await w.entries("2026-10-13", "2026-10-20");

    const done: CalendarTaskTraceOutcome = { kind: "doneOn", date: "2026-10-16" };
    expect(items.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-13", done, { sinceTime: TEN_TO_ELEVEN }),
      trace(taskId, "2026-10-14", done),
      trace(taskId, "2026-10-15", done),
    ]);
    expect(items.filter(isTask)).toMatchObject([{ id: taskId, date: "2026-10-16", status: "done", carriedFrom: null }]);
    expect((await w.entries("2026-10-20", "2026-10-20")).map((entry) => entry.id)).not.toContain(taskId);
  });

  it("returns no trace for a task with a since on or after the day it was completed on, and shows it on that day", async () => {
    const w = world(await seededTenant());
    // Planned for 20 October with a stored since of 18 October, completed on 16 October, before both.
    const early = await w.task("Send invoice", { date: "2026-10-20" });
    await w.storeRaw(early, { since: "2026-10-18" });
    await w.update(early, { status: "done" });
    expect((await w.storedTask(early)).properties).toMatchObject({
      date: "2026-10-20",
      since: "2026-10-18",
      completedOn: "2026-10-16",
    });
    // Today is 17 October, so a since of 15 October is a past day: only the completion day, 14 October, comes before it.
    setClock(ON_SEVENTEENTH);
    const before = await w.task("Book flight", { date: "2026-10-14" });
    await w.storeRaw(before, { since: "2026-10-15", status: "done", completedOn: "2026-10-14" });

    const items = await w.entries("2026-10-13", "2026-10-20");

    expect(items.filter(isTrace)).toEqual([]);
    expect(items.filter(isTask)).toMatchObject([
      { id: before, date: "2026-10-14", status: "done", carriedFrom: null },
      { id: early, date: "2026-10-16", status: "done", carriedFrom: null },
    ]);
    expect((await w.entries("2026-10-20", "2026-10-20")).map((entry) => entry.id)).not.toContain(early);
  });

  it("omits the days outside the range and returns firstDay in full, with sinceTime on the first day only", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");

    const middle = (await w.entries("2026-10-14", "2026-10-15")).filter(isTrace);
    expect(middle).toEqual([trace(taskId, "2026-10-14", CARRIED), trace(taskId, "2026-10-15", CARRIED)]);

    const first = (await w.entries("2026-10-13", "2026-10-13")).filter(isTrace);
    expect(first).toEqual([trace(taskId, "2026-10-13", CARRIED, { sinceTime: TEN_TO_ELEVEN })]);

    const last = (await w.entries("2026-10-15", "2026-10-30")).filter(isTrace);
    expect(last).toEqual([trace(taskId, "2026-10-15", CARRIED)]);

    expect((await w.entries("2026-10-01", "2026-10-12")).filter(isTrace)).toEqual([]);
  });

  it("traces no day that is not over: nothing for today or later days", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");

    expect((await w.entries("2026-10-16", "2026-10-20")).filter(isTrace)).toEqual([]);
    expect((await w.entries("2026-10-17", "2026-10-20")).filter(isTrace)).toEqual([]);
    // One day earlier the same task has traces, so the empty answers above are about the range.
    expect((await w.entries("2026-10-15", "2026-10-15")).filter(isTrace).map((entry) => entry.taskId)).toEqual([
      taskId,
    ]);
  });

  it("gives a task without times a first-day trace without sinceTime, and keeps a lone start time", async () => {
    const w = world(await seededTenant());
    const allDay = await w.carriedTask("All day", { timeFrom: null, timeTo: null });
    const startOnly = await w.carriedTask("Start only", { timeFrom: "08:00", timeTo: null });

    const items = (await w.entries("2026-10-13", "2026-10-13")).filter(isTrace);

    expect(items).toContainEqual(trace(allDay, "2026-10-13", CARRIED, { sinceTime: null }));
    expect(items).toContainEqual(trace(startOnly, "2026-10-13", CARRIED, { sinceTime: { from: "08:00", to: null } }));
    expect(items).toHaveLength(2);
  });

  it("reports outcome movedToEvent with the host event of a task that sits in an event", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Prepare slides");
    const eventId = await w.event("Workshop", { date: "2026-10-18", timeFrom: "13:00", timeTo: "14:00" });
    await w.put(taskId, eventId);

    const items = await w.entries("2026-10-13", "2026-10-18");

    const moved: CalendarTaskTraceOutcome = { kind: "movedToEvent", id: eventId, title: "Workshop" };
    expect(items.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-13", moved, { sinceTime: TEN_TO_ELEVEN }),
      trace(taskId, "2026-10-14", moved),
      trace(taskId, "2026-10-15", moved),
    ]);
  });

  it("uses the host event the task was added to last when it sits in several", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Prepare slides");
    await w.put(taskId, await w.event("Early", { date: "2026-10-17", timeFrom: "09:00", timeTo: "10:00" }));
    const later = await w.event("Late", { date: "2026-10-19", timeFrom: "09:00", timeTo: "10:00" });
    await w.put(taskId, later);

    const outcomes = (await w.entries("2026-10-15", "2026-10-15")).filter(isTrace).map((entry) => entry.outcome);

    expect(outcomes).toEqual([{ kind: "movedToEvent", id: later, title: "Late" }]);
  });

  it("reports outcome missed for a task whose status is missed", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Water plants");
    await w.update(taskId, { status: "missed" });

    const items = await w.entries("2026-10-14", "2026-10-15");

    expect(items.filter(isTrace)).toEqual([
      trace(taskId, "2026-10-14", { kind: "missed" }),
      trace(taskId, "2026-10-15", { kind: "missed" }),
    ]);
  });

  it("returns no trace for a task that will not be done, a trashed task or a task without since", async () => {
    const w = world(await seededTenant());
    const wontDo = await w.carriedTask("Dropped");
    await w.update(wontDo, { status: "wontDo" });
    const trashed = await w.carriedTask("Trashed");
    await w.inTenant(() => cp.softDeleteItem(w.tenant.tasksId, trashed));
    await w.carriedTask("Kept");
    setClock(ON_SEVENTEENTH);
    const plain = await w.task("Never moved", { date: "2026-10-14" });

    const items = await w.entries("2026-10-13", "2026-10-17");

    expect(new Set(items.filter(isTrace).map((entry) => entry.taskId)).size).toBe(1);
    expect(items.filter(isTrace).map((entry) => entry.taskId)).not.toContain(wontDo);
    expect(items.filter(isTrace).map((entry) => entry.taskId)).not.toContain(trashed);
    expect(items.filter(isTrace).map((entry) => entry.taskId)).not.toContain(plain);
    expect(items.map((entry) => entry.id)).toContain(plain);
  });

  it("ends the chain of a task at its occurrence day, which is the day it is displayed on", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Stretch");
    // No write path gives a one-off carried task a series; the stored values are those of a recurring occurrence.
    await w.storeRaw(taskId, { seriesId: randomUUID(), occurrenceDate: "2026-10-15" });

    const days = (await w.entries("2026-10-13", "2026-10-16")).filter(isTrace).map((entry) => entry.day);

    expect(days).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("places a trace among the entries of its day like a task at the time it had", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");
    setClock(ON_THIRTEENTH);
    const earlyEvent = await w.event("Early event", { date: "2026-10-13", timeFrom: "09:00", timeTo: "09:30" });
    const lateTask = await w.task("Late task", { date: "2026-10-13", timeFrom: "10:30", timeTo: "11:00" });
    const allDayEvent = await w.event("All-day event", { date: "2026-10-14" });
    const allDayTask = await w.task("All-day task", { date: "2026-10-14" });
    setClock(ON_SIXTEENTH);

    const items = await w.entries("2026-10-13", "2026-10-14");

    expect(items.map((entry) => entry.id)).toEqual([
      earlyEvent,
      `trace:${taskId}:2026-10-13`,
      lateTask,
      allDayEvent,
      `trace:${taskId}:2026-10-14`,
      allDayTask,
    ]);
  });

  it("leaves out a task whose stored since or sinceTime is not valid, logs its id and returns the others", async () => {
    const w = world(await seededTenant());
    const valid = await w.carriedTask("Valid");
    const brokenSince = await w.carriedTask("Broken since");
    await w.storeRaw(brokenSince, { since: "13 October" });
    const brokenTime = await w.carriedTask("Broken time");
    await w.storeRaw(brokenTime, { sinceTime: { from: "noon", to: null } });
    const brokenShape = await w.carriedTask("Broken shape");
    await w.storeRaw(brokenShape, { sinceTime: ["10:00"] });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const items = await w.entries("2026-10-14", "2026-10-14");

    expect(items.filter(isTrace).map((entry) => entry.taskId)).toEqual([valid]);
    const logged = warn.mock.calls.map(([fields]) => fields);
    expect(logged).toHaveLength(3);
    expect(logged).toContainEqual({ itemId: brokenSince, databaseId: w.tenant.tasksId, property: "since" });
    expect(logged).toContainEqual({ itemId: brokenTime, databaseId: w.tenant.tasksId, property: "sinceTime" });
    expect(logged).toContainEqual({ itemId: brokenShape, databaseId: w.tenant.tasksId, property: "sinceTime" });
    for (const call of warn.mock.calls) expect(call[1]).toBe(SKIP_MESSAGE);
  });

  it("leaves out a done task without a completion day, logs it, and skips a task whose display day is unreadable", async () => {
    const w = world(await seededTenant());
    const noCompletion = await w.carriedTask("No completion day");
    await w.storeRaw(noCompletion, { status: "done", completedOn: null });
    const noDisplayDay = await w.carriedTask("No display day");
    await w.storeRaw(noDisplayDay, { date: "soon", effectiveDate: null });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const items = await w.entries("2026-10-14", "2026-10-14");

    expect(items.filter(isTrace)).toEqual([]);
    expect(warn.mock.calls.map(([fields]) => fields)).toContainEqual({
      itemId: noCompletion,
      databaseId: w.tenant.tasksId,
      property: "completedOn",
    });
    // The core Tasks source logs the unreadable display day; the trace source adds no line for it.
    expect(warn.mock.calls.filter(([fields]) => (fields as { itemId?: string }).itemId === noDisplayDay)).toHaveLength(
      1,
    );
  });

  it("logs a task whose display day starts with a day but is not a calendar date, although it lies outside the range", async () => {
    const w = world(await seededTenant());
    const valid = await w.carriedTask("Valid");
    const withTime = await w.carriedTask("Display day with a time");
    await w.storeRaw(withTime, { date: "2026-10-20T09:00", effectiveDate: null });
    const impossible = await w.carriedTask("Display day that does not exist");
    await w.storeRaw(impossible, { date: "2026-13-45", effectiveDate: null });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Neither stored day is inside 13 to 16 October, so the core Tasks source selects neither Task.
    const items = await w.entries("2026-10-13", "2026-10-16");

    expect(items.filter(isTrace).map((entry) => entry.taskId)).toEqual([valid, valid, valid]);
    const logged = warn.mock.calls.map(([fields]) => fields);
    expect(logged).toHaveLength(2);
    expect(logged).toContainEqual({ itemId: withTime, databaseId: w.tenant.tasksId, property: "date" });
    expect(logged).toContainEqual({ itemId: impossible, databaseId: w.tenant.tasksId, property: "date" });
    for (const call of warn.mock.calls) expect(call[1]).toBe(SKIP_MESSAGE);
  });

  it("returns traces in the compact shape as they are, and the live task without carriedFrom", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");

    const full = await w.read("2026-10-13", "2026-10-16");
    const compact = await w.readCompact("2026-10-13", "2026-10-16");

    expect(compact.items.filter((entry) => entry.kind === "trace")).toEqual(full.items.filter(isTrace));
    const live = compact.items.find((entry) => entry.id === taskId);
    expect(live).toMatchObject({ kind: "task", date: "2026-10-16" });
    expect(live).not.toHaveProperty("carriedFrom");
  });

  it("answers GET /api/calendar/timeline with the traces and carriedFrom as JSON", async () => {
    const w = world(await seededTenant());
    const taskId = await w.carriedTask("Pay rent");

    const answer = await w.inTenant(() =>
      createCalendarTimelineRouteHandler(pool)({
        req: { url: "/api/calendar/timeline?from=2026-10-13&to=2026-10-16" },
      }),
    );

    expect(answer.status).toBe(200);
    const body = z
      .object({ today: z.string(), items: z.array(z.object({ kind: z.string() }).passthrough()) })
      .parse(JSON.parse(JSON.stringify(answer.body)));
    expect(body.today).toBe("2026-10-16");
    expect(body.items.filter((entry) => entry.kind !== "sleep")).toMatchObject([
      { kind: "trace", taskId, day: "2026-10-13", firstDay: "2026-10-13", sinceTime: TEN_TO_ELEVEN },
      { kind: "trace", taskId, day: "2026-10-14", firstDay: "2026-10-13", sinceTime: null },
      { kind: "trace", taskId, day: "2026-10-15", firstDay: "2026-10-13", sinceTime: null },
      { kind: "task", id: taskId, carriedFrom: "2026-10-13" },
    ]);
  });

  it("reads the traces with a number of statements that does not depend on the number of tasks", async () => {
    const w = world(await seededTenant());
    async function hostedCarriedTask(index: number): Promise<void> {
      const taskId = await w.carriedTask(`Task ${index}`);
      await w.put(taskId, await w.event(`Event ${index}`, { date: "2026-10-18" }));
    }
    const observe = () =>
      w.inTenant(() =>
        withTransaction(pool, async (client) => {
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
          const timeline = await readCalendarTimeline(observed, {
            from: "2026-10-13",
            to: "2026-10-18",
            shape: "full",
          });
          return { statements, traced: new Set(timeline.items.filter(isTrace).map((entry) => entry.taskId)).size };
        }),
      );
    await hostedCarriedTask(0);
    const quiet = await observe();
    for (let index = 1; index < 10; index += 1) await hostedCarriedTask(index);
    const busy = await observe();

    expect(quiet.traced).toBe(1);
    expect(busy.traced).toBe(10);
    expect(busy.statements.length).toBe(quiet.statements.length);
  });

  it("never returns another tenant's traces", async () => {
    const a = world(await seededTenant());
    const b = world(await seededTenant());
    const aTask = await a.carriedTask("A task");
    const bTask = await b.carriedTask("B task");

    const fromA = (await a.entries("2026-10-13", "2026-10-16")).filter(isTrace);
    const fromB = (await b.entries("2026-10-13", "2026-10-16")).filter(isTrace);

    expect(new Set(fromA.map((entry) => entry.taskId))).toEqual(new Set([aTask]));
    expect(new Set(fromB.map((entry) => entry.taskId))).toEqual(new Set([bTask]));
    expect(fromA).toHaveLength(3);
    expect(fromB).toHaveLength(3);
  });
});
