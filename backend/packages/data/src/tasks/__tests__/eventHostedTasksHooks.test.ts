import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  registerItemUpdateHook,
  registerRelationEdgeDeleteHook,
  resetDatabase,
} from "../../testSupport/testDb.js";
import {
  countTasksReturningFromEvent,
  eventHostedTasksDeleteHook,
  eventHostedTasksRestoreHook,
} from "../eventHostedTasksHooks.js";
import { createTaskHostEventPutRouteHandler } from "../taskHostEventRouteHandlers.js";
import { readEventTasks } from "../taskStateInEvent.js";

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let home: SeededTenant;
let foreign: SeededTenant;

const identity = { user: { id: randomUUID() } };

/** The server clock of most cases: 10 October 2026, 10:00 in the seeded zone (Europe/Prague, UTC+2 that day). */
const START = "2026-10-10T08:00:00.000Z";

/** The task's own date in every case. */
const OWN_DATE = "2026-10-12";

/** Set by a case to make the next Tasks write or the next relation edge deletion fail; reset after each case. */
const failures = { taskUpdate: false, edgeDelete: false };

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

async function task(properties: Record<string, unknown> = {}, tenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", date: OWN_DATE, ...properties } }),
  );
  return item.id;
}

async function event(properties: Record<string, unknown> = {}, tenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name: "Event", date: "2026-10-22", ...properties } }),
  );
  return item.id;
}

/** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt` from the clock. */
function put(taskId: string, eventId: string, tenant = home) {
  return runInTenant(tenant.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

const setStatus = (taskId: string, status: string) =>
  runInTenant(home.id, () => cp.updateItem({ databaseId: home.tasksId, itemId: taskId, propertiesPatch: { status } }));

const trashEvent = (eventId: string) => runInTenant(home.id, () => cp.softDeleteItem(home.eventsId, eventId));
const restoreEvent = (eventId: string) => runInTenant(home.id, () => cp.restoreItem(home.eventsId, eventId));

async function stored(databaseId: string, itemId: string, tenant = home) {
  const item = await runInTenant(tenant.id, () => cp.getItem(databaseId, itemId));
  if (!item) throw new Error(`Item ${itemId} missing`);
  return item;
}

/** The host state a task stores: the two properties the recomputation writes. */
async function hostState(taskId: string): Promise<{ hiddenUntil: unknown; effectiveDate: unknown }> {
  const { properties } = await stored(home.tasksId, taskId);
  return { hiddenUntil: properties.hiddenUntil ?? null, effectiveDate: properties.effectiveDate ?? null };
}

/** The events a task has an edge to on a relation of Tasks, by the relation's key, as its own tenant reads them. */
async function edgeTargets(taskId: string, key: "hostEvents" | "completedInEvent"): Promise<string[]> {
  const edges = await runInTenant(home.id, () =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, home.tasksId, key);
      const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
      if (!definition) throw new Error(`${key} has no definition`);
      return relationsStore.listRelationsForItem(client, definition.id, taskId);
    }),
  );
  return edges.map((edge) => relationsStore.otherSide(edge, taskId)).sort();
}

/** Runs `write`: its outcome and the realtime frames announced while it ran (none are announced for a rolled-back write). */
async function framesOf<T>(
  write: () => Promise<T>,
): Promise<{ outcome: PromiseSettledResult<T>; frames: InvalidationEvent[] }> {
  const frames: InvalidationEvent[] = [];
  setInvalidationHook((frame) => frames.push(frame));
  try {
    const [outcome] = await Promise.allSettled([write()]);
    return { outcome, frames };
  } finally {
    setInvalidationHook(() => {});
  }
}

const itemUpdates = (frames: InvalidationEvent[], databaseId: string) =>
  frames.filter((frame) => frame.scope === "item" && frame.op === "update" && frame.databaseId === databaseId);

