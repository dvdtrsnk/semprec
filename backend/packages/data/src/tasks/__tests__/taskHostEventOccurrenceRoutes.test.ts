import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError, NotFoundError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { projectTaskOccurrences } from "../projectTaskOccurrences.js";
import { createTaskHostEventPutRouteHandler } from "../taskHostEventRouteHandlers.js";
import { createTaskOccurrenceMaterializeRouteHandler } from "../taskOccurrenceRoutes.js";
import { createTaskRecurrenceSetRouteHandler } from "../taskRecurrenceRoutes.js";
import { getTaskRecurrenceBySeriesId, type TaskRecurrence } from "../taskRecurrenceStore.js";

/** A tenant with the system databases seeded. */
interface SeededTenant {
  id: string;
  tasksId: string;
  eventsId: string;
}

/** A stored occurrence of a series as its tenant reads it. */
interface StoredOccurrence {
  id: string;
  properties: Record<string, unknown>;
  updatedAt: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
/** The tenant every case uses unless it names another. */
let home: SeededTenant;
/** A second tenant: the caller of the isolation cases and the owner of the foreign rows. */
let foreign: SeededTenant;

const userId = randomUUID();
const identity = { user: { id: userId } };

/** The server's clock in every case: 10:00 UTC on Friday 16 October 2026, which is noon of that day in the seeded zone. */
const NOW = Date.UTC(2026, 9, 16, 10, 0, 0);
const TODAY = "2026-10-16";
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

function put(taskId: string, eventId: string, caller: SeededTenant = home) {
  return runInTenant(caller.id, () =>
    createTaskHostEventPutRouteHandler(pool)({ params: { id: taskId, eventId }, body: {}, identity }),
  );
}

async function event(tenant: SeededTenant = home): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.eventsId, properties: { name: "Event", date: TODAY } }),
  );
  return item.id;
}

/**
 * A daily series started through the recurrence route (issue #1665) on a task dated today: the series id and its
 * current instance, the occurrence of 16 October.
 */
async function dailySeries(tenant: SeededTenant = home): Promise<{ seriesId: string; currentId: string }> {
  const created = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Stretch", date: TODAY } }),
  );
  const response = await runInTenant(tenant.id, () =>
    createTaskRecurrenceSetRouteHandler(pool)({ params: { id: created.id }, body: { preset: "daily" }, identity }),
  );
  const seriesId = response.item.properties.seriesId;
  if (typeof seriesId !== "string") throw new Error("The recurrence route started no series");
  return { seriesId, currentId: created.id };
}

/** Stores the occurrence of `date` through the materialize route (issue #1720) and returns the new item's id. */
async function materialize(seriesId: string, date: string, tenant: SeededTenant = home): Promise<string> {
  const response = await runInTenant(tenant.id, () =>
    createTaskOccurrenceMaterializeRouteHandler(pool)({ params: { seriesId, date }, body: {}, identity }),
  );
  if (response.status !== 201) throw new Error(`The occurrence of ${date} was stored before`);
  return response.item.id;
}

async function setStatus(taskId: string, status: string): Promise<void> {
  await runInTenant(home.id, () =>
    cp.updateItem({ databaseId: home.tasksId, itemId: taskId, propertiesPatch: { status } }),
  );
}

async function trash(databaseId: string, itemId: string): Promise<void> {
  const trashed = await runInTenant(home.id, () => cp.softDeleteItem(databaseId, itemId));
  if (!trashed) throw new Error(`Item ${itemId} was not trashed`);
}

/** The series row as the Tasks store reads it: its current instance, rule, anchor date, template and `active`. */
async function seriesRow(seriesId: string, tenant: SeededTenant = home): Promise<TaskRecurrence | null> {
  return runInTenant(tenant.id, () => withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)));
}

