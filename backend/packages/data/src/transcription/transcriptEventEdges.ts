// A trashed Event keeps its relations until purged, and the cardinality trigger ignores
// `deleted_at`, so a transcript whose Event is trashed still holds its one `event` edge. For the
// match step and the pairing-card confirm that edge is no link: they read edges through
// `readTranscriptEventEdges` and remove the edge to a trashed Event with `releaseTrashedEventEdges`
// in the transaction that writes the new edge. The generic relation write still answers
// `cardinality_violation`.
import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { loadRelationEdgeContext } from "../chokePoint/relationEdgeContext.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";

/** An Event whose row is gone is in neither list. */
export interface TranscriptEventEdges {
  liveEventIds: string[];
  /** Each row is locked `FOR SHARE` in the caller's transaction. */
  trashedEventIds: string[];
}

/**
 * An Event is read without a lock first; a trashed one is then locked `FOR SHARE` and re-read, so a
 * restore (which locks `FOR UPDATE`) waits for the caller's transaction, and one that committed
 * between the reads leaves the Event live.
 *
 * The purge deletes a trashed Event's row and edges in one transaction, so an edge read here can name
 * a row removed before the share lock is granted. `lockItemTrashEpoch` returns no epoch for a missing
 * row as for a live one, so the row is read once more; an Event without a row is left out.
 */
export async function readTranscriptEventEdges(
  client: PoolClient,
  eventRelationDefinitionId: string,
  transcriptId: string,
): Promise<TranscriptEventEdges> {
  const edges = await relationsStore.listRelationsForItem(client, eventRelationDefinitionId, transcriptId);
  const eventIds = edges.map((edge) => relationsStore.otherSide(edge, transcriptId));
  const live = new Set<string>();
  const trashed = new Set<string>();
  for (const event of await itemsStore.getItemsByIdsIncludingDeleted(client, eventIds)) {
    if (event.deletedAt === null) {
      live.add(event.id);
    } else if ((await itemsStore.lockItemTrashEpoch(client, event.databaseId, event.id)) !== null) {
      trashed.add(event.id);
    } else if ((await itemsStore.getItemById(client, event.databaseId, event.id)) !== null) {
      // Restored since the first read; the share lock keeps it live in this transaction.
      live.add(event.id);
    }
  }
  return {
    liveEventIds: eventIds.filter((eventId) => live.has(eventId)),
    trashedEventIds: eventIds.filter((eventId) => trashed.has(eventId)),
  };
}

/**
 * Runs on the caller's client so the removal commits or rolls back with the caller's next write.
 * Edges to live Events are left alone. An edge another transaction already removed is no error.
 * `writer` and `actingUserId` are those of the write this removal precedes.
 */
export async function releaseTrashedEventEdges(
  client: PoolClient,
  input: { eventPropertyId: string; transcriptId: string },
  writer?: WriterIdentity,
  actingUserId?: string,
): Promise<void> {
  const { reldef } = await loadRelationEdgeContext(client, input.eventPropertyId);
  const { trashedEventIds } = await readTranscriptEventEdges(client, reldef.id, input.transcriptId);
  for (const eventId of trashedEventIds) {
    await deleteRelationWithClient(
      client,
      { relationPropertyId: input.eventPropertyId, callerItemId: input.transcriptId, targetItemId: eventId },
      undefined,
      writer,
      actingUserId,
    );
  }
}

/**
 * `null` without an edge, with a trashed Event, or without an `event` relation. Takes no lock, so a
 * later statement of the same transaction can see the Event trashed or restored.
 */
export async function readLiveTranscriptEventId(
  client: PoolClient,
  transcriptsDatabaseId: string,
  transcriptId: string,
): Promise<string | null> {
  const property = await propertiesStore.getPropertyByKey(client, transcriptsDatabaseId, "event");
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) return null;
  const edges = await relationsStore.listRelationsForItem(client, definition.id, transcriptId);
  const events = await itemsStore.getItemsByIds(
    client,
    edges.map((edge) => relationsStore.otherSide(edge, transcriptId)),
  );
  return events[0]?.id ?? null;
}
