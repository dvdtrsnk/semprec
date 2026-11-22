import { Client, DatabaseError, Pool, type ClientConfig, type PoolClient } from "pg";
import {
  enforceTenantScope,
  runDetachedAsSystem,
  type TenantScope,
  type TransactionIsolationLevel,
} from "@semprec/shared";
import {
  addPreparedJob,
  assertSearchTaskIdentifiersRegistered,
  SEARCH_TASK_IDENTIFIERS,
  type PreparedJob,
} from "@semprec/queue";
import { logger } from "./logger.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type Queryable = Pool | PoolClient;

interface TransactionOwner {
  client: PoolClient;
  active: boolean;
  failure?: { error: unknown };
  keyedCallbacks: Map<symbol, Map<string, { callback: () => void }>>;
  /** `null` for a system or unscoped invocation. */
  tenantId: string | null;
  /** Search-lane enqueues registered while the body ran, in registration order. */
  searchJobs: PreparedJob[];
  /** `runBeforeCommitOnce` flushes, one per key, in registration order. */
  preCommitFlushes: Map<symbol, (client: PoolClient) => Promise<void>>;
}

/** Two-key advisory lock classes of the search flush. Others: 2331 (`seedSystem.ts`), 2334 (`auth/sessionDeviceLock.ts`). */
export const SEARCH_FLUSH_TENANT_LOCK_CLASS = 2332;
export const SEARCH_FLUSH_SYSTEM_LOCK_CLASS = 2333;

const SEARCH_IDENTIFIERS: ReadonlySet<string> = new Set<string>(SEARCH_TASK_IDENTIFIERS);

const transactionOwner = new AsyncLocalStorage<TransactionOwner>();

export function requireManagedTransaction(client: PoolClient): void {
  const owner = transactionOwner.getStore();
  if (!owner?.active || owner.client !== client)
    throw new Error("Protected relation requires an active managed transaction");
}

/** The rollback-only state belongs to the invocation, not to a PostgreSQL savepoint. */
export function markManagedTransactionRollbackOnly(client: PoolClient, error: unknown): void {
  requireManagedTransaction(client);
  const owner = transactionOwner.getStore();
  if (!owner) throw new Error("Protected relation requires an active managed transaction");
  owner.failure ??= { error };
}

/**
 * One module's state for the active `withTransaction` invocation of a client: created by `init` on first use and
 * keyed on the invocation, so it is unreachable once the invocation ends and nothing in it reaches another
 * transaction (a retry included). A savepoint rollback does not reset it, so it may only hold facts that stay safe to
 * act on after one.
 */
export class TransactionLocal<T> {
  private readonly values = new WeakMap<TransactionOwner, T>();

  constructor(private readonly init: () => T) {}

  /** `undefined` when `client` is not the client of the active invocation. */
  get(client: Queryable): T | undefined {
    const owner = transactionOwner.getStore();
    if (!owner?.active || owner.client !== client) return undefined;
    const existing = this.values.get(owner);
    if (existing !== undefined) return existing;
    const created = this.init();
    this.values.set(owner, created);
    return created;
  }
}

export function assertManagedTransactionCommittable(client: PoolClient): void {
  requireManagedTransaction(client);
  const owner = transactionOwner.getStore();
  if (owner?.failure) throw owner.failure.error;
}

export const CONNECTION_TIMEOUT_MS = 10_000;

export const STATEMENT_TIMEOUT_MS = 60_000;

export interface CreatePoolOptions {
  /** Per-connection `statement_timeout`; `0` disables it (the migrations CLI). */
  statementTimeoutMs?: number;
  /** `-c role=...`, so a CLI logged in as the table owner still works under row-level security. */
  role?: "semprec_data";
  /** Most connections the pool opens; pg's default (10) otherwise. */
  max?: number;
}

/**
 * Socket callbacks (LISTEN `notification`, `error`) run in the async context that opened the connection, so
 * it is opened in a detached system scope instead of the first request's tenant.
 */
class DetachedScopeClient extends Client {
  constructor(config?: ClientConfig) {
    super(config);
    const connect = this.connect.bind(this) as (...args: unknown[]) => unknown;
    this.connect = ((...args: unknown[]) =>
      runDetachedAsSystem("database-connection", () => connect(...args))) as Client["connect"];
  }
}

