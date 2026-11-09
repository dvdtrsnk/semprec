import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { ValidationError } from "../../errors.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runTasksPersistentRemovalCutoverMigration } from "../tasksPersistentRemovalCutoverMigration.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let tasksId: string;

const itemRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

async function persistentDefinitions(): Promise<number> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM properties WHERE database_id = $1 AND key = 'persistent'",
      [tasksId],
    );
    return rows[0]?.count ?? -1;
  });
}

async function items(): Promise<Array<z.infer<typeof itemRow>>> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text, deleted_at::text FROM items WHERE database_id = $1 ORDER BY id",
      [tasksId],
    );
    return rows.map((row) => itemRow.parse(row));
  });
}

/** The Tasks property keys `GET /api/schema` lists, from the projection that route serves. */
async function schemaKeys(): Promise<string[]> {
  const registry = await loadFullModuleRegistry();
  const projection = await runInTenant(tenant, () =>
    withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale: "en" })),
  );
  const parsed = z
    .object({
      databases: z.array(
        z
          .object({ databaseId: z.string(), properties: z.array(z.object({ key: z.string() }).passthrough()) })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(projection);
  return (
    parsed.databases.find((database) => database.databaseId === tasksId)?.properties.map((property) => property.key) ??
    []
  );
}

/**
 * Brings the tenant back to the shape before issue #2009: the `persistent` property and items storing it, a trashed
 * one included, and more than one batch of them. Synthetic historical state: the seed no longer creates the property,
 * the Tasks schema is locked, and only a write made before this release could store a value.
 */
async function seedOldShape(): Promise<void> {
  await runInTenant(tenant, async () => {
    const property = await pool.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'persistent', NULL, 'checkbox', '{}'::jsonb, false, 'user', NULL)`,
      [tasksId],
    );
    expect(property.rowCount).toBe(1);
    const bulk = await pool.query(
      `INSERT INTO items (database_id, properties)
       SELECT $1, jsonb_build_object('name', 'Bulk ' || n, 'status', 'notDone', 'persistent', n % 2 = 0, 'flagged', true)
       FROM generate_series(1, 501) AS n`,
      [tasksId],
    );
    expect(bulk.rowCount).toBe(501);
    const trashed = await pool.query(
      `INSERT INTO items (database_id, properties, deleted_at)
       VALUES ($1, '{"name": "Trashed", "persistent": true, "description": "kept"}'::jsonb, now())`,
      [tasksId],
    );
    expect(trashed.rowCount).toBe(1);
  });
}

const WAIT_MS = 4_000;
const USER = { writerKind: "user" } as const;
const queryText = z.union([z.string(), z.object({ text: z.string() }).transform((query) => query.text)]);
const lockTimeout = z.object({ code: z.literal("55P03") });
const queryCancelled = z.object({ code: z.literal("57014") });
/** The definition read every generic item write validates against (`listPropertiesByDatabase`). */
const VALIDATION_READ = /FROM properties WHERE database_id = \$1 ORDER BY initial_position/;
const sessionRow = z.object({ pid: z.number(), started: z.string() });
const cancelledRow = z.object({ cancelled: z.boolean() });
const blockedRow = z.object({ blocked: z.boolean() });
const pidRow = z.object({ pid: z.number() });

/** One database backend: its pid and start time, which together never name a later backend that reuses the pid. */
type Session = z.infer<typeof sessionRow>;

/** The old-shape definition alone: the property row the seed no longer creates (synthetic, as in `seedOldShape`). */
async function seedOldDefinition(): Promise<void> {
  await runInTenant(tenant, async () => {
    const property = await pool.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'persistent', NULL, 'checkbox', '{}'::jsonb, false, 'user', NULL)`,
      [tasksId],
    );
    expect(property.rowCount).toBe(1);
  });
}

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

/**
 * A writer's own pool whose clients pause before the first statement after their validation read of `properties`,
 * so the write has validated (and holds ACCESS SHARE on `properties`) but not yet written.
 */
async function pausedWriterPool() {
  const owned = await ownedPool();
  let reachedNow!: () => void;
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let validated = false;
  let held = false;
  const restore = new Map<object, PropertyDescriptor | undefined>();
  owned.pool.on("acquire", (client) => {
    const delegate: unknown = Reflect.get(client, "query");
    if (typeof delegate !== "function") throw new Error("A pg client without query");
    restore.set(client, Object.getOwnPropertyDescriptor(client, "query"));
    Object.defineProperty(client, "query", {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (validated && !held) {
          held = true;
          reachedNow();
          await released;
        }
        if (VALIDATION_READ.test(queryText.parse(args[0]))) validated = true;
        return Reflect.apply(delegate, client, args);
      },
    });
  });
  owned.pool.on("release", (_error, client) => {
    const own = restore.get(client);
    restore.delete(client);
    if (own) Object.defineProperty(client, "query", own);
    else Reflect.deleteProperty(client, "query");
  });
  return { owned, reached, release };
}

