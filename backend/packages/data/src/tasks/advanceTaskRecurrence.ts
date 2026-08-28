import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { ChokePoint } from "../chokePoint/chokePoint.js";
import type { ItemRow } from "../types.js";
import { computeNextDueDate } from "./nextDueDate.js";
import { createTaskRecurrence, getTaskRecurrence, setTaskRecurrenceActive } from "./taskRecurrenceStore.js";
import type { TaskRecurrenceRule } from "./taskRecurrenceRule.js";

export interface AdvanceTaskRecurrenceInput {
  databaseId: string;
  itemId: string;
  timezone: string;
}

/**
 * The rolling model (issue #24): at any moment only one open instance of a recurring task
 * exists. Completing it (marking it 'done') creates the next instance and carries forward
 * its name/time/notification/persistent properties and every relation edge it participated
 * in (e.g. its Projects link) — not just the recurrence rule itself. Returns `null` (no-op)
 * when the completed item has no active recurrence, which is the common case.
 *
 * Writes item state exclusively through `chokePoint` (createItem/updateItem/createRelation);
 * `task_recurrence` itself is not item/database state, so it is written directly, the same
 * way `project_heartbeats` is via schedulerStore.ts.
 */
export async function advanceTaskRecurrence(pool: Pool, chokePoint: ChokePoint, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  const recurrence = await withTransaction(pool, (client) => getTaskRecurrence(client, input.itemId));
  if (!recurrence || !recurrence.active) return null;

  const current = await chokePoint.getItem(input.databaseId, input.itemId);
  if (!current) throw new NotFoundError(`Task ${input.itemId} not found`);

  const nextDate = computeNextDueDate(recurrence.mode, recurrence.rule as unknown as TaskRecurrenceRule, input.timezone, new Date());

  const newItem = await chokePoint.createItem({
    databaseId: input.databaseId,
    properties: {
      name: current.properties.name,
      status: "notDone",
      date: nextDate,
      timeFrom: current.properties.timeFrom ?? null,
      timeTo: current.properties.timeTo ?? null,
      notifications: current.properties.notifications ?? false,
      persistent: current.properties.persistent ?? false,
    },
  });

  await withTransaction(pool, async (client) => {
    await createTaskRecurrence(client, { itemId: newItem.id, mode: recurrence.mode, rule: recurrence.rule as unknown as TaskRecurrenceRule });
    await setTaskRecurrenceActive(client, input.itemId, false);
  });

  const edges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, input.itemId));
  for (const edge of edges) {
    const reldef = await withTransaction(pool, (client) => relationsStore.getRelationDefinition(client, edge.relationDefinitionId));
    if (!reldef) continue;
    const isItemSideA = edge.itemA === input.itemId;
    const relationPropertyId = isItemSideA ? reldef.propertyIdA : reldef.propertyIdB;
    if (!relationPropertyId) continue;
    const targetItemId = relationsStore.otherSide(edge, input.itemId);
    await chokePoint.createRelation({ relationPropertyId, itemId: newItem.id, targetItemId, metadata: edge.metadata });
  }

  await chokePoint.updateItem({ databaseId: input.databaseId, itemId: input.itemId, propertiesPatch: { status: "done" } });

  return newItem;
}
