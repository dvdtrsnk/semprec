import type { MailEnvelope } from "./mailMessageMetaStore.js";
import type { ClassifiedAttachment } from "./attachments.js";

/**
 * `mail_message_meta.message_id` is the dedup/threading key across all three adapters
 * (`ingest.ts`'s `ON CONFLICT (message_id)`, `threading.ts`'s ancestor/descendant lookups) —
 * it only works if every adapter agrees on the same string for the same logical header value.
 * `mailparser` and `imapflow`'s ENVELOPE both already preserve the header's `<...>` form, and
 * Graph's `internetMessageId` is documented to as well, so this is defense-in-depth against a
 * non-compliant server rather than a fix for an observed disagreement — cheap enough to apply
 * unconditionally at every adapter boundary rather than trust three separate upstreams to
 * agree forever.
 */
export function normalizeMessageId(id: string): string {
  const trimmed = id.trim().replace(/^</, "").replace(/>$/, "");
  return `<${trimmed}>`;
}

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