/** A client whose queries are counted; the pooled client itself is not patched. */
function counting(client: PoolClient): { client: PoolClient; queries: () => number } {
  let queries = 0;
  const wrapped: PoolClient = new Proxy(client, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property);
      // The hooks under test pass SQL text and a parameter array only.
      return (text: string, values?: unknown[]) => {
        queries += 1;
        return target.query(text, values);
      };
    },
  });
  return { client: wrapped, queries: () => queries };
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
  // Registered after the production hooks, so a failure here comes after the write it follows has happened.
  registerItemUpdateHook(async ({ database }) => {
    if (failures.taskUpdate && database.ownerModuleId === TASKS_MODULE_ID)
      throw new Error("injected task write failure");
  });
  registerRelationEdgeDeleteHook(async () => {
    if (failures.edgeDelete) throw new Error("injected edge deletion failure");
  });
  home = await seededTenant();
  foreign = await seededTenant();
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  vi.useRealTimers();
  failures.taskUpdate = false;
  failures.edgeDelete = false;
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("deleting an Event returns the tasks it hosts to their day (issue #1819)", () => {
  it("returns the task to the day of the host event added before it", async () => {
    const taskId = await task();
    const [previous, last] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-22" })];
    await put(taskId, previous);
    await put(taskId, last);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: "2026-10-22T21:59:59.999Z", effectiveDate: "2026-10-22" });
    await trashEvent(last);
    // 20 October ends at 23:59:59.999 in Prague (UTC+2).
    expect(await hostState(taskId)).toEqual({ hiddenUntil: "2026-10-20T21:59:59.999Z", effectiveDate: "2026-10-20" });
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([previous, last].sort());
  });

  it("returns the task to its own date and clears hiddenUntil when no live host event remains", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-22" })];
    await put(taskId, eventId);
    expect((await hostState(taskId)).hiddenUntil).toBe("2026-10-22T21:59:59.999Z");
    await trashEvent(eventId);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    // The edge stays, so the number of returning tasks can still be read while the event is in the trash.
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([eventId]);
  });

  it("announces the returned task", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    const { outcome, frames } = await framesOf(() => trashEvent(eventId));
    expect(outcome.status).toBe("fulfilled");
    expect(itemUpdates(frames, home.tasksId).map((frame) => frame.scope === "item" && frame.itemId)).toEqual([taskId]);
  });

  it("recomputes every live task of the event and leaves a trashed task alone", async () => {
    const eventId = await event();
    const [first, second, gone] = [await task(), await task(), await task()];
    for (const taskId of [first, second, gone]) await put(taskId, eventId);
    const goneBefore = await stored(home.tasksId, gone);
    await runInTenant(home.id, () => cp.softDeleteItem(home.tasksId, gone));
    const { frames } = await framesOf(() => trashEvent(eventId));
    expect(
      itemUpdates(frames, home.tasksId)
        .map((frame) => frame.scope === "item" && frame.itemId)
        .sort(),
    ).toEqual([first, second].sort());
    expect(await hostState(first)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    expect(await hostState(second)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    // The trashed task keeps the state it had when it was trashed.
    expect((await stored(home.tasksId, gone)).properties.effectiveDate).toBe(goneBefore.properties.effectiveDate);
  });

  it("recomputes a task completed in the event and leaves its completedInEvent edge", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    expect(await edgeTargets(taskId, "completedInEvent")).toEqual([eventId]);
    await trashEvent(eventId);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    expect(await edgeTargets(taskId, "completedInEvent")).toEqual([eventId]);
  });

  it("adds no task write for an event that hosts no task", async () => {
    const eventId = await event();
    const bystander = await task();
    const before = await stored(home.tasksId, bystander);
    const { outcome, frames } = await framesOf(() => trashEvent(eventId));
    expect(outcome.status).toBe("fulfilled");
    expect(itemUpdates(frames, home.tasksId)).toEqual([]);
    expect((await stored(home.tasksId, bystander)).updatedAt).toBe(before.updatedAt);
  });

  it("keeps the event live and the task unchanged when the recomputation fails", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-22" })];
    await put(taskId, eventId);
    const before = await stored(home.tasksId, taskId);
    failures.taskUpdate = true;
    const { outcome, frames } = await framesOf(() => trashEvent(eventId));
    expect(outcome).toMatchObject({ status: "rejected", reason: { message: "injected task write failure" } });
    expect((await stored(home.eventsId, eventId)).deletedAt).toBeNull();
    expect(await stored(home.tasksId, taskId)).toEqual(before);
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([eventId]);
    expect(frames).toEqual([]);
  });
});

