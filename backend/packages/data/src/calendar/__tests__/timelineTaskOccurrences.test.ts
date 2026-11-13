import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { PROJECTS_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { closeMissedOccurrence } from "../../tasks/closeMissedOccurrences.js";
import { createTaskOccurrenceMaterializeRouteHandler } from "../../tasks/taskOccurrenceRoutes.js";
import type { TaskRecurrenceRule } from "../../tasks/taskRecurrenceRule.js";
import {
  deactivateTaskRecurrenceSeries,
  deleteTaskRecurrence,
  getTaskRecurrenceBySeriesId,
  restartTaskRecurrence,
} from "../../tasks/taskRecurrenceStore.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { logger } from "../logger.js";
import { readCalendarTimeline, readTaskTimelineItems } from "../timelineRead.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";
import type { CalendarTaskOccurrence, CalendarTimelineContext, CalendarTimelineEntry } from "../timelineSources.js";
import { readTaskOccurrenceTimelineItems } from "../timelineTaskOccurrenceSource.js";

interface SeededTenant {
  id: string;
  tasksId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

const identity = { user: { id: randomUUID() } };
const daily: TaskRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };
const TEMPLATE_MESSAGE = "Calendar timeline left out a task occurrence with an invalid template value";

/** 10:00 in the seeded zone (Europe/Prague, UTC+2 until 25 October 2026) on the given day of October 2026. */
const at = (day: number): string => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`;

async function seededTenant(): Promise<SeededTenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
  return runInTenant(id, () =>
    withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      if (!tasks) throw new Error("Tasks not seeded");
      return { id, tasksId: tasks.id };
    }),
  );
}

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

const isOccurrence = (entry: CalendarTimelineEntry): entry is CalendarTaskOccurrence =>
  entry.kind === "task" && "seriesId" in entry;

/** What an occurrence entry shows of itself in the assertions. */
function glance(entry: CalendarTaskOccurrence) {
  return {
    date: entry.date,
    occurrenceDate: entry.occurrenceDate,
    timeFrom: entry.timeFrom,
    timeTo: entry.timeTo,
    status: entry.status,
    done: entry.done,
    overridden: entry.overridden,
    readOnly: entry.readOnly,
  };
}

/** One tenant's fixture writes and timeline reads, each in that tenant's scope on the runtime-role pool. */
function world(tenant: SeededTenant) {
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant.id, fn);

  const create = (moduleId: string, properties: Record<string, unknown>): Promise<string> =>
    inTenant(() =>
      withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) throw new Error(`No ${moduleId} database`);
        return (await cp.createItem({ databaseId: database.id, properties })).id;
      }),
    );

  /**
   * A daily task from 12 October 2026 with the given properties (7:00 to 7:15 unless they say otherwise), made the
   * current occurrence of a new series on 12 October. Returns the series id and the id of that first occurrence.
   */
  async function startDaily(
    name: string,
    options: {
      properties?: Record<string, unknown>;
      template?: Parameters<typeof startTaskSeries>[1]["template"];
    } = {},
  ): Promise<{ seriesId: string; firstId: string }> {
    setClock(at(12));
    const first = await inTenant(() =>
      cp.createItem({
        databaseId: tenant.tasksId,
        properties: { name, date: "2026-10-12", timeFrom: "07:00", timeTo: "07:15", ...options.properties },
      }),
    );
    const seriesId = await inTenant(() =>
      startTaskSeries(pool, {
        databaseId: tenant.tasksId,
        itemId: first.id,
        mode: "fixed",
        rule: daily,
        template: options.template,
      }),
    );
    return { seriesId, firstId: first.id };
  }

  /** The id of the stored occurrence of `seriesId` on `date`, or `null` when none is stored. */
  const occurrenceItemId = (seriesId: string, date: string): Promise<string | null> =>
    inTenant(() =>
      withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL
              AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3`,
          [tenant.tasksId, seriesId, date],
        );
        return rows[0]?.id ?? null;
      }),
    );

  /** Completes the stored occurrence of `date` on that day, which stores the next occurrence of the series. */
  async function completeOn(seriesId: string, date: string, day: number): Promise<void> {
    setClock(at(day));
    const itemId = await occurrenceItemId(seriesId, date);
    if (itemId === null) throw new Error(`No stored occurrence on ${date}`);
    await inTenant(() => cp.updateItem({ databaseId: tenant.tasksId, itemId, propertiesPatch: { status: "done" } }));
  }

  /** The nightly close of the stored occurrence of `date` on the evening of `today`: the occurrence becomes missed. */
  async function closeMissed(seriesId: string, date: string, today: string): Promise<void> {
    const itemId = await occurrenceItemId(seriesId, date);
    if (itemId === null) throw new Error(`No stored occurrence on ${date}`);
    await inTenant(() =>
      withTransaction(pool, (client) => closeMissedOccurrence(client, tenant.tasksId, itemId, today)),
    );
  }

  /** The route of issue #1720: materializes the occurrence of `date` and writes `body` to it. */
  const writeOccurrence = (seriesId: string, date: string, body: Record<string, unknown>) =>
    inTenant(() => createTaskOccurrenceMaterializeRouteHandler(pool)({ params: { seriesId, date }, body, identity }));

  /**
   * Turns the series off and starts the next one in the same row, as `PUT /api/tasks/:id/recurrence` does for a task
   * whose recurrence was turned off: the row takes a new `series_id` anchored on `anchorDate`, and the series' current
   * Task takes it too, while the stored occurrences of the old series keep theirs. Returns the new series id.
   */
  const restartSeries = (seriesId: string, anchorDate: string): Promise<string> =>
    inTenant(() =>
      withTransaction(pool, async (client) => {
        const old = await getTaskRecurrenceBySeriesId(client, seriesId, true);
        if (old === null || old.template === null) throw new Error(`No series ${seriesId}`);
        await deactivateTaskRecurrenceSeries(client, seriesId);
        const next = await restartTaskRecurrence(client, {
          itemId: old.itemId,
          mode: old.mode,
          rule: old.rule,
          anchorDate,
          template: old.template,
        });
        if (next.seriesId === null) throw new Error("restartTaskRecurrence returned no series");
        await updateItemWithClient(
          client,
          {
            databaseId: tenant.tasksId,
            itemId: old.itemId,
            propertiesPatch: { seriesId: next.seriesId, occurrenceDate: anchorDate },
          },
          { allowedSystemKeys: ["seriesId", "occurrenceDate"], systemOwnerProcess: TASKS_MODULE_ID },
        );
        return next.seriesId;
      }),
    );

  /** Removes the series row of `itemId` as the purge of its trashed item does, and leaves the stored occurrences. */
  const deleteSeriesRow = (itemId: string): Promise<void> =>
    inTenant(() => withTransaction(pool, (client) => deleteTaskRecurrence(client, itemId)));

  const link = (taskId: string, key: "project" | "people", targetId: string) =>
    inTenant(async () => {
      const property = (await cp.listProperties(tenant.tasksId)).find((entry) => entry.key === key);
      if (!property) throw new Error(`No tasks.${key}`);
      return cp.createRelation({ relationPropertyId: property.id, callerItemId: taskId, targetItemId: targetId });
    });

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

  const read = (from: string, to: string) =>
    inTenant(() => withTransaction(pool, (client) => readCalendarTimeline(client, { from, to, shape: "full" })));

  const readCompact = (from: string, to: string) =>
    inTenant(() => withTransaction(pool, (client) => readCalendarTimeline(client, { from, to, shape: "compact" })));

  /** The entries of a range without the sleep nights, which the seeded sleep plan puts on every day. */
  const entries = async (from: string, to: string) =>
    (await read(from, to)).items.filter((entry) => entry.kind !== "sleep");

  /** The occurrences of a range, in the order of the timeline. */
  const occurrences = async (from: string, to: string) => (await entries(from, to)).filter(isOccurrence);

  return {
    tenant,
    create,
    startDaily,
    occurrenceItemId,
    completeOn,
    closeMissed,
    writeOccurrence,
    restartSeries,
    deleteSeriesRow,
    link,
    storeRaw,
    read,
    readCompact,
    entries,
    occurrences,
    inTenant,
  };
}

