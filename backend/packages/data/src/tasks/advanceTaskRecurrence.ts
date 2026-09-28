import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { assertValidTimezone } from "../timezone.js";
import type { ItemRow } from "../types.js";
import { computeNextDueDate } from "./nextDueDate.js";
import { createTaskRecurrence, getTaskRecurrence, setTaskRecurrenceActive } from "./taskRecurrenceStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** The Tasks module's own process identity — proves ownership when `copyRelationEdges` re-links an edge whose property happens to be `owner: 'system'` (none exist on Tasks today, but the check must hold regardless). */
const TASKS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: TASKS_MODULE_ID };

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
 * Opens its own transaction around `advanceTaskRecurrenceWithClient` plus the `done` write.
 * That `done` write re-enters the choke point's Tasks hook (`updateItemWithClient`), which
 * finds the recurrence already deactivated in this same transaction and no-ops.
 */
export async function advanceTaskRecurrence(pool: Pool, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  return withTransaction(pool, async (client) => {
    const next = await advanceTaskRecurrenceWithClient(client, input);
    await updateItemWithClient(client, {
      databaseId: input.databaseId,
      itemId: input.itemId,
      propertiesPatch: { status: "done" },
    });
    return next;
  });
}

/**
 * The advance itself, run inside the caller's transaction — the choke point's `status: 'done'`
 * write calls it so the `done` write and the next instance commit or roll back together. It
 * does not mark the old task `done`; the caller's own write does that.
 *
 * Every item/relation write goes through the choke-point's own logic — `createItemWithClient`
 * / `createRelationWithClient` — so idempotency handling, ownership checks, onItemEvent
 * heartbeat triggering, and rollup-recompute enqueueing all still happen exactly as they would
 * through the public API, while sharing the caller's transaction keeps a crash partway through
 * from leaving two open instances of the same recurring task.
 */
export async function advanceTaskRecurrenceWithClient(
  client: PoolClient,
  input: AdvanceTaskRecurrenceInput,
): Promise<ItemRow | null> {
  // Row-locked: two concurrent advances of the same task must not both observe
  // `active: true` and both create a next instance — the second blocks here until the
  // first commits (active now false, so it correctly no-ops) or rolls back.
  const recurrence = await getTaskRecurrence(client, input.itemId, true);
  if (!recurrence || !recurrence.active) return null;

  const current = await itemsStore.getItemById(client, input.databaseId, input.itemId);
  if (!current) throw new NotFoundError(`Task ${input.itemId} not found`);

  assertValidTimezone(input.timezone);
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

  return newItem;
}

/**
 * Re-links every relation edge `fromItemId` participated in onto `toItemId`, preserving edge
 * metadata (e.g. Transcripts' `{ speaker }`). Skips an edge whose counterpart item (the side
 * that isn't being replaced) has been soft-deleted since the edge was created — the advance
 * must not fail over one stale link; it simply drops that edge, the same as if it had never
 * existed, rather than letting `createRelationWithClient`'s endpoint validation abort the
 * whole recurrence transaction.
 */
async function copyRelationEdges(client: PoolClient, fromItemId: string, toItemId: string): Promise<void> {
  const edges = await relationsStore.listAllRelationsForItem(client, fromItemId);
  for (const edge of edges) {
    const reldef = await relationsStore.getRelationDefinition(client, edge.relationDefinitionId);
    if (!reldef) continue;
    // propertyIdA always exists (NOT NULL in the schema); anchoring on it — and passing the
    // desired itemA/itemB straight through as itemId/targetItemId — works regardless of
    // which side `fromItemId` was actually on, including a one-directional relation where
    // only side A has a property (e.g. Events -> Tasks "actionItems", propertyIdB null).
    // Picking propertyIdA/propertyIdB based on which side fromItemId was on, and skipping
    // when that side's property is null, would silently drop exactly that case.
    const propertyA = await propertiesStore.getProperty(client, reldef.propertyIdA);
    if (!propertyA) continue;
    const targetDatabaseId = (propertyA.config as { targetDatabaseId?: unknown }).targetDatabaseId;
    if (typeof targetDatabaseId !== "string") continue;

    const counterpartIsItemA = edge.itemA !== fromItemId;
    const counterpartId = counterpartIsItemA ? edge.itemA : edge.itemB;
    const counterpartDatabaseId = counterpartIsItemA ? propertyA.databaseId : targetDatabaseId;
    const counterpart = await itemsStore.getItemById(client, counterpartDatabaseId, counterpartId);
    if (!counterpart || counterpart.deletedAt) continue;

    const newItemA = edge.itemA === fromItemId ? toItemId : edge.itemA;
    const newItemB = edge.itemB === fromItemId ? toItemId : edge.itemB;
    await createRelationWithClient(
      client,
      {
        relationPropertyId: reldef.propertyIdA,
        callerItemId: newItemA,
        targetItemId: newItemB,
        metadata: edge.metadata,
      },
      TASKS_RELATION_CONTEXT,
    );
  }
}
