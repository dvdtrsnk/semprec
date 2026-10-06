import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

const DEFAULT_RETENTION_DAYS = 30;
const CANDIDATE_PAGE_SIZE = 500;

/**
 * The 30-day trash purge (issue #156) for the trash visible in the current scope: permanently
 * deletes every item whose `deleted_at` is older than `retentionDays`, together with its cascade subtree and every row that depends on it, one
 * root at a time through `chokePoint.purgeExpiredTrashSubtree` — its own transaction,
 * archived-database rejection, and eligibility re-check, so one oversized or
 * already-partially-purged subtree can't fail the whole sweep and a database archived after a
 * candidate was selected is never written to. Live items and trashed items younger than the cutoff
 * are never touched, whether they're a purge root or nested underneath one.
 *
 * Candidates are read in keyset pages of 500 (issue #675), so at most one page is held at a time;
 * the keyset advances from the last row of each page, so a candidate whose subtree failed is not
 * re-read by this run. A blob whose row a subtree call deleted has its bytes removed from `storage`
 * only after that call has resolved — its transaction has committed by then — and a storage
 * failure is logged and skipped, leaving the unreferenced bytes behind rather than failing the
 * sweep. Only ids a subtree call actually committed are counted. Returns the number of items
 * permanently removed.
 *
 * Row-level security narrows every read and write to the scope the caller runs in, so call it inside
 * a tenant scope to purge that tenant's trash; `handleItemTrashPurgeSweepTask` does so once per
 * active tenant.
 */
export async function purgeExpiredTrash(
  pool: Pool,
  storage: BlobStorageWriter,
  retentionDays = DEFAULT_RETENTION_DAYS,
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
        console.error(`Failed to purge trashed item ${candidate.id}`, err);
        continue;
      }
      for (const id of result.purgedItemIds) purgedInPage.add(id);
      purgedCount += result.purgedItemIds.length;
      for (const key of result.blobStorageKeys) {
        try {
          await storage.delete(key);
        } catch (err) {
          // The blob row is already gone, so these bytes are unreachable; leaving them is safe.
          console.error(`Failed to delete blob bytes ${key} of a purged item`, err);
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
 * Runs `purgeExpiredTrash` once per active tenant, each inside that tenant's scope. A failure that
 * escapes one tenant's pass fails only that tenant; `forEachActiveTenant` rethrows the failures
 * together after every tenant was attempted, so the job is retried.
 */
export async function handleItemTrashPurgeSweepTask(pool: Pool, storage: BlobStorageWriter): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    await purgeExpiredTrash(pool, storage);
  });
}