/** `''` (reads as NULL) for a system scope. */
function scopeGucValue(scope: TenantScope): string {
  return scope.kind === "tenant" ? scope.tenantId : "";
}

const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, $2)";

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function releaseTransactionClient(
  client: PoolClient,
  releaseError: Error | undefined,
  hasPrimaryFailure: boolean,
): void {
  try {
    client.release(releaseError);
  } catch (error) {
    if (!hasPrimaryFailure) throw error;
    logger.error(
      { errorCategory: error instanceof Error ? "error" : "non_error" },
      "withTransaction: release failed while handling a transaction error",
    );
  }
}

/** Raw `connect` of a `createPool` pool, bypassing the session-level tenant hook. */
const rawConnectors = new WeakMap<Pool, () => Promise<PoolClient>>();

function connectWithoutScopeHook(pool: Pool): Promise<PoolClient> {
  return rawConnectors.get(pool)?.() ?? pool.connect();
}

/**
 * Applies the active tenant scope (`app.tenant_id`): `connect()` sets it for the session and resets it on
 * `release()`; a scoped `query()` runs as a one-statement transaction with a local GUC.
 */
export function createPool(connectionString: string, options: CreatePoolOptions = {}): Pool {
  const statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    Client: DetachedScopeClient,
    // Fixed UTC so a `timestamptz` cast of an offset-less string never depends on the server zone.
    options: options.role ? `-c TimeZone=UTC -c role=${options.role}` : "-c TimeZone=UTC",
    ...(statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  // pg emits 'error' when the server drops an idle client; without a listener that would become an
  // uncaughtException and exit the process. pg has already discarded the client.
  pool.on("error", (err) => {
    logger.error({ err }, "Idle pool client errored; the client was discarded");
  });
  installTenantScope(pool);
  return pool;
}

function installTenantScope(pool: Pool): void {
  type ConnectCallback = (
    err: Error | undefined,
    client?: PoolClient,
    done?: (release?: Error | boolean) => void,
  ) => void;
  const proto = Pool.prototype as unknown as {
    connect: (this: Pool, cb?: ConnectCallback) => Promise<PoolClient> | void;
    query: (this: Pool, ...args: unknown[]) => unknown;
  };
  const protoConnect = proto.connect;
  const protoQuery = proto.query;
  const rawConnect = (cb?: ConnectCallback): Promise<PoolClient> | void => protoConnect.call(pool, cb);
  rawConnectors.set(pool, () => protoConnect.call(pool) as Promise<PoolClient>);

  // pg-pool's `query` acquires through the overridden `this.connect`; this flag stops that inner call
  // from enforcing the scope a second time.
  let skipNextConnectEnforcement = false;

  async function checkoutWithSession(scope: TenantScope): Promise<PoolClient> {
    const client = (await rawConnect()) as PoolClient;
    try {
      await client.query(SET_TENANT_SQL, [scopeGucValue(scope), false]);
    } catch (err) {
      client.release(toError(err));
      throw err;
    }
    const poolRelease = (client as { release: (err?: Error | boolean) => void }).release;
    let released = false;
    // The GUC is reset before the connection goes back to the pool, so it never carries this tenant.
    client.release = (err?: Error | boolean): void => {
      if (released) return;
      released = true;
      if (err) {
        poolRelease(err);
        return;
      }
      client.query("RESET app.tenant_id").then(
        () => poolRelease(),
        (resetErr: unknown) => {
          logger.error({ err: resetErr }, "Resetting app.tenant_id failed; the connection was discarded");
          poolRelease(toError(resetErr));
        },
      );
    };
    return client;
  }

  async function scopedQuery(scope: TenantScope, args: unknown[]): Promise<unknown> {
    const client = await connectWithoutScopeHook(pool);
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(SET_TENANT_SQL, [scopeGucValue(scope), true]);
      const result = await (client.query as (...a: unknown[]) => Promise<unknown>).apply(client, args);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        releaseError = toError(rollbackErr);
        logger.error({ err: rollbackErr }, "Scoped pool.query: ROLLBACK failed; discarding the connection");
      }
      throw err;
    } finally {
      client.release(releaseError);
    }
  }

  (pool as unknown as { connect: unknown }).connect = (cb?: ConnectCallback): Promise<PoolClient> | void => {
    if (skipNextConnectEnforcement) {
      skipNextConnectEnforcement = false;
      return rawConnect(cb);
    }
    let scope: TenantScope | undefined;
    try {
      scope = enforceTenantScope("pool.connect");
    } catch (err) {
      return cb ? cb(toError(err)) : Promise.reject(toError(err));
    }
    if (!scope) return rawConnect(cb);
    const checkout = checkoutWithSession(scope);
    if (!cb) return checkout;
    checkout.then(
      (client) => cb(undefined, client, (err) => client.release(err)),
      (err: unknown) => cb(toError(err), undefined, () => {}),
    );
  };

  (pool as unknown as { query: unknown }).query = (...args: unknown[]): unknown => {
    const isCallbackForm = args.some((arg) => typeof arg === "function");
    if (isCallbackForm) {
      // Callback forms are scoped per session through `connect` above, not per statement.
      return protoQuery.apply(pool, args);
    }
    let scope: TenantScope | undefined;
    try {
      scope = enforceTenantScope("pool.query");
    } catch (err) {
      return Promise.reject(toError(err));
    }
    if (!scope) {
      skipNextConnectEnforcement = true;
      try {
        return protoQuery.apply(pool, args);
      } finally {
        skipNextConnectEnforcement = false;
      }
    }
    return scopedQuery(scope, args);
  };
}

