import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ImapFlow } from "imapflow";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { createImapConnectionLimiter, type ImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";

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

/** A plain-text message with a unique Message-ID from someone else to the fixture account. */
export function plainMessage(subject: string): Buffer {
  return Buffer.from(
    [
      `Message-ID: <${randomUUID()}@sender.example.test>`,
      "From: Sender <sender@sender.example.test>",
      `To: ${IMAP_FIXTURE_ACCOUNT}`,
      `Subject: ${subject}`,
      "Date: Sat, 21 Nov 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `${subject} body`,
      "",
    ].join("\r\n"),
  );
}

export interface ImapMailboxFixture {
  mailboxId: string;
  /** One `mailAccountSync` run through the production handler, with the given provider client factory. */
  sync(createImapClient: () => Promise<ImapMailClient>): Promise<void>;
}

/** A connected generic IMAP mailbox (item, address, sync state, credential) in the current tenant scope. */
export async function createImapMailboxFixture(
  runtime: Pool,
  limiter: ImapConnectionLimiter = createImapConnectionLimiter(),
): Promise<ImapMailboxFixture> {
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
    async sync(createImapClient) {
      const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      await handleSyncMailAccountTask(
        runtime,
        { mailboxItemId: mailboxId },
        { createImapClient },
        moduleIds,
        noAttachmentStorage,
        undefined,
        limiter,
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
    logger: false,
  });
  // imapflow throws from its emitter when an error event has no listener; a failure still reaches the pass through
  // the command it fails.
  flow.on("error", () => {});
  await flow.connect();
  return new ImapFlowMailClient(flow);
}
