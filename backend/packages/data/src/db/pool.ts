import { Client, Pool, type ClientConfig, type PoolClient } from "pg";
import {
  enforceTenantScope,
  runDetachedAsSystem,
  type TenantScope,
  type TransactionIsolationLevel,
} from "@semprec/shared";
import { logger } from "./logger.js";

/** Anything a query can run against: a pool, or a client already inside a transaction. */
export type Queryable = Pool | PoolClient;

/** How long `pool.connect()` waits for a connection before rejecting. */
export const CONNECTION_TIMEOUT_MS = 10_000;

/** Default per-connection `statement_timeout`, in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 60_000;

export interface CreatePoolOptions {
  /** Per-connection `statement_timeout`; defaults to STATEMENT_TIMEOUT_MS; `0` disables it (the migrations CLI, whose contract-step cutovers may run longer). */
  statementTimeoutMs?: number;
  /**
   * Makes every connection of the pool run as this role (pg startup option `-c role=...`), so a CLI
   * connected as the migrating role can do tenant work under row-level security, which applies to
   * the role but not to the table owner it logged in as.
   */
  role?: "semprec_data";
}

/**
 * Opens every physical connection in a detached system scope. A socket's event callbacks (a LISTEN
 * `notification`, an `error`) run in the async context that opened it, so a connection first opened
 * inside one request's tenant would otherwise deliver events in that tenant for the rest of its life.
 */
class DetachedScopeClient extends Client {
  constructor(config?: ClientConfig) {
    super(config);
    const connect = this.connect.bind(this) as (...args: unknown[]) => unknown;
    this.connect = ((...args: unknown[]) =>
      runDetachedAsSystem("database-connection", () => connect(...args))) as Client["connect"];
  }
}

/** Value of the `app.tenant_id` GUC for a scope: the tenant id, or `''` (reads as NULL) for system. */
function scopeGucValue(scope: TenantScope): string {
  return scope.kind === "tenant" ? scope.tenantId : "";
}

const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, $2)";

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Acquires a client from a `createPool` pool without the session-level tenant hook; plain pools connect normally. */
const rawConnectors = new WeakMap<Pool, () => Promise<PoolClient>>();

function connectWithoutScopeHook(pool: Pool): Promise<PoolClient> {
  return rawConnectors.get(pool)?.() ?? pool.connect();
}

/**
 * Returns a pool that applies the active tenant scope (`app.tenant_id`) to every checkout, see
 * `docs/adr/2026-10-05-tenant-scope-propagation.md`:
 * - `connect()` sets the GUC for the session and resets it on `release()`;
 * - a scoped `query()` runs as a one-statement transaction with a transaction-local GUC;
 * - connections are opened detached from the caller's scope.
 */
export function createPool(connectionString: string, options: CreatePoolOptions = {}): Pool {
  const statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    Client: DetachedScopeClient,
    ...(options.role ? { options: `-c role=${options.role}` } : {}),
    ...(statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
  });
  // pg's Pool emits 'error' when an idle client is dropped by the server (restart,
  // container recreate, idle_session_timeout, a network reset). An EventEmitter 'error'
  // with no listener throws, which installFatalHandlers turns into an uncaughtException
  // that exits the process. pg has already discarded the failed client from the pool by
  // the time this fires, so nothing else needs to happen here.
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

  // pg-pool's own `query` acquires through `this.connect`, which is overridden below. A
  // pass-through query sets this for the synchronous `this.connect` call it makes, so that call
  // does not enforce a second time.
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
    // The caller's `release()` returns immediately and never throws; the GUC is reset first so a
    // connection never returns to the pool carrying this checkout's tenant.
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
      // Callback forms are not scoped per statement; their checkout goes through `connect` above,
      // which enforces and applies the scope for the session.
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

/**
 * Registers `callback` to run only once the enclosing `withTransaction` call's `COMMIT`
 * has actually succeeded — never on a rolled-back transaction. For an effect a rollback
 * must not have already made visible to the outside world (e.g. `docPersistence.ts`'s
 * realtime `notifyDocUpdate`, issue #105's confirm/reject/revise review fix): firing it
 * eagerly, before the surrounding transaction commits, would let a subscriber observe a
 * `doc_updates` row that a later failure in the same transaction then discards.
 */
