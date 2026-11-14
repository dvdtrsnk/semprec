// Issue gh-1882: how the trash and the restore treat a recurring task series. Deleting any instance of a series trashes
// every instance with it, under one `deleted_at`, so one restore of any of them brings the whole series back (the
// cascade epoch of docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md). This file holds the Tasks side of
// that: the cascade expansion that adds the other instances, the pre-lock hooks (delete, restore and purge) that take
// their row locks in one order, the delete and restore hooks that turn the repeat rule off and on, and the counts of the delete impact. All of it is
// registered in `../domainWriteHooks.ts` (docs/adr/2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade.md).
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

/** The Tasks property that names the series of an occurrence. */
const SERIES_ID_KEY = "seriesId";
/** The Tasks relation properties whose live targets the delete impact counts: the attachments (`Files.tasks` is its inverse) and the host events. */
const ATTACHMENTS_KEY = "files";
const HOST_EVENTS_KEY = "hostEvents";

/** The series of a task, or `null` for a task without one. */
function readSeriesId(properties: Record<string, unknown>): string | null {
  const seriesId = properties[SERIES_ID_KEY];
  return typeof seriesId === "string" && seriesId !== "" ? seriesId : null;
}

/**
 * Locks the series `seriesId` for a trash or a restore: every instance in the Tasks database, trashed or live, `FOR
 * UPDATE` in id order, then the series' `task_recurrence` row (items before `task_recurrence`,
 * docs/adr/2026-10-25-task-and-event-recurrence-model.md). The advance of the series and the materializing of an
 * occurrence store a new instance while holding the current instance or the series row, so once both are held no
 * instance is added until this transaction ends. A read that waited for a lock does not see an instance the lock's
 * holder committed meanwhile, so the instances are read again after the series row is held, and again until a pass
 * returns the ids the previous one locked.
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

/** Locks the series of the item a trash or a restore names (`lockSeries`), before the cascade locks the item itself. */
async function lockSeriesOfNamedItem({ client, database, itemId }: ItemTrashPreLockHookContext): Promise<void> {
  const item = await itemsStore.getItemById(client, database.id, itemId);
  const seriesId = item === null ? null : readSeriesId(item.properties);
  if (seriesId !== null) await lockSeries(client, database.id, seriesId);
}

/**
 * The other instances of the series of the cascade's root, live or trashed, in id order; none for a task without a
 * series. The cascade skips the ones already in the Trash on a delete and takes the ones of the root's epoch on a
 * restore.
 */
export const taskSeriesCascadeExpansion: ItemCascadeExpansion = async ({ client, database, root }) => {
  const seriesId = readSeriesId(root.properties);
  if (seriesId === null) return [];
  const instances = await itemsStore.listItemsByTextProperty(client, database.id, SERIES_ID_KEY, seriesId, false);
  return instances.filter((row) => row.id !== root.id);
};

/**
 * Before a delete locks the task it names: locks its series (`lockSeries`). The cascade then writes instances it
 * already holds, no instance can be stored while it runs, and two trashes of different instances of one series, which
 * reach the same rows from different roots, take them in the same order instead of waiting on each other.
 */
export const taskSeriesItemDeletePreLockHook: ItemDeletePreLockHook = lockSeriesOfNamedItem;

/** The restore counterpart of `taskSeriesItemDeletePreLockHook`. */
export const taskSeriesItemRestorePreLockHook: ItemRestorePreLockHook = lockSeriesOfNamedItem;

/**
 * The purge counterpart of `taskSeriesItemDeletePreLockHook`: the purge of a series locks it before its delete loop
 * locks the root, which is not the lowest instance when the root is a later one. Without it the purge would hold the
 * root and wait for a lower instance while a restore of the same series holds that instance and waits for the root,
 * and the purge would take the series row, which its delete of the root's dependents removes, in the opposite order to
 * the restore's.
 */
export const taskSeriesItemPurgePreLockHook: ItemPurgePreLockHook = lockSeriesOfNamedItem;

/**
 * After an instance of a series was trashed: turns the series' repeat rule off and records the instance it pointed at
 * (`deactivateTaskRecurrenceForTrash`), so the trashed series projects no virtual occurrence. It runs for every row of the
 * cascade; the first one that finds the rule on turns it off, the others and a rule that was already off change nothing.
 * The pre-lock hook holds the series row and its instances for the whole cascade.
 */
export const taskSeriesItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID) return;
  const seriesId = readSeriesId(item.properties);
  if (seriesId !== null) await deactivateTaskRecurrenceForTrash(client, seriesId);
};

/**
 * After an instance of a series was restored: turns the repeat rule on again when the instance is the one the trash
 * recorded (`reactivateTaskRecurrenceAfterTrash`), so exactly one instance holds an active rule. A restore never creates an
 * instance. A rule the user had turned off before the trash stays off.
 */
export const taskSeriesItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID) return;
  const seriesId = readSeriesId(item.properties);
  if (seriesId !== null) await reactivateTaskRecurrenceAfterTrash(client, seriesId, item.id);
};

/**
 * The number of live items the task has an edge to on its relation property `propertyKey` that `reader` may see; a
 * tenant without the property has none. A reader may not see an item of a database it may not read. For an agent's project it also
 * may not see an item of a sensitivity-inheriting database (Files) that is linked to a sensitive database the project
 * may not read, the decision of `inheritedSensitivityDeniedSql` and `assertInheritedSensitivityAccess`, which an
 * external client is not held to. A person and the system (no reader) see every item.
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
  // `getItemsByIds` leaves the items in the Trash out.
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
 * What deleting a task reaches beyond its cascade: the live instances of its series, itself included (0 for a task
 * without a series), the live attachments (`Tasks.files`, the inverse of `Files.tasks`) and the live Events it sits in
 * (`Tasks.hostEvents`). The attachments stay in Files and the Events stop showing the task. The two counts leave out
 * what the reader may not read: Files and Events are non-sensitive system databases, but a Files item inherits the
 * sensitivity of a Health record or a sleep item it is linked to (issue #1999), so an agent's project without access to
 * that database is not told the file exists. The series count is of the task's own series and is not filtered.
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
