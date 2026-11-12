import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
  createTaskHostEventsClearRouteHandler,
} from "../taskHostEventRouteHandlers.js";
import { recomputeTaskHostState } from "../taskHostEventState.js";

interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
  peopleId: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let home: SeededTenant;
let foreign: SeededTenant;

const identity = { user: { id: randomUUID() } };
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

/** The server clock of every case unless it moves it: 10 October 2026, 10:00 in the seeded zone (Europe/Prague). */
const START = "2026-10-10T08:00:00.000Z";
/** The end of a whole day in Prague on 20 / 18 / 15 October (UTC+2), the `hiddenUntil` of a task in an all-day event. */
const END_OF_20 = "2026-10-20T21:59:59.999Z";
const END_OF_18 = "2026-10-18T21:59:59.999Z";

async function seededTenant(): Promise<SeededTenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
  return runInTenant(id, () =>
    withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
      const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
      if (!tasks || !events || !people) throw new Error("Tasks, Events or People not seeded");
      return { id, tasksId: tasks.id, eventsId: events.id, peopleId: people.id };
    }),
  );
}

const put = (taskId: string, eventId: string) =>
  runInTenant(home.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );

const removeOne = (taskId: string, eventId: string) =>
  runInTenant(home.id, () =>
    createTaskHostEventRemoveRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );

const removeAll = (taskId: string, body: unknown = {}) =>
  runInTenant(home.id, () => createTaskHostEventsClearRouteHandler(pool)({ params: { id: taskId }, body, identity }));

async function task(properties: Record<string, unknown> = {}, tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", ...properties } }),
  );
  return item.id;
}

async function event(properties: Record<string, unknown> = {}): Promise<string> {
  const item = await runInTenant(home.id, () =>
    cp.createItem({ databaseId: home.eventsId, properties: { name: "Event", date: "2026-10-16", ...properties } }),
  );
  return item.id;
}

const updateTask = (taskId: string, propertiesPatch: Record<string, unknown>) =>
  runInTenant(home.id, () => cp.updateItem({ databaseId: home.tasksId, itemId: taskId, propertiesPatch }));

const updateEvent = (eventId: string, propertiesPatch: Record<string, unknown>) =>
  runInTenant(home.id, () => cp.updateItem({ databaseId: home.eventsId, itemId: eventId, propertiesPatch }));

async function trash(databaseId: string, itemId: string): Promise<void> {
  const trashed = await runInTenant(home.id, () => cp.softDeleteItem(databaseId, itemId));
  if (!trashed) throw new Error(`Item ${itemId} was not trashed`);
}

async function stored(databaseId: string, itemId: string, tenant: SeededTenant = home) {
  const item = await runInTenant(tenant.id, () => cp.getItem(databaseId, itemId));
  if (!item) throw new Error(`Item ${itemId} missing`);
  return item;
}

/** The host state of a task and its first planned day, as stored. */
async function hostState(taskId: string, tenant: SeededTenant = home) {
  const { properties } = await stored(tenant.tasksId, taskId, tenant);
  return {
    hiddenUntil: properties.hiddenUntil ?? null,
    effectiveDate: properties.effectiveDate ?? null,
    since: properties.since ?? null,
    sinceTime: properties.sinceTime ?? null,
  };
}

/** The pair a stale state holds in the tests of a gate: a value no recomputation of these events and dates gives. */
const STALE = { hiddenUntil: "2026-10-01T00:00:00.000Z", effectiveDate: "2026-10-01" };

/**
 * Synthetic stale state: a writer other than the triggers (an older release) stored a different pair. A test of a
 * trigger's gate stores it first, so the case fails when the gate is missing and the unrelated write recomputes.
 */
async function storeStaleState(taskId: string): Promise<void> {
  await runInTenant(home.id, () =>
    pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [taskId, JSON.stringify(STALE)]),
  );
}

const version = async (taskId: string): Promise<string> => (await stored(home.tasksId, taskId)).updatedAt;

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

async function relationPropertyId(databaseId: string, key: string): Promise<string> {
  const property = await runInTenant(home.id, () =>
    withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key)),
  );
  if (!property) throw new Error(`Relation property ${key} missing`);
  return property.id;
}

