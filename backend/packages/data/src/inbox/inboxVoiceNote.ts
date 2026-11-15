import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getBlob } from "../blobs/blobsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { listInboxAttachments } from "./inboxAttachmentsStore.js";

// The transcript of the short voice notes of an Inbox item (issue gh-1980): the system-owned `Inbox.transcribedText`
// property, the job that fills it and the two store functions that job runs on. The handler is `semprec-transcribe`'s
// `inboxVoiceNoteTranscribe.ts`; it makes the gateway calls and writes the property.

/**
 * The key of the Inbox property that holds the transcript of the item's voice notes. It is owned by the system, with
 * `TRANSCRIPTION_OWNER_PROCESS` as its owner process, so only the transcribe process writes it, and the person's own
 * `text` is never touched.
 */
export const INBOX_TRANSCRIBED_TEXT_KEY = "transcribedText";

/** The payload of an `inboxVoiceNoteTranscribe` job: the Inbox item whose voice notes are transcribed. */
export const inboxVoiceNoteTranscribePayloadSchema = z.object({ inboxItemId: z.uuid() });
export type InboxVoiceNoteTranscribePayload = z.infer<typeof inboxVoiceNoteTranscribePayloadSchema>;

/** One job per Inbox item: an enqueue for the same item replaces the job that waits, so a second voice note re-runs it. */
export function inboxVoiceNoteJobKey(inboxItemId: string): string {
  return `inbox-voice-note:${inboxItemId}`;
}

/**
 * Enqueues the transcription of the voice notes of one Inbox item on the caller's open transaction, so the job exists
 * exactly when the metadata that made the voice note exists. The default `replace` key mode makes a repeat enqueue for
 * the same item replace the waiting job. `maxAttempts: 3` with graphile-worker's backoff is its retry policy; the
 * tenant is the producer's own scope, as for every job (`enqueueJob`).
 */
export async function enqueueInboxVoiceNoteTranscribe(client: PoolClient, inboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
    { inboxItemId },
    { jobKey: inboxVoiceNoteJobKey(inboxItemId), maxAttempts: 3, queueName: tenantLane("inbox-voice-note") },
  );
}

/** A voice note of an Inbox item as the transcription reads it: where its bytes are and how long it is. */
export interface InboxVoiceNote {
  attachmentId: string;
  /** The type the blob has as an attachment, always an `audio/` type. */
  mimeType: string;
  storageKey: string;
  /** The size of the stored file, in bytes. */
  byteSize: number;
  /** The probed length, always above zero. */
  durationSeconds: number;
  /** The file name an upload recorded, or `null` for a blob stored without one. */
  name: string | null;
}

/**
 * The voice notes of an Inbox item in position order: the audio attachments whose metadata classified them `voiceNote`
 * (`audioKindForDuration`) and gave a length above zero. A recording, a file the metadata job could not read, one whose
 * metadata is not computed yet and one that is not audio are not in the list. `null` when this tenant has no live Inbox
 * item with that id.
 */
export async function readInboxVoiceNotes(client: PoolClient, inboxItemId: string): Promise<InboxVoiceNote[] | null> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  if (!inbox) return null;
  const { rows: items } = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL",
    [inbox.id, inboxItemId],
  );
  if (items.length === 0) return null;

  const voiceNotes: InboxVoiceNote[] = [];
  for (const attachment of await listInboxAttachments(client, [inboxItemId])) {
    const { metadata } = attachment;
    if (metadata?.audioKind !== "voiceNote" || metadata.durationSeconds === undefined) continue;
    if (!(metadata.durationSeconds > 0)) continue;
    const blob = await getBlob(client, attachment.blobId);
    if (!blob) throw new Error(`Blob ${attachment.blobId} of attachment ${attachment.attachmentId} is missing`);
    voiceNotes.push({
      attachmentId: attachment.attachmentId,
      mimeType: attachment.mimeType,
      storageKey: blob.storageKey,
      byteSize: Number(attachment.byteSize),
      durationSeconds: metadata.durationSeconds,
      name: attachment.name,
    });
  }
  return voiceNotes;
}

export interface RecordInboxTranscribedTextInput {
  inboxItemId: string;
  /** The attachments whose transcripts `text` was joined from, in order: what `readInboxVoiceNotes` returned for the run. */
  attachmentIds: string[];
  text: string;
}

/**
 * What `recordInboxTranscribedText` did: `written` (the property changed), `unchanged` (it already held the text),
 * `gone` (the Inbox item is no longer a live item of this tenant) or `stale` (the item's voice notes are no longer the
 * ones `text` was made from, so nothing was written).
 */
export type RecordedInboxTranscribedText = "written" | "unchanged" | "gone" | "stale";

/**
 * Writes `transcribedText` of an Inbox item through the choke point, as the transcribe process, in the caller's
 * transaction. The item row is locked first, and the voice notes are read again under that lock: the text is written
 * only when they are still the ones it was made from, because a voice note added or deleted while the audio was being
 * transcribed makes the text wrong, and a later run makes it right. A text equal to the stored one (a missing value counts
 * as the empty text) writes nothing, so a rerun with the same result changes no row and announces nothing.
 * `transcribedText` is the only property patched; the person's `text` is never read or written.
 */
export async function recordInboxTranscribedText(
  client: PoolClient,
  input: RecordInboxTranscribedTextInput,
): Promise<RecordedInboxTranscribedText> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  if (!inbox) return "gone";
  const item = await lockItemById(client, inbox.id, input.inboxItemId);
  if (!item || item.deletedAt !== null) return "gone";

  const current = await readInboxVoiceNotes(client, input.inboxItemId);
  const currentIds = (current ?? []).map((note) => note.attachmentId);
  if (currentIds.length !== input.attachmentIds.length || currentIds.some((id, i) => id !== input.attachmentIds[i])) {
    return "stale";
  }

  const stored = item.properties[INBOX_TRANSCRIBED_TEXT_KEY];
  if ((typeof stored === "string" ? stored : "") === input.text) return "unchanged";
  await updateItemWithClient(
    client,
    { databaseId: inbox.id, itemId: item.id, propertiesPatch: { [INBOX_TRANSCRIBED_TEXT_KEY]: input.text } },
    { allowedSystemKeys: [INBOX_TRANSCRIBED_TEXT_KEY], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
  );
  return "written";
}
