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
 * Thrown by an adapter's `createImapClient` when the provider rejected the connection purely
 * for having too many of this account's IMAP sessions open at once (Gmail's well-known
 * "Too many simultaneous connections" `BYE`, detected via `imapFlowClient.ts`'s
 * `isImapConnectionLimitError`) — contention, not an account failure. `mailSyncJob.ts` catches
 * this specifically to schedule a delayed retry through the persisted sync state instead of
 * rethrowing into graphile-worker's own immediate retry, which would just reopen a connection
 * and likely hit the same limit again before the provider has cleared it.
 */
export class MailConnectionLimitError extends Error {}

/**
 * Shared upper bound on a single attachment part's *decoded* size, enforced identically by
 * all three adapters (issue #26's provider limits table tops out at iCloud's 20MB baseline /
 * Gmail's 25MB) — generous enough to never bind on a real attachment, but a hard backstop
 * against a malicious or malformed response streaming unbounded bytes into memory/disk before
 * `ingestAttachments` (mail/attachments.ts) ever sees it.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

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
  /** Gmail API / Graph API's own message id — absent in plain IMAP mode. Also carries `X-GM-MSGID` (via imapflow's `emailId`) when the IMAP server advertises the X-GM-EXT-1 extension (Gmail in IMAP fallback mode), for the same dedup role. */
  providerMessageId?: string | null;
  /** `X-GM-THRID`, Gmail only — auxiliary cross-check, never the threading key itself. */
  providerThreadId?: string | null;
  /**
   * `X-GM-LABELS` (Gmail's IMAP extension) — present only when the IMAP server is Gmail and
   * reports labels for this message (issue #26's "Gmail in IMAP fallback mode"). `undefined`
   * on every other server; imapReconcile.ts only runs the label-derived Folder membership
   * logic when this is present, so a plain IMAP/iCloud sync is entirely unaffected.
   */
  gmailLabels?: string[];
  /**
   * Raw deliveredToAddress candidates (issue #93) — every `Delivered-To` occurrence (header
   * order, top to bottom), plus `X-Original-To`/`Envelope-To` when present. mail/ingest.ts
   * applies the precedence rule centrally (mail/deliveredTo.ts) rather than each adapter
   * resolving it itself, the same "resolve once, centrally" shape threading.ts already uses.
   */
  deliveredToHeaders?: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
  /** True when this message's top-level Content-Type is `multipart/report; report-type=delivery-status` (mail/dsn.ts) — a DSN/bounce, not an ordinary human reply. */
  isDsn?: boolean;
  /**
   * The IMAP flags the message carries in the folder it was fetched from (`\Seen`,
   * `\Flagged`, …) — mail/ingest.ts maps the two the mailbox models (mail/messageFlags.ts)
   * onto the new item's `read`/`flagged` properties. `undefined` on the Gmail/Graph REST
   * adapters, which report read state in their own vocabularies; both properties are then
   * simply absent, which the mailbox reads as unread and unflagged.
   */
  flags?: string[];
}
