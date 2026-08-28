import type { MailEnvelope } from "./mailMessageMetaStore.js";
import type { ClassifiedAttachment } from "./attachments.js";

/**
 * The shape every provider adapter (imap/gmail/graph) normalizes a message down to before
 * handing it to `mail/ingest.ts`'s `ingestEmailMessage` — the one shared writer. Keeping
 * this provider-agnostic is what lets the three adapters differ only in *how they detect
 * changes*, not in the target data model (the issue's central design decision).
 */
export interface FetchedMessage {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  subject?: string;
  envelope: MailEnvelope;
  bodyText?: string;
  bodyHtml?: string;
  date?: Date;
  attachments: ClassifiedAttachment[];
  /** Gmail API / Graph API's own message id — absent in plain IMAP mode. */
  providerMessageId?: string | null;
  /** `X-GM-THRID`, Gmail only — auxiliary cross-check, never the threading key itself. */
  providerThreadId?: string | null;
}
