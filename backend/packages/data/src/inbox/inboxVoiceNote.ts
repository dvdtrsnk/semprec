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

// The handler is `semprec-transcribe`'s `inboxVoiceNoteTranscribe.ts`; it makes the gateway calls and writes the
// property through the store functions here.

/**
 * System-owned by `TRANSCRIPTION_OWNER_PROCESS`, so only the transcribe process writes it and the person's own `text`
 * is never touched.
 */
export const INBOX_TRANSCRIBED_TEXT_KEY = "transcribedText";

export const inboxVoiceNoteTranscribePayloadSchema = z.object({ inboxItemId: z.uuid() });
export type InboxVoiceNoteTranscribePayload = z.infer<typeof inboxVoiceNoteTranscribePayloadSchema>;

/** An enqueue for the same item replaces the waiting job, so a second voice note re-runs it. */
export function inboxVoiceNoteJobKey(inboxItemId: string): string {
  return `inbox-voice-note:${inboxItemId}`;
}

/** Enqueued in the caller's transaction, so the job exists exactly when the metadata that made the voice note does. */
export async function enqueueInboxVoiceNoteTranscribe(client: PoolClient, inboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
    { inboxItemId },
    { jobKey: inboxVoiceNoteJobKey(inboxItemId), maxAttempts: 3, queueName: tenantLane("inbox-voice-note") },
  );
}

export interface InboxVoiceNote {
  attachmentId: string;
  /** Always an `audio/` type. */
  mimeType: string;
  storageKey: string;
  byteSize: number;
  /** Always above zero. */
  durationSeconds: number;
  name: string | null;
}

/**
 * Only audio classified `voiceNote` with a positive length; recordings, unreadable files and pending metadata are left
 * out. `null` when this tenant has no live Inbox item with that id.
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
  /** What `readInboxVoiceNotes` returned for the run, in order. */
  attachmentIds: string[];
  text: string;
}

/** `stale`: the item's voice notes are no longer the ones `text` was made from, so nothing was written. */
export type RecordedInboxTranscribedText = "written" | "unchanged" | "gone" | "stale";

/**
 * Locks the item row and re-reads the voice notes under that lock: a note added or deleted during transcription makes
 * the text wrong, so it is written only when they still match, and a later run fixes it. An equal text (missing counts
 * as empty) writes and announces nothing.
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
