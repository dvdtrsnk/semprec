import type { Pool, PoolClient } from "pg";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { ValidationError } from "../errors.js";
import {
  imapConnectionLimitForProvider,
  sharedImapConnectionLimiter,
  type ImapConnectionLimiter,
} from "./imapConnectionLimiter.js";
import type { ImapMailClient } from "./imapReconcile.js";
import type { SyncMode } from "./mailAccountSyncStateStore.js";
import {
  createSmtpTransporter,
  openImapConnection,
  type MailServerConnectionSettings,
  type MailServerCredential,
  type MailSmtpTransporter,
} from "./mailServerConnections.js";
import { getMailServerSettings } from "./mailServerSettingsStore.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import { IMAP_SEEN_FLAG } from "./messageFlags.js";
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

export type ImapConnectionOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => Promise<ImapMailClient>;

/**
 * Called once per send as the SMTP submission starts, so its IMAP connection opens while SMTP submits. `accepted`
 * settles `true` once the server took the message and `false` otherwise (it never rejects); the copy is appended only
 * on `true`. It settles only after its connection is closed. Its failure never fails the send.
 */
export type SentCopySaver = (raw: Buffer, accepted: Promise<boolean>) => Promise<void>;

/**
 * Sent copies that run on after their send answered. Shutdown drains them once no request can add one, before the
 * connections and the pool they use go away.
 */
