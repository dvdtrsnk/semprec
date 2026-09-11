import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";

const DEFAULT_RETENTION_DAYS = 30;

/**
 * The 30-day trash purge (issue #156): permanently deletes every item whose `deleted_at` is older
 * than `retentionDays`, together with its cascade subtree, one root at a time through
 * `chokePoint.purgeExpiredTrashSubtree` — its own transaction, archived-database rejection, and
 * eligibility re-check, so one oversized or already-partially-purged subtree can't fail the whole
 * sweep and a database archived after a candidate was selected is never written to. Live items and
 * trashed items younger than the cutoff are never touched, whether they're a purge root or nested
 * underneath one. `purged` is only ever populated with ids a subtree call actually committed —
 * never speculatively before that call resolves — so a rolled-back or rejected subtree can't be
 * undercounted or wrongly skipped on a future candidate. Returns the number of items permanently
 * removed.
 */
export async function purgeExpiredTrash(pool: Pool, retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = await itemsStore.findItemsDeletedBefore(pool, cutoff);
  const chokePoint = createChokePoint(pool);

  const purged = new Set<string>();
  for (const candidate of candidates) {
    if (purged.has(candidate.id)) continue;
    try {
      const purgedIds = await chokePoint.purgeExpiredTrashSubtree(candidate.id, cutoff);
      for (const id of purgedIds) purged.add(id);
    } catch (err) {
      console.error(`Failed to purge trashed item ${candidate.id}`, err);
    }
  }
  return purged.size;
}

/** The graphile-worker task handler wired into `createCoreTaskList` (`worker.ts`) and `CORE_CRONTAB`. */
export async function handleItemTrashPurgeSweepTask(pool: Pool): Promise<void> {
  await purgeExpiredTrash(pool);
}
