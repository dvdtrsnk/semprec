// The trash lifecycle for items: soft delete and restore of an item with its cascade (inline
// databases, their rows and module expansions), and the permanent purge of an expired trashed
// subtree.
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError } from "../errors.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import {
  runItemDeleteHooks,
  runItemDeletePreLockHooks,
  runItemPurgeHooks,
  runItemPurgePreLockHooks,
  runItemRestoreHooks,
  runItemRestorePreLockHooks,
} from "./hooks.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as valueLinksStore from "./valueLinksStore.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import { FILES_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
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
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { hideClosedRollupValuesForWriter } from "../agentGrants/closedSensitiveAggregationAccess.js";
import { assertWriterCascadeAccess, collectCascadeRows } from "./itemSubtreeAccess.js";
import { deleteAgentDatabaseGrantsForProject } from "../agentGrants/agentDatabaseGrantsStore.js";

/** `system` when the caller supplied none. */
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

/** What Postgres renders with `YYYY-MM-DD"T"HH24:MI:SS.US"Z"` in UTC. */
const EXACT_TRASH_EPOCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Transaction-scoped counterpart to `chokePoint.softDeleteItem`, for the approved-operation executor.
 * Runs the full cascade (`collectCascadeRows`) with the `systemActive`/archived-database guards and
 * rollup/heartbeat side effects. Each row actually soft-deleted, root first, runs the delete hooks
 * right after; an already-trashed row runs none, and a repeat delete of a trashed root returns it. A
 * hook's rejection rolls the whole cascade back.
 *
 * The root's owning module's delete pre-lock hooks run before the root row is locked, so a writer
 * taking the module lock first and the row second cannot deadlock with this call.
 *
 * `options.deletedAtExact` makes the cascade join an earlier trash epoch instead of `now()`; a value
 * that is not six-digit UTC text is refused before anything is written.
 */
export async function itemDeleteWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  options: {
    queueAffinity: ActionQueueAffinity;
    actingUserId?: string;
    /** `system` when absent. */
    writer?: WriterIdentity;
    /** As `itemsStore.lockItemTrashEpoch` returns it; the transaction's `now()` when absent. */
    deletedAtExact?: string;
  },
): Promise<ItemRow | null> {
  if (options.deletedAtExact !== undefined && !EXACT_TRASH_EPOCH_RE.test(options.deletedAtExact)) {
    throw new Error("deletedAtExact must be UTC text with six fraction digits (YYYY-MM-DDTHH:MI:SS.ffffffZ)");
  }
  await assertWriterDatabaseAccess(client, options.writer, databaseId, "write", itemId);
  const rootDatabase = await assertDatabaseNotArchived(client, databaseId);
  // The owning module's locks come before the first lock on the trashed row.
  if (rootDatabase.ownerModuleId !== null) {
    await runItemDeletePreLockHooks(rootDatabase.ownerModuleId, { client, database: rootDatabase, itemId });
  }
  const before = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!before) return null;
  if (before.properties.systemActive === true) {
    throw new ForbiddenError(`Item ${itemId} is a system-active project and cannot be deleted, only deactivated`, {
      field: "systemActive",
    });
  }
  if (before.deletedAt) return before;

  const subtree = await collectCascadeRows(client, before);
  await assertWriterCascadeAccess(client, options.writer, databaseId, subtree);
  for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

  const writerFields = hookWriterFields(options.writer, options.actingUserId);
  const databaseOf = databaseLookup(client);
  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    const item = await itemsStore.softDeleteItem(client, row.databaseId, row.id, options.deletedAtExact);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    // Every row this cascade trashes shares one `deletedAt`: the given epoch, or the transaction's `now()`.
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
 * The rows of `subtree` in `root`'s cascade epoch: `deleted_at` equal to the root's, compared by
 * Postgres at full microsecond precision (an `ItemRow` keeps only milliseconds, which could match a
 * row trashed separately in the same millisecond). Locked `FOR UPDATE` in root-first order, the order
 * the cascades write in, so a concurrent trash or restore waits instead of changing the epoch.
 *
 * Also returns the epoch as six-digit UTC text for the restore hooks' `deletedAtExact`, read in the
 * same statement from the already-locked root before anything is restored.
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
 * Restores `itemId` and its cascade (`collectCascadeRows`) in one transaction, but only rows whose
 * `deleted_at` equals the root's: `now()` is fixed per transaction, so this tells rows trashed with
 * the root from ones the user trashed separately. A row trashed separately in the root's exact
 * microsecond is indistinguishable and restored too.
 *
 * Each restored row fires its database's `update` heartbeats and then the restore hooks (with
 * `deletedAtExact` and `queueAffinity`); a skipped row runs none, and restoring a live root returns
 * it. A hook's rejection rolls everything back. The module's restore pre-lock hooks run before the
 * root is locked. Exported for domain restore hooks and the bulk restore route, not the public barrel.
 */