const afterCommitCallbacks = new WeakMap<PoolClient, Array<() => void>>();

/** Runs only after the enclosing `withTransaction` commits, never on rollback. */
export function runAfterCommit(client: PoolClient, callback: () => void): void {
  const existing = afterCommitCallbacks.get(client);
  if (existing) {
    existing.push(callback);
  } else {
    afterCommitCallbacks.set(client, [callback]);
  }
}

export function runAfterCommitKeyed(client: PoolClient, namespace: symbol, key: string, callback: () => void): void {
  requireManagedTransaction(client);
  const owner = transactionOwner.getStore();
  if (!owner) throw new Error("Protected relation requires an active managed transaction");
  let keyed = owner.keyedCallbacks.get(namespace);
  if (!keyed) {
    keyed = new Map();
    owner.keyedCallbacks.set(namespace, keyed);
  }
  const slot = keyed.get(key);
  if (slot) {
    slot.callback = callback;
  } else {
    const next = { callback };
    keyed.set(key, next);
    runAfterCommit(client, () => next.callback());
  }
}

/**
 * Added at the pre-commit flush. Refused before registering: a client not owned by the active transaction,
 * an unknown task, another tenant's job, or a key already used by another task.
 */
export function registerSearchJob(client: PoolClient, job: PreparedJob): void {
  const owner = transactionOwner.getStore();
  if (!owner?.active || owner.client !== client)
    throw new Error("A search-lane enqueue requires the active managed transaction of its client");
  if (!SEARCH_IDENTIFIERS.has(job.identifier))
    throw new Error(`Only an item-search task can be registered for the pre-commit flush: ${job.identifier}`);
  if (job.tenantId !== owner.tenantId)
    throw new Error("A search-lane enqueue must carry the tenant its transaction was opened in");
  if (owner.searchJobs.some((other) => other.jobKey === job.jobKey && other.identifier !== job.identifier))
    throw new Error(`Search-lane job key ${job.jobKey} is already registered for another task`);
  owner.searchJobs.push(job);
}

/**
 * Runs `flush` once in the active managed transaction of `client`, after the search-lane flush and right before
 * `COMMIT`; a later registration under the same `key` is ignored. Registration closes when the body returns, so a
 * flush cannot register another, and a savepoint rollback does not withdraw one. A flush that throws rolls the whole
 * transaction back. Each flush takes its locks last in the transaction, after every lock the body took.
 */
