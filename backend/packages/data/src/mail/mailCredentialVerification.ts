import { ValidationError } from "../errors.js";
import { logger } from "./logger.js";
import {
  verifyImapServerConnection,
  verifySmtpServerConnection,
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
}

export interface VerifiedMailServerSettings {
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
}

/** Verifies both encrypted connections without storing a mailbox or its credentials. */
export async function verifyMailCredentials(input: VerifyMailCredentialsInput): Promise<VerifiedMailServerSettings> {
  return verifyMailCredentialsWithOptions(input);
}

/** Test-only port and trust roots preserve the production policy and endpoint selection. */
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
  const verify = async (endpoints: MailServerEndpoint[], protocol: "imap" | "smtp") => {
    let authentication = false;
    let tls = false;
    for (const endpoint of endpoints) {
      let result: Awaited<ReturnType<typeof verifyImapServerConnection>>;
      try {
        const settings = { endpoint, username: input.username };
        result =
          protocol === "imap"
            ? await verifyImapServerConnection(settings, credential, {}, testOptions)
            : await verifySmtpServerConnection(settings, credential, {}, testOptions);
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
      if (result === "success") return endpoint;
      if (result === "authentication") authentication = true;
      if (result === "tls") tls = true;
    }
    if (authentication)
      throw input.provider === "icloud" ? new MailAppPasswordRequiredError() : new MailAuthFailedError();
    if (tls) throw new MailTlsFailedError();
    throw new MailServerUnreachableError();
  };
  return { imap: await verify(imap, "imap"), smtp: await verify(smtp, "smtp") };
}
