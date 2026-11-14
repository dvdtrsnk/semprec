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

/**
 * Replaces an Inbox item's type and sends its card back to the tick (issue gh-1947). The route
 * `PUT /api/inbox/items/:id/type` is the single entry; the rules below are what the write needs
 * to hold together in one transaction.
 */

/** The history message of the user's choice; it names no type, because the type's name is user content. */
const TYPE_CHOSEN_MESSAGE = "The user chose another type for the source item; the proposal is being recomputed.";

export interface ChangeInboxItemTypeInput {
  itemId: string;
  typeId: string;
  /** The card's `updatedAt` as the caller last saw it. Refused for an item that has no card. */
  ifVersion?: string;
  actingUserId?: string;
}

export interface ChangeInboxItemTypeResult {
  itemId: string;
  typeId: string;
  /** The card as this call wrote it (status `computing`); `null` when the item has none, which the tick then creates. */
  card: ItemRow | null;
}

/** The destination of the assistant's previous envelope: the pair the user's manual values were typed for, and the keys of a page's properties. */
const previousEnvelopeSchema = z.object({
  entityKind: z.string(),
  target: z.string(),
  properties: z.record(z.string(), z.unknown()).default({}),
});

type PreviousEnvelope = z.infer<typeof previousEnvelopeSchema>;

/** The keys this write may set on a Processing proposals card (all are system-owned). */
const CARD_WRITE_KEYS = ["status", "userOverrides", "userEditedKeys", "history", "invalidReason"];

/**
 * The type as a chosen one: an Inbox item type that is live and `active`, held in a shared row lock for the rest of
 * the transaction so that archiving or deleting it waits for this write. A type another transaction holds for update
 * is a 409 instead of a wait, the way the tick's write phase treats it (`tryLockInboxType`).
 */
async function lockActiveType(client: PoolClient, config: SemprecTickActionConfig, typeId: string): Promise<ItemRow> {
  if (!(await tryLockInboxType(client, config.inboxItemTypesDatabaseId, typeId))) {
    throw new ConflictError("Inbox item type is busy", { field: "typeId" });
  }
  const type = await itemsStore.getItemById(client, config.inboxItemTypesDatabaseId, typeId);
  if (!type || type.deletedAt !== null || type.properties.status !== "active") {
    throw new ValidationError("'typeId' must be an active Inbox item type", { field: "typeId" });
  }
  return type;
}

/**
 * The destination a card of `type` will have, as far as the type decides it, and the keys that destination accepts as
 * manual values. A type that processes into a database decides both the database and its properties. For a page the
 * model picks the page during the tick, so the destination is assumed to be the previous one when that was a page too;
 * the tick judges the manual values again with the real envelope.
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

/** The destination the card's assistant proposal was made for; `null` for a card without one. */
function previousEnvelopeOf(card: ItemRow): PreviousEnvelope | null {
  const stored = previousEnvelopeSchema.safeParse(card.properties.aiProposal ?? card.properties.proposal);
  return stored.success ? stored.data : null;
}

/** Which of the card's manual values the new type's destination keeps (`retainOverridesForEnvelope`, issue gh-1924). */
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
 * Deletes every `type` edge of the Inbox item and creates the one to `typeId`, through the relation operations, so
 * that exactly one remains. The relation is many to many, and its write hook refuses a second edge, so the old ones go
 * first. The edge hooks of the type lock and the tick trigger run for each write.
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

/** Writes the card as `computing` with the manual values `retained` keeps and the `typeChosen` entry, and announces the change after the commit. */
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
 * Sets the Inbox item's type to `typeId` and sends its card back for a new proposal, in the caller's transaction. It
 * locks, in the order of the tick's write phase, the live Inbox item, the shared lock of the type and the item's
 * live card (`reserveInboxTypeCards`, which fails with 409 instead of waiting for a card that another transaction holds).
 *
 * - An unknown, archived or deleted type, and a type that processes into a database that is missing or archived, is a
 *   `ValidationError` on `typeId`, for an item with a card and for one without; an item that is not a live Inbox item of
 *   the tenant is a `NotFoundError`.
 * - A card that is `confirmed` or `rejected` is a `ProposalLockedError`, and an `ifVersion` that is not the card's
 *   `updatedAt` is the 409 `version_conflict` carrying the card. An `ifVersion` for an item without a card is a
 *   `ValidationError`, since it names a card that is not there.
 * - The `type` edges are replaced (`replaceTypeEdges`). With a card, the card becomes `computing`, its manual values are
 *   cleared where the new type's destination differs from the one they were typed for (`retainOverridesForEnvelope`),
 *   an `invalidReason` goes with a status of `invalid`, and a `typeChosen` entry joins its history. `proposal` and
 *   `aiProposal` stay as they were: the tick writes both when it has computed the new one.
 * - The `update` heartbeats of the Inbox database are triggered for the item, which queues the tick, in the same
 *   transaction. The tick computes the card, or creates it when the item has none, and for a `computing` card it does not
 *   stop at an unchanged fingerprint. The edge writes queue the same job, which has one key per heartbeat and item.
 */
export async function changeInboxItemTypeWithClient(
  client: PoolClient,
  config: SemprecTickActionConfig,
  input: ChangeInboxItemTypeInput,
): Promise<ChangeInboxItemTypeResult> {
  await lockInboxSource(client, input.itemId);
  const type = await lockActiveType(client, config, input.typeId);
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

  // The destination is resolved for an item without a card too, so a type whose target database is not available is
  // refused the same way whether or not the item has a card yet.
  const previous = card === null ? null : previousEnvelopeOf(card);
  const destination = await destinationOfType(client, type, previous);
  await replaceTypeEdges(client, config, input);

  const written =
    card === null ? null : await sendCardBack(client, card, retainForDestination(card, previous, destination), input);
  await triggerOnItemEventHeartbeats(client, config.inboxDatabaseId, "update", input.itemId);
  return { itemId: input.itemId, typeId: input.typeId, card: written };
}
