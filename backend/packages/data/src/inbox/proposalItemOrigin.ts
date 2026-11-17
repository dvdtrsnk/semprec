import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { NotFoundError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import type { ItemRow } from "../types.js";
import type { ItemOriginSource } from "./itemOriginsStore.js";
import type { ProposalActionConfig } from "./proposalActions.js";

export async function requireRelationPropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`);
  return property.id;
}

/** An Inbox item's capture moment from its verbatim `date` and `time` in `timezone`, or null when unusable. */
export function inboxCaptureInstant(inboxItem: ItemRow, timezone: string): string | null {
  const { date, time } = inboxItem.properties;
  if (typeof date !== "string" || typeof time !== "string") return null;
  const captured = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  return captured.isValid ? captured.toUTC().toISO() : null;
}

/** Where confirmed items came from: only a valid Inbox capture date and time gives a known timestamp. */
export async function resolveItemOriginSource(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
  transcriptId: string | null,
): Promise<ItemOriginSource> {
  if (transcriptId !== null) {
    return {
      proposalId: proposal.id,
      inboxItemId: null,
      sourceTranscriptId: transcriptId,
      capturedAt: null,
      captureTimeBasis: "unknown",
      captureChannel: "transcript",
    };
  }
  const propertyId = await requireRelationPropertyId(client, config.processingProposalsDatabaseId, "sourceInbox");
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  if (!relationDefinition)
    throw new NotFoundError(`Relation definition for Processing proposals 'sourceInbox' not found`);
  const [edge] = await relationsStore.listRelationsForItem(client, relationDefinition.id, proposal.id);
  const inboxItemId = edge ? relationsStore.otherSide(edge, proposal.id) : null;
  const [inboxItem] = inboxItemId ? await itemsStore.getItemsByIds(client, [inboxItemId]) : [];
  const capturedAt = inboxItem ? inboxCaptureInstant(inboxItem, await getSystemTimezone(client)) : null;
  return {
    proposalId: proposal.id,
    inboxItemId,
    sourceTranscriptId: null,
    capturedAt,
    captureTimeBasis: capturedAt === null ? "unknown" : "inboxCapture",
    captureChannel: "inbox",
  };
}
