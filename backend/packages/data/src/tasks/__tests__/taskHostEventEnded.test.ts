import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob, runOnce, type TaskList } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
} from "../taskHostEventRouteHandlers.js";
import {
  handleTaskHostEventEndedTask,
  recomputeTaskHostState,
  taskHostEventEndedJobKey,
} from "../taskHostEventState.js";

/**
 * Issue #1782: the job that recomputes a task's host state when the last Event it sits in ends. Every write goes
 * through the routes of issue #1764 or the choke point on a `semprec_data` pool, so row-level security applies. The
 * job runs through the production `createCoreTaskList` handler drained with `runOnce`. Only `Date` is faked, to
 * move the server clock; graphile-worker compares a job's `run_at` with the database clock, which is later than every
 * date used here, so a job is always due when it is drained and the tests decide by the fake clock what its
 * recomputation finds.
 */

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

interface PendingJob {
  id: string;
  key: string | null;
  run_at: Date;
  attempts: number;
  last_error: string | null;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let home: SeededTenant;
let foreign: SeededTenant;
let taskList: TaskList;

const identity = { user: { id: randomUUID() } };

/** The server clock of every case unless it moves it: 10 October 2026, 10:00 in the seeded zone (Europe/Prague). */
const START = "2026-10-10T08:00:00.000Z";
/** 15 October 14:00 in Prague (UTC+2): the end of the event most cases use (13:00 to 14:00). */
const END_AT_14 = "2026-10-15T12:00:00.000Z";
/** The same event after it was extended to 16:30. */
const END_AT_1630 = "2026-10-15T14:30:00.000Z";

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

const put = (taskId: string, eventId: string, tenant: SeededTenant = home) =>
  runInTenant(tenant.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );

const removeOne = (taskId: string, eventId: string) =>
  runInTenant(home.id, () =>
    createTaskHostEventRemoveRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );

async function task(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", date: "2026-10-12", ...properties } }),
  );
  return item.id;
}

async function event(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({
      databaseId: tenant.eventsId,
      properties: { name: "Event", date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00", ...properties },
    }),
  );
  return item.id;
}

const updateEvent = (eventId: string, propertiesPatch: Record<string, unknown>) =>
  runInTenant(home.id, () => cp.updateItem({ databaseId: home.eventsId, itemId: eventId, propertiesPatch }));

async function stored(databaseId: string, itemId: string, tenant: SeededTenant = home) {
  const item = await runInTenant(tenant.id, () => cp.getItem(databaseId, itemId));
  if (!item) throw new Error(`Item ${itemId} missing`);
  return item;
}

/** `hiddenUntil` and `effectiveDate` of a task as stored, and the version of the row. */
async function hostState(taskId: string, tenant: SeededTenant = home) {
  const item = await stored(tenant.tasksId, taskId, tenant);
  return {
    hiddenUntil: item.properties.hiddenUntil ?? null,
    effectiveDate: item.properties.effectiveDate ?? null,
    updatedAt: item.updatedAt,
  };
}

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

/** The queued `taskHostEventEnded` jobs, read through graphile-worker's public `jobs` view. */
async function pendingJobs(): Promise<PendingJob[]> {
  const { rows } = await admin.query<PendingJob>(
    `SELECT id::text, key, run_at, attempts, last_error
     FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key`,
    [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED],
  );
  return rows;
}

/** Completes every queued job without running it, through graphile-worker's public `complete_jobs`. */
async function discardQueuedJobs(): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

/** Drains the queue once with the production handler of `taskHostEventEnded`; nothing else runs. */
async function runJobs(): Promise<void> {
  await runOnce({ pgPool: admin, taskList });
}

/**
 * Runs the job of `taskId` once, as the queue does: its pending row is consumed first and the production handler runs
 * in the task's tenant. A job that queues itself again is therefore seen as a new pending row. `runJobs` cannot stand
 * in for it here: graphile-worker compares `run_at` with the database clock, which is past every fake date, so a job
 * that queues itself again is due at once and a drain would run it again for as long as the fake clock stays before
 * the end.
 */
