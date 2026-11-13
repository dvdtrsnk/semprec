import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { RETENTION_DAYS } from "../trashRetention.js";
import { logger } from "./logger.js";
import { purgeExpiredArchivedDatabases } from "./purgeArchivedDatabases.js";

/** How long a trashed item stays restorable before the purge sweep removes it. */
export { RETENTION_DAYS };
const CANDIDATE_PAGE_SIZE = 500;

/**
 * The 30-day trash purge (issue #156) for the trash visible in the current scope: permanently
 * deletes every item whose `deleted_at` is older than `retentionDays`, together with its cascade subtree and every row that depends on it, one
 * root at a time through `chokePoint.purgeExpiredTrashSubtree` — its own transaction,
 * archived-database rejection, and eligibility re-check, so one oversized or
 * already-partially-purged subtree can't fail the whole sweep and a database archived after a
 * candidate was selected is never written to. Live items and trashed items younger than the cutoff
 * are never touched, whether they're a purge root or nested underneath one. The items of an archived
 * database are not candidates (`itemsStore.findItemsDeletedBefore`, issue gh-1878): the database is in the
 * trash itself and `purgeExpiredArchivedDatabases` deletes it with all of them. One archived between the
 * candidate read and its purge makes `purgeExpiredTrashSubtree` refuse with `database_archived`; that
 * refusal is skipped with a debug line, every other failure is logged as an error.
 *
 * Candidates are read in keyset pages of 500 (issue #675), so at most one page is held at a time;
 * the keyset advances from the last row of each page, so a candidate whose subtree failed is not
 * re-read by this run. A blob whose row a subtree call deleted has its bytes removed from each
 * distinct configured storage only after that call has resolved — its transaction has committed
 * by then. A storage failure is logged and does not prevent another root's cleanup. Only ids a
 * subtree call actually committed are counted. Returns the number of items permanently removed.
 *
 * Row-level security narrows every read and write to the scope the caller runs in, so call it inside
 * a tenant scope to purge that tenant's trash; `handleItemTrashPurgeSweepTask` does so once per
 * active tenant.
 */
export async function purgeExpiredTrash(
  pool: Pool,
  storage: BlobStorageWriter,
  retentionDays = RETENTION_DAYS,
  alternateStorage?: BlobStorageWriter,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const chokePoint = createChokePoint(pool);

  let purgedCount = 0;
  let after: { databaseId: string; id: string } | undefined;
  for (;;) {
    const candidates = await itemsStore.findItemsDeletedBefore(pool, cutoff, after, CANDIDATE_PAGE_SIZE);
    // A root earlier in this page may already have purged a later candidate as part of its subtree.
    const purgedInPage = new Set<string>();
    for (const candidate of candidates) {
      if (purgedInPage.has(candidate.id)) continue;
      let result: { purgedItemIds: string[]; blobStorageKeys: string[] };
      try {
        result = await chokePoint.purgeExpiredTrashSubtree(candidate.id, cutoff);
      } catch (err) {
        // A database archived after the candidate read refuses the purge; it is in the trash itself now and its items
        // are deleted with it (issue gh-1878), so the item is skipped without an error.
        if (err instanceof ForbiddenError && err.code === "database_archived") {
          logger.debug({ itemId: candidate.id }, "Skipped a trashed item of a database that was archived meanwhile");
          continue;
        }
        logger.error({ err, itemId: candidate.id }, "Failed to purge trashed item");
        continue;
      }
      for (const id of result.purgedItemIds) purgedInPage.add(id);
      purgedCount += result.purgedItemIds.length;
      for (const key of result.blobStorageKeys) {
        for (const target of alternateStorage && alternateStorage !== storage
          ? [storage, alternateStorage]
          : [storage]) {
          try {
            await target.delete(key);
          } catch (err) {
            logger.error(
              { errCode: err instanceof Error && "code" in err ? String(err.code) : undefined, itemId: candidate.id },
              "Failed to delete blob bytes of a purged item",
            );
          }
        }
      }
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < CANDIDATE_PAGE_SIZE) break;
    after = { databaseId: last.databaseId, id: last.id };
  }
  return purgedCount;
}

/**
 * The graphile-worker task handler wired into `createCoreTaskList` (`worker.ts`) and `CORE_CRONTAB`.
 * Runs, once per active tenant and inside that tenant's scope, the item purge `purgeExpiredTrash` and then the purge
 * of archived databases `purgeExpiredArchivedDatabases` (issue gh-1875). A failure of the first stage does not skip
 * the second: each failure is logged with the tenant id and the error's class, and the stages' failures are rethrown
 * together after both ran. A failure that escapes one tenant's pass fails only that tenant; `forEachActiveTenant`
 * rethrows the failures together after every tenant was attempted, so the job is retried.
 */
export async function handleItemTrashPurgeSweepTask(
  pool: Pool,
  storage: BlobStorageWriter,
  alternateStorage?: BlobStorageWriter,
): Promise<void> {
  await forEachActiveTenant(pool, async (tenantId) => {
    const failures: unknown[] = [];
    try {
      await purgeExpiredTrash(pool, storage, RETENTION_DAYS, alternateStorage);
    } catch (err) {
      logger.error({ tenantId, errorName: err instanceof Error ? err.name : typeof err }, "Item purge stage failed");
      failures.push(err);
    }
    try {
      await purgeExpiredArchivedDatabases(pool, storage, alternateStorage);
    } catch (err) {
      logger.error(
        { tenantId, errorName: err instanceof Error ? err.name : typeof err },
        "Archived database purge stage failed",
      );
      failures.push(err);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Trash purge of tenant ${tenantId}: ${failures.length} stages failed`);
    }
  });
}