/** Every live item that carries `seriesId`, read in `tenant`, by occurrence date. */
async function seriesItems(seriesId: string, tenant: SeededTenant = home): Promise<StoredOccurrence[]> {
  return runInTenant(tenant.id, async () => {
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown>; updated_at: string }>(
      `SELECT id, properties, updated_at::text AS updated_at FROM items
       WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'seriesId' = $2
       ORDER BY properties->>'occurrenceDate', id`,
      [tenant.tasksId, seriesId],
    );
    return rows.map((row) => ({ id: row.id, properties: row.properties, updatedAt: row.updated_at }));
  });
}

const byEventId = (a: { eventId: string }, b: { eventId: string }): number => (a.eventId < b.eventId ? -1 : 1);

/** Every stored edge of the item as `tenant` reads it: the other item and the metadata, by the other item's id. */
async function storedEdges(
  itemId: string,
  tenant: SeededTenant = home,
): Promise<Array<{ eventId: string; metadata: Record<string, unknown> }>> {
  const edges = await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, itemId)),
  );
  return edges
    .map((edge) => ({ eventId: relationsStore.otherSide(edge, itemId), metadata: edge.metadata }))
    .sort(byEventId);
}

/**
 * One line per occurrence of `seriesId` the projection (issue #1672) returns for the range: its date, then the stored
 * item's id or `virtual:<status>`.
 */
async function projected(seriesId: string, from: string, to: string): Promise<string[]> {
  const result = await runInTenant(home.id, () =>
    withTransaction(pool, (client) => projectTaskOccurrences(client, { from, to, today: TODAY })),
  );
  return result
    .filter((occurrence) => occurrence.seriesId === seriesId)
    .map((occurrence) =>
      occurrence.virtual
        ? `${occurrence.occurrenceDate} virtual:${String(occurrence.properties.status)}`
        : `${occurrence.occurrenceDate} ${occurrence.item.id}`,
    );
}

/** Runs `write`, which must be refused, and returns the error it threw. */
async function refusal(write: () => Promise<unknown>): Promise<unknown> {
  const outcome = await write().then(
    () => null,
    (error: unknown) => ({ error }),
  );
  if (!outcome) throw new Error("Expected the write to be refused");
  return outcome.error;
}

/**
 * The two kinds of occurrence the route places. Each starts a daily series of its own in `tenant` and returns the item
 * to place: the series' current instance, or the occurrence of 17 October stored through the materialize route.
 */
