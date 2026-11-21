import { ValidationError } from "../errors.js";
import { logger } from "./logger.js";
import type { ImapFolderRef } from "./imapReconcile.js";
import {
  verifyImapServerConnection,
  verifyImapServerConnectionAndListFolders,
  verifySmtpServerConnection,
  type ImapVerification,
  type VerificationTestOptions,
} from "./mailServerConnections.js";
import type { MailServerEndpoint } from "./mailServerSettingsStore.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "./providerTypes.js";

export interface VerifyMailCredentialsInput {
  provider: "icloud" | "generic";
  address: string;
  username: string;
  password: string;
  imapHost?: string;
  smtpHost?: string;
  /** Lists the folders on the IMAP connection whose login succeeded, before closing it. */
  listFolders?: boolean;
}

export interface VerifiedMailServerSettings {
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
  /** `null` when the folders were not asked for or their listing failed (logged); the login is verified either way. */
  folders: ImapFolderRef[] | null;
}

/**
 * Verifies both encrypted connections without storing a mailbox or its credentials. IMAP and SMTP are verified
 * concurrently, each trying its candidates in order; both settle before it returns, and when both fail the IMAP
 * failure is the one thrown.
 */
export async function verifyMailCredentials(input: VerifyMailCredentialsInput): Promise<VerifiedMailServerSettings> {
  return verifyMailCredentialsWithOptions(input);
}

/** Test port and trust roots; policy and endpoint selection stay as in production. */
export async function verifyMailCredentialsForTests(
  input: VerifyMailCredentialsInput,
  options: VerificationTestOptions,
): Promise<VerifiedMailServerSettings> {
  if (process.env.NODE_ENV !== "test") throw new Error("Verification test options require test mode");
  return verifyMailCredentialsWithOptions(input, options);
}

async function verifyMailCredentialsWithOptions(
  input: VerifyMailCredentialsInput,
  testOptions?: VerificationTestOptions,
): Promise<VerifiedMailServerSettings> {
  const imapHost = input.provider === "icloud" ? "imap.mail.me.com" : input.imapHost;
  const smtpHost = input.provider === "icloud" ? "smtp.mail.me.com" : input.smtpHost;
  if (!imapHost || !smtpHost) throw new ValidationError("IMAP and SMTP hosts are required");
  const imap: MailServerEndpoint[] =
    input.provider === "icloud"
      ? [{ host: imapHost, port: 993, security: "tls" }]
      : [
          { host: imapHost, port: 993, security: "tls" },
          { host: imapHost, port: 143, security: "starttls" },
        ];
  const smtp: MailServerEndpoint[] =
    input.provider === "icloud"
      ? [{ host: smtpHost, port: 587, security: "starttls" }]
      : [
          { host: smtpHost, port: 465, security: "tls" },
          { host: smtpHost, port: 587, security: "starttls" },
        ];
  const credential = { password: input.password };
  const attempt = async (endpoint: MailServerEndpoint, protocol: "imap" | "smtp"): Promise<ImapVerification> => {
    const settings = { endpoint, username: input.username };
    if (protocol === "smtp") {
      return { attempt: await verifySmtpServerConnection(settings, credential, {}, testOptions), folders: null };
    }
    if (input.listFolders === true) {
      return verifyImapServerConnectionAndListFolders(settings, credential, {}, testOptions);
    }
    return { attempt: await verifyImapServerConnection(settings, credential, {}, testOptions), folders: null };
  };
  const verify = async (
    endpoints: MailServerEndpoint[],
    protocol: "imap" | "smtp",
  ): Promise<{ endpoint: MailServerEndpoint; folders: ImapFolderRef[] | null }> => {
    let authentication = false;
    let tls = false;
    for (const endpoint of endpoints) {
      let result: ImapVerification;
      try {
        result = await attempt(endpoint, protocol);
      } catch (error) {
        const internalFailures: unknown[] = [error];
        try {
          logger.error(
            { errorCategory: error instanceof Error ? "error" : "non_error", protocol },
            "Mail credential verification failed unexpectedly",
          );
        } catch (diagnosticError) {
          internalFailures.push(diagnosticError);
        }
        // Exact values remain local through diagnostics; the outward boundary carries no raw cause.
        void internalFailures;
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Mail credential verification failed unexpectedly");
      }
      if (result.attempt === "success") return { endpoint, folders: result.folders };
      if (result.attempt === "authentication") authentication = true;
      if (result.attempt === "tls") tls = true;
    }
    if (authentication)
      throw input.provider === "icloud" ? new MailAppPasswordRequiredError() : new MailAuthFailedError();
    if (tls) throw new MailTlsFailedError();
    throw new MailServerUnreachableError();
  };
  // Each attempt releases its own connection before it settles, so both settled means nothing is left open.
  const [imapOutcome, smtpOutcome] = await Promise.allSettled([verify(imap, "imap"), verify(smtp, "smtp")]);
  // An SMTP failure behind an IMAP failure is not reported; an unexpected one was logged where it was caught.
  if (imapOutcome.status === "rejected") throw imapOutcome.reason;
  if (smtpOutcome.status === "rejected") throw smtpOutcome.reason;
  return { imap: imapOutcome.value.endpoint, smtp: smtpOutcome.value.endpoint, folders: imapOutcome.value.folders };
}
