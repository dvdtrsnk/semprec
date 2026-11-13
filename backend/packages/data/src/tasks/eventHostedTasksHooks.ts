// Issue #1819: what the trash and the restore of an Event do to the tasks that sit in it (`Events.hostedTasks`, the
// inverse of `Tasks.hostEvents`, issue #1764). Both hooks run in the transaction of the cascade that trashes or
// restores the Event (docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md) and are registered in
// `../domainWriteHooks.ts`. The `completedInEvent` edges are never touched.
import type { PoolClient } from "pg";
import type { ItemDeleteHook, ItemRestoreHook } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, recomputeTaskHostState } from "./taskHostEventState.js";
import { readHostedTasks, type HostedTask } from "./taskStateInEvent.js";

/** The Events-side key of the relation; its inverse on Tasks is `hostEvents` (issue #1540). */
const HOSTED_TASKS_KEY = "hostedTasks";

/** The system context of the Tasks process: the only writer of the relation, which a generic edge write refuses. */
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

/**
 * The live tasks the Event holds an edge to, read from the Event's edges. The Event may be in the Trash: its edges
 * stay stored. Ordered by task id, the order in which the hooks lock the tasks.
 */
async function readHostedTasksOfEvent(client: PoolClient, eventId: string): Promise<HostedTask[]> {
  const relation = await loadHostEventsRelation(client);
  const hosted = (await readHostedTasks(client, relation, [eventId])).get(eventId) ?? [];
  return [...hosted].sort((a, b) => (a.task.id < b.task.id ? -1 : 1));
}

/**
 * The number of tasks that return to their day when the Event is deleted: the live tasks the Event holds an edge to
 * that are not completed in it. Read by the same reader as the counts of `GET /api/events/:id/tasks`, so it gives
 * the same answer for a live Event and for one in the Trash. An id that names no Event, and a tenant without the
 * relation, give 0.
 */
export async function countTasksReturningFromEvent(client: PoolClient, eventId: string): Promise<number> {
  const hosted = await readHostedTasksOfEvent(client, eventId);
  return hosted.filter((row) => !row.completedInEventIds.includes(eventId)).length;
}

/**
 * After an Event was trashed: every live task it hosts is recomputed with `recomputeTaskHostState`, in the order of
 * the task ids, in the cascade's transaction. The Event is already in the Trash, so it no longer counts as a host
 * event, and each task returns to the day decided by the host event added before it, or to its own date when there
 * is none. The edges stay, so the Event still lists the tasks that return while it is in the Trash. An Event that
 * hosts no live task causes no write. A rejection of a recomputation rolls the trash back.
 */
export const eventHostedTasksDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!database.system || database.ownerModuleId !== EVENTS_MODULE_ID) return;
  for (const { task } of await readHostedTasksOfEvent(client, item.id)) {
    await recomputeTaskHostState(client, task.id);
  }
};

/**
 * After an Event was restored: the edge to each live task it hosts is deleted, as the Tasks process and in the
 * cascade's transaction, so restoring the Event does not put the tasks back into it. Each deletion recomputes the
 * task through the edge hook of issue #1780. An edge to a task that is in the Trash stays. An Event that hosts no live
 * task causes no write. A rejection of a deletion rolls the restore back.
 *
 * Lock order: every hosted task is locked, in the order of the task ids, before the first edge is deleted, and a task
 * that is missing or in the Trash after its lock keeps its edge. The routes of issue #1764 lock the task and then write
 * its edge; deleting an edge first and locking the task in the edge hook would take the two rows in the opposite order
 * and could deadlock with them (docs/adr/2026-11-13-event-trash-and-restore-write-the-tasks-they-host.md).
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