/** The observer's client and the two actor backends of `cutoverAgainstPausedWriter`. */
interface WriterSessions {
  observer: PoolClient;
  writer: Session;
  cutover: Session;
}

/** Test-local faults for `cutoverAgainstPausedWriter`; production code is never changed. */
interface PausedWriterFaults {
  /** Replaces the barrier that observes the cutover blocked by the paused writer. */
  observe?: (sessions: WriterSessions) => Promise<void>;
  /** How long the first wait for the writer's outcome lasts. */
  writerSettleMs?: number;
  /** Receives each actor backend once identified. */
  sessions?: Session[];
}

/**
 * Runs `write` on a paused writer pool and the cutover concurrently: the writer validates against the definition and
 * pauses, the cutover is observed waiting for it, then the writer is released. Both actors are then settled in that
 * order, each on its own (`settleActor`). The first failure is thrown, the same object, with every later failure
 * appended to its cause.
 */
async function cutoverAgainstPausedWriter(
  write: (writerPool: Pool) => Promise<unknown>,
  faults: PausedWriterFaults = {},
): Promise<void> {
  const observer = await admin.connect();
  const actors: Array<{ actor: Actor; observeMs: number }> = [];
  const failures: Error[] = [];
  try {
    let paused: Awaited<ReturnType<typeof pausedWriterPool>> | undefined;
    try {
      const watching = await sessionOf(observer);
      paused = await pausedWriterPool();
      const writer = launch("the writer", paused.owned, write);
      actors.push({ actor: writer, observeMs: faults.writerSettleMs ?? WAIT_MS });
      await bounded(paused.reached, "the writer to validate");
      const cutover = launch("the cutover", await ownedPool(), (cutoverPool) =>
        runTasksPersistentRemovalCutoverMigration(cutoverPool),
      );
      actors.push({ actor: cutover, observeMs: WAIT_MS });
      const writerSession = await bounded(writer.owned.session, "the writer's backend");
      const cutoverSession = await bounded(cutover.owned.session, "the cutover's backend");
      assertOwnSessions(watching, [writerSession, cutoverSession]);
      faults.sessions?.push(writerSession, cutoverSession);
      const observe =
        faults.observe ??
        ((sessions: WriterSessions) =>
          waitsOn(sessions.observer, sessions.cutover.pid, sessions.writer.pid, "the paused writer"));
      await observe({ observer, writer: writerSession, cutover: cutoverSession });
    } catch (error) {
      failures.push(asError(error));
    } finally {
      paused?.release();
    }
    for (const settled of await settleEach(actors, observer)) {
      failures.push(...settled.failures);
      // An outcome already recorded as the observation's failure is not appended to itself.
      if (settled.outcome && !failures.includes(settled.outcome)) failures.push(settled.outcome);
    }
  } finally {
    observer.release();
  }
  const [first, ...later] = failures;
  if (first) throw withLaterFailures(first, later);
}

/**
 * Holds ACCESS SHARE on `properties` from an open reader transaction and runs the cutover concurrently. `observe`
 * runs while the reader is open. The reader is then rolled back and released, and the cutover settled
 * (`settleActor`). Returns the cutover's outcome. Any other failure is thrown instead: the first one, the same object,
 * with the later ones and then the cutover's own error appended to its cause.
 */
async function cutoverBehindReader(
  observe: (cutover: Actor, sessions: { observer: PoolClient; reader: Session; cutover: Session }) => Promise<void>,
): Promise<Error | null> {
  const observer = await admin.connect();
  const failures: Error[] = [];
  let outcome: Error | null | undefined;
  try {
    let reader: PoolClient | undefined;
    let readerOpen = false;
    let cutover: Actor | undefined;
    try {
      const watching = await sessionOf(observer);
      reader = await admin.connect();
      const readerSession = await sessionOf(reader);
      await reader.query("BEGIN");
      readerOpen = true;
      await reader.query("SELECT 1 FROM properties LIMIT 1");
      cutover = launch("the cutover", await ownedPool(), (cutoverPool) =>
        runTasksPersistentRemovalCutoverMigration(cutoverPool),
      );
      const cutoverSession = await bounded(cutover.owned.session, "the cutover's backend");
      assertOwnSessions(watching, [readerSession, cutoverSession]);
      await observe(cutover, { observer, reader: readerSession, cutover: cutoverSession });
    } catch (error) {
      failures.push(asError(error));
    } finally {
      if (reader) {
        let rollbackError: Error | undefined;
        try {
          if (readerOpen) await reader.query("ROLLBACK");
        } catch (error) {
          rollbackError = asError(error);
          failures.push(rollbackError);
        } finally {
          reader.release(rollbackError);
        }
      }
    }
    if (cutover) {
      const settled = await settleActor(cutover, observer);
      failures.push(...settled.failures);
      outcome = settled.outcome;
    }
  } finally {
    observer.release();
  }
  const [first, ...later] = failures;
  if (first) throw withLaterFailures(first, outcome && !failures.includes(outcome) ? [...later, outcome] : later);
  if (outcome === undefined) throw new Error("The cutover never started");
  return outcome;
}