export function runAfterCommit(client: PoolClient, callback: () => void): void {
  const existing = afterCommitCallbacks.get(client);
  if (existing) {
    existing.push(callback);
  } else {
    afterCommitCallbacks.set(client, [callback]);
  }
}

export interface WithTransactionOptions {
  /** Defaults to READ COMMITTED (a plain `BEGIN`) when omitted. */
  isolation?: TransactionIsolationLevel;
}

/**
 * Runs `fn` inside a single transaction on a dedicated client, committing on success and rolling back on error.
 *
 * This is the only sanctioned way to open a transaction on a pooled client: `runAfterCommit`
 * keys its callbacks on the `PoolClient`, and only this function drains and fires them after
 * its own `COMMIT` (or discards them on rollback). A hand-rolled `BEGIN`/`COMMIT` leaves those
 * callbacks parked on the client, where the next `withTransaction` call that happens to acquire
 * the same client from the pool fires or discards them instead — attached to an unrelated
 * transaction.
 *
 * With a tenant scope active (`runInTenant`/`runAsSystem`) it sets the transaction-local
 * `app.tenant_id` right after `BEGIN`; see `docs/adr/2026-10-05-tenant-scope-propagation.md`.
 *
 * On failure (from `fn` or from `COMMIT`) the original error is what propagates, even when the
 * `ROLLBACK` itself fails. A connection whose `ROLLBACK` failed is in an unknown state, so it is
 * released with that error — which makes `pg` destroy it — and never goes back into the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  const scope = enforceTenantScope("withTransaction");
  const client = await connectWithoutScopeHook(pool);
  let releaseError: Error | undefined;
  try {
    if (options.isolation === "serializable") {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    } else if (options.isolation === "repeatable_read") {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    } else {
      await client.query("BEGIN");
    }
    try {
      if (scope) await client.query(SET_TENANT_SQL, [scopeGucValue(scope), true]);
      const result = await fn(client);
      await client.query("COMMIT");
      const callbacks = afterCommitCallbacks.get(client);
      afterCommitCallbacks.delete(client);
      if (callbacks) {
        // The transaction has already committed at this point — a callback throwing must
        // never surface as if this call had failed (the caller would see an error for an
        // operation that actually succeeded), and one callback's failure must not skip the
        // rest of the list.
        for (const callback of callbacks) {
          try {
            callback();
          } catch (err) {
            console.error("withTransaction: an afterCommit callback threw", err);
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
        console.error("withTransaction: ROLLBACK failed; discarding the connection", rollbackErr);
      }
      throw err;
    }
  } finally {
    client.release(releaseError);
  }
}

/**
 * Unwraps the single row of a query that returns exactly one by construction — an aggregate
 * with no GROUP BY, a `SELECT format(...)`, a `RETURNING` on a row just written. Postgres
 * guarantees the row; `noUncheckedIndexedAccess` cannot see that, and `rows[0]!` would silently
 * hand a downstream `undefined` to whatever reads a column off it if the invariant ever broke.
 * `context` names the query so the resulting error is diagnosable.
 */
export function requireSingleRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one row from ${context}, got none`);
  }
  return row;
}

/**
 * Unwraps the affected-row count of a `DELETE`/`UPDATE` that is expected to hit a row by
 * construction — a delete keyed on an id just read back, an update guarded by a prior
 * existence check. A `rowCount` of `0` (the row was already gone, e.g. deleted by a
 * concurrent request) or `null` (the driver couldn't report a count) both mean the write
 * never happened; treating either as success is how a no-op write gets reported upstream as
 * having succeeded. `context` names the query so the resulting error is diagnosable.
 */
export function requireAffectedRows(result: { rowCount: number | null }, context: string): number {
  const { rowCount } = result;
  if (rowCount === null || rowCount === 0) {
    throw new Error(`Expected ${context} to affect at least one row, got ${rowCount ?? "null"}`);
  }
  return rowCount;
}

/** Runs `fn` on a dedicated client, releasing it in a `finally` so a throw between acquire and the first query cannot leak a pool connection. The non-transactional sibling of `withTransaction` — use this for a handful of related statements against one connection that don't need to be atomic. Not a fit for a client that must outlive `fn` itself, such as a `LISTEN` held open for a connection's lifetime and released from a separate code path. */
export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
