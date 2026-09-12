import { Pool, type PoolClient } from "pg";

/** Anything a query can run against: a pool, or a client already inside a transaction. */
export type Queryable = Pool | PoolClient;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
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

/** Runs `fn` inside a single transaction on a dedicated client, committing on success and rolling back on error. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
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
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
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
