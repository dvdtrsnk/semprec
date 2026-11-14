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

/** The id of the relation property `key` of `databaseId`, or a 404 when the database has no such property. */
export async function requireRelationPropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`);
  return property.id;
}

/**
 * The moment an Inbox item was captured: its `date` and `time` (the user's meant moment, stored
 * verbatim) read in the system timezone, or null when either is missing or unparseable.
 */
export function inboxCaptureInstant(inboxItem: ItemRow, timezone: string): string | null {
  const { date, time } = inboxItem.properties;
  if (typeof date !== "string" || typeof time !== "string") return null;
  const captured = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  return captured.isValid ? captured.toUTC().toISO() : null;
}

/**
 * Where the items a confirm creates came from. Only a valid Inbox capture date and time supplies
 * a known timestamp; transcript cards and missing or invalid capture times remain unknown.
 */
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
