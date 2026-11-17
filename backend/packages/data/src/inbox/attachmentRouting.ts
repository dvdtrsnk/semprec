import type { InboxAttachmentRow } from "./inboxAttachmentsStore.js";

/**
 * `"notReady"`: an audio attachment has no `metadata` yet; nothing is written and the metadata job re-runs the tick
 * through the item's heartbeats. `{ recording }`: the first `recording` audio attachment by position; the tick proposes
 * its transcription without a model call.
 */
export type InboxAttachmentRoute = "notReady" | { recording: string } | "compute";

/**
 * Missing audio metadata wins over everything. A recording wins over text and other attachments because it is the
 * subject of the item. The 120-second boundary is decided by `audioKind` in `inboxAttachmentMetadata.ts`.
 */
export function routeInboxAttachments(
  attachments: ReadonlyArray<Pick<InboxAttachmentRow, "attachmentId" | "mimeType" | "metadata">>,
): InboxAttachmentRoute {
  const audio = attachments.filter((attachment) => attachment.mimeType.startsWith("audio/"));
  if (audio.some((attachment) => attachment.metadata === null)) return "notReady";
  const recording = audio.find((attachment) => attachment.metadata?.audioKind === "recording");
  return recording ? { recording: recording.attachmentId } : "compute";
}
