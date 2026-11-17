import { reserveInboxTypeCards, resolveInboxTypeCardConfiguration } from "./inboxTypeCardReservation.js";
import { lockInboxSourceIfPresent } from "./inboxSourceGuard.js";
import type { PoolClient } from "pg";
import { markManagedTransactionRollbackOnly, type Queryable } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import {
  INBOX_TYPE_MODULE_TARGET_DATABASES,
  INBOX_TYPE_TARGET_DATABASES,
  type InboxTypeTargetDatabase,
} from "./inboxTypeTargets.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";

export interface InboxTypeSummary {
  id: string;
  emoji: string;
  label: string;
  /** Validated on write; `null` when the type has none. */
  processingMethod: string | null;
  targetDatabaseKey: string | null;
}

/** `journal` proposes an entry on a Journal day, which usually does not exist yet, so it has no target database or page. */
export const PROCESSING_METHODS = ["pageContent", "database", "journal"] as const;
export type ProcessingMethod = (typeof PROCESSING_METHODS)[number];

export { INBOX_TYPE_MODULE_TARGET_DATABASES, INBOX_TYPE_TARGET_DATABASES, type InboxTypeTargetDatabase };

function isProcessingMethod(value: unknown): value is ProcessingMethod {
  return (PROCESSING_METHODS as readonly unknown[]).includes(value);
}

/**
 * Cross-field validation the schema engine cannot express; called by `inboxTypeWriteHook.ts` inside the write's
 * transaction. Both fields are `select` properties, not relations, because a relation's target database is fixed at
 * property creation while this must point at any of `INBOX_TYPE_TARGET_DATABASES`.
 *
 * The arguments are the values in effect after the write (merged with the existing item on an update), never a
 * partial patch.
 */
export function assertValidProcessingConfig(resolvedMethod: unknown, resolvedTarget: unknown): void {
  if (resolvedMethod === undefined || resolvedMethod === null) {
    if (resolvedTarget !== undefined && resolvedTarget !== null) {
      throw new ValidationError("'targetDatabase' requires 'processingMethod' to be 'database'", {
        field: "targetDatabase",
      });
    }
    return;
  }
  if (!isProcessingMethod(resolvedMethod)) {
    throw new ValidationError(`'processingMethod' must be one of ${PROCESSING_METHODS.join(", ")}`, {
      field: "processingMethod",
    });
  }
  if (resolvedMethod === "database") {
    // The Journal is targeted through the `journal` method, so the refusal names it.
    if (resolvedTarget === JOURNAL_MODULE_ID) {
      throw new ValidationError(
        "processingMethod 'database' cannot target the Journal database; use processingMethod 'journal' instead",
        { field: "targetDatabase" },
      );
    }
    if (
      typeof resolvedTarget !== "string" ||
      !(INBOX_TYPE_TARGET_DATABASES as readonly string[]).includes(resolvedTarget)
    ) {
      throw new ValidationError(
        `processingMethod 'database' requires 'targetDatabase' to be one of ${INBOX_TYPE_TARGET_DATABASES.join(", ")}`,
        {
          field: "targetDatabase",
        },
      );
    }
  } else if (resolvedTarget !== undefined && resolvedTarget !== null) {
    throw new ValidationError(`processingMethod '${resolvedMethod}' must not set 'targetDatabase'`, {
      field: "targetDatabase",
    });
  }
}

export interface CreateInboxTypeInput {
  inboxItemTypesDatabaseId: string;
  name: string;
  emoji: string;
  status?: "active" | "archived";
  processingMethod: ProcessingMethod;
  targetDatabase?: InboxTypeTargetDatabase;
}

/** The processing-config check runs in the item create hook, not here. */
export async function createInboxTypeWithClient(client: PoolClient, input: CreateInboxTypeInput): Promise<ItemRow> {
  return createItemWithClient(client, {
    databaseId: input.inboxItemTypesDatabaseId,
    properties: {
      name: input.name,
      emoji: input.emoji,
      ...(input.status !== undefined ? { status: input.status } : {}),
      processingMethod: input.processingMethod,
      ...(input.targetDatabase !== undefined ? { targetDatabase: input.targetDatabase } : {}),
    },
  });
}

export interface UpdateInboxTypeInput {
  inboxItemTypesDatabaseId: string;
  itemId: string;
  propertiesPatch: Record<string, unknown>;
}

/**
 * The processing-config check runs in the item update hook against the resulting whole: patching `targetDatabase`
 * alone is valid on a `database` type and rejected on a `pageContent` one.
 */
