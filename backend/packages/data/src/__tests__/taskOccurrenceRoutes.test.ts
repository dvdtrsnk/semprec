import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { projectTaskOccurrences } from "../tasks/projectTaskOccurrences.js";
import { createTaskOccurrenceMaterializeRouteHandler } from "../tasks/taskOccurrenceRoutes.js";
import {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
import { getTaskRecurrenceBySeriesId } from "../tasks/taskRecurrenceStore.js";
import { createTaskSeriesPatchRouteHandler } from "../tasks/taskSeriesRoutes.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
const identity = { user: { id: randomUUID() } };
const WAIT_MS = 10_000;

/** The server's day in every test: 10:00 UTC on Friday 16 October 2026, which is noon of that day in the seeded zone. */
const NOW = new Date("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";

function post(seriesId: string, date: string, body: unknown, as: string = tenant) {
  return runInTenant(as, () =>
    createTaskOccurrenceMaterializeRouteHandler(pool)({ params: { seriesId, date }, body, identity }),
  );
}

async function tasksDatabaseId(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
    );
    if (!rows[0]) throw new Error("Tasks not seeded");
    return rows[0].id;
  });
}

/** A series started through the recurrence route on a task dated `date`. */
async function series(
  recurrence: unknown = { preset: "daily" },
  properties: Record<string, unknown> = {},
  date = TODAY,
): Promise<{ seriesId: string; currentId: string }> {
  const created = await runInTenant(tenant, () =>
    cp.createItem({ databaseId: tasksId, properties: { name: "Stretch", date, ...properties } }),
  );
  const response = await runInTenant(tenant, () =>
    createTaskRecurrenceSetRouteHandler(pool)({ params: { id: created.id }, body: recurrence, identity }),
  );
  const seriesId = response.item.properties.seriesId;
  if (typeof seriesId !== "string") throw new Error("No series id");
  return { seriesId, currentId: created.id };
}

/**
 * A daily series whose id has a letter, so the id written in upper case is another string. Nearly every random UUID
 * has one; a series whose id has none is left in the tenant and another is started.
 */
async function seriesWithLetterInId(): Promise<{ seriesId: string; currentId: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = await series();
    if (started.seriesId.toUpperCase() !== started.seriesId) return started;
  }
  throw new Error("No series id with a letter in five series");
}

interface OccurrenceRow {
  id: string;
  occurrenceDate: string | null;
  status: string | null;
}

/** The live items that carry `seriesId`, read in `tenantId`. */
async function occurrences(seriesId: string, tenantId: string = tenant): Promise<OccurrenceRow[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string; occurrence_date: string | null; status: string | null }>(
      `SELECT id, properties->>'occurrenceDate' AS occurrence_date, properties->>'status' AS status
       FROM items WHERE properties->>'seriesId' = $1 AND deleted_at IS NULL
       ORDER BY properties->>'occurrenceDate', id`,
      [seriesId],
    );
    return rows.map((row) => ({ id: row.id, occurrenceDate: row.occurrence_date, status: row.status }));
  });
}

interface SeriesRow {
  item_id: string;
  template: unknown;
  rule: unknown;
  anchor_date: string | null;
  active: boolean;
}

async function seriesRow(seriesId: string): Promise<SeriesRow[]> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<SeriesRow>(
      "SELECT item_id, template, rule, anchor_date::text, active FROM task_recurrence WHERE series_id = $1::uuid",
      [seriesId],
    );
    return rows;
  });
}

async function stored(id: string): Promise<{ properties: Record<string, unknown>; updatedAt: string }> {
  const item = await runInTenant(tenant, () => cp.getItem(tasksId, id));
  if (!item) throw new Error(`Task ${id} missing`);
  return { properties: item.properties, updatedAt: item.updatedAt };
}

/**
 * One line per projected occurrence, of every series or of series `only`: its date, then the stored item's id or
 * `virtual:<status>`.
 */
async function projected(from: string, to: string, only?: string): Promise<string[]> {
  const result = await runInTenant(tenant, () =>
    withTransaction(pool, (client) => projectTaskOccurrences(client, { from, to, today: TODAY })),
  );
  return result
    .filter((o) => only === undefined || o.seriesId === only)
    .map((o) =>
      o.virtual ? `${o.occurrenceDate} virtual:${String(o.properties.status)}` : `${o.occurrenceDate} ${o.item.id}`,
    );
}

