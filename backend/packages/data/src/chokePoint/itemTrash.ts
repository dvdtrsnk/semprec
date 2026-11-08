// Owns the choke point's trash lifecycle for items: soft delete and restore of an item together
// with its cascade subtree of inline databases and their rows, and the permanent purge of an
// expired trashed subtree. Item creation and updates, destructive-operation projection, and
// database-level archiving do not belong here.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md,
// docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError } from "../errors.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { runItemDeleteHooks, runItemRestoreHooks } from "./hooks.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as valueLinksStore from "./valueLinksStore.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { deleteRecordingRequestForFile } from "../transcription/recordingIntake.js";
import { TRANSCRIPTION_PREPARE_COMPUTED_KEY } from "../transcription/transcriptionComputedKeys.js";
import * as blobsStore from "../blobs/blobsStore.js";
import * as docsStore from "../docs/docsStore.js";
import * as inboxAttachmentsStore from "../inbox/inboxAttachmentsStore.js";
import * as itemOriginsStore from "../inbox/itemOriginsStore.js";
import * as itemAutomationStore from "../library/itemAutomationStore.js";
import * as taskRecurrenceStore from "../tasks/taskRecurrenceStore.js";
import { deleteKeptDate } from "../projects/projectKeptDateStore.js";
import type { WriterIdentity } from "./writerKind.js";

/** The writer fields every delete and restore hook receives; `system` when the caller supplied none. */
function hookWriterFields(writer: WriterIdentity | undefined, actingUserId: string | undefined) {
  return {
    writerKind: writer?.writerKind ?? "system",
    ...(writer?.agentRunId === undefined ? {} : { agentRunId: writer.agentRunId }),
    ...(actingUserId === undefined ? {} : { actingUserId }),
  };
}

/** Reads each database of a cascade once, for the hook contexts. */
function databaseLookup(client: PoolClient): (databaseId: string) => Promise<DatabaseRow> {
  const cache = new Map<string, DatabaseRow>();
  return async (databaseId) => {
    const cached = cache.get(databaseId);
    if (cached) return cached;
    const database = await databasesStore.getDatabase(client, databaseId);
    if (!database) throw new Error(`Database ${databaseId} of a trash cascade row is missing`);
    cache.set(databaseId, database);
    return database;
  };
}

/**
 * Transaction-scoped counterpart to `chokePoint.softDeleteItem` (issue #89), factored out for the
 * same reason as `propertyDeleteWithClient` above. Runs the identical subtree cascade, including
 * the `systemActive`/archived-database guards and rollup/heartbeat side effects. Each row this call
 * actually soft-deletes, root first, runs the item delete hooks (issue #1601) right after its soft
 * delete, inside this transaction; a row already in the trash runs none, and a repeat delete of a
 * trashed root returns it without running any. A hook's rejection rolls the whole cascade back.
 */
export async function itemDeleteWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  options: {
    queueAffinity: ActionQueueAffinity;
    actingUserId?: string;
    /** Passed to every delete hook; `system` when absent. */
    writer?: WriterIdentity;
  },
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

  const writerFields = hookWriterFields(options.writer, options.actingUserId);
  const databaseOf = databaseLookup(client);
  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    const item = await itemsStore.softDeleteItem(client, row.databaseId, row.id);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    // `now()` is fixed for the transaction, so every row this cascade trashes shares this `deletedAt`.
    if (item.deletedAt === null) throw new Error(`Soft delete of item ${item.id} returned a live row`);
    await runItemDeleteHooks({
      client,
      database: await databaseOf(item.databaseId),
      item,
      rootItemId: itemId,
      deletedAt: item.deletedAt,
      ...writerFields,
    });
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
 * The rows of `subtree` trashed together with `root` (its cascade epoch): those whose `deleted_at`
 * equals the root's, compared by Postgres at the column's full microsecond precision. An `ItemRow`'s
 * `deletedAt` keeps only whole milliseconds, so comparing those strings would take a row trashed on its
 * own in a different transaction within the same millisecond for part of the cascade. The rows are
 * locked `FOR UPDATE` in subtree (root-first) order, the order the delete and restore cascades write
 * in, so a concurrent trash or restore of one of them waits for this transaction instead of changing
 * the epoch it was matched on.
 *
 * Also returns that epoch as Postgres renders it, UTC with all six fraction digits
 * (`YYYY-MM-DDTHH:MI:SS.ffffffZ`), for the restore hooks' `deletedAtExact`. It is read in this same
 * statement, from the root row the caller already locked and before anything is restored. The root
 * itself is always one of the matched rows (its `deleted_at` equals itself), so a matched row always
 * carries the epoch.
 */