async function runRunningJob(taskId: string, tenant: SeededTenant = home): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE key = $1 AND locked_at IS NULL))",
    [taskHostEventEndedJobKey(taskId)],
  );
  await runInTenant(tenant.id, () => handleTaskHostEventEndedTask(pool, { taskId }));
}

/** Runs `work` and returns the realtime frames announced while it ran. */
async function framesOf(work: () => Promise<unknown>): Promise<InvalidationEvent[]> {
  const frames: InvalidationEvent[] = [];
  setInvalidationHook((frame) => frames.push(frame));
  try {
    await work();
  } finally {
    setInvalidationHook(() => {});
  }
  return frames;
}

const taskUpdateFrames = (frames: InvalidationEvent[], taskId: string) =>
  frames.filter((frame) => frame.scope === "item" && frame.itemId === taskId && frame.op === "update");

/** A task in the event of 15 October 13:00 to 14:00, hidden until 14:00 local, and the event. */
async function hiddenTask(tenant: SeededTenant = home): Promise<{ taskId: string; eventId: string }> {
  const [taskId, eventId] = [await task({}, tenant), await event({}, tenant)];
  await put(taskId, eventId, tenant);
  return { taskId, eventId };
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
  home = await seededTenant();
  foreign = await seededTenant();
  const ended = createCoreTaskList(pool, createActionRegistry())[CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED];
  if (!ended) throw new Error("createCoreTaskList has no taskHostEventEnded handler");
  taskList = { [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: ended };
}, 120_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(START);
  await discardQueuedJobs();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("a recomputation that leaves the task hidden queues the end-of-event job (issue #1782)", () => {
  it("queues one job at hiddenUntil, keyed by the task", async () => {
    const { taskId } = await hiddenTask();
    const jobs = await pendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_14) });
    expect(taskHostEventEndedJobKey(taskId)).toBe(`taskHostEventEnded:${taskId}`);
  });

  it("queues nothing for a task that sits in no event, and nothing for one whose events have all ended", async () => {
    await task();
    const ended = await task();
    setClock("2026-10-16T08:00:00.000Z");
    await put(ended, await event());
    expect((await hostState(ended)).hiddenUntil).toBe(null);
    expect(await pendingJobs()).toEqual([]);
  });

  it("queues the job also when the recomputation changes nothing", async () => {
    const { taskId } = await hiddenTask();
    await discardQueuedJobs();
    const before = await hostState(taskId);
    await runInTenant(home.id, () => withTransaction(pool, (client) => recomputeTaskHostState(client, taskId)));
    expect(await hostState(taskId)).toEqual(before);
    expect(await pendingJobs()).toHaveLength(1);
  });

  it("leaves one pending job when the state is recomputed again, when a second event is added and when the end moves; another task has its own", async () => {
    const { taskId, eventId } = await hiddenTask();
    const second = await event({ date: "2026-10-15", timeFrom: "09:00", timeTo: "10:00" });
    await put(taskId, second);
    await runInTenant(home.id, () => withTransaction(pool, (client) => recomputeTaskHostState(client, taskId)));
    expect(await pendingJobs()).toMatchObject([{ key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_14) }]);
    await updateEvent(eventId, { timeTo: "16:30" });
    expect(await pendingJobs()).toMatchObject([{ key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_1630) }]);
    // Another task has its own job.
    const other = await task();
    await put(other, eventId);
    expect((await pendingJobs()).map((job) => job.key)).toEqual(
      [`taskHostEventEnded:${taskId}`, `taskHostEventEnded:${other}`].sort(),
    );
  });

  it("queues the job in the transaction of the write: a rolled-back recomputation leaves none", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    await discardQueuedJobs();
    await removeOne(taskId, eventId);
    await put(taskId, eventId);
    await discardQueuedJobs();
    const failure = new Error("rolled back on purpose");
    await expect(
      runInTenant(home.id, () =>
        withTransaction(pool, async (client) => {
          await recomputeTaskHostState(client, taskId);
          expect(await pendingJobs()).toEqual([]);
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(await pendingJobs()).toEqual([]);
  });

  it("queues nothing for a trashed task", async () => {
    const { taskId } = await hiddenTask();
    await runInTenant(home.id, () => cp.softDeleteItem(home.tasksId, taskId));
    await discardQueuedJobs();
    await runInTenant(home.id, () => withTransaction(pool, (client) => recomputeTaskHostState(client, taskId)));
    expect(await pendingJobs()).toEqual([]);
  });
});

describe("the job writes the revealed state when the event has ended (issue #1782)", () => {
  it("clears hiddenUntil once the clock has passed 14:00, announces the task and leaves no job behind", async () => {
    const { taskId } = await hiddenTask();
    const hidden = await hostState(taskId);
    expect(hidden).toMatchObject({ hiddenUntil: END_AT_14, effectiveDate: "2026-10-15" });
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(runJobs);
    const revealed = await hostState(taskId);
    expect(revealed).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-15" });
    expect(revealed.updatedAt).not.toBe(hidden.updatedAt);
    expect(taskUpdateFrames(frames, taskId)).toEqual([
      expect.objectContaining({
        scope: "item",
        databaseId: home.tasksId,
        itemId: taskId,
        op: "update",
        updatedAt: revealed.updatedAt,
      }),
    ]);
    expect(await pendingJobs()).toEqual([]);
  });

  it("reveals the task of the tenant the job was queued in and no task of another tenant", async () => {
    const mine = await hiddenTask();
    const theirs = await hiddenTask(foreign);
    const theirsBefore = await hostState(theirs.taskId, foreign);
    // Only the job of the home tenant is due; the foreign one is discarded and must not be what is announced.
    await admin.query(
      `SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE key = $1))`,
      [`taskHostEventEnded:${theirs.taskId}`],
    );
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(runJobs);
    expect((await hostState(mine.taskId)).hiddenUntil).toBe(null);
    expect(await hostState(theirs.taskId, foreign)).toEqual(theirsBefore);
    expect(taskUpdateFrames(frames, theirs.taskId)).toEqual([]);
    expect(taskUpdateFrames(frames, mine.taskId)).toHaveLength(1);
  });

  it("reveals each task in its own tenant when both jobs are due", async () => {
    const mine = await hiddenTask();
    const theirs = await hiddenTask(foreign);
    setClock("2026-10-15T12:00:01.000Z");
    await runJobs();
    expect((await hostState(mine.taskId)).hiddenUntil).toBe(null);
    expect((await hostState(theirs.taskId, foreign)).hiddenUntil).toBe(null);
    expect(await pendingJobs()).toEqual([]);
  });

  it("does not touch a task of another tenant when the payload names it", async () => {
    const theirs = await hiddenTask(foreign);
    const before = await hostState(theirs.taskId, foreign);
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(() =>
      runInTenant(home.id, () => handleTaskHostEventEndedTask(pool, { taskId: theirs.taskId })),
    );
    expect(await hostState(theirs.taskId, foreign)).toEqual(before);
    expect(frames).toEqual([]);
  });
});

describe("the job recomputes from the current edges and events and never clears blindly (issue #1782)", () => {
  it("does not reveal the task early when the event was extended after the enqueue, and runs again at the new end", async () => {
    const { taskId, eventId } = await hiddenTask();
    await updateEvent(eventId, { timeTo: "16:30" });
    const extended = await hostState(taskId);
    expect(extended).toMatchObject({ hiddenUntil: END_AT_1630 });
    // The queue runs the job at 14:00:01 on the server clock.
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(() => runRunningJob(taskId));
    expect(await hostState(taskId)).toEqual(extended);
    expect(taskUpdateFrames(frames, taskId)).toEqual([]);
    expect(await pendingJobs()).toMatchObject([{ key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_1630) }]);
    setClock("2026-10-15T14:30:01.000Z");
    await runJobs();
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-15" });
    expect(await pendingJobs()).toEqual([]);
  });

  it("moves hiddenUntil to the new end and runs again when the event was extended by a write that queued nothing", async () => {
    const { taskId, eventId } = await hiddenTask();
    // A writer outside the triggers (an older release): production code cannot move an Event end without them.
    await runInTenant(home.id, () =>
      pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
        eventId,
        JSON.stringify({ timeTo: "16:30" }),
      ]),
    );
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_AT_14 });
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(() => runRunningJob(taskId));
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_AT_1630, effectiveDate: "2026-10-15" });
    expect(taskUpdateFrames(frames, taskId)).toHaveLength(1);
    expect(await pendingJobs()).toMatchObject([{ key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_1630) }]);
  });

  it("queues itself again, writing nothing, when it runs a few seconds before the end", async () => {
    const { taskId } = await hiddenTask();
    const before = await hostState(taskId);
    setClock("2026-10-15T11:59:57.000Z");
    const frames = await framesOf(() => runRunningJob(taskId));
    expect(await hostState(taskId)).toEqual(before);
    expect(taskUpdateFrames(frames, taskId)).toEqual([]);
    expect(await pendingJobs()).toMatchObject([
      { key: `taskHostEventEnded:${taskId}`, run_at: new Date(END_AT_14), attempts: 0 },
    ]);
    setClock("2026-10-15T12:00:00.001Z");
    await runJobs();
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null });
    expect(await pendingJobs()).toEqual([]);
  });

  it("keeps the task hidden until the latest of two events has ended", async () => {
    const { taskId } = await hiddenTask();
    await put(taskId, await event({ timeFrom: "15:00", timeTo: "17:00" }));
    setClock("2026-10-15T12:00:01.000Z");
    await runRunningJob(taskId);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: "2026-10-15T15:00:00.000Z" });
    expect(await pendingJobs()).toMatchObject([{ run_at: new Date("2026-10-15T15:00:00.000Z") }]);
  });
});

