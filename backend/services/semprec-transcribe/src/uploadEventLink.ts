import type { PoolClient } from "pg";
import {
  EVENTS_MODULE_ID,
  createRelationWithClient,
  getDatabaseByModuleId,
  listPropertiesByDatabase,
  lockItemById,
} from "@semprec/data";
import type { ItemRow } from "@semprec/data";

/**
 * Step 0's link from a transcript to the Event its upload named (`recording_requests.event_item_id`,
 * issue #1644): writes the Transcripts `event` edge in the caller's transaction, through the choke
 * point. The Event is read from the tenant's Events database with a row lock; when it is not there
 * or is in the Trash, nothing is written and the transcript is left to step 6's match. A missing
 * Events database or Transcripts `event` relation is a broken catalog and throws.
 * See docs/adr/2026-11-10-transcription-create-writes-the-uploads-event.md.
 */
export async function linkTranscriptToUploadEvent(
  client: PoolClient,
  transcript: Pick<ItemRow, "id" | "databaseId">,
  eventId: string,
): Promise<void> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new Error("Events database not found");
  const property = (await listPropertiesByDatabase(client, transcript.databaseId)).find(
    (entry) => entry.key === "event",
  );
  if (!property) throw new Error("Transcript event relation not found");
  // Locked, so a live Event cannot be moved to the Trash between this check and the edge write.
  const event = await lockItemById(client, events.id, eventId);
  if (!event || event.deletedAt) return;
  await createRelationWithClient(client, {
    relationPropertyId: property.id,
    callerItemId: transcript.id,
    targetItemId: event.id,
  });
}
