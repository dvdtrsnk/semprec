import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ImapFlow } from "imapflow";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { IMAP_FULL_MESSAGES_PER_PASS, type ImapMailClient } from "../mail/imapReconcile.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { handleSyncMailAccountTask, type MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { FakeImapAccount } from "./fakeImapAccount.js";
import { FakeImapServer } from "./fakeImapServer.js";

export const IMAP_FIXTURE_ACCOUNT = "owner@example.test";

/** The six folders of the Purelymail account the production measurements came from. */
export const PURELYMAIL_FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Sent", specialUse: "\\Sent" },
  { path: "Drafts", specialUse: "\\Drafts" },
  { path: "Archive", specialUse: "\\Archive" },
  { path: "Trash", specialUse: "\\Trash" },
  { path: "Junk", specialUse: "\\Junk" },
] as const;

const UNUSED_STORAGE = "the fixture's messages carry no attachments";
export const noAttachmentStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(UNUSED_STORAGE)),
  delete: async () => {},
  readStream: () => {
    throw new Error(UNUSED_STORAGE);
  },
};

/**
 * A plain-text message from someone else to the fixture account, with a unique Message-ID unless one is given, dated
 * now unless a date is given.
 */
export function plainMessage(
  subject: string,
  options: { messageId?: string; headers?: readonly string[]; date?: Date } = {},
): Buffer {
  return Buffer.from(
    [
      `Message-ID: ${options.messageId ?? `<${randomUUID()}@sender.example.test>`}`,
      "From: Sender <sender@sender.example.test>",
      `To: ${IMAP_FIXTURE_ACCOUNT}`,
      `Subject: ${subject}`,
      `Date: ${(options.date ?? new Date()).toUTCString()}`,
      ...(options.headers ?? []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      `${subject} body`,
      "",
    ].join("\r\n"),
  );
}

export interface ImapMailboxFixture {
  mailboxId: string;
  /**
   * One `mailAccountSync` run through the production handler, with the given provider client factory, writing
   * attachment bytes to `storage` (by default none may be written).
   */
  sync(
    createImapClient: NonNullable<MailSyncAdapterFactory["createImapClient"]>,
    storage?: BlobStorageWriter,
  ): Promise<void>;
}

/** A connected generic IMAP mailbox (item, address, sync state, credential) in the current tenant scope. */
export async function createImapMailboxFixture(runtime: Pool): Promise<ImapMailboxFixture> {
  const databases = await createChokePoint(runtime).listDatabases();
  const mailboxesDatabaseId = databases.find((row) => row.ownerModuleId === "mailboxes")?.id;
  if (!mailboxesDatabaseId) throw new Error("Missing mailboxes database");
  const mailboxId = await withTransaction(runtime, async (client) => {
    const mailbox = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "Purelymail", provider: "generic" },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId,
      mailboxItemId: mailbox.id,
      address: IMAP_FIXTURE_ACCOUNT,
    });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
    await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "app-password" });
    return mailbox.id;
  });
  return {
    mailboxId,
    async sync(createImapClient, storage = noAttachmentStorage) {
      const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      await handleSyncMailAccountTask(
        runtime,
        { mailboxItemId: mailboxId },
        { createImapClient },
        moduleIds,
        storage,
      );
    },
  };
}

/** The production provider client (imapflow behind `ImapFlowMailClient`) over plain TCP to a loopback server. */
export async function connectLoopbackImapClient(port: number): Promise<ImapMailClient> {
  const flow = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: IMAP_FIXTURE_ACCOUNT, pass: "app-password" },
    // As production's connections: ENABLE QRESYNC where the server advertises it.
    qresync: true,
    logger: false,
  });
  // imapflow throws from its emitter when an error event has no listener; a failure still reaches the pass through
  // the command it fails.
  flow.on("error", () => {});
  await flow.connect();
  return new ImapFlowMailClient(flow);
}

/** About 20 messages over the six folders, as in the production account; INBOX holds unread ones. */
const FLAGS: Record<string, Array<readonly string[]>> = {
  INBOX: [[], [], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Sent: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Drafts: [[IMAP_SEEN_FLAG]],
  Archive: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Trash: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Junk: [[]],
};
/** Each folder's messages are named `<folder> <n>`. */
export const PURELYMAIL_CONTENT: Record<string, readonly LoopbackMessage[]> = Object.fromEntries(
  Object.entries(FLAGS).map(([path, flags]) => [
    path,
    flags.map((messageFlags, index) => ({ subject: `${path} ${index + 1}`, flags: messageFlags })),
  ]),
);

/** One message of a loopback mailbox: its subject (unique within the mailbox), flags and optional extra headers. */
export interface LoopbackMessage {
  subject: string;
  flags?: readonly string[];
  /** Header lines added to the plain message, such as `In-Reply-To: <...>`. */
  headers?: readonly string[];
  messageId?: string;
}

export interface SyncedLoopbackMailbox {
  mailbox: ImapMailboxFixture;
  server: FakeImapServer;
  /** The loopback server's port. */
  port: number;
  /** A new connection of the production client to the loopback server. */
  overWire: () => Promise<ImapMailClient>;
  /** The server UID of the message with `subject` in `path`. */
  uidOf(path: string, subject: string): number;
}

/**
 * A Purelymail-like mailbox whose messages are ingested through an in-memory account with the same folders, UIDs,
 * flags and bytes as the loopback server, then synced once over the wire so the folder state holds the server's
 * cursors. Mail already ingested this way is what a pass over the wire finds known.
 */
export async function createSyncedLoopbackMailbox(
  runtime: Pool,
  options: { capabilities: readonly string[]; latencyMs: number; content: Record<string, readonly LoopbackMessage[]> },
): Promise<SyncedLoopbackMailbox> {
  const account = new FakeImapAccount([...PURELYMAIL_FOLDERS]);
  const server = new FakeImapServer({
    folders: PURELYMAIL_FOLDERS,
    capabilities: options.capabilities,
    latencyMs: options.latencyMs,
  });
  const uids = new Map<string, number>();
  for (const [path, messages] of Object.entries(options.content)) {
    for (const message of messages) {
      const raw = plainMessage(message.subject, message);
      account.deliver(path, raw, message.flags);
      uids.set(`${path}\n${message.subject}`, server.deliver(path, message.flags, raw));
    }
  }
  const port = await server.listen();
  const mailbox = await createImapMailboxFixture(runtime);
  const total = Object.values(options.content).reduce((sum, messages) => sum + messages.length, 0);
  // A pass ingests at most `IMAP_FULL_MESSAGES_PER_PASS` messages in full.
  for (let pass = 0; pass <= Math.ceil(total / IMAP_FULL_MESSAGES_PER_PASS); pass++)
    await mailbox.sync(async () => account.client());
  const overWire = () => connectLoopbackImapClient(port);
  await mailbox.sync(overWire);
  return {
    mailbox,
    server,
    port,
    overWire,
    uidOf(path, subject) {
      const uid = uids.get(`${path}\n${subject}`);
      if (uid === undefined) throw new Error(`No message ${subject} in ${path}`);
      return uid;
    },
  };
}