/** Writes an edge of a relation as the Tasks process with any metadata, the way a writer other than the routes would. */
async function writeEdge(
  databaseId: string,
  key: string,
  callerItemId: string,
  targetItemId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const relationPropertyIdValue = await relationPropertyId(databaseId, key);
  await runInTenant(home.id, () =>
    withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: relationPropertyIdValue, callerItemId, targetItemId, metadata },
        TASKS_CONTEXT,
      ),
    ),
  );
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

describe("the host state follows the edges of Tasks.hostEvents (issue #1780)", () => {
  it("hides a task added to the event of 15 October 13:00 to 14:00 until 14:00 local and gives it that day", async () => {
    const [taskId, eventId] = [
      await task({ date: "2026-10-12" }),
      await event({ date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" }),
    ];
    await put(taskId, eventId);
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-15T12:00:00.000Z",
      effectiveDate: "2026-10-15",
    });
  });

  it("stays hidden until the end of the 20th and takes the 18th when added to a second event, and reorders on a re-add", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [on20, on18] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-18" })];
    await put(taskId, on20);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-20" });
    await put(taskId, on18);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-18" });
    // Adding the first event again moves it to the end of the order, so its day is the one the task takes.
    await put(taskId, on20);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-20" });
  });

  it("orders an edge without an addedAt before every edge that has one", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [withAddedAt, without] = [await event({ date: "2026-10-18" }), await event({ date: "2026-10-20" })];
    await put(taskId, withAddedAt);
    await writeEdge(home.tasksId, "hostEvents", taskId, without, {});
    // The edge written last sorts first: the event added with an `addedAt` is the one "added last".
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-18" });
  });

  it("gives the task's date and no hiding when the last edge is removed, and recomputes when one of two is", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [on20, on18] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-18" })];
    await put(taskId, on20);
    await put(taskId, on18);
    await removeOne(taskId, on18);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-20" });
    await removeOne(taskId, on20);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-12" });
  });

  it("gives the new date when every edge is removed together with a new date", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    await put(taskId, await event({ date: "2026-10-20" }));
    await removeAll(taskId, { date: "2026-10-14" });
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-14" });
    expect((await stored(home.tasksId, taskId)).properties.date).toBe("2026-10-14");
  });

  it("gives the date again when every edge is removed and the date stays", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    await removeAll(taskId);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-12" });
  });

  it("is not hidden and takes the later of the task's date and the event's day when the event has ended", async () => {
    const [early, late] = [await task({ date: "2026-10-05" }), await task({ date: "2026-10-09" })];
    setClock("2026-10-10T08:00:00.000Z");
    const ended = await event({ date: "2026-10-08", timeFrom: "09:00", timeTo: "10:00" });
    await put(early, ended);
    await put(late, ended);
    expect(await hostState(early)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-08" });
    expect(await hostState(late)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-09" });
  });

  it("is not hidden once the clock has passed every end, however the task got into the events", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [on20, on18] = [await event({ date: "2026-10-20" }), await event({ date: "2026-10-18" })];
    await put(taskId, on20);
    setClock("2026-10-21T08:00:00.000Z");
    // The next trigger after the clock moved: the edge to the second event.
    await put(taskId, on18);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-18" });
    // The event added last decides, not the later one: its day is after the task's date.
    await put(taskId, on20);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-20" });
  });

  it("ignores a trashed event", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const [live, trashed] = [
      await event({ date: "2026-10-18", timeFrom: "20:00", timeTo: "21:00" }),
      await event({ date: "2026-10-20" }),
    ];
    await put(taskId, live);
    await put(taskId, trashed);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_20, effectiveDate: "2026-10-20" });
    await trash(home.eventsId, trashed);
    // Trashing an event is no trigger of this issue; the next trigger finds the event trashed.
    await updateEvent(live, { timeTo: "23:00" });
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-18T21:00:00.000Z",
      effectiveDate: "2026-10-18",
    });
  });

  it("does not recompute for an edge of another relation of the same task", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const sourceEvent = await event({ date: "2026-10-18" });
    // A stale state, so that a recomputation triggered by the unrelated edge would change it.
    await storeStaleState(taskId);
    const before = await version(taskId);
    await writeEdge(home.eventsId, "actionItems", sourceEvent, taskId, {});
    expect(await version(taskId)).toBe(before);
    expect(await hostState(taskId)).toMatchObject(STALE);
  });

  it("does not recompute for an edge of another relation that has the task on the same side as hostEvents", async () => {
    // Tasks.hostEvents has the task as its first item, as Tasks.people has: the hook would pick the task of the edge
    // by the side of hostEvents, so only an edge with the task on that side shows that the relation is checked.
    const taskId = await task({ date: "2026-10-12" });
    const person = await runInTenant(home.id, () =>
      cp.createItem({ databaseId: home.peopleId, properties: { name: "Person" } }),
    );
    await storeStaleState(taskId);
    const before = await version(taskId);
    await writeEdge(home.tasksId, "people", taskId, person.id, {});
    expect(await version(taskId)).toBe(before);
    expect(await hostState(taskId)).toMatchObject(STALE);
  });
});

