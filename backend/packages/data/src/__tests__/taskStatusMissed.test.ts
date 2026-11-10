import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { prepareTaskProposal } from "../tasks/taskPreWriteTransform.js";
import { createTaskRecurrenceSetRouteHandler } from "../tasks/taskRecurrenceRoutes.js";
import { getTaskRecurrenceBySeriesId, replaceTaskRecurrenceRule } from "../tasks/taskRecurrenceStore.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
/** The tenant's own today, read once per case: the rules compare with the day in the system time zone. */
let today: DateTime;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent" };

const day = (offset: number): string => today.plus({ days: offset }).toFormat("yyyy-MM-dd");

function write(itemId: string, propertiesPatch: Record<string, unknown>, writer?: WriterIdentity) {
  return runInTenant(tenant, () =>
    cp.updateItem({ databaseId: tasksId, itemId, propertiesPatch }, undefined, undefined, writer),
  );
}

async function stored(itemId: string): Promise<Record<string, unknown>> {
  const item = await runInTenant(tenant, () => cp.getItem(tasksId, itemId));
  if (!item) throw new Error(`Task ${itemId} missing`);
  return item.properties;
}

/** A daily series started on the day five days ago through the recurrence route. */
async function dailySeries(): Promise<string> {
  const task = await runInTenant(tenant, () =>
    cp.createItem({ databaseId: tasksId, properties: { name: "Stretch", date: day(-5) } }),
  );
  const response = await runInTenant(tenant, () =>
    createTaskRecurrenceSetRouteHandler(pool)({
      params: { id: task.id },
      body: { preset: "daily" },
      identity: { user: { id: randomUUID() } },
    }),
  );
  const seriesId = response.item.properties.seriesId;
  if (typeof seriesId !== "string") throw new Error("No series id");
  return seriesId;
}

/** A done occurrence of the series on `date` (synthetic: the #1720 materialization that stores them is not built). */
function doneOccurrence(seriesId: string, date: string): Promise<string> {
  return runInTenant(tenant, () =>
    createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: date, status: "done" }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

const WAIT_MS = 10_000;
const queryCancelled = z.object({ code: z.literal("57014") });
const sessionRow = z.object({ pid: z.number(), started: z.string() });
const cancelledRow = z.object({ cancelled: z.boolean() });
const blockedRow = z.object({ blocked: z.boolean() });
const pidRow = z.object({ pid: z.number() });

/** One database backend: its pid and start time, which together never name a later backend that reuses the pid. */
type Session = z.infer<typeof sessionRow>;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });

