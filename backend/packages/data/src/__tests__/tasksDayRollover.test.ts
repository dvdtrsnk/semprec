import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { createTasksDayRolloverAction, TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasks/tasksDayRolloverAction.js";
import { createTaskRecurrenceSetRouteHandler } from "../tasks/taskRecurrenceRoutes.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const WAIT_MS = 10_000;
type RolloverOutcome = { ok: true } | { ok: false; error: unknown };
type RolloverActorRecord = {
  label: string;
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
  timedOut: boolean;
  consumed: boolean;
  primary?: { error: unknown };
};
/**
 * Every concurrent actor a test starts is tracked: one that is still pending, or that settled after its deadline, holds
 * a connection or a row lock, so the next test refuses to reset the database under it.
 */
const pendingRolloverActors = new Set<Promise<unknown>>();
const rolloverActorRecords = new Map<Promise<unknown>, RolloverActorRecord>();
function trackRolloverActor<T>(actor: Promise<T>): Promise<T> {
  const record: RolloverActorRecord = {
    label: `rollover actor ${rolloverActorRecords.size + 1}`,
    status: "pending",
    timedOut: false,
    consumed: false,
  };
  rolloverActorRecords.set(actor, record);
  pendingRolloverActors.add(actor);
  void actor.then(
    (value) => {
      record.status = "fulfilled";
      record.value = value;
      pendingRolloverActors.delete(actor);
    },
    (error: unknown) => {
      record.status = "rejected";
      record.error = error;
      pendingRolloverActors.delete(actor);
    },
  );
  return actor;
}
function rolloverActorDiagnostic(): AggregateError | undefined {
  const retained = [...rolloverActorRecords.values()].filter(
    (record) => record.timedOut || record.status === "pending",
  );
  if (!retained.length) return undefined;
  const details: unknown[] = [];
  const primaries = new Set<{ error: unknown }>();
  for (const record of retained) {
    if (record.primary && !primaries.has(record.primary)) {
      primaries.add(record.primary);
      details.push(record.primary.error);
    }
    if (record.status === "pending") details.push(new Error(`${record.label} remains pending`));
    else if (record.status === "rejected" && !record.consumed) details.push(record.error);
    else if (
      typeof record.value === "object" &&
      record.value !== null &&
      "ok" in record.value &&
      record.value.ok === false &&
      !record.consumed &&
      "error" in record.value
    )
      details.push(record.value.error);
    else details.push(new Error(`${record.label} settled after its deadline`));
  }
  return new AggregateError(details, "Prior rollover actor crossed its deadline; resources remain reserved");
}
async function settleRolloverActor<T>(actor: Promise<T>, primary?: { error: unknown }): Promise<T> {
  if (!rolloverActorRecords.has(actor)) void trackRolloverActor(actor);
  const record = rolloverActorRecords.get(actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      actor,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (record) {
            record.timedOut = true;
            record.primary = primary;
          }
          reject(new Error("Rollover actor did not settle"));
        }, WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Waits for `ready`; an actor that fails or ends first fails the wait with its own error. */
async function waitRolloverReady<T>(
  ready: Promise<T>,
  actors: Array<Promise<RolloverOutcome>>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      ready.then((value) => ({ kind: "ready" as const, value })),
      ...actors.map((actor) =>
        actor.then(
          (outcome) => ({ kind: "actor" as const, actor, outcome }),
          (error: unknown) => ({ kind: "error" as const, actor, error }),
        ),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), WAIT_MS);
      }),
    ]);
    if (winner.kind === "ready") return winner.value;
    const record = rolloverActorRecords.get(winner.actor);
    if (winner.kind === "error") {
      if (record) record.consumed = true;
      throw winner.error;
    }
    if (!winner.outcome.ok) {
      if (record) record.consumed = true;
      throw winner.outcome.error;
    }
    throw new Error("Actor ended before readiness");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Settles every actor within the deadline after `release`, and throws the test's own failure together with every actor
 * failure it has not already reported.
 */
