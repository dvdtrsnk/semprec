// Owns the choke point's trash lifecycle for items: soft delete and restore of an item together
// with its cascade subtree of inline databases and their rows, and the permanent purge of an
// expired trashed subtree. Item creation and updates, destructive-operation projection, and
// database-level archiving do not belong here.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md,
// docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError } from "../errors.js";
import type { ItemRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";

/**
 * Transaction-scoped counterpart to `chokePoint.softDeleteItem` (issue #89), factored out for the
 * same reason as `propertyDeleteWithClient` above. Runs the identical subtree cascade, including
 * the `systemActive`/archived-database guards and rollup/heartbeat side effects.
 */
export async function itemDeleteWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  options: { queueAffinity: ActionQueueAffinity; actingUserId?: string },
): Promise<ItemRow | null> {
  await assertDatabaseNotArchived(client, databaseId);
  const before = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!before) return null;
  if (before.properties.systemActive === true) {
    throw new ForbiddenError(`Item ${itemId} is a system-active project and cannot be deleted, only deactivated`, {
      field: "systemActive",
    });
  }
  if (before.deletedAt) return before;

  const subtree = await collectItemSubtree(client, before);
  for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    const item = await itemsStore.softDeleteItem(client, row.databaseId, row.id);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    await triggerOnItemEventHeartbeats(client, row.databaseId, "delete", row.id, options.queueAffinity);
    const edges = await relationsStore.listAllRelationsForItem(client, row.id);
    for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: item.databaseId,
        itemId: item.id,
        op: "delete",
        updatedAt: item.updatedAt,
        userId: options.actingUserId,
      }),
    );
  }
  return rootResult;
}

/**
 * The exact cascade `softDeleteItem` runs, in reverse — restores `itemId` and its whole
 * subtree in one transaction, symmetric to how the delete side of it was trashed. Only
 * restores subtree rows whose `deletedAt` exactly matches the root's own `deletedAt`: since
 * Postgres's `now()` is fixed for the lifetime of a transaction, every row the original
 * cascade delete touched shares one identical timestamp, which lets this tell "trashed
 * together with the root" apart from a row that happened to already be independently trashed
 * (earlier or later) before this subtree was ever cascaded — restoring the latter would
 * silently resurrect data the user deleted on purpose.
 */
async function restoreItemWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  actingUserId?: string,
): Promise<ItemRow | null> {
  await assertDatabaseNotArchived(client, databaseId);
  // Locked for the same reason `softDeleteItem` locks its root: without it, two concurrent
  // restores of the same item can both read `deletedAt` as set, both proceed, and the
  // second one's SQL-level `itemsStore.restoreItem` then finds nothing left to restore and
  // returns null — turning an already-successful restore into a spurious 404.
  const before = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!before) return null;
  if (!before.deletedAt) return before; // not trashed: idempotent no-op, same as a repeat restore
  const cascadeEpoch = before.deletedAt;

  const subtree = await collectItemSubtree(client, before);
  for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    if (row.deletedAt !== cascadeEpoch) continue; // not trashed together with the root: leave as-is
    const item = await itemsStore.restoreItem(client, row.databaseId, row.id);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    const edges = await relationsStore.listAllRelationsForItem(client, row.id);
    for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: item.databaseId,
        itemId: item.id,
        op: "update",
        updatedAt: item.updatedAt,
        userId: actingUserId,
      }),
    );
  }
  return rootResult;
}

/**
 * Walks down from an already-fetched page item to every row nested underneath it — the inline
 * databases it owns directly (`databases.parent_item_id = itemId`), every item in each of those,
 * and recursively whatever inline databases *those* items own in turn — so delete/restore (issue
 * #156) can act on the whole subtree in one transaction instead of just the one row named by the
 * caller. Root-first order, BFS by level, root included as given (its `deletedAt` reflects the
 * state the caller read it in, before this transaction's own writes). Guards against a
 * `parent_item_id` cycle the same way `getItemPath` guards against one in the opposite direction:
 * tracking every database id already walked and refusing to walk it twice, so a corrupted loop
 * stops the traversal instead of hanging it. `include`, when given, filters the walk: a row for
 * which it returns `false` is neither collected nor descended into, so everything nested under it
 * is excluded too. The root is always included regardless of `include`.
 */
