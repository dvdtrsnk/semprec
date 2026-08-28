import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, createRelationWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import type { ItemRow } from "../types.js";
import { computeNextDueDate } from "./nextDueDate.js";
import { createTaskRecurrence, getTaskRecurrence, setTaskRecurrenceActive } from "./taskRecurrenceStore.js";

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
 * Every item/relation write goes through the choke-point's own logic — `createItemWithClient`
 * / `updateItemWithClient` / `createRelationWithClient` (chokePoint.ts), the same functions
 * `createChokePoint(...)`'s public `createItem`/`updateItem`/`createRelation` are thin
 * wrappers over — so idempotency handling, ownership checks, onItemEvent heartbeat
 * triggering, and rollup-recompute enqueueing all still happen exactly as they would through
 * the public API. The one difference is transactional scope: `createChokePoint`'s wrappers
 * each open and commit their own transaction, which here would let a crash or error partway
 * through this multi-step advance (new instance created, but the old one never marked done)
 * leave two open instances of the same recurring task — breaking the rolling model's
 * invariant. Composing the client-scoped versions inside one `withTransaction` instead makes
 * the whole advance atomic.
 */
export async function advanceTaskRecurrence(pool: Pool, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  return withTransaction(pool, async (client) => {
    // Row-locked: two concurrent advances of the same task must not both observe
    // `active: true` and both create a next instance — the second blocks here until the
    // first commits (active now false, so it correctly no-ops) or rolls back.
    const recurrence = await getTaskRecurrence(client, input.itemId, true);
    if (!recurrence || !recurrence.active) return null;

    const current = await itemsStore.getItemById(client, input.databaseId, input.itemId);
    if (!current) throw new NotFoundError(`Task ${input.itemId} not found`);

    const nextDate = computeNextDueDate(recurrence.mode, recurrence.rule, input.timezone, new Date());

    const newItem = await createItemWithClient(client, {
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

    await createTaskRecurrence(client, { itemId: newItem.id, mode: recurrence.mode, rule: recurrence.rule });
    await setTaskRecurrenceActive(client, input.itemId, false);

    await copyRelationEdges(client, input.itemId, newItem.id);

    await updateItemWithClient(client, { databaseId: input.databaseId, itemId: input.itemId, propertiesPatch: { status: "done" } });

    return newItem;
  });
}

/** Re-links every relation edge `fromItemId` participated in onto `toItemId`, preserving edge metadata (e.g. Transcripts' `{ speaker }`). */
async function copyRelationEdges(client: PoolClient, fromItemId: string, toItemId: string): Promise<void> {
  const edges = await relationsStore.listAllRelationsForItem(client, fromItemId);
  for (const edge of edges) {
    const reldef = await relationsStore.getRelationDefinition(client, edge.relationDefinitionId);
    if (!reldef) continue;
    const newItemA = edge.itemA === fromItemId ? toItemId : edge.itemA;
    const newItemB = edge.itemB === fromItemId ? toItemId : edge.itemB;
    // propertyIdA always exists (NOT NULL in the schema); anchoring on it — and passing the
    // desired itemA/itemB straight through as itemId/targetItemId — works regardless of
    // which side `fromItemId` was actually on, including a one-directional relation where
    // only side A has a property (e.g. Events -> Tasks "actionItems", propertyIdB null).
    // Picking propertyIdA/propertyIdB based on which side fromItemId was on, and skipping
    // when that side's property is null, would silently drop exactly that case.
    await createRelationWithClient(client, { relationPropertyId: reldef.propertyIdA, itemId: newItemA, targetItemId: newItemB, metadata: edge.metadata });
  }
}
