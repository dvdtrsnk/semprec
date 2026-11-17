// When a task's `sourceEvents` edge to an Event is removed, its `project` and `people` value links stop naming
// that Event. The link engine only handles `on` links of live tasks; an ended link would otherwise keep the Event
// as a source and a relink would follow it again. Values are not touched and read as the task's own once the link
// is gone. Event trash needs no such step: its source detach covers links of any state. Registered after the
// engine's hook.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import {
  deleteEmptyValueLink,
  listValueLinkSourcesByLinkIds,
  lockValueLink,
  removeValueLinkItemSource,
} from "../chokePoint/valueLinksStore.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const SOURCE_EVENTS_PROPERTY_KEY = "sourceEvents";
/** In rule declaration order. */
const EVENT_SOURCED_PROPERTY_KEYS = ["project", "people"] as const;

interface TaskSourceEventsRelation {
  definitionId: string;
  taskIsItemA: boolean;
}

/** `null` in a tenant without the relation. */
async function loadTaskSourceEventsRelation(client: PoolClient): Promise<TaskSourceEventsRelation | null> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const property = tasks && (await getPropertyByKey(client, tasks.id, SOURCE_EVENTS_PROPERTY_KEY));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) return null;
  return { definitionId: definition.id, taskIsItemA: definition.propertyIdA === property.id };
}

/**
 * Removes `eventId` from the task's `project` and `people` link sources in any state, deleting links left without
 * a source. Locks each link row, `project` before `people`, as the engine's hook does. Returns whether a link lost
 * a source.
 */
async function detachEventFromLinks(client: PoolClient, taskId: string, eventId: string): Promise<boolean> {
  let detached = false;
  for (const propertyKey of EVENT_SOURCED_PROPERTY_KEYS) {
    const link = await lockValueLink(client, taskId, propertyKey);
    if (!link) continue;
    let removed = false;
    for (const source of await listValueLinkSourcesByLinkIds(client, [link.id])) {
      if (source.kind !== "item" || source.sourceItemId !== eventId) continue;
      removed = (await removeValueLinkItemSource(client, link.id, eventId, source.sourcePropertyKey)) || removed;
    }
    if (!removed) continue;
    // Deletes nothing while another source is left.
    await deleteEmptyValueLink(client, link.id);
    detached = true;
  }
  return detached;
}

/**
 * Runs after the engine's hook, which already handled `on` links of a live task; this changes the rest (ended
 * links, any link of a trashed task) and announces a live task after commit so clients re-read its links.
 */
export const taskSourceEventLinkDetachEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op !== "delete") return;
  const relation = await loadTaskSourceEventsRelation(context.client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  const taskId = relation.taskIsItemA ? context.itemA : context.itemB;
  const eventId = relation.taskIsItemA ? context.itemB : context.itemA;
  if (!(await detachEventFromLinks(context.client, taskId, eventId))) return;
  // A task in the Trash is not announced: `getItemsByIds` reads live items only.
  for (const task of await getItemsByIds(context.client, [taskId])) {
    runAfterCommit(context.client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: task.databaseId,
        itemId: task.id,
        op: "update",
        updatedAt: task.updatedAt,
      }),
    );
  }
};
