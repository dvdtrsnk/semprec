import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getCredentialType, storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import type { ImapFolderRef, ImapMailClient } from "../mail/imapReconcile.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  recordGmailSyncCursor,
  recordGraphSyncCursor,
  listAccountsDueForSync,
  renewMailSyncPass,
} from "../mail/mailAccountSyncStateStore.js";
import { createMailDraftCreateRouteHandler, createMailDraftSendRouteHandler } from "../mail/mailDraftRouteHandlers.js";
import { prepareSend } from "../mail/mailDraftSendInput.js";
import { getMailFolderSyncState } from "../mail/mailFolderSyncStateStore.js";
import {
  createMailLiveSyncRoot,
  type MailAccountLifecycle,
  type MailLiveSyncLifecycleFactory,
} from "../mail/mailLiveSyncRoot.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mail/mailModuleIds.js";
import { getMailServerSettings, upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { mailAccountSyncJobKey } from "../mail/mailSyncEnqueue.js";
import { handleMailAccountSyncSweepTask, handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { handleMailboxRemovalTask, mailboxMailOffJobKey, mailboxRemovalJobKey } from "../mail/mailboxRemovalJob.js";
import { createMailboxDetailRouteHandler, createMailboxListRouteHandler } from "../mail/mailboxRouteHandlers.js";
import { bindMailboxServiceLiveSyncStop } from "../mail/mailboxServiceHooks.js";
import { lockMailThreadMutation } from "../mail/mailThreadMutationGuard.js";
import { sendDraftEmail } from "../mail/send.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { recordingTransport, sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { backfillOfFetchedSince, fakeFetchedMessage, fakeImapRange } from "../testSupport/fakeImapMessages.js";

const OWN_ADDRESS = "me@example.test";
const USER_ID = randomUUID();
const USER_WRITER = { writerKind: "user" } as const;

/** The provider's mailbox: an inbox with two messages, a Sent and a Drafts folder. */
const PROVIDER_FOLDERS: Array<ImapFolderRef & { count: number }> = [
  { path: "INBOX", specialUse: "\\Inbox", count: 2 },
  { path: "Sent", specialUse: "\\Sent", count: 0 },
  { path: "Drafts", specialUse: "\\Drafts", count: 0 },
];

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const UNUSED_STORAGE = "the provider's messages carry no attachments, so no blob is written";
const unusedStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(UNUSED_STORAGE)),
  delete: () => Promise.reject(new Error(UNUSED_STORAGE)),
  readStream: () => {
    throw new Error(UNUSED_STORAGE);
  },
};

/** An IMAP account whose folders hold `count` messages with UIDs 1..n. */
function providerAccount(): ImapMailClient {
  const countOf = (path: string) => PROVIDER_FOLDERS.find((folder) => folder.path === path)?.count ?? 0;
  const account: ImapMailClient = {
    appendMessage: async () => {},
    getCapabilities: async () => new Set(),
    listFolders: async () => PROVIDER_FOLDERS.map(({ path, specialUse }) => ({ path, specialUse })),
    selectFolder: async (path) => ({ uidvalidity: 7, uidnext: countOf(path) + 1, highestModSeq: null, messages: 0 }),
    fetchMessagesSince: async (path, sinceUid, limit) =>
      fakeImapRange(
        Array.from({ length: countOf(path) }, (_, index) => index + 1)
          .filter((uid) => uid >= sinceUid)
          .map((uid) =>
            fakeFetchedMessage(uid, {
              messageId: `<${path}-${uid}@example.test>`,
              subject: `${path} ${uid}`,
              envelope: { from: { address: "bob@example.test" }, to: [{ address: OWN_ADDRESS }] },
              attachments: [],
            }),
          ),
        limit,
      ),
    fetchMessagesBefore: async (path, beforeUid, limit) => backfillOfFetchedSince(account)(path, beforeUid, limit),
    fetchSnippets: async () => new Map(),
    fetchChangesSince: async () => ({ flags: [], vanished: [] }),
    fetchAllUids: async (path) => Array.from({ length: countOf(path) }, (_, index) => index + 1),
    fetchFlagsChangedSince: async () => [],
    setMessageFlag: async () => {},
    close: async () => {},
  };
  return account;
}

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function moduleIds(tenantId = tenant): Promise<MailModuleIds> {
  return inTenant((client) => resolveMailModuleIds(client), tenantId);
}

