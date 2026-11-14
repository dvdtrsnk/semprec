import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { getInboxAttachment, type InboxAttachmentRow } from "./inboxAttachmentsStore.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { parseRecordingCardProperties, type RecordingCardProperties } from "./recordingCardEnvelope.js";

// The checks of a recording card's envelope (issue gh-1978): `assertValidRecordingEnvelope` is what the envelope has to
// be wherever it is written, and `assertRecordingEnvelopeFitsCard` is what it has to be on the card that holds it.

/** The live item `itemId` of the database owned by `moduleId`, or a `ValidationError` on `field`. */
async function requireLiveItem(client: PoolClient, moduleId: string, itemId: string, field: string): Promise<void> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  const item = await getItemById(client, database.id, itemId);
  if (!item || item.deletedAt !== null) {
    throw new ValidationError(`A recording proposal's ${field} '${itemId}' is not a live item`, { field });
  }
}

/** The attachment `envelope.target` names, in the current tenant, as an audio attachment; otherwise a `ValidationError` on `target`. */
async function requireAudioAttachment(client: PoolClient, target: string): Promise<InboxAttachmentRow> {
  const attachment = UUID_RE.test(target) ? await getInboxAttachment(client, target) : null;
  if (!attachment) {
    throw new ValidationError(`A recording proposal's target '${target}' is not an Inbox attachment`, {
      field: "target",
    });
  }
  if (!attachment.mimeType.startsWith("audio/")) {
    throw new ValidationError(`A recording proposal's target '${target}' is not an audio attachment`, {
      field: "target",
    });
  }
  return attachment;
}

/**
 * Validates a `transcription` envelope as the Inbox tick, a revise and a confirm all need it: no `operations` and no
 * `relations`; `properties` that `parseRecordingCardProperties` accepts; `target` an audio attachment of the current
 * tenant; and, when set, `eventId` a live Events item and `projectId` a live Projects item. Membership of the
 * suggestions in `context.candidates` is not required, so a manual choice of any live Event stays valid. Each refusal
 * is a `ValidationError` naming the field. Returns the parsed properties and the attachment.
 */
export async function assertValidRecordingEnvelope(
  client: PoolClient,
  envelope: ProposalEnvelope,
): Promise<{ properties: RecordingCardProperties; attachment: InboxAttachmentRow }> {
  if (envelope.operations !== undefined)
    throw new ValidationError("A recording proposal has no steps", { field: "operations" });
  if (envelope.relations !== undefined)
    throw new ValidationError("A recording proposal has no relations", { field: "relations" });
  const properties = parseRecordingCardProperties(envelope.properties);
  const attachment = await requireAudioAttachment(client, envelope.target);
  if (properties.eventId !== null) await requireLiveItem(client, EVENTS_MODULE_ID, properties.eventId, "eventId");
  if (properties.projectId !== null)
    await requireLiveItem(client, PROJECTS_MODULE_ID, properties.projectId, "projectId");
  return { properties, attachment };
}

/**
 * The Inbox item `card` was made for: the other side of its `sourceInbox` edge. A card without that edge is a
 * `ValidationError` on `sourceInbox`.
 */
export async function requireSourceInboxItemId(
  client: PoolClient,
  config: { processingProposalsDatabaseId: string },
  card: ItemRow,
): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
  if (!property) throw new NotFoundError("Property 'sourceInbox' not found on Processing proposals");
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) throw new NotFoundError("Relation definition for Processing proposals 'sourceInbox' not found");
  const [edge] = await relationsStore.listRelationsForItem(client, definition.id, card.id);
  if (!edge) throw new ValidationError(`Proposal ${card.id} has no source Inbox item`, { field: "sourceInbox" });
  return relationsStore.otherSide(edge, card.id);
}

/**
 * Validates a `transcription` envelope against the card that holds it: the card is an `inbox` card (a transcript or a
 * thread card cannot hold one, `entityKind`), and `target` is an attachment of the card's source Inbox item (`target`).
 * Run after `assertValidRecordingEnvelope`, for confirm and for every revise of the card. Returns the source Inbox
 * item's id, the attachment and the parsed properties.
 */
export async function assertRecordingEnvelopeFitsCard(
  client: PoolClient,
  config: { processingProposalsDatabaseId: string },
  card: ItemRow,
  envelope: ProposalEnvelope,
): Promise<{ sourceInboxItemId: string; properties: RecordingCardProperties; attachment: InboxAttachmentRow }> {
  if (card.properties.kind !== "inbox") {
    throw new ValidationError("A recording proposal is only valid on an Inbox card", { field: "entityKind" });
  }
  const { properties, attachment } = await assertValidRecordingEnvelope(client, envelope);
  const sourceInboxItemId = await requireSourceInboxItemId(client, config, card);
  if (attachment.inboxItemId !== sourceInboxItemId) {
    throw new ValidationError(
      `A recording proposal's target '${envelope.target}' is not an attachment of the card's source Inbox item`,
      { field: "target" },
    );
  }
  return { sourceInboxItemId, properties, attachment };
}