async function refusal(write: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  expect(error.status).toBe(400);
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });
}

/** Waits until exactly `count` backends of this database wait for a lock another backend holds. */
async function waitForBlocked(count: number): Promise<void> {
  // `Date` is faked in this file, so the deadline is measured on the monotonic clock.
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    if (rows[0]?.waiting === count) return;
    if (performance.now() > deadline) throw new Error(`Expected ${count} waiting backends`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `hold` in a transaction that stays open and, once it holds its locks, starts the `contenders` in order, each
 * only after the one before it waits for a lock. When the last one waits, the holding transaction runs `beforeCommit`,
 * when given, and commits. Returns what each contender settled with (its value, or the error it rejected with) after
 * every transaction has ended; a failure of the holding transaction or of a wait is thrown after that.
 */
async function whileHolding(
  hold: Parameters<typeof withTransaction<void>>[1],
  contenders: Array<() => Promise<unknown>>,
  beforeCommit?: Parameters<typeof withTransaction<void>>[1],
): Promise<unknown[]> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding: () => void = () => undefined;
  const isHolding = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const holder: Promise<Error | null> = runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      await hold(client);
      holding();
      await held;
      await beforeCommit?.(client);
    }),
  ).then(
    () => null,
    (error: unknown) => asError(error),
  );
  const settled: Promise<unknown>[] = [];
  let waitFailure: Error | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      isHolding,
      holder.then((error) => Promise.reject(error ?? new Error("The holding transaction ended before holding"))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The holding transaction did not start")), WAIT_MS);
      }),
    ]);
    for (const contender of contenders) {
      settled.push(
        contender().then(
          (value) => value,
          (error: unknown) => error,
        ),
      );
      await waitForBlocked(settled.length);
    }
  } catch (error) {
    waitFailure = asError(error);
  } finally {
    clearTimeout(timer);
    release();
  }
  const holderError = await holder;
  const results = await Promise.all(settled);
  if (holderError !== null) throw holderError;
  if (waitFailure !== null) throw waitFailure;
  return results;
}

