import type { MailEnvelope } from "./mailMessageMetaStore.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { BulkMailHeaders } from "./bulkMail.js";

/**
 * Thrown by an adapter when it detects that the stored credential itself is no longer valid
 * (OAuth refresh token revoked, App-Specific Password revoked) rather than a transient/network
 * failure — the issue's `Mailboxes.syncStatus = 'needsReauthorization'` state (mailSyncJob.ts
 * catches this specifically to distinguish it from a generic `'error'`). "The worker stops
 * retrying and just leaves it waiting on the user" is enforced by the caller, not this class.
 * The sync job throws it itself for a mailbox that already shows that status and has no stored
 * credential, as a removed mailbox that was restored from the trash does (issue gh-2032).
 */
export class MailReauthorizationRequiredError extends Error {}

/**
 * Thrown by `exchangeAuthorizationCode` when the provider answered 400/401 and the refusal is no
 * request for administrator consent. `providerError` is the provider's short `error` code when it
 * is a plain token, never free text, and it says what was refused: `invalid_grant` is the
 * authorization code or its PKCE verifier, which the caller presented. Any other value, or none,
 * is the OAuth client or the request itself (`invalid_client` for a wrong or expired client secret),
 * which is a fault of the deployment and no input error of the caller.
 */
export class MailAuthorizationCodeRejectedError extends Error {
  constructor(
    message: string,
    readonly providerError: string | null,
  ) {
    super(message);
    this.name = "MailAuthorizationCodeRejectedError";
  }
}

/**
 * Thrown by `exchangeAuthorizationCode` when Microsoft refuses the code because the tenant
 * requires administrator approval for the application (`consent_required`, or `invalid_grant`
 * with AADSTS65001/AADSTS90094). Distinct from `MailAuthorizationCodeRejectedError` so the
 * connect flow can ask for admin consent instead of a retry.
 */
export class MailAdminConsentRequiredError extends Error {
  constructor(
    message: string,
    readonly providerError: string | null,
  ) {
    super(message);
    this.name = "MailAdminConsentRequiredError";
  }
}

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
 * Thrown by the connection factories in mail/mailServerConnections.ts when a tenant-chosen IMAP or
 * SMTP host cannot be connected to: its address was refused by the outbound address policy, or the
 * connection was refused, timed out, failed name resolution or failed TLS. Every such failure gets
 * this one error with no cause and no address in its message, so a refused address and an unreachable
 * server look identical to the caller (docs/adr/2026-10-29-mail-connections-through-the-outbound-address-policy.md).
 * Authentication failures are not mapped to it.
 */
export class MailServerUnreachableError extends Error {
  readonly code = "mail_server_unreachable";

  constructor() {
    super("The mail server could not be reached");
    this.name = "MailServerUnreachableError";
  }
}

/** A generic mailbox's credentials were rejected during verification. */
export class MailAuthFailedError extends Error {
  readonly code = "mail_auth_failed";
  constructor() {
    super("The mail server rejected the login");
    this.name = "MailAuthFailedError";
  }
}

/** iCloud requires an app-specific password when login fails. */
export class MailAppPasswordRequiredError extends Error {
  readonly code = "mail_app_password_required";
  constructor() {
    super("An app-specific password is required");
    this.name = "MailAppPasswordRequiredError";
  }
}

/** Verification observed an unambiguous TLS or required-upgrade failure. */
export class MailTlsFailedError extends Error {
  readonly code = "mail_tls_failed";
  constructor() {
    super("The mail server could not establish TLS");
    this.name = "MailTlsFailedError";
  }
}

/**
 * Thrown by a mail transport when the outgoing server rejects the login: a 535 reply, or another login failure
 * nodemailer reports as `EAUTH`. The message names neither the server's response nor the credential.
 */
export class MailSendAuthFailedError extends Error {
  readonly code = "mail_send_auth_failed";

  constructor() {
    super("The mail server rejected the login");
    this.name = "MailSendAuthFailedError";
  }
}

/**
 * Thrown by a mail transport when the outgoing server refuses a recipient in the RCPT phase: a 5xx when every
 * recipient is refused, or any refusal when the server accepted the message for only some recipients. The
 * refused recipients get nothing; the accepted ones already have the message. The error names no address.
 */
export class MailRecipientRejectedError extends Error {
  readonly code = "mail_recipient_rejected";

  constructor() {
    super("The mail server refused a recipient");
    this.name = "MailRecipientRejectedError";
  }
}

/**
 * Thrown by the mail transport factory (`createMailTransportFactory`) when it has no usable transport for a mailbox
 * and no retry can change that: a Gmail or Microsoft Graph mailbox in a composition root with no OAuth client, a sync
 * mode it has no transport for, or an IMAP mailbox with no stored SMTP credential. A failure to read the settings or
 * the credential (a database error) is not this error; it propagates as it is. Callers that run unattended, such as the
 * event invitation job, end on it with a reason code instead of retrying. The message names no secret.
 */
export class MailTransportUnavailableError extends Error {
  readonly code = "mail_transport_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "MailTransportUnavailableError";
  }
}

/**
 * Shared upper bound on a single attachment part's *decoded* size, enforced identically by
 * all three adapters (issue #26's provider limits table tops out at iCloud's 20MB baseline /
 * Gmail's 25MB) — generous enough to never bind on a real attachment, but a hard backstop
 * against a malicious or malformed response streaming unbounded bytes into memory/disk before
 * `ingestAttachments` (mail/attachments.ts) ever sees it.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Thrown by an adapter's attachment stream when a chunk would push the attachment past
 * `MAX_ATTACHMENT_BYTES` — a policy violation, not a transient stream failure. Lives here
 * (not in a specific adapter like imapFlowClient.ts) so provider-agnostic callers like
 * mail/attachments.ts can catch it without depending on any one adapter's module.
 */
export class AttachmentCapExceededError extends Error {}

/**
 * Thrown by an adapter's known-UID flag re-fetch when a mailbox has more messages than
 * `MAX_FLAG_FETCH_RESULTS` (imapFlowClient.ts) — without CONDSTORE this fetch has no way to
 * scope itself to "what changed," so an unbounded mailbox would otherwise load every UID's
 * flags into memory in one pass. A hard backstop, not an expected outcome for a real mailbox.
 */
export class FlagFetchCapExceededError extends Error {}

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
    throw new Error(
      `${context}: expected a JSON object in the response, got ${value === null ? "null" : typeof value}`,
    );
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
  /** The raw `List-Unsubscribe`/`List-Id`/`Precedence`/`Auto-Submitted` values (each absent as `null`) — mail/ingest.ts feeds them to `detectBulkMail` (mail/bulkMail.ts) once, centrally. */
  bulkHeaders?: BulkMailHeaders;
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