describe("the host state follows the dates and times of the events (issue #1780)", () => {
  it("moves hiddenUntil of a hosted task when the event's end changes, and its day when the date changes", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    await put(taskId, eventId);
    await updateEvent(eventId, { timeTo: "16:30" });
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-15T14:30:00.000Z",
      effectiveDate: "2026-10-15",
    });
    await updateEvent(eventId, { date: "2026-10-17", endDate: "2026-10-17" });
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-17T14:30:00.000Z",
      effectiveDate: "2026-10-17",
    });
    await updateEvent(eventId, { endDate: "2026-10-19" });
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-19T14:30:00.000Z",
      effectiveDate: "2026-10-17",
    });
  });

  it("recomputes every live task the event hosts and leaves the others alone", async () => {
    const [first, second, notHosted, trashedTask] = [
      await task({ date: "2026-10-12" }),
      await task({ date: "2026-10-12" }),
      await task({ date: "2026-10-12" }),
      await task({ date: "2026-10-12" }),
    ];
    const eventId = await event({ date: "2026-10-18" });
    for (const taskId of [first, second, trashedTask]) await put(taskId, eventId);
    await trash(home.tasksId, trashedTask);
    const [untouchedVersion, trashedVersion] = [await version(notHosted), await version(trashedTask)];
    await updateEvent(eventId, { date: "2026-10-19" });
    for (const taskId of [first, second]) {
      expect(await hostState(taskId)).toMatchObject({
        hiddenUntil: "2026-10-19T21:59:59.999Z",
        effectiveDate: "2026-10-19",
      });
    }
    expect(await version(notHosted)).toBe(untouchedVersion);
    // The task in the Trash keeps the state it had.
    expect(await version(trashedTask)).toBe(trashedVersion);
    expect(await hostState(trashedTask)).toMatchObject({ hiddenUntil: END_OF_18, effectiveDate: "2026-10-18" });
  });

  it("un-hides a hosted task when the event's new end is already past", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-18" });
    await put(taskId, eventId);
    await updateEvent(eventId, { date: "2026-10-08" });
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-12" });
  });

  it("writes no hosted task for an Event write that names none of the schedule keys", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-18" });
    await put(taskId, eventId);
    // A stale state, so that a recomputation triggered by the rename would change it.
    await storeStaleState(taskId);
    const before = await version(taskId);
    await updateEvent(eventId, { name: "Renamed" });
    expect(await version(taskId)).toBe(before);
    expect(await hostState(taskId)).toMatchObject(STALE);
  });

  it("writes nothing to a hosted task whose state the Event write leaves as it is", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-18", timeFrom: "09:00", timeTo: "10:00" });
    await put(taskId, eventId);
    const before = await version(taskId);
    // The start moves, the end and the day stay: the hook runs and finds nothing to write.
    await updateEvent(eventId, { timeFrom: "08:00" });
    expect(await hostState(taskId)).toMatchObject({
      hiddenUntil: "2026-10-18T08:00:00.000Z",
      effectiveDate: "2026-10-18",
    });
    expect(await version(taskId)).toBe(before);
  });

  it("does not look for hosted tasks when a task is written", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-18" });
    await put(taskId, eventId);
    const otherTask = await task({ date: "2026-10-11" });
    const before = await version(otherTask);
    await updateTask(taskId, { date: "2026-10-13" });
    expect(await version(otherTask)).toBe(before);
  });

  it("recomputes in the transaction of the Event write: visible inside it, gone with its rollback", async () => {
    const taskId = await task({ date: "2026-10-12" });
    const eventId = await event({ date: "2026-10-18" });
    await put(taskId, eventId);
    const seenInside: unknown[] = [];
    await expect(
      runInTenant(home.id, () =>
        withTransaction(pool, async (client) => {
          await updateItemWithClient(client, {
            databaseId: home.eventsId,
            itemId: eventId,
            propertiesPatch: { date: "2026-10-19" },
          });
          const inside = await itemsStore.getItemById(client, home.tasksId, taskId);
          seenInside.push(inside?.properties.effectiveDate);
          throw new Error("roll back");
        }),
      ),
    ).rejects.toThrow("roll back");
    expect(seenInside).toEqual(["2026-10-19"]);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_18, effectiveDate: "2026-10-18" });
  });
});

