import { z } from "zod";
import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import { NotFoundError, ProposalLockedError, ConflictError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { lockInboxSource, tryLockInboxType } from "./inboxSourceGuard.js";
import { resolveInboxTypeCardConfiguration, reserveInboxTypeCards } from "./inboxTypeCardReservation.js";
import { LOCKED_PROPOSAL_STATUSES, PROCESSING_METHODS } from "./inboxTypesStore.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { parseUserOverrides, retainOverridesForEnvelope, type RetainedOverrides } from "./proposalOverrides.js";
import { assertProposalVersion } from "./proposalPreconditions.js";
import type { ProposalEnvelope, SemprecTickActionConfig } from "./proposalEnvelope.js";

/** Names no type, because the type's name is user content. */
const TYPE_CHOSEN_MESSAGE = "The user chose another type for the source item; the proposal is being recomputed.";

export interface ChangeInboxItemTypeInput {
  itemId: string;
  typeId: string;
  /** Refused for an item that has no card. */
  ifVersion?: string;
  actingUserId?: string;
}

export interface ChangeInboxItemTypeResult {
  itemId: string;
  typeId: string;
  /** `null` when the item has none; the tick then creates it. */
  card: ItemRow | null;
}

/** The destination the user's manual values were typed for. */
const previousEnvelopeSchema = z.object({
  entityKind: z.string(),
  target: z.string(),
  properties: z.record(z.string(), z.unknown()).default({}),
});

type PreviousEnvelope = z.infer<typeof previousEnvelopeSchema>;

/** All are system-owned. */
const CARD_WRITE_KEYS = ["status", "userOverrides", "userEditedKeys", "history", "invalidReason"];

/**
 * Holds a shared row lock so archiving or deleting the type waits for this write. A type another transaction holds for
 * update is a 409 instead of a wait, as in the tick's write phase. Also used by the capture route.
 */
export async function lockActiveInboxType(
  client: PoolClient,
  inboxItemTypesDatabaseId: string,
  typeId: string,
): Promise<ItemRow> {
  if (!(await tryLockInboxType(client, inboxItemTypesDatabaseId, typeId))) {
    throw new ConflictError("Inbox item type is busy", { field: "typeId" });
  }
  const type = await itemsStore.getItemById(client, inboxItemTypesDatabaseId, typeId);
  if (!type || type.deletedAt !== null || type.properties.status !== "active") {
    throw new ValidationError("'typeId' must be an active Inbox item type", { field: "typeId" });
  }
  return type;
}

/**
 * For a page the model picks it during the tick, so the destination is assumed to be the previous one when that was a
 * page too; the tick re-judges the manual values against the real envelope.
 */
async function destinationOfType(
  client: PoolClient,
  type: ItemRow,
  previous: PreviousEnvelope | null,
): Promise<{ envelope: ProposalEnvelope; propertyKeys: string[] }> {
  const method = z.enum(PROCESSING_METHODS).safeParse(type.properties.processingMethod);
  const targetKey = typeof type.properties.targetDatabase === "string" ? type.properties.targetDatabase : null;
  if (method.success && method.data === "database" && targetKey !== null) {
    const database = await getDatabaseByModuleId(client, targetKey);
    if (!database || database.archivedAt !== null) {
      throw new ValidationError("'typeId' names a type whose target database is not available", { field: "typeId" });
    }
    const properties = await propertiesStore.listPropertiesByDatabase(client, database.id);
    return {
      envelope: { entityKind: "database", target: database.id, properties: {} },
      propertyKeys: properties.map((property) => property.key),
    };
  }
  const page = previous?.entityKind === "pageContent" ? previous : null;
  return {
    envelope: { entityKind: "pageContent", target: page?.target ?? "", properties: page?.properties ?? {} },
    propertyKeys: Object.keys(page?.properties ?? {}),
  };
}

function previousEnvelopeOf(card: ItemRow): PreviousEnvelope | null {
  const stored = previousEnvelopeSchema.safeParse(card.properties.aiProposal ?? card.properties.proposal);
  return stored.success ? stored.data : null;
}

function retainForDestination(
  card: ItemRow,
  previous: PreviousEnvelope | null,
  destination: { envelope: ProposalEnvelope; propertyKeys: string[] },
): RetainedOverrides {
  return retainOverridesForEnvelope(
    previous,
    destination.envelope,
    parseUserOverrides(card.properties.userOverrides, card.id),
    destination.propertyKeys,
  );
}

/**
 * The relation is many-to-many but its write hook refuses a second edge, so the old edges are deleted first. The edge
 * hooks (type lock, tick trigger) run for each write.
 */
async function replaceTypeEdges(
  client: PoolClient,
  config: SemprecTickActionConfig,
  input: ChangeInboxItemTypeInput,
): Promise<void> {
  const property = await propertiesStore.getPropertyByKey(client, config.inboxDatabaseId, "type");
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) {
    throw new NotFoundError(`Inbox database ${config.inboxDatabaseId} has no 'type' relation`);
  }
  const edges = await relationsStore.listRelationsForItem(client, definition.id, input.itemId);
  for (const edge of edges) {
    await deleteRelationWithClient(
      client,
      {
        relationPropertyId: property.id,
        callerItemId: input.itemId,
        targetItemId: relationsStore.otherSide(edge, input.itemId),
      },
      undefined,
      undefined,
      input.actingUserId,
    );
  }
  await createRelationWithClient(
    client,
    { relationPropertyId: property.id, callerItemId: input.itemId, targetItemId: input.typeId },
    undefined,
    undefined,
    input.actingUserId,
  );
}

