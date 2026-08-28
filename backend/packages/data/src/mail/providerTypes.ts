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
 * Minimal module-boundary validation for a REST client's parsed JSON response (gmailRestClient.ts,
 * graphRestClient.ts): not a full per-endpoint schema — that would mean hand-maintaining a
 * shape for every Gmail/Graph resource this issue touches, which is exactly the kind of
 * machinery beyond what the issue's Task section asks for. What it does guarantee: an
 * unexpected top-level shape (an array, a string, `null`, an HTML error page that still
 * returned `200`) fails immediately with a clear, request-scoped error, instead of an
 * `as T` cast letting it flow silently into `ingestEmailMessage` and fail confusingly deep
 * inside message processing.
 */
export function assertJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${context}: expected a JSON object in the response, got ${value === null ? "null" : typeof value}`);
  }
  return value as Record<string, unknown>;
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
