import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as queue from "@alldots/queue";
import { runAsSystem, runInTenant } from "@alldots/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  insertItemsWithIds,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { runAfterCommit, SEARCH_FLUSH_TENANT_LOCK_CLASS, withTransaction } from "../db/pool.js";
import { enqueueItemSearchReindex } from "../search/itemSearchFanout.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
  assertRelationCreatableWithClient,
  assertRelationTargetLinkableWithClient,
} from "../chokePoint/relationOps.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { insertValueLink, listValueLinksByItemIds, type ValueLinkRow } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { seedSystem } from "../seed/seedSystem.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as schedulerStore from "../scheduler/schedulerStore.js";
import * as valueLinksStore from "../chokePoint/valueLinksStore.js";
import * as inboxSourceGuard from "../inbox/inboxSourceGuard.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { enqueueRollupRecompute, rollupRecomputeJobKey } from "../rollup/recompute.js";
import { executeProposalSteps } from "../inbox/proposalSteps.js";
import { withValueLinkRelationAdmission } from "../chokePoint/valueLinkRelationAdmission.js";

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
const VALUE_LINKS = { ownerProcess: VALUE_LINKS_OWNER_PROCESS };
const BROKEN = { state: "broken" as const, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") };

let pool: Pool;
let chokePoint: ChokePoint;

type Edge = { relationPropertyId: string; callerItemId: string; targetItemId: string };
type Fixture = Awaited<ReturnType<typeof setup>>;
type ParticipantOutcome = { ok: true } | { ok: false; error: unknown };
type RelationOperation = "create" | "update" | "delete";

async function setup(cp: ChokePoint = chokePoint) {
  const projects = await cp.createDatabase({ name: "Projects" });
  const files = await cp.createDatabase({ name: "Files" });
  await cp.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
  const { property: projectsProperty, inverseProperty: filesProperty } = await cp.createRelationProperty({
    sourceDatabaseId: files.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  const file = await cp.createItem({ databaseId: files.id, properties: { name: "a.pdf" } });
  const alpha = await cp.createItem({ databaseId: projects.id, properties: {} });
  const beta = await cp.createItem({ databaseId: projects.id, properties: {} });
  return { files, file, alpha, beta, projectsProperty, filesProperty: filesProperty! };
}

/** The file's `projects` edge to `target` (alpha by default). */
function fileEdge(fx: Fixture, target: { id: string } = fx.alpha): Edge {
  return { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: target.id };
}

function inTx<T>(runtime: Pool, tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtime, fn));
}

function protectedUpdate(client: PoolClient, input: Parameters<typeof updateItemWithClient>[1]) {
  return updateItemWithClient(client, input, { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER });
}

function protectedWrite(
  operation: RelationOperation,
  client: PoolClient,
  edge: Edge,
  metadata?: Record<string, unknown>,
): Promise<unknown> {
  if (operation === "create")
    return createRelationWithClient(client, { ...edge, ...(metadata ? { metadata } : {}) }, VALUE_LINKS, SYSTEM_WRITER);
  if (operation === "update")
    return updateRelationWithClient(client, { ...edge, metadata: metadata ?? {} }, VALUE_LINKS, SYSTEM_WRITER);
  return deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
}

function updateAs(
  writer: WriterIdentity | undefined,
  databaseId: string,
  itemId: string,
  propertiesPatch: Record<string, unknown>,
  cp: ChokePoint = chokePoint,
) {
  return cp.updateItem({ databaseId, itemId, propertiesPatch }, undefined, undefined, writer);
}

async function pidOf(client: PoolClient): Promise<number | undefined> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
}

function outcomeOf(promise: Promise<unknown>): Promise<ParticipantOutcome> {
  return promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function recordEvents(): InvalidationEvent[] {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  return events;
}

function itemEvents(events: InvalidationEvent[], itemId: string): InvalidationEvent[] {
  return events.filter((event) => event.scope === "item" && event.itemId === itemId);
}

/** Inserts a link row (on unless `broken`) for each key of `itemId` in `tenant`. */
function linkIn(
  runtime: Pool,
  tenant: string,
  itemId: string,
  keys: string | readonly string[],
  options: { broken?: boolean; ruleKey?: string } = {},
): Promise<void> {
  return withTenantTransaction(runtime, tenant, async (client) => {
    for (const propertyKey of typeof keys === "string" ? [keys] : keys) {
      await insertValueLink(client, {
        itemId,
        propertyKey,
        ruleKey: options.ruleKey ?? "test",
        sources: [],
        ...(options.broken ? BROKEN : {}),
      });
    }
  });
}

function linksIn(runtime: Pool, tenant: string, itemId: string): Promise<ValueLinkRow[]> {
  return withTenantTransaction(runtime, tenant, (client) => listValueLinksByItemIds(client, [itemId]));
}

async function link(itemId: string, propertyKey: string, state?: "broken"): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, { itemId, propertyKey, ruleKey: "test", ...(state ? BROKEN : {}), sources: [] }),
  );
}

async function linkOf(itemId: string, propertyKey: string): Promise<ValueLinkRow | undefined> {
  const rows = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId]));
  return rows.find((row) => row.propertyKey === propertyKey);
}

async function readStoredLinks(runtime: Pool, tenant: string, itemId: string) {
  return withTenantTransaction(runtime, tenant, async (client) => {
    const result = await client.query<{
      id: string;
      tenant_id: string;
      item_id: string;
      property_key: string;
      rule_key: string;
      state: string;
      broken_by: string | null;
      broken_at: string | null;
      updated_at: string;
    }>(
      `SELECT id, tenant_id, item_id, property_key, rule_key, state, broken_by, broken_at::text, updated_at::text
       FROM value_links WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
      [tenant, itemId],
    );
    return result.rows;
  });
}

async function readStoredItem(runtime: Pool, tenant: string, databaseId: string, itemId: string) {
  return withTenantTransaction(runtime, tenant, async (client) => {
    const result = await client.query<{
      id: string;
      tenant_id: string;
      database_id: string;
      properties: string;
      computed: string;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `SELECT id, tenant_id, database_id, properties::text, computed::text, updated_at::text, deleted_at::text
       FROM items WHERE tenant_id = $1 AND database_id = $2 AND id = $3`,
      [tenant, databaseId, itemId],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw new Error("Expected one scoped item");
    return row;
  });
}

async function readJobs() {
  const result = await pool.query<{
    key: string | null;
    locked_at: Date | null;
    attempts: number;
    max_attempts: number;
  }>("SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs ORDER BY key NULLS FIRST");
  return result.rows;
}

async function jobCount(key?: string): Promise<string | undefined> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE $1::text IS NULL OR key = $1",
    [key ?? null],
  );
  return result.rows[0]?.count;
}

/** The stored row of an item, its link rows and the whole queue: what a refused write must leave untouched. */
async function storedState(runtime: Pool, tenant: string, databaseId: string, itemId: string) {
  return {
    item: await readStoredItem(runtime, tenant, databaseId, itemId),
    links: await readStoredLinks(runtime, tenant, itemId),
    jobs: await readJobs(),
  };
}

async function definitionOf(runtime: Pool, tenant: string, propertyId: string) {
  const definition = await withTenantTransaction(runtime, tenant, (client) =>
    relationsStore.getRelationDefinitionByPropertyId(client, propertyId),
  );
  if (!definition) throw new Error("Missing relation definition");
  return definition;
}

function storedEdges(runtime: Pool, tenant: string, definitionId: string, itemId: string) {
  return withTenantTransaction(runtime, tenant, (client) =>
    relationsStore.listRelationsForItem(client, definitionId, itemId),
  );
}

async function rowLockedBy(
  table: "items" | "item_relations" | "value_links",
  id: string,
  pid: number | undefined,
): Promise<boolean> {
  // xmax ties a locked row to its transaction, and pg_locks ties that transaction to its backend.
  const result = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${table} r JOIN pg_locks l ON l.transactionid::text = r.xmax::text
       WHERE r.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
    [id, pid],
  );
  return result.rows[0]?.held === true;
}

async function graphileJobHeldBy(jobKey: string, holderPid: number | undefined): Promise<boolean> {
  // The public jobs view does not expose xmax, needed to tie this queued row to its lock holder.
  const result = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM graphile_worker._private_jobs j JOIN pg_locks l
       ON l.transactionid::text = j.xmax::text
       WHERE j.key = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted) AS held`,
    [jobKey, holderPid],
  );
  return result.rows[0]?.held === true;
}

async function relationAdvisoryHeldBy(definitionId: string, holderPid: number | undefined): Promise<boolean> {
  const result = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
       AND classid::bigint = ((hashtextextended($2::text, 0) >> 32) & 4294967295::bigint)
       AND objid::bigint = (hashtextextended($2::text, 0) & 4294967295::bigint) AND objsubid = 1) AS held`,
    [holderPid, definitionId],
  );
  return result.rows[0]?.held === true;
}

/** Calls `observe` with the SQL and parameters of every query `client` sends while `body` runs. */
async function observingQueries<T>(
  client: PoolClient,
  observe: (sql: string, params: unknown) => void,
  body: () => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = client.query;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  client.query = new Proxy(client.query, {
    apply(query, receiver, args: unknown[]) {
      observe(typeof args[0] === "string" ? args[0] : "", args[1]);
      return Reflect.apply(query, receiver, args);
    },
  });
  try {
    return await body();
  } finally {
    client.query = original;
  }
}

/** A proposal that rewrites the file's projects to the alpha edge it already has, locking definition and edge. */
function holdProposal(client: PoolClient, fx: Fixture) {
  return executeProposalSteps(
    client,
    [
      {
        ref: "same",
        op: "update",
        role: "primary",
        itemId: fx.file.id,
        before: { relations: { projects: [fx.alpha.id] } },
        after: { relations: { projects: [fx.alpha.id] } },
      },
    ],
    { writer: USER, sourceInboxItemId: null },
  );
}

function throwFailure(error: unknown): never {
  // Re-throw the exact value, including undefined, from a test-owned operation.
  throw error;
}

function combineFailure(
  failure: { error: unknown } | undefined,
  errors: unknown[],
  message: string,
): { error: unknown } {
  if (failure) return { error: new AggregateError([failure.error, ...errors], message, { cause: failure.error }) };
  if (errors.length === 1) return { error: errors[0] };
  return { error: new AggregateError(errors, message) };
}

interface RuntimeOperations {
  run<T>(start: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
  onCancel(cancel: () => void): void;
  consume(operation: Promise<unknown>, expected: unknown): void;
}

const fixtureCancellations = new Set<Set<() => void>>();

/**
 * Runs `body` against a fresh runtime-role pool and always closes it. Operations started through `run` are settled
 * before the pool ends, and an operation's rejection fails the test unless `consume` claimed it; every barrier is
 * released when cleanup starts, and clients still checked out then are destroyed.
 */
async function withRuntimePool<T>(body: (runtime: Pool, operations: RuntimeOperations) => Promise<T>): Promise<T> {
  const runtime = await createRuntimeRolePool(pool, "alldots_data");
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  const active = new Map<PoolClient, object>();
  const clientErrors: unknown[] = [];
  const onClientError = (error: Error) => clientErrors.push(error);
  let closing = false;
  const cancellations = new Set<() => void>();
  fixtureCancellations.add(cancellations);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      client.release(true);
    } catch (error) {
      clientErrors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
    client.on("error", onClientError);
    // pg-pool 3.14 emits acquire before assigning release; defer until that stack returns.
    if (closing) queueMicrotask(() => destroy(client, token));
  };
  const onRelease = (_error: Error | undefined, client: PoolClient) => {
    active.delete(client);
    client.removeListener("error", onClientError);
  };
  runtime.on("acquire", onAcquire);
  runtime.on("release", onRelease);
  const pending = new Set<Promise<void>>();
  const outcomes: Array<{ error?: { value: unknown }; consumed: boolean }> = [];
  const outcomeByOperation = new WeakMap<Promise<unknown>, (typeof outcomes)[number]>();
  const operations: RuntimeOperations = {
    run: <U>(start: () => Promise<U>): Promise<U> => {
      const started = Promise.resolve().then(() => {
        if (closing) throw new Error("Runtime fixture is closing");
        return start();
      });
      const outcome: { error?: { value: unknown }; consumed: boolean } = { consumed: false };
      outcomes.push(outcome);
      outcomeByOperation.set(started, outcome);
      const settled = started.then(
        () => {},
        (error: unknown) => {
          outcome.error = { value: error };
        },
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return started;
    },
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    onCancel: (cancel) => {
      if (closing) cancel();
      else cancellations.add(cancel);
    },
    consume: (operation, expected) => {
      const outcome = outcomeByOperation.get(operation);
      if (!outcome?.error || outcome.error.value !== expected) throw new Error("Unexpected participant outcome");
      outcome.consumed = true;
    },
  };
  const work = Promise.resolve()
    .then(() => body(runtime, operations))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = await bounded(work, 12000);
  } catch (error) {
    outcome = { error };
  }
  closing = true;
  for (const cancel of cancellations) {
    try {
      cancel();
    } catch (error) {
      clientErrors.push(error);
    }
  }
  if ("value" in outcome && (active.size > 0 || pending.size > 0 || runtime.waitingCount > 0)) {
    clientErrors.push(new Error("Runtime body returned with owned work still pending"));
  }
  for (const [client, token] of active) destroy(client, token);
  const end = runtime.end();
  const waiting = (async () => {
    const deadline = Date.now() + 4000;
    while (runtime.waitingCount > 0) {
      if (Date.now() >= deadline) throw new Error("Runtime pool waiters did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const cleanup = Promise.allSettled([end, work, operations.settle(), waiting]);
  const removeListeners = () => {
    runtime.removeListener("acquire", onAcquire);
    runtime.removeListener("release", onRelease);
    fixtureCancellations.delete(cancellations);
  };
  try {
    const results = await bounded(cleanup, 10000);
    for (const result of results) if (result.status === "rejected") clientErrors.push(result.reason);
    const finished = await work;
    if ("error" in finished && (!("error" in outcome) || finished.error !== outcome.error)) {
      clientErrors.push(finished.error);
    }
    for (const entry of outcomes) {
      if (entry.error !== undefined && !entry.consumed) clientErrors.push(entry.error.value);
    }
    removeListeners();
  } catch (error) {
    clientErrors.push(error);
    // A failed watchdog must keep owning late arrivals until the actual cleanup settles.
    void cleanup.then(removeListeners);
  }
  if (clientErrors.length) {
    const errors = "error" in outcome ? [outcome.error, ...clientErrors] : clientErrors;
    throw new AggregateError(errors, "Test and runtime cleanup failed", { cause: errors[0] });
  }
  if ("error" in outcome) throwFailure(outcome.error);
  return outcome.value;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  for (const cancellations of fixtureCancellations) cancellations.add(resolve);
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Barrier timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Awaits an operation started through `operations.run`, expects it to reject like `expected` and claims it. */
async function expectRuntimeRejection(
  operations: RuntimeOperations,
  operation: Promise<unknown>,
  expected: unknown,
): Promise<void> {
  const result = await bounded(operation).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect(result).toMatchObject({ error: expected });
  if (!("error" in result)) throw new Error("Expected participant rejection");
  operations.consume(operation, result.error);
}

/**
 * Runs `hold` in a transaction on `holderPool` and keeps that transaction open while `body` runs, then lets it
 * commit (or throw `rollback`). A failure of the body and of the holder are both reported.
 */
async function whileHolding(
  holderPool: Pool,
  tenant: string,
  hold: (client: PoolClient) => Promise<unknown>,
  body: (holderPid: number | undefined) => Promise<void>,
  rollback?: Error,
): Promise<void> {
  const held = barrier();
  const release = barrier();
  let holderPid: number | undefined;
  const holder = outcomeOf(
    inTx(holderPool, tenant, async (client) => {
      holderPid = await pidOf(client);
      await hold(client);
      held.resolve();
      await bounded(release.promise);
      if (rollback) throw rollback;
    }),
  );
  let failure: { error: unknown } | undefined;
  try {
    await bounded(held.promise);
    expect(holderPid).toBeTypeOf("number");
    await body(holderPid);
  } catch (error) {
    failure = { error };
  } finally {
    release.resolve();
    try {
      const result = await bounded(holder, 15000);
      if (rollback) expect(result).toEqual({ ok: false, error: rollback });
      else if (!result.ok) throwFailure(result.error);
    } catch (error) {
      failure = combineFailure(failure, [error], "Test and holder cleanup failed");
    }
  }
  if (failure !== undefined) throwFailure(failure.error);
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Participant did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitBlocked(holderPid: number, competitorPid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [holderPid, competitorPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${competitorPid} to wait for ${holderPid}`);
}

