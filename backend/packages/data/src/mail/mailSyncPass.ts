import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { logger } from "./logger.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

/** How a pass enters and ends each of its transactions; supplied by the sync job. */
export interface MailSyncPass {
  /**
   * Runs first in every transaction of the pass. `false` (the mailbox is gone, in the trash or has Mail switched off)
   * ends the pass with nothing more written.
   */
  enter(client: PoolClient): Promise<boolean>;
  /** Runs last in the pass's final transaction, after the account activity is recorded. */
  finish(client: PoolClient, result: { complete: boolean }): Promise<void>;
}

export interface MailSyncPassResult {
  /** `false` when `pass.enter` ended the pass. */
  ran: boolean;
  /** `false` when new messages or backfill are left for a later pass, which `pass.finish` must schedule. */
  complete: boolean;
}

/** Every write transaction of a pass: `pass.enter` first, then the mail-thread guard. `null` when the pass ended. */
export async function inPassTransaction<T>(
  pool: Pool,
  pass: MailSyncPass,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ value: T } | null> {
  return withTransaction(pool, async (client) => {
    if (!(await pass.enter(client))) return null;
    await lockMailThreadMutation(client);
    return { value: await fn(client) };
  });
}

/**
 * Records every storage key a batch writes; when the batch's transaction fails they are deleted, best effort, since
 * no committed row references them. Keys of a committed batch are never deleted here.
 */
export async function withBatchStorage<T>(
  storage: BlobStorageWriter,
  fn: (tracked: BlobStorageWriter) => Promise<T>,
): Promise<T> {
  const written = new Set<string>();
  const tracked: BlobStorageWriter = {
    async writeStream(storageKey, source, options) {
      // Recorded before the write: a mid-write failure (disk full) still leaves a partial file at this key.
      written.add(storageKey);
      return storage.writeStream(storageKey, source, options);
    },
    delete: (storageKey) => storage.delete(storageKey),
    readStream: (storageKey, range) => storage.readStream(storageKey, range),
  };
  try {
    return await fn(tracked);
  } catch (err) {
    const outcomes = await Promise.allSettled([...written].map((key) => storage.delete(key)));
    const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
    if (failed > 0) logger.warn({ failed }, "Deleting the attachment bytes of a failed mail sync batch failed");
    throw err;
  }
}
