import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
} from "../taskHostEventRouteHandlers.js";
import { createTaskRecurrenceSetRouteHandler } from "../taskRecurrenceRoutes.js";

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

async function task(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", date: "2026-10-12", ...properties } }),
  );
  return item.id;
}

async function event(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name: "Event", date: "2026-10-16", ...properties } }),
  );
  return item.id;
}

/** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt` from the clock. */
function put(taskId: string, eventId: string, tenant: SeededTenant = home) {
  return runInTenant(tenant.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

function removeHost(taskId: string, eventId: string) {
  return runInTenant(home.id, () =>
    createTaskHostEventRemoveRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

const setStatus = (taskId: string, status: string, tenant: SeededTenant = home) =>
  runInTenant(tenant.id, () =>
    cp.updateItem({ databaseId: tenant.tasksId, itemId: taskId, propertiesPatch: { status } }),
  );

async function trash(databaseId: string, itemId: string): Promise<void> {
  const trashed = await runInTenant(home.id, () => cp.softDeleteItem(databaseId, itemId));
  if (!trashed) throw new Error(`Item ${itemId} was not trashed`);
}

async function stored(databaseId: string, itemId: string, tenant: SeededTenant = home) {
  const item = await runInTenant(tenant.id, () => cp.getItem(databaseId, itemId));
  if (!item) throw new Error(`Item ${itemId} missing`);
  return item;
}

async function relationProperty(databaseId: string, key: string, tenant: SeededTenant = home) {
  const property = await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key)),
  );
  if (!property) throw new Error(`Property ${key} missing`);
  return property;
}

/** The events a task is completed in, by their ids, as its own tenant reads the `completedInEvent` edges. */
async function completedIn(taskId: string, tenant: SeededTenant = home): Promise<string[]> {
  const property = await relationProperty(tenant.tasksId, "completedInEvent", tenant);
  const edges = await runInTenant(tenant.id, () =>
    withTransaction(pool, async (client) => {
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) throw new Error("completedInEvent has no definition");
      return relationsStore.listRelationsForItem(client, definition.id, taskId);
    }),
  );
  return edges.map((edge) => relationsStore.otherSide(edge, taskId)).sort();
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

const relationFrames = (frames: InvalidationEvent[]) => frames.filter((frame) => frame.scope === "relation");

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

describe("a completion before the end of the last host event is a completion in the event (issue #1781)", () => {
  it("records the edge for a task set to done at 13:30 in the event of 15 October 13:00 to 14:00", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" })];
    await put(taskId, eventId);
    // 13:30 in Prague on 15 October (UTC+2).
    setClock("2026-10-15T11:30:00.000Z");
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([eventId]);
    expect((await stored(home.tasksId, taskId)).properties.status).toBe("done");
  });

  it("records no edge for the same completion at 14:30, after the event has ended", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" })];
    await put(taskId, eventId);
    setClock("2026-10-15T12:30:00.000Z");
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
    expect((await stored(home.tasksId, taskId)).properties.status).toBe("done");
  });

  it("counts the end itself as ended", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" })];
    await put(taskId, eventId);
    setClock("2026-10-15T12:00:00.000Z");
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("records the edge for a task in a future event completed now", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([eventId]);
  });

  it("records the edge to the event added last when the task sits in two events", async () => {
    const taskId = await task();
    const [firstAdded, lastAdded] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-18" })];
    await put(taskId, firstAdded);
    await put(taskId, lastAdded);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([lastAdded]);
  });

  it("follows a re-add that moves an event to the end of the order", async () => {
    const taskId = await task();
    const [first, second] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-18" })];
    await put(taskId, first);
    await put(taskId, second);
    await put(taskId, first);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([first]);
  });

  it("records no edge when the event added last has ended, though an earlier one has not", async () => {
    const taskId = await task();
    const [running, ended] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-08" })];
    await put(taskId, running);
    await put(taskId, ended);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("passes over a trashed event added last and takes the live one before it", async () => {
    const taskId = await task();
    const [live, trashed] = [await event({ date: "2026-10-18" }), await event({ date: "2026-10-20" })];
    await put(taskId, live);
    await put(taskId, trashed);
    await trash(home.eventsId, trashed);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([live]);
  });

  it("records no edge for a task without host events", async () => {
    const taskId = await task();
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("records no edge after the task was taken out of its only event", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await removeHost(taskId, eventId);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("writes the edge in the transaction of the status write: seen inside it, gone with its rollback", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    const property = await relationProperty(home.tasksId, "completedInEvent");
    const seenInside: string[][] = [];
    await expect(
      runInTenant(home.id, () =>
        withTransaction(pool, async (client) => {
          await updateItemWithClient(client, {
            databaseId: home.tasksId,
            itemId: taskId,
            propertiesPatch: { status: "done" },
          });
          const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
          if (!definition) throw new Error("completedInEvent has no definition");
          const edges = await relationsStore.listRelationsForItem(client, definition.id, taskId);
          seenInside.push(edges.map((edge) => relationsStore.otherSide(edge, taskId)));
          throw new Error("roll back");
        }),
      ),
    ).rejects.toThrow("roll back");
    expect(seenInside).toEqual([[eventId]]);
    expect(await completedIn(taskId)).toEqual([]);
    expect((await stored(home.tasksId, taskId)).properties.status).toBe("notDone");
  });

  it("announces the edge on both sides after the commit", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    const { frames } = await framesOf(() => setStatus(taskId, "done"));
    expect(relationFrames(frames)).toEqual([
      expect.objectContaining({ databaseId: home.tasksId, itemId: taskId, propertyKey: "completedInEvent", op: "put" }),
      expect.objectContaining({ databaseId: home.eventsId, itemId: eventId, propertyKey: "completedTasks", op: "put" }),
    ]);
  });

  it("records the edge for a write of the system, whatever the writer", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await runInTenant(home.id, () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: home.tasksId,
          itemId: taskId,
          propertiesPatch: { status: "done" },
        }),
      ),
    );
    expect(await completedIn(taskId)).toEqual([eventId]);
  });
});

