import "../../domainWriteHooks.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  assertSearchTaskIdentifiersRegistered,
  CORE_TASK_NAMES,
  enqueueJob,
  ensureQueueSchema,
  registerTask,
  runOnce,
  SearchTaskIdentifiersNotRegisteredError,
} from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { SEARCH_FLUSH_TENANT_LOCK_CLASS, withTransaction } from "../../db/pool.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createApiCoreTaskList } from "../../worker.js";
import {
  enqueueItemSearchReindex,
  enqueueTenantSearchReindex,
  handleItemSearchReindexDependentsTask,
} from "../itemSearchFanout.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let foreign: string;
/** The tenant the helpers act in. The queue runs outside any tenant scope, between such steps. */
let scope: string;

const REINDEX = CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS;
const BACKFILL = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
const PAGE_TEXT = CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT;
/** The Inbox owner's recompute of a Journal day's cached entries (inbox/journalInboxCompute.ts). */
const RECOMPUTE = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;
const envelope = z.object({ payload: z.record(z.string(), z.unknown()) });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(scope, fn);
}

async function db(key: string): Promise<string> {
  const database = (await inTenant(() => cp.listDatabases())).find((row) => row.ownerModuleId === key);
  if (!database) throw new Error(`Missing ${key}`);
  return database.id;
}

async function item(moduleId: string, name: string): Promise<string> {
  const databaseId = await db(moduleId);
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

async function relationPropertyId(moduleId: string, key: string): Promise<string> {
  const databaseId = await db(moduleId);
  const property = await inTenant(() => withTransaction(pool, (client) => getPropertyByKey(client, databaseId, key)));
  if (!property) throw new Error(`Missing ${moduleId}.${key}`);
  return property.id;
}

async function link(moduleId: string, key: string, from: string, to: string): Promise<void> {
  const relationProperty = await relationPropertyId(moduleId, key);
  await inTenant(() =>
    cp.createRelation({ relationPropertyId: relationProperty, callerItemId: from, targetItemId: to }),
  );
}

async function unlink(moduleId: string, key: string, from: string, to: string): Promise<void> {
  const relationProperty = await relationPropertyId(moduleId, key);
  await inTenant(() =>
    cp.deleteRelation({ relationPropertyId: relationProperty, callerItemId: from, targetItemId: to }),
  );
}

async function rename(moduleId: string, itemId: string, name: string): Promise<void> {
  const databaseId = await db(moduleId);
  await inTenant(() => cp.updateItem({ databaseId, itemId, propertiesPatch: { name } }));
}

/** Whether the item's search document contains the exact word. */
async function contains(itemId: string, word: string): Promise<boolean> {
  const { rows } = await inTenant(() =>
    pool.query<{ matches: boolean }>(
      "SELECT search_vector @@ plainto_tsquery('czech_simple', $2) AS matches FROM item_search_index WHERE item_id = $1",
      [itemId, word],
    ),
  );
  return rows[0]?.matches ?? false;
}

async function indexedAt(itemId: string): Promise<string | undefined> {
  const { rows } = await inTenant(() =>
    pool.query<{ updated_at: string }>("SELECT updated_at::text FROM item_search_index WHERE item_id = $1", [itemId]),
  );
  return rows[0]?.updated_at;
}

/** The queued payloads of a task, read through the queue's test observation helper. */
async function queued(identifier: string): Promise<Record<string, unknown>[]> {
  return (await readJobPayloadsByIdentifier(admin, identifier)).map((raw) => envelope.parse(raw).payload);
}

function searchHandlers() {
  const taskList = createApiCoreTaskList(pool, createActionRegistry());
  const reindex = taskList[REINDEX];
  const backfill = taskList[BACKFILL];
  const recompute = taskList[RECOMPUTE];
  const pageText = taskList[PAGE_TEXT];
  if (!reindex || !backfill || !recompute || !pageText)
    throw new Error("Search handlers missing from the production API task list");
  return { reindex, backfill, recompute, pageText };
}

/** The keys of the queued reindex jobs, sorted, read through graphile-worker's public `jobs` view. */
async function reindexKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [REINDEX],
  );
  return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
}

/** Every queued job, as identifier and key, read through graphile-worker's public `jobs` view. */
async function allJobs(): Promise<Array<{ task_identifier: string; key: string | null }>> {
  const { rows } = await admin.query<{ task_identifier: string; key: string | null }>(
    "SELECT task_identifier, key FROM graphile_worker.jobs ORDER BY id",
  );
  return rows;
}

const itemKey = (itemId: string) => `item-search-reindex:item:${itemId}`;

const cachedEntries = z.array(z.object({ text: z.string().nullable() })).nullable();

/** The texts of a Journal day's cached Inbox entries (`computed.inboxItems`), or null without a cache. */
async function cachedTexts(dayId: string): Promise<Array<string | null> | null> {
  const { rows } = await inTenant(() =>
    pool.query<{ entries: unknown }>("SELECT computed->'inboxItems' AS entries FROM items WHERE id = $1", [dayId]),
  );
  return cachedEntries.parse(rows[0]?.entries ?? null)?.map((entry) => entry.text) ?? null;
}

/** A test-owned barrier. The first `open` decides whether the waiting actor proceeds or aborts. */
function gate() {
  let open!: (decision?: "proceed" | "abort") => void;
  const opened = new Promise<"proceed" | "abort">((resolve) => {
    open = (decision = "proceed") => resolve(decision);
  });
  return { open, opened };
}

/** What an actor throws when a harness failure opened its gate with `abort`, so its transaction rolls back. */
const ABORTED = new Error("aborted by the test after a harness failure");

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
/** Observes `promise` at once, so a started actor's rejection is never unhandled and can always be awaited. */
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

// Re-throws the exact value, including a falsy one, so the primary failure keeps its identity.
function throwFailure(error: unknown): never {
  throw error;
}

/**
 * A started database actor: its settlement exists from the moment it starts, and `pid` names its own
 * backend once known, the only handle the harness may cancel.
 */
interface Actor {
  name: string;
  settled: Promise<Outcome<unknown>>;
  pid: () => number | undefined;
  /** An error this actor is expected to end with (its own scripted failure, or `ABORTED`). */
  expected?: (error: unknown) => boolean;
}

/** Waits for `signal`; fails with the actor's own error if it ends first, or after the bound. */
async function ready(signal: Promise<unknown>, actor: Actor, label: string): Promise<void> {
  const ended = actor.settled.then((outcome) => {
    if (!outcome.ok) throwFailure(outcome.error);
    throw new Error(`${label}: ${actor.name} ended before it was ready`);
  });
  await bounded(Promise.race([signal, ended]), label);
}