/** Runs `body` with the seeded Tasks database of tenant zero on a fresh runtime pool. */
async function withSeededTasks(body: (runtime: Pool, cp: ChokePoint, tasksId: string) => Promise<void>) {
  await seedSystem(pool);
  await withRuntimePool(async (runtime) => {
    const cp = createChokePoint(runtime);
    const tasks = (await runInTenant(getTenantZeroId(), () => cp.listDatabases())).find((db) => db.key === "tasks");
    if (!tasks) throw new Error("Missing Tasks database");
    await body(runtime, cp, tasks.id);
  });
}

/**
 * Performs a valueLinks-owned patch of a seeded task with an update heartbeat watching it. Refused: nothing is
 * stored, queued or announced. Accepted: the patch is stored as `expected`, the heartbeat fires on the write's
 * client, one item update is announced and the link rows are unchanged. Returns the state before the write.
 */
async function expectHandoffTaskWrite(
  runtime: Pool,
  task: { databaseId: string; id: string },
  propertiesPatch: Record<string, unknown>,
  expected: Record<string, unknown> | "refused",
) {
  const tenant = getTenantZeroId();
  const heartbeat = await withTenantTransaction(runtime, tenant, async (client) => {
    const project = await client.query<{ id: string }>(
      "SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'projects' LIMIT 1",
    );
    if (!project.rows[0]) throw new Error("Missing seeded project");
    return schedulerStore.createHeartbeat(client, {
      projectItemId: project.rows[0].id,
      name: "Task update probe",
      rule: { kind: "onItemEvent", databaseId: task.databaseId, event: "update" },
      actionId: "noop",
    });
  });
  const jobKey = schedulerStore.heartbeatFireJobKey(heartbeat.id, task.id);
  const before = await storedState(runtime, tenant, task.databaseId, task.id);
  expect(before.jobs.some((row) => row.key === jobKey)).toBe(false);
  const enqueue = vi.spyOn(queue, "enqueueJob");
  const events = recordEvents();
  let writeClient: PoolClient | undefined;
  const write = inTx(runtime, tenant, (client) => {
    writeClient = client;
    return protectedUpdate(client, { databaseId: task.databaseId, itemId: task.id, propertiesPatch });
  });
  if (expected === "refused") {
    await expect(write).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    expect(await storedState(runtime, tenant, task.databaseId, task.id)).toEqual(before);
    expect(enqueue).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    return before;
  }
  expect((await write).properties).toMatchObject(expected);
  const after = await storedState(runtime, tenant, task.databaseId, task.id);
  const stored: unknown = JSON.parse(after.item.properties);
  expect(stored).toMatchObject(expected);
  expect(after.links).toEqual(before.links);
  expect(after.jobs).toContainEqual({ key: jobKey, locked_at: null, attempts: 0, max_attempts: 3 });
  expect(writeClient).toBeDefined();
  expect(enqueue).toHaveBeenCalledWith(
    writeClient,
    queue.CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE,
    { heartbeatId: heartbeat.id, itemId: task.id },
    expect.objectContaining({ jobKey }),
  );
  expect(events).toEqual([expect.objectContaining({ scope: "item", itemId: task.id, op: "update" })]);
  return before;
}

/** The seeded Inbox of tenant zero, its type relation and a factory for a page-content type. */
async function seededInbox(cp: ChokePoint) {
  const tenant = getTenantZeroId();
  const dbs = await runInTenant(tenant, () => cp.listDatabases());
  const inbox = dbs.find((db) => db.ownerModuleId === "inbox");
  const types = dbs.find((db) => db.ownerModuleId === "inboxItemTypes");
  if (!inbox || !types) throw new Error("Missing Inbox databases");
  const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
  if (!property) throw new Error("Missing Inbox type relation");
  const createType = (client: PoolClient, name = "Page") =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: types.id,
      name,
      emoji: name.slice(0, 1),
      processingMethod: "pageContent",
    });
  return { inbox, types, property, createType };
}

/** An Inbox item typed with a new page type, holding an on link of its `type`. */
function typedInboxItem(runtime: Pool, fx: Awaited<ReturnType<typeof seededInbox>>) {
  return withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
    const type = await fx.createType(client);
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: fx.inbox.id,
      date: "2026-10-01",
      time: "09:00",
      text: "Source",
      type: type.id,
    });
    await insertValueLink(client, { itemId: item.id, propertyKey: "type", ruleKey: "test", sources: [] });
    return { item, type };
  });
}

