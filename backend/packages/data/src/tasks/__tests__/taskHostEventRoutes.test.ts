import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError, ForbiddenError, NotFoundError, ValidationError } from "../../errors.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
  createTaskHostEventsClearRouteHandler,
} from "../taskHostEventRouteHandlers.js";
import { createTaskRecurrenceClearRouteHandler, createTaskRecurrenceSetRouteHandler } from "../taskRecurrenceRoutes.js";

/** A tenant with the system databases seeded. */
interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

/** The tenant a route is called in. */
type Caller = Pick<SeededTenant, "id">;

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
/** The tenant every case uses unless it names another. */
let home: SeededTenant;
/** A second tenant: the caller of the isolation cases and the owner of the foreign rows. */
let foreign: SeededTenant;

const userId = randomUUID();
const identity = { user: { id: userId } };
const USER: WriterIdentity = { writerKind: "user" };
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };
/** The frozen server clock of the cases that assert an exact `addedAt`. */
const CLOCK = Date.UTC(2026, 9, 10, 8, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

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

function put(taskId: string, eventId: string, caller: Caller = home, body: unknown = {}) {
  return runInTenant(caller.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body, identity }),
  );
}

function removeOne(taskId: string, eventId: string, caller: Caller = home) {
  return runInTenant(caller.id, () =>
    createTaskHostEventRemoveRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

function removeAll(taskId: string, body: unknown = {}, caller: Caller = home) {
  return runInTenant(caller.id, () =>
    createTaskHostEventsClearRouteHandler(pool)({ params: { id: taskId }, body, identity }),
  );
}

async function task(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", ...properties } }),
  );
  return item.id;
}

async function event(tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name: "Event", date: "2026-10-16" } }),
  );
  return item.id;
}

async function trash(databaseId: string, itemId: string): Promise<void> {
  const trashed = await runInTenant(home.id, () => cp.softDeleteItem(databaseId, itemId));
  if (!trashed) throw new Error(`Item ${itemId} was not trashed`);
}

/** The task as its tenant reads it: its properties and its version. */
async function storedTask(
  taskId: string,
  tenant: SeededTenant = home,
): Promise<{ properties: Record<string, unknown>; updatedAt: string }> {
  const item = await runInTenant(tenant.id, () => cp.getItem(tenant.tasksId, taskId));
  if (!item) throw new Error(`Task ${taskId} missing`);
  return { properties: item.properties, updatedAt: item.updatedAt };
}

const byEventId = (a: { eventId: string }, b: { eventId: string }): number => (a.eventId < b.eventId ? -1 : 1);

/** Every stored edge of the task, edges to trashed events included: the other item and the metadata, by event id. */
async function storedEdges(
  taskId: string,
  tenant: SeededTenant = home,
): Promise<Array<{ eventId: string; metadata: Record<string, unknown> }>> {
  const edges = await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, taskId)),
  );
  return edges
    .map((edge) => ({ eventId: relationsStore.otherSide(edge, taskId), metadata: edge.metadata }))
    .sort(byEventId);
}

async function relationPropertyId(databaseId: string, key: string): Promise<string> {
  const property = await runInTenant(home.id, () =>
    withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key)),
  );
  if (!property) throw new Error(`Relation property ${key} missing`);
  return property.id;
}

/** Writes a `hostEvents` edge as the Tasks process with any metadata, the way a writer other than the routes would. */
async function writeEdge(taskId: string, eventId: string, metadata: Record<string, unknown>): Promise<void> {
  const hostEvents = await relationPropertyId(home.tasksId, "hostEvents");
  await runInTenant(home.id, () =>
    withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: hostEvents, callerItemId: taskId, targetItemId: eventId, metadata },
        TASKS_CONTEXT,
      ),
    ),
  );
}

/** Runs `write`: its result and the realtime frames announced while it ran. */
async function framesOf<T>(write: () => Promise<T>): Promise<{ result: T; frames: InvalidationEvent[] }> {
  const frames: InvalidationEvent[] = [];
  setInvalidationHook((frame) => frames.push(frame));
  try {
    return { result: await write(), frames };
  } finally {
    setInvalidationHook(() => {});
  }
}

