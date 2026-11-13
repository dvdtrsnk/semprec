// Issue #1781: the Tasks update hook that keeps the protected edge `Tasks.completedInEvent` (inverse
// `Events.completedTasks`, issue #1540) in line with the status of a task. Registered in `../domainWriteHooks.ts`
// (docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md); it runs in the transaction of the
// status write, after the choke point has locked the task row and after the Tasks pre-write transform.
import type { PoolClient } from "pg";
import { getCalendarClock } from "../calendarTime.js";
import type { ItemUpdateHook } from "../chokePoint/hooks.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, readLiveHostEvents } from "./taskHostEventState.js";

const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/** The system context of the Tasks process: the only writer of the relation, which a generic edge write refuses. */
const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

/**
 * The statuses a task takes when it is open or given up again. A write that names one removes the task's
 * `completedInEvent` edge. `missed` is here because the Tasks transform turns a `notDone` write that reopens an
 * occurrence of a series whose next date has come into `missed` (issue #1668): the write the caller made was
 * `notDone`, and the task is no longer done either way.
 */
const NOT_COMPLETED_STATUSES: readonly unknown[] = ["notDone", "wontDo", "missed"];

/** The Tasks-side property of the relation and its definition. */
interface CompletedInEventRelation {
  propertyId: string;
  definitionId: string;
}

/** The relation of the Tasks database `tasksDatabaseId`, or `null` in a tenant whose Tasks database lacks it. */
async function loadCompletedInEventRelation(
  client: PoolClient,
  tasksDatabaseId: string,
): Promise<CompletedInEventRelation | null> {
  const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, COMPLETED_IN_EVENT_KEY);
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  return property && definition ? { propertyId: property.id, definitionId: definition.id } : null;
}

/**
 * The event a completion made now belongs to: the last live host event of the task by the edge's `addedAt` among
 * those that have a `date` (an event without a date is no host event for the task, as for its visibility in
 * `taskHostEventState.ts`), provided its end is later than now. `null` when the task has none or that event has ended.
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
 * After a write of a task that names `status`:
 *
 * - `done`, when the write moves the task into `done` (the Tasks transform stores `completedAt` with exactly that
 *   move, so a repeated `done` carries none) and the task has no `completedInEvent` edge: the edge to the event of
 *   the completion (`eventOfCompletion`) is created, when there is one. A completion made once that event has ended,
 *   or by a task in no event, writes no edge.
 * - `notDone`, `wontDo` or `missed`: the task's `completedInEvent` edge is deleted, when it has one.
 *
 * The hook writes the edge only, never a property of the task. The edge is written through the relation operations
 * as the Tasks process, in the transaction of the status write, so its realtime announcements follow the commit and a
 * refused edge write rolls the status write back with it. A tenant whose Tasks database has no `completedInEvent`
 * property is left alone.
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
    // The edge was just listed under the task's row lock; a delete that finds it already gone has nothing left to do.
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
