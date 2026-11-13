// Issue #1743: an Event in the Trash keeps its relations until it is purged, and the cardinality trigger
// does not look at `deleted_at`, so a transcript whose Event is in the Trash still holds the one `event`
// edge the relation allows it. For the match step (`./transcriptEventMatch.ts`) and for the confirm of a
// pairing card (`../inbox/proposalActions.ts`) that edge is no link: they read the transcript's edges
// through `readTranscriptEventEdges`, and they remove the edge to a trashed Event through
// `releaseTrashedEventEdges` in the transaction that writes the new edge. The generic relation write does
// neither and keeps answering `cardinality_violation`.
// Constrained by: docs/adr/2026-11-11-an-edge-to-a-trashed-event-is-no-link-for-the-match-and-a-pairing-card.md,
// docs/adr/2026-10-29-events-hold-many-transcripts.md
import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { loadRelationEdgeContext } from "../chokePoint/relationEdgeContext.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";

/**
 * The Events a transcript's `event` edges point to, by whether the Event is in the Trash. An Event whose
 * row is gone is in neither list.
 */
export interface TranscriptEventEdges {
  /**
   * The Events whose row was read with no `deleted_at`: by the read without a lock, or by the read that
   * followed the share lock of a row first read as trashed.
   */
  liveEventIds: string[];
  /** The Events in the Trash. Each of their rows is locked `FOR SHARE` in the caller's transaction. */
  trashedEventIds: string[];
}

/**
 * Reads the transcript's edges of the relation `eventRelationDefinitionId` (Transcripts `event`) and
 * splits the Events at their other end into live and trashed. An Event is read without a lock first. One that is in the Trash
 * is then locked `FOR SHARE` and read again (`itemsStore.lockItemTrashEpoch`): a restore of it, which
 * locks the row `FOR UPDATE`, waits until the caller's transaction ends, and a restore that committed
 * between the two reads leaves the Event among the live ones. An Event the first read found live is not
 * locked.
 *
 * The permanent purge (`purgeExpiredTrashSubtree`) deletes a trashed Event's row and its edges in one
 * transaction, so an edge read here can name an Event whose row that purge removes before the row is
 * read, or before the share lock is granted. `lockItemTrashEpoch` returns no trash epoch for a missing
 * row as it does for a live one, so after such a lock the row is read once more. An Event without a row
 * is left out of both lists: its edge went with it.
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
      // Restored since the first read. The share lock is on that row, so it stays live in this transaction.
      live.add(event.id);
    }
  }
  return {
    liveEventIds: eventIds.filter((eventId) => live.has(eventId)),
    trashedEventIds: eventIds.filter((eventId) => trashed.has(eventId)),
  };
}

/**
 * Deletes the transcript's edge to every Event that is in the Trash, through the choke point's
 * `deleteRelationWithClient` on the caller's client, so the removal commits or rolls back with whatever
 * the caller writes next. `eventPropertyId` is the Transcripts `event` relation property. The edges are
 * read by `readTranscriptEventEdges` in this call, which holds each trashed Event's row `FOR SHARE`.
 * An edge to a live Event is left alone. An edge that another transaction removed after that read is
 * no error: the delete finds nothing, and no edge to that Event is left either way. `writer` and
 * `actingUserId` are those of the write this removal precedes.
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
 * The live Event the transcript's `event` edge points to, or `null`: for a transcript without an edge, for
 * one whose edge points to an Event in the Trash, and when the database `transcriptsDatabaseId` has no
 * `event` relation. It takes no lock, so a later statement of the same transaction can find the Event
 * moved to the Trash or restored.
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