export interface DetachedSentCopies {
  /** Takes over a copy that never rejects; it is held until it settles. */
  add(copy: Promise<void>): void;
  /** `true` once every copy added so far has settled, `false` when `timeoutMs` passed first. */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createDetachedSentCopies(): DetachedSentCopies {
  const running = new Set<Promise<void>>();
  return {
    add(copy) {
      const held = copy.finally(() => running.delete(held));
      running.add(held);
    },
    async drain(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          Promise.all(running).then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Each send opens its own policy-checked transporter and closes it on every path out. Exported for
 * protocol tests that need a loopback endpoint the stored settings (standard ports only) cannot name.
 *
 * IMAP servers do not file sent mail themselves, so `saveSentCopy` appends a Sent copy. It starts with the
 * submission. A refused submission waits for it, so its connection is closed before the refusal is answered. An
 * accepted one waits for it too unless `detached` is given: then the copy goes to `detached` and the send answers at
 * once, since the copy may wait for a connection slot the account's sync pass holds. Its failure after an accepted
 * submission is logged and does not fail the send, because the message has been delivered.
 */
export function createSmtpMailTransport(
  mailboxItemId: string,
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  open: SmtpTransporterOpener = createSmtpTransporter,
  saveSentCopy?: SentCopySaver,
  detached?: DetachedSentCopies,
): MailTransport {
  return {
    async send(message) {
      let transporter: MailSmtpTransporter | undefined;
      let primary: { value: unknown } | undefined;
      let sendOutcome: Promise<{ ok: true } | { ok: false; value: unknown }> | undefined;
      const secondary: unknown[] = [];
      const diagnostic = (stage: "send" | "close" | "sent_copy") => {
        try {
          logger.warn({ mailboxItemId, stage }, "SMTP operation reported a failure");
        } catch (error) {
          secondary.push(error);
        }
      };
      let decide!: (accepted: boolean) => void;
      const accepted = new Promise<boolean>((resolve) => {
        decide = resolve;
      });
      const copy = saveSentCopy?.(message.raw, accepted).then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
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
      decide(primary === undefined);
      if (primary === undefined && copy && detached) {
        detached.add(
          copy.then((copyFailure) => {
            if (copyFailure) diagnostic("sent_copy");
          }),
        );
        void secondary;
        return {};
      }
      const copyFailure = await copy;
      if (copyFailure) secondary.push(copyFailure.error);
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
      if (copyFailure) diagnostic("sent_copy");
      void secondary;
      return {};
    },
  };
}

/** `null` when no sync has discovered a Sent folder for this mailbox yet. */
async function sentFolderPathOf(
  client: PoolClient,
  moduleIds: MailModuleIds,
  mailboxItemId: string,
): Promise<string | null> {
  const mailboxRelation = await getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox");
  if (!mailboxRelation) throw new Error("Email module schema is missing the Folders.mailbox relation property");
  const folderId = await findFolderBySpecialPurpose(client, {
    foldersDatabaseId: moduleIds.foldersDatabaseId,
    mailboxRelationPropertyId: mailboxRelation.id,
    mailboxItemId,
    specialPurpose: "sent",
  });
  if (folderId === null) return null;
  const folder = await getItemById(client, moduleIds.foldersDatabaseId, folderId);
  const providerId = folder?.properties.providerId;
  if (typeof providerId !== "string") throw new Error("The Sent folder has no provider path");
  return providerId;
}

/**
 * Gmail and Graph file sent mail themselves; an IMAP server does not, so the raw message is appended
 * with `\Seen`. The connection goes through the outbound address policy and holds the account's IMAP
 * connection slot at the sync worker's limit. It opens while the submission runs; the APPEND waits for
 * `accepted` and is skipped, the connection closed, when the server refused the message. No Sent folder
 * yet logs `no_sent_folder` for an accepted message and keeps no copy.
 */
export function createSentCopySaver(
  pool: Pool,
  mailboxItemId: string,
  credential: MailServerCredential,
  openImap: ImapConnectionOpener = openImapConnection,
  limiter: ImapConnectionLimiter = sharedImapConnectionLimiter,
): SentCopySaver {
  return async (raw, accepted) => {
    let decision: boolean | undefined;
    const decided = accepted.then((value) => {
      decision = value;
      return value;
    });
    const stored = await getMailServerSettings(pool, mailboxItemId);
    if (!stored?.imap) {
      throw new ValidationError(`Mailbox ${mailboxItemId} has no IMAP server settings`, { field: "imap" });
    }
    const imapSettings: MailServerConnectionSettings = { endpoint: stored.imap, username: stored.username };

    const { sentPath, connectionLimit } = await withTransaction(pool, async (client) => {
      const moduleIds = await resolveMailModuleIds(client);
      const mailbox = await getItemById(client, moduleIds.mailboxesDatabaseId, mailboxItemId);
      const provider = typeof mailbox?.properties.provider === "string" ? mailbox.properties.provider : undefined;
      return {
        sentPath: await sentFolderPathOf(client, moduleIds, mailboxItemId),
        connectionLimit: imapConnectionLimitForProvider(provider, mailbox?.properties.connectionLimit),
      };
    });
    if (sentPath === null) {
      if (await decided)
        logger.warn(
          { mailboxItemId, reason: "no_sent_folder" },
          "The mailbox has no Sent folder yet; no copy was kept",
        );
      return;
    }

    await limiter.run(mailboxItemId, connectionLimit, async () => {
      // A submission refused before the slot was free needs no connection.
      if (decision === false) return;
      const imap = await openImap(imapSettings, credential);
      try {
        if (await decided) await imap.appendMessage(sentPath, raw, [IMAP_SEEN_FLAG]);
      } finally {
        // close() never rejects, so the append's own outcome is the one the saver reports.
        await imap.close();
      }
    });
  };
}

export interface MailTransportFactoryOptions {
  gmailOAuthClient?: { clientId: string; clientSecret: string };
  graphOAuthClient?: { clientId: string; clientSecret: string };
  fetchImpl?: typeof fetch;
  openImapConnection?: ImapConnectionOpener;
  /** Given, an accepted SMTP send answers before its Sent copy, which this owns (`createSmtpMailTransport`). */
  detachedSentCopies?: DetachedSentCopies;
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
        createSentCopySaver(pool, mailboxItemId, { password }, options.openImapConnection),
        options.detachedSentCopies,
      );
    },
  };
}
