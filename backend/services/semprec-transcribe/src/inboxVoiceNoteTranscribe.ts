import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {
  inboxVoiceNoteTranscribePayloadSchema,
  readInboxVoiceNotes,
  recordInboxTranscribedText,
  withTransaction,
  type BlobStorageWriter,
  type InboxVoiceNote,
} from "@semprec/data";
import { createHttpAudioGatewayClient, type AudioGatewayClient } from "./audioGatewayClient.js";
import { logger } from "./logger.js";
import { downloadToTempFile, removeTempFile } from "./mediaNormalization.js";

/** Far past any sub-two-minute voice note; the API upload limit can be higher. A larger file is not transcribed. */
export const MAX_VOICE_NOTE_BYTES = 32 * 1024 * 1024;

/** The transcripts of the voice notes are joined with a blank line, in the order of the notes. */
const TRANSCRIPT_SEPARATOR = "\n\n";

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

async function transcribeVoiceNote(
  note: InboxVoiceNote,
  blobStorage: BlobStorageWriter,
  gatewayClient: AudioGatewayClient,
): Promise<string> {
  const tempPath = await downloadToTempFile(blobStorage, note.storageKey);
  try {
    const audio = await readFile(tempPath);
    const result = await gatewayClient.transcribe({
      audio,
      filename: note.name ?? "voice-note",
      mimeType: note.mimeType,
      audioSeconds: note.durationSeconds,
    });
    return result.text.trim();
  } finally {
    await removeTempFile(tempPath);
  }
}

/**
 * Writes the transcript of all of an Inbox item's `voiceNote` attachments into its system-owned
 * `transcribedText`; the person's `text` is never touched. Slow work runs outside any transaction.
 * Oversized notes are skipped; a gone or trashed item ends successfully. A gateway failure, or voice
 * notes that changed while transcribing, fails the job for retry with nothing written. Nothing about
 * the audio or text is logged.
 */
export function createInboxVoiceNoteTranscribeTask(
  pool: Pool,
  blobStorage: BlobStorageWriter,
  gatewayClient?: AudioGatewayClient,
) {
  const resolveGatewayClient = (): AudioGatewayClient =>
    gatewayClient ??
    createHttpAudioGatewayClient({
      port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
      token: requireGatewayInternalToken(),
    });

  return async (payload: unknown): Promise<void> => {
    const { inboxItemId } = inboxVoiceNoteTranscribePayloadSchema.parse(payload);
    const voiceNotes = await withTransaction(pool, (client) => readInboxVoiceNotes(client, inboxItemId));
    if (voiceNotes === null) {
      logger.info({ inboxItemId, outcome: "skipped" }, "Inbox voice notes have no live Inbox item to write to");
      return;
    }
    if (voiceNotes.length === 0) {
      logger.info({ inboxItemId, outcome: "skipped" }, "Inbox item has no voice note to transcribe");
      return;
    }

    const client = resolveGatewayClient();
    const transcripts: string[] = [];
    for (const note of voiceNotes) {
      if (note.byteSize > MAX_VOICE_NOTE_BYTES) {
        logger.warn({ inboxItemId, attachmentId: note.attachmentId }, "Inbox voice note is too large to transcribe");
        continue;
      }
      transcripts.push(await transcribeVoiceNote(note, blobStorage, client));
    }

    const outcome = await withTransaction(pool, (tx) =>
      recordInboxTranscribedText(tx, {
        inboxItemId,
        attachmentIds: voiceNotes.map((note) => note.attachmentId),
        text: transcripts.filter((text) => text !== "").join(TRANSCRIPT_SEPARATOR),
      }),
    );
    if (outcome === "stale") {
      throw new Error("The voice notes of the Inbox item changed while they were transcribed");
    }
    logger.info({ inboxItemId, outcome, voiceNotes: voiceNotes.length }, "Inbox voice notes transcribed");
  };
}
