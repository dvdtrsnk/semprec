import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
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
import { createEventTasksRouteHandler } from "../../tasks/eventTasksRouteHandler.js";
import { createTaskHostEventPutRouteHandler } from "../../tasks/taskHostEventRouteHandlers.js";
import { handleTaskHostEventEndedTask } from "../../tasks/taskHostEventState.js";
import { createMaterializeEventOccurrenceRouteHandler } from "../eventOccurrenceRouteHandlers.js";
import { readCalendarTimeline } from "../timelineRead.js";
import type { CalendarEventOccurrence, CalendarTimelineItem } from "../timelineSources.js";

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

const identity = { user: { id: randomUUID() } };

/** The server clock when the fixtures are written: 10 October 2026, 10:00 in the seeded zone (Europe/Prague, UTC+2). */
const START = "2026-10-10T08:00:00.000Z";

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

/** One tenant's fixture writes and timeline reads, each in that tenant's scope on the runtime-role pool. */
function world(tenant: SeededTenant) {
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant.id, fn);

  async function task(name: string, properties: Record<string, unknown> = {}): Promise<string> {
    const item = await inTenant(() =>
      cp.createItem({ databaseId: tenant.tasksId, properties: { name, date: "2026-10-12", ...properties } }),
    );
    return item.id;
  }

  async function event(name: string, properties: Record<string, unknown> = {}): Promise<string> {
    const item = await inTenant(() =>
      cp.createItem({ databaseId: tenant.eventsId, properties: { name, date: "2026-10-15", ...properties } }),
    );
    return item.id;
  }

  /** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt`. */
  const put = (taskId: string, eventId: string) =>
    inTenant(() => createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }));

  const setStatus = (taskId: string, status: string) =>
    inTenant(() => cp.updateItem({ databaseId: tenant.tasksId, itemId: taskId, propertiesPatch: { status } }));

  /** The delayed job that recomputes a task's stored host state once a host event has ended (issue #1782). */
  const recompute = (taskId: string) => inTenant(() => handleTaskHostEventEndedTask(pool, { taskId }));

  const storedTask = async (taskId: string) => {
    const item = await inTenant(() => cp.getItem(tenant.tasksId, taskId));
    if (!item) throw new Error("Task missing");
    return item;
  };

  /** Overwrites stored properties that no write path produces, with raw SQL on the admin pool inside the tenant. */
  async function storeRaw(databaseId: string, itemId: string, patch: Record<string, unknown>): Promise<void> {
    await withTenantTransaction(admin, tenant.id, async (client) => {
      const result = await client.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
        [databaseId, itemId, JSON.stringify(patch)],
      );
      expect(result.rowCount).toBe(1);
    });
  }

  const read = (from: string, to: string = from, shape: "full" | "compact" = "full") =>
    inTenant(() => withTransaction(pool, (client) => readCalendarTimeline(client, { from, to, shape })));

  /** The stored Events and Tasks of a range in the full shape, without the derived entries. */
  const items = async (from: string, to: string = from) =>
    (await read(from, to)).items.filter(
      (entry): entry is CalendarTimelineItem | CalendarEventOccurrence =>
        entry.kind === "event" || entry.kind === "task",
    );
  const eventItem = async (eventId: string, from: string, to: string = from) => {
    const found = (await items(from, to)).find((entry) => entry.id === eventId);
    if (!found) throw new Error(`Event ${eventId} is not on the timeline`);
    return found;
  };

  /** `GET /api/events/:id/tasks` as the tenant's member sends it. */
  async function getEventTasks(eventId: string) {
    const answer = await inTenant(() => createEventTasksRouteHandler(pool)({ params: { id: eventId } }));
    expect(answer.status).toBe(200);
    return answer.body;
  }

  return {
    tenant,
    task,
    event,
    put,
    setStatus,
    recompute,
    storedTask,
    storeRaw,
    read,
    items,
    eventItem,
    getEventTasks,
    inTenant,
  };
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
  setClock(START);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