/** Rejects after `ms` unless `promise` settles first. A rejection only ends the wait: it stops nothing. */
async function bounded<T>(promise: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first failure, the same object, with every later failure appended in order to its cause. */
function withLaterFailures(first: Error, later: Error[]): Error {
  if (later.length > 0) {
    // An earlier cause stays the first entry.
    first.cause = new AggregateError(first.cause === undefined ? later : [first.cause, ...later], "Later failures");
  }
  return first;
}

async function sessionOf(client: PoolClient): Promise<Session> {
  const { rows } = await client.query<Record<string, unknown>>(
    "SELECT pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
  );
  return sessionRow.parse(rows[0]);
}

/** Actors whose end was not confirmed. Their pools stay open, and no later reset or pool end may race them. */
const unsettled: string[] = [];

function assertNothingUnsettled(): void {
  if (unsettled.length > 0) throw new Error(`Not settled, so nothing is reset or closed: ${unsettled.join(", ")}`);
}

/**
 * A runtime-role pool of one actor alone. Each backend it opens is identified by a query queued on it before the pool
 * hands it out, so that query runs before the actor's first one.
 */
interface OwnedPool {
  readonly pool: Pool;
  readonly sessions: Array<Promise<Session>>;
  /** The first backend it opened. */
  readonly session: Promise<Session>;
}

async function ownedPool(): Promise<OwnedPool> {
  const owned = await createRuntimeRolePool(admin, "semprec_data");
  const sessions: Array<Promise<Session>> = [];
  let first!: (session: Promise<Session>) => void;
  const session = new Promise<Session>((resolve) => (first = resolve));
  owned.on("connect", (client) => {
    const identified = sessionOf(client);
    // Marks the rejection as observed; every awaiter of `identified` still receives it.
    identified.catch(() => undefined);
    sessions.push(identified);
    if (sessions.length === 1) first(identified);
  });
  return { pool: owned, sessions, session };
}

/** A concurrently running test actor on its own pool. Its outcome is observed from launch: null, or its error. */
interface Actor {
  readonly what: string;
  readonly owned: OwnedPool;
  readonly outcome: Promise<Error | null>;
}

function launch(what: string, owned: OwnedPool, run: (actorPool: Pool) => Promise<unknown>): Actor {
  const outcome = (async () => {
    await runInTenant(tenant, () => run(owned.pool));
    return null;
  })().catch((error: unknown) => asError(error));
  return { what, owned, outcome };
}

/** Cancels the current statement of one backend the actor owns; anything short of a confirmed cancel throws. */
async function cancelOwned(observer: PoolClient, session: Session): Promise<void> {
  const { rows } = await observer.query<Record<string, unknown>>(
    "SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz",
    [session.pid, session.started],
  );
  if (rows.length !== 1 || !cancelledRow.parse(rows[0]).cancelled) {
    throw new Error(`Cancelling backend ${session.pid} was not confirmed`);
  }
}

/**
 * Waits for the actor's outcome. If that wait fails, cancels the current statement of each backend its pool opened,
 * then waits once more. Its pool is ended only after its outcome arrived. When the outcome never arrives, `outcome`
 * is undefined, the actor is recorded in `unsettled` and its pool is not ended; a pool whose end does not complete is
 * recorded there too.
 */
async function settleActor(
  actor: Actor,
  observer: PoolClient,
  observeMs = WAIT_MS,
): Promise<{ outcome: Error | null | undefined; failures: Error[] }> {
  const failures: Error[] = [];
  let outcome: Error | null | undefined;
  try {
    outcome = await bounded(actor.outcome, `${actor.what} to settle`, observeMs);
  } catch (error) {
    failures.push(asError(error));
    try {
      for (const identified of await bounded(Promise.allSettled(actor.owned.sessions), `${actor.what}'s backends`)) {
        if (identified.status === "rejected") {
          failures.push(asError(identified.reason));
          continue;
        }
        try {
          await cancelOwned(observer, identified.value);
        } catch (cancelError) {
          failures.push(asError(cancelError));
        }
      }
    } catch (sessionsError) {
      failures.push(asError(sessionsError));
    }
    try {
      outcome = await bounded(actor.outcome, `${actor.what} to settle after its cancellation`);
    } catch (settleError) {
      failures.push(asError(settleError));
    }
  }
  if (outcome === undefined) {
    unsettled.push(actor.what);
    return { outcome, failures };
  }
  try {
    await bounded(actor.owned.pool.end(), `${actor.what}'s pool to close`);
  } catch (endError) {
    failures.push(asError(endError));
    unsettled.push(`${actor.what}'s pool`);
  }
  return { outcome, failures };
}

/** Settles each actor in order, each on its own: a failure settling one never skips a later one. */
async function settleEach(
  actors: Array<{ actor: Actor; observeMs: number }>,
  observer: PoolClient,
): Promise<Array<{ outcome: Error | null | undefined; failures: Error[] }>> {
  const settled: Array<{ outcome: Error | null | undefined; failures: Error[] }> = [];
  for (const { actor, observeMs } of actors) settled.push(await settleActor(actor, observer, observeMs));
  return settled;
}

function assertOwnSessions(observer: Session, actors: Session[]): void {
  const pids = actors.map((session) => session.pid);
  if (pids.includes(observer.pid) || new Set(pids).size !== pids.length) {
    throw new Error("The observer or two actors share a backend");
  }
}

/** Waits until backend `waiter` is blocked by backend `blocker`, as the observer's own session sees it. */
async function waitsOn(observer: PoolClient, waiter: number, blocker: number, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await observer.query<Record<string, unknown>>(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [blocker, waiter],
    );
    if (blockedRow.parse(rows[0]).blocked) return;
    if (Date.now() > deadline) throw new Error(`Backend ${waiter} never waited for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The pids of `sessions` still connected, once none is or after `WAIT_MS`, as the observer's own session sees it. */
async function liveSessions(observer: PoolClient, sessions: Session[]): Promise<number[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await observer.query<Record<string, unknown>>(
      `SELECT pid FROM pg_stat_activity
       WHERE (pid, backend_start) IN (SELECT * FROM unnest($1::int[], $2::timestamptz[]))`,
      [sessions.map((session) => session.pid), sessions.map((session) => session.started)],
    );
    const live = rows.map((row) => pidRow.parse(row).pid);
    if (live.length === 0 || Date.now() > deadline) return live;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The first actor: a transaction of the tenant that runs `work`, then stays open until it is released. */
interface HeldWork {
  work: (client: PoolClient) => Promise<void>;
  /** Runs in the same transaction once it is released. */
  afterRelease?: (client: PoolClient) => Promise<void>;
}

/** Starts `held` on its own pool: `ready` resolves once `work` is done, `release` lets the transaction go on. */
async function heldTransaction(held: HeldWork) {
  const owned = await ownedPool();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let readyNow!: () => void;
  const ready = new Promise<void>((resolve) => (readyNow = resolve));
  const actor = launch("the first transaction", owned, (actorPool) =>
    withTransaction(actorPool, async (client) => {
      await held.work(client);
      readyNow();
      await released;
      await held.afterRelease?.(client);
    }),
  );
  return { actor, ready, release };
}

/** Test-local faults for `secondWaitsForFirst`; production code is never changed. */
interface SecondWaitsFaults {
  /** Replaces the barrier that observes the second transaction blocked by the first. */
  observe?: (observer: PoolClient, waiter: number, blocker: number, what: string) => Promise<void>;
  /** How long the first wait for the first transaction's outcome lasts. */
  firstSettleMs?: number;
  /** Receives each actor backend once identified. */
  sessions?: Session[];
}

/**
 * Holds the first transaction open, starts `second` on its own pool and waits until it is blocked by the first, then
 * releases the first. Both actors are then settled in that order, each on its own (`settleActor`). The first failure
 * is thrown, the same object, with every later failure appended to its cause.
 */
async function secondWaitsForFirst(
  held: HeldWork,
  second: (actorPool: Pool) => Promise<unknown>,
  what: string,
  faults: SecondWaitsFaults = {},
): Promise<void> {
  const observer = await admin.connect();
  const actors: Array<{ actor: Actor; observeMs: number }> = [];
  const failures: Error[] = [];
  try {
    let first: Awaited<ReturnType<typeof heldTransaction>> | undefined;
    try {
      const watching = await sessionOf(observer);
      first = await heldTransaction(held);
      actors.push({ actor: first.actor, observeMs: faults.firstSettleMs ?? WAIT_MS });
      await bounded(
        Promise.race([
          first.ready,
          first.actor.outcome.then((error) => Promise.reject(error ?? new Error("ended early"))),
        ]),
        "the first transaction",
      );
      const firstSession = await bounded(first.actor.owned.session, "the first transaction's backend");
      const waiting = launch("the second transaction", await ownedPool(), second);
      actors.push({ actor: waiting, observeMs: WAIT_MS });
      const secondSession = await bounded(waiting.owned.session, "the second transaction's backend");
      assertOwnSessions(watching, [firstSession, secondSession]);
      faults.sessions?.push(firstSession, secondSession);
      await (faults.observe ?? waitsOn)(observer, secondSession.pid, firstSession.pid, what);
    } catch (error) {
      failures.push(asError(error));
    } finally {
      first?.release();
    }
    for (const settled of await settleEach(actors, observer)) {
      failures.push(...settled.failures);
      // An outcome already recorded as the observation's failure is not appended to itself.
      if (settled.outcome && !failures.includes(settled.outcome)) failures.push(settled.outcome);
    }
  } finally {
    observer.release();
  }
  const [failure, ...later] = failures;
  if (failure) throw withLaterFailures(failure, later);
}

/** A user write of the Tasks item through the generic write on the actor's own pool. */
function writeOn(actorPool: Pool, itemId: string, propertiesPatch: Record<string, unknown>) {
  return createChokePoint(actorPool).updateItem(
    { databaseId: tasksId, itemId, propertiesPatch },
    undefined,
    undefined,
    USER,
  );
}

/** A monthly rule on the occurrence's day of the month: its next date after `date` is a month later. */
function monthlyOn(date: string) {
  return { mode: "fixed" as const, rule: { kind: "monthDates" as const, dates: [DateTime.fromISO(date).day] } };
}

describe("the missed status of Tasks (issue #1668)", () => {
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
    assertNothingUnsettled();
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    tasksId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
    const zone = await runInTenant(tenant, () => withTransaction(pool, (client) => getSystemTimezone(client)));
    today = DateTime.now().setZone(zone).startOf("day");
  });

  afterAll(async () => {
    assertNothingUnsettled();
    await pool?.end();
    await admin?.end();
  });

  it.each([
    ["a user", USER],
    ["an agent", AGENT],
  ])("refuses %s writing status missed with 400 and keeps the row", async (_label, writer) => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(0) } }),
    );
    const before = await stored(task.id);
    expect((await refusal(write(task.id, { status: "missed" }, writer))).details).toEqual({ field: "status" });
    expect(await stored(task.id)).toEqual(before);
  });

  it("lets the Tasks module and the nightly job, system writers, store missed", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(-1) } }),
    );
    await write(task.id, { status: "missed" });
    expect((await stored(task.id)).status).toBe("missed");
  });

  it("accepts a user moving a missed task to done, which records the completion as for any done", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(-1) } }),
    );
    await write(task.id, { status: "missed" });
    await write(task.id, { status: "done" }, USER);
    expect(await stored(task.id)).toMatchObject({
      status: "done",
      completedOn: day(0),
      completedAt: expect.any(String),
    });
  });

  it("stores missed with completedOn empty when a past daily occurrence is set back from done to notDone", async () => {
    const seriesId = await dailySeries();
    const past = await doneOccurrence(seriesId, day(-3));
    expect((await stored(past)).completedOn).toBe(day(0));
    await write(past, { status: "notDone" }, USER);
    expect(await stored(past)).toMatchObject({ status: "missed", completedOn: null, completedAt: null });
  });

  it("stores notDone when today's daily occurrence is set back from done", async () => {
    const seriesId = await dailySeries();
    const current = await doneOccurrence(seriesId, day(0));
    await write(current, { status: "notDone" }, USER);
    expect(await stored(current)).toMatchObject({ status: "notDone", completedOn: null });
  });

  it("stores notDone for a task without a series set back from done, however old", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Once", date: day(-10) } }),
    );
    await write(task.id, { status: "done" }, USER);
    await write(task.id, { status: "notDone" }, USER);
    expect((await stored(task.id)).status).toBe("notDone");
  });

  it("refuses a proposal that would set status missed", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(0) } }),
    );
    expect((await refusal(prepareTaskProposal({ stored: task, patch: { status: "missed" } }))).details).toEqual({
      field: "status",
    });
  });

  describe("reopening an old occurrence while its series rule changes (R1: the rule is read locked)", () => {
    it("waits for a rule replacement holding the series and judges by the new rule", async () => {
      const seriesId = await dailySeries();
      const past = await doneOccurrence(seriesId, day(-3));
      await secondWaitsForFirst(
        {
          work: async (client) => {
            await replaceTaskRecurrenceRule(client, seriesId, monthlyOn(day(-3)));
          },
        },
        (actorPool) => writeOn(actorPool, past, { status: "notDone" }),
        "the replacement",
      );
      // The next date of the monthly rule is a month after the occurrence, not yet come: the occurrence is open again.
      expect(await stored(past)).toMatchObject({ status: "notDone", completedOn: null, completedAt: null });
      const series = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)),
      );
      expect(series?.rule).toEqual(monthlyOn(day(-3)).rule);
    });

    it("holds the series until the reopen commits, so a later replacement does not change its outcome", async () => {
      const seriesId = await dailySeries();
      const past = await doneOccurrence(seriesId, day(-3));
      await secondWaitsForFirst(
        {
          work: async (client) => {
            await updateItemWithClient(
              client,
              { databaseId: tasksId, itemId: past, propertiesPatch: { status: "notDone" } },
              { writer: USER },
            );
          },
        },
        (actorPool) =>
          withTransaction(actorPool, (client) => replaceTaskRecurrenceRule(client, seriesId, monthlyOn(day(-3)))),
        "the reopen",
      );
      // Judged by the daily rule it locked: the next day has come, so the occurrence was missed.
      expect(await stored(past)).toMatchObject({ status: "missed", completedOn: null });
      const series = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)),
      );
      expect(series?.rule).toEqual(monthlyOn(day(-3)).rule);
    });

    it("lets the current occurrence be completed while an old one is reopened, without a deadlock", async () => {
      const seriesId = await dailySeries();
      const past = await doneOccurrence(seriesId, day(-3));
      const series = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)),
      );
      const current = series?.itemId;
      if (current === undefined) throw new Error("The series has no current occurrence");
      await secondWaitsForFirst(
        {
          work: async (client) => {
            await updateItemWithClient(
              client,
              { databaseId: tasksId, itemId: past, propertiesPatch: { status: "notDone" } },
              { writer: USER },
            );
          },
        },
        (actorPool) => writeOn(actorPool, current, { status: "done" }),
        "the reopen",
      );
      expect(await stored(past)).toMatchObject({ status: "missed" });
      expect(await stored(current)).toMatchObject({ status: "done" });
      const advanced = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)),
      );
      expect(advanced?.itemId).not.toBe(current);
    });
  });

  describe("settling the concurrent actors when an observation fails (R2-1)", () => {
    it("still settles the waiting reopen when the observation fails and the first settlement times out", async () => {
      const seriesId = await dailySeries();
      const past = await doneOccurrence(seriesId, day(-3));
      const rule = async () =>
        (
          await runInTenant(tenant, () =>
            withTransaction(pool, (client) => getTaskRecurrenceBySeriesId(client, seriesId)),
          )
        )?.rule;
      const daily = await rule();
      const state = await admin.connect();
      try {
        const watching = await sessionOf(state);
        const original = new Error("Injected observation failure");
        const sessions: Session[] = [];
        const thrown: unknown = await secondWaitsForFirst(
          {
            work: async (client) => {
              await replaceTaskRecurrenceRule(client, seriesId, monthlyOn(day(-3)));
            },
            // Keeps the series locked past the release until its own backend is cancelled.
            afterRelease: async (client) => {
              await client.query("SELECT pg_sleep(30)");
            },
          },
          (actorPool) => writeOn(actorPool, past, { status: "notDone" }),
          "the replacement",
          {
            observe: async (observer, waiter, blocker, what) => {
              await waitsOn(observer, waiter, blocker, what);
              throw original;
            },
            firstSettleMs: 1_000,
            sessions,
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(thrown).toBe(original);
        if (!(original.cause instanceof AggregateError)) throw new Error("No later failures were appended");
        const [timedOut, cancelled] = z.tuple([z.instanceof(Error), queryCancelled]).parse(original.cause.errors);
        expect(timedOut.message).toBe("Timed out waiting for the first transaction to settle");
        expect(cancelled.code).toBe("57014");
        // The cancelled replacement rolled back; the reopen then locked the daily rule, whose next day has come.
        expect(await rule()).toEqual(daily);
        expect(await stored(past)).toMatchObject({ status: "missed", completedOn: null });
        expect(sessions.map((session) => session.pid)).not.toContain(watching.pid);
        expect(await liveSessions(state, sessions)).toEqual([]);
        expect(unsettled).toEqual([]);
      } finally {
        state.release();
      }
    });
  });
});