async function settleActors(
  release: () => void,
  actors: Array<Promise<RolloverOutcome>>,
  failure: { error: unknown } | undefined,
): Promise<void> {
  release();
  const settled = await Promise.allSettled(actors.map((actor) => settleRolloverActor(actor, failure)));
  const errors: unknown[] = failure ? [failure.error] : [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") errors.push(result.reason);
    else if (!result.value.ok && !rolloverActorRecords.get(actors[index]!)?.consumed) errors.push(result.value.error);
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Rollover actors failed", { cause: errors[0] });
}

function outcomeOf(work: Promise<unknown>): Promise<RolloverOutcome> {
  return work.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type Identity = { pid: number; started: string };

async function identityOf(client: PoolClient): Promise<Identity> {
  const result = await client.query<Identity>(
    "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
  );
  if (!result.rows[0]) throw new Error("Missing actor identity");
  return result.rows[0];
}

/**
 * A tracked transaction that runs `hold` and then stays open until `release`; `ready` answers its backend once `hold`
 * has run.
 */
function holdTransaction(hold: (client: PoolClient) => Promise<unknown>) {
  const gate = deferred();
  const ready = deferred<Identity>();
  const actor = trackRolloverActor(
    outcomeOf(
      inTenant(() =>
        withTransaction(pool, async (client) => {
          const identity = await identityOf(client);
          await hold(client);
          ready.resolve(identity);
          await gate.promise;
        }),
      ),
    ),
  );
  return { actor, ready: ready.promise, release: () => gate.resolve() };
}

function lockRow(client: PoolClient, id: string): Promise<unknown> {
  return client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [tasksId, id]);
}

async function expectBackendLive(identity: Identity): Promise<void> {
  const { rows } = await admin.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
    [identity.pid, identity.started],
  );
  expect(rows).toEqual([{ present: true }]);
}

async function isBlocking(pid: number): Promise<boolean> {
  const { rows } = await admin.query<{ waiting: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
    [pid],
  );
  return rows[0]?.waiting === true;
}

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
let eventsId: string;
let today: DateTime;
let heartbeat: { id: string; projectItemId: string; config: Record<string, unknown> };

const day = (offset: number): string => today.plus({ days: offset }).toFormat("yyyy-MM-dd");

const itemRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function task(properties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: tasksId, properties: { name: "Task", ...properties } }))).id;
}

async function row(id: string): Promise<z.infer<typeof itemRow>> {
  return inTenant(async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text FROM items WHERE id = $1",
      [id],
    );
    return itemRow.parse(rows[0]);
  });
}

function setStatus(id: string, status: string): Promise<unknown> {
  return inTenant(() => cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { status } }));
}

function run(runtime: Pool = pool, options?: { recurringLimit: number }): Promise<void> {
  return inTenant(() =>
    createTasksDayRolloverAction(runtime, options)(heartbeat.config, {
      heartbeatId: heartbeat.id,
      projectItemId: heartbeat.projectItemId,
    }),
  );
}

/** Makes the task recurring through the route a user calls, and answers its series id. */
async function setRecurrence(id: string, preset: string): Promise<string> {
  const answer = await inTenant(() =>
    createTaskRecurrenceSetRouteHandler(pool)({
      params: { id },
      body: { preset },
      identity: { user: { id: randomUUID() } },
    }),
  );
  return z.string().parse(answer.item.properties.seriesId);
}

/** The live occurrences of a series. */
async function seriesItems(seriesId: string): Promise<Array<z.infer<typeof itemRow>>> {
  return inTenant(async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
      [tasksId, seriesId],
    );
    return z.array(itemRow).parse(rows);
  });
}

/** The series row: its current occurrence, rule and whether it is active. */
async function seriesRow(seriesId: string): Promise<{ item_id: string; rule: unknown; active: boolean } | undefined> {
  const { rows } = await inTenant(() =>
    pool.query<{ item_id: string; rule: unknown; active: boolean }>(
      "SELECT item_id, rule, active FROM task_recurrence WHERE series_id = $1",
      [seriesId],
    ),
  );
  return rows[0];
}

async function queuedJobs(): Promise<Array<{ id: string; key: string | null }>> {
  return (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
    .rows;
}

/** The one occurrence of the series besides `old`. */
async function nextOccurrence(seriesId: string, old: string): Promise<Record<string, unknown> | undefined> {
  const occurrences = await seriesItems(seriesId);
  expect(occurrences).toHaveLength(2);
  return occurrences.find((entry) => entry.id !== old)?.properties;
}

/** Synthetic state for properties no production writer sets yet, written directly as Tasks. */
async function setSystemProperties(ids: string[], properties: Record<string, unknown>): Promise<void> {
  await inTenant(async () => {
    const result = await pool.query(
      "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = ANY($2::uuid[])",
      [tasksId, ids, JSON.stringify(properties)],
    );
    expect(result.rowCount).toBe(ids.length);
  });
}

async function eventsDuring(work: () => Promise<unknown>): Promise<InvalidationEvent[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await work();
  } finally {
    setInvalidationHook(() => {});
  }
  return events;
}