async function lockCascadeEpochRowIds(
  client: PoolClient,
  root: ItemRow,
  subtree: ItemRow[],
): Promise<{ ids: Set<string>; deletedAtExact: string }> {
  const { rows } = await client.query<{ id: string; deleted_at_exact: string }>(
    `SELECT id, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at_exact FROM items
      WHERE database_id = ANY($1::uuid[]) AND id = ANY($2::uuid[])
        AND deleted_at = (SELECT deleted_at FROM items WHERE database_id = $3 AND id = $4)
      ORDER BY array_position($2::uuid[], id)
      FOR UPDATE`,
    [[...new Set(subtree.map((row) => row.databaseId))], subtree.map((row) => row.id), root.databaseId, root.id],
  );
  const epoch = rows.find((row) => row.id === root.id)?.deleted_at_exact;
  if (epoch === undefined) throw new Error(`Trashed root ${root.id} is missing from its own cascade epoch`);
  return { ids: new Set(rows.map((row) => row.id)), deletedAtExact: epoch };
}

/**
 * The exact cascade `softDeleteItem` runs, in reverse — restores `itemId` and its whole
 * subtree in one transaction, symmetric to how the delete side of it was trashed. Only
 * restores subtree rows whose `deleted_at` equals the root's own (`lockCascadeEpochRowIds`):
 * since Postgres's `now()` is fixed for the lifetime of a transaction, every row the original
 * cascade delete touched shares one identical timestamp, which tells "trashed together with the
 * root" apart from a row independently trashed (earlier or later) at a different instant —
 * restoring the latter would silently resurrect data the user deleted on purpose. A timestamp is
 * not a transaction identity: a row trashed on its own at exactly the root's microsecond is
 * indistinguishable and is restored with the cascade. Each restored row triggers the `update`
 * `onItemEvent` heartbeats of its database in this same transaction, as an edit of it does
 * (issue #1604), and runs the item restore hooks (issue #1601) right after its restore; a skipped
 * row runs none, and a restore of a live root returns it without running any. A hook's rejection
 * rolls the whole cascade back. Each hook also receives the epoch at full precision
 * (`deletedAtExact`) and this call's `queueAffinity`. Exported for a domain restore hook that
 * restores a related item in the same transaction (issue #1642); it is not part of the package's
 * public barrel.
 */
export async function restoreItemWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  queueAffinity: ActionQueueAffinity,
  actingUserId?: string,
  /** Passed to every restore hook; `system` when absent. */
  writer?: WriterIdentity,
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
  const epoch = await lockCascadeEpochRowIds(client, before, subtree);

  const writerFields = hookWriterFields(writer, actingUserId);
  const databaseOf = databaseLookup(client);
  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    if (!epoch.ids.has(row.id)) continue; // not trashed together with the root: leave as-is
    const item = await itemsStore.restoreItem(client, row.databaseId, row.id);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    await runItemRestoreHooks({
      client,
      database: await databaseOf(item.databaseId),
      item,
      rootItemId: itemId,
      deletedAt: cascadeEpoch,
      deletedAtExact: epoch.deletedAtExact,
      queueAffinity,
      ...writerFields,
    });
    await triggerOnItemEventHeartbeats(client, row.databaseId, "update", row.id, queueAffinity);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `properties.file.blobId` of a Files item when it is a UUID string, otherwise null — read off JSONB, so every level is checked. */
function fileBlobId(row: ItemRow): string | null {
  const file: unknown = row.properties.file;
  if (typeof file !== "object" || file === null || !("blobId" in file)) return null;
  const { blobId } = file;
  return typeof blobId === "string" && UUID_RE.test(blobId) ? blobId : null;
}