describe("restoring an Event does not link its tasks again (issue #1819)", () => {
  it("leaves the task out of the restored event and removes the edge", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-22" })];
    await put(taskId, eventId);
    await trashEvent(eventId);
    await restoreEvent(eventId);
    expect((await stored(home.eventsId, eventId)).deletedAt).toBeNull();
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([]);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    expect(
      await runInTenant(home.id, () => withTransaction(pool, (client) => readEventTasks(client, eventId))),
    ).toEqual({
      eventId,
      tasks: [],
      counts: { open: 0, total: 0 },
    });
  });

  it("removes the edge of each live task and keeps the edge to a task in the trash", async () => {
    const eventId = await event();
    const [live, gone] = [await task(), await task()];
    await put(live, eventId);
    await put(gone, eventId);
    await trashEvent(eventId);
    await runInTenant(home.id, () => cp.softDeleteItem(home.tasksId, gone));
    await restoreEvent(eventId);
    expect(await edgeTargets(live, "hostEvents")).toEqual([]);
    expect(await edgeTargets(gone, "hostEvents")).toEqual([eventId]);
  });

  it("leaves the completedInEvent edge", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    await trashEvent(eventId);
    await restoreEvent(eventId);
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([]);
    expect(await edgeTargets(taskId, "completedInEvent")).toEqual([eventId]);
  });

  it("keeps the other host events of a task and recomputes from them", async () => {
    const taskId = await task();
    const [other, trashedLater] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-22" })];
    await put(taskId, other);
    await put(taskId, trashedLater);
    await trashEvent(trashedLater);
    await restoreEvent(trashedLater);
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([other]);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: "2026-10-20T21:59:59.999Z", effectiveDate: "2026-10-20" });
  });

  it("adds no task write for an event that hosts no task", async () => {
    const eventId = await event();
    const bystander = await task();
    await trashEvent(eventId);
    const before = await stored(home.tasksId, bystander);
    const { outcome, frames } = await framesOf(() => restoreEvent(eventId));
    expect(outcome.status).toBe("fulfilled");
    expect(itemUpdates(frames, home.tasksId)).toEqual([]);
    expect(frames.filter((frame) => frame.scope === "relation")).toEqual([]);
    expect((await stored(home.tasksId, bystander)).updatedAt).toBe(before.updatedAt);
  });

  it("keeps the event in the trash and the edge when the removal fails, and restores it once the failure is gone", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    await trashEvent(eventId);
    failures.edgeDelete = true;
    const { outcome } = await framesOf(() => restoreEvent(eventId));
    expect(outcome).toMatchObject({ status: "rejected", reason: { message: "injected edge deletion failure" } });
    expect((await stored(home.eventsId, eventId)).deletedAt).not.toBeNull();
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([eventId]);
    failures.edgeDelete = false;
    await restoreEvent(eventId);
    expect((await stored(home.eventsId, eventId)).deletedAt).toBeNull();
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([]);
  });
});

