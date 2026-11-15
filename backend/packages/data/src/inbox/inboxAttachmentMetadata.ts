import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

// What `semprec-transcribe` computes for an Inbox attachment (issue gh-1965): the shape of `inbox_attachments.metadata`,
// the one definition of the voice note / recording boundary, and the job that makes the facts. The job's handler is
// `semprec-transcribe`'s `inboxAttachmentMetadata.ts`, and the store of the columns is `inboxAttachmentsStore.ts`.

/**
 * The length, in seconds, from which an audio attachment is a recording and below which it is a voice note
 * (`audioKindForDuration`). This is the only definition of the boundary; issue gh-1978 and the transcription of voice
 * notes read it from here.
 */
export const INBOX_RECORDING_MIN_SECONDS = 120;

/** How an audio attachment is treated: a short note, or a long recording. */
export type InboxAudioKind = "voiceNote" | "recording";

/** `voiceNote` for a duration shorter than `INBOX_RECORDING_MIN_SECONDS`, `recording` for that length or longer. */
export function audioKindForDuration(durationSeconds: number): InboxAudioKind {
  return durationSeconds < INBOX_RECORDING_MIN_SECONDS ? "voiceNote" : "recording";
}

/**
 * The code stored as `metadata.error` for a file `ffprobe` or `ffmpeg` could not read. It is a code and never the
 * tool's message, which can quote the file.
 */
export const INBOX_ATTACHMENT_UNREADABLE = "mediaUnreadable";

/**
 * `inbox_attachments.metadata`: what the job found, written once. An image has `width` and `height` (as the picture is
 * shown, after its orientation is applied), audio has `durationSeconds`, `audioKind` and, when the file carries a usable
 * creation time, `recordedAt` (an ISO 8601 UTC timestamp). `pages` is always `null`: a PDF has no page count (the
 * product decided that PDFs get no preview and no page count, as Files has none). A file that could not be read has
 * `error` and none of the other facts. A key this release does not know is dropped when the column is read.
 */
export const inboxAttachmentMetadataSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  recordedAt: z.string().optional(),
  audioKind: z.enum(["voiceNote", "recording"]).optional(),
  pages: z.null(),
  error: z.literal(INBOX_ATTACHMENT_UNREADABLE).optional(),
});
export type InboxAttachmentMetadata = z.infer<typeof inboxAttachmentMetadataSchema>;

/** The payload of an `inboxAttachmentMetadata` job: the attachment to compute the facts of. */
export const inboxAttachmentMetadataPayloadSchema = z.object({ attachmentId: z.uuid() });
export type InboxAttachmentMetadataPayload = z.infer<typeof inboxAttachmentMetadataPayloadSchema>;

/** One job per attachment: a repeat enqueue for the same attachment converges onto one job. */
export function inboxAttachmentMetadataJobKey(attachmentId: string): string {
  return `inbox-attachment-metadata:${attachmentId}`;
}

/**
 * Enqueues the metadata job of one attachment on the caller's open transaction, so the job exists exactly when the
 * attachment row does. `maxAttempts: 3` with graphile-worker's backoff is its retry policy; the tenant is the
 * producer's own scope, as for every job (`enqueueJob`).
 */
export async function enqueueInboxAttachmentMetadata(client: PoolClient, attachmentId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA,
    { attachmentId },
    {
      jobKey: inboxAttachmentMetadataJobKey(attachmentId),
      maxAttempts: 3,
      queueName: tenantLane("inbox-attachment-metadata"),
    },
  );
}
