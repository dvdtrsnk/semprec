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
 * How a mailbox submits outgoing mail. `sendDraftEmail` (mail/send.ts) builds a complete RFC 5322 message
 * once (mail/outgoingMime.ts) and hands it to the transport of the mailbox's sync mode, so each provider
 * differs only in how the bytes leave. The SMTP transport below serves `imap` mailboxes, the Gmail API
 * transport (gmailTransport.ts) serves `gmail_api` mailboxes, and the Microsoft Graph transport (graphTransport.ts)
 * serves `graph_api` mailboxes.
 */
export interface MailTransportMessage {
  raw: Buffer;
  envelope: RawMailEnvelope;
  /**
   * The provider's thread id of the message being replied to, for a provider that files sent mail into a
   * conversation by id. The Gmail API transport passes it as the send's `threadId`. The SMTP and Microsoft Graph
   * transports ignore it.
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
  /**
   * The transport that sends for this mailbox. Rejects with a `ValidationError` when the mailbox has no SMTP settings
   * and with a `MailTransportUnavailableError` when the composition root has no transport for it; any other rejection
   * is a failure of a read that may succeed on a retry.
   */
  forMailbox(mailboxItemId: string, syncMode: SyncMode): Promise<MailTransport>;
}

function fieldOf(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

/**
 * Maps the two SMTP failures this transport names. nodemailer reports a failed login as `EAUTH` (a 535 among
 * other login failures), and a refusal of every recipient on `RCPT TO` as `EENVELOPE` with a 5xx response.
 * Already-classified connection failures remain unreachable. Unknown failures leave this
 * boundary as a fixed generic error after the transport has been closed.
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

/** Opens an SMTP transporter for one mailbox; `createSmtpTransporter` is the production opener. */
export type SmtpTransporterOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => MailSmtpTransporter;

/** Opens the IMAP connection a Sent-folder copy is appended over; `openImapConnection` is the production opener. */
export type ImapConnectionOpener = (
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
) => Promise<ImapMailClient>;

/**
 * Keeps a copy of a message the SMTP server accepted (issue #1641). `createSmtpMailTransport` calls it once per
 * accepted send, after the submission succeeded and the SMTP connection was closed. Its failure never fails the send.
 */
export type SentCopySaver = (raw: Buffer) => Promise<void>;

/**
 * The SMTP transport of an `imap` mailbox. Each send opens its own transporter through the policy-checked
 * factory, submits the raw message with its envelope, and closes the transporter on every path out. Closing
 * ends any connection the send still holds (`createSmtpTransporter`'s `close`). Exported for the protocol
 * tests, which take a loopback endpoint that the stored settings (standard ports only) cannot name, and
 * which inject `open` to observe the close; the production path is `createMailTransportFactory`.
 *
 * Once the server accepts the message, `saveSentCopy` keeps a copy in the Sent folder (IMAP servers do not file
 * sent mail by themselves). A failure there is logged with a fixed stage and does not fail the send, because the
 * message has been delivered. Omitted, the send keeps no copy; the production factory always supplies one.
 */
export function createSmtpMailTransport(
  mailboxItemId: string,
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  open: SmtpTransporterOpener = createSmtpTransporter,
  saveSentCopy?: SentCopySaver,
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
      if (saveSentCopy) {
        try {
          await saveSentCopy(message.raw);
        } catch (error) {
          secondary.push(error);
          diagnostic("sent_copy");
        }
      }
      void secondary;
      return {};
    },
  };
}

/**
 * The IMAP path of the mailbox's Sent folder: the Folder item with `specialPurpose` `sent` (the folder `sendDraftEmail`
 * files a sent draft into, mail/send.ts), whose `providerId` is the path the sync recorded. `null` when no sync has
 * discovered a Sent folder for this mailbox yet.
 */
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
 * Builds the `SentCopySaver` of one `imap` mailbox (issue #1641). Gmail and Graph file a sent message in their Sent
 * folder themselves; an IMAP server does not, so the raw message is appended here.
 *
 * The saver reads the mailbox's IMAP endpoint and its Sent folder's path at send time, the way the sync worker does.
 * It opens the connection through `openImap` (`openImapConnection` in production, so the outbound address policy
 * applies), appends the message with the `\Seen` flag, and closes the connection on every path out. The append holds
 * the account's IMAP connection slot (`sharedImapConnectionLimiter`) at the limit the sync worker uses. A mailbox with
 * no Sent folder yet logs `no_sent_folder` and keeps no copy. Every other failure rejects, and
 * `createSmtpMailTransport` logs it.
 */
export function createSentCopySaver(
  pool: Pool,
  mailboxItemId: string,
  credential: MailServerCredential,
  openImap: ImapConnectionOpener = openImapConnection,
  limiter: ImapConnectionLimiter = sharedImapConnectionLimiter,
): SentCopySaver {
  return async (raw) => {
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
      logger.warn({ mailboxItemId, reason: "no_sent_folder" }, "The mailbox has no Sent folder yet; no copy was kept");
      return;
    }

    await limiter.run(mailboxItemId, connectionLimit, async () => {
      const imap = await openImap(imapSettings, credential);
      try {
        await imap.appendMessage(sentPath, raw, [IMAP_SEEN_FLAG]);
      } finally {
        // close() never rejects, so the append's own outcome is the one the saver reports.
        await imap.close();
      }
    });
  };
}

export interface MailTransportFactoryOptions {
  /** The Google OAuth client the `gmail_api` transport refreshes its access tokens with. Without it a Gmail mailbox cannot send. */
  gmailOAuthClient?: { clientId: string; clientSecret: string };
  /** The Microsoft OAuth client the `graph_api` transport refreshes its access tokens with. Without it a Graph mailbox cannot send. */
  graphOAuthClient?: { clientId: string; clientSecret: string };
  /**
   * Replaces the global `fetch` for the Gmail and Graph transports' token endpoints and API requests. Tests inject a
   * fake provider here.
   */
  fetchImpl?: typeof fetch;
  /** Replaces `openImapConnection` for the copy an `imap` send keeps in the Sent folder. Tests inject a fake IMAP server here. */
  openImapConnection?: ImapConnectionOpener;
}

/**
 * The transport factory a composition root hands `sendDraftEmail`. `forMailbox` picks the transport of the
 * mailbox's sync mode. For `imap` it reads the mailbox's stored SMTP settings and decrypts its app-specific
 * password for the `smtp_send` purpose; `sendDraftEmail` gets the password only through this factory. The `imap`
 * transport also keeps a copy of each accepted message in the Sent folder (`createSentCopySaver`, issue #1641). For
 * `gmail_api` it builds the Gmail transport from `options.gmailOAuthClient`, and for `graph_api` the Graph transport
 * from `options.graphOAuthClient`.
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
        // Every SYNC_MODES value has a transport above, so only a stored value outside the union reaches this line.
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
      );
    },
  };
}