async function collectItemSubtree(
  client: PoolClient,
  root: ItemRow,
  include?: (row: ItemRow) => boolean,
): Promise<ItemRow[]> {
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
          if (include && !include(row)) continue;
          subtree.push(row);
          nextFrontier.push(row.id);
        }
      }
    }
    frontier = nextFrontier;
  }
  return subtree;
}

export function createItemTrashOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    /**
     * Soft-deletes `itemId` and, in the same transaction, cascades to its whole subtree — every
     * inline database it owns and their rows, recursively (issue #156). Every database touched
     * anywhere in that subtree must be unarchived, or the entire cascade is rejected and nothing
     * is written; a database midway down the tree being archived is not a partial success.
     */
    async softDeleteItem(databaseId: string, itemId: string, actingUserId?: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) =>
        itemDeleteWithClient(client, databaseId, itemId, { queueAffinity, actingUserId }),
      );
    },

    /** Runs `restoreItemWithClient` in its own transaction. */
    async restoreItem(databaseId: string, itemId: string, actingUserId?: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) => restoreItemWithClient(client, databaseId, itemId, actingUserId));
    },

    /**
     * Permanently removes an already-eligible trashed root together with its cascade subtree —
     * the 30-day purge sweep's (`trash/purgeExpiredTrash.ts`, issue #156) only path to a hard
     * delete, so it stays a choke-point-guarded write like every other item mutation instead of a
     * second route into the `items` table. Uses `softDeleteItem`/`restoreItem`'s subtree walk,
     * but only descends into a branch that is itself past `cutoff`: a still-live or
     * too-recently-trashed row blocks the purge of everything nested under it, since only a
     * branch that was cascade-deleted together with the root is safe to remove with it. Re-checks
     * the root's own eligibility inside this transaction (rather than trusting the caller's
     * earlier candidate snapshot); that snapshot read is a plain, unlocked `SELECT`, so it alone
     * cannot stop a `restoreItem` from committing on one of these rows between this scan and the
     * delete loop below — the actual guard against that race is `itemsStore.hardDeleteItem`'s own
     * `deleted_at IS NOT NULL` condition, which turns a race-restored row's delete into a no-op
     * instead of destroying it. Rejects — and purges nothing — if any database in the eligible
     * subtree is archived, same as `softDeleteItem`/`restoreItem`. Returns the ids actually
     * removed (never one a concurrent restore raced ahead of), empty if the root turned out not
     * to be eligible.
     */
    async purgeExpiredTrashSubtree(rootItemId: string, cutoff: Date): Promise<string[]> {
      return withTransaction(pool, async (client) => {
        const [root] = await itemsStore.getItemsByIdsIncludingDeleted(client, [rootItemId]);
        if (!root || !root.deletedAt || new Date(root.deletedAt) >= cutoff) return [];

        // A live or too-recently-trashed row stops its branch: only rows past `cutoff` are walked.
        const subtree = await collectItemSubtree(
          client,
          root,
          (row) => row.deletedAt !== null && new Date(row.deletedAt) < cutoff,
        );

        const subtreeDatabaseIds = new Set(subtree.map((row) => row.databaseId));
        for (const id of subtreeDatabaseIds) await assertDatabaseNotArchived(client, id);

        const purgedIds: string[] = [];
        for (const row of subtree) {
          const removed = await itemsStore.hardDeleteItem(client, row.databaseId, row.id);
          if (removed) purgedIds.push(row.id);
        }
        return purgedIds;
      });
    },
  };
}
