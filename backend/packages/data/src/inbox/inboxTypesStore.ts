import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, deleteRelationWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import { TEN_DATABASE_MODULE_IDS, type TenDatabaseModuleId } from "../seed/tenDatabaseKeys.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

export interface InboxTypeSummary {
  id: string;
  emoji: string;
  label: string;
}

/** An Inbox item type's processing method (issue #102) — replaces the mock's hardcoded label-text comparison. */
export const PROCESSING_METHODS = ["pageContent", "database"] as const;
export type ProcessingMethod = (typeof PROCESSING_METHODS)[number];

/**
 * Cross-field validation for `processingMethod`/`targetDatabase` — the schema engine has no
 * generic cross-field concept (see chokePoint.ts's `assertWritableProperties`), the same
 * reason `inboxStore.ts`'s `createInboxItemWithClient` hand-validates `date`/`time`.
 * `processingMethod` and `targetDatabase` are both `select` properties (not `relation` — a
 * relation's target database is fixed at property-creation time, but this must point at any
 * one of the ten hardcoded databases; see seedInboxPipeline.ts's comment), so nothing about
 * the generic write path enforces their combination either.
 *
 * `resolvedMethod`/`resolvedTarget` are the values that would be in effect *after* the write
 * (already merged with the existing item on an update) — this only judges that final state,
 * never a partial patch in isolation.
 */
function assertValidProcessingConfig(resolvedMethod: unknown, resolvedTarget: unknown): void {
  if (resolvedMethod === undefined || resolvedMethod === null) {
    if (resolvedTarget !== undefined && resolvedTarget !== null) {
      throw new ValidationError("'targetDatabase' requires 'processingMethod' to be 'database'", { field: "targetDatabase" });
    }
    return;
  }
  if (!(PROCESSING_METHODS as readonly unknown[]).includes(resolvedMethod)) {
    throw new ValidationError(`'processingMethod' must be one of ${PROCESSING_METHODS.join(", ")}`, { field: "processingMethod" });
  }
  if (resolvedMethod === "database") {
    if (typeof resolvedTarget !== "string" || !(TEN_DATABASE_MODULE_IDS as readonly string[]).includes(resolvedTarget)) {
      throw new ValidationError(`processingMethod 'database' requires 'targetDatabase' to be one of ${TEN_DATABASE_MODULE_IDS.join(", ")}`, {
        field: "targetDatabase",
      });
    }
  } else if (resolvedTarget !== undefined && resolvedTarget !== null) {
    throw new ValidationError("processingMethod 'pageContent' must not set 'targetDatabase'", { field: "targetDatabase" });
  }
}

export interface CreateInboxTypeInput {
  inboxItemTypesDatabaseId: string;
  name: string;
  emoji: string;
  status?: "active" | "archived";
  processingMethod: ProcessingMethod;
  targetDatabase?: TenDatabaseModuleId;
}

