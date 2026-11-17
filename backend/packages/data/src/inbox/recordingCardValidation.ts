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

// `assertValidRecordingEnvelope` checks the envelope wherever it is written; `assertRecordingEnvelopeFitsCard` checks
// it against the card that holds it.

async function requireLiveItem(client: PoolClient, moduleId: string, itemId: string, field: string): Promise<void> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  const item = await getItemById(client, database.id, itemId);
  if (!item || item.deletedAt !== null) {
    throw new ValidationError(`A recording proposal's ${field} '${itemId}' is not a live item`, { field });
  }
}

/** `envelope.target` as an audio attachment of the current tenant; otherwise a `ValidationError` on `target`. */
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
 * Validates a `transcription` envelope wherever it is written: no `operations` or `relations`, parsable properties, an
 * audio attachment `target` in this tenant, and live `eventId`/`projectId` items when set. The Event need not be one
 * of `context.candidates`, so a manual choice stays valid.
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

/** The other side of the card's `sourceInbox` edge; a missing edge is a `ValidationError` on `sourceInbox`. */
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
 * Validates a `transcription` envelope against its card: an `inbox` card whose source Inbox item owns the `target`
 * attachment. Run after `assertValidRecordingEnvelope` on confirm and every revise.
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
