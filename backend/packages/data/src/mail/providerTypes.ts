import type { MailEnvelope } from "./mailMessageMetaStore.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { BulkMailHeaders } from "./bulkMail.js";

/**
 * The stored credential itself is no longer valid (revoked refresh token or app-specific password), as
 * opposed to a transient failure; the sync job maps it to `needsReauthorization` and stops retrying.
 */
export class MailReauthorizationRequiredError extends Error {}

/**
 * A 400/401 refusal that is no admin-consent request. `providerError` is one of a fixed set of codes,
 * never free text, and `null` when that code occurs inside a submitted secret, so no field can echo a
 * secret. `grantRefused` survives that blanking: true for `invalid_grant` (the caller's code or
 * verifier), false for a client or request fault of the deployment.
 */
export class MailAuthorizationCodeRejectedError extends Error {
  constructor(
    message: string,
    readonly providerError: string | null,
    readonly grantRefused: boolean,
  ) {
    super(message);
    this.name = "MailAuthorizationCodeRejectedError";
  }
}

/**
 * Microsoft requires administrator approval (`consent_required`, or `invalid_grant` with
 * AADSTS65001/AADSTS90094), so the connect flow can ask for admin consent instead of a retry.
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
 * The provider refused the connection for too many simultaneous IMAP sessions (Gmail's `BYE`):
 * contention, not an account failure. The sync job schedules a delayed retry through the persisted sync
 * state, because graphile-worker's immediate retry would likely hit the same limit again.
 */
export class MailConnectionLimitError extends Error {}

/**
 * A tenant-chosen IMAP/SMTP host is refused by the outbound address policy or unreachable. One error
 * with no cause and no address, so a refused address and an unreachable server look identical.
 * Authentication failures are not mapped to it.
 */
export class MailServerUnreachableError extends Error {
  readonly code = "mail_server_unreachable";

  constructor() {
    super("The mail server could not be reached");
    this.name = "MailServerUnreachableError";
  }
}

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

/** A 535 or other `EAUTH` login failure; names neither the server's response nor the credential. */
export class MailSendAuthFailedError extends Error {
  readonly code = "mail_send_auth_failed";

  constructor() {
    super("The mail server rejected the login");
    this.name = "MailSendAuthFailedError";
  }
}

/**
 * A RCPT refusal: a 5xx for every recipient, or any refusal on a partial acceptance (the accepted ones
 * already have the message). Names no address.
 */
export class MailRecipientRejectedError extends Error {
  readonly code = "mail_recipient_rejected";

  constructor() {
    super("The mail server refused a recipient");
    this.name = "MailRecipientRejectedError";
  }
}

/**
 * No usable transport and no retry can change that (missing OAuth client, unknown sync mode, missing
 * SMTP credential). Database read failures are not this error. Unattended callers end on it instead of
 * retrying. Names no secret.
 */
export class MailTransportUnavailableError extends Error {
  readonly code = "mail_transport_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "MailTransportUnavailableError";
  }
}

/**
 * Upper bound on one attachment's decoded size for all adapters: far above provider limits (20-25 MB),
 * a backstop against a malicious response streaming unbounded bytes.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** A policy violation, not a transient stream failure; lives here so callers need no adapter module. */
export class AttachmentCapExceededError extends Error {}

/**
 * Without CONDSTORE the known-UID flag re-fetch cannot scope itself to changes, so this caps an
 * unbounded mailbox loading every UID's flags into memory. A backstop, not an expected outcome.
 */
export class FlagFetchCapExceededError extends Error {}

/**
 * Minimal top-level shape check for REST JSON responses: an unexpected shape (array, `null`, an HTML
 * page with 200) fails here with a request-scoped error instead of deep inside ingest.
 */
export function assertJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `${context}: expected a JSON object in the response, got ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

/** What every adapter normalizes a message to before the one shared writer `ingestEmailMessage`. */
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
  /** Gmail/Graph message id, or `X-GM-MSGID` from a Gmail IMAP server; absent in plain IMAP. Used for dedup. */
  providerMessageId?: string | null;
  /** `X-GM-THRID`, Gmail only: auxiliary cross-check, never the threading key. */
  providerThreadId?: string | null;
  /** `X-GM-LABELS`, only from a Gmail IMAP server; label-derived Folder membership runs only when present. */
  gmailLabels?: string[];
  /** Every `Delivered-To` in header order plus `X-Original-To`/`Envelope-To`; precedence is applied in ingest. */
  deliveredToHeaders?: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
  bulkHeaders?: BulkMailHeaders;
  /** A `multipart/report; report-type=delivery-status` DSN/bounce, not a human reply. */
  isDsn?: boolean;
  /** IMAP flags in the fetched folder; `undefined` on REST adapters, which then leave read/flagged absent. */
  flags?: string[];
}
