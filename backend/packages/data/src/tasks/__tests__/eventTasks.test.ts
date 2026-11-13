import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createEventTasksRouteHandler } from "../eventTasksRouteHandler.js";
import { createTaskHostEventPutRouteHandler } from "../taskHostEventRouteHandlers.js";
import { eventTaskCounts, readEventTasks, type EventTasks } from "../taskStateInEvent.js";

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

async function task(name: string, properties: Record<string, unknown> = {}, tenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name, date: "2026-10-12", ...properties } }),
  );
  return item.id;
}

async function event(name: string, properties: Record<string, unknown> = {}, tenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name, date: "2026-10-16", ...properties } }),
  );
  return item.id;
}

/** Puts the task into the event through the route of issue #1764, which stamps the edge's `addedAt` from the clock. */
function put(taskId: string, eventId: string, tenant = home) {
  return runInTenant(tenant.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

const setStatus = (taskId: string, status: string, tenant = home) =>
  runInTenant(tenant.id, () =>
    cp.updateItem({ databaseId: tenant.tasksId, itemId: taskId, propertiesPatch: { status } }),
  );

async function trash(databaseId: string, itemId: string, tenant = home): Promise<void> {
  const trashed = await runInTenant(tenant.id, () => cp.softDeleteItem(databaseId, itemId));
  if (!trashed) throw new Error(`Item ${itemId} was not trashed`);
}

/** `GET /api/events/:id/tasks` as the tenant's member sends it: the handler's answer in the tenant's scope. */
async function getEventTasks(eventId: string, tenant = home): Promise<EventTasks> {
  const answer = await runInTenant(tenant.id, () => createEventTasksRouteHandler(pool)({ params: { id: eventId } }));
  expect(answer.status).toBe(200);
  return answer.body;
}

const asRows = (answer: EventTasks) => answer.tasks.map((row) => [row.taskId, row.state.kind]);

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

describe("GET /api/events/:id/tasks: the state of a hosted task (issue #1801)", () => {
  it("answers open before the event ends and missed from its end, with the counts", async () => {
    const eventId = await event("Planning", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await task("Write agenda");
    await put(taskId, eventId);
    // 13:59:59.999 in Prague on 15 October (UTC+2).
    setClock("2026-10-15T11:59:59.999Z");
    expect(await getEventTasks(eventId)).toEqual({
      eventId,
      tasks: [{ taskId, title: "Write agenda", state: { kind: "open" } }],
      counts: { open: 1, total: 1 },
    });
    setClock("2026-10-15T12:00:00.000Z");
    expect(await getEventTasks(eventId)).toEqual({
      eventId,
      tasks: [{ taskId, title: "Write agenda", state: { kind: "missed" } }],
      counts: { open: 1, total: 1 },
    });
  });

  it("answers missed for a task given up with wontDo once the event has ended", async () => {
    const eventId = await event("Planning", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await task("Give up");
    await put(taskId, eventId);
    await setStatus(taskId, "wontDo");
    setClock("2026-10-15T12:00:00.000Z");
    expect(asRows(await getEventTasks(eventId))).toEqual([[taskId, "missed"]]);
  });

  it("answers moved with the name of the third event for a task that sits in three events", async () => {
    const taskId = await task("Moving");
    const [first, second, third] = [
      await event("First", { date: "2026-10-20" }),
      await event("Second", { date: "2026-10-21" }),
      await event("Third", { date: "2026-10-22" }),
    ];
    await put(taskId, first);
    await put(taskId, second);
    await put(taskId, third);
    const moved = { kind: "moved", lastEventName: "Third" };
    expect((await getEventTasks(first)).tasks).toEqual([{ taskId, title: "Moving", state: moved }]);
    expect((await getEventTasks(second)).tasks).toEqual([{ taskId, title: "Moving", state: moved }]);
    expect((await getEventTasks(third)).tasks).toEqual([{ taskId, title: "Moving", state: { kind: "open" } }]);
    expect((await getEventTasks(first)).counts).toEqual({ open: 0, total: 1 });
  });

  it("follows a re-add: the event put last is the last one", async () => {
    const taskId = await task("Re-added");
    const [first, second] = [
      await event("First", { date: "2026-10-20" }),
      await event("Second", { date: "2026-10-21" }),
    ];
    await put(taskId, first);
    await put(taskId, second);
    await put(taskId, first);
    expect(asRows(await getEventTasks(first))).toEqual([[taskId, "open"]]);
    expect((await getEventTasks(second)).tasks[0]?.state).toEqual({ kind: "moved", lastEventName: "First" });
  });

  it("answers done for a task completed in the event", async () => {
    const eventId = await event("Planning", { date: "2026-10-20" });
    const taskId = await task("Complete here");
    await put(taskId, eventId);
    await setStatus(taskId, "done");
    expect(await getEventTasks(eventId)).toEqual({
      eventId,
      tasks: [{ taskId, title: "Complete here", state: { kind: "done" } }],
      counts: { open: 0, total: 1 },
    });
  });

  it("answers done for a task completed on the day of the event after the event has ended", async () => {
    const eventId = await event("Planning", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await task("Complete after");
    await put(taskId, eventId);
    // 14:30 in Prague: the event has ended, so the completion makes no edge, and completedOn is the event's day.
    setClock("2026-10-15T12:30:00.000Z");
    await setStatus(taskId, "done");
    expect(asRows(await getEventTasks(eventId))).toEqual([[taskId, "done"]]);
  });

  it("answers doneElsewhere with the event name for a task completed in another event", async () => {
    const taskId = await task("Moved and done");
    const [first, second] = [
      await event("First", { date: "2026-10-20" }),
      await event("Second", { date: "2026-10-21" }),
    ];
    await put(taskId, first);
    await put(taskId, second);
    await setStatus(taskId, "done");
    expect((await getEventTasks(first)).tasks).toEqual([
      { taskId, title: "Moved and done", state: { kind: "doneElsewhere", eventName: "Second" } },
    ]);
    expect((await getEventTasks(second)).tasks[0]?.state).toEqual({ kind: "done" });
  });

  it("keeps the name of the event a task was completed in after that event is trashed", async () => {
    const taskId = await task("Done in trashed");
    const [first, second] = [
      await event("First", { date: "2026-10-20" }),
      await event("Second", { date: "2026-10-21" }),
    ];
    await put(taskId, first);
    await put(taskId, second);
    await setStatus(taskId, "done");
    await trash(home.eventsId, second);
    expect((await getEventTasks(first)).tasks[0]?.state).toEqual({ kind: "doneElsewhere", eventName: "Second" });
  });

  it("answers doneElsewhere with the date for a task completed from the list on 16 October", async () => {
    const eventId = await event("Planning", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    const taskId = await task("Completed from the list");
    await put(taskId, eventId);
    // 10:00 in Prague on 16 October, a day after the event.
    setClock("2026-10-16T08:00:00.000Z");
    await setStatus(taskId, "done");
    expect((await getEventTasks(eventId)).tasks).toEqual([
      { taskId, title: "Completed from the list", state: { kind: "doneElsewhere", completedOn: "2026-10-16" } },
    ]);
  });

  it("counts open and missed rows as open and every row in the total", async () => {
    const eventId = await event("Planning", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    const [open, done, gone] = [await task("Open"), await task("Done"), await task("Gone")];
    const elsewhere = await task("Elsewhere");
    const later = await event("Later", { date: "2026-10-30" });
    for (const taskId of [open, done, gone, elsewhere]) await put(taskId, eventId);
    await put(elsewhere, later);
    // 13:30 in Prague: the event is running, so the completion is made in it.
    setClock("2026-10-15T11:30:00.000Z");
    await setStatus(done, "done");
    await setStatus(gone, "wontDo");
    setClock("2026-10-15T12:00:00.000Z");
    const answer = await getEventTasks(eventId);
    expect(Object.fromEntries(asRows(answer))).toEqual({
      [open]: "missed",
      [done]: "done",
      [gone]: "missed",
      [elsewhere]: "moved",
    });
    expect(answer.counts).toEqual({ open: 2, total: 4 });
  });

  it("lists the tasks in the order of the event's edges by addedAt, not by the order they were put or created", async () => {
    const eventId = await event("Planning", { date: "2026-10-20" });
    const [a, b, c] = [await task("A"), await task("B"), await task("C")];
    // The clock runs backwards between the puts, so the stored `addedAt` order differs from the order of the writes.
    setClock("2026-10-10T08:00:02.000Z");
    await put(a, eventId);
    setClock("2026-10-10T08:00:00.000Z");
    await put(b, eventId);
    setClock("2026-10-10T08:00:01.000Z");
    await put(c, eventId);
    expect((await getEventTasks(eventId)).tasks.map((row) => row.taskId)).toEqual([b, c, a]);
  });

  it("orders tasks put in the same millisecond by task id", async () => {
    const eventId = await event("Planning", { date: "2026-10-20" });
    const taskIds: string[] = [];
    for (let index = 0; index < 6; index += 1) taskIds.push(await task(`Task ${index}`));
    for (const taskId of taskIds) await put(taskId, eventId);
    expect((await getEventTasks(eventId)).tasks.map((row) => row.taskId)).toEqual([...taskIds].sort());
  });

  it("answers an event with no tasks with an empty list and zero counts", async () => {
    const eventId = await event("Empty", { date: "2026-10-20" });
    expect(await getEventTasks(eventId)).toEqual({ eventId, tasks: [], counts: { open: 0, total: 0 } });
  });
});

describe("GET /api/events/:id/tasks: what does not count (issue #1801)", () => {
  it("leaves a trashed task out of the rows and the counts", async () => {
    const eventId = await event("Planning", { date: "2026-10-20" });
    const [kept, trashed] = [await task("Kept"), await task("Trashed")];
    await put(kept, eventId);
    await put(trashed, eventId);
    await trash(home.tasksId, trashed);
    expect(await getEventTasks(eventId)).toEqual({
      eventId,
      tasks: [{ taskId: kept, title: "Kept", state: { kind: "open" } }],
      counts: { open: 1, total: 1 },
    });
  });

  it("does not let a trashed host event count as the last event of a task", async () => {
    const taskId = await task("Hosted");
    const [live, trashedLater] = [
      await event("Live", { date: "2026-10-20" }),
      await event("Gone", { date: "2026-10-22" }),
    ];
    await put(taskId, live);
    await put(taskId, trashedLater);
    expect((await getEventTasks(live)).tasks[0]?.state).toEqual({ kind: "moved", lastEventName: "Gone" });
    await trash(home.eventsId, trashedLater);
    expect(asRows(await getEventTasks(live))).toEqual([[taskId, "open"]]);
  });

  it("answers 404 for an event in the trash, even when it still holds its edges", async () => {
    const eventId = await event("Trashed", { date: "2026-10-20" });
    await put(await task("Hosted"), eventId);
    await trash(home.eventsId, eventId);
    await expect(getEventTasks(eventId)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("answers 404 for an id that names nothing, for a task and for a non-UUID with 400", async () => {
    const taskId = await task("Not an event");
    for (const id of [randomUUID(), taskId]) {
      await expect(getEventTasks(id)).rejects.toMatchObject({ name: "NotFoundError", message: "Event not found" });
    }
    await expect(getEventTasks("not-a-uuid")).rejects.toMatchObject({
      name: "ValidationError",
      details: { field: "id" },
    });
  });

  it("answers an event in a tenant without the hostEvents relation with an empty list", async () => {
    const bare = await seededTenant();
    const eventId = await event("Bare", { date: "2026-10-20" }, bare);
    // Raw SQL on the superuser pool: no write path removes a system relation, and the case needs a tenant that lacks it.
    await admin.query(
      "DELETE FROM relation_definitions WHERE tenant_id = $1 AND property_id_a IN (SELECT id FROM properties WHERE tenant_id = $1 AND key = 'hostEvents')",
      [bare.id],
    );
    await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND key = 'hostEvents'", [bare.id]);
    expect(await getEventTasks(eventId, bare)).toEqual({ eventId, tasks: [], counts: { open: 0, total: 0 } });
  });
});

describe("GET /api/events/:id/tasks: tenant isolation on the runtime role (issue #1801)", () => {
  it("answers another tenant's event exactly like an unknown id and lists only the caller's tasks", async () => {
    const [ownEvent, foreignEvent] = [
      await event("Own", { date: "2026-10-20" }),
      await event("Foreign", { date: "2026-10-20" }, foreign),
    ];
    const [ownTask, foreignTask] = [await task("Own task"), await task("Foreign task", {}, foreign)];
    await put(ownTask, ownEvent);
    await put(foreignTask, foreignEvent, foreign);
    // The allowed side: each tenant reads its own event with its own task.
    expect(asRows(await getEventTasks(ownEvent))).toEqual([[ownTask, "open"]]);
    expect(asRows(await getEventTasks(foreignEvent, foreign))).toEqual([[foreignTask, "open"]]);
    const refusals: unknown[] = [];
    for (const id of [foreignEvent, randomUUID()]) {
      refusals.push(await getEventTasks(id).catch((error: unknown) => error));
    }
    const [foreignAnswer, randomAnswer] = refusals;
    expect(foreignAnswer).toMatchObject({ name: "NotFoundError", message: "Event not found" });
    expect(foreignAnswer).toEqual(randomAnswer);
  });
});

describe("eventTaskCounts (issue #1801)", () => {
  it("counts several events in one call and gives an event with no tasks zero counts", async () => {
    const [busy, quiet] = [
      await event("Busy", { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" }),
      await event("Quiet", { date: "2026-10-20" }),
    ];
    const [first, second] = [await task("First"), await task("Second")];
    await put(first, busy);
    await put(second, busy);
    setClock("2026-10-15T12:00:00.000Z");
    await setStatus(second, "wontDo");
    const counts = await runInTenant(home.id, () =>
      withTransaction(pool, (client) => eventTaskCounts(client, [busy, quiet])),
    );
    expect(counts).toEqual(
      new Map([
        [busy, { open: 2, total: 2 }],
        [quiet, { open: 0, total: 0 }],
      ]),
    );
  });

  it("leaves out an id that names no live event: an event in the Trash, a task, an unknown id, another tenant's event", async () => {
    const [live, trashed] = [
      await event("Live", { date: "2026-10-20" }),
      await event("Trashed", { date: "2026-10-20" }),
    ];
    await trash(home.eventsId, trashed);
    const foreignEvent = await event("Foreign", { date: "2026-10-20" }, foreign);
    const taskId = await task("A task");
    const counts = await runInTenant(home.id, () =>
      withTransaction(pool, (client) => eventTaskCounts(client, [live, trashed, taskId, randomUUID(), foreignEvent])),
    );
    expect([...counts.keys()]).toEqual([live]);
  });

  it("answers an empty list of ids with an empty map", async () => {
    const counts = await runInTenant(home.id, () => withTransaction(pool, (client) => eventTaskCounts(client, [])));
    expect(counts.size).toBe(0);
  });

  it("reads rows in a fixed number of queries however many tasks and events there are", async () => {
    const queriesFor = async (eventIds: string[]): Promise<number> =>
      runInTenant(home.id, () =>
        withTransaction(pool, async (client) => {
          let queries = 0;
          // A wrapper that delegates to the real client: the pooled client itself is not patched.
          const counting: PoolClient = new Proxy(client, {
            get(target, property) {
              if (property !== "query") return Reflect.get(target, property);
              // The readers under test pass SQL text and a parameter array only.
              return (text: string, values?: unknown[]) => {
                queries += 1;
                return target.query(text, values);
              };
            },
          });
          await eventTaskCounts(counting, eventIds);
          return queries;
        }),
      );
    const [one, other] = [await event("One", { date: "2026-10-20" }), await event("Other", { date: "2026-10-21" })];
    await put(await task("Only"), one);
    const small = await queriesFor([one]);
    for (let index = 0; index < 4; index += 1) {
      const taskId = await task(`Batch ${index}`);
      await put(taskId, one);
      await put(taskId, other);
    }
    expect(await queriesFor([one, other])).toBe(small);
  });
});

describe("readEventTasks (issue #1801)", () => {
  it("answers null for an event that is not live and the rows for one that is", async () => {
    const eventId = await event("Planning", { date: "2026-10-20" });
    const taskId = await task("Hosted");
    await put(taskId, eventId);
    const read = (id: string) =>
      runInTenant(home.id, () => withTransaction(pool, (client) => readEventTasks(client, id)));
    expect(await read(randomUUID())).toBeNull();
    expect((await read(eventId))?.tasks.map((row) => row.taskId)).toEqual([taskId]);
  });
});
