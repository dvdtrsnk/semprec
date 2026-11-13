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
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
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
type RolloverActorRecord = {
  label: string;
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
  timedOut: boolean;
  consumed: boolean;
  primary?: { error: unknown };
};
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
async function settleRolloverActor<T>(
  actor: Promise<T>,
  primary?: { error: unknown },
  deadlineMs = WAIT_MS,
): Promise<T> {
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
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RolloverOutcome = { ok: true } | { ok: false; error: unknown };
async function waitRolloverReady<T>(
  ready: Promise<T>,
  actors: Array<Promise<RolloverOutcome>>,
  message: string,
  deadlineMs = WAIT_MS,
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
        timer = setTimeout(() => reject(new Error(message)), deadlineMs);
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

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
let eventsId: string;
/** The tenant's own today in its system time zone; dates are relative to it (no clock is faked). */
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

function run(): Promise<void> {
  return inTenant(() =>
    createTasksDayRolloverAction(pool)(heartbeat.config, {
      heartbeatId: heartbeat.id,
      projectItemId: heartbeat.projectItemId,
    }),
  );
}

/** Synthetic state for a property no production writer sets yet (#1780 and #1798 will): written directly as Tasks. */
async function setSystemProperties(id: string, properties: Record<string, unknown>): Promise<void> {
  await inTenant(async () => {
    const result = await pool.query(
      "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
      [tasksId, id, JSON.stringify(properties)],
    );
    expect(result.rowCount).toBe(1);
  });
}

/** Synthetic `effectiveDate`/`hiddenUntil` for many tasks at once, as `setSystemProperties` does for one. */
async function setSystemPropertiesMany(ids: string[], properties: Record<string, unknown>): Promise<void> {
  await inTenant(async () => {
    const result = await pool.query(
      "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = ANY($2::uuid[])",
      [tasksId, ids, JSON.stringify(properties)],
    );
    expect(result.rowCount).toBe(ids.length);
  });
}

/** The item invalidations a run sends, per item id. */
async function invalidationsDuring(work: () => Promise<void>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  setInvalidationHook((event) => {
    if (event.scope === "item") counts.set(event.itemId, (counts.get(event.itemId) ?? 0) + 1);
  });
  try {
    await work();
  } finally {
    setInvalidationHook(() => {});
  }
  return counts;
}

describe("the midnight Tasks rollover (issue #1674)", () => {
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

  it("retains a rollover actor failure after readiness timeout", async () => {
    const never = new Promise<never>(() => {});
    type Outcome = { ok: true } | { ok: false; error: unknown };
    let finish: (value: Outcome) => void = () => {};
    const actor = trackRolloverActor(
      new Promise<Outcome>((resolve) => {
        finish = resolve;
      }),
    );
    let finishPending: (value: Outcome) => void = () => {};
    const pendingActor = trackRolloverActor(
      new Promise<Outcome>((resolve) => {
        finishPending = resolve;
      }),
    );
    let earlyActor: Promise<Outcome> | undefined;
    try {
      const timeout = await waitRolloverReady(never, [actor], "readiness timeout", 1).then(
        () => null,
        (error: unknown) => error,
      );
      expect(timeout).toMatchObject({ message: "readiness timeout" });
      const late = new Error("late rollover actor");
      finish({ ok: false, error: late });
      await actor;
      const outcome = await settleRolloverActor(actor, { error: timeout }, 10);
      expect(outcome).toEqual({ ok: false, error: late });
      if (outcome.ok) throw new Error("Missing actor failure");
      const aggregate = new AggregateError([timeout, outcome.error], "finite settlement", { cause: timeout });
      expect(aggregate.cause).toBe(timeout);
      expect(aggregate.errors).toEqual([timeout, late]);
      expect(aggregate.errors[1]).toBe(late);
      expect(rolloverActorRecords.get(actor)?.consumed).toBe(false);

      const pendingTimeout = await waitRolloverReady(never, [pendingActor], "pending readiness timeout", 1).then(
        () => null,
        (error: unknown) => error,
      );
      await expect(settleRolloverActor(pendingActor, { error: pendingTimeout }, 1)).rejects.toThrow();
      expect(rolloverActorDiagnostic()?.errors[0]).toBe(pendingTimeout);
      expect(pendingRolloverActors.has(pendingActor)).toBe(true);
      const retained = new Error("retained rollover actor");
      finishPending({ ok: false, error: retained });
      await pendingActor;
      expect(rolloverActorDiagnostic()?.errors.find((error) => error === retained)).toBe(retained);
      const earlyError = new Error("early rollover actor");
      earlyActor = trackRolloverActor(Promise.resolve<Outcome>({ ok: false, error: earlyError }));
      const early = await waitRolloverReady(never, [earlyActor], "unused deadline", 1).then(
        () => null,
        (error: unknown) => error,
      );
      expect(early).toBe(earlyError);
      expect(rolloverActorRecords.get(earlyActor)?.consumed).toBe(true);
      const earlyOutcome = await settleRolloverActor(earlyActor, { error: timeout }, 10);
      const errors = [early];
      if (!earlyOutcome.ok && !rolloverActorRecords.get(earlyActor)?.consumed) errors.push(earlyOutcome.error);
      expect(errors).toEqual([earlyError]);
    } finally {
      finish({ ok: true });
      finishPending({ ok: true });
      await Promise.all([actor, pendingActor, earlyActor]);
      rolloverActorRecords.delete(actor);
      rolloverActorRecords.delete(pendingActor);
      if (earlyActor) rolloverActorRecords.delete(earlyActor);
    }
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
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await run();
      const moved = await row(id);
      expect(moved.properties).toMatchObject({ date: day(0), since: day(-3) });
      await run();
      expect(await row(id)).toEqual(moved);
    } finally {
      setInvalidationHook(() => {});
    }
    expect(events.filter((event) => event.scope === "item" && event.itemId === id)).toHaveLength(1);
  });

  it("does not move a done, wontDo, deleted, recurring, undated, current or hidden task, nor one completed in an event", async () => {
    const done = await task({ date: day(-2), status: "done" });
    const wontDo = await task({ date: day(-2), status: "wontDo" });
    const deleted = await task({ date: day(-2) });
    await inTenant(() => cp.softDeleteItem(tasksId, deleted));
    const recurring = await task({ date: day(-2) });
    await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: recurring },
        body: { preset: "weekly" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const undated = await task({});
    const current = await task({ date: day(0) });
    const hidden = await task({ date: day(-2) });
    await setSystemProperties(hidden, { hiddenUntil: today.plus({ days: 1 }).toISO() });
    const completedInEvent = await task({ date: day(-2) });
    await inTenant(() =>
      withTransaction(pool, async (client: PoolClient) => {
        const event = await createRelationTarget(client);
        const property = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'completedInEvent'",
          [tasksId],
        );
        // Synthetic edge: the Tasks module's process writes it; its producer is not built yet.
        await createRelationWithClient(
          client,
          { relationPropertyId: property.rows[0]!.id, callerItemId: completedInEvent, targetItemId: event },
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
    const created = await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id },
        body: { preset: "daily" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    await run();
    expect((await row(id)).properties).toMatchObject({ status: "missed", date: day(-1) });
    const state = await inTenant(() =>
      pool.query<{ id: string; properties: Record<string, unknown> }>(
        "SELECT id, properties FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
        [tasksId, created.item.properties.seriesId],
      ),
    );
    expect(state.rows).toHaveLength(2);
    expect(state.rows.find((item) => item.id !== id)?.properties).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
    await run();
    const again = await inTenant(() =>
      pool.query<{ id: string; properties: Record<string, unknown> }>(
        "SELECT id, properties FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
        [tasksId, created.item.properties.seriesId],
      ),
    );
    expect(again.rows).toEqual(state.rows);
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
    await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: localItem },
        body: { preset: "weekly" },
        identity: { user: { id: randomUUID() } },
      }),
    );
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
    const invalidations = await invalidationsDuring(run);
    expect((await row(localItem)).properties.status).toBe("missed");
    expect(await foreignState()).toEqual(before);
    expect(invalidations.has(foreignItem)).toBe(false);
  });

  it("leaves a weekly occurrence open before its next day and catches up only to the latest weekly day", async () => {
    const notDue = await task({ date: day(-6) });
    await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: notDue },
        body: { preset: "weekly" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const before = await row(notDue);
    const overdue = await task({ date: day(-8) });
    const series = await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: overdue },
        body: { preset: "weekly" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    await run();
    expect(await row(notDue)).toEqual(before);
    expect((await row(overdue)).properties).toMatchObject({ status: "missed", date: day(-8) });
    const occurrences = await inTenant(() =>
      pool.query<{ id: string; properties: Record<string, unknown>; updated_at: Date }>(
        "SELECT id, properties, updated_at FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
        [tasksId, series.item.properties.seriesId],
      ),
    );
    expect(occurrences.rows).toHaveLength(2);
    expect(occurrences.rows.find((entry) => entry.id !== overdue)?.properties).toMatchObject({
      status: "notDone",
      date: day(-1),
      occurrenceDate: day(-1),
    });
    const seriesBeforeRepeat = await inTenant(() =>
      pool.query<{ item_id: string; rule: unknown; active: boolean }>(
        "SELECT item_id, rule, active FROM task_recurrence WHERE series_id = $1",
        [series.item.properties.seriesId],
      ),
    );
    const jobsBeforeRepeat = await admin.query<{ id: string; key: string | null }>(
      "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
    );
    const repeatEvents: InvalidationEvent[] = [];
    setInvalidationHook((event) => repeatEvents.push(event));
    try {
      await run();
    } finally {
      setInvalidationHook(() => {});
    }
    expect(
      (
        await inTenant(() =>
          pool.query<{ item_id: string; rule: unknown; active: boolean }>(
            "SELECT item_id, rule, active FROM task_recurrence WHERE series_id = $1",
            [series.item.properties.seriesId],
          ),
        )
      ).rows,
    ).toEqual(seriesBeforeRepeat.rows);
    expect(
      (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
        .rows,
    ).toEqual(jobsBeforeRepeat.rows);
    // The repeat writes nothing, so no item or relation is announced; the run itself still announces the day (issue #1951).
    expect(repeatEvents).toEqual([{ scope: "overview" }]);
    expect(
      (
        await inTenant(() =>
          pool.query<{ id: string; properties: Record<string, unknown>; updated_at: Date }>(
            "SELECT id, properties, updated_at FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
            [tasksId, series.item.properties.seriesId],
          ),
        )
      ).rows,
    ).toEqual(occurrences.rows);
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
    if (!due) throw new Error("Missing due task");
    for (const id of ids)
      await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id },
          body: { preset: id === due ? "daily" : "yearly" },
          identity: { user: { id: randomUUID() } },
        }),
      );
    const before = await Promise.all(ids.slice(0, 3).map(row));
    const action = createTasksDayRolloverAction(pool, { recurringLimit: 2 });
    await inTenant(() =>
      action(heartbeat.config, { heartbeatId: heartbeat.id, projectItemId: heartbeat.projectItemId }),
    );
    expect((await row(due)).properties.status).toBe("missed");
    expect(await Promise.all(ids.slice(0, 3).map(row))).toEqual(before);
  });

  it("projects the locked current rule when an older reopened occurrence is processed first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
      const old = await task({ date: "2026-10-12" });
      const started = await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: old },
          body: { preset: "weekly" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      const seriesId = started.item.properties.seriesId;
      if (typeof seriesId !== "string") throw new Error("Missing series");
      vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
      await inTenant(() => cp.updateItem({ databaseId: tasksId, itemId: old, propertiesPatch: { status: "done" } }));
      const pointer = await inTenant(() =>
        pool.query<{ item_id: string }>("SELECT item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
      );
      const current = pointer.rows[0]?.item_id;
      if (!current || current === old) throw new Error("Missing next occurrence");
      await inTenant(() => cp.updateItem({ databaseId: tasksId, itemId: old, propertiesPatch: { status: "notDone" } }));
      await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: current },
          body: { preset: "monthly" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
      // Hold the current occurrence so the full action's SKIP LOCKED pass must process the older one first.
      let release = () => {};
      let signalReady: (value: { pid: number; started: string }) => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<{ pid: number; started: string }>((resolve) => {
        signalReady = resolve;
      });
      const holder = trackRolloverActor(
        inTenant(() =>
          withTransaction(pool, async (client) => {
            const identity = await client.query<{ pid: number; started: string }>(
              "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
            );
            if (!identity.rows[0]) throw new Error("Missing current occurrence holder");
            await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [
              tasksId,
              current,
            ]);
            signalReady(identity.rows[0]);
            await gate;
          }),
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      let action: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      let primary: { error: unknown } | undefined;
      try {
        const held = await waitRolloverReady(ready, [holder], "Rollover actor did not settle");
        expect(
          (
            await admin.query<{ present: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
              [held.pid, held.started],
            )
          ).rows,
        ).toEqual([{ present: true }]);
        action = trackRolloverActor(
          inTenant(() =>
            createTasksDayRolloverAction(pool)(heartbeat.config, {
              heartbeatId: heartbeat.id,
              projectItemId: heartbeat.projectItemId,
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        await expect.poll(async () => (await row(old)).properties.status, { timeout: WAIT_MS }).toBe("missed");
        let blocked: Array<{ pid: number; started: string; blockers: number[] }> = [];
        await expect
          .poll(
            async () => {
              blocked = (
                await admin.query<{ pid: number; started: string; blockers: number[] }>(
                  "SELECT pid, backend_start::text AS started, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT i.id FROM items i%'",
                  [held.pid],
                )
              ).rows;
              return blocked.map((entry) => entry.blockers);
            },
            { timeout: WAIT_MS },
          )
          .toEqual([[held.pid]]);
        expect(blocked).toEqual([{ pid: expect.any(Number), started: expect.any(String), blockers: [held.pid] }]);
        expect(blocked[0]?.pid).not.toBe(held.pid);
      } catch (error) {
        primary = { error };
      }
      release();
      const settled = await Promise.allSettled([
        settleRolloverActor(holder, primary),
        ...(action ? [settleRolloverActor(action, primary)] : []),
      ]);
      const errors: unknown[] = primary ? [primary.error] : [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "rejected") errors.push(result.reason);
        else if (!result.value.ok && !(index === 0 && rolloverActorRecords.get(holder)?.consumed))
          errors.push(result.value.error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Older occurrence action failed", {
          cause: primary ? primary.error : errors[0],
        });
      if (!action) throw new Error("Rollover action did not start");
      const moved = await inTenant(() =>
        pool.query<{ item_id: string }>("SELECT item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
      );
      const latest = moved.rows[0]?.item_id;
      if (!latest || latest === old || latest === current) throw new Error("Missing new occurrence");
      const before = await row(latest);
      expect(before.properties).toMatchObject({
        occurrenceDate: "2026-11-19",
        recurrence: {
          preset: null,
          mode: "fixed",
          rule: { kind: "monthDates", dates: [19] },
        },
      });
      await inTenant(() =>
        createTasksDayRolloverAction(pool)(heartbeat.config, {
          heartbeatId: heartbeat.id,
          projectItemId: heartbeat.projectItemId,
        }),
      );
      const after = await row(latest);
      expect(after).toEqual(before);
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
    let release = () => {};
    let holder: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
      const old = await task({ date: "2026-10-12" });
      const started = await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: old },
          body: { preset: "weekly" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      const seriesId = started.item.properties.seriesId;
      if (typeof seriesId !== "string") throw new Error("Missing series");
      vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
      await inTenant(() => cp.updateItem({ databaseId: tasksId, itemId: old, propertiesPatch: { status: "done" } }));
      const pointer = await inTenant(() =>
        pool.query<{ item_id: string }>("SELECT item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
      );
      const future = pointer.rows[0]?.item_id;
      if (!future || future === old) throw new Error("Missing future occurrence");
      await inTenant(() => cp.updateItem({ databaseId: tasksId, itemId: old, propertiesPatch: { status: "notDone" } }));
      await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: future },
          body: { preset: "daily" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
      const beforeOld = await row(old);
      const beforeFuture = await row(future);
      const jobs = await admin.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      let signal: (value: { pid: number; started: string }) => void = () => {};
      const ready = new Promise<{ pid: number; started: string }>((resolve) => {
        signal = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holder = trackRolloverActor(
        inTenant(() =>
          withTransaction(pool, async (client) => {
            const own = await client.query<{ pid: number; started: string }>(
              "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
            );
            if (!own.rows[0]) throw new Error("Missing holder identity");
            await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [tasksId, future]);
            signal(own.rows[0]);
            await gate;
          }),
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      const identity = await waitRolloverReady(ready, [holder], "Rollover actor did not settle");
      expect(
        (
          await admin.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
            [identity.pid, identity.started],
          )
        ).rows,
      ).toEqual([{ present: true }]);
      await expect(
        inTenant(() =>
          createTasksDayRolloverAction(pool)(heartbeat.config, {
            heartbeatId: heartbeat.id,
            projectItemId: heartbeat.projectItemId,
          }),
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await row(old)).toEqual(beforeOld);
      expect(await row(future)).toEqual(beforeFuture);
      expect(
        (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
          .rows,
      ).toEqual(jobs.rows);
      release();
      const outcome = await settleRolloverActor(holder, failure);
      if (!outcome.ok) throw outcome.error;
      holder = undefined;
      await inTenant(() =>
        createTasksDayRolloverAction(pool)(heartbeat.config, {
          heartbeatId: heartbeat.id,
          projectItemId: heartbeat.projectItemId,
        }),
      );
      expect((await row(old)).properties.status).toBe("missed");
      expect(await row(future)).toEqual(beforeFuture);
      expect(
        (
          await inTenant(() =>
            pool.query<{ item_id: string }>("SELECT item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
          )
        ).rows,
      ).toEqual([{ item_id: future }]);
      const ensured = await inTenant(() =>
        pool.query<{ properties: Record<string, unknown> }>(
          "SELECT properties FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3",
          [tasksId, seriesId, "2026-10-16"],
        ),
      );
      expect(ensured.rows).toEqual([
        { properties: expect.objectContaining({ status: "notDone", occurrenceDate: "2026-10-16" }) },
      ]);
    } catch (error) {
      failure = { error };
    }
    release();
    if (holder) {
      try {
        const outcome = await settleRolloverActor(holder, failure);
        if (!outcome.ok && !rolloverActorRecords.get(holder)?.consumed) throw outcome.error;
      } catch (error) {
        vi.useRealTimers();
        if (failure) {
          // The earlier test failure is primary; the caught actor failure remains in the aggregate.
          // eslint-disable-next-line preserve-caught-error
          throw new AggregateError([failure.error, error], "Future occurrence actor failed", { cause: failure.error });
        }
        throw error;
      }
    }
    vi.useRealTimers();
    if (failure) throw failure.error;
  });

  it("rolls back the current recurring batch when the existing latest occurrence is reserved", async () => {
    const old = await task({ date: day(-1) });
    const series = await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: old },
        body: { preset: "daily" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const seriesId = series.item.properties.seriesId;
    if (typeof seriesId !== "string") throw new Error("Missing series id");
    // A pre-materialized latest occurrence is a historical fixture; this path does not make it current.
    const latest = await inTenant(() =>
      createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status: "notDone" }),
    );
    const beforeOld = await row(old);
    const beforeLatest = await row(latest);
    const beforeSeries = await inTenant(() =>
      pool.query<{ item_id: string; active: boolean }>(
        "SELECT item_id, active FROM task_recurrence WHERE series_id = $1",
        [seriesId],
      ),
    );
    const beforeJobs = await admin.query<{ id: string; key: string | null }>(
      "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
    );
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    let release = () => {};
    let signalReady: (identity: { pid: number; started: string }) => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<{ pid: number; started: string }>((resolve) => {
      signalReady = resolve;
    });
    const holder = trackRolloverActor(
      inTenant(() =>
        withTransaction(pool, async (client) => {
          await client.query("SET LOCAL lock_timeout = '5s'");
          const identity = await client.query<{ pid: number; started: string }>(
            "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
          );
          if (!identity.rows[0]) throw new Error("Missing holder identity");
          const trashed = await itemDeleteWithClient(client, tasksId, latest, {
            queueAffinity: createActionQueueAffinity(),
          });
          if (!trashed?.deletedAt) throw new Error("Latest occurrence was not trashed");
          signalReady(identity.rows[0]);
          await gate;
        }),
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    let failure: { error: unknown } | undefined;
    try {
      const identity = await waitRolloverReady(ready, [holder], "Latest reservation timed out");
      expect(
        (
          await admin.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
            [identity.pid, identity.started],
          )
        ).rows,
      ).toEqual([{ present: true }]);
      await expect(run()).rejects.toMatchObject({ code: "55P03" });
      expect(await row(old)).toEqual(beforeOld);
      expect(await row(latest)).toEqual(beforeLatest);
      expect(
        (
          await inTenant(() =>
            pool.query<{ item_id: string; active: boolean }>(
              "SELECT item_id, active FROM task_recurrence WHERE series_id = $1",
              [seriesId],
            ),
          )
        ).rows,
      ).toEqual(beforeSeries.rows);
      expect(
        (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
          .rows,
      ).toEqual(beforeJobs.rows);
      expect(events).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    release();
    let outcome: Awaited<typeof holder> | undefined;
    try {
      outcome = await settleRolloverActor(holder, failure);
    } catch (error) {
      if (!pendingRolloverActors.size) setInvalidationHook(() => {});
      if (failure) {
        // The earlier test failure is primary; the caught actor failure remains in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure.error, error], "Rollover actor did not settle", { cause: failure.error });
      }
      throw error;
    }
    setInvalidationHook(() => {});
    if (!outcome.ok && failure && !rolloverActorRecords.get(holder)?.consumed)
      throw new AggregateError([failure.error, outcome.error], "Rollover test and holder failed", {
        cause: failure.error,
      });
    if (!outcome.ok && !rolloverActorRecords.get(holder)?.consumed) throw outcome.error;
    if (failure) throw failure.error;
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
      const series = await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: old },
          body: { preset: "daily" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      const seriesId = series.item.properties.seriesId;
      if (typeof seriesId !== "string") throw new Error("Missing series id");
      // Synthetic materialized terminal occurrence: normal completion owns the series advance.
      const latest = await inTenant(() =>
        createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status }),
      );
      const beforeLatest = await row(latest);
      await run();
      expect((await row(old)).properties.status).toBe("missed");
      expect(await row(latest)).toEqual(beforeLatest);
      const all = await inTenant(() =>
        pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
          [tasksId, seriesId],
        ),
      );
      expect(all.rows.map((entry) => entry.id).sort()).toEqual([old, latest].sort());
    },
  );

  it("replaces a trashed latest occurrence without restoring or modifying its history", async () => {
    const old = await task({ date: day(-1) });
    const series = await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: old },
        body: { preset: "daily" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const seriesId = series.item.properties.seriesId;
    if (typeof seriesId !== "string") throw new Error("Missing series id");
    // A pre-materialized latest occurrence is a historical fixture; then use the real trash path.
    const trashed = await inTenant(() =>
      createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: day(0), status: "notDone" }),
    );
    await inTenant(() => cp.softDeleteItem(tasksId, trashed));
    const beforeTrashed = await row(trashed);
    await run();
    expect(await row(trashed)).toEqual(beforeTrashed);
    expect((await row(old)).properties.status).toBe("missed");
    const live = await inTenant(() =>
      pool.query<{ id: string; properties: Record<string, unknown> }>(
        "SELECT id, properties FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL ORDER BY id",
        [tasksId, seriesId],
      ),
    );
    expect(live.rows).toHaveLength(2);
    expect(live.rows.find((entry) => entry.id !== old)?.properties).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
  });

  it("observes a concurrent completion before attempting a missed transition", async () => {
    const old = await task({ date: day(-1) });
    const series = await inTenant(() =>
      createTaskRecurrenceSetRouteHandler(pool)({
        params: { id: old },
        body: { preset: "daily" },
        identity: { user: { id: randomUUID() } },
      }),
    );
    const seriesId = series.item.properties.seriesId;
    if (typeof seriesId !== "string") throw new Error("Missing series id");
    const actionPool = await createRuntimeRolePool(admin, "semprec_data");
    type Identity = { pid: number; started: string };
    let release = () => {};
    let holderReady: (identity: Identity) => void = () => {};
    let contenderReady: (identity: Identity) => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<Identity>((resolve) => {
      holderReady = resolve;
    });
    const competing = new Promise<Identity>((resolve) => {
      contenderReady = resolve;
    });
    const identity = async (client: PoolClient): Promise<Identity> => {
      const result = await client.query<Identity>(
        "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
      );
      if (!result.rows[0]) throw new Error("Missing actor identity");
      return result.rows[0];
    };
    const holder = trackRolloverActor(
      inTenant(() =>
        withTransaction(pool, async (client) => {
          const actor = await identity(client);
          await updateItemWithClient(
            client,
            { databaseId: tasksId, itemId: old, propertiesPatch: { status: "done" } },
            { writer: { writerKind: "user" } },
          );
          holderReady(actor);
          await gate;
        }),
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    let contender: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const bounded = (value: Promise<Identity>, actors: Array<Promise<RolloverOutcome>>) =>
        waitRolloverReady(value, actors, "Actor readiness timed out");
      const owner = await bounded(held, [holder]);
      contender = trackRolloverActor(
        inTenant(async () => {
          const client = await actionPool.connect();
          let own: Identity;
          try {
            own = await identity(client);
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
          contenderReady(own);
          await createTasksDayRolloverAction(actionPool)(heartbeat.config, {
            heartbeatId: heartbeat.id,
            projectItemId: heartbeat.projectItemId,
          });
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      const waiter = await bounded(competing, [holder, contender]);
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
    release();
    const settled = await Promise.allSettled([
      settleRolloverActor(holder, failure),
      ...(contender ? [settleRolloverActor(contender, failure)] : []),
    ]);
    const actors = [holder, ...(contender ? [contender] : [])];
    const failures = settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [result.reason]
        : result.value.ok || rolloverActorRecords.get(actors[index]!)?.consumed
          ? []
          : [result.value.error],
    );
    if (pendingRolloverActors.size)
      failures.push(new Error("Completion actor remains unsettled; action pool remains open"));
    else {
      try {
        await actionPool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failure && failures.length)
      throw new AggregateError([failure.error, ...failures], "Completion overlap failed", { cause: failure.error });
    if (failure) throw failure.error;
    if (failures.length) throw new AggregateError(failures, "Completion overlap actors failed");
    expect((await row(old)).properties.status).toBe("done");
    const occurrences = await inTenant(() =>
      pool.query<{ id: string; properties: Record<string, unknown> }>(
        "SELECT id, properties FROM items WHERE database_id = $1 AND properties->>'seriesId' = $2 AND deleted_at IS NULL",
        [tasksId, seriesId],
      ),
    );
    expect(occurrences.rows).toHaveLength(2);
    expect(occurrences.rows.find((entry) => entry.id !== old)?.properties).toMatchObject({
      status: "notDone",
      date: day(0),
      occurrenceDate: day(0),
    });
  });

  it("moves a task whose event ended yesterday, with since yesterday", async () => {
    const id = await task({ date: day(-3) });
    // The event-derived day and the end of its event (#1780, #1798 write them later): synthetic Tasks values.
    await setSystemProperties(id, {
      effectiveDate: day(-1),
      hiddenUntil: today.minus({ hours: 1 }).toISO(),
    });
    await run();
    expect((await row(id)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });

  it("sends one invalidation without an acting user for every moved task and none for an unmoved one", async () => {
    const moved = [await task({ date: day(-1) }), await task({ date: day(-2) })];
    const kept = await task({ date: day(0) });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await run();
    } finally {
      setInvalidationHook(() => {});
    }
    const items = events.filter((event) => event.scope === "item");
    for (const id of moved) {
      expect(items.filter((event) => event.itemId === id)).toEqual([
        expect.objectContaining({ scope: "item", op: "update", databaseId: tasksId, itemId: id, userId: undefined }),
      ]);
    }
    expect(items.filter((event) => event.itemId === kept)).toEqual([]);
  });

  it("moves a row another transaction holds during the first pass by the end of the same run", async () => {
    const locked = await task({ date: day(-1) });
    const free = await task({ date: day(-1) });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      holderPid = resolve;
    });
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });
    const holder: Promise<Error | null> = inTenant(() =>
      withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [locked]);
        holderPid((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
        await held;
      }),
    ).then(
      () => null,
      (error: unknown) => asError(error),
    );
    let rollover: Promise<Error | null> | undefined;
    let waitFailure: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const pid = await Promise.race([
        holding,
        holder.then((error) => Promise.reject(error ?? new Error("The holder ended before locking"))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The holder did not lock the row")), WAIT_MS);
        }),
      ]);
      rollover = run().then(
        () => null,
        (error: unknown) => asError(error),
      );
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const { rows } = await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        );
        if (rows[0]?.waiting === true) break;
        if (Date.now() > deadline) throw new Error("The rollover never waited for the held row");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The first pass skipped the held row and committed the free one before the second pass started waiting.
      expect((await row(free)).properties.date).toBe(day(0));
      expect((await row(locked)).properties.date).toBe(day(-1));
    } catch (error) {
      waitFailure = asError(error);
    } finally {
      clearTimeout(timer);
      release();
    }
    const holderError = await holder;
    const rolloverError = rollover === undefined ? null : await rollover;
    if (holderError !== null) throw holderError;
    if (waitFailure !== null) throw waitFailure;
    if (rolloverError !== null) throw rolloverError;
    expect((await row(locked)).properties).toMatchObject({ date: day(0), since: day(-1) });
  });

  describe("a task with a stale effectiveDate (synthetic: the stale value is written directly)", () => {
    it("moves it once: one invalidation, and a second run the same day writes nothing", async () => {
      const id = await task({ date: day(-3) });
      await setSystemProperties(id, { effectiveDate: day(-2), hiddenUntil: today.minus({ hours: 1 }).toISO() });
      const first = await invalidationsDuring(run);
      const moved = await row(id);
      // The Tasks transform stores the effective day with the new date (issue #1780), so the task is not selected again.
      expect(moved.properties).toMatchObject({ date: day(0), timeFrom: null, timeTo: null, effectiveDate: day(0) });
      expect(first.get(id)).toBe(1);
      const second = await invalidationsDuring(run);
      expect(second.get(id)).toBeUndefined();
      expect(await row(id)).toEqual(moved);
    });

    it("clears the times of a task dated today once, then leaves it alone", async () => {
      const id = await task({ date: day(0), timeFrom: "10:00", timeTo: "11:00" });
      await setSystemProperties(id, { effectiveDate: day(-1) });
      const first = await invalidationsDuring(run);
      const moved = await row(id);
      expect(moved.properties).toMatchObject({ date: day(0), timeFrom: null, timeTo: null, time: null });
      expect(first.get(id)).toBe(1);
      const second = await invalidationsDuring(run);
      expect(second.size).toBe(0);
      expect(await row(id)).toEqual(moved);
    });

    it("moves 101 of them and a row held during the first pass, each exactly once, in one run", async () => {
      const stale: string[] = [];
      for (let index = 0; index < 101; index++) stale.push(await task({ date: day(-2) }));
      await setSystemPropertiesMany(stale, { effectiveDate: day(-1) });
      const locked = await task({ date: day(-1) });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid: (pid: number) => void = () => undefined;
      const holding = new Promise<number>((resolve) => {
        holderPid = resolve;
      });
      const asError = (error: unknown): Error =>
        error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });
      const holder: Promise<Error | null> = inTenant(() =>
        withTransaction(pool, async (client) => {
          await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [locked]);
          holderPid((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
          await held;
        }),
      ).then(
        () => null,
        (error: unknown) => asError(error),
      );
      let rollover: Promise<Map<string, number> | Error> | undefined;
      let waitFailure: Error | null = null;
      let timer: NodeJS.Timeout | undefined;
      try {
        const pid = await Promise.race([
          holding,
          holder.then((error) => Promise.reject(error ?? new Error("The holder ended before locking"))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("The holder did not lock the row")), WAIT_MS);
          }),
        ]);
        rollover = invalidationsDuring(run).then(
          (counts) => counts,
          (error: unknown) => asError(error),
        );
        const deadline = Date.now() + WAIT_MS;
        for (;;) {
          const { rows } = await admin.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
            [pid],
          );
          if (rows[0]?.waiting === true) break;
          if (Date.now() > deadline) throw new Error("The rollover never waited for the held row");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // The second pass waits for the held row only: every stale task already moved and stopped qualifying.
        expect((await Promise.all(stale.map(row))).every((moved) => moved.properties.date === day(0))).toBe(true);
        expect((await row(locked)).properties.date).toBe(day(-1));
      } catch (error) {
        waitFailure = asError(error);
      } finally {
        clearTimeout(timer);
        release();
      }
      const holderError = await holder;
      const counts = rollover === undefined ? null : await rollover;
      if (holderError !== null) throw holderError;
      if (waitFailure !== null) throw waitFailure;
      if (counts instanceof Error) throw counts;
      expect((await row(locked)).properties).toMatchObject({ date: day(0), since: day(-1) });
      expect(counts?.size).toBe(102);
      expect([...(counts?.values() ?? [])].every((count) => count === 1)).toBe(true);
      expect(counts?.get(locked)).toBe(1);
      const rerun = await invalidationsDuring(run);
      expect(rerun.size).toBe(0);
    });
  });
  describe("the overview invalidation (issue #1951)", () => {
    /** The events of one run, with what a reader of the database sees of `watched` at the moment an overview event is sent. */
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
      const { overview, all } = await overviewEventsDuring(run, moved);

      expect(overview.map((entry) => entry.event)).toEqual([{ scope: "overview" }]);
      expect(await overview[0]?.watchedDate).toBe(day(0));
      // It follows the item invalidation of the task the run moved.
      const lastItem = all.map((event) => event.scope).lastIndexOf("item");
      expect(lastItem).toBeGreaterThanOrEqual(0);
      expect(all.map((event) => event.scope).indexOf("overview")).toBeGreaterThan(lastItem);
    });

    it("announces once when no task moved", async () => {
      const kept = await task({ date: day(0) });
      const { overview, all } = await overviewEventsDuring(run);

      expect(overview.map((entry) => entry.event)).toEqual([{ scope: "overview" }]);
      expect(all.filter((event) => event.scope === "item" && event.itemId === kept)).toEqual([]);
    });

    it("announces once when the run only closed a missed occurrence of a recurring task", async () => {
      const first = await task({ date: day(-8) });
      await inTenant(() =>
        createTaskRecurrenceSetRouteHandler(pool)({
          params: { id: first },
          body: { preset: "daily" },
          identity: { user: { id: randomUUID() } },
        }),
      );
      const { overview } = await overviewEventsDuring(run);

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

/** An Event to be the target of a fixture edge, created through the choke point in the caller's transaction. */
async function createRelationTarget(client: PoolClient): Promise<string> {
  return (await createItemWithClient(client, { databaseId: eventsId, properties: { name: "Workshop", date: day(-2) } }))
    .id;
}
