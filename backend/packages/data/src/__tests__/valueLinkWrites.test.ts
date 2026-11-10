import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as queue from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
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

/** Issue #1516: user and agent writes end value links; the valueLinks process needs an `on` link. */
const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
const VALUE_LINKS = { ownerProcess: VALUE_LINKS_OWNER_PROCESS };

let pool: Pool;
let chokePoint: ChokePoint;

async function graphileJobHeldBy(jobKey: string, holderPid: number | undefined): Promise<boolean> {
  // Graphile Worker 0.17.3's public jobs view does not expose the tuple xmax
  // needed to connect this exact queued row to its transaction lock holder.
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
      `SELECT id, tenant_id, item_id, property_key, rule_key, state, broken_by,
                      broken_at::text, updated_at::text
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
    if (result.rows.length !== 1) throw new Error("Expected one scoped item");
    return result.rows[0];
  });
}

async function link(itemId: string, propertyKey: string, state?: "broken"): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId,
      propertyKey,
      ruleKey: "test",
      ...(state ? { state, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") } : {}),
      sources: [],
    }),
  );
}

async function linkOf(itemId: string, propertyKey: string): Promise<ValueLinkRow | undefined> {
  const rows = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId]));
  return rows.find((row) => row.propertyKey === propertyKey);
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

function requireSuccessful(outcome: { ok: true } | { ok: false; error: unknown }): void {
  if (!outcome.ok) throwFailure(outcome.error);
}

function expectFixtureClosed(runtime: Pool | undefined): void {
  if (!runtime) throw new Error("Missing fixture pool");
  expect(runtime.ended).toBe(true);
  expect(runtime.totalCount).toBe(0);
  expect(runtime.waitingCount).toBe(0);
  expect(runtime.listenerCount("acquire")).toBe(0);
  expect(runtime.listenerCount("release")).toBe(0);
  expect(fixtureCancellations.size).toBe(0);
}

interface RuntimeOperations {
  run<T>(start: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
  onCancel(cancel: () => void): void;
  consume(operation: Promise<unknown>, expected: unknown): void;
}

// Local to these serial fixtures: every barrier is released if any owning pool closes early.
const fixtureCancellations = new Set<Set<() => void>>();

async function withRuntimePool<T>(body: (runtime: Pool, operations: RuntimeOperations) => Promise<T>): Promise<T> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
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

async function settleOwned<T>(promise: Promise<T>, _getPid: () => number | undefined): Promise<T> {
  // The enclosing runtime-pool watchdog destroys only checked-out owned clients first.
  return bounded(promise, 15000);
}

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

type ParticipantOutcome = { ok: true } | { ok: false; error: unknown };

async function settleParticipants<T extends ParticipantOutcome>(
  user: Promise<T> | undefined,
  system: Promise<T> | undefined,
  userPid: () => number | undefined,
  systemPid: () => number | undefined,
  consumed: ReadonlySet<T>,
): Promise<unknown[]> {
  const owned: Promise<T>[] = [];
  if (user) owned.push(settleOwned(user, userPid));
  if (system) owned.push(settleOwned(system, systemPid));
  const results = await Promise.allSettled(owned);
  return results.flatMap((result) => {
    if (result.status === "rejected") return [result.reason];
    return !result.value.ok && !consumed.has(result.value) ? [result.value.error] : [];
  });
}

/** Polls a participant's own progress flag (observation only; locks and barriers create the order). */
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

describe("value link state on writes (issue #1516)", () => {
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

  it.each([undefined, { marker: "non-error" }])("preserves owned participant failure identity %#", async (original) => {
    let settled = false;
    let runtimePool: Pool | undefined;
    const operation = withRuntimePool(async (runtime, operations) => {
      runtimePool = runtime;
      await operations.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          settled = true;
        }),
      );
      await operations.settle();
      throwFailure(original);
    });
    await expect(operation).rejects.toBe(original);
    expect(settled).toBe(true);
    if (!runtimePool) throw new Error("Missing runtime fixture");
    expect(runtimePool.totalCount).toBe(0);
    const cleanup = { marker: "cleanup" };
    const combined = combineFailure({ error: original }, [cleanup], "combined").error;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(combined.errors[0]).toBe(original);
    expect(combined.errors[1]).toBe(cleanup);
    expect(combined.cause).toBe(original);
  });

  it("settles a client delivered after pool cleanup starts without running its transaction", async () => {
    const tenant = await createTestTenant(pool);
    const bodyError = new Error("forced body failure");
    const verifying = barrier();
    let delivered = false;
    let transactionRan = false;
    let operationSettled = false;
    let observedPool: Pool | undefined;
    let observedFailure: unknown;
    const operationErrors: Array<{ value: unknown } | undefined> = [];
    try {
      await withRuntimePool(async (runtime, operations) => {
        observedPool = runtime;
        runtime.options.verify = (_client, done) => {
          operations.onCancel(() =>
            queueMicrotask(() => {
              delivered = true;
              done();
            }),
          );
          verifying.resolve();
        };
        const operation = operations.run(() =>
          runInTenant(tenant, () =>
            withTransaction(runtime, async () => {
              transactionRan = true;
            }),
          ),
        );
        void operation.then(
          () => {
            operationSettled = true;
          },
          (error: unknown) => {
            operationErrors[0] = { value: error };
            operationSettled = true;
          },
        );
        await bounded(verifying.promise);
        throw bodyError;
      });
    } catch (error) {
      observedFailure = error;
    }
    expect(observedFailure).toBeInstanceOf(AggregateError);
    if (!(observedFailure instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(observedFailure.cause).toBe(bodyError);
    const captured = operationErrors.filter((entry): entry is { value: unknown } => entry !== undefined);
    expect(captured.length).toBeGreaterThan(0);
    expect(observedFailure.errors).toHaveLength(1 + captured.length);
    expect(observedFailure.errors[0]).toBe(bodyError);
    for (let index = 0; index < captured.length; index++) {
      const observed = captured[index];
      if (!observed) throw new Error("Missing operation failure");
      expect(observed.value).toBeInstanceOf(Error);
      expect(observedFailure.errors[index + 1]).toBe(observed.value);
    }
    expect(delivered).toBe(true);
    expect(operationSettled).toBe(true);
    expect(transactionRan).toBe(false);
    expectFixtureClosed(observedPool);
  }, 30000);

  it("preserves a body failure alongside an owned client cleanup error", async () => {
    const tenant = await createTestTenant(pool);
    const bodyError = new Error("body failure");
    const clientError = new Error("owned client error");
    let observed: unknown;
    let observedPool: Pool | undefined;
    try {
      await withRuntimePool(async (runtime) => {
        observedPool = runtime;
        const client = await runInTenant(tenant, () => runtime.connect());
        client.emit("error", clientError);
        throw bodyError;
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected cleanup errors");
    expect(observed.errors).toEqual([bodyError, clientError]);
    expect(observed.cause).toBe(bodyError);
    expectFixtureClosed(observedPool);
  }, 30000);

  it("refuses success when the body leaves an owned client checked out", async () => {
    const tenant = await createTestTenant(pool);
    let observedPool: Pool | undefined;
    await expect(
      withRuntimePool(async (runtime) => {
        observedPool = runtime;
        await runInTenant(tenant, () => runtime.connect());
        return "not a successful fixture";
      }),
    ).rejects.toMatchObject({ message: "Test and runtime cleanup failed" });
    expectFixtureClosed(observedPool);
  }, 30000);

  it("settles a participant paused before its PID query when cleanup begins", async () => {
    const tenant = await createTestTenant(pool);
    const bodyError = new Error("cancel before PID");
    let ranAfterPid = false;
    let settled = false;
    let observedPool: Pool | undefined;
    let observedFailure: unknown;
    const operationErrors: Array<{ value: unknown } | undefined> = [];
    try {
      await withRuntimePool(async (runtime, operations) => {
        observedPool = runtime;
        const started = barrier();
        const release = barrier();
        const participant = operations.run(() =>
          runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              started.resolve();
              await bounded(release.promise);
              await client.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()");
              ranAfterPid = true;
            }),
          ),
        );
        void participant.then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            operationErrors[0] = { value: error };
            settled = true;
          },
        );
        await bounded(started.promise);
        throw bodyError;
      });
    } catch (error) {
      observedFailure = error;
    }
    expect(observedFailure).toBeInstanceOf(AggregateError);
    if (!(observedFailure instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(observedFailure.cause).toBe(bodyError);
    const captured = operationErrors.filter((entry): entry is { value: unknown } => entry !== undefined);
    expect(captured.length).toBeGreaterThan(0);
    expect(observedFailure.errors).toHaveLength(1 + captured.length);
    expect(observedFailure.errors[0]).toBe(bodyError);
    for (let index = 0; index < captured.length; index++) {
      const observed = captured[index];
      if (!observed) throw new Error("Missing operation failure");
      expect(observed.value).toBeInstanceOf(Error);
      expect(observedFailure.errors[index + 1]).toBe(observed.value);
    }
    expect(settled).toBe(true);
    expect(ranAfterPid).toBe(false);
    expectFixtureClosed(observedPool);
  }, 30000);

  it.each(["cancel", "undefined", "object"] as const)(
    "settles a real blocked contender and holder when fixture cleanup starts (%s)",
    async (control) => {
      const tenant = await createTestTenant(pool);
      const bodyError = new Error("stop blocked participants");
      const late = control === "undefined" ? undefined : { marker: "late runtime participant" };
      const acquired = barrier();
      const release = barrier();
      let holderPid: number | undefined;
      let contenderPid: number | undefined;
      let holderSettled = false;
      let contenderSettled = false;
      let progressSettled = false;
      let observedPool: Pool | undefined;
      let observedFailure: unknown;
      const operationErrors: Array<{ value: unknown } | undefined> = [];
      let items: { databaseId: string; heldId: string; progressId: string } | undefined;
      try {
        await withRuntimePool(async (runtime, operations) => {
          observedPool = runtime;
          const cp = createChokePoint(runtime);
          const fx = await runInTenant(tenant, () => setup(cp));
          const progressItem = await runInTenant(tenant, () =>
            cp.createItem({ databaseId: fx.files.id, properties: { name: "independent" } }),
          );
          items = { databaseId: fx.files.id, heldId: fx.file.id, progressId: progressItem.id };
          const refused = operations.run(() =>
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                updateItemWithClient(
                  client,
                  { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "refused" } },
                  { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                ),
              ),
            ),
          );
          await expectRuntimeRejection(operations, refused, { status: 403, code: "owner_violation" });
          runtime.once("release", () => release.resolve());
          const holder = operations.run(() =>
            runInTenant(tenant, () =>
              withTransaction(runtime, async (client) => {
                holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                await updateItemWithClient(client, {
                  databaseId: fx.files.id,
                  itemId: fx.file.id,
                  propertiesPatch: { name: "held" },
                });
                acquired.resolve();
                await bounded(release.promise);
                if (control !== "cancel") throwFailure(late);
              }),
            ),
          );
          void holder.then(
            () => {
              holderSettled = true;
            },
            (error: unknown) => {
              operationErrors[0] = { value: error };
              holderSettled = true;
            },
          );
          await bounded(acquired.promise);
          const contenderStarted = barrier();
          const contender = operations.run(() =>
            runInTenant(tenant, () =>
              withTransaction(runtime, async (client) => {
                contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                contenderStarted.resolve();
                await updateItemWithClient(client, {
                  databaseId: fx.files.id,
                  itemId: fx.file.id,
                  propertiesPatch: { name: "contender" },
                });
              }),
            ),
          );
          void contender.then(
            () => {
              contenderSettled = true;
            },
            (error: unknown) => {
              operationErrors[1] = { value: error };
              contenderSettled = true;
            },
          );
          await bounded(contenderStarted.promise);
          if (!holderPid || !contenderPid) throw new Error("Missing participant PID");
          await waitBlocked(holderPid, contenderPid);
          const progressStarted = barrier();
          const progressRelease = barrier();
          const progress = operations.run(() =>
            runInTenant(tenant, () =>
              withTransaction(runtime, async (client) => {
                await updateItemWithClient(client, {
                  databaseId: fx.files.id,
                  itemId: progressItem.id,
                  propertiesPatch: { name: "progress" },
                });
                progressStarted.resolve();
                await bounded(progressRelease.promise);
              }),
            ),
          );
          void progress.then(
            () => {
              progressSettled = true;
            },
            (error: unknown) => {
              operationErrors[2] = { value: error };
              progressSettled = true;
            },
          );
          await bounded(progressStarted.promise);
          if (control !== "cancel") {
            try {
              throw bodyError;
            } catch (error) {
              release.resolve();
              progressRelease.resolve();
              await Promise.allSettled([holder, contender, progress]);
              throwFailure(error);
            }
          }
          throw bodyError;
        });
      } catch (error) {
        observedFailure = error;
      }
      expect(observedFailure).toBeInstanceOf(AggregateError);
      if (!(observedFailure instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(observedFailure.cause).toBe(bodyError);
      const captured = operationErrors.filter((entry): entry is { value: unknown } => entry !== undefined);
      expect(captured.length).toBeGreaterThan(0);
      expect(observedFailure.errors).toHaveLength(1 + captured.length);
      expect(observedFailure.errors[0]).toBe(bodyError);
      for (let index = 0; index < captured.length; index++) {
        const observed = captured[index];
        if (!observed) throw new Error("Missing operation failure");
        if (control === "cancel") expect(observed.value).toBeInstanceOf(Error);
        else expect(observed.value).toBe(late);
        expect(observedFailure.errors[index + 1]).toBe(observed.value);
      }
      expect(holderSettled).toBe(true);
      expect(contenderSettled).toBe(true);
      expect(progressSettled).toBe(true);
      expectFixtureClosed(observedPool);
      if (!items) throw new Error("Missing fixture items");
      const resultItems = items;
      expect(
        (await runInTenant(tenant, () => chokePoint.getItem(resultItems.databaseId, resultItems.heldId)))?.properties
          .name,
      ).toBe(control === "cancel" ? "a.pdf" : "contender");
      expect(
        (await runInTenant(tenant, () => chokePoint.getItem(resultItems.databaseId, resultItems.progressId)))
          ?.properties.name,
      ).toBe(control === "cancel" ? "independent" : "progress");
    },
    30000,
  );

  afterAll(async () => {
    await pool.end();
  });

  describe("plain properties", () => {
    it("a user write that changes a linked value breaks the link with brokenBy user", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      const row = await linkOf(file.id, "name");
      expect(row).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(row?.brokenAt).not.toBeNull();
    });

    it("an agent write breaks the link with brokenBy agent", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("a system write leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        SYSTEM_WRITER,
      );
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } });

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on", brokenBy: null, brokenAt: null });
    });

    it("a patch that sets the value it already holds leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "a.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
    });

    it("only the keys whose value changed are broken", async () => {
      const { files, file } = await setup();
      await chokePoint.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { note: "n" } });
      await link(file.id, "name");
      await link(file.id, "note");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf", note: "n" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken" });
      expect(await linkOf(file.id, "note")).toMatchObject({ state: "on" });
    });

    it("two writes keep the first brokenBy and brokenAt", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );
      const first = await linkOf(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      const second = await linkOf(file.id, "name");
      expect(second).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(second?.brokenAt).toBe(first?.brokenAt);
    });

    it("a write to an unlinked property changes no link", async () => {
      const { files, file } = await setup();

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toBeUndefined();
    });

    it("rolls the link state back together with a failed write", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
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
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      expect((await chokePoint.getItem(files.id, file.id))?.properties.name).toBe("a.pdf");
    });
  });

  describe("relation edges", () => {
    it("breaks and announces linked values on both definition sides", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      await link(alpha.id, "files");
      const actorId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await chokePoint.createRelation(
          { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          USER,
          actorId,
        );
        expect(events.filter((event) => event.scope === "item")).toHaveLength(2);
        await chokePoint.createRelation(
          { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          USER,
          actorId,
        );
        expect(events.filter((event) => event.scope === "item")).toHaveLength(2);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(await linkOf(alpha.id, "files")).toMatchObject({ state: "broken", brokenBy: "user" });
      for (const itemId of [file.id, alpha.id]) {
        expect(
          events.filter((event) => event.scope === "item" && event.itemId === itemId && event.op === "update"),
        ).toEqual([expect.objectContaining({ userId: actorId })]);
      }
    });

    it("breaks both sides of a self-edge and announces the item once after commit", async () => {
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
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
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
        await withTransaction(pool, async (client) => {
          await createSelfEdge(client);
          expect(events).toEqual([]);
        });
        expect(await linkOf(item.id, "outgoing")).toMatchObject({ state: "broken", brokenBy: "user" });
        expect(await linkOf(item.id, "incoming")).toMatchObject({ state: "broken", brokenBy: "user" });
        expect(events.filter((event) => event.scope === "item" && event.itemId === item.id)).toEqual([
          expect.objectContaining({ userId: actorId }),
        ]);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("putting a second project edge breaks the file's projects link", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await link(file.id, "projects");
      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting the edge through the project's files property breaks the file's link", async () => {
      const { file, alpha, filesProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation(
        { relationPropertyId: filesProperty.id, callerItemId: alpha.id, targetItemId: file.id },
        AGENT,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("deleting an edge breaks the link, deleting an absent edge does not", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });
      await link(file.id, "projects");

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting an existing edge and replacing metadata leave the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      const edge = { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id };
      await chokePoint.createRelation(edge);
      await link(file.id, "projects");

      await chokePoint.createRelation({ ...edge, metadata: { note: "x" } }, USER);
      await chokePoint.updateRelation({ ...edge, metadata: { note: "y" } }, USER);

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("a system edge write leaves the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("announces the item whose link state changed after the commit", async () => {
      const { files, file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await withTransaction(pool, async (client) => {
          await createRelationWithClient(
            client,
            { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
            undefined,
            USER,
          );
          expect(events).toEqual([]);
        });
      } finally {
        setInvalidationHook(() => {});
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          scope: "item",
          databaseId: files.id,
          itemId: file.id,
          op: "update",
          userId: undefined,
        }),
      );
    });

    it("rolls back the edge and link without publishing an item invalidation", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(pool, async (client) => {
            await createRelationWithClient(
              client,
              { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
              undefined,
              USER,
            );
            expect(events).toEqual([]);
            throw new Error("abort relation");
          }),
        ).rejects.toThrow("abort relation");
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
      expect(await chokePoint.listItemRelations(file.id, projectsProperty.id)).toEqual([]);
    });
  });

  describe("valueLinks handoff", () => {
    it.each([
      ["timeFrom", "missing"],
      ["timeFrom", "broken"],
      ["timeFrom", "on"],
      ["timeTo", "missing"],
      ["timeTo", "broken"],
      ["timeTo", "on"],
    ] as const)("enforces date-off Tasks handoff when the %s link is %s", async (missingKey, state) => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const task = await runInTenant(tenant, async () => {
          const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          return cp.createItem({
            databaseId: db.id,
            properties: { name: "Timed", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
          });
        });
        await withTenantTransaction(runtime, tenant, async (client) => {
          for (const propertyKey of ["date", "timeFrom", "timeTo"].filter((key) => key !== missingKey)) {
            await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
          }
          if (state !== "missing") {
            await insertValueLink(client, {
              itemId: task.id,
              propertyKey: missingKey,
              ruleKey: "test",
              sources: [],
              ...(state === "broken"
                ? { state: "broken" as const, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") }
                : {}),
            });
          }
        });
        const heartbeat = await withTenantTransaction(runtime, tenant, async (client) => {
          const project = await client.query<{ id: string }>(
            "SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'projects' LIMIT 1",
          );
          if (!project.rows[0]) throw new Error("Missing seeded project");
          return schedulerStore.createHeartbeat(client, {
            projectItemId: project.rows[0].id,
            name: "Dated date-off probe",
            rule: { kind: "onItemEvent", databaseId: task.databaseId, event: "update" },
            actionId: "noop",
          });
        });
        const jobKey = schedulerStore.heartbeatFireJobKey(heartbeat.id, task.id);
        const readJobs = () =>
          pool.query<{ key: string | null; locked_at: Date | null; attempts: number; max_attempts: number }>(
            "SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
          );
        const beforeJobs = (await readJobs()).rows;
        expect(beforeJobs.some((row) => row.key === jobKey)).toBe(false);
        const beforeItem = await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id));
        const beforeStoredItem = await readStoredItem(runtime, tenant, task.databaseId, task.id);
        const beforeLinks = await readStoredLinks(runtime, tenant, task.id);
        const events: InvalidationEvent[] = [];
        const enqueue = vi.spyOn(queue, "enqueueJob");
        setInvalidationHook((event) => events.push(event));
        try {
          let writeClient: PoolClient | undefined;
          const write = () =>
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) => {
                writeClient = client;
                return updateItemWithClient(
                  client,
                  { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
                  { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                );
              }),
            );
          if (state === "on") {
            const result = await write();
            expect(result.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
            expect((await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id)))?.properties).toMatchObject({
              date: null,
              timeFrom: null,
              timeTo: null,
              time: null,
            });
            expect((await readJobs()).rows).toContainEqual({
              key: jobKey,
              locked_at: null,
              attempts: 0,
              max_attempts: 3,
            });
            expect(writeClient).toBeDefined();
            expect(enqueue).toHaveBeenCalledWith(
              writeClient,
              queue.CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE,
              { heartbeatId: heartbeat.id, itemId: task.id },
              expect.objectContaining({ jobKey }),
            );
            expect(events).toEqual([expect.objectContaining({ scope: "item", itemId: task.id, op: "update" })]);
          } else {
            await expect(write()).rejects.toMatchObject({ status: 403, code: "owner_violation" });
            expect(await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id))).toEqual(beforeItem);
            expect(await readStoredItem(runtime, tenant, task.databaseId, task.id)).toEqual(beforeStoredItem);
            expect((await readJobs()).rows).toEqual(beforeJobs);
            expect(enqueue).not.toHaveBeenCalled();
            expect(events).toEqual([]);
          }
          expect(await readStoredLinks(runtime, tenant, task.id)).toEqual(beforeLinks);
        } finally {
          enqueue.mockRestore();
          setInvalidationHook(() => {});
        }
      });
    });

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
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const db = (await runInTenant(tenant, () => cp.listDatabases())).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          // Historical valid noncanonical value; current production writes normalize it on entry.
          const task = await withTenantTransaction(runtime, tenant, (client) =>
            itemsStore.insertItem(client, {
              databaseId: db.id,
              properties: {
                name: "Old",
                date: "2026-10-13",
                timeFrom: key === "timeFrom" ? "9:00" : "09:00",
                timeTo: key === "timeTo" ? "" : "10:00",
                time: key === "timeFrom" ? "9:00–10:00" : "09:00",
              },
            }),
          );
          await withTenantTransaction(runtime, tenant, async (client) => {
            await insertValueLink(client, { itemId: task.id, propertyKey: "date", ruleKey: "test", sources: [] });
            if (state !== "missing")
              await insertValueLink(client, {
                itemId: task.id,
                propertyKey: key,
                ruleKey: "test",
                sources: [],
                ...(state === "broken"
                  ? { state: "broken" as const, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") }
                  : {}),
              });
          });
          const heartbeat = await withTenantTransaction(runtime, tenant, async (client) => {
            const project = await client.query<{ id: string }>(
              "SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'projects' LIMIT 1",
            );
            if (!project.rows[0]) throw new Error("Missing seeded project");
            return schedulerStore.createHeartbeat(client, {
              projectItemId: project.rows[0].id,
              name: "Task update probe",
              rule: { kind: "onItemEvent", databaseId: db.id, event: "update" },
              actionId: "noop",
            });
          });
          const jobKey = schedulerStore.heartbeatFireJobKey(heartbeat.id, task.id);
          const readJobs = () =>
            pool.query<{ key: string | null; locked_at: Date | null; attempts: number; max_attempts: number }>(
              "SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
            );
          const beforeJobs = (await readJobs()).rows;
          expect(beforeJobs.some((row) => row.key === jobKey)).toBe(false);
          const beforeItem = await readStoredItem(runtime, tenant, db.id, task.id);
          if (!beforeItem) throw new Error("Missing task before update");
          const beforeLinks = await readStoredLinks(runtime, tenant, task.id);
          const advanced = await pool.query<{ advanced: boolean }>(
            "SELECT clock_timestamp() > $1::timestamptz AS advanced",
            [beforeItem.updated_at],
          );
          expect(advanced.rows[0]?.advanced).toBe(true);
          const events: InvalidationEvent[] = [];
          const enqueue = vi.spyOn(queue, "enqueueJob");
          setInvalidationHook((event) => events.push(event));
          try {
            let writeClient: PoolClient | undefined;
            const write = () =>
              runInTenant(tenant, () =>
                withTransaction(runtime, (client) => {
                  writeClient = client;
                  return updateItemWithClient(
                    client,
                    { databaseId: db.id, itemId: task.id, propertiesPatch: { date: "2026-10-14" } },
                    { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                  );
                }),
              );
            if (state === "on") {
              const result = await write();
              expect(result.properties).toMatchObject({
                date: "2026-10-14",
                timeFrom: "09:00",
                timeTo: key === "timeTo" ? null : "10:00",
                time: key === "timeTo" ? "09:00" : "09:00–10:00",
              });
              const afterItem = await readStoredItem(runtime, tenant, db.id, task.id);
              if (!afterItem) throw new Error("Missing task after update");
              expect(afterItem).toEqual({
                ...beforeItem,
                properties: afterItem.properties,
                updated_at: afterItem.updated_at,
              });
              const persistedProperties: unknown = JSON.parse(afterItem.properties);
              expect(persistedProperties).toEqual({
                name: "Old",
                date: "2026-10-14",
                timeFrom: "09:00",
                timeTo: key === "timeTo" ? null : "10:00",
                time: key === "timeTo" ? "09:00" : "09:00–10:00",
              });
              expect(afterItem.updated_at).not.toBe(beforeItem.updated_at);
              expect(await readStoredLinks(runtime, tenant, task.id)).toEqual(beforeLinks);
              expect((await readJobs()).rows).toContainEqual({
                key: jobKey,
                locked_at: null,
                attempts: 0,
                max_attempts: 3,
              });
              expect(writeClient).toBeDefined();
              expect(enqueue).toHaveBeenCalledWith(
                writeClient,
                queue.CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE,
                { heartbeatId: heartbeat.id, itemId: task.id },
                expect.objectContaining({ jobKey }),
              );
              expect(events).toEqual([expect.objectContaining({ scope: "item", itemId: task.id, op: "update" })]);
            } else {
              await expect(write()).rejects.toMatchObject({ status: 403, code: "owner_violation" });
              expect(await readStoredItem(runtime, tenant, db.id, task.id)).toEqual(beforeItem);
              expect(await readStoredLinks(runtime, tenant, task.id)).toEqual(beforeLinks);
              expect((await readJobs()).rows).toEqual(beforeJobs);
              expect(enqueue).not.toHaveBeenCalled();
              expect(events).toEqual([]);
            }
          } finally {
            enqueue.mockRestore();
            setInvalidationHook(() => {});
          }
        });
      },
      30000,
    );

    it.each(["09:00", null] as const)(
      "does not require a link for an unchanged omitted canonical time: %s",
      async (timeFrom) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const db = (await runInTenant(tenant, () => cp.listDatabases())).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          const task = await runInTenant(tenant, () =>
            cp.createItem({
              databaseId: db.id,
              properties: { name: "Task", date: "2026-10-13", timeFrom },
            }),
          );
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: task.id, propertyKey: "date", ruleKey: "test", sources: [] }),
          );
          const result = await runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: db.id, itemId: task.id, propertiesPatch: { date: "2026-10-14" } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
          expect(result.properties).toMatchObject({ date: "2026-10-14", timeFrom, time: timeFrom });
          const links = await readStoredLinks(runtime, tenant, task.id);
          expect(links.map((entry) => [entry.property_key, entry.state])).toEqual([["date", "on"]]);
        });
      },
      30000,
    );

    it.each(["10:00", null] as const)(
      "does not require an omitted unchanged end-time link: %s",
      async (timeTo) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const db = (await runInTenant(tenant, () => cp.listDatabases())).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          const task = await runInTenant(tenant, () =>
            cp.createItem({
              databaseId: db.id,
              properties: { name: "Task", date: "2026-10-13", timeFrom: "09:00", timeTo },
            }),
          );
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: task.id, propertyKey: "date", ruleKey: "test", sources: [] }),
          );
          const links = await readStoredLinks(runtime, tenant, task.id);
          await runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: db.id, itemId: task.id, propertiesPatch: { date: "2026-10-14" } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
          const after = await readStoredItem(runtime, tenant, db.id, task.id);
          if (!after) throw new Error("Missing task after update");
          const properties: unknown = JSON.parse(after.properties);
          expect(properties).toMatchObject({
            date: "2026-10-14",
            timeFrom: "09:00",
            timeTo,
            time: timeTo === null ? "09:00" : "09:00–10:00",
          });
          expect(await readStoredLinks(runtime, tenant, task.id)).toEqual(links);
          expect(links.map((entry) => entry.property_key)).toEqual(["date"]);
        });
      },
      30000,
    );

    it("allows a date-off Tasks transform when every added user key has an on link", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const task = await runInTenant(tenant, async () => {
          const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          return cp.createItem({
            databaseId: db.id,
            properties: { name: "Timed", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
          });
        });
        await withTenantTransaction(runtime, tenant, async (client) => {
          for (const propertyKey of ["date", "timeFrom", "timeTo"]) {
            await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
          }
        });
        const result = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(
              client,
              { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
              { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
            ),
          ),
        );
        expect(result.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
        const links = await withTenantTransaction(runtime, tenant, (client) =>
          listValueLinksByItemIds(client, [task.id]),
        );
        expect(links.map((entry) => entry.state)).toEqual(["on", "on", "on"]);
      });
    });

    it.each(["timeFrom", "timeTo"] as const)(
      "requires handoff for unchanged transform-added null %s",
      async (missingKey) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const task = await runInTenant(tenant, async () => {
            const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
            if (!db) throw new Error("Missing Tasks database");
            return cp.createItem({ databaseId: db.id, properties: { name: "Undated" } });
          });
          await withTenantTransaction(runtime, tenant, async (client) => {
            for (const propertyKey of ["date", "timeFrom", "timeTo"].filter((key) => key !== missingKey)) {
              await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
            }
          });
          const heartbeat = await withTenantTransaction(runtime, tenant, async (client) => {
            const project = await client.query<{ id: string }>(
              "SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'projects' LIMIT 1",
            );
            if (!project.rows[0]) throw new Error("Missing seeded project");
            return schedulerStore.createHeartbeat(client, {
              projectItemId: project.rows[0].id,
              name: "Date-off probe",
              rule: { kind: "onItemEvent", databaseId: task.databaseId, event: "update" },
              actionId: "noop",
            });
          });
          const jobKey = schedulerStore.heartbeatFireJobKey(heartbeat.id, task.id);
          const readJobs = () =>
            pool.query<{ key: string | null; locked_at: Date | null; attempts: number; max_attempts: number }>(
              "SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
            );
          const beforeJobs = (await readJobs()).rows;
          expect(beforeJobs.some((row) => row.key === jobKey)).toBe(false);
          const beforeItem = await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id));
          const beforeStoredItem = await readStoredItem(runtime, tenant, task.databaseId, task.id);
          const beforeLinks = await readStoredLinks(runtime, tenant, task.id);
          const events: InvalidationEvent[] = [];
          const enqueue = vi.spyOn(queue, "enqueueJob");
          setInvalidationHook((event) => events.push(event));
          try {
            await expect(
              runInTenant(tenant, () =>
                withTransaction(runtime, (client) =>
                  updateItemWithClient(
                    client,
                    { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
                    { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                  ),
                ),
              ),
            ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
            expect(await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id))).toEqual(beforeItem);
            expect(await readStoredItem(runtime, tenant, task.databaseId, task.id)).toEqual(beforeStoredItem);
            expect(await readStoredLinks(runtime, tenant, task.id)).toEqual(beforeLinks);
            expect((await readJobs()).rows).toEqual(beforeJobs);
            expect(enqueue).not.toHaveBeenCalled();
            expect(events).toEqual([]);
          } finally {
            enqueue.mockRestore();
            setInvalidationHook(() => {});
          }
        });
      },
    );

    async function relationWrites(client: PoolClient, fx: Awaited<ReturnType<typeof setup>>) {
      const edge = { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id };
      return {
        create: () => createRelationWithClient(client, edge, VALUE_LINKS),
        update: () => updateRelationWithClient(client, { ...edge, metadata: {} }, VALUE_LINKS),
        remove: () => deleteRelationWithClient(client, edge, VALUE_LINKS),
      };
    }

    it("rejects a user-owned relation write without a link row", async () => {
      const fx = await setup();
      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await expect(writes.create()).rejects.toMatchObject({ code: "owner_violation" });
      });
      const { rows } = await pool.query<{ "?column?": number }>("SELECT 1 FROM item_relations");
      expect(rows).toHaveLength(0);
    });

    it("rejects every relation write with a broken row", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects", "broken");
      for (const name of ["create", "update", "remove"] as const) {
        await withTransaction(pool, async (client) => {
          const writes = await relationWrites(client, fx);
          await expect(writes[name]()).rejects.toMatchObject({ code: "owner_violation" });
        });
      }
    });

    it("writes with an on row and leaves the state on", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");

      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await writes.create();
        await writes.remove();
      });

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on", brokenBy: null });
    });

    it("rejects a plain property write without an on row and writes nothing", async () => {
      const { files, file } = await setup();
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
            { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
          ),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });

      const { rows } = await pool.query<{ name: string | null }>(
        "SELECT properties->>'name' AS name FROM items WHERE id = $1",
        [file.id],
      );
      expect(rows).toEqual([{ name: "a.pdf" }]);
    });

    it("writes a plain property with an on row and leaves the state on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
          { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
        ),
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      const { rows } = await pool.query<{ name: string | null }>(
        "SELECT properties->>'name' AS name FROM items WHERE id = $1",
        [file.id],
      );
      expect(rows).toEqual([{ name: "z.pdf" }]);
    });
  });

  describe("tenants", () => {
    it("keeps the Inbox missing-source error after a real purge", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const dbs = await runInTenant(tenant, () => cp.listDatabases());
        const inbox = dbs.find((db) => db.ownerModuleId === "inbox");
        const types = dbs.find((db) => db.ownerModuleId === "inboxItemTypes");
        if (!inbox || !types) throw new Error("Missing Inbox databases");
        const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
        if (!property) throw new Error("Missing Inbox type relation");
        const fixture = await withTenantTransaction(runtime, tenant, async (client) => {
          const type = await createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: types.id,
            name: "Page",
            emoji: "P",
            processingMethod: "pageContent",
          });
          const item = await createInboxItemWithClient(client, {
            inboxDatabaseId: inbox.id,
            date: "2026-10-01",
            time: "09:00",
            text: "Source",
            type: type.id,
          });
          await insertValueLink(client, { itemId: item.id, propertyKey: "type", ruleKey: "test", sources: [] });
          return { item, type };
        });
        await runInTenant(tenant, () => cp.softDeleteItem(inbox.id, fixture.item.id));
        await runInTenant(tenant, () => cp.purgeExpiredTrashSubtree(fixture.item.id, new Date(Date.now() + 60000)));
        const links = await withTenantTransaction(runtime, tenant, (client) =>
          listValueLinksByItemIds(client, [fixture.item.id]),
        );
        // Issue #1656: the purge removes the purged item's own link rows, so the value-link process no
        // longer holds the `type` handoff and is refused before the item is looked up. A user write still
        // gets the missing-source error.
        expect(links).toEqual([]);
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                deleteRelationWithClient(
                  client,
                  { relationPropertyId: property.id, callerItemId: fixture.item.id, targetItemId: fixture.type.id },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                ),
              ),
            ),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          await expect(
            runInTenant(tenant, () =>
              cp.deleteRelation({
                relationPropertyId: property.id,
                callerItemId: fixture.item.id,
                targetItemId: fixture.type.id,
              }),
            ),
          ).rejects.toMatchObject({ status: 404, code: "not_found" });
          expect(events).toEqual([]);
          expect(
            await withTenantTransaction(runtime, tenant, (client) =>
              listValueLinksByItemIds(client, [fixture.item.id]),
            ),
          ).toEqual(links);
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it("refuses protected Inbox deletion when its trashed source is locked", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const dbs = await runInTenant(tenant, () => cp.listDatabases());
          const inbox = dbs.find((db) => db.ownerModuleId === "inbox");
          const types = dbs.find((db) => db.ownerModuleId === "inboxItemTypes");
          if (!inbox || !types) throw new Error("Missing Inbox databases");
          const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
          if (!property) throw new Error("Missing Inbox type relation");
          const fixture = await withTenantTransaction(holderPool, tenant, async (client) => {
            const type = await createInboxTypeWithClient(client, {
              inboxItemTypesDatabaseId: types.id,
              name: "Page",
              emoji: "P",
              processingMethod: "pageContent",
            });
            const item = await createInboxItemWithClient(client, {
              inboxDatabaseId: inbox.id,
              date: "2026-10-01",
              time: "09:00",
              text: "Source",
              type: type.id,
            });
            await insertValueLink(client, { itemId: item.id, propertyKey: "type", ruleKey: "test", sources: [] });
            return { item, type };
          });
          await runInTenant(tenant, () => cp.softDeleteItem(inbox.id, fixture.item.id));
          const edge = {
            relationPropertyId: property.id,
            callerItemId: fixture.item.id,
            targetItemId: fixture.type.id,
          };
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          const beforeJobs = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM graphile_worker.jobs",
          );
          const definition = await withTenantTransaction(holderPool, tenant, (client) =>
            relationsStore.getRelationDefinitionByPropertyId(client, property.id),
          );
          if (!definition) throw new Error("Missing Inbox relation definition");
          const beforeEdges = await withTenantTransaction(holderPool, tenant, (client) =>
            relationsStore.listRelationsForItem(client, definition.id, fixture.item.id),
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let contenderPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await deleteRelationWithClient(client, edge, undefined, USER);
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          try {
            await bounded(held.promise);
            const lock = await pool.query<{ held: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM items i JOIN pg_locks l ON l.transactionid::text = i.xmax::text WHERE i.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
              [fixture.item.id, holderPid],
            );
            expect(lock.rows[0]?.held).toBe(true);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  return deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(contenderPid).toBeTypeOf("number");
            expect(events).toEqual([]);
            expect(
              await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs"),
            ).toMatchObject({ rows: beforeJobs.rows });
            expect(
              await withTenantTransaction(contenderPool, tenant, (client) =>
                relationsStore.listRelationsForItem(client, definition.id, fixture.item.id),
              ),
            ).toEqual(beforeEdges);
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              requireSuccessful(await settleOwned(holder, () => holderPid));
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and holder cleanup failed");
            } finally {
              setInvalidationHook(() => {});
            }
          }
          if (failure !== undefined) throwFailure(failure.error);
          const links = await withTenantTransaction(holderPool, tenant, (client) =>
            listValueLinksByItemIds(client, [fixture.item.id]),
          );
          expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
        }),
      );
    }, 30000);

    it("preserves proposed-nil target validation without taking a link lease", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const dbs = await runInTenant(tenant, () => cp.listDatabases());
        const inbox = dbs.find((db) => db.ownerModuleId === "inbox");
        const types = dbs.find((db) => db.ownerModuleId === "inboxItemTypes");
        if (!inbox || !types) throw new Error("Missing Inbox databases");
        const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
        if (!property) throw new Error("Missing Inbox type relation");
        const target = await withTenantTransaction(runtime, tenant, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: types.id,
            name: "Page",
            emoji: "P",
            processingMethod: "pageContent",
          }),
        );
        const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");
        try {
          await runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              assertRelationTargetLinkableWithClient(
                client,
                { relationPropertyId: property.id, targetItemId: target.id },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          );
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("restores nested managed PostgreSQL lock timeouts in stack order", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        await runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            const definition = await relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id);
            if (!definition) throw new Error("Missing relation definition");
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
                await createRelationWithClient(
                  client,
                  { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                );
                expect(await read()).toBe("1ms");
              },
            );
            expect(await read()).toBe(before);
          }),
        );
      });
    });

    it("preserves a non-driver SC001 value through the protected create store", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        const spoof = { code: "SC001" };
        const original = relationsStore.createItemRelationReportingInsert;
        const spy = vi
          .spyOn(relationsStore, "createItemRelationReportingInsert")
          .mockImplementation(async (client, input) => {
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
        try {
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                createRelationWithClient(
                  client,
                  { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                ),
              ),
            ),
          ).rejects.toBe(spoof);
          expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("keeps genuine cardinality violation mapping through protected create", async () => {
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
          const item = await cp.createItem({ databaseId: source.id, properties: {} });
          const one = await cp.createItem({ databaseId: target.id, properties: {} });
          const two = await cp.createItem({ databaseId: target.id, properties: {} });
          const other = await cp.createItem({ databaseId: source.id, properties: {} });
          const three = await cp.createItem({ databaseId: target.id, properties: {} });
          await cp.createRelation({ relationPropertyId: property.id, callerItemId: item.id, targetItemId: one.id });
          return { property, item, one, two, other, three };
        });
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: fixture.item.id, propertyKey: "target", ruleKey: "test", sources: [] }),
        );
        await expect(
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              createRelationWithClient(
                client,
                {
                  relationPropertyId: fixture.property.id,
                  callerItemId: fixture.item.id,
                  targetItemId: fixture.two.id,
                },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          ),
        ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
        const edges = await runInTenant(tenant, () => cp.listItemRelations(fixture.item.id, fixture.property.id));
        expect(edges?.map((edge) => edge.targetItemId)).toEqual([fixture.one.id]);
        const held = barrier();
        const release = barrier();
        let holderPid: number | undefined;
        let contenderPid: number | undefined;
        const holder = runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            await createRelationWithClient(client, {
              relationPropertyId: fixture.property.id,
              callerItemId: fixture.other.id,
              targetItemId: fixture.three.id,
            });
            held.resolve();
            await bounded(release.promise);
          }),
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let failure: { error: unknown } | undefined;
        try {
          await bounded(held.promise);
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, async (client) => {
                contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                return createRelationWithClient(
                  client,
                  {
                    relationPropertyId: fixture.property.id,
                    callerItemId: fixture.item.id,
                    targetItemId: fixture.two.id,
                  },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                );
              }),
            ),
          ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
          expect(holderPid).toBeTypeOf("number");
          expect(contenderPid).toBeTypeOf("number");
        } catch (error) {
          failure = { error };
        } finally {
          release.resolve();
          try {
            requireSuccessful(await settleOwned(holder, () => holderPid));
          } catch (error) {
            failure = combineFailure(failure, [error], "Test and holder cleanup failed");
          }
        }
        if (failure !== undefined) throwFailure(failure.error);
      });
    });

    it("refuses a relation while its new active link is still uncommitted", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let contenderPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await insertValueLink(client, {
                itemId: fx.file.id,
                propertyKey: "projects",
                ruleKey: "test",
                sources: [],
              });
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          try {
            await bounded(held.promise);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  return createRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
            expect(holderPid).toBeTypeOf("number");
            expect(contenderPid).toBeTypeOf("number");
            expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual(
              [],
            );
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              requireSuccessful(await settleOwned(holder, () => holderPid));
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and holder cleanup failed");
            }
          }
          if (failure !== undefined) throwFailure(failure.error);
          const links = await withTenantTransaction(holderPool, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        }),
      );
    }, 30000);

    it("uses a nonlocking prediction in relation validation and rechecks on mutation", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (validationPool) =>
        withRuntimePool(async (userPool) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          await withTenantTransaction(userPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const edge = {
            relationPropertyId: fx.projectsProperty.id,
            callerItemId: fx.file.id,
            targetItemId: fx.alpha.id,
          };
          const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");
          let participant: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
          let participantPid: number | undefined;
          let failure: { error: unknown } | undefined;
          try {
            await runInTenant(tenant, () =>
              withTransaction(validationPool, async (client) => {
                await assertRelationCreatableWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
                expect(spy.mock.calls.map((call) => call[3])).toEqual(["none"]);
                participant = runInTenant(tenant, () =>
                  withTransaction(userPool, async (userClient) => {
                    participantPid = (await userClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                      ?.pid;
                    return createRelationWithClient(userClient, edge, undefined, USER);
                  }),
                ).then(
                  () => ({ ok: true as const }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
                requireSuccessful(await bounded(participant));
              }),
            );
            await expect(
              runInTenant(tenant, () =>
                withTransaction(validationPool, (client) =>
                  createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER),
                ),
              ),
            ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          } catch (error) {
            failure = { error };
          } finally {
            if (participant) {
              try {
                requireSuccessful(await settleOwned(participant, () => participantPid));
              } catch (error) {
                failure = combineFailure(failure, [error], "Validation and participant cleanup failed");
              }
            }
            spy.mockRestore();
          }
          if (failure !== undefined) throwFailure(failure.error);
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
        await withTenantTransaction(runtime, tenantB, (client) =>
          insertValueLink(client, { itemId: foreign.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        const edge = {
          relationPropertyId: own.projectsProperty.id,
          callerItemId: own.file.id,
          targetItemId: own.alpha.id,
        };
        await expect(
          runInTenant(tenantA, () =>
            withTransaction(runtime, (client) => createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)),
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect(await runInTenant(tenantA, () => cp.listItemRelations(own.file.id, own.projectsProperty.id))).toEqual(
          [],
        );
        const foreignLinks = await withTenantTransaction(runtime, tenantB, (client) =>
          listValueLinksByItemIds(client, [foreign.file.id]),
        );
        expect(foreignLinks[0]).toMatchObject({ state: "on" });
        await withTenantTransaction(runtime, tenantA, (client) =>
          insertValueLink(client, { itemId: own.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        await expect(
          runInTenant(tenantA, () =>
            withTransaction(runtime, (client) => createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)),
          ),
        ).resolves.toMatchObject({ itemA: own.file.id, itemB: own.alpha.id });
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
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: movie.id, propertyKey: "watchedWith", ruleKey: "test", sources: [] }),
        );
        const write = (rating: number) =>
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              createRelationWithClient(
                client,
                {
                  relationPropertyId: property.id,
                  callerItemId: movie.id,
                  targetItemId: person.id,
                  metadata: { rating },
                },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          );
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(write(6)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
          expect(events).toEqual([]);
          expect(await runInTenant(tenant, () => cp.listItemRelations(movie.id, property.id))).toEqual([]);
          await expect(write(5)).resolves.toMatchObject({ metadata: { rating: 5 } });
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [movie.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it.each([
      ["update", "commit", "normal"],
      ["update", "rollback", "normal"],
      ["delete", "commit", "normal"],
      ["delete", "rollback", "normal"],
      ["update", "commit", "undefined"],
      ["update", "commit", "combined"],
    ] as const)(
      "refuses protected %s on a proposal-held edge before holder %s (%s)",
      async (operation, outcome, control) => {
        const original = { marker: "observation" };
        const cleanup = { marker: "cleanup" };
        const runControl = async () => {
          const tenant = await createTestTenant(pool);
          await withRuntimePool(async (holderPool) =>
            withRuntimePool(async (contenderPool, operations) => {
              const cp = createChokePoint(holderPool);
              const fx = await runInTenant(tenant, () => setup(cp));
              const edge = {
                relationPropertyId: fx.projectsProperty.id,
                callerItemId: fx.file.id,
                targetItemId: fx.alpha.id,
              };
              await runInTenant(tenant, () => cp.createRelation(edge));
              await withTenantTransaction(holderPool, tenant, (client) =>
                insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
              );
              const definition = await withTenantTransaction(contenderPool, tenant, (client) =>
                relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id),
              );
              if (!definition) throw new Error("Missing relation definition");
              const beforeEdges = await withTenantTransaction(contenderPool, tenant, (client) =>
                relationsStore.listRelationsForItem(client, definition.id, fx.file.id),
              );
              const target = beforeEdges[0];
              if (!target || beforeEdges.length !== 1) throw new Error("Expected one existing edge");
              const beforeItem = await readStoredItem(contenderPool, tenant, fx.files.id, fx.file.id);
              const beforeLinks = await readStoredLinks(contenderPool, tenant, fx.file.id);
              const beforeJobs = await pool.query<{ key: string | null }>(
                "SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
              );
              const held = barrier();
              const release = barrier();
              const rollback = new Error("forced proposal rollback");
              let holderPid: number | undefined;
              let contenderPid: number | undefined;
              let edgeAttempt = false;
              const events: InvalidationEvent[] = [];
              setInvalidationHook((event) => events.push(event));
              const holder = runInTenant(tenant, () =>
                withTransaction(holderPool, async (client) => {
                  holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  await executeProposalSteps(
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
                  held.resolve();
                  await bounded(release.promise);
                  if (outcome === "rollback") throw rollback;
                }),
              ).then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              let failure: { error: unknown } | undefined;
              try {
                await bounded(held.promise);
                const edgeLock = await pool.query<{ held: boolean }>(
                  `SELECT EXISTS (SELECT 1 FROM item_relations e JOIN pg_locks l ON l.transactionid::text = e.xmax::text
               WHERE e.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted) AS held`,
                  [target.id, holderPid],
                );
                expect(edgeLock.rows[0]?.held).toBe(true);
                await expectRuntimeRejection(
                  operations,
                  operations.run(() =>
                    runInTenant(tenant, () =>
                      withTransaction(contenderPool, async (client) => {
                        contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                          ?.pid;
                        // eslint-disable-next-line @typescript-eslint/unbound-method
                        const original = client.query;
                        // eslint-disable-next-line @typescript-eslint/unbound-method
                        client.query = new Proxy(client.query, {
                          apply(query, receiver, args: unknown[]) {
                            const params: unknown = args[1];
                            if (
                              typeof args[0] === "string" &&
                              args[0].includes("FROM item_relations") &&
                              args[0].includes("FOR UPDATE NOWAIT") &&
                              Array.isArray(params) &&
                              params[0] === definition.id &&
                              params[1] === target.itemA &&
                              params[2] === target.itemB
                            )
                              edgeAttempt = true;
                            return Reflect.apply(query, receiver, args);
                          },
                        });
                        try {
                          return operation === "update"
                            ? await updateRelationWithClient(
                                client,
                                { ...edge, metadata: { attempted: true } },
                                VALUE_LINKS,
                                SYSTEM_WRITER,
                              )
                            : await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
                        } finally {
                          client.query = original;
                        }
                      }),
                    ),
                  ),
                  { status: 409, code: "value_link_busy" },
                );
                expect(edgeAttempt).toBe(true);
                if (control === "undefined") throwFailure(undefined);
                if (control === "combined") throwFailure(original);
                expect(holderPid).toBeTypeOf("number");
                expect(contenderPid).toBeTypeOf("number");
                expect(events).toEqual([]);
                expect(await readStoredItem(contenderPool, tenant, fx.files.id, fx.file.id)).toEqual(beforeItem);
                expect(await readStoredLinks(contenderPool, tenant, fx.file.id)).toEqual(beforeLinks);
                expect(
                  (
                    await pool.query<{ key: string | null }>(
                      "SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
                    )
                  ).rows,
                ).toEqual(beforeJobs.rows);
                expect(
                  await withTenantTransaction(contenderPool, tenant, (client) =>
                    relationsStore.listRelationsForItem(client, definition.id, fx.file.id),
                  ),
                ).toEqual(beforeEdges);
              } catch (error) {
                failure = { error };
              } finally {
                release.resolve();
                try {
                  await operations.settle();
                  const result = await settleOwned(holder, () => holderPid);
                  if (outcome === "rollback") {
                    expect(result.ok).toBe(false);
                    if (!result.ok) expect(result.error).toBe(rollback);
                  } else requireSuccessful(result);
                  if (control === "combined") throwFailure(cleanup);
                } catch (error) {
                  failure = combineFailure(failure, [error], "Test and proposal cleanup failed");
                } finally {
                  setInvalidationHook(() => {});
                }
              }
              if (failure !== undefined) throwFailure(failure.error);
              await runInTenant(tenant, () =>
                withTransaction(contenderPool, (client) =>
                  operation === "update"
                    ? updateRelationWithClient(
                        client,
                        { ...edge, metadata: { healthy: true } },
                        VALUE_LINKS,
                        SYSTEM_WRITER,
                      )
                    : deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER),
                ),
              );
              const after = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
              if (operation === "update") expect(after?.[0]?.metadata).toEqual({ healthy: true });
              else expect(after).toEqual([]);
              expect((await readStoredLinks(contenderPool, tenant, fx.file.id))[0]?.state).toBe("on");
            }),
          );
        };
        if (control === "normal") return runControl();
        const result = await runControl().then(
          () => ({ rejected: false as const }),
          (error: unknown) => ({ rejected: true as const, error }),
        );
        expect(result.rejected).toBe(true);
        if (!result.rejected) throw new Error("Expected rejection");
        if (control === "undefined") expect(result.error).toBeUndefined();
        else {
          expect(result.error).toBeInstanceOf(AggregateError);
          if (!(result.error instanceof AggregateError)) throw new Error("Expected combined failure");
          expect(result.error.errors).toHaveLength(2);
          expect(result.error.errors[0]).toBe(original);
          expect(result.error.errors[1]).toBe(cleanup);
          expect(result.error.cause).toBe(original);
        }
      },
      30000,
    );

    it("refuses a protected relation when a real proposal holds its definition and edge", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          await runInTenant(tenant, () =>
            cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            }),
          );
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          const beforeJobs = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM graphile_worker.jobs",
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let contenderPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await executeProposalSteps(
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
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          try {
            await bounded(held.promise);
            const definition = await withTenantTransaction(contenderPool, tenant, (client) =>
              relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id),
            );
            if (!definition) throw new Error("Missing relation definition");
            const beforeEdges = await withTenantTransaction(contenderPool, tenant, (client) =>
              relationsStore.listRelationsForItem(client, definition.id, fx.file.id),
            );
            const lock = await pool.query<{ held: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
                 AND classid::bigint = ((hashtextextended($2::text, 0) >> 32) & 4294967295::bigint)
                 AND objid::bigint = (hashtextextended($2::text, 0) & 4294967295::bigint) AND objsubid = 1) AS held`,
              [holderPid, definition.id],
            );
            expect(lock.rows[0]?.held).toBe(true);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  return createRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.beta.id },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(contenderPid).toBeTypeOf("number");
            expect(events).toEqual([]);
            expect(
              await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs"),
            ).toMatchObject({ rows: beforeJobs.rows });
            expect(
              await withTenantTransaction(contenderPool, tenant, (client) =>
                relationsStore.listRelationsForItem(client, definition.id, fx.file.id),
              ),
            ).toEqual(beforeEdges);
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              const result = await settleOwned(holder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and proposal cleanup failed");
            } finally {
              setInvalidationHook(() => {});
            }
          }
          if (failure !== undefined) throwFailure(failure.error);
          const links = await withTenantTransaction(holderPool, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        }),
      );
    }, 30000);

    it("rechecks an active prediction after a concurrent user breaks the link", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool) =>
        withRuntimePool(async (systemPool) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const edge = {
            relationPropertyId: fx.projectsProperty.id,
            callerItemId: fx.file.id,
            targetItemId: fx.beta.id,
          };
          await runInTenant(tenant, () => cp.createRelation(edge));
          await withTenantTransaction(userPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const admitted = barrier();
          const release = barrier();
          let systemClient: PoolClient | undefined;
          let systemPid: number | undefined;
          let userPid: number | undefined;
          const original = relationsStore.lockExistingRelationNowait;
          const spy = vi
            .spyOn(relationsStore, "lockExistingRelationNowait")
            .mockImplementation(async (client, definitionId, itemA, itemB) => {
              await original(client, definitionId, itemA, itemB);
              if (client === systemClient) {
                admitted.resolve();
                await bounded(release.promise);
              }
            });
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          const system = runInTenant(tenant, () =>
            withTransaction(systemPool, async (client) => {
              systemClient = client;
              systemPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              return createRelationWithClient(
                client,
                { ...edge, targetItemId: fx.alpha.id },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          let consumedSystem: Awaited<typeof system> | undefined;
          try {
            await bounded(admitted.promise);
            await runInTenant(tenant, () =>
              withTransaction(userPool, async (client) => {
                userPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                await deleteRelationWithClient(client, edge, undefined, USER);
              }),
            );
            release.resolve();
            const systemOutcome = await bounded(system);
            expect(systemOutcome).toMatchObject({ ok: false, error: { status: 403, code: "owner_violation" } });
            consumedSystem = systemOutcome;
            expect(systemPid).toBeTypeOf("number");
            expect(userPid).toBeTypeOf("number");
            const links = await withTenantTransaction(userPool, tenant, (client) =>
              listValueLinksByItemIds(client, [fx.file.id]),
            );
            expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
            expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual(
              [],
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              const outcome = await settleOwned(system, () => systemPid);
              if (!outcome.ok && outcome !== consumedSystem)
                failure = combineFailure(failure, [outcome.error], "Test and system cleanup failed");
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and system cleanup failed");
            }
            spy.mockRestore();
            setInvalidationHook(() => {});
          }
          if (failure !== undefined) throwFailure(failure.error);
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
          withRuntimePool(async (contenderPool, operations) => {
            const cp = createChokePoint(holderPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            const edge = {
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            };
            await runInTenant(tenant, () => cp.createRelation(edge));
            if (state !== "missing")
              await withTenantTransaction(holderPool, tenant, (client) =>
                insertValueLink(client, {
                  itemId: fx.file.id,
                  propertyKey: "projects",
                  ruleKey: "test",
                  sources: [],
                  ...(state === "broken"
                    ? {
                        state: "broken" as const,
                        brokenBy: "user" as const,
                        brokenAt: new Date("2026-01-01T00:00:00Z"),
                      }
                    : {}),
                }),
              );
            const held = barrier();
            const release = barrier();
            let holderPid: number | undefined;
            let contenderPid: number | undefined;
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            const jobsBefore = (
              await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs")
            ).rows[0]?.count;
            const holder = runInTenant(tenant, () =>
              withTransaction(holderPool, async (client) => {
                holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                await updateRelationWithClient(client, { ...edge, metadata: { holder: true } });
                held.resolve();
                await bounded(release.promise);
              }),
            ).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
            let failure: { error: unknown } | undefined;
            try {
              await bounded(held.promise);
              const edgeLock = await pool.query<{ held: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM item_relations e JOIN pg_locks l ON l.transactionid::text = e.xmax::text
                 WHERE e.item_a = $1 AND e.item_b = $2 AND l.pid = $3 AND l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted) AS held`,
                [fx.file.id, fx.alpha.id, holderPid],
              );
              expect(edgeLock.rows[0]?.held).toBe(true);
              await expectRuntimeRejection(
                operations,
                operations.run(() =>
                  runInTenant(tenant, () =>
                    withTransaction(contenderPool, async (client) => {
                      contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                        ?.pid;
                      if (operation === "create")
                        return createRelationWithClient(
                          client,
                          { ...edge, metadata: { contender: true } },
                          VALUE_LINKS,
                          SYSTEM_WRITER,
                        );
                      if (operation === "update")
                        return updateRelationWithClient(
                          client,
                          { ...edge, metadata: { contender: true } },
                          VALUE_LINKS,
                          SYSTEM_WRITER,
                        );
                      return deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
                    }),
                  ),
                ),
                state === "on" ? { status: 409, code: "value_link_busy" } : { status: 403, code: "owner_violation" },
              );
              expect(holderPid).toBeTypeOf("number");
              expect(contenderPid).toBeTypeOf("number");
              expect(events).toEqual([]);
              expect(
                (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs"))
                  .rows[0]?.count,
              ).toBe(jobsBefore);
            } catch (error) {
              failure = { error };
            } finally {
              release.resolve();
              try {
                await operations.settle();
                const outcome = await settleOwned(holder, () => holderPid);
                requireSuccessful(outcome);
              } catch (error) {
                failure = combineFailure(failure, [error], "Test and holder cleanup failed");
              }
              setInvalidationHook(() => {});
            }
            if (failure !== undefined) throwFailure(failure.error);
            const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            expect(edges?.[0]?.metadata).toEqual({ holder: true });
            const links = await withTenantTransaction(holderPool, tenant, (client) =>
              listValueLinksByItemIds(client, [fx.file.id]),
            );
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
          const cp = createChokePoint(runtime);
          const fx = await runInTenant(tenant, () => setup(cp));
          const edge =
            side === "A"
              ? { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id }
              : { relationPropertyId: fx.filesProperty.id, callerItemId: fx.alpha.id, targetItemId: fx.file.id };
          const propertyKey = side === "A" ? "projects" : "files";
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: edge.callerItemId, propertyKey, ruleKey: "test", sources: [] }),
          );
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              await createRelationWithClient(
                client,
                { ...edge, metadata: { replay: true } },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
              await updateRelationWithClient(
                client,
                { ...edge, metadata: { update: true } },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
              expect(await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)).not.toBeNull();
              expect(await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)).toBeNull();
            }),
          );
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                updateRelationWithClient(client, { ...edge, metadata: {} }, VALUE_LINKS, SYSTEM_WRITER),
              ),
            ),
          ).rejects.toMatchObject({ status: 404, code: "not_found" });
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [edge.callerItemId]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        });
      },
    );

    it.each(["0", "5s"])(
      "restores the effective lock timeout %s after protected success and no-op",
      async (setting) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const fx = await runInTenant(tenant, () => setup(cp));
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              await client.query<{ set_config: string }>("SELECT set_config('lock_timeout', $1, true)", [setting]);
              const read = async () =>
                (await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') AS setting")).rows[0]
                  ?.setting;
              const before = await read();
              const edge = {
                relationPropertyId: fx.projectsProperty.id,
                callerItemId: fx.file.id,
                targetItemId: fx.alpha.id,
              };
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
              await deleteRelationWithClient(client, { ...edge, targetItemId: fx.beta.id }, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
            }),
          );
        });
      },
    );

    it("rejects an unmanaged client before prediction and protected hooks", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const client = await runtime.connect();
        const prediction = vi.spyOn(valueLinksStore, "lockOnValueLink");
        try {
          await client.query<{ set_config: string }>("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
          const edge = {
            relationPropertyId: fx.projectsProperty.id,
            callerItemId: fx.file.id,
            targetItemId: fx.alpha.id,
          };
          for (const operation of [
            () => createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER),
            () => updateRelationWithClient(client, { ...edge, metadata: {} }, VALUE_LINKS, SYSTEM_WRITER),
            () => deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER),
          ])
            await expect(runInTenant(tenant, operation)).rejects.toThrow("active managed transaction");
          expect(prediction).not.toHaveBeenCalled();
        } finally {
          prediction.mockRestore();
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
        const edge = {
          relationPropertyId: fx.projectsProperty.id,
          callerItemId: fx.file.id,
          targetItemId: fx.alpha.id,
        };
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        const definition = await withTenantTransaction(runtime, tenant, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id),
        );
        if (!definition) throw new Error("Missing definition");
        const admission = {
          definitionId: definition.id,
          itemA: fx.file.id,
          itemB: fx.alpha.id,
          callerItemId: fx.file.id,
          propertyKey: "projects",
          insert: true,
        };
        const foreign = await runtime.connect();
        const release = barrier();
        operations.onCancel(() => release.resolve());
        let descendant: Promise<void> | undefined;
        const hook = vi.fn(async () => {});
        const body = vi.fn(async () => {});
        const lock = vi.spyOn(relationsStore, "tryLockRelationDefinition");
        let failure: { error: unknown } | undefined;
        try {
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              expect(client).not.toBe(foreign);
              const foreignQuery = vi.spyOn(foreign, "query");
              try {
                await expect(withValueLinkRelationAdmission(foreign, admission, hook, body)).rejects.toThrow(
                  "active managed transaction",
                );
                expect(foreignQuery).not.toHaveBeenCalled();
                expect(lock).not.toHaveBeenCalled();
                expect(hook).not.toHaveBeenCalled();
                expect(body).not.toHaveBeenCalled();
              } finally {
                foreignQuery.mockRestore();
              }
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              const ownerLockCalls = lock.mock.calls.length;
              descendant = operations.run(async () => {
                await bounded(release.promise);
                const oldQuery = vi.spyOn(client, "query");
                try {
                  await expect(withValueLinkRelationAdmission(client, admission, hook, body)).rejects.toThrow(
                    "active managed transaction",
                  );
                  expect(oldQuery).not.toHaveBeenCalled();
                  expect(lock).toHaveBeenCalledTimes(ownerLockCalls);
                  expect(hook).not.toHaveBeenCalled();
                  expect(body).not.toHaveBeenCalled();
                } finally {
                  oldQuery.mockRestore();
                }
              });
            }),
          );
          release.resolve();
          if (!descendant) throw new Error("Missing descendant");
          await bounded(descendant);
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
            }),
          );
          expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual([]);
        } catch (error) {
          failure = { error };
        } finally {
          release.resolve();
          try {
            await operations.settle();
          } catch (error) {
            failure = combineFailure(failure, [error], "Body and cleanup failed");
          }
          lock.mockRestore();
          try {
            foreign.release();
          } catch (error) {
            failure = combineFailure(failure, [error], "Body and release failed");
          }
        }
        if (failure !== undefined) throwFailure(failure.error);
      });
    }, 30000);

    it("keeps a caught NOWAIT failure rollback-only after savepoint recovery", async () => {
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
            const target = await cp.createDatabase({ name: "Other rollup targets" });
            await cp.createRelationProperty({
              sourceDatabaseId: fx.files.id,
              targetDatabaseId: target.id,
              key: "others",
              name: "Others",
            });
            return cp.createProperty({
              databaseId: fx.files.id,
              key: "otherCount",
              name: "Other count",
              type: "rollup",
              config: { relationPropertyKey: "others", aggregation: "count" },
            });
          });
          const jobKey = rollupRecomputeJobKey(rollup.id, unrelated.id);
          const jobCount = async () =>
            (
              await pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
                [jobKey],
              )
            ).rows[0]?.count;
          expect(await jobCount()).toBe("0");
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          const callback = vi.fn();
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          let holderPid: number | undefined;
          let competitorPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await createRelationWithClient(
                client,
                { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                undefined,
                USER,
              );
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          try {
            await bounded(held.promise);
            const linkLock = await pool.query<{ held: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM value_links v JOIN pg_locks l ON l.transactionid::text = v.xmax::text
                 WHERE v.item_id = $1 AND v.property_key = 'projects' AND l.pid = $2 AND l.locktype = 'transactionid' AND l.granted) AS held`,
              [fx.file.id, holderPid],
            );
            expect(linkLock.rows[0]?.held).toBe(true);
            await expectRuntimeRejection(
              operations,
              operations.run(() =>
                runInTenant(tenant, () =>
                  withTransaction(contenderPool, async (client) => {
                    competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                      ?.pid;
                    await updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "before" } },
                      { writer: USER },
                    );
                    await enqueueRollupRecompute(client, rollup.id, unrelated.id);
                    const queued = await client.query<{ key: string }>(
                      "SELECT key FROM graphile_worker.jobs WHERE key = $1",
                      [jobKey],
                    );
                    expect(queued.rows).toEqual([{ key: jobKey }]);
                    runAfterCommit(client, callback);
                    await client.query("SAVEPOINT relation_busy");
                    await expect(
                      updateRelationWithClient(
                        client,
                        {
                          relationPropertyId: fx.projectsProperty.id,
                          callerItemId: fx.file.id,
                          targetItemId: fx.beta.id,
                          metadata: {},
                        },
                        VALUE_LINKS,
                        SYSTEM_WRITER,
                      ),
                    ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
                    await client.query("ROLLBACK TO SAVEPOINT relation_busy");
                    await updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "after" } },
                      { writer: USER },
                    );
                  }),
                ),
              ),
              { status: 409, code: "value_link_busy" },
            );
            expect(holderPid).toBeTypeOf("number");
            expect(competitorPid).toBeTypeOf("number");
            expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, unrelated.id)))?.properties.name).toBe(
              "original",
            );
            expect(callback).not.toHaveBeenCalled();
            expect(await jobCount()).toBe("0");
            expect(events.filter((event) => event.scope === "item" && event.itemId === unrelated.id)).toEqual([]);
            await runInTenant(tenant, () =>
              withTransaction(contenderPool, async (client) => {
                const result = await client.query<{ pid: number; timeout: string }>(
                  "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS timeout",
                );
                expect(result.rows[0]).toEqual({ pid: competitorPid, timeout: "0" });
                await expect(
                  updateRelationWithClient(
                    client,
                    {
                      relationPropertyId: fx.projectsProperty.id,
                      callerItemId: unrelated.id,
                      targetItemId: fx.beta.id,
                      metadata: {},
                    },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  ),
                ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
              }),
            );
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              await operations.settle();
              const result = await settleOwned(holder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and holder cleanup failed");
            }
            setInvalidationHook(() => {});
          }
          if (failure !== undefined) throwFailure(failure.error);
        }),
      );
    }, 30000);

    it("rolls back all earlier and later writes when caught advisory busy reaches the transaction owner", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool, operations) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const unrelated = await runInTenant(tenant, () =>
            cp.createItem({ databaseId: fx.files.id, properties: { name: "original" } }),
          );
          const rollup = await runInTenant(tenant, () =>
            cp.createProperty({
              databaseId: fx.files.id,
              key: "projectCount",
              name: "Project count",
              type: "rollup",
              config: { relationPropertyKey: "projects", aggregation: "count" },
            }),
          );
          const jobKey = rollupRecomputeJobKey(rollup.id, unrelated.id);
          const searchJobKey = `item-search-reindex:item:${unrelated.id}`;
          const jobCount = async () =>
            (
              await pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
                [jobKey],
              )
            ).rows[0]?.count;
          expect(await jobCount()).toBe("0");
          await runInTenant(tenant, () =>
            cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            }),
          );
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let competitorPid: number | undefined;
          const events: InvalidationEvent[] = [];
          const callback = vi.fn();
          setInvalidationHook((event) => events.push(event));
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await executeProposalSteps(
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
              held.resolve();
              await bounded(release.promise);
            }),
          );
          const settledHolder = holder.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: { error: unknown } | undefined;
          try {
            await bounded(held.promise);
            await expectRuntimeRejection(
              operations,
              operations.run(() =>
                runInTenant(tenant, () =>
                  withTransaction(contenderPool, async (client) => {
                    competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                      ?.pid;
                    await updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "before" } },
                      { writer: USER },
                    );
                    await enqueueRollupRecompute(client, rollup.id, unrelated.id);
                    // Registered for the pre-commit flush (R1 D1), which the caught busy below must prevent.
                    await enqueueItemSearchReindex(client, { kind: "item", itemId: unrelated.id });
                    const queued = await client.query<{ key: string }>(
                      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])",
                      [[jobKey, searchJobKey]],
                    );
                    expect(queued.rows).toEqual([{ key: jobKey }]);
                    runAfterCommit(client, callback);
                    await expect(
                      createRelationWithClient(
                        client,
                        {
                          relationPropertyId: fx.projectsProperty.id,
                          callerItemId: fx.file.id,
                          targetItemId: fx.beta.id,
                        },
                        VALUE_LINKS,
                        SYSTEM_WRITER,
                      ),
                    ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
                    await updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "after" } },
                      { writer: USER },
                    );
                  }),
                ),
              ),
              { status: 409, code: "value_link_busy" },
            );
            expect(holderPid).toBeTypeOf("number");
            expect(competitorPid).toBeTypeOf("number");
            expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, unrelated.id)))?.properties.name).toBe(
              "original",
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === unrelated.id)).toEqual([]);
            expect(callback).not.toHaveBeenCalled();
            expect(await jobCount()).toBe("0");
            const searchJobs = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
              [searchJobKey],
            );
            expect(searchJobs.rows[0]?.count).toBe("0");
          } catch (error) {
            failure = { error };
          } finally {
            release.resolve();
            try {
              await operations.settle();
              const result = await settleOwned(settledHolder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure = combineFailure(failure, [error], "Test and holder cleanup failed");
            } finally {
              setInvalidationHook(() => {});
            }
          }
          if (failure !== undefined) throwFailure(failure.error);
        }),
      );
    }, 30000);

    /*
     * R1 D1: a protected valueLinks relation and an ordinary relation that share an endpoint both queue that
     * endpoint's search job. The protected write registers it in its 1 ms body and adds it at its pre-commit
     * flush, after the body restored the session's lock timeout and while its lease stays held. A scratch holder
     * of the tenant's search-flush lock (released and awaited below) makes that flush wait observably.
     */
    it("adds a protected relation's search jobs at its flush, waiting there without value_link_busy beside an ordinary writer", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const other = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: fx.files.id, properties: { name: "b.pdf" } }),
        );
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
        );
        const lockHeld = barrier();
        const releaseLock = barrier();
        let holderPid: number | undefined;
        const holder = runAsSystem("search flush lock holder", () =>
          withTransaction(pool, async (client) => {
            holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            await client.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))", [
              SEARCH_FLUSH_TENANT_LOCK_CLASS,
              tenant,
            ]);
            lockHeld.resolve();
            await bounded(releaseLock.promise);
          }),
        );
        let protectedPid: number | undefined;
        let ordinaryPid: number | undefined;
        type Outcome = { ok: true } | { ok: false; error: unknown };
        const write = (kind: "protected" | "ordinary", callerItemId: string): Promise<Outcome> =>
          runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (kind === "protected") protectedPid = pid;
              else ordinaryPid = pid;
              const edge = { relationPropertyId: fx.projectsProperty.id, callerItemId, targetItemId: fx.alpha.id };
              if (kind === "protected") await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              else await createRelationWithClient(client, edge, undefined, USER);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        let protectedWrite: Promise<Outcome> | undefined;
        let ordinaryWrite: Promise<Outcome> | undefined;
        let failure: { error: unknown } | undefined;
        try {
          await bounded(lockHeld.promise);
          protectedWrite = write("protected", fx.file.id);
          await waitUntil(() => protectedPid !== undefined);
          if (!holderPid || !protectedPid) throw new Error("Missing participant PID");
          // The protected body finished; its flush waits on the tenant's flush lock, far beyond the body's 1 ms.
          await waitBlocked(holderPid, protectedPid);
          ordinaryWrite = write("ordinary", other.id);
          await waitUntil(() => ordinaryPid !== undefined);
          if (!ordinaryPid) throw new Error("Missing participant PID");
          // The ordinary write waits behind the protected write's held relation lock, not on the flush.
          await waitBlocked(protectedPid, ordinaryPid);
        } catch (error) {
          failure = { error };
        } finally {
          releaseLock.resolve();
        }
        const settled = await Promise.allSettled([
          bounded(holder),
          bounded(protectedWrite ?? Promise.resolve({ ok: true as const })),
          bounded(ordinaryWrite ?? Promise.resolve({ ok: true as const })),
        ]);
        if (failure) throwFailure(failure.error);
        const [held, protectedOutcome, ordinaryOutcome] = settled;
        expect(held.status).toBe("fulfilled");
        expect(protectedOutcome).toEqual({ status: "fulfilled", value: { ok: true } });
        expect(ordinaryOutcome).toEqual({ status: "fulfilled", value: { ok: true } });
        const keys = await pool.query<{ key: string }>(
          "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
          [[fx.file.id, fx.alpha.id, other.id].map((id) => `item-search-reindex:item:${id}`)],
        );
        expect(keys.rows.map((row) => row.key)).toEqual(
          [fx.file.id, fx.alpha.id, other.id].map((id) => `item-search-reindex:item:${id}`).sort(),
        );
        expect(await readStoredLinks(runtime, tenant, fx.file.id)).toMatchObject([{ state: "on" }]);
      });
    }, 30000);

    it("refuses a protected relation waiting on a populated rollup job", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool) =>
        withRuntimePool(async (systemPool) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const gamma = await runInTenant(tenant, async () => {
            await cp.createProperty({ databaseId: fx.alpha.databaseId, key: "hours", name: "Hours", type: "number" });
            await cp.updateItem({
              databaseId: fx.alpha.databaseId,
              itemId: fx.alpha.id,
              propertiesPatch: { hours: 1 },
            });
            const third = await cp.createItem({ databaseId: fx.alpha.databaseId, properties: { hours: 3 } });
            await cp.createProperty({
              databaseId: fx.files.id,
              key: "totalHours",
              name: "Total hours",
              type: "rollup",
              config: { relationPropertyKey: "projects", aggregation: "sum", targetPropertyKey: "hours" },
            });
            await cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            });
            await cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.beta.id,
            });
            return third;
          });
          const rollup = await runInTenant(tenant, () => cp.getPropertyByKey(fx.files.id, "totalHours"));
          if (!rollup) throw new Error("Missing rollup property");
          const jobKey = rollupRecomputeJobKey(rollup.id, fx.file.id);
          const beforeJob = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
            [jobKey],
          );
          expect(beforeJob.rows[0]?.count).toBe("1");
          await withTenantTransaction(userPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const jobHeld = barrier();
          const linkHeld = barrier();
          const releaseJob = barrier();
          const releaseLink = barrier();
          let userClient: PoolClient | undefined;
          let systemClient: PoolClient | undefined;
          let userPid: number | undefined;
          let systemPid: number | undefined;
          let systemEnqueueAttempted = false;
          const originalLink = valueLinksStore.lockOnValueLink;
          const linkSpy = vi
            .spyOn(valueLinksStore, "lockOnValueLink")
            .mockImplementation(async (client, id, key, mode) => {
              const result = await originalLink(client, id, key, mode);
              if (client === systemClient && result && mode === "nowait") {
                linkHeld.resolve();
                await bounded(releaseLink.promise);
              }
              return result;
            });
          type Outcome = { ok: true } | { ok: false; error: unknown };
          const run = (kind: "user" | "system"): Promise<Outcome> =>
            runInTenant(tenant, () =>
              withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                await client.query("SET LOCAL statement_timeout = '7s'");
                const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                if (!pid) throw new Error("Missing queue participant PID");
                if (kind === "user") {
                  userClient = client;
                  userPid = pid;
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.alpha.databaseId, itemId: fx.alpha.id, propertiesPatch: { hours: 2 } },
                    { writer: USER },
                  );
                  jobHeld.resolve();
                  await bounded(releaseJob.promise);
                  return deleteRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.beta.id },
                    undefined,
                    USER,
                  );
                }
                systemClient = client;
                systemPid = pid;
                // eslint-disable-next-line @typescript-eslint/unbound-method
                const originalQuery = client.query;
                // eslint-disable-next-line @typescript-eslint/unbound-method
                client.query = new Proxy(client.query, {
                  apply(target, receiver, args: unknown[]) {
                    const params: unknown = args[1];
                    if (
                      typeof args[0] === "string" &&
                      args[0].includes("graphile_worker.add_job") &&
                      Array.isArray(params) &&
                      params[5] === jobKey
                    )
                      systemEnqueueAttempted = true;
                    return Reflect.apply(target, receiver, args);
                  },
                });
                try {
                  return await createRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: gamma.id },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  );
                } finally {
                  client.query = originalQuery;
                }
              }),
            ).then(
              () => ({ ok: true }),
              (error: unknown) => ({ ok: false, error }),
            );
          let user: Promise<Outcome> | undefined;
          let system: Promise<Outcome> | undefined;
          let failure: { error: unknown } | undefined;
          const consumed = new Set<Outcome>();
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          try {
            user = run("user");
            await bounded(jobHeld.promise);
            expect(await graphileJobHeldBy(jobKey, userPid)).toBe(true);
            system = run("system");
            await bounded(linkHeld.promise);
            if (!userPid || !systemPid || !userClient) throw new Error("Missing queue participant PID");
            releaseLink.resolve();
            const systemOutcome = await bounded(system);
            expect(systemEnqueueAttempted).toBe(true);
            expect(systemOutcome).toMatchObject({ ok: false, error: { status: 409, code: "value_link_busy" } });
            consumed.add(systemOutcome);
            releaseJob.resolve();
            const outcomes = await bounded(Promise.all([user, system]));
            console.info("Populated rollup contention refusal", { userPid, systemPid, jobKey, outcomes });
            expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
            expect(outcomes.filter((result) => !result.ok)).toMatchObject([{ error: { code: "value_link_busy" } }]);
            const links = await withTenantTransaction(userPool, tenant, (client) =>
              listValueLinksByItemIds(client, [fx.file.id]),
            );
            const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            const targetIds = edges?.map((edge) => edge.targetItemId) ?? [];
            const alpha = await runInTenant(tenant, () => cp.getItem(fx.alpha.databaseId, fx.alpha.id));
            expect(links[0]).toMatchObject(outcomes[0]?.ok ? { state: "broken", brokenBy: "user" } : { state: "on" });
            expect(alpha?.properties.hours).toBe(outcomes[0]?.ok ? 2 : 1);
            expect(targetIds.includes(fx.beta.id)).toBe(!outcomes[0]?.ok);
            expect(targetIds.includes(gamma.id)).toBe(Boolean(outcomes[1]?.ok));
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.alpha.id)).toHaveLength(
              outcomes[0]?.ok ? 1 : 0,
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
            const afterJob = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
              [jobKey],
            );
            expect(afterJob.rows[0]?.count).toBe("1");
          } catch (error) {
            failure = { error };
          } finally {
            releaseJob.resolve();
            releaseLink.resolve();
            const errors = await settleParticipants(
              user,
              system,
              () => userPid,
              () => systemPid,
              consumed,
            );
            linkSpy.mockRestore();
            setInvalidationHook(() => {});
            if (errors.length) failure = combineFailure(failure, errors, "Rollup diagnostic cleanup failed");
          }
          if (failure !== undefined) throwFailure(failure.error);
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
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            await withTenantTransaction(userPool, tenant, (client) =>
              insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
            );
            const definition = await withTenantTransaction(userPool, tenant, (client) =>
              relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id),
            );
            if (!definition) throw new Error("Missing relation definition");
            const edgeHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseEdge = barrier();
            const releaseLink = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const originalInsert = relationsStore.createItemRelationReportingInsert;
            const originalLink = valueLinksStore.lockOnValueLink;
            const edgeSpy = vi
              .spyOn(relationsStore, "createItemRelationReportingInsert")
              .mockImplementation(async (client, input) => {
                const result = await originalInsert(client, input);
                if (client === userClient) {
                  edgeHeld.resolve();
                  await bounded(releaseEdge.promise);
                }
                return result;
              });
            const linkSpy = vi
              .spyOn(valueLinksStore, "lockOnValueLink")
              .mockImplementation(async (client, id, key, mode) => {
                const result = await originalLink(client, id, key, mode);
                if (client === systemClient && result && mode === "nowait") {
                  linkHeld.resolve();
                  await bounded(releaseLink.promise);
                }
                return result;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const run = (kind: "user" | "system"): Promise<Outcome> =>
              runInTenant(tenant, () =>
                withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  if (!pid) throw new Error("Missing relation participant PID");
                  if (kind === "user") {
                    userClient = client;
                    userPid = pid;
                    userStarted.resolve();
                  } else {
                    systemClient = client;
                    systemPid = pid;
                  }
                  return createRelationWithClient(
                    client,
                    {
                      relationPropertyId: fx.projectsProperty.id,
                      callerItemId: fx.file.id,
                      targetItemId: kind === "user" || sameTarget ? fx.alpha.id : fx.beta.id,
                    },
                    kind === "system" ? VALUE_LINKS : undefined,
                    kind === "user" ? USER : SYSTEM_WRITER,
                  );
                }),
              ).then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: { error: unknown } | undefined;
            const consumed = new Set<Outcome>();
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "system-first") {
                system = run("system");
                await bounded(linkHeld.promise);
                expect(await relationAdvisoryHeldBy(definition.id, systemPid)).toBe(true);
                user = run("user");
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing relation participant PID");
                await waitBlocked(systemPid, userPid);
                releaseLink.resolve();
                releaseEdge.resolve();
              } else {
                user = run("user");
                await bounded(edgeHeld.promise);
                expect(await relationAdvisoryHeldBy(definition.id, userPid)).toBe(true);
                system = run("system");
                const refused = await bounded(system);
                expect(refused).toMatchObject({
                  ok: false,
                  error: { code: "value_link_busy", status: 409 },
                });
                consumed.add(refused);
                releaseEdge.resolve();
              }
              const outcomes = await bounded(Promise.all([user, system]));
              console.info("Relation advisory admission", { order, userPid, systemPid });
              expect(outcomes[0]).toEqual({ ok: true });
              if (order === "system-first") expect(outcomes[1]).toEqual({ ok: true });
              else expect(outcomes[1]).toMatchObject({ ok: false, error: { code: "value_link_busy" } });
              if (outcomes[1]) consumed.add(outcomes[1]);
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fx.file.id]),
              );
              expect(links[0]).toMatchObject(outcomes[0]?.ok ? { state: "broken", brokenBy: "user" } : { state: "on" });
              expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
              const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
              expect(edges).toHaveLength(order === "system-first" ? 2 : 1);
            } catch (error) {
              failure = { error };
            } finally {
              releaseEdge.resolve();
              releaseLink.resolve();
              const errors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
                consumed,
              );
              edgeSpy.mockRestore();
              linkSpy.mockRestore();
              setInvalidationHook(() => {});
              if (errors.length) failure = combineFailure(failure, errors, "Relation diagnostic cleanup failed");
            }
            if (failure !== undefined) throwFailure(failure.error);
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
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const databases = await runInTenant(tenant, () => cp.listDatabases());
            const inbox = databases.find((db) => db.ownerModuleId === "inbox");
            const types = databases.find((db) => db.ownerModuleId === "inboxItemTypes");
            if (!inbox || !types) throw new Error("Missing seeded Inbox databases");
            const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
            if (!property) throw new Error("Missing Inbox type relation");
            const fixture = await withTenantTransaction(userPool, tenant, async (client) => {
              const type = await createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: types.id,
                name: "Task",
                emoji: "T",
                processingMethod: "database",
                targetDatabase: "tasks",
              });
              const other = await createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: types.id,
                name: "Page",
                emoji: "P",
                processingMethod: "pageContent",
              });
              const item = await createInboxItemWithClient(client, {
                inboxDatabaseId: inbox.id,
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
            const priorJobs = await pool.query<{ key: string }>(
              "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
              [jobKeys],
            );
            const sourceHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseSource = barrier();
            const releaseLink = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            let userSourceAttempt = false;
            let systemSourceNowaitAttempt = false;
            const originalSource = inboxSourceGuard.lockInboxSource;
            const originalLink = valueLinksStore.lockOnValueLink;
            const sourceSpy = vi
              .spyOn(inboxSourceGuard, "lockInboxSource")
              .mockImplementation(async (client, id, allowDeleted, mode) => {
                await originalSource(client, id, allowDeleted, mode);
                if (client === userClient) {
                  sourceHeld.resolve();
                  await bounded(releaseSource.promise);
                }
              });
            const linkSpy = vi
              .spyOn(valueLinksStore, "lockOnValueLink")
              .mockImplementation(async (client, id, key, mode) => {
                const found = await originalLink(client, id, key, mode);
                if (client === systemClient && found && mode === "nowait") {
                  linkHeld.resolve();
                  await bounded(releaseLink.promise);
                }
                return found;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const run = (kind: "user" | "system"): Promise<Outcome> =>
              runInTenant(tenant, () =>
                withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  if (!pid) throw new Error("Missing relation participant PID");
                  if (kind === "user") {
                    userClient = client;
                    userPid = pid;
                    userStarted.resolve();
                  } else {
                    systemClient = client;
                    systemPid = pid;
                  }
                  // eslint-disable-next-line @typescript-eslint/unbound-method
                  const originalQuery = client.query;
                  // eslint-disable-next-line @typescript-eslint/unbound-method
                  client.query = new Proxy(client.query, {
                    apply(target, receiver, args: unknown[]) {
                      const sql = typeof args[0] === "string" ? args[0] : "";
                      const params: unknown = args[1];
                      if (
                        sql.includes("FROM items i JOIN databases") &&
                        sql.includes("FOR UPDATE OF i") &&
                        Array.isArray(params) &&
                        params[0] === fixture.item.id
                      ) {
                        if (kind === "user") userSourceAttempt = true;
                        if (kind === "system" && sql.includes("NOWAIT")) systemSourceNowaitAttempt = true;
                      }
                      return Reflect.apply(target, receiver, args);
                    },
                  });
                  try {
                    return await createRelationWithClient(
                      client,
                      {
                        relationPropertyId: property.id,
                        callerItemId: fixture.item.id,
                        targetItemId: kind === "user" ? fixture.type.id : fixture.other.id,
                      },
                      kind === "system" ? VALUE_LINKS : undefined,
                      kind === "user" ? USER : SYSTEM_WRITER,
                    );
                  } finally {
                    client.query = originalQuery;
                  }
                }),
              ).then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: { error: unknown } | undefined;
            const consumed = new Set<Outcome>();
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "system-first") {
                system = run("system");
                await bounded(linkHeld.promise);
                const heldSource = await pool.query<{ held: boolean }>(
                  `SELECT EXISTS (SELECT 1 FROM items i JOIN pg_locks l ON l.transactionid::text = i.xmax::text
                     WHERE i.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted) AS held`,
                  [fixture.item.id, systemPid],
                );
                expect(heldSource.rows[0]?.held).toBe(true);
                user = run("user");
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing relation participant PID");
                await waitBlocked(systemPid, userPid);
                const waiting = await pool.query<{ waiting: boolean }>(
                  `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1
                    AND query LIKE '%FROM items i JOIN databases%FOR UPDATE OF i%'
                    AND $2::int = ANY(pg_blocking_pids(pid))) AS waiting`,
                  [userPid, systemPid],
                );
                expect(waiting.rows[0]?.waiting).toBe(true);
                expect(userSourceAttempt).toBe(true);
                releaseLink.resolve();
                releaseSource.resolve();
              } else {
                user = run("user");
                await bounded(sourceHeld.promise);
                const sourceLock = await pool.query<{ held: boolean }>(
                  `SELECT EXISTS (SELECT 1 FROM items i JOIN pg_locks l ON l.transactionid::text = i.xmax::text
                     WHERE i.id = $1 AND l.pid = $2 AND l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted) AS held`,
                  [fixture.item.id, userPid],
                );
                expect(sourceLock.rows[0]?.held).toBe(true);
                system = run("system");
                const refused = await bounded(system);
                expect(refused).toMatchObject({
                  ok: false,
                  error: { code: "value_link_busy", status: 409 },
                });
                consumed.add(refused);
                expect(systemSourceNowaitAttempt).toBe(true);
                releaseSource.resolve();
              }
              const outcomes = await bounded(Promise.all([user, system]));
              console.info("Inbox relation admission", { order, userPid, systemPid });
              if (order === "system-first") {
                expect(outcomes[0]).toMatchObject({ ok: false, error: { code: "cardinality_violation", status: 409 } });
                expect(outcomes[1]).toEqual({ ok: true });
              } else {
                expect(outcomes[0]).toEqual({ ok: true });
                expect(outcomes[1]).toMatchObject({ ok: false, error: { code: "value_link_busy", status: 409 } });
              }
              for (const outcome of outcomes) if (outcome) consumed.add(outcome);
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fixture.item.id]),
              );
              expect(links).toHaveLength(1);
              expect(links[0]).toMatchObject(
                order === "system-first" ? { state: "on" } : { state: "broken", brokenBy: "user" },
              );
              expect(events.filter((event) => event.scope === "item" && event.itemId === fixture.item.id)).toHaveLength(
                1,
              );
              const edges = await runInTenant(tenant, () => cp.listItemRelations(fixture.item.id, property.id));
              if (!edges) throw new Error("Missing Inbox type relation");
              expect(edges).toHaveLength(1);
              expect(edges[0]).toMatchObject({
                itemA: fixture.item.id,
                itemB: order === "system-first" ? fixture.other.id : fixture.type.id,
              });
              const jobs = await pool.query<{ key: string }>(
                "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
                [jobKeys],
              );
              expect(jobs.rows.map((row) => row.key)).toEqual(
                [
                  ...new Set([
                    ...priorJobs.rows.map((row) => row.key),
                    jobKeys[0],
                    jobKeys[order === "system-first" ? 2 : 1],
                  ]),
                ].sort(),
              );
            } catch (error) {
              failure = { error };
            } finally {
              releaseSource.resolve();
              releaseLink.resolve();
              const errors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
                consumed,
              );
              sourceSpy.mockRestore();
              linkSpy.mockRestore();
              setInvalidationHook(() => {});
              if (errors.length) failure = combineFailure(failure, errors, "Relation diagnostic cleanup failed");
            }
            if (failure !== undefined) throwFailure(failure.error);
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
        await withTenantTransaction(runtime, tenant, async (client) => {
          for (const propertyKey of ["name", "note"]) {
            await insertValueLink(client, { itemId: fx.file.id, propertyKey, ruleKey: "test", sources: [] });
          }
        });
        const handoff = vi.spyOn(valueLinksStore, "lockOnValueLink");
        const prelock = vi.spyOn(itemsStore, "lockItemById");
        try {
          await runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { note: "one", name: "system" } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
          expect(handoff.mock.calls.map((call) => call[2])).toEqual(["name", "note"]);
          expect(prelock).toHaveBeenCalledTimes(1);
          prelock.mockClear();
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "user" } },
              undefined,
              undefined,
              USER,
            ),
          );
          expect(prelock).not.toHaveBeenCalled();
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links.map((entry) => [entry.propertyKey, entry.state])).toEqual([
            ["name", "broken"],
            ["note", "on"],
          ]);
        } finally {
          handoff.mockRestore();
          prelock.mockRestore();
        }
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
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          for (const itemId of [own.file.id, foreign.file.id, "00000000-0000-4000-8000-000000000001"]) {
            await expect(
              runInTenant(tenantA, () =>
                withTransaction(runtime, (client) =>
                  updateItemWithClient(
                    client,
                    { databaseId: own.files.id, itemId, propertiesPatch: { name: "blocked" } },
                    { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                  ),
                ),
              ),
            ).rejects.toMatchObject({ status: 404 });
          }
          expect(spy).not.toHaveBeenCalled();
          expect(events).toEqual([]);
          expect(
            (await runInTenant(tenantB, () => cp.getItem(foreign.files.id, foreign.file.id)))?.properties.name,
          ).toBe("a.pdf");
        } finally {
          spy.mockRestore();
          setInvalidationHook(() => {});
        }
      });
    });

    it("retains version conflicts and normal equal-value update effects", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, {
            itemId: fx.file.id,
            propertyKey: "name",
            ruleKey: "test",
            sources: [],
          }),
        );
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                updateItemWithClient(
                  client,
                  {
                    databaseId: fx.files.id,
                    itemId: fx.file.id,
                    propertiesPatch: { name: "new" },
                    ifVersion: "2000-01-01T00:00:00.000Z",
                  },
                  { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                ),
              ),
            ),
          ).rejects.toMatchObject({ status: 409 });
          expect(events).toEqual([]);
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "a.pdf" } },
              undefined,
              undefined,
              USER,
            ),
          );
          expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
          expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id)))?.properties.name).toBe("a.pdf");
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it.each([
      ["plain", "user-first", "normal"],
      ["plain", "system-first", "normal"],
      ["transformed", "user-first", "normal"],
      ["transformed", "system-first", "normal"],
      ["plain", "system-rollback", "normal"],
      ["plain", "system-first", "late-undefined"],
      ["plain", "system-first", "late-object"],
    ] as const)(
      "serializes %s item and handoff writes with %s (%s)",
      async (kind, order, control) => {
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
            await withTenantTransaction(userPool, tenant, async (client) => {
              for (const propertyKey of kind === "transformed" ? ["date", "timeFrom", "timeTo"] : ["name"]) {
                await insertValueLink(client, { itemId: fx.file.id, propertyKey, ruleKey: "test", sources: [] });
              }
            });
            const userHeld = barrier();
            const systemHeld = barrier();
            const releaseUser = barrier();
            const releaseSystem = barrier();
            const userStarted = barrier();
            const systemStarted = barrier();
            const bodyError = new Error("forced observation failure");
            const rollbackError = new Error("forced rollback");
            const secondary = { marker: "late participant" };
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const realUpdate = itemsStore.updateItemProperties;
            const realLock = itemsStore.lockItemById;
            const updateSpy = vi.spyOn(itemsStore, "updateItemProperties").mockImplementation(async (client, input) => {
              const result = await realUpdate(client, input);
              if (client === userClient) {
                userHeld.resolve();
                await bounded(releaseUser.promise);
              }
              return result;
            });
            const lockSpy = vi
              .spyOn(itemsStore, "lockItemById")
              .mockImplementation(async (client, databaseId, itemId) => {
                const found = await realLock(client, databaseId, itemId);
                if (client === systemClient && found) {
                  systemHeld.resolve();
                  await bounded(releaseSystem.promise);
                }
                return found;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const settled = (promise: Promise<unknown>): Promise<Outcome> =>
              promise.then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            const run = (actor: "user" | "system") =>
              settled(
                runInTenant(tenant, () =>
                  withTransaction(actor === "user" ? userPool : systemPool, async (client) => {
                    await client.query("SET LOCAL statement_timeout = '7s'");
                    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                    if (!pid) throw new Error("Missing operation PID");
                    if (actor === "user") {
                      userClient = client;
                      userPid = pid;
                      userStarted.resolve();
                    } else {
                      systemClient = client;
                      systemPid = pid;
                      systemStarted.resolve();
                    }
                    const result = await updateItemWithClient(
                      client,
                      {
                        databaseId: fx.files.id,
                        itemId: fx.file.id,
                        propertiesPatch:
                          kind === "transformed" ? { date: actor === "user" ? "2026-10-14" : null } : { name: actor },
                      },
                      actor === "user"
                        ? { writer: USER }
                        : { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                    );
                    if (actor === "system" && control === "late-undefined") throwFailure(undefined);
                    if (actor === "system" && control === "late-object") throwFailure(secondary);
                    if (actor === "system" && order === "system-rollback") throw rollbackError;
                    return result;
                  }),
                ),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: { error: unknown } | undefined;
            const consumed = new Set<Outcome>();
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "user-first") {
                user = userOperations.run(() => run("user"));
                await bounded(userHeld.promise);
                system = systemOperations.run(() => run("system"));
                await bounded(systemStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                await waitBlocked(userPid, systemPid);
                console.info("Observed item handoff wait", {
                  kind,
                  order,
                  holderPid: userPid,
                  competitorPid: systemPid,
                });
                releaseUser.resolve();
                releaseSystem.resolve();
              } else {
                system = systemOperations.run(() => run("system"));
                await bounded(systemHeld.promise);
                await bounded(
                  userOperations.run(() =>
                    runInTenant(tenant, () =>
                      cp.updateItem(
                        { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "progress" } },
                        undefined,
                        undefined,
                        USER,
                      ),
                    ),
                  ),
                );
                await bounded(
                  userOperations.run(() =>
                    runInTenant(otherTenant, () =>
                      cp.updateItem(
                        {
                          databaseId: foreign.files.id,
                          itemId: foreign.file.id,
                          propertiesPatch: { name: "progress" },
                        },
                        undefined,
                        undefined,
                        USER,
                      ),
                    ),
                  ),
                );
                user = userOperations.run(() => run("user"));
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                await waitBlocked(systemPid, userPid);
                if (control !== "normal") throw bodyError;
                console.info("Observed item handoff wait", {
                  kind,
                  order,
                  holderPid: systemPid,
                  competitorPid: userPid,
                });
                releaseSystem.resolve();
                releaseUser.resolve();
              }
              const results = await bounded(Promise.all([user, system]));
              expect(results[0]).toEqual({ ok: true });
              if (order === "user-first") {
                expect(results[1]).toMatchObject({ ok: false, error: { status: 403, code: "owner_violation" } });
              } else if (order === "system-rollback") {
                expect(results[1]?.ok).toBe(false);
                if (!results[1] || results[1].ok) throw new Error("Expected rollback");
                expect(results[1].error).toBe(rollbackError);
              } else {
                expect(results[1]).toEqual({ ok: true });
              }
              if (results[1]) consumed.add(results[1]);
              expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(
                order === "system-first" ? 2 : 1,
              );
              const current = await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id));
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fx.file.id]),
              );
              if (kind === "transformed") {
                expect(current?.properties.date).toBe("2026-10-14");
                expect(links.find((link) => link.propertyKey === "date")).toMatchObject({
                  state: "broken",
                  brokenBy: "user",
                });
                expect(links.filter((link) => link.propertyKey !== "date").map((link) => link.state)).toEqual([
                  "on",
                  "on",
                ]);
                expect(current?.properties.timeFrom).toBe(order === "system-first" ? null : "10:00");
                expect(current?.properties.timeTo).toBe(order === "system-first" ? null : "11:00");
              } else {
                expect(current?.properties.name).toBe("user");
                expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
              }
            } catch (error) {
              failure = { error };
            } finally {
              releaseUser.resolve();
              releaseSystem.resolve();
              await userOperations.settle();
              await systemOperations.settle();
              const cleanupErrors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
                consumed,
              );
              updateSpy.mockRestore();
              lockSpy.mockRestore();
              setInvalidationHook(() => {});
              if (cleanupErrors.length) {
                failure = combineFailure(failure, cleanupErrors, "Diagnostic and cleanup failed");
              }
            }
            if (control !== "normal") {
              const error = failure?.error;
              expect(error).toBeInstanceOf(AggregateError);
              if (!(error instanceof AggregateError)) throw new Error("Expected combined failure");
              expect(error.errors).toHaveLength(2);
              expect(error.errors[0]).toBe(bodyError);
              expect(error.errors[1]).toBe(control === "late-undefined" ? undefined : secondary);
              expect(error.cause).toBe(bodyError);
              return;
            }
            if (failure !== undefined) throwFailure(failure.error);
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
        const write = (value: string) =>
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: value } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
        const readItem = () => runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id));
        const events: InvalidationEvent[] = [];
        const expectRefusedWithoutEffects = async (value: string) => {
          const beforeItem = await readItem();
          const beforeStoredItem = await readStoredItem(runtime, tenant, fx.files.id, fx.file.id);
          const beforeLinks = await readStoredLinks(runtime, tenant, fx.file.id);
          events.length = 0;
          await expect(write(value)).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          expect(await readItem()).toEqual(beforeItem);
          expect(await readStoredItem(runtime, tenant, fx.files.id, fx.file.id)).toEqual(beforeStoredItem);
          expect(await readStoredLinks(runtime, tenant, fx.file.id)).toEqual(beforeLinks);
          expect(events).toEqual([]);
        };
        setInvalidationHook((event) => events.push(event));
        try {
          await expectRefusedWithoutEffects("blocked");
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, {
              itemId: fx.file.id,
              propertyKey: "name",
              ruleKey: "test",
              sources: [],
            }),
          );
          await expect(write("system")).resolves.toMatchObject({ properties: { name: "system" } });
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "system" } },
              undefined,
              undefined,
              USER,
            ),
          );
          const read = () =>
            withTenantTransaction(runtime, tenant, (client) => listValueLinksByItemIds(client, [fx.file.id]));
          expect((await read())[0]).toMatchObject({ state: "on" });
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "user" } },
              undefined,
              undefined,
              USER,
            ),
          );
          expect((await read())[0]).toMatchObject({ state: "broken", brokenBy: "user" });
          await expectRefusedWithoutEffects("blocked again");
          expect((await readItem())?.properties.name).toBe("user");
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it("isolates same-item and key handoffs and breaks across runtime tenants", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenantA, () => setup(cp));
        await runInTenant(tenantA, () =>
          cp.createProperty({ databaseId: fx.files.id, key: "note", name: "Note", type: "text" }),
        );
        await withTenantTransaction(runtime, tenantA, (client) =>
          insertValueLink(client, { itemId: fx.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );
        await withTenantTransaction(runtime, tenantB, async (client) => {
          for (const propertyKey of ["name", "note", "projects"]) {
            await insertValueLink(client, { itemId: fx.file.id, propertyKey, ruleKey: "foreign", sources: [] });
          }
        });
        const foreignBefore = await readStoredLinks(runtime, tenantB, fx.file.id);
        expect(foreignBefore).toHaveLength(3);
        await runInTenant(tenantA, () =>
          cp.updateItem(
            { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "changed" } },
            undefined,
            undefined,
            USER,
          ),
        );
        expect((await readStoredLinks(runtime, tenantA, fx.file.id))[0]).toMatchObject({
          property_key: "name",
          state: "broken",
          broken_by: "user",
        });
        expect(await readStoredLinks(runtime, tenantB, fx.file.id)).toEqual(foreignBefore);
        const itemBefore = await readStoredItem(runtime, tenantA, fx.files.id, fx.file.id);
        const linksBefore = await readStoredLinks(runtime, tenantA, fx.file.id);
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(
            runInTenant(tenantA, () =>
              withTransaction(runtime, (client) =>
                updateItemWithClient(
                  client,
                  {
                    databaseId: fx.files.id,
                    itemId: fx.file.id,
                    propertiesPatch: { note: "foreign cannot authorize" },
                  },
                  { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                ),
              ),
            ),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          await expect(
            runInTenant(tenantA, () =>
              withTransaction(runtime, (client) =>
                createRelationWithClient(
                  client,
                  { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                ),
              ),
            ),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
          expect(await readStoredItem(runtime, tenantA, fx.files.id, fx.file.id)).toEqual(itemBefore);
          expect(await readStoredLinks(runtime, tenantA, fx.file.id)).toEqual(linksBefore);
          expect(await readStoredLinks(runtime, tenantB, fx.file.id)).toEqual(foreignBefore);
          expect(await runInTenant(tenantA, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual(
            [],
          );
          expect(events).toEqual([]);
          await withTenantTransaction(runtime, tenantA, async (client) => {
            for (const propertyKey of ["note", "projects"]) {
              await insertValueLink(client, { itemId: fx.file.id, propertyKey, ruleKey: "own", sources: [] });
            }
          });
          await runInTenant(tenantA, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { note: "authorized" } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
          await runInTenant(tenantA, () =>
            withTransaction(runtime, (client) =>
              createRelationWithClient(
                client,
                { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          );
          const own = await readStoredLinks(runtime, tenantA, fx.file.id);
          expect(own.filter((link) => link.property_key !== "name").map((link) => link.state)).toEqual(["on", "on"]);
          expect(await readStoredLinks(runtime, tenantB, fx.file.id)).toEqual(foreignBefore);
        } finally {
          setInvalidationHook(() => {});
        }
      });
    }, 30000);

    it("never touches the links of another tenant", async () => {
      await resetDatabase(pool);
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const cp = createChokePoint(runtimePool);
        const a = await runInTenant(tenantA, () => setup(cp));
        const b = await runInTenant(tenantB, () => setup(cp));
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          insertValueLink(client, { itemId: a.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );
        await withTenantTransaction(runtimePool, tenantB, (client) =>
          insertValueLink(client, { itemId: b.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );

        await runInTenant(tenantB, () =>
          cp.updateItem(
            { databaseId: b.files.id, itemId: b.file.id, propertiesPatch: { name: "changed" } },
            undefined,
            undefined,
            USER,
          ),
        );

        const states = async (tenantId: string, itemId: string) =>
          withTenantTransaction(runtimePool, tenantId, (client) => listValueLinksByItemIds(client, [itemId]));
        expect((await states(tenantA, a.file.id))[0]).toMatchObject({ state: "on" });
        expect((await states(tenantB, b.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
      } finally {
        await runtimePool.end();
      }
    });
  });
});