describe("a repeated done and the properties of the completion (issue #1781)", () => {
  it("changes nothing on a repeated done of a task that has the edge", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    const before = await runInTenant(home.id, () =>
      withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, taskId)),
    );
    setClock("2026-10-11T08:00:00.000Z");
    const { frames } = await framesOf(() => setStatus(taskId, "done"));
    expect(relationFrames(frames)).toEqual([]);
    const after = await runInTenant(home.id, () =>
      withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, taskId)),
    );
    expect(after).toEqual(before);
    expect(await completedIn(taskId)).toEqual([eventId]);
  });

  it("writes no edge on a repeated done of a task that was completed after the event ended", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-12", timeFrom: "09:00", timeTo: "10:00" })];
    await put(taskId, eventId);
    setClock("2026-10-12T09:00:00.000Z");
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
    // The event is moved later, so that it has not ended at the time of the repeated write.
    await runInTenant(home.id, () =>
      cp.updateItem({ databaseId: home.eventsId, itemId: eventId, propertiesPatch: { date: "2026-10-20" } }),
    );
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("leaves completedOn, completedAt and the other properties as the status write stored them", async () => {
    const [taskId, eventId] = [await task({ name: "Plain", timeFrom: "08:00" }), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    // The same write in a task that sits in no event.
    const control = await task({ name: "Plain", timeFrom: "08:00" });
    await setStatus(taskId, "done");
    await setStatus(control, "done");
    const [inEvent, alone] = [await stored(home.tasksId, taskId), await stored(home.tasksId, control)];
    expect(inEvent.properties).toMatchObject({ status: "done", completedOn: "2026-10-10", completedAt: START });
    const { hiddenUntil, effectiveDate, ...ownProperties } = inEvent.properties;
    const { hiddenUntil: aloneHidden, effectiveDate: aloneEffective, ...aloneProperties } = alone.properties;
    expect(ownProperties).toEqual(aloneProperties);
    expect([aloneHidden ?? null, aloneEffective]).toEqual([null, "2026-10-12"]);
    // The host state of the event is what the events of issue #1780 gave, not something this hook wrote.
    expect(hiddenUntil).toBe("2026-10-20T21:59:59.999Z");
    expect(effectiveDate).toBe("2026-10-20");
  });

  it("writes no edge for a write that names no status", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await runInTenant(home.id, () =>
      cp.updateItem({ databaseId: home.tasksId, itemId: taskId, propertiesPatch: { name: "Renamed", flagged: true } }),
    );
    expect(await completedIn(taskId)).toEqual([]);
  });
});

describe("a status that is not done removes the edge (issue #1781)", () => {
  it.each(["notDone", "wontDo"])("removes the edge when the status is set to %s", async (status) => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([eventId]);
    const { frames } = await framesOf(() => setStatus(taskId, status));
    expect(await completedIn(taskId)).toEqual([]);
    expect((await stored(home.tasksId, taskId)).properties.status).toBe(status);
    expect(relationFrames(frames)).toEqual([
      expect.objectContaining({ itemId: taskId, propertyKey: "completedInEvent", op: "delete" }),
      expect.objectContaining({ itemId: eventId, propertyKey: "completedTasks", op: "delete" }),
    ]);
  });

  it("removes the edge when the system sets the status to missed", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    await runInTenant(home.id, () =>
      withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: home.tasksId,
          itemId: taskId,
          propertiesPatch: { status: "missed" },
        }),
      ),
    );
    expect(await completedIn(taskId)).toEqual([]);
    expect((await stored(home.tasksId, taskId)).properties.status).toBe("missed");
  });

  it("removes an edge whose event is in the Trash", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    await trash(home.eventsId, eventId);
    await setStatus(taskId, "notDone");
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("writes nothing for a task that has no edge", async () => {
    const taskId = await task();
    await setStatus(taskId, "done");
    const { frames } = await framesOf(() => setStatus(taskId, "notDone"));
    expect(relationFrames(frames)).toEqual([]);
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("is undone as a whole: a task completed again in the event gets the edge again", async () => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    await setStatus(taskId, "notDone");
    await setStatus(taskId, "done");
    expect(await completedIn(taskId)).toEqual([eventId]);
  });
});

