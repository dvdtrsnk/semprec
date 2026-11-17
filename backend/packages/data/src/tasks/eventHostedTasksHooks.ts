// What trashing and restoring an Event do to the tasks it hosts (`Events.hostedTasks`). Both hooks run in the
// cascade's transaction. `completedInEvent` edges are never touched.
import type { PoolClient } from "pg";
import type { ItemDeleteHook, ItemRestoreHook } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, recomputeTaskHostState } from "./taskHostEventState.js";
import { readHostedTasks, type HostedTask } from "./taskStateInEvent.js";

/** Its inverse on Tasks is `hostEvents`. */
const HOSTED_TASKS_KEY = "hostedTasks";

/** The only writer of the relation; a generic edge write refuses it. */
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

/** The Event may be trashed: its edges stay. Ordered by task id, the order the hooks lock the tasks in. */
async function readHostedTasksOfEvent(client: PoolClient, eventId: string): Promise<HostedTask[]> {
  const relation = await loadHostEventsRelation(client);
  const hosted = (await readHostedTasks(client, relation, [eventId])).get(eventId) ?? [];
  return [...hosted].sort((a, b) => (a.task.id < b.task.id ? -1 : 1));
}

/**
 * Live hosted tasks not completed in the Event, via the same reader as `GET /api/events/:id/tasks`, so live and
 * trashed Events answer alike. 0 for an unknown id or a tenant without the relation.
 */
export async function countTasksReturningFromEvent(client: PoolClient, eventId: string): Promise<number> {
  const hosted = await readHostedTasksOfEvent(client, eventId);
  return hosted.filter((row) => !row.completedInEventIds.includes(eventId)).length;
}

/**
 * Recomputes every live hosted task in task id order. The trashed Event no longer counts as a host, so each
 * task returns to the previous host's day or its own date. Edges stay, so the trashed Event still lists them. A
 * failed recomputation rolls the trash back.
 */
export const eventHostedTasksDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== EVENTS_MODULE_ID) return;
  for (const { task } of await readHostedTasksOfEvent(client, item.id)) {
    await recomputeTaskHostState(client, task.id);
  }
};

/**
 * Deletes the edge to each live hosted task as the Tasks process, so restoring the Event does not put tasks back
 * into it; each deletion recomputes the task through the edge hook. Edges to trashed tasks stay. A failed
 * deletion rolls the restore back.
 *
 * Lock order: all hosted tasks are locked in id order before the first edge is deleted. The host-event routes lock
 * the task then write the edge; the reverse order here could deadlock with them.
 */
export const eventHostedTasksRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== EVENTS_MODULE_ID) return;
  const property = await propertiesStore.getPropertyByKey(client, database.id, HOSTED_TASKS_KEY);
  if (!property) return;
  const hosted = await readHostedTasksOfEvent(client, item.id);
  const locked: string[] = [];
  for (const { task } of hosted) {
    const current = await itemsStore.lockItemById(client, task.databaseId, task.id);
    if (current && !current.deletedAt) locked.push(current.id);
  }
  for (const taskId of locked) {
    await deleteRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: item.id, targetItemId: taskId },
      TASKS_CONTEXT,
    );
  }
};