const withoutPersistent = (properties: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "persistent"));

describe("removing the Tasks property persistent (issue #2009)", () => {
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
    tasksId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
  });

  afterAll(async () => {
    assertNothingUnsettled();
    await pool?.end();
    await admin?.end();
  });

  it("seeds a new tenant's Tasks without persistent, and its schema lists none", async () => {
    expect(await persistentDefinitions()).toBe(0);
    const keys = await schemaKeys();
    expect(keys).toContain("notifications");
    expect(keys).not.toContain("persistent");
  });

  it("removes the definition and every stored value, trashed items included, leaving every other value unchanged", async () => {
    await seedOldShape();
    expect(await persistentDefinitions()).toBe(1);
    expect(await schemaKeys()).toContain("persistent");
    const before = await items();
    expect(before.filter((row) => Object.hasOwn(row.properties, "persistent"))).toHaveLength(502);

    await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));

    expect(await persistentDefinitions()).toBe(0);
    const after = await items();
    expect(after.filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
    expect(after).toEqual(before.map((row) => ({ ...row, properties: withoutPersistent(row.properties) })));
    expect(after.find((row) => row.properties.name === "Trashed")).toMatchObject({
      deleted_at: expect.any(String),
      properties: { name: "Trashed", description: "kept" },
    });
    expect(await schemaKeys()).not.toContain("persistent");

    const snapshot = [await items(), await persistentDefinitions()];
    await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));
    expect([await items(), await persistentDefinitions()]).toEqual(snapshot);
  });

  it("skips a tenant without a Tasks database", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runTasksPersistentRemovalCutoverMigration(pool));
    const rows = await runInTenant(
      empty,
      async () => (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM databases")).rows,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("creates the next instance of a completed recurring task without persistent", async () => {
    const task = await runInTenant(tenant, () =>
      createChokePoint(pool).createItem({
        databaseId: tasksId,
        properties: { name: "Water plants", date: "2026-10-12" },
      }),
    );
    // A series stored before #2009 keeps `persistent: true` in its internal template.
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: tasksId,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
        template: { persistent: true },
      }),
    );
    await runInTenant(tenant, () =>
      createChokePoint(pool).updateItem({ databaseId: tasksId, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    const next = (await items()).find((row) => row.properties.seriesId === seriesId && row.id !== task.id);
    expect(next?.properties.status).toBe("notDone");
    expect(next && Object.hasOwn(next.properties, "persistent")).toBe(false);
  });

  describe("a writer that validated persistent before the definition is deleted (R1)", () => {
    it("is waited for by the cutover, and the value its update commits is stripped", async () => {
      await seedOldDefinition();
      const task = await runInTenant(tenant, () =>
        createChokePoint(pool).createItem({ databaseId: tasksId, properties: { name: "Paused update" } }),
      );
      await cutoverAgainstPausedWriter((writerPool) =>
        createChokePoint(writerPool).updateItem(
          { databaseId: tasksId, itemId: task.id, propertiesPatch: { persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      );
      expect(await persistentDefinitions()).toBe(0);
      const stored = (await items()).find((row) => row.id === task.id);
      expect(stored?.properties).toMatchObject({ name: "Paused update" });
      expect(stored && Object.hasOwn(stored.properties, "persistent")).toBe(false);
    });

    it("is waited for by the cutover, and the value its create commits is stripped", async () => {
      await seedOldDefinition();
      await cutoverAgainstPausedWriter((writerPool) =>
        createChokePoint(writerPool).createItem(
          { databaseId: tasksId, properties: { name: "Paused create", persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      );
      expect(await persistentDefinitions()).toBe(0);
      const created = (await items()).find((row) => row.properties.name === "Paused create");
      expect(created).toBeDefined();
      expect(created && Object.hasOwn(created.properties, "persistent")).toBe(false);
    });

    it("refuses a write naming persistent once the cutover has deleted it, and writes nothing", async () => {
      await seedOldDefinition();
      const task = await runInTenant(tenant, () =>
        createChokePoint(pool).createItem({ databaseId: tasksId, properties: { name: "Late writer" } }),
      );
      await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));
      const before = await items();
      const error: unknown = await runInTenant(tenant, () =>
        createChokePoint(pool).updateItem(
          { databaseId: tasksId, itemId: task.id, propertiesPatch: { persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
      expect(error.details).toEqual({ field: "persistent" });
      expect(await items()).toEqual(before);
    });

    it("fails with lock timeout 55P03 behind an open reader, keeping the definition, and a rerun completes", async () => {
      await seedOldShape();
      await cutoverBehindReader(async (cutover) => {
        const error = await bounded(cutover.outcome, "the cutover to time out", WAIT_MS + 5_000);
        expect(lockTimeout.safeParse(error).success).toBe(true);
        // The deleting transaction rolled back; the batches stripped before it stay committed.
        expect(await persistentDefinitions()).toBe(1);
        expect((await items()).filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
      });
      await runInTenant(tenant, () => runTasksPersistentRemovalCutoverMigration(pool));
      expect(await persistentDefinitions()).toBe(0);
      expect((await items()).filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
    });
  });

  describe("settling the concurrent actors when an observation fails (R2-1)", () => {
    it("settles the cutover still waiting for the reader before returning, when the outer wait times out", async () => {
      await seedOldShape();
      const state = await admin.connect();
      try {
        const watching = await sessionOf(state);
        let timedOut: unknown;
        let cutoverSettled = false;
        let cutoverOutcome: Promise<Error | null> | undefined;
        let markSettled: Promise<void> | undefined;
        const sessions: Session[] = [];
        const thrown: unknown = await cutoverBehindReader(async (cutover, observed) => {
          cutoverOutcome = cutover.outcome;
          // Attached before the harness waits for the outcome, so it runs before the harness can return.
          markSettled = cutover.outcome.then(() => {
            cutoverSettled = true;
          });
          sessions.push(observed.cutover);
          await waitsOn(observed.observer, observed.cutover.pid, observed.reader.pid, "the reader");
          // Far shorter than its 5s lock attempt: the cutover is still waiting when this wait gives up.
          try {
            await bounded(cutover.outcome, "the cutover behind the reader", 200);
          } catch (error) {
            timedOut = error;
            throw error;
          }
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(cutoverSettled).toBe(true);
        await markSettled;
        expect(thrown).toBe(timedOut);
        if (!(thrown instanceof Error)) throw new Error("The harness threw no Error");
        expect(thrown.message).toBe("Timed out waiting for the cutover behind the reader");
        expect(thrown.cause).toBeUndefined();
        // Released, the reader no longer held the lock: the cutover acquired it and completed.
        expect(await cutoverOutcome).toBeNull();
        expect(await persistentDefinitions()).toBe(0);
        expect((await items()).filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
        expect(sessions.map((session) => session.pid)).not.toContain(watching.pid);
        expect(await liveSessions(state, sessions)).toEqual([]);
        expect(unsettled).toEqual([]);
      } finally {
        state.release();
      }
    });

    it("still settles the cutover when the observation fails and the writer's settlement times out", async () => {
      await seedOldDefinition();
      const task = await runInTenant(tenant, () =>
        createChokePoint(pool).createItem({ databaseId: tasksId, properties: { name: "Cancelled update" } }),
      );
      const before = (await items()).find((row) => row.id === task.id);
      const state = await admin.connect();
      try {
        const watching = await sessionOf(state);
        const original = new Error("Injected observation failure");
        const sessions: Session[] = [];
        const thrown: unknown = await cutoverAgainstPausedWriter(
          (writerPool) =>
            withTransaction(writerPool, async (client) => {
              await updateItemWithClient(
                client,
                { databaseId: tasksId, itemId: task.id, propertiesPatch: { persistent: true } },
                { writer: USER },
              );
              // Keeps the validation's ACCESS SHARE past the release until its own backend is cancelled.
              await client.query("SELECT pg_sleep(30)");
            }),
          {
            observe: async (observed) => {
              await waitsOn(observed.observer, observed.cutover.pid, observed.writer.pid, "the paused writer");
              throw original;
            },
            writerSettleMs: 1_000,
            sessions,
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(thrown).toBe(original);
        if (!(original.cause instanceof AggregateError)) throw new Error("No later failures were appended");
        const [timedOut, cancelled] = z.tuple([z.instanceof(Error), queryCancelled]).parse(original.cause.errors);
        expect(timedOut.message).toBe("Timed out waiting for the writer to settle");
        expect(cancelled.code).toBe("57014");
        // The cancelled writer rolled back; the cutover, no longer blocked, deleted the definition.
        expect(await persistentDefinitions()).toBe(0);
        expect((await items()).find((row) => row.id === task.id)).toEqual(before);
        expect(sessions.map((session) => session.pid)).not.toContain(watching.pid);
        expect(await liveSessions(state, sessions)).toEqual([]);
        expect(unsettled).toEqual([]);
      } finally {
        state.release();
      }
    });
  });
});
