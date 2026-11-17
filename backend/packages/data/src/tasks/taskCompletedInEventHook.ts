// Keeps the protected edge `Tasks.completedInEvent` (inverse `Events.completedTasks`) in line with a task's status.
// Runs in the status write's transaction, after the choke point locked the task row and after the Tasks transform.
import type { PoolClient } from "pg";
import { getCalendarClock } from "../calendarTime.js";
import type { ItemUpdateHook } from "../chokePoint/hooks.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, readLiveHostEvents } from "./taskHostEventState.js";

const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/** The only writer of the relation; a generic edge write refuses it. */
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

/**
 * Statuses that remove the `completedInEvent` edge. `missed` is included because the Tasks transform turns a
 * reopening `notDone` write on a past series occurrence into `missed`.
 */
const NOT_COMPLETED_STATUSES: readonly unknown[] = ["notDone", "wontDo", "missed"];

interface CompletedInEventRelation {
  propertyId: string;
  definitionId: string;
}

/** `null` when the tenant's Tasks database lacks the relation. */
async function loadCompletedInEventRelation(
  client: PoolClient,
  tasksDatabaseId: string,
): Promise<CompletedInEventRelation | null> {
  const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, COMPLETED_IN_EVENT_KEY);
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  return property && definition ? { propertyId: property.id, definitionId: definition.id } : null;
}

/**
 * The last live dated host event by `addedAt` (undated events are no hosts), provided it has not ended; else `null`.
 */
async function eventOfCompletion(client: PoolClient, taskId: string): Promise<string | null> {
  const relation = await loadHostEventsRelation(client);
  if (!relation) return null;
  const hostEvents = await readLiveHostEvents(client, relation, taskId);
  let last: { eventId: string; date: string; endDate: string | null; timeTo: string | null } | null = null;
  for (const hostEvent of hostEvents) {
    if (hostEvent.date !== null) last = { ...hostEvent, date: hostEvent.date };
  }
  if (last === null) return null;
  const clock = await getCalendarClock(client);
  return clock.eventEnd(last).toMillis() > Date.now() ? last.eventId : null;
}

/**
 * After a write naming `status`:
 *
 * - A move into `done` (the transform stores `completedAt` only then) without an edge creates the edge to the
 *   event of the completion, if any.
 * - `notDone`, `wontDo` or `missed` deletes the edge, if any.
 *
 * Only the edge is written, as the Tasks process in the status write's transaction, so announcements follow the
 * commit and a refused edge write rolls the status back. A Tasks database without the property is left alone.
 */
export const taskCompletedInEventHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== TASKS_MODULE_ID || !Object.hasOwn(propertiesPatch, "status")) return;
  const { status } = propertiesPatch;
  const enteringDone = status === "done" && typeof propertiesPatch.completedAt === "string";
  if (!enteringDone && !NOT_COMPLETED_STATUSES.includes(status)) return;
  const relation = await loadCompletedInEventRelation(client, database.id);
  if (!relation) return;
  const edges = await relationsStore.listRelationsForItem(client, relation.definitionId, item.id);
  if (enteringDone) {
    if (edges.length > 0) return;
    const eventId = await eventOfCompletion(client, item.id);
    if (eventId === null) return;
    await createRelationWithClient(
      client,
      { relationPropertyId: relation.propertyId, callerItemId: item.id, targetItemId: eventId },
      TASKS_CONTEXT,
    );
    return;
  }
  for (const edge of edges) {
    // Listed under the task's row lock; a delete finding it gone has nothing to do.
    await deleteRelationWithClient(
      client,
      {
        relationPropertyId: relation.propertyId,
        callerItemId: item.id,
        targetItemId: relationsStore.otherSide(edge, item.id),
      },
      TASKS_CONTEXT,
    );
  }
};
