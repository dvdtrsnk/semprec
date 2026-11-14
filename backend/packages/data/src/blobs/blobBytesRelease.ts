import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { LocalFsBlobStorageWriter, resolveBlobStorageDir } from "../mail/blobStorage.js";
import { logger } from "./logger.js";

/**
 * Removes the bytes of blobs whose rows the caller's transaction deleted, once that transaction has committed, in the
 * way of `2026-09-28-blob-bytes-deleted-best-effort-after-the-commit`: the rows are gone, so a failure to remove bytes
 * leaves unreachable files and is logged, never raised. For a caller that has no blob storage of its own, such as a
 * confirmation of a proposal: the bytes are in the local-filesystem storage of `FILES_STORAGE_DIR`, where Files blobs
 * and the derived images of Inbox attachments (issue gh-1965) are written.
 */
export function removeBlobBytesAfterCommit(client: PoolClient, storageKeys: readonly string[]): void {
  if (storageKeys.length === 0) return;
  // `removeBlobBytes` catches every failure it can meet, so the promise it returns never rejects.
  runAfterCommit(client, () => {
    void removeBlobBytes(storageKeys);
  });
}

/** Resolves once every key was tried; it never rejects. */
async function removeBlobBytes(storageKeys: readonly string[]): Promise<void> {
  let storage: LocalFsBlobStorageWriter;
  try {
    storage = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR"));
  } catch (err) {
    logger.error(
      { errName: err instanceof Error ? err.name : undefined, count: storageKeys.length },
      "Blob storage is not configured, so the bytes of deleted blobs stay",
    );
    return;
  }
  for (const key of storageKeys) {
    try {
      await storage.delete(key);
    } catch (err) {
      logger.error(
        { errCode: err instanceof Error && "code" in err ? String(err.code) : undefined },
        "Failed to delete the bytes of a deleted blob",
      );
    }
  }
}
