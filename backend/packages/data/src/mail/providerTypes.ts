import type { MailEnvelope } from "./mailMessageMetaStore.js";
import type { ClassifiedAttachment } from "./attachments.js";

/**
 * Thrown by an adapter when it detects that the stored credential itself is no longer valid
 * (OAuth refresh token revoked, App-Specific Password revoked) rather than a transient/network
 * failure — the issue's `Mailboxes.syncStatus = 'needsReauthorization'` state (mailSyncJob.ts
 * catches this specifically to distinguish it from a generic `'error'`). "The worker stops
 * retrying and just leaves it waiting on the user" is enforced by the caller, not this class.
 */
export class MailReauthorizationRequiredError extends Error {}

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
