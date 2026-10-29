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
import { createGmailMailTransport } from "./gmailTransport.js";
import { MailRecipientRejectedError, MailSendAuthFailedError } from "./providerTypes.js";
import { NodemailerSmtpClient, type RawMailEnvelope } from "./smtpClient.js";

/**
 * How a mailbox submits outgoing mail. `sendDraftEmail` (mail/send.ts) builds a complete RFC 5322 message
 * once (mail/outgoingMime.ts) and hands it to the transport of the mailbox's sync mode, so each provider
 * differs only in how the bytes leave. The SMTP transport below serves `imap` mailboxes, the Gmail API
 * transport (gmailTransport.ts) serves `gmail_api` mailboxes, and the Microsoft Graph transport (#1753)
 * will implement this same interface.
 */
export interface MailTransportMessage {
  raw: Buffer;
  envelope: RawMailEnvelope;
  /**
   * The provider's thread id of the message being replied to, for a provider that files sent mail into a
   * conversation by id. The Gmail API transport passes it as the send's `threadId`. The SMTP transport ignores it.
   */
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

export interface MailTransportFactoryOptions {
  /** The Google OAuth client the `gmail_api` transport refreshes its access tokens with. Without it a Gmail mailbox cannot send. */
  gmailOAuthClient?: { clientId: string; clientSecret: string };
  /** Replaces the global `fetch` for the Gmail transport's token endpoint and API requests. Tests inject a fake Google here. */
  fetchImpl?: typeof fetch;
}

/**
 * The transport factory a composition root hands `sendDraftEmail`. `forMailbox` picks the transport of the
 * mailbox's sync mode. For `imap` it reads the mailbox's stored SMTP settings and decrypts its app-specific
 * password for the `smtp_send` purpose; `sendDraftEmail` gets the password only through this factory. For
 * `gmail_api` it builds the Gmail transport from `options.gmailOAuthClient`. `graph_api` has no transport yet (#1753).
 */
export function createMailTransportFactory(
  pool: Pool,
  options: MailTransportFactoryOptions = {},
): MailTransportFactory {
  return {
    async forMailbox(mailboxItemId, syncMode) {
      if (syncMode === "gmail_api") {
        const { gmailOAuthClient, fetchImpl } = options;
        if (!gmailOAuthClient) {
          throw new Error("No Gmail OAuth client is configured for this composition root");
        }
        return createGmailMailTransport({
          pool,
          mailboxItemId,
          clientId: gmailOAuthClient.clientId,
          clientSecret: gmailOAuthClient.clientSecret,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      }
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