export function runBeforeCommitOnce(
  client: PoolClient,
  key: symbol,
  flush: (client: PoolClient) => Promise<void>,
): void {
  const owner = transactionOwner.getStore();
  if (!owner?.active || owner.client !== client)
    throw new Error("A pre-commit flush requires the active managed transaction of its client");
  if (!owner.preCommitFlushes.has(key)) owner.preCommitFlushes.set(key, flush);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Takes the tenant lock, then adds jobs in (identifier, key) order, each group in registration order. */
async function flushSearchJobs(client: PoolClient, owner: TransactionOwner): Promise<void> {
  const jobs = owner.searchJobs.splice(0);
  if (jobs.length === 0) return;
  await assertSearchTaskIdentifiersRegistered(client);
  if (owner.tenantId === null)
    await client.query("SELECT pg_advisory_xact_lock($1::int4, 0)", [SEARCH_FLUSH_SYSTEM_LOCK_CLASS]);
  else
    await client.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))", [
      SEARCH_FLUSH_TENANT_LOCK_CLASS,
      owner.tenantId,
    ]);
  // `registerSearchJob` keeps one identifier per key, so a group's identifier is that of every call in it.
  const groups = new Map<string, { identifier: string; jobKey: string; calls: PreparedJob[] }>();
  for (const job of jobs) {
    const group = groups.get(job.jobKey);
    if (group) group.calls.push(job);
    else groups.set(job.jobKey, { identifier: job.identifier, jobKey: job.jobKey, calls: [job] });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => compareCodeUnits(a.identifier, b.identifier) || compareCodeUnits(a.jobKey, b.jobKey),
  );
  for (const group of ordered) for (const job of group.calls) await addPreparedJob(client, job);
}

export interface WithTransactionOptions {
  /** Defaults to READ COMMITTED. */
  isolation?: TransactionIsolationLevel;
}

/** Attempts of one READ COMMITTED transaction inside `retryingTransientConflicts`, the first included. */
export const TRANSIENT_CONFLICT_ATTEMPTS = 3;

/** `true` inside `retryingTransientConflicts`; `false` inside a transaction body it is retrying. */
const transientConflictRetry = new AsyncLocalStorage<boolean>();

/** A serialization failure (`40001`) or a detected deadlock (`40P01`): the same work in a fresh transaction may pass. */
export function isTransientConflict(err: unknown): err is DatabaseError {
  return err instanceof DatabaseError && (err.code === "40001" || err.code === "40P01");
}

/**
 * Inside `fn`, a READ COMMITTED `withTransaction` that fails with a transient conflict is rolled back and its body
 * run again in a fresh transaction, up to `TRANSIENT_CONFLICT_ATTEMPTS` attempts; after the last one the conflict
 * propagates. A transaction opened inside a body that is being retried is not retried on its own, so the outer
 * transaction is retried as a whole. Explicit isolation levels are never retried: their callers handle conflicts.
 */
export function retryingTransientConflicts<T>(fn: () => Promise<T>): Promise<T> {
  return transientConflictRetry.run(true, fn);
}

/**
 * The only sanctioned way to open a transaction: `runAfterCommit` callbacks are keyed on the client and only
 * this fires or discards them. Sets `app.tenant_id` locally after `BEGIN` and flushes search jobs before
 * `COMMIT`. The original error propagates even if `ROLLBACK` fails; such a client is destroyed, not pooled.
 * Retries transient conflicts only inside `retryingTransientConflicts`.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  if (options.isolation !== undefined || transientConflictRetry.getStore() !== true) {
    return runTransaction(pool, fn, options);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await transientConflictRetry.run(false, () => runTransaction(pool, fn, options));
    } catch (err) {
      if (!isTransientConflict(err) || attempt >= TRANSIENT_CONFLICT_ATTEMPTS) throw err;
      logger.warn({ sqlState: err.code, attempt }, "withTransaction: retrying after a transient conflict");
    }
  }
}

async function runTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: WithTransactionOptions,
): Promise<T> {
  const scope = enforceTenantScope("withTransaction");
  const client = await connectWithoutScopeHook(pool);
  let releaseError: Error | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    if (options.isolation === "serializable") {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    } else if (options.isolation === "repeatable_read") {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    } else {
      await client.query("BEGIN");
    }
    let owner: TransactionOwner | undefined;
    try {
      if (scope) await client.query(SET_TENANT_SQL, [scopeGucValue(scope), true]);
      owner = {
        client,
        active: true,
        keyedCallbacks: new Map(),
        tenantId: scope?.kind === "tenant" ? scope.tenantId : null,
        searchJobs: [],
        preCommitFlushes: new Map(),
      };
      let result: T;
      try {
        result = await transactionOwner.run(owner, () => fn(client));
        if (owner.failure) throw owner.failure.error;
      } finally {
        // Closes registration before the flush: nothing can register or mark the owner from here on.
        owner.active = false;
      }
      await flushSearchJobs(client, owner);
      for (const flush of owner.preCommitFlushes.values()) await flush(client);
      await client.query("COMMIT");
      const callbacks = afterCommitCallbacks.get(client);
      afterCommitCallbacks.delete(client);
      if (callbacks) {
        // Already committed: a throwing callback must not surface as a failure of this call, nor skip the rest.
        for (const callback of callbacks) {
          try {
            callback();
          } catch (err) {
            logger.error({ err }, "withTransaction: an afterCommit callback threw");
          }
        }
      }
      return result;
    } catch (err) {
      afterCommitCallbacks.delete(client);
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        releaseError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        logger.error({ err: rollbackErr }, "withTransaction: ROLLBACK failed; discarding the connection");
      }
      throw err;
    } finally {
      owner?.keyedCallbacks.clear();
      owner?.searchJobs.splice(0);
      owner?.preCommitFlushes.clear();
    }
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    releaseTransactionClient(client, releaseError, primaryFailure !== undefined);
  }
}

/** Queue lengths and keyed-slot callbacks at savepoint start, restored if its body fails. */
interface SavepointMark {
  callbackCount: number;
  searchJobCount: number;
  keyedSlots: Map<{ callback: () => void }, () => void>;
}

