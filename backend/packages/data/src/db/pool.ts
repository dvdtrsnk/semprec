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
