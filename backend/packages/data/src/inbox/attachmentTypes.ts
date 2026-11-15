/**
 * The blob mime types an Inbox item may carry as attachments (issue gh-1963): PDF, JPEG, PNG, XLSX and DOCX (the
 * types Files knows) and the audio notes M4A and MP3. HEIC is absent on purpose: the iPhone client converts it to
 * JPEG before upload and the server does not convert it. The values are the mime types stored on `blobs`, which
 * `POST /api/blobs` decides from the uploaded bytes and never from the client's header.
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

/** Whether a blob with this stored mime type may be attached to an Inbox item. */
export function isAllowedInboxAttachmentMime(mime: string): boolean {
  return INBOX_ATTACHMENT_MIME_TYPES.includes(mime);
}
