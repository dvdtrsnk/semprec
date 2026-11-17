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

// The confirm of a recording card, called by `confirmProposalWithClient` in its transaction.

export interface ConfirmedRecordingCard {
  fileItemId: string;
  filesDatabaseId: string;
  /**
   * Whether this confirm enqueued `transcriptionCreate` or `transcriptionJob`. False when a transcript exists or the
   * jobs were already queued (by the user's upload), so the card's undo must not cancel them.
   */
  transcriptionQueued: boolean;
}

/**
 * The card's `projectId`, unless it is the project of the card's Event: then the transcript takes it from the Event
 * edge and follows the Event. The Event is locked first, ordering this read against writes that lock the Event as the
 * edge's caller (not against edges written from the project's side).
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
 * Starts the transcription a recording card proposes, in the caller's transaction: the attachment moves into Files
 * (an existing Files item with the same blob is reused), the recording request is written via `recordRecordingIntake`
 * with the card's parameters, its own project (`ownProjectId`) and the metadata's recording time (the card never
 * carries one), and `noEvent` sets `event_decision` after the intake. The source Inbox item is locked before its
 * metadata is read, as the metadata writer locks it. Any failure rolls everything back.
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
  // Stored after the intake, under the Files item's row lock. Without the choice nothing is written, so a stored
  // decision is never cleared.
  if (properties.noEvent) {
    await setRecordingEventDecision(client, moved.fileItemId, RECORDING_EVENT_DECISION_NO_EVENT);
  }
  // The intake enqueues missing jobs and finds queued ones (none once a transcript exists). Both are read back, so a
  // confirm never succeeds without them, but only jobs this confirm enqueued count as its follow-up.
  if (
    intake.transcriptId === null &&
    ((await findTranscriptionCreateJobId(client, moved.fileItemId)) === null ||
      (await findTranscriptionJobId(client, moved.fileItemId)) === null)
  ) {
    throw new Error(`Recording intake of Files item ${moved.fileItemId} left no transcription job`);
  }
  return { fileItemId: moved.fileItemId, filesDatabaseId: file.databaseId, transcriptionQueued: intake.enqueued };
}
