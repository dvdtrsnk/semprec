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
import { createGraphMailTransport } from "./graphTransport.js";
import {
  MailRecipientRejectedError,
  MailSendAuthFailedError,
  MailServerUnreachableError,
  MailTransportUnavailableError,
} from "./providerTypes.js";
import { NodemailerSmtpClient, type RawMailEnvelope } from "./smtpClient.js";

/**
 * The complete RFC 5322 message is built once (outgoingMime.ts); providers differ only in how the bytes
 * leave: SMTP for `imap`, Gmail API for `gmail_api`, Microsoft Graph for `graph_api`.
 */
export interface MailTransportMessage {
  raw: Buffer;
  envelope: RawMailEnvelope;
  /** Provider thread id of the replied-to message; only the Gmail API transport uses it. */
  providerThreadId?: string;
}

export interface MailTransportResult {
  /** SMTP reports none. */
  providerMessageId?: string;
  /**
   * `true` when the provider files no Sent copy itself (SMTP): the caller records the message with
   * `recordPendingSentCopy` in the transaction that records the send, and a queue job appends it.
   */
  needsSentCopy?: true;
}

export interface MailTransport {
  send(message: MailTransportMessage): Promise<MailTransportResult>;
}

export interface MailTransportFactory {
  /**
   * Rejects with `ValidationError` when the mailbox has no SMTP settings and with
   * `MailTransportUnavailableError` when no transport is configured; any other rejection is retryable.
   */
  forMailbox(mailboxItemId: string, syncMode: SyncMode): Promise<MailTransport>;
}

function fieldOf(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

/**
 * nodemailer reports a failed login as `EAUTH` and a refusal of every recipient as `EENVELOPE` (5xx).
 * Unknown failures leave as a fixed generic error after the transport has been closed.
 */
function mapSmtpSendFailure(error: unknown): Error {
  if (error instanceof MailServerUnreachableError) return new MailServerUnreachableError();
  if (error instanceof MailSendAuthFailedError) return new MailSendAuthFailedError();
  if (error instanceof MailRecipientRejectedError) return new MailRecipientRejectedError();
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
  return new Error("SMTP submission failed unexpectedly");
}

export type SmtpTransporterOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => MailSmtpTransporter;

/**
 * Each send opens its own policy-checked transporter and closes it on every path out. Exported for
 * protocol tests that need a loopback endpoint the stored settings (standard ports only) cannot name.
 *
 * IMAP servers do not file sent mail themselves, so an accepted send answers `needsSentCopy`: the caller records the
 * copy durably and a queue job appends it. The send never waits for an IMAP connection.
 */
export function createSmtpMailTransport(
  mailboxItemId: string,
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  open: SmtpTransporterOpener = createSmtpTransporter,
): MailTransport {
  return {
    async send(message) {
      let transporter: MailSmtpTransporter | undefined;
      let primary: { value: unknown } | undefined;
      let sendOutcome: Promise<{ ok: true } | { ok: false; value: unknown }> | undefined;
      const secondary: unknown[] = [];
      const diagnostic = (stage: "send" | "close") => {
        try {
          logger.warn({ mailboxItemId, stage }, "SMTP operation reported a failure");
        } catch (error) {
          secondary.push(error);
        }
      };
      try {
        transporter = open(settings, credential);
        const owned = transporter;
        await new NodemailerSmtpClient({
          sendMail(message) {
            const operation = owned.sendMail(message);
            sendOutcome = operation.then(
              () => ({ ok: true as const }),
              (value: unknown) => ({ ok: false as const, value }),
            );
            return operation;
          },
        }).sendRaw({ raw: message.raw, envelope: message.envelope });
      } catch (error) {
        primary = { value: error };
      }
      if (transporter) {
        try {
          transporter.close();
        } catch (error) {
          secondary.push(error);
          diagnostic("close");
        }
      }
      if (sendOutcome) {
        const settled = await sendOutcome;
        if (!settled.ok && (!primary || settled.value !== primary.value)) secondary.push(settled.value);
      }
      if (primary) {
        let mapped: Error;
        try {
          mapped = mapSmtpSendFailure(primary.value);
        } catch (classificationError) {
          secondary.push(classificationError);
          mapped = new Error("SMTP submission failed unexpectedly");
        }
        diagnostic("send");
        // The original and all secondary values remain local through cleanup and diagnostics.
        void secondary;
        throw mapped;
      }
      void secondary;
      return { needsSentCopy: true };
    },
  };
}

export interface MailTransportFactoryOptions {
  gmailOAuthClient?: { clientId: string; clientSecret: string };
  graphOAuthClient?: { clientId: string; clientSecret: string };
  fetchImpl?: typeof fetch;
}

/**
 * Picks the transport of the mailbox's sync mode. For `imap` it decrypts the SMTP password for the
 * `smtp_send` purpose; `sendDraftEmail` gets the password only through this factory.
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
          throw new MailTransportUnavailableError("No Gmail OAuth client is configured for this composition root");
        }
        return createGmailMailTransport({
          pool,
          mailboxItemId,
          clientId: gmailOAuthClient.clientId,
          clientSecret: gmailOAuthClient.clientSecret,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      }
      if (syncMode === "graph_api") {
        const { graphOAuthClient, fetchImpl } = options;
        if (!graphOAuthClient) {
          throw new MailTransportUnavailableError(
            "No Microsoft Graph OAuth client is configured for this composition root",
          );
        }
        return createGraphMailTransport({
          pool,
          mailboxItemId,
          clientId: graphOAuthClient.clientId,
          clientSecret: graphOAuthClient.clientSecret,
          fetchImpl,
        });
      }
      if (syncMode !== "imap") {
        // Only a stored value outside the SYNC_MODES union reaches this line.
        const unnamedMode: string = syncMode;
        throw new MailTransportUnavailableError(`No mail transport for sync mode ${unnamedMode} is available yet`);
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
      if (password === null) {
        throw new MailTransportUnavailableError(`Mailbox ${mailboxItemId} has no stored credential`);
      }
      return createSmtpMailTransport(
        mailboxItemId,
        { endpoint: stored.smtp, username: stored.username },
        { password },
        createSmtpTransporter,
      );
    },
  };
}