describe("restoring an Event locks the task before its edge, as the host-event routes do (issue #1819)", () => {
  /** True once a backend of the test database waits for a lock, which is the restore waiting for the task. */
  async function someoneWaitsForALock(): Promise<boolean> {
    const { rows } = await admin.query<{ waiting: string }>(
      "SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
    );
    return Number(rows[0]?.waiting) > 0;
  }

  async function untilSomeoneWaits(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await someoneWaitsForALock()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the restore never waited for the task lock");
  }

  it("waits for a route that holds the task and deletes the edge, without a deadlock", async () => {
    const [taskId, eventId] = [await task(), await event()];
    await put(taskId, eventId);
    await trashEvent(eventId);
    const outcome = await runInTenant(home.id, () =>
      withTransaction(pool, async (route) => {
        // What DELETE /api/tasks/:id/host-events/:eventId does first: the task row.
        await itemsStore.lockItemById(route, home.tasksId, taskId);
        const restore = restoreEvent(eventId);
        await untilSomeoneWaits();
        const property = await propertiesStore.getPropertyByKey(route, home.tasksId, "hostEvents");
        if (!property) throw new Error("Tasks has no hostEvents");
        await deleteRelationWithClient(
          route,
          { relationPropertyId: property.id, callerItemId: taskId, targetItemId: eventId },
          { ownerProcess: TASKS_MODULE_ID },
        );
        return { restore };
      }),
    );
    // The route committed first; without the lock order the restore holds the edge and both would deadlock (40P01).
    await outcome.restore;
    expect((await stored(home.eventsId, eventId)).deletedAt).toBeNull();
    expect(await edgeTargets(taskId, "hostEvents")).toEqual([]);
    expect(await hostState(taskId)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
  }, 30_000);
});

describe("a tenant whose Events database lacks the hostedTasks property (issue #1819)", () => {
  it("restores an Event and leaves its edges alone", async () => {
    const bare = await seededTenant();
    const [taskId, eventId] = [await task({}, bare), await event({}, bare)];
    await put(taskId, eventId, bare);
    await runInTenant(bare.id, () => cp.softDeleteItem(bare.eventsId, eventId));
    // Raw SQL on the superuser pool: no write path removes a system relation property, and the case needs a tenant that lacks it.
    await admin.query(
      "UPDATE relation_definitions SET property_id_b = NULL WHERE tenant_id = $1 AND property_id_b IN (SELECT id FROM properties WHERE tenant_id = $1 AND key = 'hostedTasks')",
      [bare.id],
    );
    await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND key = 'hostedTasks'", [bare.id]);
    await runInTenant(bare.id, () => cp.restoreItem(bare.eventsId, eventId));
    expect((await stored(bare.eventsId, eventId, bare)).deletedAt).toBeNull();
    const edges = await runInTenant(bare.id, () =>
      withTransaction(pool, async (client) => {
        const property = await propertiesStore.getPropertyByKey(client, bare.tasksId, "hostEvents");
        const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
        return definition ? relationsStore.listRelationsForItem(client, definition.id, taskId) : [];
      }),
    );
    expect(edges).toHaveLength(1);
  });
});

describe("countTasksReturningFromEvent (issue #1819)", () => {
  const countOf = (eventId: string, tenant = home) =>
    runInTenant(tenant.id, () => withTransaction(pool, (client) => countTasksReturningFromEvent(client, eventId)));

  it("counts the live hosted tasks that are not completed in the event, before and after the delete", async () => {
    const eventId = await event();
    const [open, done, gone, other] = [await task(), await task(), await task(), await task()];
    for (const taskId of [open, done, gone, other]) await put(taskId, eventId);
    await setStatus(done, "done");
    await runInTenant(home.id, () => cp.softDeleteItem(home.tasksId, gone));
    expect(await countOf(eventId)).toBe(2);
    await trashEvent(eventId);
    expect(await countOf(eventId)).toBe(2);
    // The two returned to their own day; the one completed in the event is not counted though it was recomputed too.
    expect(await hostState(open)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
    expect(await hostState(other)).toEqual({ hiddenUntil: null, effectiveDate: OWN_DATE });
  });

  it("counts a task completed in another event of the task", async () => {
    const taskId = await task();
    const [first, second] = [await event({ date: "2026-10-21" }), await event({ date: "2026-10-22" })];
    await put(taskId, first);
    await put(taskId, second);
    await setStatus(taskId, "done");
    expect(await edgeTargets(taskId, "completedInEvent")).toEqual([second]);
    expect(await countOf(first)).toBe(1);
    expect(await countOf(second)).toBe(0);
  });

  it("is 0 for an event with no task, for an id that names no event and for another tenant's event", async () => {
    const [empty, foreignEvent] = [await event(), await event({}, foreign)];
    await put(await task({}, foreign), foreignEvent, foreign);
    expect(await countOf(empty)).toBe(0);
    expect(await countOf(randomUUID())).toBe(0);
    expect(await countOf(foreignEvent)).toBe(0);
    expect(await countOf(foreignEvent, foreign)).toBe(1);
  });
});

describe("the hooks act on the Events database only (issue #1819)", () => {
  /** Calls `hook` for the Tasks database, for a user database named like Events, and for Events itself; counts queries. */
  async function queriesOf(which: "delete" | "restore", database: "tasks" | "notSystem" | "events"): Promise<number> {
    return runInTenant(home.id, () =>
      withTransaction(pool, async (client) => {
        const tasksDatabase = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
        const eventsDatabase = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
        if (!tasksDatabase || !eventsDatabase) throw new Error("Tasks or Events not seeded");
        const item = await stored(home.eventsId, await event());
        const target =
          database === "tasks"
            ? tasksDatabase
            : database === "notSystem"
              ? { ...eventsDatabase, system: false }
              : eventsDatabase;
        const { client: counted, queries } = counting(client);
        const base = { client: counted, database: target, item, rootItemId: item.id, deletedAt: item.updatedAt };
        if (which === "delete") await eventHostedTasksDeleteHook({ ...base, writerKind: "system" });
        else {
          await eventHostedTasksRestoreHook({
            ...base,
            deletedAtExact: "2026-10-10T08:00:00.000000Z",
            queueAffinity: createActionQueueAffinity(),
            writerKind: "system",
          });
        }
        return queries();
      }),
    );
  }

  it.each(["delete", "restore"] as const)(
    "the %s hook reads nothing for a database that is not Events",
    async (which) => {
      expect(await queriesOf(which, "tasks")).toBe(0);
      expect(await queriesOf(which, "notSystem")).toBe(0);
    },
  );

  it.each(["delete", "restore"] as const)("the %s hook reads the edges of an Event", async (which) => {
    expect(await queriesOf(which, "events")).toBeGreaterThan(0);
  });
});