/** Runs one sync pass; `opened` counts the IMAP connections the pass asked for. */
async function runSync(mailboxItemId: string, tenantId = tenant): Promise<{ opened: number }> {
  const ids = await moduleIds(tenantId);
  const account = providerAccount();
  let opened = 0;
  await runInTenant(tenantId, () =>
    handleSyncMailAccountTask(
      runtime,
      { mailboxItemId },
      {
        createImapClient: async () => {
          opened += 1;
          return account;
        },
      },
      ids,
      unusedStorage,
    ),
  );
  return { opened };
}

/** A connected password account, synced once through the production pass. */
async function connectAccount(tenantId = tenant): Promise<string> {
  const ids = await moduleIds(tenantId);
  const mailboxId = await inTenant(async (client) => {
    const mailbox = await createChokePoint(runtime).createItem({
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "generic" },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: ids.mailboxesDatabaseId,
      mailboxItemId: mailbox.id,
      address: OWN_ADDRESS,
    });
    await storeCredential(client, { itemId: mailbox.id, credentialType: "plain_password", plaintext: "s3cret" });
    await upsertMailServerSettings(client, mailbox.id, {
      imap: { host: "imap.example.test", port: 993, security: "tls" },
      smtp: { host: "smtp.example.test", port: 465, security: "tls" },
      username: OWN_ADDRESS,
    });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
    return mailbox.id;
  }, tenantId);
  await runSync(mailboxId, tenantId);
  return mailboxId;
}

function switchMail(mailboxId: string, mailEnabled: boolean, tenantId = tenant) {
  return runInTenant(tenantId, async () => {
    const { mailboxesDatabaseId } = await moduleIds(tenantId);
    return createChokePoint(runtime).updateItem(
      { databaseId: mailboxesDatabaseId, itemId: mailboxId, propertiesPatch: { mailEnabled } },
      USER_ID,
      USER_ID,
      USER_WRITER,
    );
  });
}

function runMailOffJob(mailboxItemId: string, tenantId = tenant): Promise<void> {
  return runInTenant(tenantId, () => handleMailboxRemovalTask(runtime, { mailboxItemId, purpose: "mailOff" }));
}

/** The keys of the queued mail jobs (sync, removal, mail-off). */
async function jobKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE key LIKE 'mail%' ORDER BY key",
  );
  return rows.map((row) => row.key);
}

/** Removes every queued job, so only an enqueue made after this call is observed. */
async function clearJobs(): Promise<void> {
  await admin.query("DELETE FROM graphile_worker._private_jobs");
}

interface MailRows {
  liveEmails: Array<{ id: string; messageId: string | null }>;
  liveFolders: string[];
  threadRows: number;
  liveThreadItems: number;
}

/** The tenant's mail (one account per test) as the database holds it: live Emails with their meta, live Folders, threads. */
async function tenantMail(tenantId = tenant): Promise<MailRows> {
  const ids = await moduleIds(tenantId);
  return inTenant(async (client) => {
    const emails = await client.query<{ id: string; message_id: string | null }>(
      `SELECT i.id, m.message_id FROM items i
         LEFT JOIN mail_message_meta m ON m.item_id = i.id
        WHERE i.database_id = $1 AND i.deleted_at IS NULL ORDER BY m.message_id`,
      [ids.emailsDatabaseId],
    );
    const folders = await client.query<{ name: string }>(
      `SELECT properties ->> 'name' AS name FROM items
        WHERE database_id = $1 AND deleted_at IS NULL ORDER BY 1`,
      [ids.foldersDatabaseId],
    );
    const threads = await client.query<{ rows: number }>(`SELECT count(*)::int AS rows FROM mail_threads`);
    const liveThreadItems = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.owner_module_id = 'threads' AND i.deleted_at IS NULL`,
    );
    return {
      liveEmails: emails.rows.map((row) => ({ id: row.id, messageId: row.message_id })),
      liveFolders: folders.rows.map((row) => row.name),
      threadRows: threads.rows[0]?.rows ?? -1,
      liveThreadItems: liveThreadItems.rows[0]?.n ?? -1,
    };
  }, tenantId);
}

async function inboxFolderId(): Promise<string> {
  const ids = await moduleIds();
  const id = await inTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'providerId' = 'INBOX'`,
      [ids.foldersDatabaseId],
    );
    return rows[0]?.id ?? null;
  });
  if (id === null) throw new Error("the account has no live inbox");
  return id;
}

function newDraft(mailboxId: string, subject: string): Promise<string> {
  return runInTenant(tenant, async () => {
    const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })({
      params: {},
      body: {
        mailboxId,
        from: OWN_ADDRESS,
        to: [{ name: "Bob", address: "bob@example.test" }],
        cc: [],
        bcc: [],
        subject,
        body: "Hi",
      },
      identity: { user: { id: USER_ID, locale: "en" } },
    });
    expect(created.status).toBe(201);
    return created.body.id;
  });
}

