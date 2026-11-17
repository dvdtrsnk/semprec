import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { RETENTION_DAYS } from "../trashRetention.js";
import { logger } from "./logger.js";
import { purgeExpiredArchivedDatabases } from "./purgeArchivedDatabases.js";

export { RETENTION_DAYS };
const CANDIDATE_PAGE_SIZE = 500;

/**
 * Permanently deletes every item in scope trashed longer than `retentionDays`, with its cascade subtree, one root
 * per `chokePoint.purgeExpiredTrashSubtree` transaction (which re-checks eligibility and refuses archived
 * databases), so one bad subtree cannot fail the sweep. Items of archived databases are not candidates:
 * `purgeExpiredArchivedDatabases` deletes them with the database. Candidates are read in keyset pages of 500, so a
 * failed candidate is not re-read by this run. Blob bytes are removed only after the subtree commits; storage
 * failures are logged. Must run in a tenant scope (RLS). Returns the number of items committed as removed.
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
        // Archived after the candidate read: its items go with the database, so skip without an error.
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
 * Per active tenant: `purgeExpiredTrash`, then `purgeExpiredArchivedDatabases`. A failure of the first stage does
 * not skip the second; failures are logged and rethrown together after both ran, and per-tenant failures are
 * rethrown after every tenant was attempted, so the job retries.
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