describe("POST /api/tasks/series/:seriesId/occurrences/:date (issue #1720)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    tasksId = await tasksDatabaseId(tenant);
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

  it("stores a future occurrence as done, and a second identical POST returns that item and stores nothing new", async () => {
    const { seriesId, currentId } = await series();
    const first = await post(seriesId, "2026-10-20", { status: "done" });
    expect(first.status).toBe(201);
    expect(first.item.properties).toMatchObject({
      name: "Stretch",
      status: "done",
      date: "2026-10-20",
      occurrenceDate: "2026-10-20",
      seriesId,
      completedOn: TODAY,
    });
    expect((await stored(first.item.id)).properties).toMatchObject({ status: "done", occurrenceDate: "2026-10-20" });

    const second = await post(seriesId, "2026-10-20", { status: "done" });
    expect(second.status).toBe(200);
    expect(second.item.id).toBe(first.item.id);
    // The occurrence ahead of the current one was completed without a next occurrence, and the series did not move.
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "notDone" },
      { id: first.item.id, occurrenceDate: "2026-10-20", status: "done" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId }]);
  });

  it("makes the projection return the stored item instead of a virtual occurrence for that date", async () => {
    const { seriesId } = await series();
    expect(await projected("2026-10-19", "2026-10-21")).toEqual([
      "2026-10-19 virtual:notDone",
      "2026-10-20 virtual:notDone",
      "2026-10-21 virtual:notDone",
    ]);
    const response = await post(seriesId, "2026-10-20", { status: "done" });
    expect(await projected("2026-10-19", "2026-10-21")).toEqual([
      "2026-10-19 virtual:notDone",
      `2026-10-20 ${response.item.id}`,
      "2026-10-21 virtual:notDone",
    ]);
  });

  it("moves only that occurrence for a body with date and timeFrom, whether it is created or already stored", async () => {
    const { seriesId, currentId } = await series();
    const other = (await post(seriesId, "2026-10-18", {})).item.id;
    const before = [await seriesRow(seriesId), await stored(currentId), await stored(other)];

    const moved = await post(seriesId, "2026-10-17", { date: "2026-10-19", timeFrom: "8:00" });
    expect(moved.status).toBe(201);
    expect(moved.item.properties).toMatchObject({
      status: "notDone",
      date: "2026-10-19",
      occurrenceDate: "2026-10-17",
      timeFrom: "08:00",
      time: "08:00",
    });
    expect([await seriesRow(seriesId), await stored(currentId), await stored(other)]).toEqual(before);

    const again = await post(seriesId, "2026-10-17", { timeFrom: "09:00", timeTo: "10:00" });
    expect(again.status).toBe(200);
    expect(again.item.id).toBe(moved.item.id);
    expect((await stored(moved.item.id)).properties).toMatchObject({
      date: "2026-10-19",
      occurrenceDate: "2026-10-17",
      timeFrom: "09:00",
      timeTo: "10:00",
    });
    expect([await seriesRow(seriesId), await stored(currentId), await stored(other)]).toEqual(before);
  });

  it("stores a past virtual occurrence the projection shows as missed as done and stores no other occurrence", async () => {
    const { seriesId, currentId } = await series({ preset: "daily" }, {}, "2026-10-12");
    expect(await projected("2026-10-14", "2026-10-14")).toEqual(["2026-10-14 virtual:missed"]);
    const response = await post(seriesId, "2026-10-14", { status: "done", completedOn: "2026-10-14" });
    expect(response.status).toBe(201);
    expect(response.item.properties).toMatchObject({
      status: "done",
      date: "2026-10-14",
      occurrenceDate: "2026-10-14",
      completedOn: "2026-10-14",
    });
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: "2026-10-12", status: "notDone" },
      { id: response.item.id, occurrenceDate: "2026-10-14", status: "done" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId }]);
  });

  it("completes a stored missed occurrence in place and stores no other occurrence", async () => {
    const { seriesId, currentId } = await series({ preset: "daily" }, {}, "2026-10-12");
    // The nightly job stores `missed`; this is its system write.
    const missed = await runInTenant(tenant, () =>
      createSeriesOccurrence(pool, {
        databaseId: tasksId,
        seriesId,
        occurrenceDate: "2026-10-15",
        status: "missed",
      }),
    );
    const response = await post(seriesId, "2026-10-15", { status: "done" });
    expect(response.status).toBe(200);
    expect(response.item.id).toBe(missed);
    expect((await stored(missed)).properties).toMatchObject({ status: "done", completedOn: TODAY });
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: "2026-10-12", status: "notDone" },
      { id: missed, occurrenceDate: "2026-10-15", status: "done" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId }]);
  });

  it("stores wontDo on a future occurrence without a next occurrence", async () => {
    const { seriesId, currentId } = await series();
    const response = await post(seriesId, "2026-10-20", { status: "wontDo" });
    expect(response.status).toBe(201);
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "notDone" },
      { id: response.item.id, occurrenceDate: "2026-10-20", status: "wontDo" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId }]);
  });

  it("advances the series once when the series' current occurrence is completed through the endpoint", async () => {
    const { seriesId, currentId } = await series();
    const response = await post(seriesId, TODAY, { status: "done" });
    expect(response.status).toBe(200);
    expect(response.item.id).toBe(currentId);
    const after = await occurrences(seriesId);
    expect(after).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "done" },
      { id: expect.any(String), occurrenceDate: "2026-10-17", status: "notDone" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: after[1]?.id }]);

    expect((await post(seriesId, TODAY, { status: "done" })).status).toBe(200);
    expect(await occurrences(seriesId)).toEqual(after);
  });

  it("writes the stored occurrence for a series id sent in upper case, and stores no second item for its date", async () => {
    const { seriesId, currentId } = await seriesWithLetterInId();
    const response = await post(seriesId.toUpperCase(), TODAY, { status: "done" });
    expect(response.status).toBe(200);
    expect(response.item.id).toBe(currentId);
    // The item the series row points at was completed, so the series advanced; no item carries the upper-case id.
    const after = await occurrences(seriesId);
    expect(after).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "done" },
      { id: expect.any(String), occurrenceDate: "2026-10-17", status: "notDone" },
    ]);
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: after[1]?.id }]);
    expect(await occurrences(seriesId.toUpperCase())).toEqual([]);
  });

  it("stores a virtual occurrence under the series' stored id for a series id sent in upper case, and finds it again by either form", async () => {
    const { seriesId, currentId } = await seriesWithLetterInId();
    const upper = seriesId.toUpperCase();
    const created = await post(upper, "2026-10-20", {});
    expect(created.status).toBe(201);
    expect(created.item.properties).toMatchObject({ seriesId, occurrenceDate: "2026-10-20", status: "notDone" });
    expect(await projected("2026-10-20", "2026-10-20", seriesId)).toEqual([`2026-10-20 ${created.item.id}`]);

    const lower = await post(seriesId, "2026-10-20", {});
    expect(lower.status).toBe(200);
    expect(lower.item.id).toBe(created.item.id);
    const again = await post(upper, "2026-10-20", { status: "done" });
    expect(again.status).toBe(200);
    expect(again.item.id).toBe(created.item.id);
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "notDone" },
      { id: created.item.id, occurrenceDate: "2026-10-20", status: "done" },
    ]);
    expect(await occurrences(upper)).toEqual([]);
  });

  it("creates the item as a copy of the series template for an empty body, and returns it unchanged the second time", async () => {
    const { seriesId, currentId } = await series(
      { preset: "daily" },
      { timeFrom: "07:30", timeTo: "08:00", notifications: true, flagged: true, description: "Ten minutes" },
    );
    // The current occurrence is edited on its own, so the template and the current occurrence differ.
    await runInTenant(tenant, () =>
      cp.updateItem({
        databaseId: tasksId,
        itemId: currentId,
        propertiesPatch: { timeFrom: "09:30", timeTo: "10:00", flagged: false },
      }),
    );
    const response = await post(seriesId, "2026-10-18", {});
    expect(response.status).toBe(201);
    expect(response.item.properties).toMatchObject({
      name: "Stretch",
      timeFrom: "07:30",
      timeTo: "08:00",
      notifications: true,
      flagged: true,
      description: "Ten minutes",
      status: "notDone",
      date: "2026-10-18",
      occurrenceDate: "2026-10-18",
      seriesId,
    });
    const before = await stored(response.item.id);
    expect(before.properties).toEqual(response.item.properties);

    const again = await post(seriesId, "2026-10-18", {});
    expect(again.status).toBe(200);
    expect(again.item.id).toBe(response.item.id);
    expect(await stored(response.item.id)).toEqual(before);
  });

  it("creates the item without a name when the series template has none", async () => {
    const untitled = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { date: TODAY } }),
    );
    const started = await runInTenant(tenant, () =>
      createTaskRecurrenceSetRouteHandler(pool)({ params: { id: untitled.id }, body: { preset: "daily" }, identity }),
    );
    const seriesId = started.item.properties.seriesId;
    if (typeof seriesId !== "string") throw new Error("No series id");
    expect(await seriesRow(seriesId)).toMatchObject([{ template: { name: null } }]);

    const response = await post(seriesId, "2026-10-20", { status: "done" });
    expect(response.status).toBe(201);
    const { properties } = await stored(response.item.id);
    expect(Object.hasOwn(properties, "name")).toBe(false);
    expect(properties).toMatchObject({ status: "done", occurrenceDate: "2026-10-20", seriesId });
  });

  it("accepts a date a floating rule gives from the anchor and refuses one between two of them", async () => {
    const { seriesId, currentId } = await series({ mode: "floating", rule: { unit: "days", n: 3 } });
    expect((await refusal(post(seriesId, "2026-10-18", {}))).details).toEqual({ field: "occurrenceDate" });
    const response = await post(seriesId, "2026-10-19", {});
    expect(response.status).toBe(201);
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "notDone" },
      { id: response.item.id, occurrenceDate: "2026-10-19", status: "notDone" },
    ]);
  });

  it.each([
    ["a day the weekly rule does not give", "2026-10-17"],
    ["a rule day before the anchor date", "2026-10-09"],
    ["a day that does not exist", "2026-02-30"],
    ["a date in another format", "16-10-2026"],
    ["a word", "tomorrow"],
  ])("refuses %s with 400 on occurrenceDate and stores nothing", async (_label, date) => {
    const { seriesId, currentId } = await series({ preset: "weekly" });
    const before = [await occurrences(seriesId), await stored(currentId)];
    expect((await refusal(post(seriesId, date, { status: "done" }))).details).toEqual({ field: "occurrenceDate" });
    expect([await occurrences(seriesId), await stored(currentId)]).toEqual(before);
  });

  it("refuses a stored occurrence whose date the rule does not give, and leaves it unchanged", async () => {
    const { seriesId } = await series({ preset: "weekly" });
    // An occurrence on a Saturday of a Friday series. A stored occurrence is off the dates this route accepts after a
    // rule change, when the series was started on a date its rule does not give, and when a floating series advanced
    // from a completion day that is not a whole number of intervals after the anchor date.
    const offRule = await runInTenant(tenant, () =>
      createSeriesOccurrence(pool, {
        databaseId: tasksId,
        seriesId,
        occurrenceDate: "2026-10-17",
        status: "notDone",
      }),
    );
    const before = await stored(offRule);
    expect((await refusal(post(seriesId, "2026-10-17", { status: "done" }))).details).toEqual({
      field: "occurrenceDate",
    });
    expect(await stored(offRule)).toEqual(before);
  });

  it.each([
    ["name", { name: "Other" }],
    ["flagged", { flagged: true }],
    ["occurrenceDate", { occurrenceDate: "2026-10-21" }],
    ["seriesId", { seriesId: "9b2f6f0e-6d7b-4c58-9a51-0c1d2e3f4a5b" }],
    ["status", { status: "missed" }],
    ["status", { status: "finished" }],
    ["status", { status: 1 }],
    ["status", { status: null }],
    ["body", []],
    ["body", null],
    ["body", "done"],
  ])("refuses a body that fails on %s with 400 on that field and stores nothing", async (field, body) => {
    const { seriesId } = await series();
    const before = await occurrences(seriesId);
    expect((await refusal(post(seriesId, "2026-10-20", body))).details).toEqual({ field });
    expect(await occurrences(seriesId)).toEqual(before);
  });

  it.each([
    ["an unreadable start", { timeFrom: "25:99" }, "timeFrom"],
    ["an end before the start", { timeFrom: "10:00", timeTo: "09:00" }, "timeTo"],
    ["a completion day in the future", { status: "done", completedOn: "2026-10-20" }, "completedOn"],
    ["a completion day without done", { completedOn: TODAY }, "completedOn"],
    ["a cleared date", { date: null }, "date"],
    ["a date that does not exist", { date: "2026-02-30" }, "date"],
  ])("rolls the new item back when the Tasks write refuses %s", async (_label, body, field) => {
    const { seriesId } = await series();
    const before = await occurrences(seriesId);
    expect((await refusal(post(seriesId, "2026-10-20", body))).details).toEqual({ field });
    expect(await occurrences(seriesId)).toEqual(before);
    expect(await projected("2026-10-20", "2026-10-20")).toEqual(["2026-10-20 virtual:notDone"]);
  });

  it("answers an unknown and a turned-off series with not found, and a malformed series id with 400", async () => {
    await expect(post(randomUUID(), "2026-10-20", {})).rejects.toBeInstanceOf(NotFoundError);
    expect((await refusal(post("nope", "2026-10-20", {}))).details).toEqual({ field: "seriesId" });

    const { seriesId, currentId } = await series();
    await runInTenant(tenant, () =>
      createTaskRecurrenceClearRouteHandler(pool)({ params: { id: currentId }, body: undefined, identity }),
    );
    await expect(post(seriesId, "2026-10-20", { status: "done" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await occurrences(seriesId)).toEqual([]);
  });

  it("answers another tenant's series like an unknown one and stores nothing in either tenant", async () => {
    const { seriesId, currentId } = await series();
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool, createViewTypeRegistry()));
    const outcome = (id: string) =>
      post(id, "2026-10-20", { status: "done" }, other).then(
        () => "stored",
        (error: unknown) =>
          error instanceof ChokePointError ? { status: error.status, code: error.code } : asError(error),
      );
    const foreign = await outcome(seriesId);
    expect(foreign).toEqual({ status: 404, code: "not_found" });
    expect(foreign).toEqual(await outcome(randomUUID()));
    expect(await occurrences(seriesId)).toEqual([{ id: currentId, occurrenceDate: TODAY, status: "notDone" }]);
    expect(await occurrences(seriesId, other)).toEqual([]);
    // The owner's own request for the same date is served, so the refusal above came from the tenant boundary.
    expect((await post(seriesId, "2026-10-20", { status: "done" })).status).toBe(201);
  });

  it("answers a tenant without a Tasks database with not found", async () => {
    const { seriesId } = await series();
    const bare = await createTestTenant(admin);
    await expect(post(seriesId, "2026-10-20", {}, bare)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ["anchor date", "UPDATE task_recurrence SET anchor_date = NULL WHERE series_id = $1::uuid"],
    ["template", "UPDATE task_recurrence SET template = NULL WHERE series_id = $1::uuid"],
  ])("fails without a domain error and stores nothing for a series row without its %s", async (_label, corrupt) => {
    const { seriesId } = await series();
    // Raw SQL: the store writes a series' id, anchor date and template together, so no write path leaves one null.
    await runInTenant(tenant, () => pool.query(corrupt, [seriesId]));
    const before = await occurrences(seriesId);
    const error: unknown = await post(seriesId, "2026-10-20", {}).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(await occurrences(seriesId)).toEqual(before);
  });

  it("stores one item when two requests for the same virtual occurrence run at once, and refuses the other with 409", async () => {
    const { seriesId, currentId } = await series();
    // Both requests look for the occurrence, find none and wait for the series row; one creates it, the other
    // reads it under the lock it got second.
    const request = () => post(seriesId, "2026-10-20", { status: "done" });
    const results = await whileHolding(
      async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      },
      [request, request],
    );
    const refused = results.filter((result) => result instanceof ConflictError);
    const served = results.filter((result) => !(result instanceof Error));
    expect(refused).toHaveLength(1);
    expect(served).toMatchObject([{ status: 201, item: { properties: { occurrenceDate: "2026-10-20" } } }]);
    expect(await occurrences(seriesId)).toEqual([
      { id: currentId, occurrenceDate: TODAY, status: "notDone" },
      { id: expect.any(String), occurrenceDate: "2026-10-20", status: "done" },
    ]);
    // The refused request can be repeated: it now finds the stored item.
    expect((await post(seriesId, "2026-10-20", { status: "done" })).status).toBe(200);
  });

  it("has a series edit refused that waited for the series row while the request stored an open occurrence, and a repeated edit reaches it", async () => {
    const { seriesId, currentId } = await series();
    const edit = () =>
      runInTenant(tenant, () =>
        createTaskSeriesPatchRouteHandler(pool)({ params: { seriesId }, body: { timeFrom: "08:00" }, identity }),
      );
    // The request finds no item for the date and waits for the held series row. The edit starts after it, locks the
    // current occurrence and the open occurrences stored so far, and waits for the row behind the request:
    // PostgreSQL gives a row lock to its waiters in the order they came. The request then stores an item the edit
    // has not locked, from the template the edit is about to replace.
    const results = await whileHolding(
      async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      },
      [() => post(seriesId, "2026-10-20", {}), edit],
    );
    expect(results[0]).toMatchObject({ status: 201, item: { properties: { occurrenceDate: "2026-10-20" } } });
    expect(results[1]).toBeInstanceOf(ConflictError);
    // The refused edit wrote nothing: the template and both open occurrences have no start time.
    const [, created] = await occurrences(seriesId);
    if (!created) throw new Error("The request stored no occurrence");
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId, template: { timeFrom: null } }]);
    expect((await stored(currentId)).properties.timeFrom ?? null).toBeNull();
    expect((await stored(created.id)).properties.status).toBe("notDone");
    expect((await stored(created.id)).properties.timeFrom ?? null).toBeNull();

    expect(await edit()).toMatchObject({ status: 200 });
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId, template: { timeFrom: "08:00" } }]);
    expect((await stored(currentId)).properties).toMatchObject({ timeFrom: "08:00" });
    expect((await stored(created.id)).properties).toMatchObject({ timeFrom: "08:00", date: "2026-10-20" });
  });

  it("creates the occurrence from the edited template when the request waited for the series row behind a series edit", async () => {
    const { seriesId, currentId } = await series();
    // The edit locks the current occurrence and waits for the held series row; the request starts after it and waits
    // for the row behind the edit. The edit commits the new template before the request reads it under the lock.
    const results = await whileHolding(
      async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      },
      [
        () =>
          runInTenant(tenant, () =>
            createTaskSeriesPatchRouteHandler(pool)({ params: { seriesId }, body: { timeFrom: "08:00" }, identity }),
          ),
        () => post(seriesId, "2026-10-20", {}),
      ],
    );
    expect(results[0]).toMatchObject({ status: 200 });
    expect(results[1]).toMatchObject({
      status: 201,
      item: { properties: { occurrenceDate: "2026-10-20", status: "notDone", timeFrom: "08:00" } },
    });
    expect(await seriesRow(seriesId)).toMatchObject([{ item_id: currentId, template: { timeFrom: "08:00" } }]);
    expect((await stored(currentId)).properties).toMatchObject({ timeFrom: "08:00" });
  });

  it("waits for a stored occurrence without holding the series row, which its holder then locks", async () => {
    const { seriesId } = await series();
    const occurrence = (await post(seriesId, "2026-10-20", {})).item.id;
    // The holder locks as a Tasks status write does: the occurrence, then the series row. Had the request taken the
    // series row before it waited for the occurrence, the two would deadlock and one of them would fail.
    const results = await whileHolding(
      async (client) => {
        await lockItemById(client, tasksId, occurrence);
      },
      [() => post(seriesId, "2026-10-20", { status: "done" })],
      async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      },
    );
    expect(results).toMatchObject([{ status: 200, item: { id: occurrence, properties: { status: "done" } } }]);
  });

  it("creates a new item when the stored occurrence is trashed while the request waits for its row", async () => {
    const { seriesId } = await series();
    const trashed = (await post(seriesId, "2026-10-20", {})).item.id;
    const results = await whileHolding(
      async (client) => {
        // Fixture SQL: the choke point trashes a series as a whole and turns its rule off (issue gh-1882), so the
        // occurrence is trashed on its own to reach the route's branch for an occurrence that left the live items.
        await client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [
          tasksId,
          trashed,
        ]);
      },
      [() => post(seriesId, "2026-10-20", { status: "done" })],
    );
    expect(results).toMatchObject([{ status: 201, item: { properties: { status: "done" } } }]);
    const live = (await occurrences(seriesId)).filter((row) => row.occurrenceDate === "2026-10-20");
    expect(live).toEqual([{ id: expect.any(String), occurrenceDate: "2026-10-20", status: "done" }]);
    expect(live[0]?.id).not.toBe(trashed);
  });

  it("answers not found and creates nothing when the series is trashed while the request waits for its row (issue gh-1882)", async () => {
    const { seriesId } = await series();
    const stored = (await post(seriesId, "2026-10-20", {})).item.id;
    const results = await whileHolding(
      async (client) => {
        await itemDeleteWithClient(client, tasksId, stored, { queueAffinity: createActionQueueAffinity() });
      },
      [() => post(seriesId, "2026-10-20", { status: "done" })],
    );
    expect(results[0]).toBeInstanceOf(NotFoundError);
    expect(await occurrences(seriesId)).toEqual([]);
  });

  it("answers not found when the occurrence leaves its series while the request waits for its row", async () => {
    const { seriesId, currentId } = await series();
    // The clear route locks the current occurrence and waits for the held series row; only then does the request
    // start, and it waits for the occurrence. Once released, the clear route turns the series off and takes the
    // occurrence out of it.
    const results = await whileHolding(
      async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      },
      [
        () =>
          runInTenant(tenant, () =>
            createTaskRecurrenceClearRouteHandler(pool)({ params: { id: currentId }, body: undefined, identity }),
          ),
        () => post(seriesId, TODAY, { status: "done" }),
      ],
    );
    expect(results[0]).toMatchObject({ status: 200 });
    expect(results[1]).toBeInstanceOf(NotFoundError);
    expect(await occurrences(seriesId)).toEqual([]);
    expect((await stored(currentId)).properties).toMatchObject({ status: "notDone", seriesId: null });
  });
});