describe("internet account service switches", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterEach(() => {
    bindMailboxServiceLiveSyncStop(undefined);
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it.each([
    {
      name: "an existing mailbox without switches",
      patch: null,
      expected: { mailEnabled: true, calendarsEnabled: false },
    },
    {
      name: "Mail switched off",
      patch: { mailEnabled: false },
      expected: { mailEnabled: false, calendarsEnabled: false },
    },
    {
      name: "Calendars switched on",
      patch: { calendarsEnabled: true },
      expected: { mailEnabled: true, calendarsEnabled: true },
    },
  ])("the mailbox rows report the switches of $name", async ({ patch, expected }) => {
    const mailboxId = await connectAccount();
    if (patch !== null) {
      await runInTenant(tenant, async () => {
        const { mailboxesDatabaseId } = await moduleIds();
        await createChokePoint(runtime).updateItem(
          { databaseId: mailboxesDatabaseId, itemId: mailboxId, propertiesPatch: patch },
          USER_ID,
          USER_ID,
          USER_WRITER,
        );
      });
    }
    const list = await runInTenant(tenant, () => createMailboxListRouteHandler(runtime)());
    const detail = await runInTenant(tenant, () =>
      createMailboxDetailRouteHandler(runtime)({ params: { id: mailboxId } }),
    );
    expect(
      list.body.mailboxes.map((row) => ({
        id: row.id,
        mailEnabled: row.mailEnabled,
        calendarsEnabled: row.calendarsEnabled,
      })),
    ).toEqual([{ id: mailboxId, ...expected }]);
    expect(detail.body).toMatchObject(expected);
  });

  it("switching Mail off pauses the account in the same transaction, queues the removal of its mail and stops its live sync after the commit", async () => {
    const mailboxId = await connectAccount();
    const inbox = await inboxFolderId();
    expect(await inTenant((client) => getMailFolderSyncState(client, inbox))).not.toBeNull();
    expect((await inTenant((client) => getMailAccountSyncState(client, mailboxId)))?.connectedAt).not.toBeNull();
    // Cursors of an unfinished Gmail listing and Graph delta round, as a pass of either mode leaves them.
    await inTenant(async (client) => {
      await recordGmailSyncCursor(client, mailboxId, {
        historyId: "7",
        listingPhase: "index",
        listingPageToken: "page-9",
      });
      await recordGraphSyncCursor(client, mailboxId, {
        deltaLink: "https://graph.test/delta",
        nextLink: "https://graph.test/next",
      });
    });
    await clearJobs();
    const stops: Array<{ tenantId: string; mailboxItemId: string; committed: boolean }> = [];
    bindMailboxServiceLiveSyncStop(async (tenantId, mailboxItemId) => {
      // Read on another connection: only a committed pause is visible there.
      const { rows } = await admin.query<{ paused: boolean }>(
        "SELECT sync_paused_at IS NOT NULL AS paused FROM mail_account_sync_state WHERE item_id = $1",
        [mailboxItemId],
      );
      stops.push({ tenantId, mailboxItemId, committed: rows[0]?.paused === true });
    });

    await switchMail(mailboxId, false);
    // The stop runs un-awaited after the commit; its read settles within a few turns.
    for (let attempt = 0; attempt < 100 && stops.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const state = await inTenant((client) => getMailAccountSyncState(client, mailboxId));
    expect(state).toMatchObject({
      syncMode: "imap",
      initialSyncCompletedAt: null,
      nextExpectedActivityAt: null,
      connectedAt: null,
      gmailHistoryId: null,
      gmailListingPhase: null,
      gmailListingPageToken: null,
      graphDeltaLink: null,
      graphDeltaNextLink: null,
    });
    expect(state?.syncPausedAt).not.toBeNull();
    expect(await inTenant((client) => getMailFolderSyncState(client, inbox))).toBeNull();
    expect(await jobKeys()).toEqual([mailboxMailOffJobKey(mailboxId)]);
    expect(stops).toEqual([{ tenantId: tenant, mailboxItemId: mailboxId, committed: true }]);

    // Repeating the switch changes nothing and queues nothing.
    await clearJobs();
    await switchMail(mailboxId, false);
    expect((await inTenant((client) => getMailAccountSyncState(client, mailboxId)))?.syncPausedAt).toBe(
      state?.syncPausedAt,
    );
    expect(await jobKeys()).toEqual([]);
    expect(stops).toHaveLength(1);
  });

  it("with Mail off no sync pass, sweep enqueue or hosted live sync runs, its mail is removed, and its credential, server settings and item remain", async () => {
    const mailboxId = await connectAccount();
    const before = await tenantMail();
    expect(before.liveEmails.map((row) => row.messageId)).toEqual(["<INBOX-1@example.test>", "<INBOX-2@example.test>"]);
    expect(before.liveFolders).toEqual(["Drafts", "INBOX", "Sent"]);
    expect(before).toMatchObject({ threadRows: 2, liveThreadItems: 2 });

    const lifecycles: Array<{ mailboxItemId: string; starts: number; stops: number }> = [];
    const factory: MailLiveSyncLifecycleFactory = (account) => {
      const entry = { mailboxItemId: account.mailboxItemId, starts: 0, stops: 0 };
      lifecycles.push(entry);
      const lifecycle: MailAccountLifecycle = {
        async start() {
          entry.starts += 1;
        },
        async stop() {
          entry.stops += 1;
        },
      };
      return lifecycle;
    };
    const root = createMailLiveSyncRoot(runtime, factory);
    try {
      await root.reconcileOnce();
      expect(lifecycles).toEqual([{ mailboxItemId: mailboxId, starts: 1, stops: 0 }]);

      await switchMail(mailboxId, false);
      // No stop is bound here: the next discovery pass unhosts the paused account and does not host it again.
      await root.reconcileOnce();
      await root.reconcileOnce();
      expect(lifecycles).toEqual([{ mailboxItemId: mailboxId, starts: 1, stops: 1 }]);
    } finally {
      await root.stop();
    }

    expect(await runSync(mailboxId)).toEqual({ opened: 0 });
    await clearJobs();
    await handleMailAccountSyncSweepTask(runtime);
    expect(await jobKeys()).toEqual([]);
    expect(await inTenant((client) => listAccountsDueForSync(client))).toEqual([]);

    await runMailOffJob(mailboxId);
    expect(await tenantMail()).toEqual({ liveEmails: [], liveFolders: [], threadRows: 0, liveThreadItems: 0 });
    const ids = await moduleIds();
    await inTenant(async (client) => {
      const item = await getItemById(client, ids.mailboxesDatabaseId, mailboxId);
      expect(item?.deletedAt).toBeNull();
      expect(item?.properties).toMatchObject({ name: "Personal", mailEnabled: false });
      expect(await getCredentialType(client, mailboxId)).toBe("plain_password");
      expect(await getMailServerSettings(client, mailboxId)).toMatchObject({ username: OWN_ADDRESS });
      expect(await getMailAccountSyncState(client, mailboxId)).toMatchObject({ syncMode: "imap" });
    });
  });

  it("a Mail-off chunk takes the sync state row before the mail-thread guard, the order of a pass's transaction, so the two never deadlock", async () => {
    const mailboxId = await connectAccount();
    await switchMail(mailboxId, false);
    // How many backends wait for a lock other than the advisory guards: the chunk waiting for the sync state row.
    const rowLockWaiters = async () =>
      (
        await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event <> 'advisory'`,
        )
      ).rows[0]?.n ?? 0;

    // A transaction locking as a pass's does: the lease renewal on the sync state row, then the mail-thread guard.
    let job: Promise<unknown> = Promise.resolve();
    await inTenant(async (client) => {
      expect(await renewMailSyncPass(client, mailboxId, randomUUID(), 60_000)).toBe(true);
      job = runMailOffJob(mailboxId).then(
        () => "done",
        (error: unknown) => error,
      );
      await vi.waitFor(async () => expect(await rowLockWaiters()).toBe(1), { timeout: 10_000, interval: 10 });
      await lockMailThreadMutation(client);
    });

    expect(await job).toBe("done");
    expect(await tenantMail()).toEqual({ liveEmails: [], liveFolders: [], threadRows: 0, liveThreadItems: 0 });
  });

  it("switching Mail on queues a sync in the same transaction, and the mail downloads again as for a new account", async () => {
    const mailboxId = await connectAccount();
    const original = (await tenantMail()).liveEmails.map((row) => row.id);
    await switchMail(mailboxId, false);
    await runMailOffJob(mailboxId);
    await clearJobs();

    await switchMail(mailboxId, true);
    expect(await jobKeys()).toEqual([mailAccountSyncJobKey(mailboxId)]);
    expect((await inTenant((client) => getMailAccountSyncState(client, mailboxId)))?.syncPausedAt).toBeNull();

    expect(await runSync(mailboxId)).toEqual({ opened: 1 });
    const after = await tenantMail();
    expect(after.liveEmails.map((row) => row.messageId)).toEqual(["<INBOX-1@example.test>", "<INBOX-2@example.test>"]);
    expect(after.liveEmails.some((row) => original.includes(row.id))).toBe(false);
    expect(after.liveFolders).toEqual(["Drafts", "INBOX", "Sent"]);
    expect(after).toMatchObject({ threadRows: 2, liveThreadItems: 2 });
    expect(
      (await inTenant((client) => getMailAccountSyncState(client, mailboxId)))?.initialSyncCompletedAt,
    ).not.toBeNull();
  });

  it("with Mail off sending a draft answers mail_disabled and sends nothing; with Mail on it sends", async () => {
    const mailboxId = await connectAccount();
    const transport = recordingTransport();
    const adapters = sendAdapters(transportFor(transport));
    const send = (draftId: string) =>
      runInTenant(tenant, () =>
        createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adapters } })({
          params: { id: draftId },
          body: undefined,
          identity: { user: { id: USER_ID } },
        }),
      );

    const sentWhileOn = await newDraft(mailboxId, "While on");
    expect((await send(sentWhileOn)).status).toBe(200);
    expect(transport.sent).toHaveLength(1);

    const refused = await newDraft(mailboxId, "While off");
    await switchMail(mailboxId, false);
    await expect(send(refused)).rejects.toMatchObject({ status: 409, code: "mail_disabled" });
    expect(transport.sent).toHaveLength(1);
    const claimed = await inTenant(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM mail_message_meta WHERE item_id = $1",
        [refused],
      );
      return rows[0]?.n;
    });
    expect(claimed).toBe(0);
  });

  it("a send whose claim read Mail on holds the switch until the claim commits", async () => {
    const mailboxId = await connectAccount();
    const draftId = await newDraft(mailboxId, "Racing the switch");
    const transport = recordingTransport();
    const order: string[] = [];
    let switching: Promise<unknown> | undefined;
    await runInTenant(tenant, async () => {
      const prepared = await withTransaction(runtime, (client) => prepareSend(client, draftId));
      await sendDraftEmail(runtime, prepared.input, prepared.moduleIds, sendAdapters(transportFor(transport)), {
        beforeClaim: async () => {
          switching = switchMail(mailboxId, false).then(() => order.push("switched"));
          // The switch waits for the claim's share lock on the sync state row.
          for (let attempt = 0; ; attempt += 1) {
            const { rows } = await admin.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND query LIKE '%FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE%'`,
            );
            if ((rows[0]?.n ?? 0) > 0) break;
            if (attempt > 500) throw new Error("the switch never waited for the claim");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          order.push("claiming");
        },
      });
    });
    await switching;
    expect(order).toEqual(["claiming", "switched"]);
    expect(transport.sent).toHaveLength(1);
  });

  it("removing an account with Mail off still removes everything, its switches with the item", async () => {
    const mailboxId = await connectAccount();
    await switchMail(mailboxId, false);
    await clearJobs();
    const ids = await moduleIds();
    expect(
      await runInTenant(tenant, () =>
        removeMailbox(runtime, mailboxId, { queueAffinity: createActionQueueAffinity() }),
      ),
    ).toBe(true);
    expect(await jobKeys()).toEqual([mailboxRemovalJobKey(mailboxId)]);
    await runInTenant(tenant, () => handleMailboxRemovalTask(runtime, { mailboxItemId: mailboxId }));
    await inTenant(async (client) => {
      const item = await getItemById(client, ids.mailboxesDatabaseId, mailboxId);
      expect(item?.deletedAt).not.toBeNull();
      expect(item?.properties).toMatchObject({ mailEnabled: false });
      expect(await getCredentialType(client, mailboxId)).toBeNull();
      expect(await getMailServerSettings(client, mailboxId)).toBeNull();
      expect(await getMailAccountSyncState(client, mailboxId)).toBeNull();
    });
    expect((await tenantMail()).liveEmails).toEqual([]);
    // A mail-off job still queued from before finds no paused account and changes nothing.
    await runMailOffJob(mailboxId);
  });

  it("another tenant cannot switch the account: its write answers not found and pauses nothing", async () => {
    const mailboxId = await connectAccount();
    await clearJobs();
    await expect(switchMail(mailboxId, false, foreign)).rejects.toBeInstanceOf(NotFoundError);
    expect((await inTenant((client) => getMailAccountSyncState(client, mailboxId)))?.syncPausedAt).toBeNull();
    expect(await jobKeys()).toEqual([]);
  });
});
