// Write hooks keeping a task's stored host state current, each inside the triggering write's transaction. The
// third trigger (create and writes of the task's own `date`) is the Tasks pre-write transform.
import type { ItemUpdateHook, RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, recomputeTaskHostState } from "./taskHostEventState.js";

/** The Event properties its end and day come from. */
const EVENT_SCHEDULE_KEYS = ["date", "endDate", "timeFrom", "timeTo", "time"] as const;

/** Recomputes the task on a created, updated or removed host-event edge; other relations are ignored. */
export const taskHostEventEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  const relation = await loadHostEventsRelation(context.client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  await recomputeTaskHostState(context.client, relation.taskIsItemA ? context.itemA : context.itemB);
};

/**
 * Recomputes every live task in the Event, in task id order, when a schedule key is named. Whether the value
 * changed is not checked; a recomputation with nothing to change writes nothing.
 */
export const taskHostEventScheduleItemUpdateHook: ItemUpdateHook = async ({
  client,
  database,
  item,
  propertiesPatch,
}) => {
  if (database.ownerModuleId !== EVENTS_MODULE_ID) return;
  if (!EVENT_SCHEDULE_KEYS.some((key) => Object.hasOwn(propertiesPatch, key))) return;
  const relation = await loadHostEventsRelation(client);
  if (!relation) return;
  const edges = await relationsStore.listRelationsForItem(client, relation.definitionId, item.id);
  const taskIds = edges.map((edge) => relationsStore.otherSide(edge, item.id)).sort();
  for (const taskId of taskIds) await recomputeTaskHostState(client, taskId);
};