/**
 * "Stretch 10 min", daily at 7:00 to 7:15 from 12 October 2026, done on 12, 13 and 14 October and not done on 15
 * October, which the nightly close marked missed on the evening of 15 October. The clock is left on 16 October.
 */
async function stretchFixture(w: ReturnType<typeof world>) {
  const { seriesId, firstId } = await w.startDaily("Stretch 10 min");
  await w.completeOn(seriesId, "2026-10-12", 12);
  await w.completeOn(seriesId, "2026-10-13", 13);
  await w.completeOn(seriesId, "2026-10-14", 14);
  setClock(at(16));
  await w.closeMissed(seriesId, "2026-10-15", "2026-10-16");
  return { seriesId, firstId };
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
  setClock(at(16));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("calendar timeline: recurring task occurrences (issue gh-1886)", () => {
  it("returns five occurrences 7:00 to 7:15 for 12 to 16 October, the first three done, and no carry-over of the missed one", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);

    const result = await w.entries("2026-10-12", "2026-10-16");

    const found = result.filter(isOccurrence);
    expect(found.map(glance)).toEqual([
      {
        date: "2026-10-12",
        occurrenceDate: "2026-10-12",
        timeFrom: "07:00",
        timeTo: "07:15",
        status: "done",
        done: true,
        overridden: true,
        readOnly: false,
      },
      {
        date: "2026-10-13",
        occurrenceDate: "2026-10-13",
        timeFrom: "07:00",
        timeTo: "07:15",
        status: "done",
        done: true,
        overridden: true,
        readOnly: false,
      },
      {
        date: "2026-10-14",
        occurrenceDate: "2026-10-14",
        timeFrom: "07:00",
        timeTo: "07:15",
        status: "done",
        done: true,
        overridden: true,
        readOnly: false,
      },
      {
        date: "2026-10-15",
        occurrenceDate: "2026-10-15",
        timeFrom: "07:00",
        timeTo: "07:15",
        status: "missed",
        done: false,
        overridden: true,
        readOnly: false,
      },
      {
        date: "2026-10-16",
        occurrenceDate: "2026-10-16",
        timeFrom: "07:00",
        timeTo: "07:15",
        status: "notDone",
        done: false,
        overridden: true,
        readOnly: false,
      },
    ]);
    for (const entry of found) {
      expect(entry).toMatchObject({
        kind: "task",
        seriesId,
        title: "Stretch 10 min",
        effectiveTo: "07:15",
        allDay: false,
      });
    }
    // The missed occurrence stays on 15 October: nothing is carried onto 16 October, and nothing is a trace.
    expect(result.map((entry) => entry.kind)).toEqual(["task", "task", "task", "task", "task"]);
    expect(found.filter((entry) => entry.date === "2026-10-16").map((entry) => entry.occurrenceDate)).toEqual([
      "2026-10-16",
    ]);
    expect(found.map((entry) => entry.carriedFrom)).toEqual([null, null, null, null, null]);
  });

  it("changes only the entry of the moved occurrence when the 16 October occurrence is moved to 8:00", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const before = await w.occurrences("2026-10-12", "2026-10-18");

    await w.writeOccurrence(seriesId, "2026-10-16", { timeFrom: "08:00", timeTo: "08:15" });
    const after = await w.occurrences("2026-10-12", "2026-10-18");

    expect(after).toHaveLength(7);
    expect(after.map((entry) => entry.occurrenceDate)).toEqual(before.map((entry) => entry.occurrenceDate));
    const changed = after.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]));
    expect(changed.map((entry) => entry.occurrenceDate)).toEqual(["2026-10-16"]);
    expect(changed[0]).toMatchObject({ timeFrom: "08:00", timeTo: "08:15", effectiveTo: "08:15", overridden: true });
    expect(after.find((entry) => entry.occurrenceDate === "2026-10-17")).toMatchObject({
      id: `${seriesId}@2026-10-17`,
      timeFrom: "07:00",
      timeTo: "07:15",
      overridden: false,
    });
  });

  it("returns the virtual 17 October occurrence as it is and a moved virtual occurrence as the item the move stored", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);

    const virtual = (await w.occurrences("2026-10-17", "2026-10-17"))[0];
    expect(virtual).toMatchObject({
      kind: "task",
      id: `${seriesId}@2026-10-17`,
      seriesId,
      occurrenceDate: "2026-10-17",
      date: "2026-10-17",
      title: "Stretch 10 min",
      status: "notDone",
      done: false,
      overridden: false,
      readOnly: true,
      timeFrom: "07:00",
      timeTo: "07:15",
      effectiveTo: "07:15",
      hasEnd: true,
      allDay: false,
      project: null,
      people: [],
      hostEvent: null,
      carriedFrom: null,
    });
    const tasksCalendar = await w.inTenant(() =>
      withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE properties->>'systemKey' = 'tasks' AND deleted_at IS NULL",
        );
        return rows[0]?.id ?? null;
      }),
    );
    expect(tasksCalendar).not.toBeNull();
    expect(virtual?.calendarId).toBe(tasksCalendar);

    await w.writeOccurrence(seriesId, "2026-10-17", { timeFrom: "08:00", timeTo: "08:15" });
    const moved = (await w.occurrences("2026-10-17", "2026-10-17"))[0];
    const storedId = await w.occurrenceItemId(seriesId, "2026-10-17");
    expect(storedId).not.toBeNull();
    expect(moved).toMatchObject({ id: storedId, timeFrom: "08:00", overridden: true, readOnly: false });
  });

  it("shows a past virtual occurrence as missed on its own day and carries it nowhere", async () => {
    const w = world(await seededTenant());
    await w.startDaily("Stretch 10 min");
    setClock(at(16));

    const result = await w.entries("2026-10-12", "2026-10-17");

    const found = result.filter(isOccurrence);
    expect(found.map((entry) => [entry.occurrenceDate, entry.date, entry.status, entry.overridden])).toEqual([
      ["2026-10-12", "2026-10-12", "notDone", true],
      ["2026-10-13", "2026-10-13", "missed", false],
      ["2026-10-14", "2026-10-14", "missed", false],
      ["2026-10-15", "2026-10-15", "missed", false],
      ["2026-10-16", "2026-10-16", "notDone", false],
      ["2026-10-17", "2026-10-17", "notDone", false],
    ]);
    expect(result.filter((entry) => entry.kind === "trace" && entry.day >= "2026-10-13")).toEqual([]);
  });

  it("returns the series row once, as an occurrence, and no other Task row of its series", async () => {
    const w = world(await seededTenant());
    const { seriesId, firstId } = await stretchFixture(w);
    const currentId = await w.occurrenceItemId(seriesId, "2026-10-16");

    const result = await w.entries("2026-10-12", "2026-10-18");

    expect(result.map((entry) => entry.id)).toHaveLength(new Set(result.map((entry) => entry.id)).size);
    expect(result.filter((entry) => entry.id === firstId)).toHaveLength(1);
    expect(result.filter((entry) => entry.id === currentId)).toHaveLength(1);
    expect(result.filter(isOccurrence)).toHaveLength(7);
    expect(result).toHaveLength(7);
    // The core Tasks source returns none of them.
    const core = await w.inTenant(() =>
      withTransaction(pool, async (client) => {
        const context: CalendarTimelineContext = {
          from: "2026-10-12",
          to: "2026-10-18",
          timezone: "Europe/Prague",
          today: "2026-10-16",
          now: { date: "2026-10-16", time: "10:00" },
          at: new Date(at(16)),
        };
        return readTaskTimelineItems(client, context);
      }),
    );
    expect(core).toEqual([]);
  });

  it("keeps the done occurrences of a series that was turned off and started again, once each, next to the new series", async () => {
    const w = world(await seededTenant());
    const { seriesId, firstId } = await w.startDaily("Stretch 10 min");
    await w.completeOn(seriesId, "2026-10-12", 12);
    await w.completeOn(seriesId, "2026-10-13", 13);
    await w.completeOn(seriesId, "2026-10-14", 14);
    setClock(at(14));
    const currentId = await w.occurrenceItemId(seriesId, "2026-10-15");
    if (currentId === null) throw new Error("No stored occurrence on 2026-10-15");

    const restarted = await w.restartSeries(seriesId, "2026-10-15");
    expect(restarted).not.toBe(seriesId);
    const result = await w.entries("2026-10-12", "2026-10-16");

    const found = result.filter(isOccurrence);
    expect(found.map((entry) => [entry.occurrenceDate, entry.seriesId, entry.done, entry.overridden])).toEqual([
      ["2026-10-12", seriesId, true, true],
      ["2026-10-13", seriesId, true, true],
      ["2026-10-14", seriesId, true, true],
      ["2026-10-15", restarted, false, true],
      ["2026-10-16", restarted, false, false],
    ]);
    expect(found.slice(0, 3).map((entry) => [entry.date, entry.timeFrom, entry.timeTo, entry.readOnly])).toEqual([
      ["2026-10-12", "07:00", "07:15", false],
      ["2026-10-13", "07:00", "07:15", false],
      ["2026-10-14", "07:00", "07:15", false],
    ]);
    expect(found[0]?.id).toBe(firstId);
    expect(found[3]?.id).toBe(currentId);
    expect(result).toHaveLength(5);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(5);
    // The compact shape tells the history apart like any occurrence.
    const compact = (await w.readCompact("2026-10-12", "2026-10-12")).items.filter((entry) => entry.kind === "task");
    expect(compact).toEqual([expect.objectContaining({ id: firstId, seriesId, occurrenceDate: "2026-10-12" })]);
  });

  it("keeps the done and missed occurrences of a series whose row was removed, once each, and no virtual occurrence after them", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const currentId = await w.occurrenceItemId(seriesId, "2026-10-16");
    if (currentId === null) throw new Error("No stored occurrence on 2026-10-16");

    await w.deleteSeriesRow(currentId);
    const result = await w.entries("2026-10-12", "2026-10-18");

    const found = result.filter(isOccurrence);
    expect(found.map((entry) => [entry.occurrenceDate, entry.status, entry.overridden, entry.readOnly])).toEqual([
      ["2026-10-12", "done", true, false],
      ["2026-10-13", "done", true, false],
      ["2026-10-14", "done", true, false],
      ["2026-10-15", "missed", true, false],
      ["2026-10-16", "notDone", true, false],
    ]);
    expect(new Set(found.map((entry) => entry.seriesId))).toEqual(new Set([seriesId]));
    expect(new Set(result.map((entry) => entry.id)).size).toBe(result.length);
  });

  it("leaves out a stored occurrence of a series that is gone when it will not be done, and shows the others only in their range", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const currentId = await w.occurrenceItemId(seriesId, "2026-10-16");
    const doneId = await w.occurrenceItemId(seriesId, "2026-10-14");
    if (currentId === null || doneId === null) throw new Error("No stored occurrence");
    await w.deleteSeriesRow(currentId);
    await w.inTenant(() =>
      cp.updateItem({ databaseId: w.tenant.tasksId, itemId: currentId, propertiesPatch: { status: "wontDo" } }),
    );

    const result = await w.occurrences("2026-10-14", "2026-10-18");

    expect(result.map((entry) => entry.occurrenceDate)).toEqual(["2026-10-14", "2026-10-15"]);
    expect(result.map((entry) => entry.id)).toContain(doneId);
    expect(result.map((entry) => entry.id)).not.toContain(currentId);
  });

  it("keeps showing a Task without a series through the core Tasks source next to the occurrences", async () => {
    const w = world(await seededTenant());
    await stretchFixture(w);
    const plain = await w.create("tasks", { name: "Pay rent", date: "2026-10-16" });

    const result = await w.entries("2026-10-16", "2026-10-16");

    const own = result.find((entry) => entry.id === plain);
    expect(own).toMatchObject({ kind: "task", title: "Pay rent" });
    expect(own).not.toHaveProperty("seriesId");
    expect(result.filter(isOccurrence)).toHaveLength(1);
  });

  it("carries seriesId and occurrenceDate in the compact shape of a virtual and of a stored occurrence, and of no other Task", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const plain = await w.create("tasks", { name: "Pay rent", date: "2026-10-16" });

    const compact = (await w.readCompact("2026-10-15", "2026-10-17")).items.filter((entry) => entry.kind === "task");

    const stored = compact.find((entry) => "date" in entry && entry.date === "2026-10-15");
    const virtual = compact.find((entry) => "date" in entry && entry.date === "2026-10-17");
    expect(stored).toMatchObject({ seriesId, occurrenceDate: "2026-10-15", status: "missed", readOnly: false });
    expect(virtual).toMatchObject({
      id: `${seriesId}@2026-10-17`,
      seriesId,
      occurrenceDate: "2026-10-17",
      status: "notDone",
      readOnly: true,
    });
    expect(Object.keys(virtual ?? {}).sort()).toEqual(
      [
        "allDay",
        "calendarId",
        "counts",
        "date",
        "endDate",
        "id",
        "kind",
        "occurrenceDate",
        "readOnly",
        "seriesId",
        "status",
        "timeFrom",
        "title",
        "updatedAt",
      ].sort(),
    );
    expect(compact.find((entry) => entry.id === plain)).not.toHaveProperty("seriesId");
  });

  it("answers GET /api/calendar/timeline with the occurrences as JSON", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);

    const answer = await w.inTenant(() =>
      createCalendarTimelineRouteHandler(pool)({
        req: { url: "/api/calendar/timeline?from=2026-10-15&to=2026-10-17&shape=compact" },
      }),
    );

    expect(answer.status).toBe(200);
    const body = z
      .object({ items: z.array(z.object({ kind: z.string() }).passthrough()) })
      .parse(JSON.parse(JSON.stringify(answer.body)));
    expect(body.items.filter((entry) => entry.kind === "task")).toMatchObject([
      { seriesId, occurrenceDate: "2026-10-15", status: "missed" },
      { seriesId, occurrenceDate: "2026-10-16", status: "notDone" },
      { id: `${seriesId}@2026-10-17`, seriesId, occurrenceDate: "2026-10-17", status: "notDone", readOnly: true },
    ]);
  });

  it("gives a stored occurrence its project and people", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const project = await w.create(PROJECTS_MODULE_ID, { name: "Health", color: "#34C759" });
    const person = await w.create(PEOPLE_MODULE_ID, { name: "Jana Kovářová" });
    const itemId = await w.occurrenceItemId(seriesId, "2026-10-16");
    if (itemId === null) throw new Error("No stored occurrence on 2026-10-16");
    await w.link(itemId, "project", project);
    await w.link(itemId, "people", person);

    const [stored, virtual] = await w.occurrences("2026-10-16", "2026-10-17");

    expect(stored).toMatchObject({
      id: itemId,
      project: { id: project, name: "Health", color: "#34C759" },
      people: [{ id: person, name: "Jana Kovářová" }],
    });
    expect(virtual).toMatchObject({ overridden: false, project: null, people: [] });
  });

  it("leaves out a stored occurrence that will not be done, and does not show its date as virtual", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);

    await w.writeOccurrence(seriesId, "2026-10-17", { status: "wontDo" });
    const result = await w.occurrences("2026-10-16", "2026-10-18");

    expect(result.map((entry) => entry.occurrenceDate)).toEqual(["2026-10-16", "2026-10-18"]);
  });

  it("hides a stored occurrence while it sits in an Event that has not ended, and shows it afterwards", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await stretchFixture(w);
    const itemId = await w.occurrenceItemId(seriesId, "2026-10-16");
    if (itemId === null) throw new Error("No stored occurrence on 2026-10-16");

    await w.storeRaw(itemId, { hiddenUntil: "2026-10-16T12:00:00.000Z" });
    expect((await w.occurrences("2026-10-16", "2026-10-16")).map((entry) => entry.id)).toEqual([]);

    await w.storeRaw(itemId, { hiddenUntil: "2026-10-16T07:00:00.000Z" });
    expect((await w.occurrences("2026-10-16", "2026-10-16")).map((entry) => entry.id)).toEqual([itemId]);
  });

  it("shows an occurrence of a series without times as an all-day entry", async () => {
    const w = world(await seededTenant());
    await w.startDaily("Water the plants", { properties: { timeFrom: null, timeTo: null } });
    setClock(at(16));

    const [virtual] = await w.occurrences("2026-10-17", "2026-10-17");

    expect(virtual).toMatchObject({ allDay: true, timeFrom: null, timeTo: null, effectiveTo: null, hasEnd: false });
  });

  it("leaves out the virtual occurrences of a series whose template time is not valid, logs the series and keeps the others", async () => {
    const w = world(await seededTenant());
    const broken = await w.startDaily("Broken", { template: { timeFrom: "7 in the morning" } });
    const valid = await w.startDaily("Valid");
    setClock(at(16));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const found = await w.occurrences("2026-10-17", "2026-10-18");

    expect(found.map((entry) => entry.seriesId)).toEqual([valid.seriesId, valid.seriesId]);
    const logged = warn.mock.calls.map(([fields]) => fields);
    expect(logged).toEqual([
      { seriesId: broken.seriesId, occurrenceDate: "2026-10-17", databaseId: w.tenant.tasksId, property: "timeFrom" },
      { seriesId: broken.seriesId, occurrenceDate: "2026-10-18", databaseId: w.tenant.tasksId, property: "timeFrom" },
    ]);
    for (const call of warn.mock.calls) expect(call[1]).toBe(TEMPLATE_MESSAGE);
  });

  it("projects a range of more than 400 days in windows, with every day once and none lost at the window edge", async () => {
    const w = world(await seededTenant());
    const { seriesId } = await w.startDaily("Stretch 10 min");
    setClock(at(16));

    const found = await w.occurrences("2026-10-01", "2028-01-31");

    // 2026-10-01 to 2027-11-04 is the first window of 400 days, and 2027-11-05 starts the second.
    const expected = DateTime.fromISO("2028-01-31", { zone: "utc" }).diff(
      DateTime.fromISO("2026-10-12", { zone: "utc" }),
      "days",
    ).days;
    expect(found).toHaveLength(Math.round(expected) + 1);
    expect(new Set(found.map((entry) => entry.id)).size).toBe(found.length);
    const days = found.map((entry) => entry.occurrenceDate);
    expect(days.slice(0, 2)).toEqual(["2026-10-12", "2026-10-13"]);
    expect(days.slice(-2)).toEqual(["2028-01-30", "2028-01-31"]);
    expect(days.slice(days.indexOf("2027-11-03"), days.indexOf("2027-11-07") + 1)).toEqual([
      "2027-11-03",
      "2027-11-04",
      "2027-11-05",
      "2027-11-06",
      "2027-11-07",
    ]);
    expect(found.every((entry) => entry.seriesId === seriesId)).toBe(true);
  });

  it("returns nothing for a tenant without a Tasks database", async () => {
    const id = await createTestTenant(admin);

    const result = await runInTenant(id, () =>
      withTransaction(pool, (client) =>
        readTaskOccurrenceTimelineItems(client, {
          from: "2026-10-12",
          to: "2026-10-18",
          timezone: "Europe/Prague",
          today: "2026-10-16",
          now: { date: "2026-10-16", time: "10:00" },
          at: new Date(at(16)),
        }),
      ),
    );

    expect(result).toEqual([]);
  });

  it("reads with a number of statements that does not depend on the number of series", async () => {
    const w = world(await seededTenant());
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
            from: "2026-10-12",
            to: "2026-10-18",
            shape: "full",
          });
          return {
            statements,
            series: new Set(timeline.items.filter(isOccurrence).map((entry) => entry.seriesId)).size,
          };
        }),
      );
    await w.startDaily("Series 0");
    setClock(at(16));
    const quiet = await observe();
    for (let index = 1; index < 6; index += 1) await w.startDaily(`Series ${index}`);
    setClock(at(16));
    const busy = await observe();

    expect(quiet.series).toBe(1);
    expect(busy.series).toBe(6);
    expect(busy.statements.length).toBe(quiet.statements.length);
  });

  it("never returns another tenant's series, and each tenant sees its own", async () => {
    const a = world(await seededTenant());
    const b = world(await seededTenant());
    const aSeries = await a.startDaily("A stretch");
    const bSeries = await b.startDaily("B stretch");
    setClock(at(16));

    const fromA = await a.occurrences("2026-10-12", "2026-10-18");
    const fromB = await b.occurrences("2026-10-12", "2026-10-18");

    expect(new Set(fromA.map((entry) => entry.seriesId))).toEqual(new Set([aSeries.seriesId]));
    expect(new Set(fromB.map((entry) => entry.seriesId))).toEqual(new Set([bSeries.seriesId]));
    expect(fromA).toHaveLength(7);
    expect(fromB).toHaveLength(7);
    expect(fromA.map((entry) => entry.title)).toEqual(Array(7).fill("A stretch"));
    expect(fromB.map((entry) => entry.title)).toEqual(Array(7).fill("B stretch"));
    expect(fromA.map((entry) => entry.id)).not.toContain(bSeries.firstId);
    expect(fromB.map((entry) => entry.id)).not.toContain(aSeries.firstId);
  });
});
