import type { Pool, PoolClient } from "pg";
import { createLogger, type Logger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";

const logger: Logger = createLogger("inbox-tick");

/** True when `err` is Postgres' `serialization_failure` (SQLSTATE 40001). */
export function isSerializationFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "40001";
}

/** How many times a tick transaction is run before its serialization failure is rethrown. */
const TICK_TRANSACTION_ATTEMPTS = 3;
const writeTransactions = new WeakSet<PoolClient>();

export function isTickWriteTransaction(client: PoolClient): boolean {
  return writeTransactions.has(client);
}

/** Post-model writes use fresh statement snapshots after taking their source lock. */
export function withTickWriteTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (client) => {
    writeTransactions.add(client);
    try {
      return await fn(client);
    } finally {
      writeTransactions.delete(client);
    }
  });
}

/**
 * Runs one of the tick's `repeatable read` transactions and runs it again when Postgres aborts it with a
 * serialization failure; PostgreSQL's documentation says applications at this level must be prepared to retry.
 * The read phase can hit one: it enqueues the Journal day's recompute through graphile-worker's `add_job`, and
 * when the worker's completion of the job with that key is still in flight, the snapshot and the completion
 * conflict. A retry takes a fresh snapshot, by which time that completion has normally committed. The failed
 * attempt rolled back, so the retry does not double any write, and every other error is rethrown at once.
 */
export async function withTickTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(pool, fn, { isolation: "repeatable_read" });
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= TICK_TRANSACTION_ATTEMPTS) throw err;
      logger.info({ attempt }, "Retrying an Inbox tick transaction after a serialization failure");
    }
  }
}
