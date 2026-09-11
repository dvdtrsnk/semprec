import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { ItemRow } from "../types.js";

const DEFAULT_RETENTION_DAYS = 30;

/**
 * Walks down from an already-eligible trashed root the same way the choke-point's own
 * `collectItemSubtree` does, but stops the moment a branch is no longer eligible: a still-live or
 * too-recently-trashed row blocks purge of everything nested under it, since only a branch that
 * was cascade-deleted together with its root shares its `deleted_at` and is safe to remove
 * together with it — issue #156's "purge removes exactly the same subtree the cascade delete
 * trashed."
 */
async function collectPurgeableSubtree(client: PoolClient, root: ItemRow, cutoff: Date): Promise<ItemRow[]> {
  const subtree: ItemRow[] = [root];
  const visitedDatabaseIds = new Set<string>();
  let frontier = [root.id];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const parentItemId of frontier) {
      const childDatabases = await databasesStore.listDatabasesByParentItem(client, parentItemId);
      for (const database of childDatabases) {
        if (visitedDatabaseIds.has(database.id)) continue;
        visitedDatabaseIds.add(database.id);
        const rows = await itemsStore.getAllItemsInDatabase(client, database.id);
        for (const row of rows) {
          if (!row.deletedAt || new Date(row.deletedAt) >= cutoff) continue; // live or too fresh: this branch stops here
          subtree.push(row);
          nextFrontier.push(row.id);
        }
      }
    }
    frontier = nextFrontier;
  }
  return subtree;
}

/**
 * The 30-day trash purge (issue #156): permanently deletes every item whose `deleted_at` is older
 * than `retentionDays`, together with its cascade subtree, one root at a time in its own
 * transaction — so one oversized or already-partially-purged subtree can't fail the whole sweep.
 * Live items and trashed items younger than the cutoff are never touched, whether they're a purge
 * root or nested underneath one (`collectPurgeableSubtree` stops at the first ineligible row on
 * any branch). Returns the number of items permanently removed.
 */
export async function purgeExpiredTrash(pool: Pool, retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = await itemsStore.findItemsDeletedBefore(pool, cutoff);

  const purged = new Set<string>();
  let purgedCount = 0;
  for (const candidate of candidates) {
    if (purged.has(candidate.id)) continue;
    try {
      await withTransaction(pool, async (client) => {
        const subtree = await collectPurgeableSubtree(client, candidate, cutoff);
        for (const item of subtree) {
          if (purged.has(item.id)) continue;
          await itemsStore.hardDeleteItem(client, item.databaseId, item.id);
          purged.add(item.id);
          purgedCount++;
        }
      });
    } catch (err) {
      console.error(`Failed to purge trashed item ${candidate.id}`, err);
    }
  }
  return purgedCount;
}

/** The graphile-worker task handler wired into `createCoreTaskList` (`worker.ts`) and `CORE_CRONTAB`. */
export async function handleItemTrashPurgeSweepTask(pool: Pool): Promise<void> {
  await purgeExpiredTrash(pool);
}
