import type { Pool, PoolClient } from "pg";
import { createLogger, type Logger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";

const logger: Logger = createLogger("inbox-tick");

export function isSerializationFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "40001";
}

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
 * Runs a tick `repeatable read` transaction, retrying on serialization failure. The read phase can hit one when its
 * `add_job` for the Journal day recompute conflicts with the worker's in-flight completion of the same job key; a
 * retry takes a fresh snapshot. The failed attempt rolled back, so nothing is written twice.
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
