import type { Pool } from "pg";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { ValidationError } from "../errors.js";
import type { SyncMode } from "./mailAccountSyncStateStore.js";
import {
  createSmtpTransporter,
  type MailServerConnectionSettings,
  type MailServerCredential,
  type MailSmtpTransporter,
} from "./mailServerConnections.js";
import { getMailServerSettings } from "./mailServerSettingsStore.js";
import { logger } from "./logger.js";
import { MailRecipientRejectedError, MailSendAuthFailedError } from "./providerTypes.js";
import { NodemailerSmtpClient, type RawMailEnvelope } from "./smtpClient.js";

/**
 * How a mailbox submits outgoing mail. `sendDraftEmail` (mail/send.ts) builds a complete RFC 5322 message
 * once (mail/outgoingMime.ts) and hands it to the transport of the mailbox's sync mode, so each provider
 * differs only in how the bytes leave. The SMTP transport below serves `imap` mailboxes; the Gmail API and
 * Microsoft Graph transports implement this same interface (#1637, #1753).
 */
export interface MailTransportMessage {
  raw: Buffer;
  envelope: RawMailEnvelope;
  /** The provider's thread id, for a provider that threads sent mail itself (Gmail's `X-GM-THRID`). The SMTP transport ignores it. */
  providerThreadId?: string;
}

export interface MailTransportResult {
  /** The provider's id for the sent message, when the provider reports one. SMTP does not. */
  providerMessageId?: string;
}

export interface MailTransport {
  send(message: MailTransportMessage): Promise<MailTransportResult>;
}

export interface MailTransportFactory {
  /** The transport that sends for this mailbox. Rejects when the mailbox cannot send over its configured server. */
  forMailbox(mailboxItemId: string, syncMode: SyncMode): Promise<MailTransport>;
}

function fieldOf(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

/**
 * Maps the two SMTP failures this transport names. nodemailer reports a failed login as `EAUTH` (a 535 among
 * other login failures), and a refusal of every recipient on `RCPT TO` as `EENVELOPE` with a 5xx response.
 * Any other error passes through unchanged, including the connect and timeout failures that
 * `createSmtpTransporter` and the send client have already mapped to `MailServerUnreachableError`.
 */
function mapSmtpSendFailure(error: unknown): unknown {
  if (fieldOf(error, "code") === "EAUTH") return new MailSendAuthFailedError();
  const responseCode = fieldOf(error, "responseCode");
  if (
    fieldOf(error, "code") === "EENVELOPE" &&
    fieldOf(error, "command") === "RCPT TO" &&
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode <= 599
  ) {
    return new MailRecipientRejectedError();
  }
  return error;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "NonError";
}

/** Opens an SMTP transporter for one mailbox; `createSmtpTransporter` is the production opener. */
export type SmtpTransporterOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => MailSmtpTransporter;

/**
 * The SMTP transport of an `imap` mailbox. Each send opens its own transporter through the policy-checked
 * factory, submits the raw message with its envelope, and closes the transporter on every path out. Closing
 * ends any connection the send still holds (`createSmtpTransporter`'s `close`). Exported for the protocol
 * tests, which take a loopback endpoint that the stored settings (standard ports only) cannot name, and
 * which inject `open` to observe the close; the production path is `createMailTransportFactory`.
 */
export function createSmtpMailTransport(
  mailboxItemId: string,
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  open: SmtpTransporterOpener = createSmtpTransporter,
): MailTransport {
  return {
    async send(message) {
      const transporter = open(settings, credential);
      try {
        await new NodemailerSmtpClient(transporter).sendRaw({ raw: message.raw, envelope: message.envelope });
      } catch (error) {
        const mapped = mapSmtpSendFailure(error);
        if (mapped !== error) logger.warn({ mailboxItemId, errorName: errorNameOf(mapped) }, "SMTP send was refused");
        throw mapped;
      } finally {
        try {
          transporter.close();
        } catch (error) {
          // The send's outcome is the error the caller needs; a failed close is logged and not rethrown.
          logger.warn({ mailboxItemId, errorName: errorNameOf(error) }, "Closing the SMTP transporter failed");
        }
      }
      return {};
    },
  };
}

/**
 * The transport factory a composition root hands `sendDraftEmail`. `forMailbox` reads the mailbox's stored
 * SMTP settings and decrypts its app-specific password for the `smtp_send` purpose; `sendDraftEmail` gets the
 * password only through this factory. Only the `imap` sync mode has a transport so far.
 */
export function createMailTransportFactory(pool: Pool): MailTransportFactory {
  return {
    async forMailbox(mailboxItemId, syncMode) {
      if (syncMode !== "imap") {
        throw new Error(`No mail transport for sync mode ${syncMode} is available yet`);
      }
      const stored = await getMailServerSettings(pool, mailboxItemId);
      if (!stored?.smtp) {
        throw new ValidationError(`Mailbox ${mailboxItemId} has no SMTP server settings`, { field: "smtp" });
      }
      const password = await getDecryptedCredential(pool, {
        itemId: mailboxItemId,
        actorType: "smtp_send",
        purpose: "smtp_send",
      });
      if (password === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
      return createSmtpMailTransport(mailboxItemId, { endpoint: stored.smtp, username: stored.username }, { password });
    },
  };
}