export async function restoreItemWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  queueAffinity: ActionQueueAffinity,
  actingUserId?: string,
  /** `system` when absent. */
  writer?: WriterIdentity,
): Promise<ItemRow | null> {
  await assertWriterDatabaseAccess(client, writer, databaseId, "write", itemId);
  const rootDatabase = await assertDatabaseNotArchived(client, databaseId);
  // The owning module's locks come before the first lock on the restored row, as on the delete side.
  if (rootDatabase.ownerModuleId !== null) {
    await runItemRestorePreLockHooks(rootDatabase.ownerModuleId, { client, database: rootDatabase, itemId });
  }
  // Without the lock, two concurrent restores could both see `deletedAt` set and the second would
  // return a spurious 404.
  const before = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!before) return null;
  if (!before.deletedAt) return before; // not trashed: idempotent no-op, same as a repeat restore
  const cascadeEpoch = before.deletedAt;

  const subtree = await collectCascadeRows(client, before);
  await assertWriterCascadeAccess(client, writer, databaseId, subtree);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read off JSONB, so every level is checked. */
function fileBlobId(row: ItemRow): string | null {
  const file: unknown = row.properties.file;
  if (typeof file !== "object" || file === null || !("blobId" in file)) return null;
  const { blobId } = file;
  return typeof blobId === "string" && UUID_RE.test(blobId) ? blobId : null;
}

