// Trash and restore of a recurring task series: deleting any instance trashes every instance under one
// `deleted_at`, so one restore of any brings the series back. Holds the cascade expansion, the pre-lock hooks that
// take the row locks in one order, the hooks turning the repeat rule off and on, and the delete-impact counts. See
// docs/architecture/domain-calendar-tasks-and-media.md#recurring-task-series.
import type { PoolClient } from "pg";
import type {
  ItemCascadeExpansion,
  ItemDeleteHook,
  ItemDeleteImpactReader,
  ItemDeletePreLockHook,
  ItemPurgePreLockHook,
  ItemRestoreHook,
  ItemRestorePreLockHook,
  ItemTrashPreLockHookContext,
} from "../chokePoint/hooks.js";
import { itemIdsLinkedToDatabases } from "../agentGrants/inheritedSensitivity.js";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  deactivateTaskRecurrenceForTrash,
  getTaskRecurrenceBySeriesId,
  reactivateTaskRecurrenceAfterTrash,
} from "./taskRecurrenceStore.js";

const SERIES_ID_KEY = "seriesId";
/** Relation properties whose live targets the delete impact counts. */
const ATTACHMENTS_KEY = "files";
const HOST_EVENTS_KEY = "hostEvents";

function readSeriesId(properties: Record<string, unknown>): string | null {
  const seriesId = properties[SERIES_ID_KEY];
  return typeof seriesId === "string" && seriesId !== "" ? seriesId : null;
}

/**
 * Locks every instance of the series `FOR UPDATE` in id order, then its `task_recurrence` row (items before
 * `task_recurrence`). Advancing and materializing store a new instance while holding the current instance or the
 * series row, so once both are held no instance can be added. A read that waited on a lock misses instances
 * committed meanwhile, so it re-reads until a pass returns the ids already locked.
 */
async function lockSeries(client: PoolClient, databaseId: string, seriesId: string): Promise<void> {
  let locked: string[] = [];
  for (;;) {
    const ids = (await itemsStore.listItemsByTextProperty(client, databaseId, SERIES_ID_KEY, seriesId, true)).map(
      (row) => row.id,
    );
    if (ids.length === locked.length && ids.every((id, index) => id === locked[index])) return;
    locked = ids;
    await getTaskRecurrenceBySeriesId(client, seriesId, true);
  }
}

async function lockSeriesOfNamedItem({ client, database, itemId }: ItemTrashPreLockHookContext): Promise<void> {
  const item = await itemsStore.getItemById(client, database.id, itemId);
  const seriesId = item === null ? null : readSeriesId(item.properties);
  if (seriesId !== null) await lockSeries(client, database.id, seriesId);
}

/**
 * The other instances of the root's series, live or trashed, in id order. Delete skips already trashed ones;
 * restore takes those of the root's epoch.
 */
export const taskSeriesCascadeExpansion: ItemCascadeExpansion = async ({ client, database, root }) => {
  const seriesId = readSeriesId(root.properties);
  if (seriesId === null) return [];
  const instances = await itemsStore.listItemsByTextProperty(client, database.id, SERIES_ID_KEY, seriesId, false);
  return instances.filter((row) => row.id !== root.id);
};

/**
 * Locks the series before the delete locks its task, so no instance appears mid-cascade and two trashes of
 * different instances of one series take the same rows in the same order instead of deadlocking.
 */
export const taskSeriesItemDeletePreLockHook: ItemDeletePreLockHook = lockSeriesOfNamedItem;

export const taskSeriesItemRestorePreLockHook: ItemRestorePreLockHook = lockSeriesOfNamedItem;

/**
 * The purge locks the series before its delete loop locks the root, which is not the lowest instance for a later
 * root. Otherwise purge and a concurrent restore would take instances, and the series row, in opposite orders.
 */
export const taskSeriesItemPurgePreLockHook: ItemPurgePreLockHook = lockSeriesOfNamedItem;

/**
 * Turns the repeat rule off so the trashed series projects no virtual occurrence. Runs for every cascade row;
 * only the first finding it on changes anything. The pre-lock hook holds the series for the whole cascade.
 */
export const taskSeriesItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID) return;
  const seriesId = readSeriesId(item.properties);
  if (seriesId !== null) await deactivateTaskRecurrenceForTrash(client, seriesId);
};

/**
 * Re-enables the rule only on the instance the trash recorded, so exactly one instance holds an active rule. A
 * rule turned off before the trash stays off; a restore never creates an instance.
 */
export const taskSeriesItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID) return;
  const seriesId = readSeriesId(item.properties);
  if (seriesId !== null) await reactivateTaskRecurrenceAfterTrash(client, seriesId, item.id);
};

/**
 * Live edge targets of `propertyKey` that `reader` may see. An agent's project also may not see a Files item
 * linked to a sensitive database it may not read (`inheritedSensitivityDeniedSql`); external clients are not held
 * to that. A person and the system see everything.
 */
async function countLiveEdgeTargets(
  client: PoolClient,
  databaseId: string,
  propertyKey: string,
  itemId: string,
  reader: DatabaseReader | undefined,
): Promise<number> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, propertyKey);
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) return 0;
  const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
  const targets = await itemsStore.getItemsByIds(client, [
    ...new Set(edges.map((edge) => relationsStore.otherSide(edge, itemId))),
  ]);
  if (reader === undefined || targets.length === 0) return targets.length;
  const unreadable = await listUnreadableDatabaseIds(client, reader);
  const readable = targets.filter((target) => !unreadable.has(target.databaseId));
  if (typeof reader !== "string") return readable.length;
  const hidden = await itemIdsLinkedToDatabases(
    client,
    readable.map((target) => target.id),
    unreadable,
  );
  return readable.filter((target) => !hidden.has(target.id)).length;
}

/**
 * What deleting a task reaches beyond its cascade: the live instances of its series (itself included), its live
 * attachments and its live host Events. Attachment and Event counts omit what the reader may not read, since a
 * Files item inherits the sensitivity of a linked record; the series count is not filtered.
 */
export const taskDeleteImpactReader: ItemDeleteImpactReader = async ({ client, database, item, reader }) => {
  const seriesId = readSeriesId(item.properties);
  const instances =
    seriesId === null
      ? []
      : await itemsStore.listItemsByTextProperty(client, database.id, SERIES_ID_KEY, seriesId, false);
  return {
    seriesInstanceCount: instances.filter((row) => row.deletedAt === null).length,
    attachmentCount: await countLiveEdgeTargets(client, database.id, ATTACHMENTS_KEY, item.id, reader),
    hostEventCount: await countLiveEdgeTargets(client, database.id, HOST_EVENTS_KEY, item.id, reader),
  };
};