describe("value link state on writes", () => {
  beforeAll(() => {
    pool = getTestPool();
    pool.options.connectionTimeoutMillis = 2500;
    pool.options.statement_timeout = 5000;
    pool.options.query_timeout = 7000;
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("plain properties", () => {
    it.each([
      ["a user write that changes the value breaks it with brokenBy user", USER, "b.pdf", "user"],
      ["an agent write breaks it with brokenBy agent", AGENT, "b.pdf", "agent"],
      ["a system write leaves it on", SYSTEM_WRITER, "b.pdf", null],
      ["a write without a writer identity leaves it on", undefined, "c.pdf", null],
      ["a user patch that sets the value it already holds leaves it on", USER, "a.pdf", null],
    ] as const)("%s", async (_name, writer, name, brokenBy) => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await updateAs(writer, files.id, file.id, { name });

      const row = await linkOf(file.id, "name");
      if (brokenBy === null) expect(row).toMatchObject({ state: "on", brokenBy: null, brokenAt: null });
      else {
        expect(row).toMatchObject({ state: "broken", brokenBy });
        expect(row?.brokenAt).not.toBeNull();
      }
    });

    it("only the keys whose value changed are broken", async () => {
      const { files, file } = await setup();
      await chokePoint.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
      await updateAs(undefined, files.id, file.id, { note: "n" });
      await link(file.id, "name");
      await link(file.id, "note");

      await updateAs(USER, files.id, file.id, { name: "b.pdf", note: "n" });

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken" });
      expect(await linkOf(file.id, "note")).toMatchObject({ state: "on" });
    });

    it("two writes keep the first brokenBy and brokenAt", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      await updateAs(USER, files.id, file.id, { name: "b.pdf" });
      const first = await linkOf(file.id, "name");

      await updateAs(AGENT, files.id, file.id, { name: "c.pdf" });

      const second = await linkOf(file.id, "name");
      expect(second).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(second?.brokenAt).toBe(first?.brokenAt);
    });

    it("a write to an unlinked property changes no link", async () => {
      const { files, file } = await setup();

      await updateAs(USER, files.id, file.id, { name: "b.pdf" });

      expect(await linkOf(file.id, "name")).toBeUndefined();
    });

    it("rolls the link state back together with a failed write", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      const events = recordEvents();

      await expect(
        withTransaction(pool, async (client) => {
          await updateItemWithClient(
            client,
            { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
            { writer: USER },
          );
          expect(events).toEqual([]);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      expect(events).toEqual([]);
      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      expect((await chokePoint.getItem(files.id, file.id))?.properties.name).toBe("a.pdf");
    });
  });

  describe("relation edges", () => {
    it("breaks and announces linked values on both definition sides once", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");
      await link(fx.alpha.id, "files");
      const actorId = randomUUID();
      const events = recordEvents();

      await chokePoint.createRelation(fileEdge(fx), USER, actorId);
      expect(events.filter((event) => event.scope === "item")).toHaveLength(2);
      await chokePoint.createRelation(fileEdge(fx), USER, actorId);
      expect(events.filter((event) => event.scope === "item")).toHaveLength(2);

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(await linkOf(fx.alpha.id, "files")).toMatchObject({ state: "broken", brokenBy: "user" });
      for (const itemId of [fx.file.id, fx.alpha.id]) {
        expect(itemEvents(events, itemId)).toEqual([expect.objectContaining({ op: "update", userId: actorId })]);
      }
    });

    it("breaks both sides of a self-edge after commit only, announcing the item once", async () => {
      const database = await chokePoint.createDatabase({ name: "Self relations" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: database.id,
        targetDatabaseId: database.id,
        key: "outgoing",
        name: "Outgoing",
        cardinality: "many_to_many",
        inverse: { key: "incoming", name: "Incoming" },
      });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await link(item.id, "outgoing");
      await link(item.id, "incoming");
      const actorId = randomUUID();
      const events = recordEvents();
      const createSelfEdge = (client: PoolClient) =>
        createRelationWithClient(
          client,
          { relationPropertyId: property.id, callerItemId: item.id, targetItemId: item.id },
          undefined,
          USER,
          actorId,
        );
      const rollback = new Error("rollback self-edge");

      await expect(
        withTransaction(pool, async (client) => {
          await createSelfEdge(client);
          expect(events).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(events).toEqual([]);
      expect(await linkOf(item.id, "outgoing")).toMatchObject({ state: "on" });
      expect(await linkOf(item.id, "incoming")).toMatchObject({ state: "on" });
      expect(await chokePoint.listItemRelations(item.id, property.id)).toEqual([]);

      await withTransaction(pool, async (client) => {
        await createSelfEdge(client);
        expect(events).toEqual([]);
      });
      expect(await linkOf(item.id, "outgoing")).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(await linkOf(item.id, "incoming")).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(itemEvents(events, item.id)).toEqual([expect.objectContaining({ userId: actorId })]);
    });

    it("a system edge leaves the link on and a second user edge breaks it", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");
      await chokePoint.createRelation(fileEdge(fx), SYSTEM_WRITER);
      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.createRelation(fileEdge(fx, fx.beta), USER);

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting the edge through the project's files property breaks the file's link", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");

      await chokePoint.createRelation(
        { relationPropertyId: fx.filesProperty.id, callerItemId: fx.alpha.id, targetItemId: fx.file.id },
        AGENT,
      );

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("deleting an edge breaks the link, deleting an absent edge does not", async () => {
      const fx = await setup();
      await chokePoint.createRelation(fileEdge(fx));
      await link(fx.file.id, "projects");

      await chokePoint.deleteRelation(fileEdge(fx, fx.beta), USER);
      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.deleteRelation(fileEdge(fx), USER);
      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting an existing edge and replacing metadata leave the link on", async () => {
      const fx = await setup();
      await chokePoint.createRelation(fileEdge(fx));
      await link(fx.file.id, "projects");

      await chokePoint.createRelation({ ...fileEdge(fx), metadata: { note: "x" } }, USER);
      await chokePoint.updateRelation({ ...fileEdge(fx), metadata: { note: "y" } }, USER);

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on" });
    });
  });

  describe("valueLinks handoff", () => {
    it.each([
      ["timeFrom", "missing", "timed"],
      ["timeFrom", "broken", "timed"],
      ["timeFrom", "on", "timed"],
      ["timeTo", "missing", "timed"],
      ["timeTo", "broken", "timed"],
      ["timeTo", "on", "timed"],
      ["timeFrom", "missing", "undated"],
      ["timeTo", "missing", "undated"],
    ] as const)(
      "enforces the date-off Tasks handoff when the %s link is %s on a %s task",
      async (key, state, shape) => {
        await withSeededTasks(async (runtime, cp, tasksId) => {
          const tenant = getTenantZeroId();
          const properties =
            shape === "timed"
              ? { name: "Timed", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" }
              : { name: "Undated" };
          const task = await runInTenant(tenant, () => cp.createItem({ databaseId: tasksId, properties }));
          await linkIn(
            runtime,
            tenant,
            task.id,
            ["date", "timeFrom", "timeTo"].filter((entry) => entry !== key),
          );
          if (state !== "missing") await linkIn(runtime, tenant, task.id, key, { broken: state === "broken" });

          await expectHandoffTaskWrite(
            runtime,
            task,
            { date: null },
            state === "on" ? { date: null, timeFrom: null, timeTo: null, time: null } : "refused",
          );
        });
      },
      30000,
    );

    it.each([
      ["timeFrom", "missing"],
      ["timeFrom", "broken"],
      ["timeFrom", "on"],
      ["timeTo", "missing"],
      ["timeTo", "broken"],
      ["timeTo", "on"],
    ] as const)(
      "requires an active link for a retained legacy %s canonicalized by a date patch: %s",
      async (key, state) => {
        await withSeededTasks(async (runtime, _cp, tasksId) => {
          const tenant = getTenantZeroId();
          // Historical valid noncanonical value; current production writes normalize it on entry.
          const task = await withTenantTransaction(runtime, tenant, (client) =>
            itemsStore.insertItem(client, {
              databaseId: tasksId,
              properties: {
                name: "Old",
                date: "2026-10-13",
                timeFrom: key === "timeFrom" ? "9:00" : "09:00",
                timeTo: key === "timeTo" ? "" : "10:00",
                time: key === "timeFrom" ? "9:00–10:00" : "09:00",
              },
            }),
          );
          await linkIn(runtime, tenant, task.id, "date");
          if (state !== "missing") await linkIn(runtime, tenant, task.id, key, { broken: state === "broken" });
          const canonical = {
            name: "Old",
            date: "2026-10-14",
            // A write that names `date` stores the effective day; with no host event it is the date.
            effectiveDate: "2026-10-14",
            timeFrom: "09:00",
            timeTo: key === "timeTo" ? null : "10:00",
            time: key === "timeTo" ? "09:00" : "09:00–10:00",
          };

          const before = await expectHandoffTaskWrite(
            runtime,
            task,
            { date: "2026-10-14" },
            state === "on" ? canonical : "refused",
          );

          if (state !== "on") return;
          const after = await readStoredItem(runtime, tenant, tasksId, task.id);
          expect(after).toEqual({ ...before.item, properties: after.properties, updated_at: after.updated_at });
          const stored: unknown = JSON.parse(after.properties);
          expect(stored).toEqual(canonical);
          expect(after.updated_at).not.toBe(before.item.updated_at);
        });
      },
      30000,
    );

    it.each([
      ["start time 09:00", { timeFrom: "09:00" }, { timeFrom: "09:00", time: "09:00" }],
      ["start time null", { timeFrom: null }, { timeFrom: null, time: null }],
      [
        "end time 10:00",
        { timeFrom: "09:00", timeTo: "10:00" },
        { timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" },
      ],
      ["end time null", { timeFrom: "09:00", timeTo: null }, { timeFrom: "09:00", timeTo: null, time: "09:00" }],
    ] as const)(
      "does not require a link for an unchanged omitted canonical %s",
      async (_name, times, expected) => {
        await withSeededTasks(async (runtime, cp, tasksId) => {
          const tenant = getTenantZeroId();
          const task = await runInTenant(tenant, () =>
            cp.createItem({ databaseId: tasksId, properties: { name: "Task", date: "2026-10-13", ...times } }),
          );
          await linkIn(runtime, tenant, task.id, "date");

          await expectHandoffTaskWrite(runtime, task, { date: "2026-10-14" }, { date: "2026-10-14", ...expected });

          expect((await readStoredLinks(runtime, tenant, task.id)).map((entry) => entry.property_key)).toEqual([
            "date",
          ]);
        });
      },
      30000,
    );

    it.each(["missing", "broken"] as const)(
      "rejects every protected relation write with a %s link row and writes no edge",
      async (state) => {
        const fx = await setup();
        if (state === "broken") await link(fx.file.id, "projects", "broken");
        for (const operation of ["create", "update", "delete"] as const) {
          await expect(
            withTransaction(pool, (client) => protectedWrite(operation, client, fileEdge(fx))),
          ).rejects.toMatchObject({ code: "owner_violation" });
        }
        const { rows } = await pool.query<{ "?column?": number }>("SELECT 1 FROM item_relations");
        expect(rows).toHaveLength(0);
      },
    );

    it("writes protected relations with an on row and leaves the state on", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");

      await withTransaction(pool, async (client) => {
        await protectedWrite("create", client, fileEdge(fx));
        await protectedWrite("delete", client, fileEdge(fx));
      });

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on", brokenBy: null });
    });

    it.each([false, true])(
      "a protected plain property write with an on row (%s) is stored and keeps it on",
      async (linked) => {
        const { files, file } = await setup();
        if (linked) await link(file.id, "name");

        const write = withTransaction(pool, (client) =>
          protectedUpdate(client, { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } }),
        );

        if (linked) await write;
        else await expect(write).rejects.toMatchObject({ code: "owner_violation" });
        const { rows } = await pool.query<{ name: string | null }>(
          "SELECT properties->>'name' AS name FROM items WHERE id = $1",
          [file.id],
        );
        expect(rows).toEqual([{ name: linked ? "z.pdf" : "a.pdf" }]);
        if (linked) expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      },
    );
  });

  describe("protected writes on runtime connections", () => {
    it("keeps the Inbox missing-source error after a real purge", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const inbox = await seededInbox(cp);
        const { item, type } = await typedInboxItem(runtime, inbox);
        const edge = { relationPropertyId: inbox.property.id, callerItemId: item.id, targetItemId: type.id };
        await runInTenant(tenant, () => cp.softDeleteItem(inbox.inbox.id, item.id));
        await runInTenant(tenant, () => cp.purgeExpiredTrashSubtree(item.id, new Date(Date.now() + 60000)));
        // The purge removes the item's own link rows, so the value-link process no longer holds the `type` handoff and is
        // refused before lookup; a user write still gets the missing-source error.
        expect(await linksIn(runtime, tenant, item.id)).toEqual([]);
        const events = recordEvents();

        await expect(inTx(runtime, tenant, (client) => protectedWrite("delete", client, edge))).rejects.toMatchObject({
          status: 403,
          code: "owner_violation",
        });
        await expect(runInTenant(tenant, () => cp.deleteRelation(edge))).rejects.toMatchObject({
          status: 404,
          code: "not_found",
        });

        expect(events).toEqual([]);
        expect(await linksIn(runtime, tenant, item.id)).toEqual([]);
      });
    });

    it("refuses protected Inbox deletion when its trashed source is locked", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const inbox = await seededInbox(cp);
          const { item, type } = await typedInboxItem(holderPool, inbox);
          await runInTenant(tenant, () => cp.softDeleteItem(inbox.inbox.id, item.id));
          const edge = { relationPropertyId: inbox.property.id, callerItemId: item.id, targetItemId: type.id };
          const definition = await definitionOf(holderPool, tenant, inbox.property.id);
          const beforeEdges = await storedEdges(holderPool, tenant, definition.id, item.id);
          const beforeJobs = await jobCount();
          const events = recordEvents();

          await whileHolding(
            holderPool,
            tenant,
            (client) => deleteRelationWithClient(client, edge, undefined, USER),
            async (holderPid) => {
              expect(await rowLockedBy("items", item.id, holderPid)).toBe(true);
              await expect(
                inTx(contenderPool, tenant, (client) => protectedWrite("delete", client, edge)),
              ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
              expect(events).toEqual([]);
              expect(await jobCount()).toBe(beforeJobs);
              expect(await storedEdges(contenderPool, tenant, definition.id, item.id)).toEqual(beforeEdges);
            },
          );

          expect((await linksIn(holderPool, tenant, item.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
        }),
      );
    }, 30000);

    it("preserves proposed-nil target validation without taking a link lease", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const inbox = await seededInbox(createChokePoint(runtime));
        const target = await withTenantTransaction(runtime, tenant, (client) => inbox.createType(client));
        const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");

        await inTx(runtime, tenant, (client) =>
          assertRelationTargetLinkableWithClient(
            client,
            { relationPropertyId: inbox.property.id, targetItemId: target.id },
            VALUE_LINKS,
            SYSTEM_WRITER,
          ),
        );

        expect(spy).not.toHaveBeenCalled();
      });
    });

    it("restores nested managed PostgreSQL lock timeouts in stack order", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const fx = await runInTenant(tenant, () => setup(createChokePoint(runtime)));
        await linkIn(runtime, tenant, fx.file.id, "projects");
        const definition = await definitionOf(runtime, tenant, fx.projectsProperty.id);
        await inTx(runtime, tenant, async (client) => {
          await client.query<{ set_config: string }>("SELECT set_config('lock_timeout', $1, true)", ["5s"]);
          const read = async () =>
            (await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') AS setting")).rows[0]
              ?.setting;
          const before = await read();
          await withValueLinkRelationAdmission(
            client,
            {
              definitionId: definition.id,
              itemA: fx.file.id,
              itemB: fx.alpha.id,
              callerItemId: fx.file.id,
              propertyKey: "projects",
              insert: true,
            },
            async () => {},
            async () => {
              expect(await read()).toBe("1ms");
              await protectedWrite("create", client, fileEdge(fx));
              expect(await read()).toBe("1ms");
            },
          );
          expect(await read()).toBe(before);
        });
      });
    });

    it.each(["0", "5s"])(
      "restores the effective lock timeout %s after protected success and no-op",
      async (setting) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (runtime) => {
          const fx = await runInTenant(tenant, () => setup(createChokePoint(runtime)));
          await linkIn(runtime, tenant, fx.file.id, "projects");
          await inTx(runtime, tenant, async (client) => {
            await client.query<{ set_config: string }>("SELECT set_config('lock_timeout', $1, true)", [setting]);
            const read = async () =>
              (await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') AS setting")).rows[0]
                ?.setting;
            const before = await read();
            for (const [operation, target] of [
              ["create", fx.alpha],
              ["create", fx.alpha],
              ["delete", fx.beta],
            ] as const) {
              await protectedWrite(operation, client, fileEdge(fx, target));
              expect(await read()).toBe(before);
            }
          });
        });
      },
    );

    it("preserves a non-driver SC001 value through the protected create store", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await linkIn(runtime, tenant, fx.file.id, "projects");
        const spoof = { code: "SC001" };
        const original = relationsStore.createItemRelationReportingInsert;
        vi.spyOn(relationsStore, "createItemRelationReportingInsert").mockImplementation(async (client, input) => {
          const originalQuery = client.query.bind(client);
          const query = vi.spyOn(client, "query");
          // pg's last overload is callback-based; the real invocation here is the promise overload.
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          query.mockImplementationOnce(originalQuery).mockRejectedValueOnce(spoof);
          try {
            return await original(client, input);
          } finally {
            query.mockRestore();
          }
        });

        await expect(inTx(runtime, tenant, (client) => protectedWrite("create", client, fileEdge(fx)))).rejects.toBe(
          spoof,
        );

        expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
      });
    });

    it("keeps genuine cardinality violation mapping through protected create, and value_link_busy while held", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fixture = await runInTenant(tenant, async () => {
          const source = await cp.createDatabase({ name: "Source" });
          const target = await cp.createDatabase({ name: "Target" });
          const { property } = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "target",
            name: "Target",
            cardinality: "one_to_one",
          });
          const create = (databaseId: string) => cp.createItem({ databaseId, properties: {} });
          const [item, one, two, other, three] = [
            await create(source.id),
            await create(target.id),
            await create(target.id),
            await create(source.id),
            await create(target.id),
          ];
          await cp.createRelation({ relationPropertyId: property.id, callerItemId: item.id, targetItemId: one.id });
          return { property, item, one, two, other, three };
        });
        await linkIn(runtime, tenant, fixture.item.id, "target");
        const contended = {
          relationPropertyId: fixture.property.id,
          callerItemId: fixture.item.id,
          targetItemId: fixture.two.id,
        };

        await expect(
          inTx(runtime, tenant, (client) => protectedWrite("create", client, contended)),
        ).rejects.toMatchObject({
          status: 409,
          code: "cardinality_violation",
        });
        const edges = await runInTenant(tenant, () => cp.listItemRelations(fixture.item.id, fixture.property.id));
        expect(edges?.map((edge) => edge.targetItemId)).toEqual([fixture.one.id]);

        await whileHolding(
          runtime,
          tenant,
          (client) =>
            createRelationWithClient(client, {
              relationPropertyId: fixture.property.id,
              callerItemId: fixture.other.id,
              targetItemId: fixture.three.id,
            }),
          async () => {
            await expect(
              inTx(runtime, tenant, (client) => protectedWrite("create", client, contended)),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
          },
        );
      });
    });

    it("refuses a relation while its new active link is still uncommitted", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));

          await whileHolding(
            holderPool,
            tenant,
            (client) =>
              insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
            async () => {
              await expect(
                inTx(contenderPool, tenant, (client) => protectedWrite("create", client, fileEdge(fx))),
              ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
              expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual(
                [],
              );
            },
          );

          expect((await linksIn(holderPool, tenant, fx.file.id))[0]).toMatchObject({ state: "on" });
        }),
      );
    }, 30000);

    it("uses a nonlocking prediction in relation validation and rechecks on mutation", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (validationPool) =>
        withRuntimePool(async (userPool, operations) => {
          const fx = await runInTenant(tenant, () => setup(createChokePoint(userPool)));
          await linkIn(userPool, tenant, fx.file.id, "projects");
          const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");

          await inTx(validationPool, tenant, async (client) => {
            await assertRelationCreatableWithClient(client, fileEdge(fx), VALUE_LINKS, SYSTEM_WRITER);
            expect(spy.mock.calls.map((call) => call[3])).toEqual(["none"]);
            // A user edge commits while the validating transaction is still open: the prediction held no lock.
            await bounded(
              operations.run(() =>
                inTx(userPool, tenant, (userClient) =>
                  createRelationWithClient(userClient, fileEdge(fx), undefined, USER),
                ),
              ),
            );
          });

          await expect(
            inTx(validationPool, tenant, (client) => protectedWrite("create", client, fileEdge(fx))),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        }),
      );
    });

    it("does not use another tenant's active relation handoff", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const own = await runInTenant(tenantA, () => setup(cp));
        const foreign = await runInTenant(tenantB, () => setup(cp));
        await linkIn(runtime, tenantB, foreign.file.id, "projects");
        const write = () => inTx(runtime, tenantA, (client) => protectedWrite("create", client, fileEdge(own)));

        await expect(write()).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect(await runInTenant(tenantA, () => cp.listItemRelations(own.file.id, own.projectsProperty.id))).toEqual(
          [],
        );
        expect((await linksIn(runtime, tenantB, foreign.file.id))[0]).toMatchObject({ state: "on" });

        await linkIn(runtime, tenantA, own.file.id, "projects");
        await expect(write()).resolves.toMatchObject({ itemA: own.file.id, itemB: own.alpha.id });
      });
    });

    it("preserves Library rating validation on protected relation writes", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const databases = await runInTenant(tenant, () => cp.listDatabases());
        const movies = databases.find((db) => db.ownerModuleId === "movies");
        const people = databases.find((db) => db.ownerModuleId === "people");
        if (!movies || !people) throw new Error("Missing seeded Library databases");
        const property = await runInTenant(tenant, () => cp.getPropertyByKey(movies.id, "watchedWith"));
        if (!property) throw new Error("Missing watchedWith relation");
        const [movie, person] = await runInTenant(tenant, async () => [
          await cp.createItem({ databaseId: movies.id, properties: { name: "Film" } }),
          await cp.createItem({ databaseId: people.id, properties: { name: "Person" } }),
        ]);
        await linkIn(runtime, tenant, movie.id, "watchedWith");
        const write = (rating: number) =>
          inTx(runtime, tenant, (client) =>
            protectedWrite(
              "create",
              client,
              { relationPropertyId: property.id, callerItemId: movie.id, targetItemId: person.id },
              { rating },
            ),
          );
        const events = recordEvents();

        await expect(write(6)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
        expect(events).toEqual([]);
        expect(await runInTenant(tenant, () => cp.listItemRelations(movie.id, property.id))).toEqual([]);
        await expect(write(5)).resolves.toMatchObject({ metadata: { rating: 5 } });
        expect((await linksIn(runtime, tenant, movie.id))[0]).toMatchObject({ state: "on" });
      });
    });

    it.each([
      ["update", "commit"],
      ["update", "rollback"],
      ["delete", "commit"],
      ["delete", "rollback"],
    ] as const)(
      "refuses protected %s on a proposal-held edge before the holder's %s, and admits it afterwards",
      async (operation, outcome) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (holderPool) =>
          withRuntimePool(async (contenderPool) => {
            const cp = createChokePoint(holderPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            const edge = fileEdge(fx);
            await runInTenant(tenant, () => cp.createRelation(edge));
            await linkIn(holderPool, tenant, fx.file.id, "projects");
            const definition = await definitionOf(contenderPool, tenant, fx.projectsProperty.id);
            const beforeEdges = await storedEdges(contenderPool, tenant, definition.id, fx.file.id);
            const target = beforeEdges[0];
            if (!target || beforeEdges.length !== 1) throw new Error("Expected one existing edge");
            const before = await storedState(contenderPool, tenant, fx.files.id, fx.file.id);
            const events = recordEvents();

            await whileHolding(
              holderPool,
              tenant,
              (client) => holdProposal(client, fx),
              async (holderPid) => {
                expect(await rowLockedBy("item_relations", target.id, holderPid)).toBe(true);
                let edgeAttempt = false;
                await expect(
                  inTx(contenderPool, tenant, (client) =>
                    observingQueries(
                      client,
                      (sql, params) => {
                        if (
                          sql.includes("FROM item_relations") &&
                          sql.includes("UPDATE NOWAIT") &&
                          Array.isArray(params) &&
                          params[0] === definition.id &&
                          params[1] === target.itemA &&
                          params[2] === target.itemB
                        )
                          edgeAttempt = true;
                      },
                      () => protectedWrite(operation, client, edge, { attempted: true }),
                    ),
                  ),
                ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
                expect(edgeAttempt).toBe(true);
                expect(events).toEqual([]);
                expect(await storedState(contenderPool, tenant, fx.files.id, fx.file.id)).toEqual(before);
                expect(await storedEdges(contenderPool, tenant, definition.id, fx.file.id)).toEqual(beforeEdges);
              },
              outcome === "rollback" ? new Error("forced proposal rollback") : undefined,
            );

            await inTx(contenderPool, tenant, (client) => protectedWrite(operation, client, edge, { healthy: true }));
            const after = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            if (operation === "update") expect(after?.[0]?.metadata).toEqual({ healthy: true });
            else expect(after).toEqual([]);
            expect((await readStoredLinks(contenderPool, tenant, fx.file.id))[0]?.state).toBe("on");
          }),
        );
      },
      30000,
    );

    it("refuses a protected relation when a real proposal holds its definition", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          await runInTenant(tenant, () => cp.createRelation(fileEdge(fx)));
          await linkIn(holderPool, tenant, fx.file.id, "projects");
          const definition = await definitionOf(contenderPool, tenant, fx.projectsProperty.id);
          const beforeEdges = await storedEdges(contenderPool, tenant, definition.id, fx.file.id);
          const beforeJobs = await jobCount();
          const events = recordEvents();

          await whileHolding(
            holderPool,
            tenant,
            (client) => holdProposal(client, fx),
            async (holderPid) => {
              expect(await relationAdvisoryHeldBy(definition.id, holderPid)).toBe(true);
              await expect(
                inTx(contenderPool, tenant, (client) => protectedWrite("create", client, fileEdge(fx, fx.beta))),
              ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
              expect(events).toEqual([]);
              expect(await jobCount()).toBe(beforeJobs);
              expect(await storedEdges(contenderPool, tenant, definition.id, fx.file.id)).toEqual(beforeEdges);
            },
          );

          expect((await linksIn(holderPool, tenant, fx.file.id))[0]).toMatchObject({ state: "on" });
        }),
      );
    }, 30000);

    it("rechecks an active prediction after a concurrent user breaks the link", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool) =>
        withRuntimePool(async (systemPool, operations) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const userEdge = fileEdge(fx, fx.beta);
          await runInTenant(tenant, () => cp.createRelation(userEdge));
          await linkIn(userPool, tenant, fx.file.id, "projects");
          const admitted = barrier();
          const release = barrier();
          let systemClient: PoolClient | undefined;
          const original = relationsStore.lockExistingRelationNowait;
          vi.spyOn(relationsStore, "lockExistingRelationNowait").mockImplementation(
            async (client, definitionId, itemA, itemB) => {
              await original(client, definitionId, itemA, itemB);
              if (client === systemClient) {
                admitted.resolve();
                await bounded(release.promise);
              }
            },
          );
          const events = recordEvents();

          const system = operations.run(() =>
            inTx(systemPool, tenant, (client) => {
              systemClient = client;
              return protectedWrite("create", client, fileEdge(fx));
            }),
          );
          await bounded(admitted.promise);
          await inTx(userPool, tenant, (client) => deleteRelationWithClient(client, userEdge, undefined, USER));
          release.resolve();

          await expectRuntimeRejection(operations, system, { status: 403, code: "owner_violation" });
          expect((await linksIn(userPool, tenant, fx.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
          expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
          expect(itemEvents(events, fx.file.id)).toHaveLength(1);
        }),
      );
    }, 30000);

    it.each([
      ["create", "on"],
      ["update", "on"],
      ["delete", "on"],
      ["update", "missing"],
      ["update", "broken"],
    ] as const)(
      "refuses protected %s with %s link while the exact existing edge is held",
      async (operation, state) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (holderPool) =>
          withRuntimePool(async (contenderPool) => {
            const cp = createChokePoint(holderPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            const edge = fileEdge(fx);
            await runInTenant(tenant, () => cp.createRelation(edge));
            if (state !== "missing")
              await linkIn(holderPool, tenant, fx.file.id, "projects", { broken: state === "broken" });
            const definition = await definitionOf(holderPool, tenant, fx.projectsProperty.id);
            const [stored] = await storedEdges(holderPool, tenant, definition.id, fx.file.id);
            if (!stored) throw new Error("Expected the existing edge");
            const jobsBefore = await jobCount();
            const events = recordEvents();

            await whileHolding(
              holderPool,
              tenant,
              (client) => updateRelationWithClient(client, { ...edge, metadata: { holder: true } }),
              async (holderPid) => {
                expect(await rowLockedBy("item_relations", stored.id, holderPid)).toBe(true);
                await expect(
                  inTx(contenderPool, tenant, (client) => protectedWrite(operation, client, edge, { contender: true })),
                ).rejects.toMatchObject(
                  state === "on" ? { status: 409, code: "value_link_busy" } : { status: 403, code: "owner_violation" },
                );
                expect(events).toEqual([]);
                expect(await jobCount()).toBe(jobsBefore);
              },
            );

            const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            expect(edges?.[0]?.metadata).toEqual({ holder: true });
            const links = await linksIn(holderPool, tenant, fx.file.id);
            if (state === "missing") expect(links).toEqual([]);
            else expect(links[0]).toMatchObject({ state });
          }),
        );
      },
      30000,
    );

    it.each(["A", "B"] as const)(
      "admits protected create, replay, update and delete from definition side %s",
      async (side) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (runtime) => {
          const fx = await runInTenant(tenant, () => setup(createChokePoint(runtime)));
          const edge =
            side === "A"
              ? fileEdge(fx)
              : { relationPropertyId: fx.filesProperty.id, callerItemId: fx.alpha.id, targetItemId: fx.file.id };
          await linkIn(runtime, tenant, edge.callerItemId, side === "A" ? "projects" : "files");

          await inTx(runtime, tenant, async (client) => {
            await protectedWrite("create", client, edge);
            await protectedWrite("create", client, edge, { replay: true });
            await protectedWrite("update", client, edge, { update: true });
            expect(await protectedWrite("delete", client, edge)).not.toBeNull();
            expect(await protectedWrite("delete", client, edge)).toBeNull();
          });
          await expect(inTx(runtime, tenant, (client) => protectedWrite("update", client, edge))).rejects.toMatchObject(
            {
              status: 404,
              code: "not_found",
            },
          );

          expect((await linksIn(runtime, tenant, edge.callerItemId))[0]).toMatchObject({ state: "on" });
        });
      },
    );

    it("rejects an unmanaged client before prediction and protected hooks", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const fx = await runInTenant(tenant, () => setup(createChokePoint(runtime)));
        const client = await runtime.connect();
        const prediction = vi.spyOn(valueLinksStore, "lockOnValueLink");
        try {
          await client.query<{ set_config: string }>("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
          for (const operation of ["create", "update", "delete"] as const) {
            await expect(runInTenant(tenant, () => protectedWrite(operation, client, fileEdge(fx)))).rejects.toThrow(
              "active managed transaction",
            );
          }
          expect(prediction).not.toHaveBeenCalled();
        } finally {
          try {
            await client.query<{ set_config: string }>("SELECT set_config('app.tenant_id', '', false)");
          } finally {
            client.release();
          }
        }
      });
    });

    it("rejects stale and foreign transaction owners before admission and permits subsequent borrowers", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime, operations) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await linkIn(runtime, tenant, fx.file.id, "projects");
        const definition = await definitionOf(runtime, tenant, fx.projectsProperty.id);
        const admission = {
          definitionId: definition.id,
          itemA: fx.file.id,
          itemB: fx.alpha.id,
          callerItemId: fx.file.id,
          propertyKey: "projects",
          insert: true,
        };
        const hook = vi.fn(async () => {});
        const body = vi.fn(async () => {});
        const lock = vi.spyOn(relationsStore, "tryLockRelationDefinition");
        const expectRefusedUntouched = async (client: PoolClient, lockCalls: number) => {
          const query = vi.spyOn(client, "query");
          try {
            await expect(withValueLinkRelationAdmission(client, admission, hook, body)).rejects.toThrow(
              "active managed transaction",
            );
            expect(query).not.toHaveBeenCalled();
          } finally {
            query.mockRestore();
          }
          expect(lock).toHaveBeenCalledTimes(lockCalls);
          expect(hook).not.toHaveBeenCalled();
          expect(body).not.toHaveBeenCalled();
        };
        const foreign = await runtime.connect();
        const release = barrier();
        let descendant: Promise<void> | undefined;
        try {
          await inTx(runtime, tenant, async (client) => {
            expect(client).not.toBe(foreign);
            await expectRefusedUntouched(foreign, 0);
            await protectedWrite("create", client, fileEdge(fx));
            const ownerLockCalls = lock.mock.calls.length;
            // Runs on the same client after its transaction has ended.
            descendant = operations.run(async () => {
              await bounded(release.promise);
              await expectRefusedUntouched(client, ownerLockCalls);
            });
          });
          release.resolve();
          if (!descendant) throw new Error("Missing descendant");
          await bounded(descendant);
          await inTx(runtime, tenant, (client) => protectedWrite("delete", client, fileEdge(fx)));
          expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
        } finally {
          foreign.release();
        }
      });
    }, 30000);

    it.each([
      ["a NOWAIT edge lock recovered by a savepoint", "update"],
      ["an advisory busy without recovery", "create"],
    ] as const)(
      "keeps a transaction that caught %s rollback-only, discarding its writes, jobs and callbacks",
      async (_name, operation) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (holderPool) =>
          withRuntimePool(async (contenderPool, operations) => {
            contenderPool.options.max = 1;
            const cp = createChokePoint(holderPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            const unrelated = await runInTenant(tenant, () =>
              cp.createItem({ databaseId: fx.files.id, properties: { name: "original" } }),
            );
            const rollup = await runInTenant(tenant, async () => {
              if (operation === "update") {
                const target = await cp.createDatabase({ name: "Other rollup targets" });
                await cp.createRelationProperty({
                  sourceDatabaseId: fx.files.id,
                  targetDatabaseId: target.id,
                  key: "others",
                  name: "Others",
                });
              } else await cp.createRelation(fileEdge(fx));
              return cp.createProperty({
                databaseId: fx.files.id,
                key: "rollupCount",
                name: "Rollup count",
                type: "rollup",
                config: { relationPropertyKey: operation === "update" ? "others" : "projects", aggregation: "count" },
              });
            });
            const jobKey = rollupRecomputeJobKey(rollup.id, unrelated.id);
            const searchJobKey = `item-search-reindex:item:${unrelated.id}`;
            expect(await jobCount(jobKey)).toBe("0");
            await linkIn(holderPool, tenant, fx.file.id, "projects");
            const linkId = (await readStoredLinks(holderPool, tenant, fx.file.id))[0]?.id;
            if (!linkId) throw new Error("Missing link row");
            const callback = vi.fn();
            const events = recordEvents();
            let competitorPid: number | undefined;
            const renameUnrelated = (client: PoolClient, name: string) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name } },
                { writer: USER },
              );

            await whileHolding(
              holderPool,
              tenant,
              (client) =>
                operation === "update"
                  ? createRelationWithClient(client, fileEdge(fx), undefined, USER)
                  : holdProposal(client, fx),
              async (holderPid) => {
                if (operation === "update") expect(await rowLockedBy("value_links", linkId, holderPid)).toBe(true);
                await expectRuntimeRejection(
                  operations,
                  operations.run(() =>
                    inTx(contenderPool, tenant, async (client) => {
                      competitorPid = await pidOf(client);
                      await renameUnrelated(client, "before");
                      await enqueueRollupRecompute(client, rollup.id, unrelated.id);
                      // Registered for the pre-commit flush, which the caught busy below must prevent.
                      await enqueueItemSearchReindex(client, { kind: "item", itemId: unrelated.id });
                      const queued = await client.query<{ key: string }>(
                        "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])",
                        [[jobKey, searchJobKey]],
                      );
                      expect(queued.rows).toEqual([{ key: jobKey }]);
                      runAfterCommit(client, callback);
                      if (operation === "update") await client.query("SAVEPOINT relation_busy");
                      await expect(protectedWrite(operation, client, fileEdge(fx, fx.beta))).rejects.toMatchObject({
                        status: 409,
                        code: "value_link_busy",
                      });
                      if (operation === "update") await client.query("ROLLBACK TO SAVEPOINT relation_busy");
                      await renameUnrelated(client, "after");
                    }),
                  ),
                  { status: 409, code: "value_link_busy" },
                );
                expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, unrelated.id)))?.properties.name).toBe(
                  "original",
                );
                expect(callback).not.toHaveBeenCalled();
                expect(await jobCount(jobKey)).toBe("0");
                expect(await jobCount(searchJobKey)).toBe("0");
                expect(itemEvents(events, unrelated.id)).toEqual([]);
                if (operation !== "update") return;
                // The single pooled connection comes back with its lock timeout restored.
                await inTx(contenderPool, tenant, async (client) => {
                  const result = await client.query<{ pid: number; timeout: string }>(
                    "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS timeout",
                  );
                  expect(result.rows[0]).toEqual({ pid: competitorPid, timeout: "0" });
                  await expect(
                    protectedWrite("update", client, {
                      relationPropertyId: fx.projectsProperty.id,
                      callerItemId: unrelated.id,
                      targetItemId: fx.beta.id,
                    }),
                  ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
                });
              },
            );
          }),
        );
      },
      30000,
    );

    /*
     * A protected valueLinks relation and an ordinary relation sharing an endpoint both queue its search job. The
     * protected write adds it at its pre-commit flush, after restoring the lock timeout and while its lease is held;
     * a scratch holder of the tenant's search-flush lock makes that flush wait observably.
     */
    it("adds a protected relation's search jobs at its flush, waiting there without value_link_busy beside an ordinary writer", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const other = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: fx.files.id, properties: { name: "b.pdf" } }),
        );
        await linkIn(runtime, tenant, fx.file.id, "projects");
        const lockHeld = barrier();
        const releaseLock = barrier();
        let holderPid: number | undefined;
        const holder = runAsSystem("search flush lock holder", () =>
          withTransaction(pool, async (client) => {
            holderPid = await pidOf(client);
            await client.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))", [
              SEARCH_FLUSH_TENANT_LOCK_CLASS,
              tenant,
            ]);
            lockHeld.resolve();
            await bounded(releaseLock.promise);
          }),
        );
        const pids: { protected?: number; ordinary?: number } = {};
        const write = (kind: "protected" | "ordinary", callerItemId: string) =>
          outcomeOf(
            inTx(runtime, tenant, async (client) => {
              pids[kind] = await pidOf(client);
              const edge = { relationPropertyId: fx.projectsProperty.id, callerItemId, targetItemId: fx.alpha.id };
              if (kind === "protected") await protectedWrite("create", client, edge);
              else await createRelationWithClient(client, edge, undefined, USER);
            }),
          );
        let protectedCall: Promise<ParticipantOutcome> | undefined;
        let ordinaryWrite: Promise<ParticipantOutcome> | undefined;
        let failure: { error: unknown } | undefined;
        try {
          await bounded(lockHeld.promise);
          protectedCall = write("protected", fx.file.id);
          await waitUntil(() => pids.protected !== undefined);
          if (!holderPid || !pids.protected) throw new Error("Missing participant PID");
          // The protected body finished; its flush waits on the tenant's flush lock, far beyond the body's 1 ms.
          await waitBlocked(holderPid, pids.protected);
          ordinaryWrite = write("ordinary", other.id);
          await waitUntil(() => pids.ordinary !== undefined);
          if (!pids.ordinary) throw new Error("Missing participant PID");
          // The ordinary write waits behind the protected write's held relation lock, not on the flush.
          await waitBlocked(pids.protected, pids.ordinary);
        } catch (error) {
          failure = { error };
        } finally {
          releaseLock.resolve();
        }
        const settled = await Promise.allSettled([
          bounded(holder),
          bounded(protectedCall ?? Promise.resolve({ ok: true as const })),
          bounded(ordinaryWrite ?? Promise.resolve({ ok: true as const })),
        ]);
        if (failure) throwFailure(failure.error);
        expect(settled[0].status).toBe("fulfilled");
        expect(settled.slice(1)).toEqual([
          { status: "fulfilled", value: { ok: true } },
          { status: "fulfilled", value: { ok: true } },
        ]);
        const keys = [fx.file.id, fx.alpha.id, other.id].map((id) => `item-search-reindex:item:${id}`);
        const queued = await pool.query<{ key: string }>(
          "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
          [keys],
        );
        expect(queued.rows.map((row) => row.key)).toEqual([...keys].sort());
        expect(await readStoredLinks(runtime, tenant, fx.file.id)).toMatchObject([{ state: "on" }]);
      });
    }, 30000);

    it("refuses a protected relation waiting on a populated rollup job", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool, userOperations) =>
        withRuntimePool(async (systemPool, systemOperations) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const gamma = await runInTenant(tenant, async () => {
            await cp.createProperty({ databaseId: fx.alpha.databaseId, key: "hours", name: "Hours", type: "number" });
            await updateAs(undefined, fx.alpha.databaseId, fx.alpha.id, { hours: 1 }, cp);
            const third = await cp.createItem({ databaseId: fx.alpha.databaseId, properties: { hours: 3 } });
            await cp.createProperty({
              databaseId: fx.files.id,
              key: "totalHours",
              name: "Total hours",
              type: "rollup",
              config: { relationPropertyKey: "projects", aggregation: "sum", targetPropertyKey: "hours" },
            });
            await cp.createRelation(fileEdge(fx));
            await cp.createRelation(fileEdge(fx, fx.beta));
            return third;
          });
          const rollup = await runInTenant(tenant, () => cp.getPropertyByKey(fx.files.id, "totalHours"));
          if (!rollup) throw new Error("Missing rollup property");
          const jobKey = rollupRecomputeJobKey(rollup.id, fx.file.id);
          expect(await jobCount(jobKey)).toBe("1");
          await linkIn(userPool, tenant, fx.file.id, "projects");
          const jobHeld = barrier();
          const linkHeld = barrier();
          const releaseJob = barrier();
          const releaseLink = barrier();
          let systemClient: PoolClient | undefined;
          let userPid: number | undefined;
          let systemEnqueueAttempted = false;
          const originalLink = valueLinksStore.lockOnValueLink;
          vi.spyOn(valueLinksStore, "lockOnValueLink").mockImplementation(async (client, id, key, mode) => {
            const result = await originalLink(client, id, key, mode);
            if (client === systemClient && result && mode === "nowait") {
              linkHeld.resolve();
              await bounded(releaseLink.promise);
            }
            return result;
          });
          const events = recordEvents();

          // The user's hours update queues the populated rollup job and holds it until released.
          const user = userOperations.run(() =>
            inTx(userPool, tenant, async (client) => {
              userPid = await pidOf(client);
              await updateItemWithClient(
                client,
                { databaseId: fx.alpha.databaseId, itemId: fx.alpha.id, propertiesPatch: { hours: 2 } },
                { writer: USER },
              );
              jobHeld.resolve();
              await bounded(releaseJob.promise);
              return deleteRelationWithClient(client, fileEdge(fx, fx.beta), undefined, USER);
            }),
          );
          await bounded(jobHeld.promise);
          expect(await graphileJobHeldBy(jobKey, userPid)).toBe(true);
          const system = systemOperations.run(() =>
            inTx(systemPool, tenant, (client) => {
              systemClient = client;
              return observingQueries(
                client,
                (sql, params) => {
                  if (sql.includes("graphile_worker.add_job") && Array.isArray(params) && params[5] === jobKey)
                    systemEnqueueAttempted = true;
                },
                () => protectedWrite("create", client, fileEdge(fx, gamma)),
              );
            }),
          );
          await bounded(linkHeld.promise);
          releaseLink.resolve();
          await expectRuntimeRejection(systemOperations, system, { status: 409, code: "value_link_busy" });
          expect(systemEnqueueAttempted).toBe(true);
          releaseJob.resolve();
          await bounded(user);

          expect((await linksIn(userPool, tenant, fx.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
          expect(
            (await runInTenant(tenant, () => cp.getItem(fx.alpha.databaseId, fx.alpha.id)))?.properties.hours,
          ).toBe(2);
          const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
          expect(edges?.map((edge) => edge.targetItemId)).toEqual([fx.alpha.id]);
          expect(itemEvents(events, fx.alpha.id)).toHaveLength(1);
          expect(itemEvents(events, fx.file.id)).toHaveLength(1);
          expect(await jobCount(jobKey)).toBe("1");
        }),
      );
    }, 30000);

    it.each([
      ["system-first", false],
      ["user-first", false],
      ["user-first", true],
    ] as const)(
      "serializes relation advisory with %s (same target: %s)",
      async (order, sameTarget) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (userPool, userOperations) =>
          withRuntimePool(async (systemPool, systemOperations) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            await linkIn(userPool, tenant, fx.file.id, "projects");
            const definition = await definitionOf(userPool, tenant, fx.projectsProperty.id);
            const edgeHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseEdge = barrier();
            const releaseLink = barrier();
            const clients: { user?: PoolClient; system?: PoolClient } = {};
            const pids: { user?: number; system?: number } = {};
            const originalInsert = relationsStore.createItemRelationReportingInsert;
            const originalLink = valueLinksStore.lockOnValueLink;
            vi.spyOn(relationsStore, "createItemRelationReportingInsert").mockImplementation(async (client, input) => {
              const result = await originalInsert(client, input);
              if (client === clients.user) {
                edgeHeld.resolve();
                await bounded(releaseEdge.promise);
              }
              return result;
            });
            vi.spyOn(valueLinksStore, "lockOnValueLink").mockImplementation(async (client, id, key, mode) => {
              const result = await originalLink(client, id, key, mode);
              if (client === clients.system && result && mode === "nowait") {
                linkHeld.resolve();
                await bounded(releaseLink.promise);
              }
              return result;
            });
            const run = (kind: "user" | "system") =>
              (kind === "user" ? userOperations : systemOperations).run(() =>
                inTx(kind === "user" ? userPool : systemPool, tenant, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  clients[kind] = client;
                  pids[kind] = await pidOf(client);
                  if (kind === "user") {
                    userStarted.resolve();
                    return createRelationWithClient(client, fileEdge(fx), undefined, USER);
                  }
                  return protectedWrite("create", client, fileEdge(fx, sameTarget ? fx.alpha : fx.beta));
                }),
              );
            const events = recordEvents();

            if (order === "system-first") {
              const system = run("system");
              await bounded(linkHeld.promise);
              expect(await relationAdvisoryHeldBy(definition.id, pids.system)).toBe(true);
              const user = run("user");
              await bounded(userStarted.promise);
              if (!pids.user || !pids.system) throw new Error("Missing relation participant PID");
              await waitBlocked(pids.system, pids.user);
              releaseLink.resolve();
              releaseEdge.resolve();
              await bounded(Promise.all([user, system]));
            } else {
              const user = run("user");
              await bounded(edgeHeld.promise);
              expect(await relationAdvisoryHeldBy(definition.id, pids.user)).toBe(true);
              await expectRuntimeRejection(systemOperations, run("system"), { code: "value_link_busy", status: 409 });
              releaseEdge.resolve();
              await bounded(user);
            }

            expect((await linksIn(userPool, tenant, fx.file.id))[0]).toMatchObject({
              state: "broken",
              brokenBy: "user",
            });
            expect(itemEvents(events, fx.file.id)).toHaveLength(1);
            const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            expect(edges).toHaveLength(order === "system-first" ? 2 : 1);
          }),
        );
      },
      30000,
    );

    it.each(["system-first", "user-first"] as const)(
      "serializes the Inbox source and relation handoff with %s",
      async (order) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (userPool, userOperations) =>
          withRuntimePool(async (systemPool, systemOperations) => {
            const cp = createChokePoint(userPool);
            const inbox = await seededInbox(cp);
            const property = inbox.property;
            const fixture = await withTenantTransaction(userPool, tenant, async (client) => {
              const type = await createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: inbox.types.id,
                name: "Task",
                emoji: "T",
                processingMethod: "database",
                targetDatabase: "tasks",
              });
              const other = await inbox.createType(client);
              const item = await createInboxItemWithClient(client, {
                inboxDatabaseId: inbox.inbox.id,
                date: "2026-10-01",
                time: "09:00",
                text: "Source",
              });
              await insertValueLink(client, { itemId: item.id, propertyKey: "type", ruleKey: "test", sources: [] });
              return { item, type, other };
            });
            const jobKeys = [fixture.item.id, fixture.type.id, fixture.other.id].map(
              (id) => `item-search-reindex:item:${id}`,
            );
            const queuedKeys = async () =>
              (
                await pool.query<{ key: string }>(
                  "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
                  [jobKeys],
                )
              ).rows.map((row) => row.key);
            const priorJobs = await queuedKeys();
            const sourceHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseSource = barrier();
            const releaseLink = barrier();
            const clients: { user?: PoolClient; system?: PoolClient } = {};
            const pids: { user?: number; system?: number } = {};
            let userSourceAttempt = false;
            let systemSourceNowaitAttempt = false;
            const originalSource = inboxSourceGuard.lockInboxSource;
            const originalLink = valueLinksStore.lockOnValueLink;
            vi.spyOn(inboxSourceGuard, "lockInboxSource").mockImplementation(async (client, id, allowDeleted, mode) => {
              await originalSource(client, id, allowDeleted, mode);
              if (client === clients.user) {
                sourceHeld.resolve();
                await bounded(releaseSource.promise);
              }
            });
            vi.spyOn(valueLinksStore, "lockOnValueLink").mockImplementation(async (client, id, key, mode) => {
              const found = await originalLink(client, id, key, mode);
              if (client === clients.system && found && mode === "nowait") {
                linkHeld.resolve();
                await bounded(releaseLink.promise);
              }
              return found;
            });
            const run = (kind: "user" | "system") =>
              (kind === "user" ? userOperations : systemOperations).run(() =>
                inTx(kind === "user" ? userPool : systemPool, tenant, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  clients[kind] = client;
                  pids[kind] = await pidOf(client);
                  if (kind === "user") userStarted.resolve();
                  return observingQueries(
                    client,
                    (sql, params) => {
                      if (
                        !sql.includes("FROM items i JOIN databases") ||
                        !sql.includes("UPDATE OF i") ||
                        !Array.isArray(params) ||
                        params[0] !== fixture.item.id
                      )
                        return;
                      if (kind === "user") userSourceAttempt = true;
                      else if (sql.includes("NOWAIT")) systemSourceNowaitAttempt = true;
                    },
                    () => {
                      const edge = {
                        relationPropertyId: property.id,
                        callerItemId: fixture.item.id,
                        targetItemId: kind === "user" ? fixture.type.id : fixture.other.id,
                      };
                      return kind === "user"
                        ? createRelationWithClient(client, edge, undefined, USER)
                        : protectedWrite("create", client, edge);
                    },
                  );
                }),
              );
            const events = recordEvents();

            if (order === "system-first") {
              const system = run("system");
              await bounded(linkHeld.promise);
              expect(await rowLockedBy("items", fixture.item.id, pids.system)).toBe(true);
              const user = run("user");
              await bounded(userStarted.promise);
              if (!pids.user || !pids.system) throw new Error("Missing relation participant PID");
              await waitBlocked(pids.system, pids.user);
              const waiting = await pool.query<{ waiting: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1
                  AND query LIKE '%FROM items i JOIN databases%FOR NO KEY UPDATE OF i%'
                  AND $2::int = ANY(pg_blocking_pids(pid))) AS waiting`,
                [pids.user, pids.system],
              );
              expect(waiting.rows[0]?.waiting).toBe(true);
              expect(userSourceAttempt).toBe(true);
              releaseLink.resolve();
              releaseSource.resolve();
              await bounded(system);
              await expectRuntimeRejection(userOperations, user, { code: "cardinality_violation", status: 409 });
            } else {
              const user = run("user");
              await bounded(sourceHeld.promise);
              expect(await rowLockedBy("items", fixture.item.id, pids.user)).toBe(true);
              await expectRuntimeRejection(systemOperations, run("system"), { code: "value_link_busy", status: 409 });
              expect(systemSourceNowaitAttempt).toBe(true);
              releaseSource.resolve();
              await bounded(user);
            }

            const links = await linksIn(userPool, tenant, fixture.item.id);
            expect(links).toHaveLength(1);
            expect(links[0]).toMatchObject(
              order === "system-first" ? { state: "on" } : { state: "broken", brokenBy: "user" },
            );
            const targetId = order === "system-first" ? fixture.other.id : fixture.type.id;
            expect(itemEvents(events, fixture.item.id)).toHaveLength(order === "system-first" ? 0 : 1);
            expect(events.filter((event) => event.scope === "relation")).toEqual([
              expect.objectContaining({ scope: "relation", itemId: fixture.item.id, propertyKey: "type", op: "put" }),
              expect.objectContaining({ scope: "relation", itemId: targetId, propertyKey: null, op: "put" }),
            ]);
            expect(await runInTenant(tenant, () => cp.listItemRelations(fixture.item.id, property.id))).toEqual([
              expect.objectContaining({ relationPropertyId: property.id, propertyKey: "type", targetItemId: targetId }),
            ]);
            expect(await queuedKeys()).toEqual(
              [...new Set([...priorJobs, jobKeys[0], jobKeys[order === "system-first" ? 2 : 1]])].sort(),
            );
          }),
        );
      },
      30000,
    );

    it("checks multiple caller keys once in stable order and preserves ordinary writer locking", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await runInTenant(tenant, () =>
          cp.createProperty({ databaseId: fx.files.id, key: "note", name: "Note", type: "text" }),
        );
        await linkIn(runtime, tenant, fx.file.id, ["name", "note"]);
        const handoff = vi.spyOn(valueLinksStore, "lockOnValueLink");
        const prelock = vi.spyOn(itemsStore, "lockItemById");

        await inTx(runtime, tenant, (client) =>
          protectedUpdate(client, {
            databaseId: fx.files.id,
            itemId: fx.file.id,
            propertiesPatch: { note: "one", name: "system" },
          }),
        );
        expect(handoff.mock.calls.map((call) => call[2])).toEqual(["name", "note"]);
        expect(prelock).toHaveBeenCalledTimes(1);
        prelock.mockClear();
        await runInTenant(tenant, () => updateAs(USER, fx.files.id, fx.file.id, { name: "user" }, cp));
        expect(prelock).not.toHaveBeenCalled();

        expect((await linksIn(runtime, tenant, fx.file.id)).map((entry) => [entry.propertyKey, entry.state])).toEqual([
          ["name", "broken"],
          ["note", "on"],
        ]);
      });
    });

    it("checks a live scoped item before looking up any handoff link", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const own = await runInTenant(tenantA, () => setup(cp));
        const foreign = await runInTenant(tenantB, () => setup(cp));
        await runInTenant(tenantA, () => cp.softDeleteItem(own.files.id, own.file.id));
        const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");
        const events = recordEvents();

        for (const itemId of [own.file.id, foreign.file.id, "00000000-0000-4000-8000-000000000001"]) {
          await expect(
            inTx(runtime, tenantA, (client) =>
              protectedUpdate(client, { databaseId: own.files.id, itemId, propertiesPatch: { name: "blocked" } }),
            ),
          ).rejects.toMatchObject({ status: 404 });
        }

        expect(spy).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect((await runInTenant(tenantB, () => cp.getItem(foreign.files.id, foreign.file.id)))?.properties.name).toBe(
          "a.pdf",
        );
      });
    });

    it("retains version conflicts and normal equal-value update effects", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await linkIn(runtime, tenant, fx.file.id, "name");
        const events = recordEvents();

        await expect(
          inTx(runtime, tenant, (client) =>
            protectedUpdate(client, {
              databaseId: fx.files.id,
              itemId: fx.file.id,
              propertiesPatch: { name: "new" },
              ifVersion: "2000-01-01T00:00:00.000Z",
            }),
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(events).toEqual([]);
        await runInTenant(tenant, () => updateAs(USER, fx.files.id, fx.file.id, { name: "a.pdf" }, cp));

        expect(itemEvents(events, fx.file.id)).toHaveLength(1);
        expect((await linksIn(runtime, tenant, fx.file.id))[0]).toMatchObject({ state: "on" });
        expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id)))?.properties.name).toBe("a.pdf");
      });
    });

    it.each([
      ["plain", "user-first"],
      ["plain", "system-first"],
      ["transformed", "user-first"],
      ["transformed", "system-first"],
      ["plain", "system-rollback"],
    ] as const)(
      "serializes %s item and handoff writes with %s",
      async (kind, order) => {
        if (kind === "transformed") await seedSystem(pool);
        const tenant = kind === "transformed" ? getTenantZeroId() : await createTestTenant(pool);
        const otherTenant = await createTestTenant(pool);
        await withRuntimePool(async (userPool, userOperations) =>
          withRuntimePool(async (systemPool, systemOperations) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, async () => {
              if (kind === "plain") return setup(cp);
              const files = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
              if (!files) throw new Error("Missing seeded Tasks database");
              const file = await cp.createItem({
                databaseId: files.id,
                properties: { name: "initial", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
              });
              return { files, file };
            });
            const unrelated = await runInTenant(tenant, () =>
              cp.createItem({ databaseId: fx.files.id, properties: { name: "other" } }),
            );
            const foreign = await runInTenant(otherTenant, () => setup(cp));
            await linkIn(
              userPool,
              tenant,
              fx.file.id,
              kind === "transformed" ? ["date", "timeFrom", "timeTo"] : "name",
            );
            const userHeld = barrier();
            const systemHeld = barrier();
            const releaseUser = barrier();
            const releaseSystem = barrier();
            const userStarted = barrier();
            const systemStarted = barrier();
            const rollbackError = new Error("forced rollback");
            const clients: { user?: PoolClient; system?: PoolClient } = {};
            const pids: { user?: number; system?: number } = {};
            const realUpdate = itemsStore.updateItemProperties;
            const realLock = itemsStore.lockItemById;
            vi.spyOn(itemsStore, "updateItemProperties").mockImplementation(async (client, input) => {
              const result = await realUpdate(client, input);
              if (client === clients.user) {
                userHeld.resolve();
                await bounded(releaseUser.promise);
              }
              return result;
            });
            vi.spyOn(itemsStore, "lockItemById").mockImplementation(async (client, databaseId, itemId) => {
              const found = await realLock(client, databaseId, itemId);
              if (client === clients.system && found) {
                systemHeld.resolve();
                await bounded(releaseSystem.promise);
              }
              return found;
            });
            const run = (actor: "user" | "system") =>
              (actor === "user" ? userOperations : systemOperations).run(() =>
                inTx(actor === "user" ? userPool : systemPool, tenant, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  clients[actor] = client;
                  pids[actor] = await pidOf(client);
                  (actor === "user" ? userStarted : systemStarted).resolve();
                  const input = {
                    databaseId: fx.files.id,
                    itemId: fx.file.id,
                    propertiesPatch:
                      kind === "transformed" ? { date: actor === "user" ? "2026-10-14" : null } : { name: actor },
                  };
                  const result =
                    actor === "user"
                      ? await updateItemWithClient(client, input, { writer: USER })
                      : await protectedUpdate(client, input);
                  if (actor === "system" && order === "system-rollback") throw rollbackError;
                  return result;
                }),
              );
            const events = recordEvents();

            let system: Promise<unknown>;
            if (order === "user-first") {
              const user = run("user");
              await bounded(userHeld.promise);
              system = run("system");
              await bounded(systemStarted.promise);
              if (!pids.user || !pids.system) throw new Error("Missing participant PID");
              await waitBlocked(pids.user, pids.system);
              releaseUser.resolve();
              releaseSystem.resolve();
              await bounded(user);
              await expectRuntimeRejection(systemOperations, system, { status: 403, code: "owner_violation" });
            } else {
              system = run("system");
              await bounded(systemHeld.promise);
              // While the handoff holds this item, writes of another item and another tenant proceed.
              for (const [scope, databaseId, itemId] of [
                [tenant, fx.files.id, unrelated.id],
                [otherTenant, foreign.files.id, foreign.file.id],
              ] as const) {
                await bounded(
                  userOperations.run(() =>
                    runInTenant(scope, () => updateAs(USER, databaseId, itemId, { name: "progress" }, cp)),
                  ),
                );
              }
              const user = run("user");
              await bounded(userStarted.promise);
              if (!pids.user || !pids.system) throw new Error("Missing participant PID");
              await waitBlocked(pids.system, pids.user);
              releaseSystem.resolve();
              releaseUser.resolve();
              if (order === "system-rollback") await expectRuntimeRejection(systemOperations, system, rollbackError);
              else await bounded(system);
              await bounded(user);
            }

            expect(itemEvents(events, fx.file.id)).toHaveLength(order === "system-first" ? 2 : 1);
            const current = await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id));
            const links = await linksIn(userPool, tenant, fx.file.id);
            if (kind === "transformed") {
              expect(current?.properties.date).toBe("2026-10-14");
              expect(links.find((entry) => entry.propertyKey === "date")).toMatchObject({
                state: "broken",
                brokenBy: "user",
              });
              expect(links.filter((entry) => entry.propertyKey !== "date").map((entry) => entry.state)).toEqual([
                "on",
                "on",
              ]);
              expect(current?.properties.timeFrom).toBe(order === "system-first" ? null : "10:00");
              expect(current?.properties.timeTo).toBe(order === "system-first" ? null : "11:00");
            } else {
              expect(current?.properties.name).toBe("user");
              expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
            }
          }),
        );
      },
      30000,
    );

    it("enforces handoff and preserves unchanged links on scoped runtime connections without overlap", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const write = (name: string) =>
          inTx(runtime, tenant, (client) =>
            protectedUpdate(client, { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name } }),
          );
        const userWrite = (name: string) =>
          runInTenant(tenant, () => updateAs(USER, fx.files.id, fx.file.id, { name }, cp));
        const events = recordEvents();
        const expectRefusedWithoutEffects = async (name: string) => {
          const before = await storedState(runtime, tenant, fx.files.id, fx.file.id);
          events.length = 0;
          await expect(write(name)).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          expect(await storedState(runtime, tenant, fx.files.id, fx.file.id)).toEqual(before);
          expect(events).toEqual([]);
        };

        await expectRefusedWithoutEffects("blocked");
        await linkIn(runtime, tenant, fx.file.id, "name");
        await expect(write("system")).resolves.toMatchObject({ properties: { name: "system" } });
        await userWrite("system");
        expect((await linksIn(runtime, tenant, fx.file.id))[0]).toMatchObject({ state: "on" });
        await userWrite("user");
        expect((await linksIn(runtime, tenant, fx.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
        await expectRefusedWithoutEffects("blocked again");
        expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id)))?.properties.name).toBe("user");
      });
    });

    it("isolates same-key handoffs and breaks across runtime tenants", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenantA, () => setup(cp));
        await runInTenant(tenantA, () =>
          cp.createProperty({ databaseId: fx.files.id, key: "note", name: "Note", type: "text" }),
        );
        await linkIn(runtime, tenantA, fx.file.id, "name");
        // Rows of another tenant under the same keys must neither authorize nor break anything here. They sit on an
        // item of their own: item ids are unique across tenants and a link must name an item of its tenant.
        const foreignItemId = randomUUID();
        await withTenantTransaction(runtime, tenantB, (client) => insertItemsWithIds(client, [foreignItemId]));
        await linkIn(runtime, tenantB, foreignItemId, ["name", "note", "projects"], { ruleKey: "foreign" });
        const foreignBefore = await readStoredLinks(runtime, tenantB, foreignItemId);
        expect(foreignBefore).toHaveLength(3);

        await runInTenant(tenantA, () => updateAs(USER, fx.files.id, fx.file.id, { name: "changed" }, cp));
        expect((await readStoredLinks(runtime, tenantA, fx.file.id))[0]).toMatchObject({
          property_key: "name",
          state: "broken",
          broken_by: "user",
        });
        expect(await readStoredLinks(runtime, tenantB, foreignItemId)).toEqual(foreignBefore);

        const before = await storedState(runtime, tenantA, fx.files.id, fx.file.id);
        const events = recordEvents();
        const writeNote = (note: string) =>
          inTx(runtime, tenantA, (client) =>
            protectedUpdate(client, { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { note } }),
          );
        const createEdge = () => inTx(runtime, tenantA, (client) => protectedWrite("create", client, fileEdge(fx)));
        await expect(writeNote("foreign cannot authorize")).rejects.toMatchObject({
          status: 403,
          code: "owner_violation",
        });
        await expect(createEdge()).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect(await storedState(runtime, tenantA, fx.files.id, fx.file.id)).toEqual(before);
        expect(await readStoredLinks(runtime, tenantB, foreignItemId)).toEqual(foreignBefore);
        expect(await runInTenant(tenantA, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
        expect(events).toEqual([]);

        await linkIn(runtime, tenantA, fx.file.id, ["note", "projects"], { ruleKey: "own" });
        await writeNote("authorized");
        await createEdge();
        const own = await readStoredLinks(runtime, tenantA, fx.file.id);
        expect(own.filter((entry) => entry.property_key !== "name").map((entry) => entry.state)).toEqual(["on", "on"]);
        expect(await readStoredLinks(runtime, tenantB, foreignItemId)).toEqual(foreignBefore);
      });
    }, 30000);
  });
});