const UNSETTLED = Symbol("unsettled");
async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | typeof UNSETTLED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof UNSETTLED>((resolve) => {
        timer = setTimeout(() => resolve(UNSETTLED), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const cancelRow = z.object({ cancelled: z.boolean() });

/** Sends a cancel signal to an actor's own backend; resolves whether Postgres sent it. */
async function cancelBackend(pid: number): Promise<boolean> {
  const { rows } = await admin.query<{ cancelled: unknown }>("SELECT pg_cancel_backend($1::int) AS cancelled", [pid]);
  return cancelRow.parse(rows[0]).cancelled;
}

interface SettleOptions {
  /** Receives `settled:<name>` for each actor, once it has settled. */
  order?: string[];
  /** How long the first wait lasts before the cancel signal; only the cancellation-failure control shortens it. */
  cancelAfterMs?: number;
  /** The cancellation attempt; only the cancellation-failure control replaces it. */
  cancel?: (pid: number) => Promise<boolean>;
}

/**
 * Awaits every started actor, in order (callers open all their gates first). A timeout is not treated as
 * settlement: an actor still running after `cancelAfterMs` gets a cancel signal for its own backend and is
 * awaited again for up to 10 s. A cancel signal sent is not settlement either, and a failed cancellation
 * attempt is recorded as a cleanup error at its actor's place; the second wait and every later actor's
 * settlement still happen. An actor that still does not settle is reported as unsettled, and the caller
 * must then not restore shared state. Returns the cancellation failures and the actors' unexpected errors
 * in actor order, without the primary failure itself.
 */
async function settleActors(actors: Actor[], primary: { error: unknown } | undefined, options: SettleOptions = {}) {
  const { order, cancelAfterMs = 10_000, cancel = cancelBackend } = options;
  const errors: unknown[] = [];
  let unsettled = false;
  for (const actor of actors) {
    let outcome = await within(actor.settled, cancelAfterMs);
    if (outcome === UNSETTLED) {
      const pid = actor.pid();
      if (pid !== undefined) {
        // Whether the signal was sent does not decide anything: only the second wait shows settlement. The
        // attempt runs inside `then`, so a synchronous throw is recorded like a rejection.
        const cancellation = await settle(Promise.resolve().then(() => cancel(pid)));
        if (!cancellation.ok) errors.push(cancellation.error);
      }
      outcome = await within(actor.settled, 10_000);
    }
    if (outcome === UNSETTLED) {
      unsettled = true;
      errors.push(new Error(`${actor.name} did not settle`));
      continue;
    }
    order?.push(`settled:${actor.name}`);
    if (!outcome.ok && !(primary && outcome.error === primary.error) && !actor.expected?.(outcome.error))
      errors.push(outcome.error);
  }
  return { errors, unsettled };
}

/** The primary failure with every cleanup error after it, or the primary failure itself when there is none. */
function failureOf(primary: { error: unknown }, cleanup: unknown[], message: string): unknown {
  return cleanup.length
    ? new AggregateError([primary.error, ...cleanup], message, { cause: primary.error })
    : primary.error;
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Polls until `waiterPid` is blocked by `holderPid` (observation only; locks create the order). */
async function waitBlocked(holderPid: number, waiterPid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ blocked: boolean }>(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [holderPid, waiterPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${waiterPid} to wait for ${holderPid}`);
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("Missing backend pid");
  return pid;
}

/**
 * Scratch barrier (R1 D1): a dedicated system transaction holds the tenant's search-flush advisory lock, so a
 * writer that reached its pre-commit flush waits there, observably, until `release`. It returns at once, with
 * the release gate and the settlement, so no wait for `held` can hide the holder; the caller opens the gate
 * and settles the holder on every path. `failBeforeLock` makes the holder fail before it locks (a control).
 */
function startFlushLockHolder(tenantId: string, failBeforeLock?: { value: unknown }) {
  const held = gate();
  const release = gate();
  let pid: number | undefined;
  const actor: Actor = {
    name: "flush lock holder",
    pid: () => pid,
    settled: settle(
      runAsSystem("search flush lock holder", () =>
        withTransaction(admin, async (client) => {
          pid = await backendPid(client);
          if (failBeforeLock) throwFailure(failBeforeLock.value);
          await client.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))", [
            SEARCH_FLUSH_TENANT_LOCK_CLASS,
            tenantId,
          ]);
          held.open();
          await release.opened;
        }),
      ),
    ),
  };
  return { actor, held: held.opened, release: () => release.open() };
}

/**
 * A named system transaction on the admin pool, the pool the flush lock holder uses, held open from
 * `opened` until `end` commits it (`proceed`) or rolls it back (`abort`); the actor of the observer's
 * positive control and of the cancellation-failure control (R2-1). It returns at once with its
 * settlement; the caller ends and settles it on every path.
 */
function startHeldTransaction(name: string) {
  const opened = gate();
  const end = gate();
  let pid: number | undefined;
  const actor: Actor = {
    name,
    pid: () => pid,
    expected: (error) => error === ABORTED,
    settled: settle(
      runAsSystem("observer positive control", () =>
        withTransaction(admin, async (client) => {
          pid = await backendPid(client);
          opened.open();
          if ((await end.opened) === "abort") throw ABORTED;
        }),
      ),
    ),
  };
  return { actor, opened: opened.opened, end: end.open };
}

/** A dedicated admin connection that observes the actors' backends, and its own backend pid. */
interface Observer {
  client: PoolClient;
  pid: number;
}

/**
 * Runs `observe` with an observation connection checked out first. The observed actors start inside
 * `observe` and are settled there, before its state assertions. While it runs, no actor can be given the
 * observer's backend, and no observation can borrow a backend an actor released to the pool, as
 * `admin.query` could. The observer is released once `observe` ended. A failure of `observe` keeps its
 * identity (a falsy one too), followed by a release failure.
 */
async function withObserver(observe: (observer: Observer) => Promise<void>): Promise<void> {
  const client = await admin.connect();
  let primary: { error: unknown } | undefined;
  try {
    await observe({ client, pid: await backendPid(client) });
  } catch (error) {
    primary = { error };
  }
  const cleanup: unknown[] = [];
  try {
    client.release();
  } catch (error) {
    cleanup.push(error);
  }
  if (primary) throwFailure(failureOf(primary, cleanup, "An observed control and its observer release failed"));
  if (cleanup.length) throwFailure(cleanup[0]);
}

/**
 * Whether the actor backend `pid` has an open transaction. An actor that has not settled keeps one.
 * The observer asserts first that `pid` is not its own backend. It then reads `pg_stat_activity` on
 * its own connection, and that statement reports the observer's pid as well. Each call is its own
 * autocommit statement, so it reads a fresh activity snapshot; Postgres holds one until the end of the
 * transaction that took it.
 */
async function inTransaction(observer: Observer, pid: number): Promise<boolean> {
  expect(pid).not.toBe(observer.pid);
  const { rows } = await observer.client.query<{ observer: number; open: boolean }>(
    `SELECT pg_backend_pid() AS observer,
       EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND xact_start IS NOT NULL) AS open`,
    [pid],
  );
  expect(rows[0]?.observer).toBe(observer.pid);
  return rows[0]?.open === true;
}

const graphileWorkerModule = z.object({
  makeWorkerUtils: z.custom<(options: { pgPool: Pool }) => Promise<unknown>>((value) => typeof value === "function"),
});
const workerUtilsShape = z.object({
  cleanup: z.custom<(options: { tasks: string[] }) => Promise<void>>((value) => typeof value === "function"),
  release: z.custom<() => Promise<void>>((value) => typeof value === "function"),
});

/**
 * graphile-worker 0.17.3's public garbage collection (`WorkerUtils.cleanup`): `GC_TASK_IDENTIFIERS` deletes task
 * identifier rows and `GC_JOB_QUEUES` queue rows that no job references. Resolved from the queue package, which
 * depends on graphile-worker; this package does not. The caller drains the queue first, and every test that
 * collects identifiers restores the search ones through the production bootstrap (`ensureQueueSchema`) before
 * it ends. Test files run one at a time, so no other test shares the state in between.
 */
async function collectUnusedQueueMetadata(tasks: Array<"GC_TASK_IDENTIFIERS" | "GC_JOB_QUEUES">): Promise<void> {
  const requireFromQueue = createRequire(fileURLToPath(new URL("../../../../queue/package.json", import.meta.url)));
  const { makeWorkerUtils } = graphileWorkerModule.parse(requireFromQueue("graphile-worker"));
  const utils = workerUtilsShape.parse(
    await runAsSystem("queue metadata gc", () => makeWorkerUtils({ pgPool: admin })),
  );
  try {
    await runAsSystem("queue metadata gc", () => utils.cleanup({ tasks }));
  } finally {
    await utils.release();
  }
}

/** Two databases joined by four distinct relation definitions, and two target items A and B. */
async function relationNodes() {
  const source = await inTenant(() => cp.createDatabase({ name: "Uzly" }));
  const target = await inTenant(() => cp.createDatabase({ name: "Cíle" }));
  const definitions: string[] = [];
  for (const key of ["first", "second", "third", "fourth"]) {
    const { property } = await inTenant(() =>
      cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key,
        name: key,
        targetDatabaseId: target.id,
        cardinality: "many_to_many",
      }),
    );
    definitions.push(property.id);
  }
  const [first, second, third, fourth] = definitions;
  if (!first || !second || !third || !fourth) throw new Error("Expected four relation properties");
  const a = (await inTenant(() => cp.createItem({ databaseId: target.id, properties: {} }))).id;
  const b = (await inTenant(() => cp.createItem({ databaseId: target.id, properties: {} }))).id;
  return { source: source.id, a, b, first, second, third, fourth };
}

/**
 * Runs the queued reindex, backfill and Journal recompute jobs with the production API task list's
 * own handlers until none is left, so jobs a running job queues (continuations, an area's project
 * items) run too.
 */
async function runQueued(): Promise<void> {
  const { reindex, backfill, recompute } = searchHandlers();
  // One run may leave jobs of the serialized tenant lane for the next one, so it repeats while it
  // makes progress.
  let remaining = Number.POSITIVE_INFINITY;
  for (;;) {
    await runOnce({ pgPool: admin }, { [REINDEX]: reindex, [BACKFILL]: backfill, [RECOMPUTE]: recompute });
    const left = (await queued(REINDEX)).length + (await queued(BACKFILL)).length + (await queued(RECOMPUTE)).length;
    if (left === 0) return;
    if (left >= remaining) {
      const { rows } = await admin.query<{ task_identifier: string; attempts: number; last_error: string | null }>(
        "SELECT task_identifier, attempts, last_error FROM graphile_worker.jobs ORDER BY id",
      );
      throw new Error(`Search jobs stopped making progress: ${JSON.stringify(rows)}`);
    }
    remaining = left;
  }
}

/** A Journal day and one Inbox entry on it, written through the Inbox capture write. */
async function journalEntry(text: string) {
  const journal = await db("journal");
  const inbox = await db("inbox");
  const day = await inTenant(() =>
    withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journal, "day", new Date("2026-10-27T12:00:00Z"), "UTC"),
    ),
  );
  const entry = await inTenant(() =>
    withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inbox, date: "2026-10-27", time: "12:00", text }),
    ),
  );
  return { inbox, day, entry };
}

/**
 * Fault injection (R1 P2, parent D5): makes the search-index write of exactly one item fail, which no
 * production input can do on demand. The item id reaches the trigger's WHEN clause as a literal quoted
 * by Postgres (`format('%L')` in a DO block, read from a session setting), never interpolated here.
 * Cleanup runs after `run` settled, on the same dedicated client; a failed cleanup discards that
 * client, and a primary failure and a cleanup failure are reported together.
 */
async function withIndexWriteFault(itemId: string, run: () => Promise<void>): Promise<void> {
  const client = await admin.connect();
  let primary: { error: unknown } | undefined;
  try {
    await client.query("SELECT set_config('semprec_test.fault_item', $1, false)", [itemId]);
    await client.query(`CREATE FUNCTION fanout_index_fault_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test index write failure'; END $$`);
    await client.query(`DO $$ BEGIN EXECUTE format(
      'CREATE TRIGGER fanout_index_fault_test BEFORE INSERT OR UPDATE ON item_search_index FOR EACH ROW '
      'WHEN (NEW.item_id = %L::uuid) EXECUTE FUNCTION fanout_index_fault_test()',
      current_setting('semprec_test.fault_item')); END $$`);
    await run();
  } catch (error) {
    primary = { error };
  }
  let cleanup: { error: unknown } | undefined;
  try {
    await client.query("DROP TRIGGER IF EXISTS fanout_index_fault_test ON item_search_index");
    await client.query("DROP FUNCTION IF EXISTS fanout_index_fault_test()");
  } catch (error) {
    cleanup = { error };
  }
  client.release(cleanup ? new Error("Fault trigger cleanup failed; the connection is discarded") : undefined);
  if (primary && cleanup) throw new AggregateError([primary.error, cleanup.error], "Fault test and its cleanup failed");
  if (primary) throw primary.error;
  if (cleanup) throw cleanup.error;
}

describe("search reindex fan-out (issue #1652)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    const role = await runAsSystem("verify fanout role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(pool));
    scope = tenant;
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("puts a renamed project's new title into its tasks' documents once the queued job ran", async () => {
    const project = await item("projects", "Alfaprojekt");
    const task = await item("tasks", "Faktura");
    await link("tasks", "project", task, project);
    await runQueued();
    expect(await contains(task, "alfaprojekt")).toBe(true);
    await rename("projects", project, "Betaprojekt");
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    expect(await contains(task, "betaprojekt")).toBe(false);
    await runQueued();
    expect(await contains(task, "betaprojekt")).toBe(true);
    expect(await contains(task, "alfaprojekt")).toBe(false);
  });

  it("puts a project's new area title into its tasks' documents after the project moves", async () => {
    const oldArea = await item("areas", "Starooblast");
    const newArea = await item("areas", "Novooblast");
    const project = await item("projects", "Web");
    const task = await item("tasks", "Nasazení");
    await link("projects", "area", project, oldArea);
    await link("tasks", "project", task, project);
    await runQueued();
    expect(await contains(task, "starooblast")).toBe(true);
    await unlink("projects", "area", project, oldArea);
    await link("projects", "area", project, newArea);
    expect(await queued(REINDEX)).toContainEqual({ kind: "projectItems", projectItemId: project });
    await runQueued();
    expect(await contains(task, "novooblast")).toBe(true);
    expect(await contains(task, "starooblast")).toBe(false);
  });

  it("reaches the items of an area's projects when the area is renamed, through its projects found at run time", async () => {
    const area = await item("areas", "Zahrada");
    const project = await item("projects", "Skleník");
    const task = await item("tasks", "Zalít");
    await link("projects", "area", project, area);
    await link("tasks", "project", task, project);
    await runQueued();
    await rename("areas", area, "Sad");
    // The write queues only the area's referrers; its projects are found when that job runs.
    expect((await queued(REINDEX)).filter((payload) => payload.kind === "projectItems")).toEqual([]);
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: area });
    await runQueued();
    expect(await contains(task, "sad")).toBe(true);
    expect(await contains(task, "zahrada")).toBe(false);
  });

  it("drops a removed person's name from the event's document", async () => {
    const person = await item("people", "Vlasta");
    const event = await item("events", "Porada");
    await link("events", "people", event, person);
    await runQueued();
    expect(await contains(event, "vlasta")).toBe(true);
    await unlink("events", "people", event, person);
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: event });
    await runQueued();
    expect(await contains(event, "vlasta")).toBe(false);
  });

  it("drops a soft-deleted project's title from its tasks and brings it back after the restore", async () => {
    const project = await item("projects", "Gamaprojekt");
    const task = await item("tasks", "Revize");
    await link("tasks", "project", task, project);
    await runQueued();
    const projects = await db("projects");
    await inTenant(() => cp.softDeleteItem(projects, project));
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    await runQueued();
    expect(await contains(task, "gamaprojekt")).toBe(false);
    await inTenant(() => cp.restoreItem(projects, project));
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    await runQueued();
    expect(await contains(task, "gamaprojekt")).toBe(true);
  });

  it("puts an Inbox entry's new text into its Journal day's cache and document and drops the old one, through the cache owner (R1 F2)", async () => {
    const { inbox, day, entry } = await journalEntry("Mléko");
    // The create queues the day's document (through the new journalDay edge) and the owner's own recompute.
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    expect(await queued(RECOMPUTE)).toContainEqual({ journalDayItemId: day.id });
    await runQueued();
    expect(await cachedTexts(day.id)).toEqual(["Mléko"]);
    expect(await contains(day.id, "mléko")).toBe(true);
    await inTenant(() => cp.updateItem({ databaseId: inbox, itemId: entry.id, propertiesPatch: { text: "Chléb" } }));
    // The update queues the day's document job, which runs the owner's recompute; no recompute job of its own.
    expect((await queued(REINDEX)).filter((payload) => payload.itemId === day.id)).toEqual([
      { kind: "item", itemId: day.id },
    ]);
    expect(await queued(RECOMPUTE)).toEqual([]);
    expect(await cachedTexts(day.id)).toEqual(["Mléko"]);
    await runQueued();
    expect(await cachedTexts(day.id)).toEqual(["Chléb"]);
    expect(await contains(day.id, "chléb")).toBe(true);
    expect(await contains(day.id, "mléko")).toBe(false);
  });

  it("drops a trashed Inbox entry's text from its Journal day's cache and document and brings it back after the restore (R1 F2)", async () => {
    const { inbox, day, entry } = await journalEntry("Pečivo");
    await runQueued();
    expect(await contains(day.id, "pečivo")).toBe(true);
    await inTenant(() => cp.softDeleteItem(inbox, entry.id));
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    expect(await queued(RECOMPUTE)).toEqual([]);
    await runQueued();
    expect(await cachedTexts(day.id)).toEqual([]);
    expect(await contains(day.id, "pečivo")).toBe(false);
    await inTenant(() => cp.restoreItem(inbox, entry.id));
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    expect(await queued(RECOMPUTE)).toEqual([]);
    await runQueued();
    expect(await cachedTexts(day.id)).toEqual(["Pečivo"]);
    expect(await contains(day.id, "pečivo")).toBe(true);
  });

  it("runs a Journal day's item job through the cache owner and another item's through the index write only (R1 F2)", async () => {
    const { day } = await journalEntry("Rohlík");
    const event = await item("events", "Snídaně");
    await runQueued();
    // A value written past the owner (no write path changes another owner's cache), so the job's recompute shows.
    await inTenant(() =>
      withTransaction(pool, (client) =>
        client.query(
          "UPDATE items SET computed = computed - 'inboxItems' WHERE tenant_id = app_tenant_default() AND id = $1",
          [day.id],
        ),
      ),
    );
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await inTenant(() => handleItemSearchReindexDependentsTask(pool, { kind: "item", itemId: day.id }));
      await inTenant(() => handleItemSearchReindexDependentsTask(pool, { kind: "item", itemId: event }));
    } finally {
      setInvalidationHook(() => {});
    }
    expect(await cachedTexts(day.id)).toEqual(["Rohlík"]);
    expect(events.filter((entry) => entry.scope === "item").map((entry) => entry.itemId)).toEqual([day.id]);
    expect(await cachedTexts(event)).toBeNull();
    expect(await contains(event, "snídaně")).toBe(true);
  });

  it("rolls a Journal day's item job back, cache and document together, when its index write fails (R1 F2)", async () => {
    const { inbox, day, entry } = await journalEntry("Máslo");
    await runQueued();
    await inTenant(() => cp.updateItem({ databaseId: inbox, itemId: entry.id, propertiesPatch: { text: "Sýr" } }));
    await withIndexWriteFault(day.id, async () => {
      await expect(
        inTenant(() => handleItemSearchReindexDependentsTask(pool, { kind: "item", itemId: day.id })),
      ).rejects.toThrow("test index write failure");
    });
    expect(await cachedTexts(day.id)).toEqual(["Máslo"]);
    expect(await contains(day.id, "máslo")).toBe(true);
    expect(await contains(day.id, "sýr")).toBe(false);
    await runQueued();
    expect(await cachedTexts(day.id)).toEqual(["Sýr"]);
    expect(await contains(day.id, "sýr")).toBe(true);
  });

  it("queues both ends' documents when an edge is written (R1 P2)", async () => {
    const person = await item("people", "Ota");
    const event = await item("events", "Schůzka");
    await runQueued();
    await link("events", "people", event, person);
    const payloads = await queued(REINDEX);
    expect(payloads).toContainEqual({ kind: "item", itemId: event });
    expect(payloads).toContainEqual({ kind: "item", itemId: person });
    await runQueued();
    expect(await contains(event, "ota")).toBe(true);
  });

  it("queues the database's backfill for a property patch and for a property delete, each on its own, and each job rewrites the item's document (R1 P2, R2-4)", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Archiv" }));
    await inTenant(() => cp.createProperty({ databaseId: collection.id, key: "name", name: "Name", type: "title" }));
    // A select's document text is its option's label; patching the label keeps the stored option key.
    const property = await inTenant(() =>
      cp.createProperty({
        databaseId: collection.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "draft", label: "Zelenomodrý" }] },
      }),
    );
    const entry = await inTenant(() =>
      cp.createItem({ databaseId: collection.id, properties: { name: "Exponát", stage: "draft" } }),
    );
    const backfills = async () => (await queued(BACKFILL)).filter((payload) => payload.databaseId === collection.id);
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
    await runQueued();
    expect(await backfills()).toEqual([]);
    expect(await contains(entry.id, "zelenomodrý")).toBe(true);
    await inTenant(() =>
      cp.updateProperty(property.id, { config: { options: [{ key: "draft", label: "Fialovočervený" }] } }),
    );
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
    // Until the patch's job runs the document still quotes the old label.
    expect(await contains(entry.id, "fialovočervený")).toBe(false);
    await runQueued();
    expect(await backfills()).toEqual([]);
    expect(await contains(entry.id, "fialovočervený")).toBe(true);
    expect(await contains(entry.id, "zelenomodrý")).toBe(false);
    await inTenant(() => cp.deleteProperty(property.id));
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
    expect(await contains(entry.id, "fialovočervený")).toBe(true);
    await runQueued();
    expect(await backfills()).toEqual([]);
    expect(await contains(entry.id, "fialovočervený")).toBe(false);
    // The retained title property is still in the document.
    expect(await contains(entry.id, "exponát")).toBe(true);
  });

  it("leaves a trashed referrer's document as it was when the project is renamed (R1 P2)", async () => {
    const project = await item("projects", "Deltaprojekt");
    const live = await item("tasks", "Živý");
    const trashed = await item("tasks", "Smazaný");
    for (const task of [live, trashed]) await link("tasks", "project", task, project);
    await runQueued();
    const tasksDatabase = await db("tasks");
    await inTenant(() => cp.softDeleteItem(tasksDatabase, trashed));
    await runQueued();
    const before = await indexedAt(trashed);
    await rename("projects", project, "Epsilonprojekt");
    await runQueued();
    expect(await contains(live, "epsilonprojekt")).toBe(true);
    expect(await indexedAt(trashed)).toBe(before);
    expect(await contains(trashed, "epsilonprojekt")).toBe(false);
  });

  it("commits each chunk of referrers on its own and rolls back only a failing later chunk (R1 P2)", async () => {
    const project = await item("projects", "Bořivoj");
    const tasks: string[] = [];
    for (let index = 0; index < 101; index++) {
      const task = await item("tasks", `Úkol ${index}`);
      await link("tasks", "project", task, project);
      tasks.push(task);
    }
    await runQueued();
    await rename("projects", project, "Spytihněv");
    // The production handler is called directly, chunk by chunk, so each chunk's commit is observable.
    // Chunks follow the referrers' id order.
    const ordered = [...tasks].sort();
    const boundary = ordered[99];
    const last = ordered[100];
    if (!boundary || !last) throw new Error("Expected 101 referrers");
    await inTenant(() => handleItemSearchReindexDependentsTask(pool, { kind: "referrers", itemId: project }));
    const staleFirst: string[] = [];
    for (const task of ordered.slice(0, 100)) if (!(await contains(task, "spytihněv"))) staleFirst.push(task);
    expect(staleFirst).toEqual([]);
    expect(await contains(last, "spytihněv")).toBe(false);
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project, afterItemId: boundary });
    await withIndexWriteFault(last, async () => {
      await expect(
        inTenant(() =>
          handleItemSearchReindexDependentsTask(pool, { kind: "referrers", itemId: project, afterItemId: boundary }),
        ),
      ).rejects.toThrow("test index write failure");
    });
    // The first chunk stays committed; the failed chunk wrote nothing.
    const lostFirst: string[] = [];
    for (const task of ordered.slice(0, 100)) if (!(await contains(task, "spytihněv"))) lostFirst.push(task);
    expect(lostFirst).toEqual([]);
    expect(await contains(last, "spytihněv")).toBe(false);
    await runQueued();
    expect(await contains(last, "spytihněv")).toBe(true);
  });

  it("makes existing values of a newly added text property searchable once the queued backfill ran", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Sbírka" }));
    await inTenant(() => cp.createProperty({ databaseId: collection.id, key: "name", name: "Name", type: "title" }));
    const entry = await inTenant(() => cp.createItem({ databaseId: collection.id, properties: { name: "Exponát" } }));
    await runQueued();
    // A value stored before its property existed (as imported data can be): no write path stores an
    // undeclared key, so the fixture writes it directly in the tenant's scope.
    await inTenant(() =>
      withTransaction(pool, (client) =>
        client.query(
          "UPDATE items SET properties = properties || jsonb_build_object('origin', 'Mezopotámie') WHERE tenant_id = app_tenant_default() AND id = $1",
          [entry.id],
        ),
      ),
    );
    expect(await contains(entry.id, "mezopotámie")).toBe(false);
    await inTenant(() => cp.createProperty({ databaseId: collection.id, key: "origin", name: "Origin", type: "text" }));
    expect(await queued(BACKFILL)).toContainEqual({ databaseId: collection.id, onlyMissing: false });
    await runQueued();
    expect(await contains(entry.id, "mezopotámie")).toBe(true);
  });

  it("queues one backfill of the database for repeated property create, patch and delete", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Katalog" }));
    const property = await inTenant(() =>
      cp.createProperty({ databaseId: collection.id, key: "note", name: "Note", type: "text" }),
    );
    await inTenant(() => cp.updateProperty(property.id, { name: "Poznámka" }));
    await inTenant(() => cp.deleteProperty(property.id));
    expect((await queued(BACKFILL)).filter((payload) => payload.databaseId === collection.id)).toEqual([
      { databaseId: collection.id, onlyMissing: false },
    ]);
  });

  it("leaves one queued job for a project whose title changes three times in a row", async () => {
    const project = await item("projects", "První");
    await runQueued();
    for (const name of ["Druhý", "Třetí", "Čtvrtý"]) await rename("projects", project, name);
    expect(
      (await queued(REINDEX)).filter((payload) => payload.kind === "referrers" && payload.itemId === project),
    ).toHaveLength(1);
  });

  it("reindexes more referrers than one chunk through a committed continuation job", async () => {
    const project = await item("projects", "Bořivoj");
    const tasks: string[] = [];
    for (let index = 0; index < 101; index++) {
      const task = await item("tasks", `Úkol ${index}`);
      await link("tasks", "project", task, project);
      tasks.push(task);
    }
    await runQueued();
    await rename("projects", project, "Spytihněv");
    expect((await queued(REINDEX)).filter((payload) => payload.kind === "referrers")).toEqual([
      { kind: "referrers", itemId: project },
    ]);
    await runQueued();
    const stale: string[] = [];
    for (const task of tasks) if (!(await contains(task, "spytihněv"))) stale.push(task);
    expect(stale).toEqual([]);
  });

  it("queues the tenant-wide backfill for a profile language change", async () => {
    await inTenant(() => withTransaction(pool, (client) => enqueueTenantSearchReindex(client)));
    expect(await queued(BACKFILL)).toContainEqual({ onlyMissing: false });
  });

  it("never reaches another tenant's referrers", async () => {
    scope = foreign;
    const foreignProject = await item("projects", "Cizíprojekt");
    const foreignTask = await item("tasks", "Cizí");
    await link("tasks", "project", foreignTask, foreignProject);
    await runQueued();
    scope = tenant;
    const project = await item("projects", "Vlastní");
    await rename("projects", project, "Přejmenovaný");
    await runQueued();
    scope = foreign;
    expect(await contains(foreignTask, "cizíprojekt")).toBe(true);
    expect(await contains(foreignTask, "přejmenovaný")).toBe(false);
  });

  /*
   * R1 F3: X links A then B while Y links B then A, each edge through its own relation definition, interleaved
   * edge by edge. Queued inline, each transaction held its first edge's job rows when it reached the other's,
   * a lock cycle. The jobs are now added at each transaction's pre-commit flush under the tenant's flush lock;
   * a scratch holder of that lock makes both writers wait observably at their flush before either commits.
   */
  interface CrossedOptions {
    /** X throws its own failure after its first edge (the rollback control). */
    xFails?: boolean;
    /** The harness fails, with this exact value, once both writers wait at their gates (a settlement control). */
    failObservation?: { value: unknown };
    /** The lock holder fails before it locks (a settlement control). */
    holderFails?: { value: unknown };
    /** Filled before the call returns or throws: each settled actor in order, and every backend the actors used. */
    trace?: { order: string[]; pids: number[] };
  }

  /**
   * Runs the crossed schedule. Every actor is settled before this returns or throws: on a harness failure the
   * writers' gates open with `abort`, so their transactions roll back, the holder is released, and the primary
   * failure is rethrown with its identity (cleanup errors after it). `actors` lists every actor started.
   */
  async function crossedWrites(nodes: Awaited<ReturnType<typeof relationNodes>>, options: CrossedOptions = {}) {
    const holder = startFlushLockHolder(tenant, options.holderFails);
    const actors: Actor[] = [holder.actor];
    const xLinkedA = gate();
    const xContinue = gate();
    const yLinkedB = gate();
    const yContinue = gate();
    let xPid: number | undefined;
    let yPid: number | undefined;
    const xFailure = new Error("X fails after its first edge");
    let xWrite: Promise<Outcome<string>> | undefined;
    let yWrite: Promise<Outcome<string>> | undefined;
    let primary: { error: unknown } | undefined;
    try {
      await ready(holder.held, holder.actor, "flush lock held");
      xWrite = settle(
        inTenant(() =>
          withTransaction(pool, async (client) => {
            xPid = await backendPid(client);
            const x = await createItemWithClient(client, { databaseId: nodes.source, properties: {} });
            await createRelationWithClient(client, {
              relationPropertyId: nodes.first,
              callerItemId: x.id,
              targetItemId: nodes.a,
            });
            xLinkedA.open();
            if ((await xContinue.opened) === "abort") throw ABORTED;
            if (options.xFails) throw xFailure;
            await createRelationWithClient(client, {
              relationPropertyId: nodes.second,
              callerItemId: x.id,
              targetItemId: nodes.b,
            });
            return x.id;
          }),
        ),
      );
      const x: Actor = {
        name: "X",
        settled: xWrite,
        pid: () => xPid,
        expected: (error) => error === ABORTED || (options.xFails === true && error === xFailure),
      };
      actors.push(x);
      await ready(xLinkedA.opened, x, "X linked A");
      yWrite = settle(
        inTenant(() =>
          withTransaction(pool, async (client) => {
            yPid = await backendPid(client);
            const y = await createItemWithClient(client, { databaseId: nodes.source, properties: {} });
            await createRelationWithClient(client, {
              relationPropertyId: nodes.third,
              callerItemId: y.id,
              targetItemId: nodes.b,
            });
            yLinkedB.open();
            if ((await yContinue.opened) === "abort") throw ABORTED;
            await createRelationWithClient(client, {
              relationPropertyId: nodes.fourth,
              callerItemId: y.id,
              targetItemId: nodes.a,
            });
            return y.id;
          }),
        ),
      );
      const y: Actor = { name: "Y", settled: yWrite, pid: () => yPid, expected: (error) => error === ABORTED };
      actors.push(y);
      await ready(yLinkedB.opened, y, "Y linked B");
      if (options.failObservation) throwFailure(options.failObservation.value);
      xContinue.open();
      if (!options.xFails) await waitBlocked(holder.actor.pid() ?? 0, xPid ?? 0);
      yContinue.open();
      await waitBlocked(holder.actor.pid() ?? 0, yPid ?? 0);
    } catch (error) {
      primary = { error };
    }
    // A writer still at its gate aborts after a harness failure; one already released goes on.
    xContinue.open(primary ? "abort" : "proceed");
    yContinue.open(primary ? "abort" : "proceed");
    holder.release();
    const settlement = await settleActors(actors, primary, { order: options.trace?.order });
    options.trace?.pids.push(...[holder.actor.pid(), xPid, yPid].filter((pid): pid is number => pid !== undefined));
    if (primary) throwFailure(failureOf(primary, settlement.errors, "Crossed writes and their settlement failed"));
    if (settlement.errors.length)
      throw new AggregateError(settlement.errors, "A crossed writer or the lock holder failed");
    const [xOutcome, yOutcome] = await Promise.all([xWrite, yWrite]);
    if (!xOutcome || !yOutcome?.ok) throw new Error("Expected both writers to have run");
    if (options.xFails && !(!xOutcome.ok && xOutcome.error === xFailure)) throw new Error("Expected X's own failure");
    return { x: xOutcome, y: yOutcome.value };
  }

  it.each(["warm", "cold"] as const)(
    "commits X→[A, B] and Y→[B, A] interleaved, both waiting at their flush, with exactly their jobs (R1 F3, %s lane)",
    async (lane) => {
      const nodes = await relationNodes();
      await runQueued();
      // A cold lane: graphile-worker's public GC removes the drained tenant lane's queue row.
      if (lane === "cold") await collectUnusedQueueMetadata(["GC_JOB_QUEUES"]);
      const { x, y } = await crossedWrites(nodes);
      if (!x.ok) throw x.error;
      expect(await reindexKeys()).toEqual([nodes.a, nodes.b, x.value, y].map(itemKey).sort());
      const edges = async (itemId: string) =>
        ((await inTenant(() => cp.listItemRelations(itemId))) ?? []).map((edge) => edge.targetItemId).sort();
      expect(await edges(x.value)).toEqual([nodes.a, nodes.b].sort());
      expect(await edges(y)).toEqual([nodes.a, nodes.b].sort());
    },
  );

  it("adds none of a failed writer's jobs and announces none of its items while the other writer commits (R1 F3)", async () => {
    const nodes = await relationNodes();
    await runQueued();
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    const { x, y } = await crossedWrites(nodes, { xFails: true }).finally(() => setInvalidationHook(() => {}));
    expect(x.ok).toBe(false);
    expect(await reindexKeys()).toEqual([nodes.a, nodes.b, y].map(itemKey).sort());
    const announced = new Set(events.flatMap((event) => (event.scope === "item" ? [event.itemId] : [])));
    expect(announced.has(y)).toBe(true);
    const { rows } = await inTenant(() =>
      pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND id <> $2 ORDER BY id", [
        nodes.source,
        y,
      ]),
    );
    expect(rows).toEqual([]);
    for (const id of announced) expect([nodes.a, nodes.b, y]).toContain(id);
  });

  /** The source database's items, read in the tenant. */
  async function sourceItems(source: string): Promise<string[]> {
    const { rows } = await inTenant(() =>
      pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [source]),
    );
    return rows.map((row) => row.id);
  }

  it("sees an exact-owned held transaction open, and closed once it committed and once it rolled back (R2-1 observer control)", async () => {
    await withObserver(async (observer) => {
      for (const ending of ["proceed", "abort"] as const) {
        const held = startHeldTransaction("held transaction");
        const order: string[] = [];
        let pid: number | undefined;
        let open: boolean | undefined;
        let primary: { error: unknown } | undefined;
        try {
          await ready(held.opened, held.actor, "transaction held");
          pid = held.actor.pid();
          if (pid === undefined) throw new Error("Expected the held transaction's backend");
          open = await inTransaction(observer, pid);
        } catch (error) {
          primary = { error };
        }
        held.end(primary ? "abort" : ending);
        const settlement = await settleActors([held.actor], primary, { order });
        if (primary) throwFailure(failureOf(primary, settlement.errors, "The held transaction control failed"));
        if (settlement.errors.length) throw new AggregateError(settlement.errors, "The held transaction failed");
        if (pid === undefined) throw new Error("Expected the held transaction's backend");
        expect(open).toBe(true);
        expect(order).toEqual(["settled:held transaction"]);
        expect(await held.actor.settled).toEqual(
          ending === "proceed" ? { ok: true, value: undefined } : { ok: false, error: ABORTED },
        );
        expect(await inTransaction(observer, pid)).toBe(false);
      }
    });
  });

  it("keeps settling a stuck actor and every later one when the stuck actor's cancellation attempt fails, reporting the primary failure then the cancellation failure (R2-1)", async () => {
    await withObserver(async (observer) => {
      type Settlement = Awaited<ReturnType<typeof settleActors>>;
      const stuck = startHeldTransaction("stuck transaction");
      const later = startHeldTransaction("later transaction");
      const harnessFailure = new Error("harness failed while both transactions were held");
      const cancelFault = new Error("cancellation attempt failed (test fault)");
      const attempts: Array<{ pid: number; open: boolean }> = [];
      // The labelled fault takes the place of exactly the cancellation query. It records whether the stuck actor
      // is still in its transaction, opens its gate so it really rolls back during the second wait, and rejects.
      const cancel = async (pid: number): Promise<boolean> => {
        attempts.push({ pid, open: await inTransaction(observer, pid) });
        stuck.end("abort");
        throw cancelFault;
      };
      const order: string[] = [];
      let settlement: Settlement | undefined;
      // The harnesses' failure path: the primary failure, every reachable gate opened, every actor settled,
      // then the primary failure with the cleanup errors after it.
      async function harness(): Promise<void> {
        let primary: { error: unknown } | undefined;
        try {
          await ready(stuck.opened, stuck.actor, "stuck transaction held");
          await ready(later.opened, later.actor, "later transaction held");
          throwFailure(harnessFailure);
        } catch (error) {
          primary = { error };
        }
        let result: Settlement;
        try {
          // The stuck actor's gate stays shut here; only the faulted cancellation opens it.
          later.end("abort");
          result = await settleActors([stuck.actor, later.actor], primary, { order, cancelAfterMs: 500, cancel });
        } finally {
          // Every gate is open on every path, whatever the helper did; a gate keeps its first decision.
          stuck.end("abort");
          later.end("abort");
        }
        settlement = result;
        if (primary)
          throwFailure(failureOf(primary, result.errors, "The cancellation control and its settlement failed"));
      }
      const outcome = await settle(harness());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected the harness failure");
      expect(outcome.error).toBeInstanceOf(AggregateError);
      if (!(outcome.error instanceof AggregateError)) throw new Error("Expected the primary and cleanup failures");
      const failures: unknown[] = outcome.error.errors;
      expect(failures).toHaveLength(2);
      expect(failures[0]).toBe(harnessFailure);
      expect(failures[1]).toBe(cancelFault);
      expect(outcome.error.cause).toBe(harnessFailure);
      // Both actors settled inside the helper: the stuck one after its cancellation failed, the later one after it.
      expect(order).toEqual(["settled:stuck transaction", "settled:later transaction"]);
      expect(settlement).toEqual({ errors: [cancelFault], unsettled: false });
      expect(settlement?.errors[0]).toBe(cancelFault);
      const stuckPid = stuck.actor.pid();
      const laterPid = later.actor.pid();
      if (stuckPid === undefined || laterPid === undefined) throw new Error("Expected both transactions' backends");
      expect(attempts).toEqual([{ pid: stuckPid, open: true }]);
      expect(await stuck.actor.settled).toEqual({ ok: false, error: ABORTED });
      expect(await later.actor.settled).toEqual({ ok: false, error: ABORTED });
      for (const pid of [stuckPid, laterPid]) expect(await inTransaction(observer, pid)).toBe(false);
    });
  });

  it.each([
    ["an error", new Error("observation failed")],
    ["a falsy value", undefined],
  ] as const)(
    "settles the lock holder and both crossed writers before rejecting with a harness failure (%s), leaving no effect (R2-1)",
    async (_case, value) => {
      const nodes = await relationNodes();
      await runQueued();
      const keysBefore = await reindexKeys();
      await withObserver(async (observer) => {
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        const trace = { order: [] as string[], pids: [] as number[] };
        const outcome = await settle(crossedWrites(nodes, { failObservation: { value }, trace })).finally(() =>
          setInvalidationHook(() => {}),
        );
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("Expected the harness failure");
        expect(outcome.error).toBe(value);
        expect(trace.order).toEqual(["settled:flush lock holder", "settled:X", "settled:Y"]);
        expect(trace.pids).toHaveLength(3);
        for (const pid of trace.pids) expect(await inTransaction(observer, pid)).toBe(false);
        expect(await reindexKeys()).toEqual(keysBefore);
        expect(await sourceItems(nodes.source)).toEqual([]);
        expect(events).toEqual([]);
      });
    },
  );

  it("rejects with the lock holder's own failure before any writer starts, after the holder settled (R2-1)", async () => {
    const nodes = await relationNodes();
    await runQueued();
    const keysBefore = await reindexKeys();
    await withObserver(async (observer) => {
      const holderFailure = new Error("holder failed before it locked");
      const trace = { order: [] as string[], pids: [] as number[] };
      const outcome = await settle(crossedWrites(nodes, { holderFails: { value: holderFailure }, trace }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected the holder's failure");
      expect(outcome.error).toBe(holderFailure);
      expect(trace.order).toEqual(["settled:flush lock holder"]);
      expect(trace.pids).toHaveLength(1);
      for (const pid of trace.pids) expect(await inTransaction(observer, pid)).toBe(false);
      expect(await reindexKeys()).toEqual(keysBefore);
      expect(await sourceItems(nodes.source)).toEqual([]);
    });
  });

  it("refuses a search write before any effect while the search task identifiers are unregistered, and writes after the bootstrap (R1 D1)", async () => {
    const project = await item("projects", "Omega");
    const task = await item("tasks", "Uzávěrka");
    await runQueued();
    await collectUnusedQueueMetadata(["GC_TASK_IDENTIFIERS"]);
    try {
      await expect(assertSearchTaskIdentifiersRegistered(admin)).rejects.toBeInstanceOf(
        SearchTaskIdentifiersNotRegisteredError,
      );
      const jobsBefore = await allJobs();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(link("tasks", "project", task, project)).rejects.toBeInstanceOf(
          SearchTaskIdentifiersNotRegisteredError,
        );
      } finally {
        setInvalidationHook(() => {});
      }
      expect(events).toEqual([]);
      expect(await allJobs()).toEqual(jobsBefore);
      expect(await inTenant(() => cp.listItemRelations(task))).toEqual([]);
    } finally {
      await ensureQueueSchema(admin);
    }
    await link("tasks", "project", task, project);
    expect(await reindexKeys()).toEqual([project, task].map(itemKey).sort());
  });

  /*
   * R1 D1 (the parent's cold counterexample): a writer holds a fresh, uncommitted inline task identifier row while
   * a worker's own registration of its task list (search identifiers first, the fresh one last) waits on it.
   * With the search identifiers registered by the bootstrap, the registration holds none of the writer's flush
   * rows, so the writer's flush adds its job and commits, and the registration then settles. Without them, the
   * registration holds its own uncommitted search identifier rows while it waits; the writer's flush does not
   * see them registered and refuses before any add_job instead of waiting on them.
   */
  /**
   * Runs the mixed schedule. The writer and the native worker are settled before the bootstrap restores the
   * search identifiers, on every path; after a harness failure the writer's gate opens with `abort`, so its
   * transaction rolls back, and the failure is rethrown with its identity (cleanup errors after it). `order`
   * records each settlement and the restoration.
   */
  async function mixedRegistration(
    state: "registered" | "unregistered",
    options: { failObservation?: { value: unknown }; trace?: { order: string[]; pids: number[] } } = {},
  ) {
    const { failObservation } = options;
    const event = await item("events", "Sraz");
    await runQueued();
    const otherJobs = await allJobs();
    const probe = `searchFlushProbe${state === "registered" ? "Registered" : "Unregistered"}${failObservation ? "Failed" : ""}`;
    if (state === "unregistered") await collectUnusedQueueMetadata(["GC_TASK_IDENTIFIERS"]);
    const order = options.trace?.order ?? [];
    const ran: string[] = [];
    const enqueued = gate();
    const release = gate();
    let writerPid: number | undefined;
    let primary: { error: unknown } | undefined;
    const writer: Actor = {
      name: "writer",
      pid: () => writerPid,
      expected: (error) =>
        error === ABORTED || (state === "unregistered" && error instanceof SearchTaskIdentifiersNotRegisteredError),
      settled: settle(
        inTenant(() =>
          withTransaction(pool, async (client) => {
            writerPid = await backendPid(client);
            await enqueueJob(client, probe, {});
            await enqueueItemSearchReindex(client, { kind: "item", itemId: event });
            enqueued.open();
            if ((await release.opened) === "abort") throw ABORTED;
          }),
        ),
      ),
    };
    const actors: Actor[] = [writer];
    try {
      await ready(enqueued.opened, writer, "writer enqueued");
      const { reindex, backfill, pageText } = searchHandlers();
      // graphile-worker's connections are not named here, so the worker can only be awaited, never cancelled.
      actors.push({
        name: "worker",
        pid: () => undefined,
        settled: settle(
          runOnce(
            { pgPool: admin },
            {
              [BACKFILL]: backfill,
              [PAGE_TEXT]: pageText,
              [REINDEX]: reindex,
              [probe]: registerTask(probe, async () => {
                ran.push(probe);
              }),
            },
          ),
        ),
      });
      if (failObservation) throwFailure(failObservation.value);
      const deadline = Date.now() + 5000;
      let registrationWaits = false;
      while (!registrationWaits && Date.now() < deadline) {
        const { rows } = await admin.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE position('_private_tasks' IN query) > 0
             AND position('unnest' IN query) > 0 AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`,
          [writerPid ?? 0],
        );
        registrationWaits = rows[0]?.waiting === true;
        if (!registrationWaits) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(registrationWaits).toBe(true);
    } catch (error) {
      primary = { error };
    }
    release.open(primary ? "abort" : "proceed");
    const settlement = await settleActors(actors, primary, { order });
    if (writerPid !== undefined) options.trace?.pids.push(writerPid);
    // The identifiers are restored only once every actor settled; an unsettled one keeps the state as it is.
    if (!settlement.unsettled) {
      const restored = await settle(ensureQueueSchema(admin));
      order.push("restored");
      if (!restored.ok) settlement.errors.push(restored.error);
    }
    if (primary) throwFailure(failureOf(primary, settlement.errors, "Mixed registration and its settlement failed"));
    if (settlement.errors.length) throw new AggregateError(settlement.errors, "A mixed-schedule actor failed");
    return { writer: await writer.settled, ran, probe, order, otherJobs, writerPid };
  }

  it.each(["registered", "unregistered"] as const)(
    "settles a writer holding a fresh inline identifier beside a worker's own registration (search identifiers %s, R1 D1)",
    async (state) => {
      const { writer, ran, probe, order, otherJobs } = await mixedRegistration(state);
      expect(order).toEqual(["settled:writer", "settled:worker", "restored"]);
      // The worker ran the writer's probe and search jobs, or the writer's rollback left none.
      expect(await allJobs()).toEqual(otherJobs);
      if (state === "registered") {
        expect(writer).toEqual({ ok: true, value: undefined });
        expect(ran).toEqual([probe]);
      } else {
        expect(writer.ok).toBe(false);
        if (writer.ok) throw new Error("Expected the writer's refusal");
        expect(writer.error).toBeInstanceOf(SearchTaskIdentifiersNotRegisteredError);
        expect(ran).toEqual([]);
      }
    },
  );

  it("settles the writer and the native worker before restoring the identifiers when the observation fails (R2-1)", async () => {
    await withObserver(async (observer) => {
      const failure = new Error("registration observation failed");
      const trace = { order: [] as string[], pids: [] as number[] };
      const outcome = await settle(mixedRegistration("unregistered", { failObservation: { value: failure }, trace }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected the observation failure");
      expect(outcome.error).toBe(failure);
      // Both actors settled before the identifiers were restored, and the aborted writer (which writes only
      // jobs) left none.
      expect(trace.order).toEqual(["settled:writer", "settled:worker", "restored"]);
      expect(trace.pids).toHaveLength(1);
      for (const pid of trace.pids) expect(await inTransaction(observer, pid)).toBe(false);
      await expect(assertSearchTaskIdentifiersRegistered(admin)).resolves.toBeUndefined();
      expect((await allJobs()).filter((job) => job.task_identifier.startsWith("searchFlushProbe"))).toEqual([]);
      expect(await reindexKeys()).toEqual([]);
    });
  });
});
