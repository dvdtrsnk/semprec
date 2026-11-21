import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { createMailDraftCreateRouteHandler, createMailDraftSendRouteHandler } from "../mail/mailDraftRouteHandlers.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { getMailThreadDetail } from "../mail/mailThreadDetail.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import {
  createMailThreadArchiveRouteHandler,
  createMailThreadFlagRouteHandler,
  createMailThreadReadRouteHandler,
  createMailThreadRestoreRouteHandler,
  createMailThreadTrashRouteHandler,
} from "../mail/mailThreadRoutes.js";
import type { MailTransport } from "../mail/mailTransport.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { IMAP_FLAGGED_FLAG, IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import { sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// A Purelymail-like IMAP account that sends only from itself: every test mail is addressed to the account, so the
// server delivers it to INBOX while the Sent-copy saver appends it to Sent. Both provider copies share one
// Message-ID and converge onto one Emails item.

let admin: Pool;
let runtime: Pool;
let tenant: string;

const USER_ID = randomUUID();
const ACCOUNT = "debug@example.test";

const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Sent", specialUse: "\\Sent" },
  { path: "Drafts", specialUse: "\\Drafts" },
  { path: "Archive", specialUse: "\\Archive" },
  { path: "Trash", specialUse: "\\Trash" },
];

const UNUSED_STORAGE = "self-addressed mail carries no attachments";
const noStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(UNUSED_STORAGE)),
  delete: async () => {},
  readStream: () => {
    throw new Error(UNUSED_STORAGE);
  },
};

const ctx = (params: Record<string, string>, body: unknown) => ({
  params,
  body,
  identity: { user: { id: USER_ID, locale: "en" } },
});

interface Account {
  mailboxId: string;
  imap: FakeImapAccount;
  sync(): Promise<void>;
  send(body: Record<string, unknown>): Promise<{ emailId: string; threadId: string }>;
}