export async function updateInboxTypeWithClient(client: PoolClient, input: UpdateInboxTypeInput): Promise<ItemRow> {
  const current = await itemsStore.getItemById(client, input.inboxItemTypesDatabaseId, input.itemId);
  if (!current) throw new NotFoundError(`Inbox item type ${input.itemId} not found`);

  return updateItemWithClient(client, {
    databaseId: input.inboxItemTypesDatabaseId,
    itemId: input.itemId,
    propertiesPatch: input.propertiesPatch,
  });
}

/** A card in these states, and therefore its source Inbox item, is never recomputed. */
export const LOCKED_PROPOSAL_STATUSES = new Set(["confirmed", "rejected"]);

export interface DeleteInboxTypeInput {
  inboxDatabaseId: string;
  inboxItemTypesDatabaseId: string;
  processingProposalsDatabaseId: string;
  typeItemId: string;
}

/**
 * Clears the `type` relation on every unlocked referencing Inbox item, so it falls into the ordinary untyped path
 * (`needsClarification`) with no special case for deleted references. Locked items (a `confirmed`/`rejected` card) are
 * left alone: they are historical, and dereferencing them would discard the record of their type.
 */
export async function deleteInboxTypeWithClient(
  client: PoolClient,
  input: DeleteInboxTypeInput,
): Promise<ItemRow | null> {
  const typeProperty = await propertiesStore.getPropertyByKey(client, input.inboxDatabaseId, "type");
  if (!typeProperty) throw new NotFoundError(`Inbox database ${input.inboxDatabaseId} has no 'type' relation property`);
  const typeRelationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, typeProperty.id);
  if (!typeRelationDefinition) throw new NotFoundError(`Property '${typeProperty.id}' has no relation definition`);

  let configuration: Awaited<ReturnType<typeof resolveInboxTypeCardConfiguration>>;
  try {
    configuration = await resolveInboxTypeCardConfiguration(client, input.processingProposalsDatabaseId);
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }

  const typeEdges = await relationsStore.listRelationsForItem(client, typeRelationDefinition.id, input.typeItemId);
  const inboxItemIds = typeEdges.map((edge) => relationsStore.otherSide(edge, input.typeItemId)).sort();

  for (const inboxItemId of inboxItemIds) {
    if (!(await lockInboxSourceIfPresent(client, inboxItemId, true))) continue;
    let cards: ItemRow[];
    try {
      cards = await reserveInboxTypeCards(client, inboxItemId, configuration);
    } catch (error) {
      markManagedTransactionRollbackOnly(client, error);
      throw error;
    }
    const locked = cards.some(
      (card) => typeof card.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(card.properties.status),
    );
    if (locked) continue;

    await deleteRelationWithClient(client, {
      relationPropertyId: typeProperty.id,
      callerItemId: inboxItemId,
      targetItemId: input.typeItemId,
    });
  }

  const item = await itemsStore.softDeleteItem(client, input.inboxItemTypesDatabaseId, input.typeItemId);
  if (!item) return null;
  await triggerOnItemEventHeartbeats(client, input.inboxItemTypesDatabaseId, "delete", input.typeItemId);
  const remainingEdges = await relationsStore.listAllRelationsForItem(client, input.typeItemId);
  for (const edge of remainingEdges) await enqueueRollupRecomputeForEdge(client, edge);
  return item;
}

/**
 * Only active types: archiving removes a type from new capture while existing items keep its id. Relations store the
 * id, never the emoji, so changing the emoji cannot break them. The target's display name is resolved by the route
 * handler.
 */
export async function listActiveInboxTypes(
  client: Queryable,
  inboxItemTypesDatabaseId: string,
): Promise<InboxTypeSummary[]> {
  const items: ItemRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await itemsStore.listItems(client, inboxItemTypesDatabaseId, {
      limit: 200,
      cursor,
      buildFilterSql: (params) => {
        params.push("active");
        return `properties ->> 'status' = $${params.length}`;
      },
    });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items.map((item) => ({
    id: item.id,
    emoji: typeof item.properties.emoji === "string" ? item.properties.emoji : "",
    label: typeof item.properties.name === "string" ? item.properties.name : "",
    processingMethod: typeof item.properties.processingMethod === "string" ? item.properties.processingMethod : null,
    targetDatabaseKey: typeof item.properties.targetDatabase === "string" ? item.properties.targetDatabase : null,
  }));
}