const OCCURRENCES: Array<[string, (tenant?: SeededTenant) => Promise<{ seriesId: string; occurrenceId: string }>]> = [
  [
    "the current instance",
    async (tenant) => {
      const { seriesId, currentId } = await dailySeries(tenant);
      return { seriesId, occurrenceId: currentId };
    },
  ],
  [
    "a materialized occurrence",
    async (tenant) => {
      const { seriesId } = await dailySeries(tenant);
      return { seriesId, occurrenceId: await materialize(seriesId, "2026-10-17", tenant) };
    },
  ],
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("PUT /api/tasks/:id/host-events/:eventId for an occurrence of a recurring series (issue #2012)", () => {
  it("puts the current instance of a daily series into an event and leaves the series, its other occurrences and the projection as they were", async () => {
    const { seriesId, currentId } = await dailySeries();
    const otherId = await materialize(seriesId, "2026-10-18");
    const eventId = await event();
    const before = {
      row: await seriesRow(seriesId),
      items: await seriesItems(seriesId),
      projection: await projected(seriesId, TODAY, "2026-10-19"),
    };
    expect(before.row).toMatchObject({ itemId: currentId, active: true, anchorDate: TODAY });
    expect(before.items.map((item) => item.id)).toEqual([currentId, otherId]);
    expect(before.projection).toEqual([
      `2026-10-16 ${currentId}`,
      "2026-10-17 virtual:notDone",
      `2026-10-18 ${otherId}`,
      "2026-10-19 virtual:notDone",
    ]);

    const response = await put(currentId, eventId);

    expect(response).toEqual({
      status: 200,
      body: { taskId: currentId, hostEvents: [{ eventId, addedAt: iso(NOW) }] },
    });
    expect(await storedEdges(currentId)).toEqual([{ eventId, metadata: { addedAt: iso(NOW) } }]);
    expect(await storedEdges(otherId)).toEqual([]);
    // The series row still names the placed item as its current instance, with the same rule, anchor and template.
    expect(await seriesRow(seriesId)).toEqual(before.row);
    // The placed occurrence and the other stored one keep their properties and their version.
    expect(await seriesItems(seriesId)).toEqual(before.items);
    expect(await projected(seriesId, TODAY, "2026-10-19")).toEqual(before.projection);
  });

  it("puts the materialized occurrence of 17 October into an event: that item alone gets the edge, and 18 October is still projected", async () => {
    const { seriesId, currentId } = await dailySeries();
    const occurrenceId = await materialize(seriesId, "2026-10-17");
    const eventId = await event();
    const before = { row: await seriesRow(seriesId), items: await seriesItems(seriesId) };
    expect(before.row).toMatchObject({ itemId: currentId, active: true });
    expect(before.items.map((item) => item.id)).toEqual([currentId, occurrenceId]);

    const response = await put(occurrenceId, eventId);

    expect(response).toEqual({
      status: 200,
      body: { taskId: occurrenceId, hostEvents: [{ eventId, addedAt: iso(NOW) }] },
    });
    expect(await storedEdges(occurrenceId)).toEqual([{ eventId, metadata: { addedAt: iso(NOW) } }]);
    expect(await storedEdges(currentId)).toEqual([]);
    expect(await seriesRow(seriesId)).toEqual(before.row);
    expect(await seriesItems(seriesId)).toEqual(before.items);
    expect(await projected(seriesId, TODAY, "2026-10-18")).toEqual([
      `2026-10-16 ${currentId}`,
      `2026-10-17 ${occurrenceId}`,
      "2026-10-18 virtual:notDone",
    ]);
    // The following occurrence, once it is stored, sits in no event.
    const followingId = await materialize(seriesId, "2026-10-18");
    expect(await storedEdges(followingId)).toEqual([]);
  });

  it("creates the next instance once when the placed current instance is completed, and does not put it into the event", async () => {
    const { seriesId, currentId } = await dailySeries();
    const eventId = await event();
    await put(currentId, eventId);
    const row = await seriesRow(seriesId);
    expect(row).toMatchObject({ itemId: currentId, active: true });

    await setStatus(currentId, "done");

    const items = await seriesItems(seriesId);
    expect(
      items.map((item) => [item.id === currentId, item.properties.occurrenceDate, item.properties.status]),
    ).toEqual([
      [true, TODAY, "done"],
      [false, "2026-10-17", "notDone"],
    ]);
    const nextId = items[1]?.id;
    if (nextId === undefined) throw new Error("The series did not advance");
    expect(await seriesRow(seriesId)).toEqual({ ...row, itemId: nextId });
    expect(await storedEdges(currentId)).toEqual([{ eventId, metadata: { addedAt: iso(NOW) } }]);
    expect(await storedEdges(nextId)).toEqual([]);

    // The placed occurrence is no longer the current instance: completing it again creates nothing.
    await setStatus(currentId, "notDone");
    await setStatus(currentId, "done");
    expect((await seriesItems(seriesId)).map((item) => item.id)).toEqual([currentId, nextId]);
    expect(await seriesRow(seriesId)).toEqual({ ...row, itemId: nextId });
  });
});

describe.each(OCCURRENCES)(
  "the rules of issue #1764 for %s of a recurring series (issue #2012)",
  (_kind, occurrence) => {
    it("answers 404 for the occurrence in the trash and writes nothing", async () => {
      const { seriesId, occurrenceId } = await occurrence();
      const eventId = await event();
      await trash(home.tasksId, occurrenceId);
      const row = await seriesRow(seriesId);

      const error = await refusal(() => put(occurrenceId, eventId));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
      expect(await storedEdges(occurrenceId)).toEqual([]);
      expect(await seriesRow(seriesId)).toEqual(row);
    });

    it("answers 404 for an event in the trash and writes nothing", async () => {
      const { seriesId, occurrenceId } = await occurrence();
      const eventId = await event();
      await trash(home.eventsId, eventId);
      const before = { row: await seriesRow(seriesId), items: await seriesItems(seriesId) };

      const error = await refusal(() => put(occurrenceId, eventId));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
      expect(await storedEdges(occurrenceId)).toEqual([]);
      expect({ row: await seriesRow(seriesId), items: await seriesItems(seriesId) }).toEqual(before);
    });

    it("answers another tenant's occurrence like a task id that names nothing and writes nothing in either tenant", async () => {
      const { seriesId, occurrenceId } = await occurrence();
      const callerEvent = await event(foreign);
      const before = { row: await seriesRow(seriesId), items: await seriesItems(seriesId) };
      expect(before.items.map((item) => item.id)).toContain(occurrenceId);
      // The edges the caller's event got when it was created, its calendar among them (issue #1761).
      const callerEventEdges = await storedEdges(callerEvent, foreign);

      const asForeign = await refusal(() => put(occurrenceId, callerEvent, foreign));
      const asRandom = await refusal(() => put(randomUUID(), callerEvent, foreign));

      const shape = (error: unknown): unknown =>
        error instanceof ChokePointError ? { status: error.status, code: error.code, details: error.details } : error;
      expect(asForeign).toBeInstanceOf(NotFoundError);
      expect(shape(asForeign)).toEqual(shape(asRandom));
      expect(shape(asForeign)).toMatchObject({ status: 404, code: "not_found" });
      expect(await storedEdges(occurrenceId)).toEqual([]);
      // The refused PUT added no edge to the caller's event and changed none of those it had.
      expect(await storedEdges(callerEvent, foreign)).toEqual(callerEventEdges);
      expect({ row: await seriesRow(seriesId), items: await seriesItems(seriesId) }).toEqual(before);
      // The calling tenant sees neither the series nor its items.
      expect(await seriesRow(seriesId, foreign)).toBeNull();
      expect(await seriesItems(seriesId, foreign)).toEqual([]);
    });

    it("answers 404 for another tenant's event and writes nothing in either tenant", async () => {
      const { seriesId, occurrenceId } = await occurrence();
      const foreignEvent = await event(foreign);
      const before = { row: await seriesRow(seriesId), items: await seriesItems(seriesId) };
      // The edges the other tenant's event got when it was created, its calendar among them (issue #1761).
      const foreignEventEdges = await storedEdges(foreignEvent, foreign);

      const error = await refusal(() => put(occurrenceId, foreignEvent));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
      expect(await storedEdges(occurrenceId)).toEqual([]);
      // The refused PUT added no edge to the other tenant's event and changed none of those it had.
      expect(await storedEdges(foreignEvent, foreign)).toEqual(foreignEventEdges);
      expect({ row: await seriesRow(seriesId), items: await seriesItems(seriesId) }).toEqual(before);
    });

    it("moves an event that is put again to the end of the order and keeps one edge per event", async () => {
      const { occurrenceId } = await occurrence();
      const [first, second] = [await event(), await event()];
      await put(occurrenceId, first);
      await put(occurrenceId, second);

      const response = await put(occurrenceId, first);

      expect(response.body).toEqual({
        taskId: occurrenceId,
        hostEvents: [
          { eventId: second, addedAt: iso(NOW + 1) },
          { eventId: first, addedAt: iso(NOW + 2) },
        ],
      });
      expect(await storedEdges(occurrenceId)).toEqual(
        [
          { eventId: first, metadata: { addedAt: iso(NOW + 2) } },
          { eventId: second, metadata: { addedAt: iso(NOW + 1) } },
        ].sort(byEventId),
      );
    });
  },
);