const taskIds = (entries: { kind: string; id: string }[]) =>
  entries.filter((entry) => entry.kind === "task").map((entry) => entry.id);

describe("calendar timeline: tasks in events (issue gh-1880)", () => {
  it("shows a task of a running event only inside the event, and from the event's end as an all-day item on its day", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Planning", { timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await w.task("Write agenda");
    await w.put(taskId, eventId);

    // 13:30 in Prague on 15 October (UTC+2).
    setClock("2026-10-15T11:30:00.000Z");
    const running = await w.items("2026-10-15");
    expect(taskIds(running)).toEqual([]);
    const during = await w.eventItem(eventId, "2026-10-15");
    expect(during.tasks).toEqual([{ taskId, title: "Write agenda", state: { kind: "open" } }]);
    expect(during.counts).toEqual({ open: 1, total: 1 });

    // 13:59:59.999: the end is later than now, so the task stays hidden.
    setClock("2026-10-15T11:59:59.999Z");
    expect(taskIds(await w.items("2026-10-15"))).toEqual([]);

    // 14:00: the stored `hiddenUntil` is no longer later than now.
    setClock("2026-10-15T12:00:00.000Z");
    const ended = await w.items("2026-10-15");
    const shown = ended.find((entry) => entry.id === taskId);
    expect(shown).toMatchObject({
      kind: "task",
      title: "Write agenda",
      date: "2026-10-15",
      allDay: true,
      status: "notDone",
      counts: null,
      tasks: null,
      hostEvent: {
        id: eventId,
        title: "Planning",
        ended: true,
        date: "2026-10-15",
        timeFrom: "13:00",
        timeTo: "14:00",
        state: { kind: "missed" },
      },
    });
    expect((await w.eventItem(eventId, "2026-10-15")).tasks).toEqual([
      { taskId, title: "Write agenda", state: { kind: "missed" } },
    ]);
    // The item sits on its display day, not on the task's own date 12 October.
    expect(taskIds(await w.items("2026-10-12"))).toEqual([]);
  });

  it("returns the task on 16 October with the host event and the day stored in effectiveDate", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Planning", { timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await w.task("Write agenda", { date: "2026-10-16" });
    await w.put(taskId, eventId);

    setClock("2026-10-16T08:00:00.000Z");
    await w.recompute(taskId);

    expect((await w.storedTask(taskId)).properties.effectiveDate).toBe("2026-10-16");
    const onSixteenth = (await w.items("2026-10-16")).find((entry) => entry.id === taskId);
    expect(onSixteenth).toMatchObject({
      date: "2026-10-16",
      hostEvent: { id: eventId, ended: true, state: { kind: "missed" } },
    });
    expect(taskIds(await w.items("2026-10-15"))).toEqual([]);
  });

  it("reports moved with the later event's name on the earlier event, and the later event as the host event", async () => {
    const w = world(await seededTenant());
    const first = await w.event("First", { date: "2026-10-15" });
    const second = await w.event("Second", { date: "2026-10-16" });
    const taskId = await w.task("Moving");
    await w.put(taskId, first);
    await w.put(taskId, second);

    // While the later event is running the task stays inside the events.
    setClock("2026-10-16T10:00:00.000Z");
    const during = await w.items("2026-10-15", "2026-10-17");
    expect(taskIds(during)).toEqual([]);
    expect(during.find((entry) => entry.id === first)?.tasks).toEqual([
      { taskId, title: "Moving", state: { kind: "moved", lastEventName: "Second" } },
    ]);
    expect(during.find((entry) => entry.id === second)?.tasks).toEqual([
      { taskId, title: "Moving", state: { kind: "open" } },
    ]);

    setClock("2026-10-17T09:00:00.000Z");
    await w.recompute(taskId);
    const after = await w.items("2026-10-15", "2026-10-17");
    expect(after.find((entry) => entry.id === first)).toMatchObject({
      tasks: [{ taskId, state: { kind: "moved", lastEventName: "Second" } }],
      counts: { open: 0, total: 1 },
    });
    expect(after.find((entry) => entry.id === taskId)).toMatchObject({
      date: "2026-10-16",
      hostEvent: { id: second, title: "Second", ended: true, state: { kind: "missed" } },
    });
  });

  it("keeps the task of a multi-day event hidden while the event runs and shows it after the end", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Offsite", {
      date: "2026-10-25",
      timeFrom: "10:00",
      endDate: "2026-10-26",
      timeTo: "12:00",
    });
    const taskId = await w.task("Pack", { date: "2026-10-26" });
    await w.put(taskId, eventId);

    // 12:00 on the 25th and 10:00 on the 26th in Prague (UTC+1 from the 25th): the event is running.
    for (const now of ["2026-10-25T11:00:00.000Z", "2026-10-26T09:00:00.000Z"]) {
      setClock(now);
      const running = await w.items("2026-10-25", "2026-10-26");
      expect(taskIds(running)).toEqual([]);
      expect(running.find((entry) => entry.id === eventId)?.tasks).toEqual([
        { taskId, title: "Pack", state: { kind: "open" } },
      ]);
    }

    // 13:00 on the 26th: the event has ended.
    setClock("2026-10-26T12:00:00.000Z");
    await w.recompute(taskId);
    expect(await w.items("2026-10-25", "2026-10-26")).toContainEqual(
      expect.objectContaining({ id: taskId, date: "2026-10-26", hostEvent: expect.objectContaining({ ended: true }) }),
    );
  });

  it("keeps the task of an all-day multi-day event hidden until the end of its last day", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Trip", { date: "2026-10-25", endDate: "2026-10-26" });
    const taskId = await w.task("Book", { date: "2026-10-24" });
    await w.put(taskId, eventId);

    // Noon on the 26th in Prague: the last day is not over.
    setClock("2026-10-26T11:00:00.000Z");
    expect(taskIds(await w.items("2026-10-24", "2026-10-27"))).toEqual([]);

    // 00:00 on the 27th in Prague (UTC+1).
    setClock("2026-10-26T23:00:00.000Z");
    await w.recompute(taskId);
    const after = await w.items("2026-10-24", "2026-10-27");
    // The task's own date 24 October is before the event, so the later event day is the display day.
    expect(after.find((entry) => entry.id === taskId)).toMatchObject({
      date: "2026-10-25",
      hostEvent: { id: eventId, ended: true, date: "2026-10-25", state: { kind: "missed" } },
    });
  });

  it("gives an event the tasks and counts that GET /api/events/:id/tasks answers, with every state", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Planning", { timeFrom: "13:00", timeTo: "14:00" });
    const later = await w.event("Later", { date: "2026-10-20" });
    const open = await w.task("Stays");
    const completed = await w.task("Completed inside");
    const moved = await w.task("Moves on");
    for (const id of [open, completed, moved]) await w.put(id, eventId);
    await w.put(moved, later);
    setClock("2026-10-15T11:30:00.000Z");
    await w.setStatus(completed, "done");
    // 14:30: the event has ended; `hiddenUntil` of the completed task is in the past, only its edge keeps it out.
    setClock("2026-10-15T12:30:00.000Z");

    const timeline = await w.items("2026-10-15", "2026-10-20");

    for (const id of [eventId, later]) {
      const route = await w.getEventTasks(id);
      const entry = timeline.find((candidate) => candidate.id === id);
      expect({ tasks: entry?.tasks, counts: entry?.counts }).toEqual({ tasks: route.tasks, counts: route.counts });
    }
    const inEvent = timeline.find((candidate) => candidate.id === eventId);
    // The tasks were put in at the same fixed clock instant, so their order is by id and not asserted here.
    expect(Object.fromEntries((inEvent?.tasks ?? []).map((row) => [row.taskId, row.state.kind]))).toEqual({
      [open]: "missed",
      [completed]: "done",
      [moved]: "moved",
    });
    // The open task is shown on its own; the completed one only inside the event; the moved one waits for `later`.
    expect(taskIds(timeline)).toEqual([open]);
  });

  it("shows a task completed inside an event only inside that event, after the event as well", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Planning", { timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await w.task("Finish here");
    await w.put(taskId, eventId);
    setClock("2026-10-15T11:30:00.000Z");
    await w.setStatus(taskId, "done");

    for (const now of ["2026-10-15T11:45:00.000Z", "2026-10-16T08:00:00.000Z"]) {
      setClock(now);
      const timeline = await w.items("2026-10-15", "2026-10-16");
      expect(taskIds(timeline)).toEqual([]);
      expect(timeline.find((entry) => entry.id === eventId)?.tasks).toEqual([
        { taskId, title: "Finish here", state: { kind: "done" } },
      ]);
    }
  });

  it("returns a task dated 22 October and completed on 16 October on 16 October only, with status done", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Early bird", { date: "2026-10-22" });
    setClock("2026-10-16T10:00:00.000Z");
    await w.setStatus(taskId, "done");

    const sixteenth = (await w.items("2026-10-16")).find((entry) => entry.id === taskId);
    expect(sixteenth).toMatchObject({ date: "2026-10-16", status: "done", hostEvent: null });
    expect(taskIds(await w.items("2026-10-22"))).toEqual([]);
  });

  it("places a task on its occurrenceDate before its completedOn, effectiveDate and date, and on no other of those days", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Recurring instance", { date: "2026-10-12" });
    await w.storeRaw(w.tenant.tasksId, taskId, {
      occurrenceDate: "2026-10-18",
      effectiveDate: "2026-10-14",
      status: "done",
      completedOn: "2026-10-16",
    });

    expect(await w.items("2026-10-18")).toEqual([expect.objectContaining({ id: taskId, date: "2026-10-18" })]);
    for (const day of ["2026-10-12", "2026-10-14", "2026-10-16"]) {
      expect(taskIds(await w.items(day))).toEqual([]);
    }
  });

  it("places a task whose occurrenceDate is empty on its effectiveDate", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Empty occurrence", { date: "2026-10-12" });
    await w.storeRaw(w.tenant.tasksId, taskId, { occurrenceDate: "", effectiveDate: "2026-10-14" });

    expect(await w.items("2026-10-14")).toEqual([expect.objectContaining({ id: taskId, date: "2026-10-14" })]);
    expect(taskIds(await w.items("2026-10-12"))).toEqual([]);
  });

  it("places a done task with an empty or missing completedOn on its effectiveDate, else on its date", async () => {
    const w = world(await seededTenant());
    const emptyCompleted = await w.task("Empty completedOn", { date: "2026-10-12" });
    await w.storeRaw(w.tenant.tasksId, emptyCompleted, {
      status: "done",
      completedOn: "",
      effectiveDate: "2026-10-14",
    });
    const missingCompleted = await w.task("Missing completedOn", { date: "2026-10-12" });
    await w.storeRaw(w.tenant.tasksId, missingCompleted, { status: "done", effectiveDate: "2026-10-14" });
    const onlyDate = await w.task("Only date", { date: "2026-10-13" });
    await w.storeRaw(w.tenant.tasksId, onlyDate, { status: "done", completedOn: "", effectiveDate: "" });

    expect((await w.items("2026-10-14")).map((entry) => entry.id).sort()).toEqual(
      [emptyCompleted, missingCompleted].sort(),
    );
    expect((await w.items("2026-10-14")).every((entry) => entry.date === "2026-10-14")).toBe(true);
    expect(await w.items("2026-10-13")).toEqual([expect.objectContaining({ id: onlyDate, date: "2026-10-13" })]);
    expect(taskIds(await w.items("2026-10-12"))).toEqual([]);
  });

  it("leaves a trashed host event out: a task whose only event is in the Trash is shown on its own day", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Cancelled", { timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await w.task("Freed", { date: "2026-10-15" });
    await w.put(taskId, eventId);
    setClock("2026-10-14T08:00:00.000Z");
    expect(await w.inTenant(() => cp.softDeleteItem(w.tenant.eventsId, eventId))).toBeTruthy();

    const timeline = await w.items("2026-10-15");

    expect(timeline.find((entry) => entry.id === taskId)).toMatchObject({ date: "2026-10-15", hostEvent: null });
    expect(timeline.map((entry) => entry.id)).not.toContain(eventId);
  });

  it("takes the last host event that has a date as the one that decided the day", async () => {
    const w = world(await seededTenant());
    const dated = await w.event("Dated", { date: "2026-10-15" });
    const undated = await w.event("Undated", { date: "2026-10-16" });
    const taskId = await w.task("Two events", { date: "2026-10-10" });
    await w.put(taskId, dated);
    await w.put(taskId, undated);
    await w.storeRaw(w.tenant.eventsId, undated, { date: "" });
    setClock("2026-10-17T08:00:00.000Z");
    await w.recompute(taskId);

    const shown = (await w.items("2026-10-15")).find((entry) => entry.id === taskId);

    expect(shown).toMatchObject({ date: "2026-10-15", hostEvent: { id: dated, title: "Dated" } });
  });

  it("does not hide a task whose stored hiddenUntil is not an instant", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Odd", { date: "2026-10-16" });
    await w.storeRaw(w.tenant.tasksId, taskId, { hiddenUntil: "later" });

    expect(taskIds(await w.items("2026-10-16"))).toEqual([taskId]);
  });

  it("hides a task whose stored hiddenUntil is later than now even when no event is read", async () => {
    const w = world(await seededTenant());
    const taskId = await w.task("Hidden", { date: "2026-10-16" });
    await w.storeRaw(w.tenant.tasksId, taskId, { hiddenUntil: "2026-10-16T12:00:00.000Z" });

    setClock("2026-10-16T11:59:59.999Z");
    expect(taskIds(await w.items("2026-10-16"))).toEqual([]);
    setClock("2026-10-16T12:00:00.000Z");
    expect(taskIds(await w.items("2026-10-16"))).toEqual([taskId]);
  });

  it("gives an Event with no task empty tasks and zero counts, and a Task without a host event a null hostEvent", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Alone");
    const taskId = await w.task("Free", { date: "2026-10-15" });

    const timeline = await w.items("2026-10-15");

    expect(timeline.find((entry) => entry.id === eventId)).toMatchObject({ tasks: [], counts: { open: 0, total: 0 } });
    expect(timeline.find((entry) => entry.id === taskId)).toMatchObject({
      hostEvent: null,
      tasks: null,
      counts: null,
    });
  });

  it("gives every occurrence of a series the tasks of its stored Event, and a changed occurrence its own", async () => {
    const w = world(await seededTenant());
    const series = await w.event("Standup", {
      date: "2026-10-12",
      timeFrom: "09:00",
      timeTo: "09:30",
      recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
    });
    const inSeries = await w.task("Prepare");
    await w.put(inSeries, series);
    const materialized = await w.inTenant(() =>
      createMaterializeEventOccurrenceRouteHandler(pool)({
        params: { seriesId: series, date: "2026-10-14" },
        identity,
      }),
    );
    const occurrenceId = materialized.item.id;
    const inOccurrence = await w.task("Only Wednesday");
    await w.put(inOccurrence, occurrenceId);

    const entries = (await w.items("2026-10-12", "2026-10-16")).filter(
      (entry): entry is CalendarEventOccurrence => "seriesId" in entry,
    );

    const virtual = entries.filter((entry) => !entry.overridden);
    expect(virtual).toHaveLength(4);
    for (const entry of virtual) {
      expect(entry.tasks).toEqual([{ taskId: inSeries, title: "Prepare", state: { kind: "open" } }]);
      expect(entry.counts).toEqual({ open: 1, total: 1 });
    }
    const own = entries.filter((entry) => entry.overridden);
    expect(own.map((entry) => entry.id)).toEqual([occurrenceId]);
    expect(own[0]?.tasks).toEqual([{ taskId: inOccurrence, title: "Only Wednesday", state: { kind: "open" } }]);
  });

  it("returns only the counts of an Event in the compact shape, and null counts for a Task", async () => {
    const w = world(await seededTenant());
    const eventId = await w.event("Planning", { timeFrom: "13:00", timeTo: "14:00" });
    const hosted = await w.task("Hosted");
    await w.put(hosted, eventId);
    const free = await w.task("Free", { date: "2026-10-15" });
    setClock("2026-10-15T11:30:00.000Z");

    const compact = (await w.read("2026-10-15", "2026-10-15", "compact")).items.filter(
      (entry) => entry.kind === "event" || entry.kind === "task",
    );

    expect(compact.map((entry) => [entry.id, "counts" in entry ? entry.counts : undefined])).toEqual(
      expect.arrayContaining([
        [eventId, { open: 1, total: 1 }],
        [free, null],
      ]),
    );
    for (const entry of compact) {
      expect(entry).not.toHaveProperty("tasks");
      expect(entry).not.toHaveProperty("hostEvent");
    }
    expect(taskIds(compact)).toEqual([free]);
  });

  it("reads the task-in-event state with a number of statements that does not depend on the number of events", async () => {
    const w = world(await seededTenant());
    async function hostedEvents(count: number, day: string): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const eventId = await w.event(`Event ${index}`, { date: day, timeFrom: "13:00", timeTo: "14:00" });
        const taskId = await w.task(`Task ${index}`, { date: day });
        await w.put(taskId, eventId);
        // The task also sits in a second event, so a task has more than one host event.
        await w.put(taskId, await w.event(`Second ${index}`, { date: day, timeFrom: "15:00", timeTo: "16:00" }));
      }
    }
    await hostedEvents(1, "2026-10-14");
    await hostedEvents(5, "2026-10-15");
    setClock("2026-10-16T08:00:00.000Z");

    const observe = (day: string) =>
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
          const timeline = await readCalendarTimeline(observed, { from: day, to: day, shape: "full" });
          return { statements, events: timeline.items.filter((entry) => entry.kind === "event").length };
        }),
      );

    const quiet = await observe("2026-10-14");
    const busy = await observe("2026-10-15");

    expect(quiet.events).toBe(2);
    expect(busy.events).toBe(10);
    expect(busy.statements.length).toBe(quiet.statements.length);
  });

  it("never returns another tenant's tasks, events or states", async () => {
    const a = world(await seededTenant());
    const b = world(await seededTenant());
    async function seed(w: ReturnType<typeof world>, name: string) {
      const eventId = await w.event(`${name} event`, { timeFrom: "13:00", timeTo: "14:00" });
      const taskId = await w.task(`${name} task`);
      await w.put(taskId, eventId);
      const freeId = await w.task(`${name} free`, { date: "2026-10-15" });
      return { eventId, taskId, freeId };
    }
    const own = await seed(a, "A");
    const foreign = await seed(b, "B");
    setClock("2026-10-15T12:30:00.000Z");

    const text = JSON.stringify((await a.read("2026-10-01", "2026-10-31")).items);

    for (const id of [own.eventId, own.taskId, own.freeId]) expect(text).toContain(id);
    for (const id of [foreign.eventId, foreign.taskId, foreign.freeId]) expect(text).not.toContain(id);
    expect(text).not.toContain("B task");
    expect((await b.items("2026-10-15")).map((entry) => entry.id).sort()).toEqual(
      [foreign.eventId, foreign.taskId, foreign.freeId].sort(),
    );
  });
});