/** The number of item invalidations per item id during `work`. */
async function invalidationsDuring(work: () => Promise<void>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const event of await eventsDuring(work)) {
    if (event.scope === "item") counts.set(event.itemId, (counts.get(event.itemId) ?? 0) + 1);
  }
  return counts;
}

/**
 * A weekly series begun on 2026-10-12 whose first occurrence was completed on 10-13 and reopened, so it is older than
 * the next occurrence the completion created; that next occurrence then gets the rule `preset`.
 */
async function reopenedSeries(preset: string): Promise<{ old: string; next: string; seriesId: string }> {
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  const old = await task({ date: "2026-10-12" });
  const seriesId = await setRecurrence(old, "weekly");
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
  await setStatus(old, "done");
  const next = (await seriesRow(seriesId))?.item_id;
  if (!next || next === old) throw new Error("Missing next occurrence");
  await setStatus(old, "notDone");
  await setRecurrence(next, preset);
  return { old, next, seriesId };
}

describe("the midnight Tasks rollover", () => {
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
    const unsafe = rolloverActorDiagnostic();
    if (unsafe) throw unsafe;
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    const databases = await inTenant(() => cp.listDatabases());
    tasksId = databases.find((database) => database.ownerModuleId === "tasks")?.id ?? "";
    eventsId = databases.find((database) => database.ownerModuleId === "events")?.id ?? "";
    const zone = await inTenant(() => withTransaction(pool, (client) => getSystemTimezone(client)));
    today = DateTime.now().setZone(zone).startOf("day");
    const { rows } = await inTenant(() =>
      pool.query<{ id: string; project_item_id: string; action_config: Record<string, unknown> }>(
        "SELECT id, project_item_id, action_config FROM project_heartbeats WHERE action_id = $1",
        [TASKS_DAY_ROLLOVER_ACTION_ID],
      ),
    );
    if (!rows[0]) throw new Error("The rollover heartbeat was not seeded");
    heartbeat = { id: rows[0].id, projectItemId: rows[0].project_item_id, config: rows[0].action_config };
  });

  afterAll(async () => {
    const unsafe = rolloverActorDiagnostic();
    if (unsafe) throw unsafe;
    setInvalidationHook(() => {});
    await pool?.end();
    await admin?.end();
  });

  it("moves a notDone task of yesterday 10:00-11:00 to today without times, with since yesterday", async () => {
    const id = await task({ date: day(-1), timeFrom: "10:00", timeTo: "11:00" });
    await run();
    expect((await row(id)).properties).toMatchObject({
      date: day(0),
      timeFrom: null,
      timeTo: null,
      time: null,
      since: day(-1),
      sinceTime: { from: "10:00", to: "11:00" },
    });
  });

  it("keeps the first planned day when a task that already moved is moved again (relative days, not a clock advance)", async () => {
    const id = await task({ date: day(-3), timeFrom: "10:00", timeTo: "11:00" });
    // A user moving it to yesterday records the first planned day, as an earlier night's move would have.
    await inTenant(() =>
      cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { date: day(-1) } }, undefined, undefined, {
        writerKind: "user",
      }),
    );
    expect((await row(id)).properties.since).toBe(day(-3));
    await run();
    expect((await row(id)).properties).toMatchObject({ date: day(0), since: day(-3) });
  });

  it("changes nothing on a second run the same day, and after a three-day outage writes today once", async () => {
    const id = await task({ date: day(-3) });
    let moved: z.infer<typeof itemRow> | undefined;
    const counts = await invalidationsDuring(async () => {
      await run();
      moved = await row(id);
      expect(moved.properties).toMatchObject({ date: day(0), since: day(-3) });
      await run();
    });
    expect(await row(id)).toEqual(moved);
    expect(counts.get(id)).toBe(1);
  });

  it("does not move a done, wontDo, deleted, recurring, undated, current or hidden task, nor one completed in an event", async () => {
    const done = await task({ date: day(-2), status: "done" });
    const wontDo = await task({ date: day(-2), status: "wontDo" });
    const deleted = await task({ date: day(-2) });
    await inTenant(() => cp.softDeleteItem(tasksId, deleted));
    const recurring = await task({ date: day(-2) });
    await setRecurrence(recurring, "weekly");
    const undated = await task({});
    const current = await task({ date: day(0) });
    const hidden = await task({ date: day(-2) });
    await setSystemProperties([hidden], { hiddenUntil: today.plus({ days: 1 }).toISO() });
    const completedInEvent = await task({ date: day(-2) });
    await inTenant(() =>
      withTransaction(pool, async (client) => {
        const event = await createItemWithClient(client, {
          databaseId: eventsId,
          properties: { name: "Workshop", date: day(-2) },
        });
        const property = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'completedInEvent'",
          [tasksId],
        );
        // Synthetic edge: its producer is not built yet.
        await createRelationWithClient(
          client,
          { relationPropertyId: property.rows[0]!.id, callerItemId: completedInEvent, targetItemId: event.id },
          { ownerProcess: "tasks" },
        );
      }),
    );
    const ids = [done, wontDo, deleted, recurring, undated, current, hidden, completedInEvent];
    const before = await Promise.all(ids.map(row));
    await run();
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });

  it("marks a daily occurrence missed and creates today's occurrence exactly once", async () => {
    const id = await task({ date: day(-1) });
    const seriesId = await setRecurrence(id, "daily");
    await run();
    expect((await row(id)).properties).toMatchObject({ status: "missed", date: day(-1) });
    expect(await nextOccurrence(seriesId, id)).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
    const state = await seriesItems(seriesId);
    await run();
    expect(await seriesItems(seriesId)).toEqual(state);
  });

  it("rolls over only the active tenant while another tenant has a due series", async () => {
    const foreign = await createTestTenant(admin);
    const foreignItem = await runInTenant(foreign, async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const database = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "tasks");
      if (!database) throw new Error("Missing foreign Tasks database");
      const item = await cp.createItem({ databaseId: database.id, properties: { name: "Foreign", date: day(-8) } });
      await createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: item.id },
        body: { preset: "weekly" },
        identity: { user: { id: randomUUID() } },
      });
      return item.id;
    });
    const localItem = await task({ date: day(-8) });
    await setRecurrence(localItem, "weekly");
    const foreignState = () =>
      runInTenant(foreign, async () => ({
        items: (
          await pool.query<Record<string, unknown>>(
            "SELECT id, properties, updated_at::text, deleted_at::text FROM items ORDER BY id",
          )
        ).rows,
        series: (await pool.query<Record<string, unknown>>("SELECT * FROM task_recurrence ORDER BY series_id")).rows,
      }));
    const before = await foreignState();
    const invalidations = await invalidationsDuring(() => run());
    expect((await row(localItem)).properties.status).toBe("missed");
    expect(await foreignState()).toEqual(before);
    expect(invalidations.has(foreignItem)).toBe(false);
  });

  it("leaves a weekly occurrence open before its next day and catches up only to the latest weekly day", async () => {
    const notDue = await task({ date: day(-6) });
    await setRecurrence(notDue, "weekly");
    const before = await row(notDue);
    const overdue = await task({ date: day(-8) });
    const seriesId = await setRecurrence(overdue, "weekly");
    await run();
    expect(await row(notDue)).toEqual(before);
    expect((await row(overdue)).properties).toMatchObject({ status: "missed", date: day(-8) });
    expect(await nextOccurrence(seriesId, overdue)).toMatchObject({
      status: "notDone",
      date: day(-1),
      occurrenceDate: day(-1),
    });
    const occurrences = await seriesItems(seriesId);
    const seriesBeforeRepeat = await seriesRow(seriesId);
    const jobsBeforeRepeat = await queuedJobs();

    const repeatEvents = await eventsDuring(() => run());

    expect(await seriesRow(seriesId)).toEqual(seriesBeforeRepeat);
    expect(await queuedJobs()).toEqual(jobsBeforeRepeat);
    // The repeat writes nothing, so only the run's day announcement is sent.
    expect(repeatEvents).toEqual([{ scope: "overview" }]);
    expect(await seriesItems(seriesId)).toEqual(occurrences);
  });

  it("processes a higher-id due series behind lower-id nondue series within the selection limit", async () => {
    const ids = (
      await Promise.all([
        task({ date: day(-1) }),
        task({ date: day(-1) }),
        task({ date: day(-1) }),
        task({ date: day(-1) }),
      ])
    ).sort();
    const due = ids[3];
    for (const id of ids) await setRecurrence(id, id === due ? "daily" : "yearly");
    const before = await Promise.all(ids.slice(0, 3).map(row));
    await run(pool, { recurringLimit: 2 });
    expect((await row(due)).properties.status).toBe("missed");
    expect(await Promise.all(ids.slice(0, 3).map(row))).toEqual(before);
  });

  it("projects the locked current rule when an older reopened occurrence is processed first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { old, next: current, seriesId } = await reopenedSeries("monthly");
      vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
      // Hold the current occurrence so the full action's SKIP LOCKED pass must process the older one first.
      const held = holdTransaction((client) => lockRow(client, current));
      let action: Promise<RolloverOutcome> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        const holder = await waitRolloverReady(held.ready, [held.actor], "Rollover actor did not settle");
        await expectBackendLive(holder);
        action = trackRolloverActor(outcomeOf(run()));
        await expect.poll(async () => (await row(old)).properties.status, { timeout: WAIT_MS }).toBe("missed");
        let blocked: Array<{ pid: number; started: string; blockers: number[] }> = [];
        await expect
          .poll(
            async () => {
              blocked = (
                await admin.query<{ pid: number; started: string; blockers: number[] }>(
                  "SELECT pid, backend_start::text AS started, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT i.id FROM items i%'",
                  [holder.pid],
                )
              ).rows;
              return blocked.map((entry) => entry.blockers);
            },
            { timeout: WAIT_MS },
          )
          .toEqual([[holder.pid]]);
        expect(blocked).toEqual([{ pid: expect.any(Number), started: expect.any(String), blockers: [holder.pid] }]);
        expect(blocked[0]?.pid).not.toBe(holder.pid);
      } catch (error) {
        failure = { error };
      }
      await settleActors(held.release, [held.actor, ...(action ? [action] : [])], failure);
      const latest = (await seriesRow(seriesId))?.item_id;
      if (!latest || latest === old || latest === current) throw new Error("Missing new occurrence");
      const before = await row(latest);
      expect(before.properties).toMatchObject({
        occurrenceDate: "2026-11-19",
        recurrence: { preset: null, mode: "fixed", rule: { kind: "monthDates", dates: [19] } },
      });
      await run();
      expect(await row(latest)).toEqual(before);
      const noOp = await inTenant(() =>
        cp.updateItem({ databaseId: tasksId, itemId: latest, propertiesPatch: { recurrence: { preset: "monthly" } } }),
      );
      expect(noOp.properties.recurrence).toEqual(before.properties.recurrence);
      expect(await row(latest)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves a future current occurrence without waiting and retains its pointer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { old, next: future, seriesId } = await reopenedSeries("daily");
      vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
      const beforeOld = await row(old);
      const beforeFuture = await row(future);
      const jobs = await queuedJobs();
      const held = holdTransaction((client) => lockRow(client, future));
      let failure: { error: unknown } | undefined;
      try {
        await expectBackendLive(await waitRolloverReady(held.ready, [held.actor], "Rollover actor did not settle"));
        await expect(run()).rejects.toMatchObject({ code: "55P03" });
        expect(await row(old)).toEqual(beforeOld);
        expect(await row(future)).toEqual(beforeFuture);
        expect(await queuedJobs()).toEqual(jobs);
      } catch (error) {
        failure = { error };
      }
      await settleActors(held.release, [held.actor], failure);
      await run();
      expect((await row(old)).properties.status).toBe("missed");
      expect(await row(future)).toEqual(beforeFuture);
      expect((await seriesRow(seriesId))?.item_id).toBe(future);
      const ensured = (await seriesItems(seriesId)).filter((entry) => entry.properties.occurrenceDate === "2026-10-16");
      expect(ensured.map((entry) => entry.properties)).toEqual([
        expect.objectContaining({ status: "notDone", occurrenceDate: "2026-10-16" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back the current recurring batch when the existing latest occurrence is reserved", async () => {
    const old = await task({ date: day(-1) });
    const seriesId = await setRecurrence(old, "daily");
    // A pre-materialized latest occurrence is a historical fixture; this path does not make it current.
    const latest = await inTenant(() =>
      createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status: "notDone" }),
    );
    const beforeOld = await row(old);
    const beforeLatest = await row(latest);
    const beforeSeries = await seriesRow(seriesId);
    const beforeJobs = await queuedJobs();
    const held = holdTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Fixture SQL: the choke point trashes a whole series, so the latest occurrence is trashed on its own to hold its row lock.
      const trashed = await client.query(
        "UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL",
        [tasksId, latest],
      );
      if (trashed.rowCount !== 1) throw new Error("Latest occurrence was not trashed");
    });
    let failure: { error: unknown } | undefined;
    try {
      await expectBackendLive(await waitRolloverReady(held.ready, [held.actor], "Latest reservation timed out"));
      const events = await eventsDuring(() => expect(run()).rejects.toMatchObject({ code: "55P03" }));
      expect(await row(old)).toEqual(beforeOld);
      expect(await row(latest)).toEqual(beforeLatest);
      expect(await seriesRow(seriesId)).toEqual(beforeSeries);
      expect(await queuedJobs()).toEqual(beforeJobs);
      expect(events).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    await settleActors(held.release, [held.actor], failure);
    const trashed = await inTenant(() =>
      pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE database_id = $1 AND id = $2",
        [tasksId, latest],
      ),
    );
    expect(trashed.rows).toEqual([{ deleted: true }]);
    expect(await row(old)).toEqual(beforeOld);
  });

  it.each(["done", "wontDo", "missed"] as const)(
    "preserves an already materialized latest %s occurrence",
    async (status) => {
      const old = await task({ date: day(-1) });
      const seriesId = await setRecurrence(old, "daily");
      // Synthetic materialized terminal occurrence: normal completion owns the series advance.
      const latest = await inTenant(() =>
        createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status }),
      );
      const beforeLatest = await row(latest);
      await run();
      expect((await row(old)).properties.status).toBe("missed");
      expect(await row(latest)).toEqual(beforeLatest);
      expect((await seriesItems(seriesId)).map((entry) => entry.id).sort()).toEqual([old, latest].sort());
    },
  );

  it("replaces a trashed latest occurrence without restoring or modifying its history", async () => {
    const old = await task({ date: day(-1) });
    const seriesId = await setRecurrence(old, "daily");
    // A pre-materialized latest occurrence is a historical fixture; then trash it.
    const trashed = await inTenant(() =>
      createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status: "notDone" }),
    );
    // Fixture SQL: the choke point trashes a whole series, so the latest occurrence is trashed on its own.
    await admin.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [tasksId, trashed]);
    const beforeTrashed = await row(trashed);
    await run();
    expect(await row(trashed)).toEqual(beforeTrashed);
    expect((await row(old)).properties.status).toBe("missed");
    expect(await nextOccurrence(seriesId, old)).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
  });

  it("observes a concurrent completion before attempting a missed transition", async () => {
    const old = await task({ date: day(-1) });
    const seriesId = await setRecurrence(old, "daily");
    const actionPool = await createRuntimeRolePool(admin, "semprec_data");
    const held = holdTransaction((client) =>
      updateItemWithClient(
        client,
        { databaseId: tasksId, itemId: old, propertiesPatch: { status: "done" } },
        { writer: { writerKind: "user" } },
      ),
    );
    const competing = deferred<Identity>();
    let contender: Promise<RolloverOutcome> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const owner = await waitRolloverReady(held.ready, [held.actor], "Actor readiness timed out");
      contender = trackRolloverActor(
        outcomeOf(
          inTenant(async () => {
            const client = await actionPool.connect();
            let own: Identity;
            try {
              own = await identityOf(client);
            } catch (error) {
              client.release(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
            // Scoped checkout resets its GUC asynchronously; wait for this exact client to return to the pool.
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                actionPool.off("release", onRelease);
                reject(new Error("Action client did not return to its pool"));
              }, WAIT_MS);
              const onRelease = (error: Error | undefined, returned: PoolClient) => {
                if (returned !== client) return;
                clearTimeout(timer);
                actionPool.off("release", onRelease);
                if (error) reject(error);
                else resolve();
              };
              actionPool.on("release", onRelease);
              client.release();
            });
            competing.resolve(own);
            await run(actionPool);
          }),
        ),
      );
      const waiter = await waitRolloverReady(competing.promise, [held.actor, contender], "Actor readiness timed out");
      await expect
        .poll(
          async () => {
            const result = await admin.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity w ON w.pid = $3
               WHERE h.pid = $1 AND h.backend_start = $2::timestamptz AND w.backend_start = $4::timestamptz
                 AND $1::int = ANY(pg_blocking_pids(w.pid))) AS blocked`,
              [owner.pid, owner.started, waiter.pid, waiter.started],
            );
            return result.rows[0]?.blocked;
          },
          { timeout: WAIT_MS },
        )
        .toBe(true);
    } catch (error) {
      failure = { error };
    }
    try {
      await settleActors(held.release, [held.actor, ...(contender ? [contender] : [])], failure);
    } finally {
      // An actor that stays pending still uses the action pool, so the pool stays open for the diagnostic.
      if (!pendingRolloverActors.size) await actionPool.end();
    }
    expect((await row(old)).properties.status).toBe("done");
    expect(await nextOccurrence(seriesId, old)).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
  });

  it("moves a task whose event ended yesterday, with since yesterday", async () => {
    const id = await task({ date: day(-3) });
    // Synthetic Tasks values: no writer sets the event-derived day and event end yet.
    await setSystemProperties([id], { effectiveDate: day(-1), hiddenUntil: today.minus({ hours: 1 }).toISO() });
    await run();
    expect((await row(id)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });

  it("sends one invalidation without an acting user for every moved task and none for an unmoved one", async () => {
    const moved = [await task({ date: day(-1) }), await task({ date: day(-2) })];
    const kept = await task({ date: day(0) });
    const items = (await eventsDuring(() => run())).filter((event) => event.scope === "item");
    for (const id of moved) {
      expect(items.filter((event) => event.itemId === id)).toEqual([
        expect.objectContaining({ scope: "item", op: "update", databaseId: tasksId, itemId: id, userId: undefined }),
      ]);
    }
    expect(items.filter((event) => event.itemId === kept)).toEqual([]);
  });

  /**
   * Starts the run while another transaction holds `locked`, waits until the run's second pass waits for that row,
   * runs `whileBlocked`, then releases the row; answers the item invalidation counts of the whole run.
   */
  async function runWhileRowHeld(locked: string, whileBlocked: () => Promise<void>): Promise<Map<string, number>> {
    const held = holdTransaction((client) => lockRow(client, locked));
    let counts = new Map<string, number>();
    let rollover: Promise<RolloverOutcome> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const holder = await waitRolloverReady(held.ready, [held.actor], "The holder did not lock the row");
      rollover = trackRolloverActor(
        outcomeOf(
          invalidationsDuring(() => run()).then((result) => {
            counts = result;
          }),
        ),
      );
      await expect.poll(() => isBlocking(holder.pid), { timeout: WAIT_MS }).toBe(true);
      await whileBlocked();
    } catch (error) {
      failure = { error };
    }
    await settleActors(held.release, [held.actor, ...(rollover ? [rollover] : [])], failure);
    return counts;
  }

  it("moves a row another transaction holds during the first pass by the end of the same run", async () => {
    const locked = await task({ date: day(-1) });
    const free = await task({ date: day(-1) });
    await runWhileRowHeld(locked, async () => {
      // The first pass skipped the held row and committed the free one before the second pass started waiting.
      expect((await row(free)).properties.date).toBe(day(0));
      expect((await row(locked)).properties.date).toBe(day(-1));
    });
    expect((await row(locked)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });

  describe("a task with a stale effectiveDate (synthetic: the stale value is written directly)", () => {
    it("moves it once: one invalidation, and a second run the same day writes nothing", async () => {
      const id = await task({ date: day(-3) });
      await setSystemProperties([id], { effectiveDate: day(-2), hiddenUntil: today.minus({ hours: 1 }).toISO() });
      const first = await invalidationsDuring(() => run());
      const moved = await row(id);
      // The Tasks transform stores the effective day with the new date, so the task is not selected again.
      expect(moved.properties).toMatchObject({ date: day(0), timeFrom: null, timeTo: null, effectiveDate: day(0) });
      expect(first.get(id)).toBe(1);
      const second = await invalidationsDuring(() => run());
      expect(second.get(id)).toBeUndefined();
      expect(await row(id)).toEqual(moved);
    });

    it("clears the times of a task dated today once, then leaves it alone", async () => {
      const id = await task({ date: day(0), timeFrom: "10:00", timeTo: "11:00" });
      await setSystemProperties([id], { effectiveDate: day(-1) });
      const first = await invalidationsDuring(() => run());
      const moved = await row(id);
      expect(moved.properties).toMatchObject({ date: day(0), timeFrom: null, timeTo: null, time: null });
      expect(first.get(id)).toBe(1);
      const second = await invalidationsDuring(() => run());
      expect(second.size).toBe(0);
      expect(await row(id)).toEqual(moved);
    });

    it("moves 101 of them and a row held during the first pass, each exactly once, in one run", async () => {
      const stale: string[] = [];
      for (let index = 0; index < 101; index++) stale.push(await task({ date: day(-2) }));
      await setSystemProperties(stale, { effectiveDate: day(-1) });
      const locked = await task({ date: day(-1) });
      const counts = await runWhileRowHeld(locked, async () => {
        // The second pass waits for the held row only: every stale task already moved and stopped qualifying.
        expect((await Promise.all(stale.map(row))).every((moved) => moved.properties.date === day(0))).toBe(true);
        expect((await row(locked)).properties.date).toBe(day(-1));
      });
      expect((await row(locked)).properties).toMatchObject({ date: day(0), since: day(-1) });
      expect(counts.size).toBe(102);
      expect([...counts.values()].every((count) => count === 1)).toBe(true);
      expect(counts.get(locked)).toBe(1);
      expect((await invalidationsDuring(() => run())).size).toBe(0);
    });
  });

  describe("the overview invalidation", () => {
    async function overviewEventsDuring(work: () => Promise<void>, watched?: string) {
      const overview: Array<{ event: InvalidationEvent; watchedDate: Promise<unknown> | null }> = [];
      const all: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        all.push(event);
        if (event.scope !== "overview") return;
        // A separate connection sees committed rows only, so the date it reads is the one the run left.
        overview.push({
          event,
          watchedDate:
            watched === undefined
              ? null
              : admin
                  .query<{ date: string | null }>("SELECT properties->>'date' AS date FROM items WHERE id = $1", [
                    watched,
                  ])
                  .then((result) => result.rows[0]?.date ?? null),
        });
      });
      try {
        await work();
      } finally {
        setInvalidationHook(() => {});
      }
      return { overview, all };
    }

    it("announces once, with no field but the scope and no acting user, after the tasks it moved have committed", async () => {
      const moved = await task({ date: day(-2) });
      const { overview, all } = await overviewEventsDuring(() => run(), moved);

      expect(overview.map((entry) => entry.event)).toEqual([{ scope: "overview" }]);
      expect(await overview[0]?.watchedDate).toBe(day(0));
      const lastItem = all.map((event) => event.scope).lastIndexOf("item");
      expect(lastItem).toBeGreaterThanOrEqual(0);
      expect(all.map((event) => event.scope).indexOf("overview")).toBeGreaterThan(lastItem);
    });

    it("announces once when no task moved", async () => {
      const kept = await task({ date: day(0) });
      const { overview, all } = await overviewEventsDuring(() => run());

      expect(overview.map((entry) => entry.event)).toEqual([{ scope: "overview" }]);
      expect(all.filter((event) => event.scope === "item" && event.itemId === kept)).toEqual([]);
    });

    it("announces once when the run only closed a missed occurrence of a recurring task", async () => {
      const first = await task({ date: day(-8) });
      await setRecurrence(first, "daily");
      const { overview } = await overviewEventsDuring(() => run());

      expect((await row(first)).properties.status).toBe("missed");
      expect(overview.map((entry) => entry.event)).toEqual([{ scope: "overview" }]);
    });

    it("announces nothing when a transaction of the run rolls back", async () => {
      await task({ date: day(-2), name: "overview poison" });
      // A trigger that rejects the rollover's write of one task: the only way to make a chunk of the run fail.
      await admin.query(`
        CREATE FUNCTION test_overview_rollover_poison() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.properties->>'name' = 'overview poison' THEN
            RAISE EXCEPTION 'simulated rollover failure';
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(
        "CREATE TRIGGER test_overview_rollover_poison BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION test_overview_rollover_poison()",
      );
      try {
        let failure: unknown = null;
        const { overview } = await overviewEventsDuring(() =>
          run().catch((err: unknown) => {
            failure = err;
          }),
        );

        expect(failure).toEqual(
          expect.objectContaining({ message: expect.stringContaining("simulated rollover failure") }),
        );
        expect(overview).toEqual([]);
      } finally {
        await admin.query("DROP TRIGGER test_overview_rollover_poison ON items");
        await admin.query("DROP FUNCTION test_overview_rollover_poison()");
      }
    });
  });
});
