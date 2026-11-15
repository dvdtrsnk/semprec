import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  RECORDING_EVENT_DECISION_NO_EVENT,
  recordRecordingIntake,
  setRecordingEventDecision,
} from "../transcription/recordingIntake.js";
import { readEventProjects } from "../transcription/recordingCardCandidates.js";
import { findTranscriptionCreateJobId, findTranscriptionJobId } from "../transcription/transcriptionJob.js";
import type { ItemRow } from "../types.js";
import { getInboxAttachment } from "./inboxAttachmentsStore.js";
import { lockInboxSource } from "./inboxSourceGuard.js";
import { insertItemOrigins } from "./itemOriginsStore.js";
import { insertInboxOriginNotes } from "./originNote.js";
import { resolveItemOriginSource } from "./proposalItemOrigin.js";
import { moveAttachmentIntoFiles } from "./proposalSteps.js";
import type { RecordingCardProperties } from "./recordingCardEnvelope.js";

// The confirm of a recording card (issue gh-1978), called by `confirmProposalWithClient` in its transaction.

/** What the confirm of a recording card wrote: the Files item the recording is in and whether its transcription is queued. */
export interface ConfirmedRecordingCard {
  fileItemId: string;
  filesDatabaseId: string;
  /**
   * Whether this confirm enqueued the `transcriptionCreate` or the `transcriptionJob` of the Files item. False for a Files
   * item that already has its transcript, and for one whose jobs were already queued before the confirm (the user's own
   * upload queued them): the confirm found those, it did not queue them, so the undo of the card must not cancel them.
   */
  transcriptionQueued: boolean;
}

/**
 * The project the recording request stores: the card's `projectId` unless it is the project of the card's Event, which
 * the transcript takes from the Event itself when its Event edge is written (issue gh-1697), so that it follows the
 * Event until the user chooses another project. The Event is locked first, which orders the read against a write that
 * locks the Event as the edge's caller; an edge written from the project's side is not ordered against it. The lock is
 * released with the transaction.
 */
async function ownProjectId(client: PoolClient, properties: RecordingCardProperties): Promise<string | null> {
  if (properties.projectId === null || properties.eventId === null) return properties.projectId;
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new NotFoundError(`Database for module '${EVENTS_MODULE_ID}' not found`);
  if (!(await lockItemById(client, events.id, properties.eventId))) {
    throw new ConflictError(`Event '${properties.eventId}' no longer exists`, { field: "eventId" });
  }
  const eventProject = (await readEventProjects(client, events.id, [properties.eventId])).get(properties.eventId);
  return eventProject?.id === properties.projectId ? null : properties.projectId;
}

/**
 * Starts the transcription a recording card proposes, in the caller's transaction: the attachment `attachmentId` moves
 * into Files as a `fileFromAttachment` step moves it (a Files item with the same blob is linked instead of
 * duplicated), the recording request of the Files item is written through `recordRecordingIntake` with the card's name,
 * language, speaker count and Event, its project when it is the user's own (`ownProjectId`) and the recording time of
 * the attachment's metadata, and, when the card's `noEvent` is true, the request's `event_decision` is set to
 * `noEvent` right after the intake (`setRecordingEventDecision`); the intake enqueues `transcriptionCreate` and `transcriptionJob` for the item unless
 * they are already queued (`transcriptionQueued` is true only for jobs this confirm enqueued). The
 * recording time is the metadata's alone: the card never carries one, and metadata without it passes none. The source
 * Inbox item is locked before the metadata is read, as the writer of the metadata locks it. A failing step throws and the
 * caller's transaction rolls all of it back. The Files item's origin is recorded as for any item a confirm creates.
 * `properties` and `sourceInboxItemId` are those `assertRecordingEnvelopeFitsCard` validated for this card.
 */
export async function confirmRecordingCard(
  client: PoolClient,
  config: { processingProposalsDatabaseId: string },
  proposal: ItemRow,
  attachmentId: string,
  validated: { sourceInboxItemId: string; properties: RecordingCardProperties },
  writer: WriterIdentity,
  actingUserId?: string,
): Promise<ConfirmedRecordingCard> {
  const { sourceInboxItemId, properties } = validated;
  await lockInboxSource(client, sourceInboxItemId, true);
  const attachment = await getInboxAttachment(client, attachmentId);
  if (!attachment || attachment.inboxItemId !== sourceInboxItemId) {
    throw new ConflictError(`Attachment '${attachmentId}' was already moved`, { field: "target" });
  }
  const recordedAtMs =
    attachment.metadata?.recordedAt === undefined ? Number.NaN : Date.parse(attachment.metadata.recordedAt);
  const recordedAt = Number.isFinite(recordedAtMs) ? new Date(recordedAtMs).toISOString() : null;
  const projectId = await ownProjectId(client, properties);

  const moved = await moveAttachmentIntoFiles(
    client,
    { attachmentId, name: properties.name },
    { writer, actingUserId, sourceInboxItemId },
  );
  const [file] = await getItemsByIds(client, [moved.fileItemId]);
  if (!file) throw new Error(`Files item ${moved.fileItemId} disappeared during confirm`);
  if (moved.created) {
    const origin = await resolveItemOriginSource(client, config, proposal, null);
    await insertItemOrigins(client, [moved.fileItemId], origin);
    await insertInboxOriginNotes(client, [moved.fileItemId], origin.inboxItemId, actingUserId);
  }

  const intake = await recordRecordingIntake(client, {
    fileItemId: moved.fileItemId,
    eventId: properties.eventId,
    recordedAt,
    parameters: {
      name: properties.name,
      language: properties.language,
      numSpeakersExact: properties.numSpeakersExact,
      numSpeakersMin: properties.numSpeakersMin,
      projectId,
    },
  });
  // The explicit "no event" choice is stored after the intake wrote or found the request, while this transaction holds
  // the Files item's row lock. A confirm that makes no such choice writes nothing and never clears a stored decision.
  if (properties.noEvent) {
    await setRecordingEventDecision(client, moved.fileItemId, RECORDING_EVENT_DECISION_NO_EVENT);
  }
  // The intake enqueues the jobs of a Files item that has no transcript yet that are not queued under their keys, and
  // finds the ones that are; a Files item that already has its transcript gets none. Both are read back, so a confirm
  // never succeeds without them, but the result claims a follow-up only for the jobs this confirm enqueued itself.
  if (
    intake.transcriptId === null &&
    ((await findTranscriptionCreateJobId(client, moved.fileItemId)) === null ||
      (await findTranscriptionJobId(client, moved.fileItemId)) === null)
  ) {
    throw new Error(`Recording intake of Files item ${moved.fileItemId} left no transcription job`);
  }
  return { fileItemId: moved.fileItemId, filesDatabaseId: file.databaseId, transcriptionQueued: intake.enqueued };
}
