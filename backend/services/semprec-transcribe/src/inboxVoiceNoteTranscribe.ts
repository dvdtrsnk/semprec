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

/**
 * The largest voice note, in bytes, that is read into memory and sent to the gateway. A voice note is shorter than two
 * minutes, so a file of this size is far past anything a recording of that length produces; the upload limit of the API
 * is configurable and can be higher. A larger file is not transcribed.
 */
export const MAX_VOICE_NOTE_BYTES = 32 * 1024 * 1024;

/** The transcripts of the voice notes are joined with a blank line, in the order of the notes. */
const TRANSCRIPT_SEPARATOR = "\n\n";

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/** The transcript of one voice note: its bytes from storage, one gateway call, no transaction open. */
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
 * The handler of `inboxVoiceNoteTranscribe` (issue gh-1980): writes the transcript of an Inbox item's voice notes into
 * its system-owned `transcribedText`, as the transcribe process, through the choke point (`recordInboxTranscribedText`).
 *
 * - The voice notes are the audio attachments the metadata job classified `voiceNote` (`audioKindForDuration`), in
 *   position order; a recording is left to its own pipeline. Each is sent to the gateway's transcription route
 *   (`AudioGatewayClient.transcribe`, with the probed length as `audioSeconds`) and the non-empty transcripts are
 *   joined with a blank line. The job covers every voice note of the item, so a second one re-runs it over all of them.
 * - The slow work (the download and the gateway call) runs outside any transaction; one transaction then writes the text.
 *   A text equal to the stored one writes nothing. The person's `text` is never read or written, and a transcript is
 *   written whether `text` is empty or not.
 * - A voice note larger than `MAX_VOICE_NOTE_BYTES` is not downloaded or transcribed and the others are; the log names
 *   its attachment id. An item that is gone or in the Trash, and one without a voice note, end the job successfully with
 *   nothing written.
 * - A gateway failure, a budget refusal included, fails the job so the queue retries it, and nothing is written. So does a
 *   write that finds the item's voice notes changed while the audio was being transcribed: the text it holds would be
 *   wrong, and the retry reads the notes of then.
 *
 * The transcript, the file and the item's text are never logged. `gatewayClient` defaults to the loopback client of
 * `semprec-ai-gateway`, built when the first job that needs it runs.
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
