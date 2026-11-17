/**
 * HEIC is absent on purpose: the iPhone client converts it to JPEG and the server does not convert. The values are
 * the mime types `POST /api/blobs` sniffs from the uploaded bytes, never the client's header.
 */
export const INBOX_ATTACHMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/mp4",
  "audio/x-m4a",
  "audio/mpeg",
];

export function isAllowedInboxAttachmentMime(mime: string): boolean {
  return INBOX_ATTACHMENT_MIME_TYPES.includes(mime);
}