describe("the Tasks transform stores the effective day with the date (issue #1780)", () => {
  it("stores the date as the effective day on create, and nothing when the task has no date", async () => {
    const dated = await task({ date: "2026-10-12" });
    const undated = await task();
    expect(await hostState(dated)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-12" });
    expect((await stored(home.tasksId, undated)).properties).not.toHaveProperty("effectiveDate");
  });

  it("follows the date of a task that sits in no event, and clears with it", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await updateTask(taskId, { date: "2026-10-14" });
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-14" });
    await updateTask(taskId, { date: null });
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: null });
  });

  it("keeps the day of the event added last while the task is hidden, whatever the new date", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    await updateTask(taskId, { date: "2026-10-25" });
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_18, effectiveDate: "2026-10-18" });
  });

  it("takes the later of the new date and the day of the last event once every event has ended", async () => {
    const taskId = await task({ date: "2026-10-05" });
    await put(taskId, await event({ date: "2026-10-08" }));
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-08" });
    await updateTask(taskId, { date: "2026-10-09" });
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-09" });
    await updateTask(taskId, { date: "2026-10-06" });
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-08" });
  });

  it("leaves the effective day and the host state alone for a write that names no date", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    // A stale state, so that a recomputation of the effective day by the rename would change it.
    await storeStaleState(taskId);
    const before = await hostState(taskId);
    await updateTask(taskId, { name: "Renamed", flagged: true });
    expect(await hostState(taskId)).toEqual(before);
    expect(await hostState(taskId)).toMatchObject(STALE);
  });
});

describe("the first planned day on a change of the effective day (issue #1780)", () => {
  it("records since and sinceTime of an open task whose previous effective day was before today and had no since", async () => {
    const taskId = await task({ date: "2026-10-05", timeFrom: "09:00" });
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-05", since: null });
    await put(taskId, await event({ date: "2026-10-14" }));
    expect(await hostState(taskId)).toEqual({
      hiddenUntil: "2026-10-14T21:59:59.999Z",
      effectiveDate: "2026-10-14",
      since: "2026-10-05",
      sinceTime: { from: "09:00", to: null },
    });
  });

  it("records the day without a time for a task that has none", async () => {
    const taskId = await task({ date: "2026-10-05" });
    await put(taskId, await event({ date: "2026-10-14" }));
    expect(await hostState(taskId)).toMatchObject({ since: "2026-10-05", sinceTime: null });
  });

  it("does not record it for a task that is not open", async () => {
    const taskId = await task({ date: "2026-10-05" });
    await updateTask(taskId, { status: "done" });
    await put(taskId, await event({ date: "2026-10-14" }));
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-14", since: null, sinceTime: null });
  });

  it("does not record it when the previous effective day is not before today", async () => {
    const taskId = await task({ date: "2026-10-10" });
    await put(taskId, await event({ date: "2026-10-14" }));
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-14", since: null, sinceTime: null });
  });

  it("does not record it when the task has a since already", async () => {
    const taskId = await task({ date: "2026-10-05" });
    // Moving the date on is the write that records the first planned day (issue #1602).
    await updateTask(taskId, { date: "2026-10-06" });
    expect(await hostState(taskId)).toMatchObject({ since: "2026-10-05" });
    await put(taskId, await event({ date: "2026-10-14" }));
    expect(await hostState(taskId)).toMatchObject({ effectiveDate: "2026-10-14", since: "2026-10-05" });
  });

  it("does not record it, and writes nothing, when the effective day stays the same", async () => {
    const taskId = await task({ date: "2026-10-05" });
    const before = await version(taskId);
    // An event that has ended on the task's own day changes neither the day nor the hiding.
    await put(taskId, await event({ date: "2026-10-05" }));
    expect(await hostState(taskId)).toEqual({
      hiddenUntil: null,
      effectiveDate: "2026-10-05",
      since: null,
      sinceTime: null,
    });
    expect(await version(taskId)).toBe(before);
  });

  it("does not record it when only the hiding changes and the day does not", async () => {
    setClock("2026-10-20T08:00:00.000Z");
    const taskId = await task({ date: "2026-10-14" });
    const eventId = await event({ date: "2026-10-14" });
    await put(taskId, eventId);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: null, effectiveDate: "2026-10-14" });
    // The event now runs past the clock: the task is hidden again on the same day.
    await updateEvent(eventId, { endDate: "2026-10-25" });
    expect(await hostState(taskId)).toEqual({
      // 25 October is the day the zone leaves summer time, so its end is at UTC+1.
      hiddenUntil: "2026-10-25T22:59:59.999Z",
      effectiveDate: "2026-10-14",
      since: null,
      sinceTime: null,
    });
  });
});