/** Runs `write`, which must be refused: the error it threw and the realtime frames announced while it ran. */
async function refusal(write: () => Promise<unknown>): Promise<{ error: unknown; frames: InvalidationEvent[] }> {
  const { result, frames } = await framesOf(() =>
    write().then(
      () => null,
      (error: unknown) => ({ error }),
    ),
  );
  if (!result) throw new Error("Expected the write to be refused");
  return { error: result.error, frames };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `hold` in a transaction of the home tenant and keeps that transaction open until `blocked` backends wait on a
 * lock, at least one of them on this transaction. `start` begins the work that is expected to wait; it is settled
 * before this returns or throws.
 */
async function whileHolding<T>(
  hold: (client: PoolClient) => Promise<void>,
  blocked: number,
  start: () => Array<Promise<T>>,
): Promise<Array<Outcome<T>>> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: (pid: number) => void = () => {};
  const announced = new Promise<number>((resolve) => {
    announce = resolve;
  });
  const holder = runInTenant(home.id, () =>
    withTransaction(pool, async (client) => {
      await hold(client);
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (!rows[0]) throw new Error("No backend pid");
      announce(rows[0].pid);
      await held;
    }),
  );
  const pid = await Promise.race([
    announced,
    holder.then(() => Promise.reject(new Error("The holder ended before it held its lock"))),
  ]);
  const waiters = start().map((work) =>
    work.then(
      (value): Outcome<T> => ({ ok: true, value }),
      (error: unknown): Outcome<T> => ({ ok: false, error }),
    ),
  );
  let waitFailure: Error | undefined;
  try {
    // Counted in attempts, not on the clock: a case may have frozen `Date.now`.
    for (let attempt = 0; ; attempt++) {
      // A second waiter on one row is blocked by the first waiter, not by the holder, so every blocked backend counts.
      const { rows } = await admin.query<{ waiting: number; onHolder: boolean }>(
        `SELECT count(*)::int AS waiting,
                COALESCE(bool_or($1::int = ANY(pg_blocking_pids(pid))), false) AS "onHolder"
         FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`,
        [pid],
      );
      if (rows[0]?.waiting === blocked && rows[0].onHolder) break;
      if (attempt >= 500) throw new Error("The work never waited on the held lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    waitFailure = error instanceof Error ? error : new Error("The wait failed", { cause: error });
  } finally {
    release();
  }
  // Every transaction settles before a failure is reported.
  await holder;
  const outcomes = await Promise.all(waiters);
  if (waitFailure) throw waitFailure;
  return outcomes;
}

function relationFrame(side: "task" | "event", itemId: string, op: "put" | "delete"): InvalidationEvent {
  return {
    scope: "relation",
    databaseId: side === "task" ? home.tasksId : home.eventsId,
    itemId,
    propertyKey: side === "task" ? "hostEvents" : "hostedTasks",
    op,
    userId,
  };
}

/** The announcement of a stored change of the task itself, which the recomputation of its host state makes. */
const taskItemFrame = (taskId: string) =>
  expect.objectContaining({ scope: "item", databaseId: home.tasksId, itemId: taskId, op: "update" });

const eventIdsOf = (response: { body: { hostEvents: Array<{ eventId: string }> } }): string[] =>
  response.body.hostEvents.map((entry) => entry.eventId);

/**
 * The three routes, each called for `taskId` with `eventId`, an event of the calling tenant, so only the task decides.
 * The removal of all events sends no new date: the item write would refuse a trashed task by itself.
 */
const ROUTES: Array<[string, (taskId: string, eventId: string, caller: Caller) => Promise<unknown>]> = [
  ["PUT /api/tasks/:id/host-events/:eventId", (taskId, eventId, caller) => put(taskId, eventId, caller)],
  ["DELETE /api/tasks/:id/host-events/:eventId", (taskId, eventId, caller) => removeOne(taskId, eventId, caller)],
  ["DELETE /api/tasks/:id/host-events", (taskId, _eventId, caller) => removeAll(taskId, {}, caller)],
];

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
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("PUT /api/tasks/:id/host-events/:eventId (issue #1764)", () => {
  it("creates the edge with the server's addedAt, whatever the body carries, and lists the event", async () => {
    const [taskId, eventId] = [await task(), await event()];
    vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    const sent = { addedAt: "2001-01-01T00:00:00.000Z", metadata: { addedAt: "2001-01-01T00:00:00.000Z" } };
    const response = await put(taskId, eventId, home, sent);
    expect(response).toEqual({ status: 200, body: { taskId, hostEvents: [{ eventId, addedAt: iso(CLOCK) }] } });
    expect(await storedEdges(taskId)).toEqual([{ eventId, metadata: { addedAt: iso(CLOCK) } }]);
  });

  it("moves an event that is put again to the end of the order and keeps one edge per event", async () => {
    const [taskId, first, second] = [await task(), await event(), await event()];
    vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    await put(taskId, first);
    await put(taskId, second);
    const response = await put(taskId, first);
    expect(response.body.hostEvents).toEqual([
      { eventId: second, addedAt: iso(CLOCK + 1) },
      { eventId: first, addedAt: iso(CLOCK + 2) },
    ]);
    expect(await storedEdges(taskId)).toEqual(
      [
        { eventId: first, metadata: { addedAt: iso(CLOCK + 2) } },
        { eventId: second, metadata: { addedAt: iso(CLOCK + 1) } },
      ].sort(byEventId),
    );
  });

  it("keeps three events in the order they were put", async () => {
    const taskId = await task();
    const order = [await event(), await event(), await event()];
    for (const eventId of order) await put(taskId, eventId);
    const listed = (await removeOne(taskId, randomUUID())).body.hostEvents;
    expect(listed.map((entry) => entry.eventId)).toEqual(order);
    const instants = listed.map((entry) => Date.parse(entry.addedAt));
    expect([...instants].sort((a, b) => a - b)).toEqual(instants);
    expect(new Set(instants).size).toBe(3);
  });

  it("puts an event after the stored ones when the server clock is behind them", async () => {
    const [taskId, first, second] = [await task(), await event(), await event()];
    const clock = vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    await put(taskId, first);
    clock.mockReturnValue(CLOCK - 3_600_000);
    const response = await put(taskId, second);
    expect(response.body.hostEvents).toEqual([
      { eventId: first, addedAt: iso(CLOCK) },
      { eventId: second, addedAt: iso(CLOCK + 1) },
    ]);
  });

  it("makes two puts of one task wait for its row lock, so each gets its own place in the order", async () => {
    const [taskId, first, second] = [await task(), await event(), await event()];
    vi.spyOn(Date, "now").mockReturnValue(CLOCK);
    const outcomes = await whileHolding(
      async (client) => {
        await itemsStore.lockItemById(client, home.tasksId, taskId);
      },
      2,
      () => [put(taskId, first), put(taskId, second)],
    );
    const lists = outcomes
      .map((outcome) => {
        if (!outcome.ok) throw new Error("A put failed", { cause: outcome.error });
        return outcome.value.body.hostEvents;
      })
      .sort((a, b) => a.length - b.length);
    // Whichever put got the lock first lists only its own event; the other one lists both and comes last.
    const earlier = lists[0]?.[0]?.eventId;
    expect([first, second]).toContain(earlier);
    const later = earlier === first ? second : first;
    expect(lists).toEqual([
      [{ eventId: earlier, addedAt: iso(CLOCK) }],
      [
        { eventId: earlier, addedAt: iso(CLOCK) },
        { eventId: later, addedAt: iso(CLOCK + 1) },
      ],
    ]);
  });

  it("announces the relation to the task and to the event, and the change of the task's host state", async () => {
    const [taskId, eventId] = [await task(), await event()];
    const { frames } = await framesOf(() => put(taskId, eventId));
    expect(frames).toHaveLength(3);
    expect(frames).toEqual(
      expect.arrayContaining([
        relationFrame("task", taskId, "put"),
        relationFrame("event", eventId, "put"),
        taskItemFrame(taskId),
      ]),
    );
  });

  it("puts a done task into an event and changes only its host state", async () => {
    const [taskId, eventId] = [await task({ date: "2026-10-12" }), await event()];
    await runInTenant(home.id, () =>
      cp.updateItem({ databaseId: home.tasksId, itemId: taskId, propertiesPatch: { status: "done" } }),
    );
    const before = await storedTask(taskId);
    expect(before.properties.status).toBe("done");
    expect(eventIdsOf(await put(taskId, eventId))).toEqual([eventId]);
    // The event of 16 October is past: the task is not hidden, and its effective day is the later of the two days.
    expect((await storedTask(taskId)).properties).toEqual({ ...before.properties, effectiveDate: "2026-10-16" });
  });

  it("puts a task whose recurrence was turned off into an event", async () => {
    const [taskId, eventId] = [await task({ date: "2026-10-22" }), await event()];
    const params = { id: taskId };
    await runInTenant(home.id, async () => {
      await createTaskRecurrenceSetRouteHandler(pool)({ params, body: { preset: "weekly" }, identity });
      await createTaskRecurrenceClearRouteHandler(pool)({ params, body: {}, identity });
    });
    expect(eventIdsOf(await put(taskId, eventId))).toEqual([eventId]);
  });

  it.each<[string, () => Promise<string>]>([
    [
      "a trashed event",
      async () => {
        const eventId = await event();
        await trash(home.eventsId, eventId);
        return eventId;
      },
    ],
    ["an event id that names nothing", async () => randomUUID()],
    ["an id that names a task", () => task()],
    ["another tenant's event", () => event(foreign)],
  ])("answers 404 for %s and writes nothing", async (_label, makeEventId) => {
    const [taskId, eventId] = [await task(), await makeEventId()];
    const { error, frames } = await refusal(() => put(taskId, eventId));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(frames).toEqual([]);
    expect(await storedEdges(taskId)).toEqual([]);
  });

  it("accepts upper-case ids and answers with the stored ones", async () => {
    const [taskId, eventId] = [await task(), await event()];
    const response = await put(taskId.toUpperCase(), eventId.toUpperCase());
    expect(response.body.taskId).toBe(taskId);
    expect(eventIdsOf(response)).toEqual([eventId]);
    const { result, frames } = await framesOf(() => removeOne(taskId.toUpperCase(), eventId.toUpperCase()));
    expect(result.body).toEqual({ taskId, hostEvents: [] });
    expect(frames).toHaveLength(3);
    expect(frames).toEqual(
      expect.arrayContaining([
        relationFrame("task", taskId, "delete"),
        relationFrame("event", eventId, "delete"),
        taskItemFrame(taskId),
      ]),
    );
    expect(await storedEdges(taskId)).toEqual([]);
  });
});

describe("DELETE /api/tasks/:id/host-events/:eventId (issue #1764)", () => {
  it("removes only that edge, keeps the others as they were and announces the removal", async () => {
    const taskId = await task();
    const [first, second, third] = [await event(), await event(), await event()];
    for (const eventId of [first, second, third]) await put(taskId, eventId);
    const before = await storedEdges(taskId);
    const { result, frames } = await framesOf(() => removeOne(taskId, second));
    expect(result.status).toBe(200);
    expect(eventIdsOf(result)).toEqual([first, third]);
    expect(await storedEdges(taskId)).toEqual(before.filter((edge) => edge.eventId !== second));
    expect(frames).toEqual([relationFrame("task", taskId, "delete"), relationFrame("event", second, "delete")]);
  });

  it.each<[string, () => Promise<string>]>([
    ["an event the task does not sit in", () => event()],
    ["an event id that names nothing", async () => randomUUID()],
    ["another tenant's event", () => event(foreign)],
  ])("answers 200 with the current list for %s and writes nothing", async (_label, makeEventId) => {
    const [taskId, hostId, eventId] = [await task(), await event(), await makeEventId()];
    const placed = await put(taskId, hostId);
    const before = await storedEdges(taskId);
    const { result, frames } = await framesOf(() => removeOne(taskId, eventId));
    expect(result).toEqual({ status: 200, body: placed.body });
    expect(frames).toEqual([]);
    expect(await storedEdges(taskId)).toEqual(before);
  });

  it("leaves a trashed event out of the list, lists it again once restored, and removes its edge", async () => {
    const taskId = await task();
    const [first, second, third] = [await event(), await event(), await event()];
    await put(taskId, first);
    await put(taskId, second);
    await trash(home.eventsId, second);
    expect(eventIdsOf(await put(taskId, third))).toEqual([first, third]);
    expect((await storedEdges(taskId)).map((edge) => edge.eventId)).toEqual([first, second, third].sort());

    await runInTenant(home.id, () => cp.restoreItem(home.eventsId, second));
    expect(eventIdsOf(await removeOne(taskId, randomUUID()))).toEqual([first, second, third]);

    await trash(home.eventsId, second);
    expect(eventIdsOf(await removeOne(taskId, second))).toEqual([first, third]);
    expect((await storedEdges(taskId)).map((edge) => edge.eventId)).toEqual([first, third].sort());
  });

  it("orders edges with the same addedAt by event id", async () => {
    const taskId = await task();
    const [lower, higher] = [await event(), await event()].sort();
    if (!lower || !higher) throw new Error("Expected two events");
    await writeEdge(taskId, higher, { addedAt: iso(CLOCK) });
    await writeEdge(taskId, lower, { addedAt: iso(CLOCK) });
    expect((await removeOne(taskId, randomUUID())).body.hostEvents).toEqual([
      { eventId: lower, addedAt: iso(CLOCK) },
      { eventId: higher, addedAt: iso(CLOCK) },
    ]);
  });
});

describe("DELETE /api/tasks/:id/host-events (issue #1764)", () => {
  it("removes every edge and sets the new date and time in the same write", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [first, second, trashed] = [await event(), await event(), await event()];
    for (const eventId of [first, second, trashed]) await put(taskId, eventId);
    await trash(home.eventsId, trashed);
    const { result, frames } = await framesOf(() => removeAll(taskId, { date: "2026-10-16", timeFrom: "09:00" }));
    expect(result).toEqual({ status: 200, body: { taskId, hostEvents: [] } });
    expect(await storedEdges(taskId)).toEqual([]);
    const after = await storedTask(taskId);
    // With no host event left the effective day follows the task's own date, the new one.
    expect(after.properties).toMatchObject({
      date: "2026-10-16",
      timeFrom: "09:00",
      time: "09:00",
      effectiveDate: "2026-10-16",
    });
    // Four relation frames, the recomputation after the last edge and the write of the new date.
    expect(frames).toHaveLength(6);
    expect(frames).toEqual(
      expect.arrayContaining([
        relationFrame("task", taskId, "delete"),
        relationFrame("event", first, "delete"),
        relationFrame("event", second, "delete"),
        relationFrame("event", trashed, "delete"),
        { scope: "item", databaseId: home.tasksId, itemId: taskId, op: "update", updatedAt: after.updatedAt, userId },
      ]),
    );
    expect(frames.filter((frame) => frame.scope === "item")).toHaveLength(2);
  });

  it("changes nothing when the new time is refused", async () => {
    const taskId = await task({ date: "2026-10-12", timeFrom: "07:00" });
    const [first, second] = [await event(), await event()];
    await put(taskId, first);
    await put(taskId, second);
    const before = { edges: await storedEdges(taskId), task: await storedTask(taskId) };
    const { error, frames } = await refusal(() => removeAll(taskId, { date: "2026-10-16", timeFrom: "25:99" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeFrom" } });
    expect(frames).toEqual([]);
    expect(before.edges).toHaveLength(2);
    expect({ edges: await storedEdges(taskId), task: await storedTask(taskId) }).toEqual(before);
  });

  it("removes every edge and leaves the task's own properties as they are when the body is empty", async () => {
    const taskId = await task({ date: "2026-10-12", timeFrom: "07:00" });
    const [first, second] = [await event(), await event()];
    await put(taskId, first);
    await put(taskId, second);
    const before = await storedTask(taskId);
    const { frames } = await framesOf(() => removeAll(taskId, {}));
    expect(await storedEdges(taskId)).toEqual([]);
    // Only the effective day moves, from the day of the events back to the task's own date.
    expect(before.properties.effectiveDate).toBe("2026-10-16");
    expect((await storedTask(taskId)).properties).toEqual({ ...before.properties, effectiveDate: "2026-10-12" });
    expect(frames).toHaveLength(4);
    expect(frames).toEqual(
      expect.arrayContaining([
        relationFrame("task", taskId, "delete"),
        relationFrame("event", first, "delete"),
        relationFrame("event", second, "delete"),
        taskItemFrame(taskId),
      ]),
    );
  });

  it("sets the date of a task that sits in no event", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const response = await removeAll(taskId, { date: "2026-10-16" });
    expect(response).toEqual({ status: 200, body: { taskId, hostEvents: [] } });
    expect((await storedTask(taskId)).properties.date).toBe("2026-10-16");
  });

  it.each<[string, unknown, string]>([
    ["an array", [], "body"],
    ["a string", "2026-10-16", "body"],
    ["null", null, "body"],
    ["a key of another task property", { status: "done" }, "status"],
    ["an unknown key beside a known one", { date: "2026-10-16", addedAt: "2026-10-16T09:00:00.000Z" }, "addedAt"],
  ])("refuses %s as the body before anything is written", async (_label, body, field) => {
    const [taskId, eventId] = [await task({ date: "2026-10-12" }), await event()];
    await put(taskId, eventId);
    const before = { edges: await storedEdges(taskId), task: await storedTask(taskId) };
    const { error, frames } = await refusal(() => removeAll(taskId, body));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
    expect(frames).toEqual([]);
    expect(before.edges).toHaveLength(1);
    expect({ edges: await storedEdges(taskId), task: await storedTask(taskId) }).toEqual(before);
  });
});

describe("the three host event routes (issue #1764)", () => {
  it.each(ROUTES)("%s answers 404 for a task id that names nothing", async (_route, call) => {
    const eventId = await event();
    const { error, frames } = await refusal(() => call(randomUUID(), eventId, home));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(frames).toEqual([]);
  });

  it.each(ROUTES)("%s answers 404 for a trashed task and keeps its edges", async (_route, call) => {
    const [taskId, eventId] = [await task({ date: "2026-10-12" }), await event()];
    await put(taskId, eventId);
    await trash(home.tasksId, taskId);
    const before = await storedEdges(taskId);
    const { error, frames } = await refusal(() => call(taskId, eventId, home));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(frames).toEqual([]);
    expect(before).toHaveLength(1);
    expect(await storedEdges(taskId)).toEqual(before);
  });

  it.each(ROUTES)(
    "%s answers another tenant's task like a task id that names nothing and leaves it unchanged",
    async (_route, call) => {
      const [taskId, eventId] = [await task({ date: "2026-10-12" }), await event()];
      await put(taskId, eventId);
      const before = { edges: await storedEdges(taskId), task: await storedTask(taskId) };
      const callerEvent = await event(foreign);
      const asForeign = await refusal(() => call(taskId, callerEvent, foreign));
      const asRandom = await refusal(() => call(randomUUID(), callerEvent, foreign));
      const shape = (error: unknown): unknown =>
        error instanceof ChokePointError ? { status: error.status, code: error.code, details: error.details } : error;
      expect(asForeign.error).toBeInstanceOf(NotFoundError);
      expect(shape(asForeign.error)).toEqual(shape(asRandom.error));
      expect(asForeign.frames).toEqual([]);
      expect(before.edges).toHaveLength(1);
      expect({ edges: await storedEdges(taskId), task: await storedTask(taskId) }).toEqual(before);
    },
  );

  it("writes no edge from a task to another tenant's event, in either tenant", async () => {
    const [callerTask, homeTask, homeEvent] = [await task({}, foreign), await task(), await event()];
    await put(homeTask, homeEvent);
    const before = await storedEdges(homeTask);
    const { error } = await refusal(() => put(callerTask, homeEvent, foreign));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(await storedEdges(callerTask, foreign)).toEqual([]);
    expect(before).toHaveLength(1);
    expect(await storedEdges(homeTask)).toEqual(before);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    ["PUT", "id", () => put("not-a-uuid", randomUUID())],
    ["PUT", "eventId", () => put(randomUUID(), "not-a-uuid")],
    ["DELETE of one event", "id", () => removeOne("not-a-uuid", randomUUID())],
    ["DELETE of one event", "eventId", () => removeOne(randomUUID(), "not-a-uuid")],
    ["DELETE of all events", "id", () => removeAll("not-a-uuid")],
  ])("%s refuses a malformed '%s' with 400 on that parameter", async (_route, field, call) => {
    const { error } = await refusal(call);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
  });

  it("answers 404 on every route in a tenant without a Tasks database", async () => {
    const bare = { id: await createTestTenant(admin) };
    for (const call of [
      () => put(randomUUID(), randomUUID(), bare),
      () => removeOne(randomUUID(), randomUUID(), bare),
      () => removeAll(randomUUID(), {}, bare),
    ]) {
      const { error } = await refusal(call);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
    }
  });

  it("fails with a server error, not a client error, when Tasks has no hostEvents relation", async () => {
    const broken = await seededTenant();
    const [taskId, eventId] = [await task({}, broken), await event(broken)];
    // Raw SQL: no API renames the key of a system relation property.
    const renamed = await admin.query("UPDATE properties SET key = $1 WHERE database_id = $2 AND key = $3", [
      "hostEventsRenamed",
      broken.tasksId,
      "hostEvents",
    ]);
    expect(renamed.rowCount).toBe(1);
    for (const call of [
      () => put(taskId, eventId, broken),
      () => removeOne(taskId, eventId, broken),
      () => removeAll(taskId, {}, broken),
    ]) {
      const { error } = await refusal(call);
      expect(error).not.toBeInstanceOf(ChokePointError);
      expect(error).toMatchObject({ message: "Tasks has no 'hostEvents' relation" });
    }
  });

  it("fails the list on an edge without a valid addedAt, and the removal of all events still removes it", async () => {
    const [taskId, eventId, otherEventId] = [await task(), await event(), await event()];
    await writeEdge(taskId, eventId, {});
    for (const call of [() => put(taskId, otherEventId), () => removeOne(taskId, otherEventId)]) {
      const { error } = await refusal(call);
      expect(error).not.toBeInstanceOf(ChokePointError);
      expect(error).toMatchObject({ message: expect.stringMatching(/^Host event edge .+ has no valid addedAt$/) });
    }
    expect(await storedEdges(taskId)).toEqual([{ eventId, metadata: {} }]);
    expect((await removeAll(taskId)).body).toEqual({ taskId, hostEvents: [] });
    expect(await storedEdges(taskId)).toEqual([]);
  });
});

describe("generic relation writes on Tasks.hostEvents and Events.hostedTasks (issue #1764)", () => {
  it("are refused with 403 owner_violation and leave an edge the route wrote as it is", async () => {
    const [taskId, eventId, otherEventId] = [await task(), await event(), await event()];
    await put(taskId, eventId);
    const before = await storedEdges(taskId);
    const hostEvents = await relationPropertyId(home.tasksId, "hostEvents");
    const hostedTasks = await relationPropertyId(home.eventsId, "hostedTasks");
    const metadata = { addedAt: iso(CLOCK) };
    const fromTask = (targetItemId: string) => ({ relationPropertyId: hostEvents, callerItemId: taskId, targetItemId });
    const fromEvent = (callerItemId: string) => ({
      relationPropertyId: hostedTasks,
      callerItemId,
      targetItemId: taskId,
    });
    const writes: Array<() => Promise<unknown>> = [
      () => cp.createRelation(fromTask(eventId), USER, userId),
      () => cp.createRelation(fromEvent(eventId), USER, userId),
      () => cp.createRelation({ ...fromTask(otherEventId), metadata }, USER, userId),
      () => cp.createRelation({ ...fromEvent(otherEventId), metadata }, USER, userId),
      () => cp.updateRelation({ ...fromTask(eventId), metadata }, USER),
      () => cp.updateRelation({ ...fromEvent(eventId), metadata }, USER),
      () => cp.deleteRelation(fromTask(eventId), USER, userId),
      () => cp.deleteRelation(fromEvent(eventId), USER, userId),
    ];
    for (const write of writes) {
      const { error, frames } = await refusal(() => runInTenant(home.id, write));
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error).toMatchObject({ status: 403, code: "owner_violation" });
      expect(frames).toEqual([]);
    }
    expect(before).toHaveLength(1);
    expect(await storedEdges(taskId)).toEqual(before);
  });
});