/** The `computed.prepare` blob ids that are valid UUID strings; a missing or older checkpoint yields none. */
function derivedBlobIds(row: ItemRow): string[] {
  const prepare: unknown = row.computed[TRANSCRIPTION_PREPARE_COMPUTED_KEY];
  if (typeof prepare !== "object" || prepare === null) return [];
  const original = fileBlobId(row);
  const ids: string[] = [];
  for (const key of ["normalizedBlobId", "playbackBlobId"] as const) {
    const id: unknown = (prepare as Record<string, unknown>)[key];
    // A playback rendition that is the original blob is not a separate blob; and one id is deleted once.
    if (typeof id === "string" && UUID_RE.test(id) && id !== original && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Deletes every row that points at a just-purged item (issue #675). `items` is partitioned with a
 * composite key, so none of these tables carries a Postgres FK to it and nothing else removes
 * them: its relation edges, curated-view memberships, idempotency reservation, doc (whose
 * snapshots, updates, history updates and snapshot history cascade by FK), recurrence rule,
 * automation state, origin and search-index row, its Inbox attachment rows (issue #1564), and its
 * value links and the value-link sources naming it (issue #1656).
 * Must run in the purge's own transaction, after `itemsStore.hardDeleteItem` has removed `row` —
 * the blob checks below rely on the row already being gone.
 *
 * The doc, recurrence rule, automation state, origin and blob rows are each deleted through their
 * owning store. Every blob an Inbox attachment row named is released through
 * `blobsStore.deleteBlobIfUnreferenced` once those rows are gone, so a blob a Files item or another
 * attachment still names keeps its row. For a Files item it also deletes the `blobs` row its
 * `properties.file.blobId` names, but only when nothing else references that blob. Returns the
 * deleted blob's `storage_key`, and the derived blobs named by its `computed.prepare` checkpoint
 * (`normalizedBlobId`, `playbackBlobId`) are deleted unconditionally through
 * `blobsStore.deleteDerivedBlob`, since they are one-to-one with the item; a playback id equal to
 * the original blob is not deleted separately. Returns the `storage_key` of every deleted blob row
 * so the caller can remove the bytes after the commit.
 */
export async function deleteItemDependents(client: PoolClient, row: ItemRow): Promise<{ blobStorageKeys: string[] }> {
  await client.query("DELETE FROM item_relations WHERE item_a = $1 OR item_b = $1", [row.id]);
  // Issue #1656: the purged item's own value links (their sources cascade), every source naming it,
  // and each link that is left without a source; the items of those links refetch them after commit.
  await valueLinksStore.deleteValueLinksByItemId(client, row.id);
  const detached = await valueLinksStore.deleteValueLinkSourcesBySourceItem(client, row.id);
  await valueLinksStore.deleteValueLinksWithoutSources(
    client,
    detached.map((entry) => entry.linkId),
  );
  for (const item of await itemsStore.getItemsByIds(client, [...new Set(detached.map((entry) => entry.itemId))])) {
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: item.databaseId,
        itemId: item.id,
        op: "update",
        updatedAt: item.updatedAt,
      }),
    );
  }
  await client.query("DELETE FROM view_items WHERE item_id = $1", [row.id]);
  await client.query("DELETE FROM idempotency_keys WHERE item_id = $1 AND database_id = $2", [row.id, row.databaseId]);
  await docsStore.deleteDocByItemId(client, row.id);
  await taskRecurrenceStore.deleteTaskRecurrence(client, row.id);
  await deleteKeptDate(client, row.id);
  await itemAutomationStore.deleteItemAutomation(client, row.id);
  const database = await databasesStore.getDatabase(client, row.databaseId);
  if (database?.system && database.ownerModuleId === FILES_MODULE_ID)
    await deleteRecordingRequestForFile(client, row.id);
  await itemOriginsStore.deleteItemOrigin(client, row.id);
  await client.query("DELETE FROM item_search_index WHERE item_id = $1", [row.id]);

  const blobStorageKeys: string[] = [];
  // The attachment rows go first: a row still present would keep its blob referenced.
  const attachmentBlobIds = await inboxAttachmentsStore.deleteInboxAttachmentsForItem(client, row.id);
  for (const id of new Set(attachmentBlobIds)) {
    const key = await blobsStore.deleteBlobIfUnreferenced(client, id);
    if (key !== null) blobStorageKeys.push(key);
  }
  const blobId = fileBlobId(row);
  if (blobId) {
    const key = await blobsStore.deleteBlobIfUnreferenced(client, blobId);
    if (key !== null) blobStorageKeys.push(key);
  }
  for (const id of derivedBlobIds(row)) {
    const key = await blobsStore.deleteDerivedBlob(client, id);
    if (key !== null) blobStorageKeys.push(key);
  }
  return { blobStorageKeys };
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
    async softDeleteItem(
      databaseId: string,
      itemId: string,
      actingUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow | null> {
      return withTransaction(pool, (client) =>
        itemDeleteWithClient(client, databaseId, itemId, { queueAffinity, actingUserId, writer }),
      );
    },

    /** Runs `restoreItemWithClient` in its own transaction. */
    async restoreItem(
      databaseId: string,
      itemId: string,
      actingUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow | null> {
      return withTransaction(pool, (client) =>
        restoreItemWithClient(client, databaseId, itemId, queueAffinity, actingUserId, writer),
      );
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
     * subtree is archived, same as `softDeleteItem`/`restoreItem`.
     *
     * Every removed row's dependents go with it in the same transaction (`deleteItemDependents`,
     * issue #675); a race-restored row keeps all of them. Once the delete loop is done, each
     * inline database owned by a removed item (never the root's own database) whose partition is
     * now empty is dropped together with its partition; one that still holds a live or too-fresh
     * row is left in place. Returns the ids actually removed (never one a concurrent restore
     * raced ahead of), empty if the root turned out not to be eligible, and the storage keys of
     * the blob rows deleted with them — their bytes are the caller's to remove once this has
     * committed.
     */
    async purgeExpiredTrashSubtree(
      rootItemId: string,
      cutoff: Date,
    ): Promise<{ purgedItemIds: string[]; blobStorageKeys: string[] }> {
      return withTransaction(pool, async (client) => {
        const scope = await client.query<{ tenant_id: string | null }>(
          "SELECT app_tenant_default()::text AS tenant_id",
        );
        const tenantId = scope.rows[0]?.tenant_id;
        if (!tenantId) throw new Error("Tenant scope is required for trash purge");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `trash-purge:v1:${tenantId.toLowerCase()}`,
        ]);
        const [root] = await itemsStore.getItemsByIdsIncludingDeleted(client, [rootItemId]);
        if (!root || !root.deletedAt || new Date(root.deletedAt) >= cutoff) {
          return { purgedItemIds: [], blobStorageKeys: [] };
        }

        // A live or too-recently-trashed row stops its branch: only rows past `cutoff` are walked.
        const subtree = await collectItemSubtree(
          client,
          root,
          (row) => row.deletedAt !== null && new Date(row.deletedAt) < cutoff,
        );

        const subtreeDatabaseIds = new Set(subtree.map((row) => row.databaseId));
        for (const id of subtreeDatabaseIds) await assertDatabaseNotArchived(client, id);

        const purgedItemIds: string[] = [];
        const blobStorageKeys: string[] = [];
        for (const row of subtree) {
          const removed = await itemsStore.hardDeleteItem(client, row.databaseId, row.id);
          if (!removed) continue;
          purgedItemIds.push(row.id);
          blobStorageKeys.push(...(await deleteItemDependents(client, row)).blobStorageKeys);
        }

        // Keyed off the purged owners rather than `subtreeDatabaseIds`: a nested row is usually an
        // expired candidate of its own and may already have been purged as a root by an earlier
        // call, leaving its inline database empty and absent from this subtree's rows. An inline
        // database whose owning item survived (race-restored) is never dropped here.
        const ownedDatabaseIds = new Set<string>();
        for (const itemId of purgedItemIds) {
          for (const database of await databasesStore.listDatabasesByParentItem(client, itemId)) {
            ownedDatabaseIds.add(database.id);
          }
        }
        for (const id of ownedDatabaseIds) {
          if (id === root.databaseId) continue;
          const { rows } = await client.query<{ empty: boolean }>(
            "SELECT NOT EXISTS (SELECT 1 FROM items WHERE database_id = $1) AS empty",
            [id],
          );
          if (rows[0]?.empty === true) await databasesStore.dropDatabaseWithPartition(client, id);
        }
        return { purgedItemIds, blobStorageKeys };
      });
    },
  };
}