/** Announces the change after the commit. */
async function sendCardBack(
  client: PoolClient,
  card: ItemRow,
  retained: RetainedOverrides,
  input: ChangeInboxItemTypeInput,
): Promise<ItemRow> {
  const written = await updateItemWithClient(
    client,
    {
      databaseId: card.databaseId,
      itemId: card.id,
      propertiesPatch: {
        status: "computing",
        userOverrides: retained.userOverrides,
        userEditedKeys: retained.userEditedKeys,
        history: appendHistoryEntry(card.properties.history, TYPE_CHOSEN_MESSAGE, "user", { kind: "typeChosen" }),
        ...(card.properties.status === "invalid" ? { invalidReason: null } : {}),
      },
    },
    { allowedSystemKeys: CARD_WRITE_KEYS, actingUserId: input.actingUserId },
  );
  publishInboxCardChange(client, card.id, "updated");
  return written;
}

/**
 * Runs in the caller's transaction. Locks in the tick write phase's order: the live Inbox item, the type (shared), then
 * the live card (`reserveInboxTypeCards`, 409 instead of waiting).
 *
 * An unusable type (unknown, archived, deleted, or targeting a missing/archived database) is a `ValidationError` with
 * or without a card. A locked card is `ProposalLockedError`; a stale `ifVersion` is `version_conflict`; an `ifVersion`
 * without a card is a `ValidationError`. The card becomes `computing` and keeps only manual values that still fit the new
 * destination; `proposal` and `aiProposal` stay until the tick writes new ones. The Inbox `update` heartbeats queue the
 * tick in the same transaction, and a `computing` card is not stopped by an unchanged fingerprint.
 */
export async function changeInboxItemTypeWithClient(
  client: PoolClient,
  config: SemprecTickActionConfig,
  input: ChangeInboxItemTypeInput,
): Promise<ChangeInboxItemTypeResult> {
  await lockInboxSource(client, input.itemId);
  const type = await lockActiveInboxType(client, config.inboxItemTypesDatabaseId, input.typeId);
  const cardConfiguration = await resolveInboxTypeCardConfiguration(client, config.processingProposalsDatabaseId);
  const cards = await reserveInboxTypeCards(client, input.itemId, cardConfiguration);
  if (
    cards.some(
      (candidate) =>
        typeof candidate.properties.status === "string" && LOCKED_PROPOSAL_STATUSES.has(candidate.properties.status),
    )
  ) {
    throw new ProposalLockedError();
  }
  const card = cards[0] ?? null;
  if (card === null && input.ifVersion !== undefined) {
    throw new ValidationError("'ifVersion' names a proposal card, and this item has none", { field: "ifVersion" });
  }
  if (card !== null) assertProposalVersion(card, input.ifVersion);

  // Resolved without a card too, so an unavailable target is refused the same way either way.
  const previous = card === null ? null : previousEnvelopeOf(card);
  const destination = await destinationOfType(client, type, previous);
  await replaceTypeEdges(client, config, input);

  const written =
    card === null ? null : await sendCardBack(client, card, retainForDestination(card, previous, destination), input);
  await triggerOnItemEventHeartbeats(client, config.inboxDatabaseId, "update", input.itemId);
  return { itemId: input.itemId, typeId: input.typeId, card: written };
}
