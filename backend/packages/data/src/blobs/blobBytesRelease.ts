import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { LocalFsBlobStorageWriter, resolveBlobStorageDir } from "../mail/blobStorage.js";
import { logger } from "./logger.js";

/**
 * Best effort after commit: the rows are gone, so a failure only leaves unreachable files and is logged, never
 * raised. For callers without their own storage; the bytes live under `FILES_STORAGE_DIR`.
 */
export function removeBlobBytesAfterCommit(client: PoolClient, storageKeys: readonly string[]): void {
  if (storageKeys.length === 0) return;
  // Never rejects.
  runAfterCommit(client, () => {
    void removeBlobBytes(storageKeys);
  });
}

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