/** A missing or older checkpoint yields none. */
function derivedBlobIds(row: ItemRow): string[] {
  const prepare: unknown = row.computed[TRANSCRIPTION_PREPARE_COMPUTED_KEY];
  if (typeof prepare !== "object" || prepare === null) return [];
  const original = fileBlobId(row);
  const ids: string[] = [];
  for (const key of ["normalizedBlobId", "playbackBlobId"] as const) {
    const id: unknown = (prepare as Record<string, unknown>)[key];
    // A playback rendition equal to the original is not a separate blob; each id is deleted once.
    if (typeof id === "string" && UUID_RE.test(id) && id !== original && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Deletes every row that points at a just-purged item. Partitioned `items` cannot be an FK target,
 * so nothing else removes them: edges, curated-view memberships, idempotency reservation, doc,
 * recurrence rule, automation state, origin, search-index row, Inbox attachments, value links and
 * sources naming it, transcript action item states and an agent project's grants. Must run in the
 * purge's transaction after `itemsStore.hardDeleteItem` removed `row`; the blob checks rely on that.
 *
 * Attachment blobs (with previews and reduced copies) and a Files item's blob are released only when
 * unreferenced; `computed.prepare` derived blobs are one-to-one with the item and deleted outright.
 * Returns the `storage_key` of every deleted blob row so the caller removes bytes after commit.
 */
export async function deleteItemDependents(client: PoolClient, row: ItemRow): Promise<{ blobStorageKeys: string[] }> {
  await client.query("DELETE FROM item_relations WHERE item_a = $1 OR item_b = $1", [row.id]);
  // The item's own value links (sources cascade), every source naming it, and each link left without
  // a source; the links' items refetch after commit.
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
  if (database?.system && database.ownerModuleId === PROJECTS_MODULE_ID)
    await deleteAgentDatabaseGrantsForProject(client, row.id);
  await itemOriginsStore.deleteItemOrigin(client, row.id);
  await client.query("DELETE FROM item_search_index WHERE item_id = $1", [row.id]);
  await client.query(
    "DELETE FROM transcript_action_item_states WHERE tenant_id = app_tenant_default() AND transcript_item_id = $1",
    [row.id],
  );

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

/** With the rollups an agent writer may not read hidden. */
async function returnedToWriter(
  client: PoolClient,
  writer: WriterIdentity | undefined,
  item: ItemRow | null,
): Promise<ItemRow | null> {
  return item === null ? null : (await hideClosedRollupValuesForWriter(client, writer, [item]))[0]!;
}

export function createItemTrashOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    /**
     * Soft-deletes `itemId` and its whole subtree in one transaction. Every database in the subtree must
     * be unarchived, or nothing is written.
     */
    async softDeleteItem(
      databaseId: string,
      itemId: string,
      actingUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) =>
        returnedToWriter(
          client,
          writer,
          await itemDeleteWithClient(client, databaseId, itemId, { queueAffinity, actingUserId, writer }),
        ),
      );
    },

    async restoreItem(
      databaseId: string,
      itemId: string,
      actingUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) =>
        returnedToWriter(
          client,
          writer,
          await restoreItemWithClient(client, databaseId, itemId, queueAffinity, actingUserId, writer),
        ),
      );
    },

    /**
     * Permanently removes an eligible trashed root with its cascade: the purge sweep's only path to a hard
     * delete. Only descends into branches past `cutoff`, since only a branch trashed with the root is safe
     * to remove with it. Re-checks the root's eligibility in this transaction. Rejects, purging nothing,
     * if any database in the eligible subtree is archived.
     *
     * Each row is re-read with `itemsStore.lockTrashedItemBefore` immediately before its delete, so the
     * locked row is exactly what is removed. A row that no longer qualifies (gone, restored, or trashed
     * again at or after `cutoff`) is skipped with no lock, write or hook. At READ COMMITTED a row that
     * changes during the lock wait is rechecked; a restore committing during that wait leaves the skipped
     * row locked until this transaction ends. `hardDeleteItem`'s guard stays behind it.
     *
     * Each removed row's dependents (`deleteItemDependents`) go with it, then its purge hooks run; a
     * hook's rejection rolls back the whole call. Afterwards each now-empty inline database owned by a
     * removed item (never the root's own database) is dropped with its partition. Returns the removed ids
     * (empty if the root was not eligible) and the deleted blobs' storage keys, whose bytes the caller
     * removes after commit.
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

        // Module locks first, in the order trash and restore take them; taking the root first could wait
        // on rows a restore of the same cascade holds while it waits on the root.
        const databaseOf = databaseLookup(client);
        const rootDatabase = await databaseOf(root.databaseId);
        if (rootDatabase.ownerModuleId !== null) {
          await runItemPurgePreLockHooks(rootDatabase.ownerModuleId, {
            client,
            database: rootDatabase,
            itemId: rootItemId,
          });
        }

        // A live or too-recently-trashed row stops its branch: only rows past `cutoff` are walked.
        const subtree = await collectCascadeRows(
          client,
          root,
          (row) => row.deletedAt !== null && new Date(row.deletedAt) < cutoff,
        );

        const subtreeDatabaseIds = new Set(subtree.map((row) => row.databaseId));
        for (const id of subtreeDatabaseIds) await assertDatabaseNotArchived(client, id);

        const purgedItemIds: string[] = [];
        const blobStorageKeys: string[] = [];
        for (const row of subtree) {
          // `row` is the unlocked walk's read. The locked read returns, and holds until the delete, the row
          // the delete removes, but only while it is still trashed before `cutoff`.
          const locked = await itemsStore.lockTrashedItemBefore(client, row.databaseId, row.id, cutoff);
          if (!locked) continue;
          const removed = await itemsStore.hardDeleteItem(client, locked.databaseId, locked.id);
          if (!removed) continue;
          purgedItemIds.push(locked.id);
          blobStorageKeys.push(...(await deleteItemDependents(client, locked)).blobStorageKeys);
          await runItemPurgeHooks({
            client,
            database: await databaseOf(locked.databaseId),
            item: locked,
            rootItemId,
          });
        }

        // Keyed off purged owners rather than `subtreeDatabaseIds`: a nested row may already have been purged
        // as a root earlier, leaving its inline database absent here. A database whose owner survived is
        // never dropped.
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