describe("a recomputation that has nothing to do (issue #1780)", () => {
  const recompute = (taskId: string, tenant: SeededTenant = home) =>
    runInTenant(tenant.id, () => withTransaction(pool, (client) => recomputeTaskHostState(client, taskId)));

  it("is a no-op for a task that does not exist", async () => {
    await expect(recompute(randomUUID())).resolves.toBeUndefined();
  });

  it("is a no-op for a task in the Trash", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    await trash(home.tasksId, taskId);
    // Moved to the clock past the event so that a live task would change.
    setClock("2026-10-21T08:00:00.000Z");
    const before = await stored(home.tasksId, taskId);
    await recompute(taskId);
    expect(await stored(home.tasksId, taskId)).toEqual(before);
  });

  it("is a no-op for a task of another tenant, which the caller's scope does not see", async () => {
    const foreignTask = await task({ date: "2026-10-12" }, foreign);
    // Synthetic stale state: a writer other than the triggers stored a day the date does not give.
    await runInTenant(foreign.id, () =>
      pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
        foreignTask,
        JSON.stringify({ effectiveDate: "2026-10-01" }),
      ]),
    );
    const stale = await stored(foreign.tasksId, foreignTask, foreign);
    await recompute(foreignTask, home);
    expect(await stored(foreign.tasksId, foreignTask, foreign)).toEqual(stale);
    // In its own tenant the same call repairs it, so the line above is the scope and not a task that needs no repair.
    await recompute(foreignTask, foreign);
    expect(await hostState(foreignTask, foreign)).toMatchObject({ effectiveDate: "2026-10-12" });
  });

  it("is a no-op in a tenant that has no Tasks database", async () => {
    const bare = await createTestTenant(admin);
    await expect(
      runInTenant(bare, () => withTransaction(pool, (client) => recomputeTaskHostState(client, randomUUID()))),
    ).resolves.toBeUndefined();
  });

  it("writes nothing when the stored state is already right", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    const before = await stored(home.tasksId, taskId);
    await recompute(taskId);
    expect(await stored(home.tasksId, taskId)).toEqual(before);
  });

  it("repairs a stored state that does not match the events", async () => {
    const taskId = await task({ date: "2026-10-12" });
    await put(taskId, await event({ date: "2026-10-18" }));
    // Synthetic stale state: a writer other than the triggers (an older release) stored a different pair.
    await runInTenant(home.id, () =>
      pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
        taskId,
        JSON.stringify({ hiddenUntil: "2026-10-01T00:00:00.000Z", effectiveDate: "2026-10-01" }),
      ]),
    );
    await recompute(taskId);
    expect(await hostState(taskId)).toMatchObject({ hiddenUntil: END_OF_18, effectiveDate: "2026-10-18" });
  });
});
