// Issue #1780: the write hooks that keep a task's stored host state (`hiddenUntil`, `effectiveDate`) current. Each
// runs inside the triggering write's transaction. The third trigger, a write of the task's own `date` and the
// create, is the Tasks pre-write transform (`taskPreWriteTransform.ts`). Registered in `../domainWriteHooks.ts`
// (docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md). See
// docs/adr/2026-11-12-task-host-state-is-recomputed-in-the-writing-transaction.md.
import type { ItemUpdateHook, RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelation, recomputeTaskHostState } from "./taskHostEventState.js";

/** The Events properties the end and the day of an Event come from: its start and end day and times, and the derived `time`. */
const EVENT_SCHEDULE_KEYS = ["date", "endDate", "timeFrom", "timeTo", "time"] as const;

/**
 * After a `Tasks.hostEvents` / `Events.hostedTasks` edge was created, updated or removed (issue #1530's hook): the
 * task on that edge is recomputed. An edge of another relation is left alone.
 */
export const taskHostEventEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  const relation = await loadHostEventsRelation(context.client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  await recomputeTaskHostState(context.client, relation.taskIsItemA ? context.itemA : context.itemB);
};

/**
 * After a write of an Event that names `date`, `endDate`, `timeFrom`, `timeTo` or the derived `time`: every task
 * that sits in the Event is recomputed, in the order of the task ids. A task in the Trash is left alone. The hook
 * does not look at whether the value changed; a recomputation that finds nothing to change writes nothing.
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
