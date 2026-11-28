import type { PoolClient } from "pg";
import {
  EVENTS_MODULE_ID,
  createRelationWithClient,
  getDatabaseByModuleId,
  listPropertiesByDatabase,
  lockItemById,
} from "@alldots/data";
import type { ItemRow } from "@alldots/data";

/**
 * Writes the `event` edge to the Event the upload named, in the caller's transaction. A missing or
 * trashed Event writes nothing (step 6 matches instead); a missing catalog entry throws.
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
