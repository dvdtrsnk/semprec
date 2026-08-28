import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
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
 * Runs as a single transaction, via the raw stores directly rather than `createChokePoint`'s
 * per-call `withTransaction` — each choke-point method commits on its own, so calling several
 * of them in sequence here (create the next instance, mark the old one done, copy relations)
 * would leave the rolling-model invariant ("only one open instance") broken by a crash or
 * error partway through, e.g. a completed process crash after the new instance is created but
 * before the old one is marked 'done' would leave both open at once. A single transaction
 * makes the whole advance all-or-nothing. This does mean rollup-recompute enqueueing (which
 * `createChokePoint`'s create/update/createRelation normally do) is not replicated here — Tasks
 * has no rollup properties in this seed, so there is nothing to recompute; onItemEvent
 * heartbeats are still triggered explicitly below, since those are a real, general concern.
 */
export async function advanceTaskRecurrence(pool: Pool, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  return withTransaction(pool, async (client) => {
    const recurrence = await getTaskRecurrence(client, input.itemId);
    if (!recurrence || !recurrence.active) return null;

    const current = await itemsStore.getItemById(client, input.databaseId, input.itemId);
    if (!current) throw new NotFoundError(`Task ${input.itemId} not found`);

    const nextDate = computeNextDueDate(recurrence.mode, recurrence.rule as unknown as TaskRecurrenceRule, input.timezone, new Date());

    const newItem = await itemsStore.insertItem(client, {
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
    await triggerOnItemEventHeartbeats(client, input.databaseId, "create", newItem.id);

    await createTaskRecurrence(client, { itemId: newItem.id, mode: recurrence.mode, rule: recurrence.rule as unknown as TaskRecurrenceRule });
    await setTaskRecurrenceActive(client, input.itemId, false);

    await copyRelationEdges(client, input.itemId, newItem.id);

    await itemsStore.updateItemProperties(client, { databaseId: input.databaseId, itemId: input.itemId, propertiesPatch: { status: "done" } });
    await triggerOnItemEventHeartbeats(client, input.databaseId, "update", input.itemId);

    return newItem;
  });
}

/** Re-links every relation edge `fromItemId` participated in onto `toItemId`, preserving edge metadata (e.g. Transcripts' `{ speaker }`). */
async function copyRelationEdges(client: PoolClient, fromItemId: string, toItemId: string): Promise<void> {
  const edges = await relationsStore.listAllRelationsForItem(client, fromItemId);
  for (const edge of edges) {
    const isItemSideA = edge.itemA === fromItemId;
    const itemA = isItemSideA ? toItemId : edge.itemA;
    const itemB = isItemSideA ? edge.itemB : toItemId;
    await relationsStore.createItemRelation(client, { relationDefinitionId: edge.relationDefinitionId, itemA, itemB, metadata: edge.metadata });
  }
}
