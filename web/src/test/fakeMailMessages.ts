import type { MailMessageAttachment, MailMessageContent, MailMessageOperations } from "../api/mailMessageOperations.js";
import { MailMessageError } from "../api/mailMessageOperations.js";
import type { FakeBackend } from "./fakeOperations.js";

export type FakeMailMessageCall =
  { kind: "getContent"; emailId: string } | { kind: "saveAttachment"; emailId: string; attachmentId: string };

export interface FakeMailMessages extends MailMessageOperations {
  /** Per Emails item id, its attachments as the backend currently holds them; a save stores one. */
  attachments: Record<string, MailMessageAttachment[]>;
  /** Every request the client made, in order. */
  calls: FakeMailMessageCall[];
}

/**
 * An in-memory stand-in for the backend's `/api/mail/messages` routes over the same fake backend
 * the generic operations read: a message's content is its stored `body`, and a save gives the
 * attachment a blob and a Files item, so the next content read lists it as stored. An unknown
 * message or attachment is the backend's 404.
 */
export function createFakeMailMessages(
  backend: FakeBackend,
  attachments: Record<string, MailMessageAttachment[]> = {},
): FakeMailMessages {
  const calls: FakeMailMessageCall[] = [];
  const notFound = () => new MailMessageError({ code: "notFound" }, 404);

  return {
    attachments,
    calls,

    async getContent(emailId): Promise<MailMessageContent> {
      calls.push({ kind: "getContent", emailId });
      const item = backend.items.find((candidate) => candidate.id === emailId);
      if (!item) throw notFound();
      const body = typeof item.properties.body === "string" ? item.properties.body : "";
      return {
        emailId,
        contentState: "full",
        bodyHtml: body,
        bodyText: body,
        fetchedAt: null,
        expiresAt: null,
        attachments: (attachments[emailId] ?? []).map((attachment) => ({ ...attachment })),
      };
    },

    async saveAttachment(emailId, attachmentId) {
      calls.push({ kind: "saveAttachment", emailId, attachmentId });
      const attachment = attachments[emailId]?.find((candidate) => candidate.attachmentId === attachmentId);
      if (!attachment) throw notFound();
      attachment.stored = true;
      attachment.blobId ??= `blob-${attachmentId}`;
      attachment.fileItemId ??= `file-${attachmentId}`;
      return { fileItemId: attachment.fileItemId };
    },

    blobUrl(blobId) {
      return `/api/blobs/${blobId}`;
    },
  };
}