describe("the job completes without a write when there is nothing to do (issue #1782)", () => {
  it("completes for a task that was trashed in between, writing and queueing nothing", async () => {
    const { taskId } = await hiddenTask();
    await runInTenant(home.id, () => cp.softDeleteItem(home.tasksId, taskId));
    const before = await hostState(taskId);
    setClock("2026-10-15T12:00:01.000Z");
    const frames = await framesOf(runJobs);
    expect(await hostState(taskId)).toEqual(before);
    expect(frames).toEqual([]);
    expect(await pendingJobs()).toEqual([]);
  });

  it("completes for a task that does not exist", async () => {
    await runInTenant(home.id, () => enqueueJob(pool, CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED, { taskId: randomUUID() }));
    const frames = await framesOf(runJobs);
    expect(frames).toEqual([]);
    expect(await pendingJobs()).toEqual([]);
  });

  it("completes when the event was deleted in between, and reveals the task, which sits in no live event any more", async () => {
    const { taskId, eventId } = await hiddenTask();
    await runInTenant(home.id, () => cp.softDeleteItem(home.eventsId, eventId));
    setClock("2026-10-15T11:00:00.000Z");
    await runJobs();
    expect(await pendingJobs()).toEqual([]);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-12" });
  });

  it("completes when the last edge was removed in between, with an unchanged state and no announcement", async () => {
    const { taskId, eventId } = await hiddenTask();
    await removeOne(taskId, eventId);
    const before = await hostState(taskId);
    expect(before.hiddenUntil).toBe(null);
    expect(await pendingJobs()).toHaveLength(1);
    const frames = await framesOf(runJobs);
    expect(await hostState(taskId)).toEqual(before);
    expect(frames).toEqual([]);
    expect(await pendingJobs()).toEqual([]);
  });

  it("completes for a task whose state the job already wrote, without a second write", async () => {
    const { taskId } = await hiddenTask();
    setClock("2026-10-15T12:00:01.000Z");
    await runJobs();
    const revealed = await hostState(taskId);
    await runInTenant(home.id, () => enqueueJob(pool, CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED, { taskId }));
    const frames = await framesOf(runJobs);
    expect(await hostState(taskId)).toEqual(revealed);
    expect(frames).toEqual([]);
    expect(await pendingJobs()).toEqual([]);
  });
});

describe("the payload of the job is checked at its edge (issue #1782)", () => {
  it.each([
    ["no task id", {}],
    ["a task id that is not a UUID", { taskId: "task-1" }],
    ["a number as the task id", { taskId: 7 }],
    ["a field besides the task id", { taskId: "6f4a9b0e-44c1-4a43-8d51-0a1f5f2f3a11", tenantId: "other" }],
  ])("rejects %s", async (_name, payload) => {
    await expect(runInTenant(home.id, () => handleTaskHostEventEndedTask(pool, payload))).rejects.toThrow();
  });
});
