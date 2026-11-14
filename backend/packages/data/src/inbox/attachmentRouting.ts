import type { InboxAttachmentRow } from "./inboxAttachmentsStore.js";

// How the Inbox tick treats the attachments of an item before it computes a proposal (issue gh-1985).

/**
 * What the tick does with an item, from its attachments alone:
 * - `"notReady"`: an audio attachment has no `metadata` yet, so nothing is decided and nothing is written; the metadata
 *   job announces its result to the item's heartbeats, which runs the tick again.
 * - `{ recording }`: the item holds a recording, an audio attachment whose `audioKind` (gh-1965) is `recording`;
 *   `recording` is the id of the first such attachment by position. The tick proposes its transcription and makes no
 *   model call.
 * - `"compute"`: the item goes through the normal computation.
 */
export type InboxAttachmentRoute = "notReady" | { recording: string } | "compute";

/**
 * Decides the route of an item from its attachments, in the order the position gives them. An audio attachment without
 * metadata makes the item `notReady` whatever else it holds. Otherwise the first audio attachment of `audioKind`
 * `recording` makes it `{ recording }`, even when the item also has text or other attachments, because the long
 * recording is the subject of the item. An audio attachment that is a `voiceNote`, one whose metadata says it
 * cannot be read (it has no `audioKind`) and every other attachment leave the item `"compute"`. The 120-second boundary
 * is not decided here: `audioKind` is the one of `inboxAttachmentMetadata.ts`.
 */
export function routeInboxAttachments(
  attachments: ReadonlyArray<Pick<InboxAttachmentRow, "attachmentId" | "mimeType" | "metadata">>,
): InboxAttachmentRoute {
  const audio = attachments.filter((attachment) => attachment.mimeType.startsWith("audio/"));
  if (audio.some((attachment) => attachment.metadata === null)) return "notReady";
  const recording = audio.find((attachment) => attachment.metadata?.audioKind === "recording");
  return recording ? { recording: recording.attachmentId } : "compute";
}