/** The Inbox item type creation logic (issue #102), mirroring `inbox/inboxStore.ts`'s `createInboxItemWithClient`. */
export async function createInboxTypeWithClient(client: PoolClient, input: CreateInboxTypeInput): Promise<ItemRow> {
  assertValidProcessingConfig(input.processingMethod, input.targetDatabase);

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
 * The Inbox item type update logic (issue #102). Merges the patch onto the item's current
 * `processingMethod`/`targetDatabase` before validating, so a patch that only touches one of
 * the two fields is judged against the resulting whole, not the patch in isolation — e.g.
 * patching `targetDatabase` alone on a type that is already `processingMethod: 'database'`
 * is valid; patching it alone on a `pageContent` type is rejected.
 */
export async function updateInboxTypeWithClient(client: PoolClient, input: UpdateInboxTypeInput): Promise<ItemRow> {
  const current = await itemsStore.getItemById(client, input.inboxItemTypesDatabaseId, input.itemId);
  if (!current) throw new NotFoundError(`Inbox item type ${input.itemId} not found`);

  const resolvedMethod = "processingMethod" in input.propertiesPatch ? input.propertiesPatch.processingMethod : current.properties.processingMethod;
  const resolvedTarget = "targetDatabase" in input.propertiesPatch ? input.propertiesPatch.targetDatabase : current.properties.targetDatabase;
  assertValidProcessingConfig(resolvedMethod, resolvedTarget);

  return updateItemWithClient(client, {
    databaseId: input.inboxItemTypesDatabaseId,
    itemId: input.itemId,
    propertiesPatch: input.propertiesPatch,
  });
}

/** Processing proposal states in which the card, and therefore its source Inbox item, is never recomputed again (issue #100's "a locked card is never recomputed again"). */
const LOCKED_PROPOSAL_STATUSES = new Set(["confirmed", "rejected"]);

export interface DeleteInboxTypeInput {
  inboxDatabaseId: string;
  inboxItemTypesDatabaseId: string;
  processingProposalsDatabaseId: string;
  typeItemId: string;
}

/**
 * Deletes an Inbox item type (issue #102). Per the epic (#100): "Deleting a type that
 * existing Inbox items still reference does not leave those items dangling with a dead
 * reference — they fall into the same path as an item with no type at all... no
 * special-case handling code just for deleted references, just reuse of the existing
 * 'unknown type' mechanism." Concretely: this clears the `type` relation on every
 * referencing Inbox item that is not locked, so the item becomes indistinguishable from
 * one that never had a type — the same untyped state `createInboxItemWithClient` already
 * treats as valid and which later (issue #103) enters `needsClarification`.
 *
 * A locked Inbox item — one with a `confirmed`/`rejected` Processing proposal card, per
 * the epic's "a locked card is never recomputed again" — is left alone: it is already
 * fully processed and historical, so dereferencing it would serve no purpose and would
 * discard the record of what type it actually was.
 */
export async function deleteInboxTypeWithClient(client: PoolClient, input: DeleteInboxTypeInput): Promise<ItemRow | null> {
  const typeProperty = await propertiesStore.getPropertyByKey(client, input.inboxDatabaseId, "type");
  if (!typeProperty) throw new NotFoundError(`Inbox database ${input.inboxDatabaseId} has no 'type' relation property`);
  const typeRelationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, typeProperty.id);
  if (!typeRelationDefinition) throw new NotFoundError(`Property '${typeProperty.id}' has no relation definition`);

  const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, input.processingProposalsDatabaseId, "sourceInbox");
  if (!sourceInboxProperty) throw new NotFoundError(`Processing proposals database ${input.processingProposalsDatabaseId} has no 'sourceInbox' relation property`);
  const sourceInboxRelationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty.id);
  if (!sourceInboxRelationDefinition) throw new NotFoundError(`Property '${sourceInboxProperty.id}' has no relation definition`);

  const typeEdges = await relationsStore.listRelationsForItem(client, typeRelationDefinition.id, input.typeItemId);
  for (const edge of typeEdges) {
    const inboxItemId = relationsStore.otherSide(edge, input.typeItemId);

    const proposalEdges = await relationsStore.listRelationsForItem(client, sourceInboxRelationDefinition.id, inboxItemId);
    let locked = false;
    for (const proposalEdge of proposalEdges) {
      const proposalItemId = relationsStore.otherSide(proposalEdge, inboxItemId);
      const proposal = await itemsStore.getItemById(client, input.processingProposalsDatabaseId, proposalItemId);
      if (proposal && typeof proposal.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(proposal.properties.status)) {
        locked = true;
        break;
      }
    }
    if (locked) continue;

    await deleteRelationWithClient(client, { relationPropertyId: typeProperty.id, itemId: inboxItemId, targetItemId: input.typeItemId });
  }

  const item = await itemsStore.softDeleteItem(client, input.inboxItemTypesDatabaseId, input.typeItemId);
  if (!item) return null;
  await triggerOnItemEventHeartbeats(client, input.inboxItemTypesDatabaseId, "delete", input.typeItemId);
  return item;
}

/**
 * The data behind `GET /api/inbox-types` (issue #101; no HTTP layer exists yet in this repo
 * to mount it on — see backend/services' "empty until its issue" convention). Returns only
 * active types: archiving a type (issue #102) removes it from new capture while existing
 * Inbox items keep pointing at its id validly. `label` is the type's own `name`, not looked
 * up via i18n — unlike a structural, system-defined vocabulary entry, an Inbox item type is
 * user-managed content, the same as any other item's `name`. Relations always store `id`,
 * never `emoji` — renaming a type's emoji afterwards cannot break an Inbox item's relation.
 */
export async function listActiveInboxTypes(client: Queryable, inboxItemTypesDatabaseId: string): Promise<InboxTypeSummary[]> {
  const { items } = await itemsStore.listItems(client, inboxItemTypesDatabaseId, {
    limit: 200,
    buildFilterSql: (params) => {
      params.push("active");
      return `properties ->> 'status' = $${params.length}`;
    },
  });
  return items.map((item) => ({
    id: item.id,
    emoji: typeof item.properties.emoji === "string" ? item.properties.emoji : "",
    label: typeof item.properties.name === "string" ? item.properties.name : "",
  }));
}
