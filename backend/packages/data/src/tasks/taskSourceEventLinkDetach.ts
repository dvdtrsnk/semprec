// Issue #1724: a task's `project` and `people` value links stop naming an Event once the task's
// `sourceEvents` edge to that Event is removed. The link engine removes the Event only from a link that
// is `on`, and only while the task is not in the Trash; a link the user or Semp had ended would keep
// naming it, so the value would read as inherited from an Event the task has no edge to, and a relink
// would make the task follow that Event again. The hook below detaches the Event from the links of any
// state in the transaction that removes the edge. The values are not touched and read as the task's own
// once the link is gone.
// The trash of an Event needs no such step: the source detach of issue #1656 covers links of any state.
// Registered in `../domainWriteHooks.ts`, after the engine's hook. Constrained by:
// docs/adr/2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
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
/** The Tasks properties whose value link names a source Event as its source, in the order their rules are declared. */
const EVENT_SOURCED_PROPERTY_KEYS = ["project", "people"] as const;

interface TaskSourceEventsRelation {
  definitionId: string;
  /** Whether the task is `itemA` of the relation's edges; the Event is the other item. */
  taskIsItemA: boolean;
}

/** The Tasks `sourceEvents` relation of the caller's tenant, or `null` in a tenant without it. */
async function loadTaskSourceEventsRelation(client: PoolClient): Promise<TaskSourceEventsRelation | null> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const property = tasks && (await getPropertyByKey(client, tasks.id, SOURCE_EVENTS_PROPERTY_KEY));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) return null;
  return { definitionId: definition.id, taskIsItemA: definition.propertyIdA === property.id };
}

/**
 * Removes `eventId` from the sources of the task's `project` and `people` value links, whatever their
 * state, and deletes a link that is left without a source; a link another source Event still feeds
 * stays, with its state. Each link row is locked first, `project` before `people`, as the engine's hook
 * locks them. Returns whether a link lost a source.
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
    // Deletes nothing when another source is left: that link stays, with the sources it still has.
    await deleteEmptyValueLink(client, link.id);
    detached = true;
  }
  return detached;
}

/**
 * After a Tasks `sourceEvents` edge was removed (issue #1530's hook), written from the task or from
 * `Events.actionItems`: detaches the Event from the task's `project` and `people` links. The engine's
 * hook, registered before this one, has by then handled the links of a live task that are `on`. This
 * one changes what is left, a link that was ended and any link of a task in the Trash, and tells
 * clients about a live task after the commit, so they read its links again.
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