describe("a recurring task completed in an event (issue #1781)", () => {
  it("gets its next instance in the same transaction as the edge", async () => {
    setClock("2026-10-16T10:00:00.000Z");
    const created = await task({ name: "Stretch", date: "2026-10-16" });
    const response = await runInTenant(home.id, () =>
      createTaskRecurrenceSetRouteHandler(pool)({ params: { id: created }, body: { preset: "daily" }, identity }),
    );
    const seriesId = response.item.properties.seriesId;
    if (typeof seriesId !== "string") throw new Error("The recurrence route started no series");
    const eventId = await event({ date: "2026-10-16" });
    await put(created, eventId);

    const instances = async (): Promise<string[]> => {
      const { rows } = await runInTenant(home.id, () =>
        pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'seriesId' = $2 ORDER BY id",
          [home.tasksId, seriesId],
        ),
      );
      return rows.map((row) => row.id);
    };
    expect(await instances()).toEqual([created]);
    await setStatus(created, "done");
    expect(await completedIn(created)).toEqual([eventId]);
    const all = await instances();
    expect(all).toHaveLength(2);
    const next = all.find((id) => id !== created);
    if (next === undefined) throw new Error("The series advanced to no new instance");
    expect((await stored(home.tasksId, next)).properties).toMatchObject({ status: "notDone", seriesId });
    expect(await completedIn(next)).toEqual([]);
  });
});

describe("the edge is protected and tenant-bound (issue #1781)", () => {
  it.each([
    ["Tasks.completedInEvent", "task side"],
    ["Events.completedTasks", "event side"],
  ])("refuses a generic edge write through %s with 403 owner_violation (%s)", async (name) => {
    const [taskId, eventId] = [await task(), await event({ date: "2026-10-20" })];
    const onTaskSide = name === "Tasks.completedInEvent";
    const property = onTaskSide
      ? await relationProperty(home.tasksId, "completedInEvent")
      : await relationProperty(home.eventsId, "completedTasks");
    const input = {
      relationPropertyId: property.id,
      callerItemId: onTaskSide ? taskId : eventId,
      targetItemId: onTaskSide ? eventId : taskId,
    };
    // The refused PUT writes no edge, the refused DELETE leaves the one the hook wrote.
    await expect(runInTenant(home.id, () => cp.createRelation(input))).rejects.toMatchObject({
      status: 403,
      code: "owner_violation",
    });
    expect(await completedIn(taskId)).toEqual([]);
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    await expect(runInTenant(home.id, () => cp.deleteRelation(input))).rejects.toMatchObject({
      status: 403,
      code: "owner_violation",
    });
    expect(await completedIn(taskId)).toEqual([eventId]);
  });

  it("touches no task of another tenant", async () => {
    const [foreignTask, foreignEvent] = [await task({}, foreign), await event({ date: "2026-10-20" }, foreign)];
    await put(foreignTask, foreignEvent, foreign);
    const before = await stored(foreign.tasksId, foreignTask, foreign);

    // A completion in the home tenant leaves the foreign tenant's task and its edges as they were.
    const [homeTask, homeEvent] = [await task(), await event({ date: "2026-10-20" })];
    await put(homeTask, homeEvent);
    await setStatus(homeTask, "done");
    expect(await completedIn(homeTask)).toEqual([homeEvent]);
    expect(await completedIn(foreignTask, foreign)).toEqual([]);
    expect(await stored(foreign.tasksId, foreignTask, foreign)).toEqual(before);

    // A write of the foreign task's id from the home tenant finds nothing and changes nothing there.
    await expect(setStatus(foreignTask, "done", home)).rejects.toMatchObject({ status: 404 });
    expect(await completedIn(foreignTask, foreign)).toEqual([]);
    expect(await stored(foreign.tasksId, foreignTask, foreign)).toEqual(before);

    // The foreign tenant's own completion records its own edge, so the checks above are not an inert hook.
    await setStatus(foreignTask, "done", foreign);
    expect(await completedIn(foreignTask, foreign)).toEqual([foreignEvent]);
  });
});