describe("self-addressed mail of an IMAP account (Purelymail end-to-end findings)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  async function connectAccount(): Promise<Account> {
    const imap = new FakeImapAccount(FOLDERS);
    const databases = await createChokePoint(runtime).listDatabases();
    const mailboxesDatabaseId = databases.find((row) => row.ownerModuleId === "mailboxes")?.id;
    if (!mailboxesDatabaseId) throw new Error("Missing mailboxes");
    const mailboxId = await withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: "Purelymail", provider: "generic" },
      });
      await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: mailbox.id, address: ACCOUNT });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "app-password" });
      return mailbox.id;
    });
    const limiter = createImapConnectionLimiter();
    const sync = async () => {
      const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      await handleSyncMailAccountTask(
        runtime,
        { mailboxItemId: mailboxId },
        { createImapClient: async () => imap.client() },
        moduleIds,
        noStorage,
        undefined,
        limiter,
      );
    };
    // The server delivers the self-addressed message to INBOX; the saver keeps the Sent copy, as `\Seen`.
    const transport: MailTransport = {
      async send(message) {
        imap.deliver("INBOX", message.raw);
        imap.deliver("Sent", message.raw, [IMAP_SEEN_FLAG]);
        return {};
      },
    };
    const adapters = sendAdapters(transportFor(transport));
    const send = async (body: Record<string, unknown>) => {
      const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })(
        ctx({}, { mailboxId, from: ACCOUNT, to: [{ name: "", address: ACCOUNT }], cc: [], bcc: [], ...body }),
      );
      expect(created.status).toBe(201);
      const sent = await createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adapters } })(
        ctx({ id: created.body.id }, undefined),
      );
      expect(sent.status).toBe(200);
      return { emailId: sent.body.emailId, threadId: sent.body.threadId };
    };
    await sync();
    return { mailboxId, imap, sync, send };
  }

  async function sentToSelf(account: Account, subject = "Self test") {
    const sent = await account.send({ subject, body: "Hello me" });
    await account.sync();
    return sent;
  }

  async function desiredFlagsOf(itemId: string): Promise<Record<string, boolean>> {
    const { rows } = await runtime.query<{ property_key: string; desired_state: boolean }>(
      `SELECT property_key, desired_state FROM mail_message_flag_sync_state
       WHERE tenant_id = app_tenant_default() AND message_item_id = $1`,
      [itemId],
    );
    return Object.fromEntries(rows.map((row) => [row.property_key, row.desired_state]));
  }

  async function folderPathsOf(itemId: string): Promise<string[]> {
    const { rows } = await runtime.query<{ path: string }>(
      `SELECT folder.properties->>'providerId' AS path
       FROM item_relations r
       JOIN items folder ON folder.tenant_id = r.tenant_id AND folder.id IN (r.item_a, r.item_b) AND folder.id <> $1
       WHERE r.tenant_id = app_tenant_default() AND $1 IN (r.item_a, r.item_b) AND folder.deleted_at IS NULL
         AND folder.properties ? 'specialPurpose'
       ORDER BY 1`,
      [itemId],
    );
    return rows.map((row) => row.path);
  }

  const detailOf = (threadId: string) =>
    withTransaction(runtime, (client) => getMailThreadDetail(client, threadId, false), {
      isolation: "repeatable_read",
    });

  const inboxThreads = () =>
    withTransaction(runtime, (client) =>
      listMailThreads(client, 50, null, { box: "inbox", folderId: null, mailboxId: null, unread: false }),
    );

  tenantIt("keeps one Emails item for both copies and shows it unread like its delivered copy", async () => {
    const account = await connectAccount();
    const { emailId, threadId } = await sentToSelf(account);
    // A second pass observes the flags of both known copies again; the `\Seen` Sent copy must not win.
    await account.sync();

    expect(await folderPathsOf(emailId)).toEqual(["INBOX", "Sent"]);
    expect((await inboxThreads()).map((row) => [row.threadId, row.unread])).toEqual([[threadId, true]]);
  });

  describe("read and flag (F13)", () => {
    tenantIt("marks the INBOX copy of a self-addressed message read and writes \\Seen back to INBOX", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);

      const result = await createMailThreadReadRouteHandler(runtime)(ctx({ threadId }, { read: true }));

      expect(result).toEqual({ status: 200, body: { threadId, unread: false } });
      expect(await desiredFlagsOf(emailId)).toMatchObject({ read: true });
      await account.sync();
      expect(account.imap.stores).toContainEqual({ path: "INBOX", uid: 1, flag: IMAP_SEEN_FLAG, value: true });
      expect(account.imap.flagsIn("INBOX").get(1)).toEqual([IMAP_SEEN_FLAG]);
      expect((await inboxThreads()).map((row) => row.unread)).toEqual([false]);
    });

    tenantIt("marks it unread again and answers unread true", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);
      await createMailThreadReadRouteHandler(runtime)(ctx({ threadId }, { read: true }));
      await account.sync();

      const result = await createMailThreadReadRouteHandler(runtime)(ctx({ threadId }, { read: false }));

      expect(result).toEqual({ status: 200, body: { threadId, unread: true } });
      expect(await desiredFlagsOf(emailId)).toMatchObject({ read: false });
      await account.sync();
      expect(account.imap.flagsIn("INBOX").get(1)).toEqual([]);
    });

    tenantIt("refuses read:false and flagged:true on a thread of sent mail only and changes nothing", async () => {
      const account = await connectAccount();
      const sentOnly: MailTransport = {
        async send(message) {
          account.imap.deliver("Sent", message.raw, [IMAP_SEEN_FLAG]);
          return {};
        },
      };
      const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })(
        ctx(
          {},
          {
            mailboxId: account.mailboxId,
            from: ACCOUNT,
            to: [{ name: "", address: "petr@example.test" }],
            cc: [],
            bcc: [],
            subject: "Offer",
            body: "Hello",
          },
        ),
      );
      const sent = await createMailDraftSendRouteHandler(runtime, {
        mailServerClients: { send: sendAdapters(transportFor(sentOnly)) },
      })(ctx({ id: created.body.id }, undefined));
      await account.sync();
      const { threadId, emailId } = sent.body;
      const before = await desiredFlagsOf(emailId);

      await expect(createMailThreadReadRouteHandler(runtime)(ctx({ threadId }, { read: false }))).rejects.toMatchObject(
        {
          status: 409,
          code: "mail_thread_no_received_message",
        },
      );
      await expect(
        createMailThreadFlagRouteHandler(runtime)(ctx({ threadId }, { flagged: true })),
      ).rejects.toMatchObject({ status: 409, code: "mail_thread_no_received_message" });
      expect(await desiredFlagsOf(emailId)).toEqual(before);
      // Nothing to change is no refusal: the thread is read and unflagged already.
      expect(await createMailThreadReadRouteHandler(runtime)(ctx({ threadId }, { read: true }))).toEqual({
        status: 200,
        body: { threadId, unread: false },
      });
      expect(await createMailThreadFlagRouteHandler(runtime)(ctx({ threadId }, { flagged: false }))).toEqual({
        status: 200,
        body: { threadId, flagged: false },
      });
    });

    tenantIt("flags the INBOX copy of a self-addressed message and writes \\Flagged back", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);

      const result = await createMailThreadFlagRouteHandler(runtime)(ctx({ threadId }, { flagged: true }));

      expect(result).toEqual({ status: 200, body: { threadId, flagged: true } });
      expect(await desiredFlagsOf(emailId)).toMatchObject({ flagged: true });
      await account.sync();
      expect(account.imap.flagsIn("INBOX").get(1)).toEqual([IMAP_FLAGGED_FLAG]);
    });
  });

  describe("archive, trash and restore (F13)", () => {
    tenantIt("archives the INBOX copy to Archive on the server and keeps the Sent copy in Sent", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);

      const result = await createMailThreadArchiveRouteHandler(runtime)(ctx({ threadId }, undefined));
      await account.sync();

      expect(result).toEqual({ status: 200, body: { threadId, moved: 1 } });
      expect([account.imap.countIn("INBOX"), account.imap.countIn("Archive"), account.imap.countIn("Sent")]).toEqual([
        0, 1, 1,
      ]);
      expect(await folderPathsOf(emailId)).toEqual(["Archive", "Sent"]);
    });

    tenantIt("restores an archived self-addressed message into INBOX", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);
      await createMailThreadArchiveRouteHandler(runtime)(ctx({ threadId }, undefined));
      await account.sync();

      const result = await createMailThreadRestoreRouteHandler(runtime)(ctx({ threadId }, undefined));
      await account.sync();

      expect(result).toEqual({ status: 200, body: { threadId, moved: 1 } });
      expect([account.imap.countIn("INBOX"), account.imap.countIn("Archive")]).toEqual([1, 0]);
      expect(await folderPathsOf(emailId)).toEqual(["INBOX", "Sent"]);
    });

    tenantIt("trashes the delivered copy and restores it into INBOX, the Sent copy staying in Sent", async () => {
      const account = await connectAccount();
      const { emailId, threadId } = await sentToSelf(account);

      const trashed = await createMailThreadTrashRouteHandler(runtime)(ctx({ threadId }, undefined));
      await account.sync();

      expect(trashed).toEqual({ status: 200, body: { threadId, moved: 1 } });
      expect([account.imap.countIn("INBOX"), account.imap.countIn("Trash"), account.imap.countIn("Sent")]).toEqual([
        0, 1, 1,
      ]);
      expect(await folderPathsOf(emailId)).toEqual(["Sent", "Trash"]);

      const restored = await createMailThreadRestoreRouteHandler(runtime)(ctx({ threadId }, undefined));
      await account.sync();

      expect(restored).toEqual({ status: 200, body: { threadId, moved: 1 } });
      expect([account.imap.countIn("INBOX"), account.imap.countIn("Trash")]).toEqual([1, 0]);
      expect(await folderPathsOf(emailId)).toEqual(["INBOX", "Sent"]);
    });
  });

  describe("restore to where it came from (F18)", () => {
    // Mail to oneself sent by another client that keeps no Sent copy: one provider message, in INBOX only.
    async function deliveredOnly(account: Account): Promise<{ emailId: string; threadId: string }> {
      account.imap.deliver(
        "INBOX",
        Buffer.from(
          `From: ${ACCOUNT}\r\nTo: ${ACCOUNT}\r\nSubject: From my phone\r\nMessage-ID: <phone@example.test>\r\n` +
            "Date: Sat, 21 Nov 2026 10:00:00 +0000\r\n\r\nHello me\r\n",
        ),
      );
      await account.sync();
      const [row] = await inboxThreads();
      if (!row) throw new Error("The delivered message is not listed");
      const detail = await detailOf(row.threadId);
      const [message] = detail.messages;
      if (!message) throw new Error("The thread has no message");
      return { emailId: message.emailId, threadId: row.threadId };
    }

    it.each(["trash", "archive"] as const)(
      "restores mail to oneself moved to %s from INBOX back to INBOX on the server",
      (kind) =>
        runInTenant(tenant, async () => {
          const account = await connectAccount();
          const { emailId, threadId } = await deliveredOnly(account);
          const move = kind === "trash" ? createMailThreadTrashRouteHandler : createMailThreadArchiveRouteHandler;
          await move(runtime)(ctx({ threadId }, undefined));
          await account.sync();
          expect(account.imap.countIn(kind === "trash" ? "Trash" : "Archive")).toBe(1);

          const restored = await createMailThreadRestoreRouteHandler(runtime)(ctx({ threadId }, undefined));
          await account.sync();

          expect(restored).toEqual({ status: 200, body: { threadId, moved: 1 } });
          expect(FOLDERS.map(({ path }) => account.imap.countIn(path))).toEqual([1, 0, 0, 0, 0]);
          expect(await folderPathsOf(emailId)).toEqual(["INBOX"]);
        }),
    );
  });

  describe("reply threading (F16)", () => {
    tenantIt("threads a reply to a self-addressed message into its thread, one message per Message-ID", async () => {
      const account = await connectAccount();
      const original = await sentToSelf(account, "Thread test");

      const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })(
        ctx({}, { mailboxId: account.mailboxId, mode: "reply", sourceEmailId: original.emailId, body: "Reply body" }),
      );
      expect(created.status).toBe(201);
      const reply = await createMailDraftSendRouteHandler(runtime, {
        mailServerClients: {
          send: sendAdapters(
            transportFor({
              async send(message) {
                account.imap.deliver("INBOX", message.raw);
                account.imap.deliver("Sent", message.raw, [IMAP_SEEN_FLAG]);
                return {};
              },
            }),
          ),
        },
      })(ctx({ id: created.body.id }, undefined));
      await account.sync();

      expect(reply.body.threadId).toBe(original.threadId);
      const detail = await detailOf(original.threadId);
      expect(detail.messages.map((message) => message.emailId)).toEqual([original.emailId, reply.body.emailId]);
      expect(await folderPathsOf(reply.body.emailId)).toEqual(["INBOX", "Sent"]);
      const inbox = await withTransaction(runtime, (client) =>
        listMailThreads(client, 50, null, { box: "inbox", folderId: null, mailboxId: null, unread: false }),
      );
      expect(inbox.map((row) => [row.threadId, row.messageCount])).toEqual([[original.threadId, 2]]);
    });
  });
});
