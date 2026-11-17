import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";

// The shape of `inbox_attachments.metadata`, computed by `semprec-transcribe`'s `inboxAttachmentMetadata.ts` job.

/** The single definition of the voice note / recording boundary, in seconds. */
export const INBOX_RECORDING_MIN_SECONDS = 120;

export type InboxAudioKind = "voiceNote" | "recording";

export function audioKindForDuration(durationSeconds: number): InboxAudioKind {
  return durationSeconds < INBOX_RECORDING_MIN_SECONDS ? "voiceNote" : "recording";
}

/** A code, never the tool's message, which can quote the file. */
export const INBOX_ATTACHMENT_UNREADABLE = "mediaUnreadable";

/**
 * Written once. Image `width`/`height` are after orientation is applied; `recordedAt` is ISO 8601 UTC when the file
 * carries a usable creation time. `pages` is always `null`: PDFs get no page count. An unreadable file has only
 * `error`. Unknown keys are dropped on read.
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

export const inboxAttachmentMetadataPayloadSchema = z.object({ attachmentId: z.uuid() });
export type InboxAttachmentMetadataPayload = z.infer<typeof inboxAttachmentMetadataPayloadSchema>;

/** A repeat enqueue converges onto one job. */
export function inboxAttachmentMetadataJobKey(attachmentId: string): string {
  return `inbox-attachment-metadata:${attachmentId}`;
}

/** Enqueued in the caller's transaction, so the job exists exactly when the attachment row does. */
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
