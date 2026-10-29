import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { deleteBlobIfUnreferenced, listStandaloneBlobIdsCreatedBefore } from "./blobsStore.js";
import { logger } from "./logger.js";

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

/**
 * Deletes the standalone upload blobs (`POST /api/blobs`) of the tenant in scope that were created
 * more than 24 hours ago and that nothing references any more (`deleteBlobIfUnreferenced`'s rule).
 * Candidates are read in keyset pages; each blob is deleted in its own transaction and its bytes
 * are removed from `storage` only after that transaction committed (best effort, see
 * `docs/adr/2026-09-28-blob-bytes-deleted-best-effort-after-the-commit.md`). A blob whose delete
 * failed is logged and skipped so one bad row does not stop the rest; the sweep then throws so the
 * job is retried. Returns the number of blob rows deleted.
 */
export async function sweepUnreferencedBlobs(
  pool: Pool,
  storage: BlobStorageWriter,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - MIN_AGE_MS);
  let deleted = 0;
  let failed = 0;
  let afterId: string | null = null;
  for (;;) {
    const ids: string[] = await withTransaction(pool, (client) =>
      listStandaloneBlobIdsCreatedBefore(client, cutoff, afterId, PAGE_SIZE),
    );
    for (const id of ids) {
      let storageKey: string | null;
      try {
        storageKey = await withTransaction(pool, (client) => deleteBlobIfUnreferenced(client, id));
      } catch (err) {
        failed += 1;
        logger.error({ err, blobId: id }, "Failed to delete an unreferenced blob");
        continue;
      }
      if (storageKey === null) continue;
      deleted += 1;
      try {
        await storage.delete(storageKey);
      } catch (err) {
        // The row is gone, so these bytes are unreachable; leaving them is safe.
        logger.error(
          { errCode: err instanceof Error && "code" in err ? String(err.code) : undefined, blobId: id },
          "Failed to delete the bytes of an unreferenced blob",
        );
      }
    }
    const last = ids.at(-1);
    if (last === undefined || ids.length < PAGE_SIZE) break;
    afterId = last;
  }
  if (failed > 0) throw new Error(`${failed} unreferenced blobs could not be deleted`);
  return deleted;
}

/** The `blobsUnreferencedSweep` task handler: `sweepUnreferencedBlobs` once per active tenant. */
export async function handleBlobsUnreferencedSweepTask(pool: Pool, storage: BlobStorageWriter): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    await sweepUnreferencedBlobs(pool, storage);
  });
}