function markSavepoint(client: PoolClient, owner: TransactionOwner): SavepointMark {
  const keyedSlots = new Map<{ callback: () => void }, () => void>();
  for (const keyed of owner.keyedCallbacks.values()) {
    for (const slot of keyed.values()) keyedSlots.set(slot, slot.callback);
  }
  return {
    callbackCount: afterCommitCallbacks.get(client)?.length ?? 0,
    searchJobCount: owner.searchJobs.length,
    keyedSlots,
  };
}

/** Drops what was queued since `mark`; a pre-existing keyed slot gets its earlier callback back. */
function discardSinceSavepoint(client: PoolClient, owner: TransactionOwner, mark: SavepointMark): void {
  afterCommitCallbacks.get(client)?.splice(mark.callbackCount);
  owner.searchJobs.splice(mark.searchJobCount);
  for (const keyed of owner.keyedCallbacks.values()) {
    for (const [key, slot] of keyed) {
      const earlier = mark.keyedSlots.get(slot);
      if (earlier === undefined) keyed.delete(key);
      else slot.callback = earlier;
    }
  }
}

/** Never repeats, so a nested savepoint cannot shadow its parent. */
let savepointSequence = 0;

/**
 * One savepoint step of the active managed transaction. If `fn` throws, its writes and after-commit queue
 * are discarded and the error is rethrown unchanged. A rollback-only mark survives the savepoint; a failed
 * rollback-to-savepoint marks the transaction rollback-only.
 */
export async function withSavepoint<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  const owner = transactionOwner.getStore();
  if (!owner?.active || owner.client !== client)
    throw new Error("A savepoint requires the active managed transaction of its client");
  // Counter-built name, never from input.
  const name = `semprec_savepoint_${++savepointSequence}`;
  const mark = markSavepoint(client, owner);
  await client.query(`SAVEPOINT ${name}`);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    discardSinceSavepoint(client, owner, mark);
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch (cleanupError) {
      markManagedTransactionRollbackOnly(client, error);
      logger.error(
        { errorCategory: cleanupError instanceof Error ? "error" : "non_error" },
        "withSavepoint: going back to the savepoint failed; the transaction can no longer commit",
      );
    }
    throw error;
  }
  await client.query(`RELEASE SAVEPOINT ${name}`);
  return result;
}

/** For a query that returns exactly one row by construction; throws instead of passing `undefined` on. */
export function requireSingleRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one row from ${context}, got none`);
  }
  return row;
}

/** For a write expected to hit a row: `0` or `null` means it did not happen and throws. */
export function requireAffectedRows(result: { rowCount: number | null }, context: string): number {
  const { rowCount } = result;
  if (rowCount === null || rowCount === 0) {
    throw new Error(`Expected ${context} to affect at least one row, got ${rowCount ?? "null"}`);
  }
  return rowCount;
}

/** Released in `finally`. Not for a client that must outlive `fn`, such as a long-held `LISTEN`. */
export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
