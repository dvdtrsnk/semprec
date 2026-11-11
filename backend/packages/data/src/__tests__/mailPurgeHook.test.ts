import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { deleteMailAttachmentsOfMessage, ingestAttachments, type ClassifiedAttachment } from "../mail/attachments.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  deleteMailFolderSyncStatesOfFoldersWithoutMailbox,
  ensureMailFolderSyncState,
} from "../mail/mailFolderSyncStateStore.js";
import { deleteMailMessageFlagSyncStates, recordObservedMailMessageFlags } from "../mail/mailMessageFlagSyncStore.js";
import { reassignThread, upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { lockMailThreadMutation } from "../mail/mailThreadMutationGuard.js";
import { EMAILS_MODULE_ID, THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { handleItemTrashPurgeSweepTask } from "../trash/purgeExpiredTrash.js";

// The mail module's item purge hook as `domainWriteHooks.ts` registers it, driven through the permanent
// purge: docs/adr/2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks.md.

/** The seeded ids every fixture shares, read per tenant. */
interface MailIds {
  mailboxes: string;
  folders: string;
  emails: string;
  files: string;
  threads: string;
  emailFolderProperty: string;
  emailAttachmentsProperty: string;
  folderMailboxProperty: string;
}

/** A Mailboxes item with two Folders the production folder discovery related to it. */
interface TestMailbox {
  id: string;
  inbox: string;
  archive: string;
}

/** The mail rows that name one Emails item, as stored. */
interface EmailRows {
  /** The thread of each `mail_message_meta` row of the item; at most one row exists. */
  meta: Array<string | null>;
  attachments: string[];
  flags: string[];
}

/** The rows a mailbox removal deletes, for one mailbox, as stored. */
interface MailboxRows {
  credential: number;
  accountState: number;
  folderStates: string[];
  serverSettings: number;
}

const NO_EMAIL_ROWS: EmailRows = { meta: [], attachments: [], flags: [] };
const NO_MAILBOX_ROWS: MailboxRows = { credential: 0, accountState: 0, folderStates: [], serverSettings: 0 };

/** Every table the hook deletes from, and the aliases that go with a deleted thread; a closed list, see `mailRowVersions`. */
const MAIL_TABLES = [
  "mail_message_meta",
  "mail_attachments",
  "mail_message_flag_sync_state",
  "mail_threads",
  "mail_thread_aliases",
  "external_credentials",
  "mail_account_sync_state",
  "mail_folder_sync_state",
  "mail_account_server_settings",
] as const;

/** A cutoff every trashed row is older than, so a test needs no backdating to make its trash eligible. */
const EVERYTHING_EXPIRED = new Date("2999-01-01T00:00:00Z");

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

const storage: BlobStorageWriter = {
  async writeStream(_storageKey: string, source: Readable) {
    let byteSize = 0;
    for await (const chunk of source) byteSize += Buffer.byteLength(chunk);
    return { byteSize, contentHash: randomUUID() };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function loadIds(client: PoolClient): Promise<MailIds> {
  const mail = await resolveMailModuleIds(client);
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads) throw new Error("the Threads database is not seeded");
  const propertyId = async (databaseId: string, key: string): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [databaseId, key],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`property '${key}' is not seeded`);
    return id;
  };
  return {
    mailboxes: mail.mailboxesDatabaseId,
    folders: mail.foldersDatabaseId,
    emails: mail.emailsDatabaseId,
    files: mail.filesDatabaseId,
    threads: threads.id,
    emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
    emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
    folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
  };
}

function idsOf(tenantId = tenant): Promise<MailIds> {
  return inTenant(loadIds, tenantId);
}

/** A mailbox that never connected: the item and its two folders, and none of the rows a removal deletes. */
async function createMailbox(client: PoolClient, ids: MailIds, name: string): Promise<TestMailbox> {
  const mailbox = await createItemWithClient(client, {
    databaseId: ids.mailboxes,
    properties: { name, provider: "generic" },
  });
  const folder = (purpose: "inbox" | "archive"): Promise<string> =>
    ensureFolderItem(client, {
      foldersDatabaseId: ids.folders,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId: ids.folderMailboxProperty,
      providerId: purpose,
      name: purpose,
      behavior: "folder",
      specialPurpose: purpose,
    });
  return { id: mailbox.id, inbox: await folder("inbox"), archive: await folder("archive") };
}

/** A connected mailbox: a credential, an account sync state, a sync state for both folders and server settings. */
async function createConnectedMailbox(client: PoolClient, ids: MailIds, name: string): Promise<TestMailbox> {
  const mailbox = await createMailbox(client, ids, name);
  await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: `secret of ${name}` });
  await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
  await ensureMailFolderSyncState(client, mailbox.inbox);
  await ensureMailFolderSyncState(client, mailbox.archive);
  await upsertMailServerSettings(client, mailbox.id, {
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    username: "user@example.com",
  });
  return mailbox;
}

function attachment(filename: string): ClassifiedAttachment {
  return {
    filename,
    contentType: "application/octet-stream",
    contentId: null,
    disposition: "attachment",
    openStream: () => Readable.from([filename]),
  };
}

/**
 * One message through the production ingest writer, with the read and flagged state the provider
 * reported for it, as a sync pass records it. A message whose `references` name an earlier one joins
 * that message's thread.
 */
async function ingest(
  client: PoolClient,
  ids: MailIds,
  input: { mailbox: TestMailbox; messageId: string; references?: string[]; attachments?: string[] },
): Promise<string> {
  const references = input.references ?? [];
  const { itemId } = await ingestEmailMessage(client, {
    emailsDatabaseId: ids.emails,
    filesDatabaseId: ids.files,
    folderRelationPropertyId: ids.emailFolderProperty,
    attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
    folderItemId: input.mailbox.inbox,
    mailboxItemId: input.mailbox.id,
    messageId: input.messageId,
    inReplyTo: references.at(-1) ?? null,
    references,
    subject: input.messageId,
    envelope: { from: { address: "bob@example.com" }, to: [{ address: "me@example.com" }] },
    attachments: (input.attachments ?? []).map(attachment),
    storage,
    storageKeyPrefix: "mail-purge-hook",
  });
  await recordObservedMailMessageFlags(client, itemId, { read: true, flagged: false });
  return itemId;
}

/** The mail rows that name `itemId`, in any tenant. */
async function emailRows(itemId: string): Promise<EmailRows> {
  const meta = await admin.query<{ thread_id: string | null }>(
    "SELECT thread_id::text AS thread_id FROM mail_message_meta WHERE item_id = $1",
    [itemId],
  );
  const attachments = await admin.query<{ filename: string }>(
    "SELECT filename FROM mail_attachments WHERE message_item_id = $1 ORDER BY filename",
    [itemId],
  );
  const flags = await admin.query<{ property_key: string }>(
    "SELECT property_key FROM mail_message_flag_sync_state WHERE message_item_id = $1 ORDER BY property_key",
    [itemId],
  );
  return {
    meta: meta.rows.map((row) => row.thread_id),
    attachments: attachments.rows.map((row) => row.filename),
    flags: flags.rows.map((row) => row.property_key),
  };
}

/** The thread of the message `itemId` and the Threads item its `mail_threads` row is bound to. */
async function threadOf(itemId: string): Promise<{ id: string; itemId: string }> {
  const { rows } = await admin.query<{ id: string; item_id: string | null }>(
    `SELECT t.id::text AS id, t.item_id::text AS item_id
       FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1`,
    [itemId],
  );
  const row = rows[0];
  if (!row?.item_id) throw new Error(`message ${itemId} has no thread bound to a Threads item`);
  return { id: row.id, itemId: row.item_id };
}

/** The ids of the `mail_threads` rows among `threadIds` that still exist, in any tenant. */
async function existingThreads(threadIds: string[]): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id::text AS id FROM mail_threads WHERE id = ANY($1::uuid[]) ORDER BY id",
    [threadIds],
  );
  return rows.map((row) => row.id);
}

/** Whether item `itemId` exists and is in the trash, with its `updated_at` and `deleted_at` at full precision; empty when it is gone. */
async function itemState(
  itemId: string,
): Promise<Array<{ trashed: boolean; updatedAt: string; deletedAt: string | null }>> {
  const { rows } = await admin.query<{ trashed: boolean; updatedAt: string; deletedAt: string | null }>(
    `SELECT deleted_at IS NOT NULL AS trashed, updated_at::text AS "updatedAt", deleted_at::text AS "deletedAt"
       FROM items WHERE id = $1`,
    [itemId],
  );
  return rows;
}

/** The rows a removal deletes for `mailbox`, read in `tenantId`'s scope, so a row of another tenant is absent. */
function mailboxRows(mailbox: TestMailbox, tenantId = tenant): Promise<MailboxRows> {
  return inTenant(async (client) => {
    const count = async (sql: string): Promise<number> => {
      const { rows } = await client.query<{ n: number }>(sql, [mailbox.id]);
      const n = rows[0]?.n;
      if (n === undefined) throw new Error("a count returned no row");
      return n;
    };
    const folderStates = await client.query<{ item_id: string }>(
      "SELECT item_id::text AS item_id FROM mail_folder_sync_state WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
      [[mailbox.inbox, mailbox.archive]],
    );
    return {
      credential: await count("SELECT count(*)::int AS n FROM external_credentials WHERE item_id = $1"),
      accountState: await count("SELECT count(*)::int AS n FROM mail_account_sync_state WHERE item_id = $1"),
      folderStates: folderStates.rows.map((row) => row.item_id),
      serverSettings: await count(
        "SELECT count(*)::int AS n FROM mail_account_server_settings WHERE mailbox_item_id = $1",
      ),
    };
  }, tenantId);
}

/** The rows of a connected mailbox none of which was deleted. */
const connectedRows = (mailbox: TestMailbox): MailboxRows => ({
  credential: 1,
  accountState: 1,
  folderStates: [mailbox.inbox, mailbox.archive].sort(),
  serverSettings: 1,
});

/**
 * The row versions of every mail table, of one tenant or of all: a row that was inserted, updated or
 * deleted changes its table's list, so equal lists mean that no row of the table was written.
 */
async function mailRowVersions(tenantId?: string): Promise<Record<string, string[]>> {
  const versions: Record<string, string[]> = {};
  for (const table of MAIL_TABLES) {
    // `table` is one of the literals of MAIL_TABLES, so it cannot break out of the statement; a table
    // name accepts no bind parameter.
    const { rows } = await admin.query<{ version: string }>(
      `SELECT tenant_id::text || ' ' || ctid::text || ' ' || xmin::text AS version
         FROM ${table} WHERE $1::uuid IS NULL OR tenant_id = $1::uuid ORDER BY 1`,
      [tenantId ?? null],
    );
    versions[table] = rows.map((row) => row.version);
  }
  return versions;
}

/** The generic soft delete of a live item, in `tenantId`'s scope. */
function trash(databaseId: string, itemId: string, tenantId = tenant): Promise<void> {
  return runInTenant(tenantId, async () => {
    expect(await chokePoint.softDeleteItem(databaseId, itemId)).not.toBeNull();
  });
}

/** The permanent purge of the trashed item `itemId` in `tenantId`'s scope; resolves the ids it removed. */
function purge(itemId: string, tenantId = tenant): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const purged = await chokePoint.purgeExpiredTrashSubtree(itemId, EVERYTHING_EXPIRED);
    return purged.purgedItemIds;
  });
}

/**
 * Makes every row delete from `table` fail until the returned function runs. A trigger is the only way
 * to fail one statement of the hook inside the purge's transaction; no production code exposes that seam.
 */
async function failDeletesFrom(table: (typeof MAIL_TABLES)[number]): Promise<() => Promise<void>> {
  await admin.query(`CREATE FUNCTION test_mail_purge_hook_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test mail purge hook failure'; END $$`);
  // `table` is one of the literals of MAIL_TABLES, so it cannot break out of the statement;
  // CREATE TRIGGER and DROP TRIGGER accept no bind parameters.
  await admin.query(
    `CREATE TRIGGER test_mail_purge_hook_fail BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_mail_purge_hook_fail()`,
  );
  return async () => {
    await admin.query(`DROP TRIGGER test_mail_purge_hook_fail ON ${table}`);
    await admin.query("DROP FUNCTION test_mail_purge_hook_fail()");
  };
}

/** A promise with its resolver, for the explicit signals of the concurrent tests. */
function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Waits for `reached`, and fails as soon as `work` ends first: its work was meant to stop at that point. */
function reachedBeforeEnd<T>(reached: Promise<T>, work: Promise<unknown>, what: string): Promise<T> {
  return Promise.race([
    reached,
    work.then(() => {
      throw new Error(`${what} ended before it reached its stop`);
    }),
  ]);
}

/**
 * Whether `work` came to wait for a lock backend `holder` holds: `true` as soon as a backend is seen
 * waiting for it, `false` when `work` settled without one. `work` stays the caller's to await.
 */
async function waitsFor(holder: number, work: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  work.then(settle, settle);
  for (;;) {
    const { rows } = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [holder],
    );
    if (rows.length > 0) return true;
    if (settled) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Takes the tenant's mail-thread mutation guard in a transaction of its own and keeps it until
 * `release` runs; `beforeCommit` then runs in that transaction, still under the guard. Resolves the
 * holder's backend once the guard is held.
 */
async function holdThreadGuard(
  beforeCommit: (client: PoolClient) => Promise<void> = async () => {},
): Promise<{ backend: number; release: () => Promise<void> }> {
  const held = signal<number>();
  const released = signal();
  const holder = inTenant(async (client) => {
    await lockMailThreadMutation(client);
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error("the guard holder's backend has no pid");
    held.resolve(pid);
    await released.promise;
    await beforeCommit(client);
  });
  const backend = await reachedBeforeEnd(held.promise, holder, "the guard holder");
  return {
    backend,
    release: async () => {
      released.resolve();
      await holder;
    },
  };
}

describe("mail purge hook (gh-1691)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    const role = await runAsSystem("verify mail purge hook role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("an Emails item", () => {
    it("removes the purged Email's meta row, attachment rows and flag rows, and keeps another Email's rows, the Files items and the blobs", async () => {
      const ids = await idsOf();
      const { purged, kept } = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        return {
          purged: await ingest(client, ids, { mailbox, messageId: "<purged@x>", attachments: ["a.pdf", "b.pdf"] }),
          kept: await ingest(client, ids, { mailbox, messageId: "<kept@x>", attachments: ["c.pdf"] }),
        };
      });
      const keptThread = await threadOf(kept);
      expect(await emailRows(purged)).toEqual({
        meta: [(await threadOf(purged)).id],
        attachments: ["a.pdf", "b.pdf"],
        flags: ["flagged", "read"],
      });
      const files = await admin.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
        ids.files,
      ]);
      const blobs = await admin.query<{ id: string }>("SELECT id FROM blobs ORDER BY id");
      expect(files.rows).toHaveLength(3);
      expect(blobs.rows).toHaveLength(3);
      await trash(ids.emails, purged);

      expect(await purge(purged)).toEqual([purged]);

      expect(await emailRows(purged)).toEqual(NO_EMAIL_ROWS);
      expect(await emailRows(kept)).toEqual({
        meta: [keptThread.id],
        attachments: ["c.pdf"],
        flags: ["flagged", "read"],
      });
      expect(await existingThreads([keptThread.id])).toEqual([keptThread.id]);
      // The Files items the attachments were filed as stay live, and so do the blob rows they name.
      const filesAfter = await admin.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
        [ids.files],
      );
      expect(filesAfter.rows).toEqual(files.rows);
      expect((await admin.query<{ id: string }>("SELECT id FROM blobs ORDER BY id")).rows).toEqual(blobs.rows);
    });

    it.each(["live", "trashed"] as const)(
      "keeps the thread of a purged Email while a %s message still names it",
      async (other) => {
        const ids = await idsOf();
        const { first, reply } = await inTenant(async (client) => {
          const mailbox = await createMailbox(client, ids, "Work");
          const first = await ingest(client, ids, { mailbox, messageId: "<first@x>" });
          return {
            first,
            reply: await ingest(client, ids, { mailbox, messageId: "<reply@x>", references: ["<first@x>"] }),
          };
        });
        const thread = await threadOf(first);
        expect(await threadOf(reply)).toEqual(thread);
        const threadItem = await itemState(thread.itemId);
        expect(threadItem).toMatchObject([{ trashed: false }]);
        if (other === "trashed") await trash(ids.emails, reply);
        await trash(ids.emails, first);

        expect(await purge(first)).toEqual([first]);

        expect(await emailRows(first)).toEqual(NO_EMAIL_ROWS);
        expect(await existingThreads([thread.id])).toEqual([thread.id]);
        expect((await emailRows(reply)).meta).toEqual([thread.id]);
        // The thread's Threads item is exactly as it was: not trashed and not rewritten.
        expect(await itemState(thread.itemId)).toEqual(threadItem);
      },
    );

    it("removes the thread with its last message: the row and the aliases that point at it are deleted and its Threads item is trashed", async () => {
      const ids = await idsOf();
      const { first, second } = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        return {
          first: await ingest(client, ids, { mailbox, messageId: "<first@x>" }),
          second: await ingest(client, ids, { mailbox, messageId: "<second@x>" }),
        };
      });
      const thread = await threadOf(first);
      const merged = await threadOf(second);
      // The production merge moves the second message into the first thread and records the alias.
      await inTenant((client) => reassignThread(client, merged.id, thread.id));
      expect((await threadOf(second)).id).toBe(thread.id);
      const aliases = (): Promise<{ rows: Array<{ from_thread_id: string }> }> =>
        admin.query<{ from_thread_id: string }>(
          "SELECT from_thread_id::text AS from_thread_id FROM mail_thread_aliases WHERE to_thread_id = $1",
          [thread.id],
        );
      expect((await aliases()).rows).toEqual([{ from_thread_id: merged.id }]);
      await trash(ids.emails, first);
      await trash(ids.emails, second);
      expect(await purge(second)).toEqual([second]);
      // One message is left, so the thread is still there.
      expect(await existingThreads([thread.id])).toEqual([thread.id]);
      expect(await itemState(thread.itemId)).toMatchObject([{ trashed: false }]);

      expect(await purge(first)).toEqual([first]);

      expect(await existingThreads([thread.id])).toEqual([]);
      expect((await aliases()).rows).toEqual([]);
      // The Threads item is in the trash, not removed: the purge removed only the Email.
      expect(await itemState(thread.itemId)).toMatchObject([{ trashed: true }]);
      expect(await emailRows(first)).toEqual(NO_EMAIL_ROWS);
    });

    it("deletes the row of an emptied thread whose Threads item is already in the trash, and leaves that item as it was", async () => {
      const ids = await idsOf();
      const email = await inTenant(async (client) =>
        ingest(client, ids, { mailbox: await createMailbox(client, ids, "Work"), messageId: "<only@x>" }),
      );
      const thread = await threadOf(email);
      await trash(ids.threads, thread.itemId);
      const trashedThreadItem = await itemState(thread.itemId);
      expect(trashedThreadItem).toMatchObject([{ trashed: true }]);
      await trash(ids.emails, email);

      expect(await purge(email)).toEqual([email]);

      expect(await existingThreads([thread.id])).toEqual([]);
      expect(await emailRows(email)).toEqual(NO_EMAIL_ROWS);
      expect(await itemState(thread.itemId)).toEqual(trashedThreadItem);
    });

    it("deletes the row of an emptied thread whose Threads item was purged before", async () => {
      const ids = await idsOf();
      const email = await inTenant(async (client) =>
        ingest(client, ids, { mailbox: await createMailbox(client, ids, "Work"), messageId: "<only@x>" }),
      );
      const thread = await threadOf(email);
      await trash(ids.threads, thread.itemId);
      expect(await purge(thread.itemId)).toEqual([thread.itemId]);
      // The purge of a Threads item is not the hook's: the thread row is still there, bound to an item that is gone.
      expect(await existingThreads([thread.id])).toEqual([thread.id]);
      expect(await itemState(thread.itemId)).toEqual([]);
      await trash(ids.emails, email);

      expect(await purge(email)).toEqual([email]);

      expect(await existingThreads([thread.id])).toEqual([]);
      expect(await emailRows(email)).toEqual(NO_EMAIL_ROWS);
    });

    it("deletes the row of an emptied thread that is bound to no Threads item", async () => {
      const ids = await idsOf();
      const email = await inTenant(async (client) =>
        ingest(client, ids, { mailbox: await createMailbox(client, ids, "Work"), messageId: "<only@x>" }),
      );
      const thread = await threadOf(email);
      // Raw SQL: a thread row from before the Threads cutover has no item, and no current writer creates one.
      const unbound = await admin.query("UPDATE mail_threads SET item_id = NULL WHERE id = $1", [thread.id]);
      expect(unbound.rowCount).toBe(1);
      const formerThreadItem = await itemState(thread.itemId);
      await trash(ids.emails, email);

      expect(await purge(email)).toEqual([email]);

      expect(await existingThreads([thread.id])).toEqual([]);
      expect(await emailRows(email)).toEqual(NO_EMAIL_ROWS);
      expect(await itemState(thread.itemId)).toEqual(formerThreadItem);
      expect(formerThreadItem).toMatchObject([{ trashed: false }]);
    });

    it("purges an Email that has no meta row, an unsent draft, with its attachment and flag rows", async () => {
      const ids = await idsOf();
      const { draft, other } = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        const draft = await createEmailDraft(client, {
          emailsDatabaseId: ids.emails,
          folderRelationPropertyId: ids.emailFolderProperty,
          draftsFolderItemId: mailbox.archive,
          subject: "Draft",
          bodyText: "Draft body",
        });
        await ingestAttachments(client, {
          messageItemId: draft.id,
          filesDatabaseId: ids.files,
          attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
          attachments: [attachment("draft.pdf")],
          storage,
          storageKeyPrefix: "mail-purge-hook",
        });
        await recordObservedMailMessageFlags(client, draft.id, { read: true, flagged: true });
        return { draft: draft.id, other: await ingest(client, ids, { mailbox, messageId: "<other@x>" }) };
      });
      expect(await emailRows(draft)).toEqual({ meta: [], attachments: ["draft.pdf"], flags: ["flagged", "read"] });
      const otherThread = await threadOf(other);
      await trash(ids.emails, draft);

      expect(await purge(draft)).toEqual([draft]);

      expect(await emailRows(draft)).toEqual(NO_EMAIL_ROWS);
      expect(await existingThreads([otherThread.id])).toEqual([otherThread.id]);
      expect((await emailRows(other)).meta).toEqual([otherThread.id]);
    });

    it("purges an Email whose meta row names no thread, and deletes that row", async () => {
      const ids = await idsOf();
      const { unthreaded, other } = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        const item = await createItemWithClient(
          client,
          { databaseId: ids.emails, properties: { name: "Unthreaded" } },
          { allowedSystemKeys: ["name"] },
        );
        // The store's own writer, without a thread: the row the thread backfill has not reached yet.
        await upsertMailMessageMeta(client, {
          itemId: item.id,
          mailboxItemId: mailbox.id,
          messageId: "<unthreaded@x>",
          envelope: {},
        });
        return { unthreaded: item.id, other: await ingest(client, ids, { mailbox, messageId: "<other@x>" }) };
      });
      expect((await emailRows(unthreaded)).meta).toEqual([null]);
      const otherThread = await threadOf(other);
      const threadsBefore = (await mailRowVersions()).mail_threads;
      await trash(ids.emails, unthreaded);

      expect(await purge(unthreaded)).toEqual([unthreaded]);

      expect(await emailRows(unthreaded)).toEqual(NO_EMAIL_ROWS);
      expect((await mailRowVersions()).mail_threads).toEqual(threadsBefore);
      expect(await existingThreads([otherThread.id])).toEqual([otherThread.id]);
    });
  });

  describe("a Mailboxes item", () => {
    it("removes the credential, both kinds of sync state and the server settings of a purged mailbox that the generic delete trashed, and keeps another mailbox's rows", async () => {
      const ids = await idsOf();
      const { mailbox, other } = await inTenant(async (client) => ({
        mailbox: await createConnectedMailbox(client, ids, "Work"),
        other: await createConnectedMailbox(client, ids, "Private"),
      }));
      // A trashed folder is still one of the mailbox's folders: its sync state goes too.
      await trash(ids.folders, mailbox.archive);
      // The generic delete runs no removal, so every row of the mailbox is still there.
      await trash(ids.mailboxes, mailbox.id);
      expect(await mailboxRows(mailbox)).toEqual(connectedRows(mailbox));

      expect(await purge(mailbox.id)).toEqual([mailbox.id]);

      expect(await mailboxRows(mailbox)).toEqual(NO_MAILBOX_ROWS);
      expect(await mailboxRows(other)).toEqual(connectedRows(other));
      // The folders themselves are not the hook's: both are still there, one live and one in the trash.
      expect(await itemState(mailbox.inbox)).toMatchObject([{ trashed: false }]);
      expect(await itemState(mailbox.archive)).toMatchObject([{ trashed: true }]);
    });

    it("purges a mailbox that never connected and so has none of the rows", async () => {
      const ids = await idsOf();
      const { mailbox, other } = await inTenant(async (client) => ({
        mailbox: await createMailbox(client, ids, "Never connected"),
        other: await createConnectedMailbox(client, ids, "Private"),
      }));
      expect(await mailboxRows(mailbox)).toEqual(NO_MAILBOX_ROWS);
      await trash(ids.mailboxes, mailbox.id);

      expect(await purge(mailbox.id)).toEqual([mailbox.id]);

      expect(await itemState(mailbox.id)).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual(NO_MAILBOX_ROWS);
      expect(await mailboxRows(other)).toEqual(connectedRows(other));
    });
  });

  describe("an item of another database", () => {
    it("writes no mail table and does not wait for the mail-thread guard", async () => {
      const ids = await idsOf();
      const mailbox = await inTenant(async (client) => {
        const mailbox = await createConnectedMailbox(client, ids, "Work");
        await ingest(client, ids, { mailbox, messageId: "<kept@x>", attachments: ["a.pdf"] });
        return mailbox;
      });
      const { plain, impostor } = await runInTenant(tenant, async () => {
        const notes = await chokePoint.createDatabase({ name: "Notes" });
        const plain = await chokePoint.createItem({ databaseId: notes.id, properties: {} });
        const host = await chokePoint.createItem({ databaseId: notes.id, properties: {} });
        // A database that is not a system database and carries the Emails module id: not the Emails database.
        const lookalike = await chokePoint.createInlineDatabase({
          name: "Lookalike",
          parentItemId: host.id,
          ownerModuleId: EMAILS_MODULE_ID,
        });
        const impostor = await chokePoint.createItem({ databaseId: lookalike.id, properties: {} });
        await chokePoint.softDeleteItem(notes.id, plain.id);
        await chokePoint.softDeleteItem(lookalike.id, impostor.id);
        return { plain: plain.id, impostor: impostor.id };
      });
      // Mail rows that name the lookalike's item, which the Emails branch would delete.
      await inTenant(async (client) => {
        await recordObservedMailMessageFlags(client, impostor, { read: true, flagged: true });
        await upsertMailMessageMeta(client, {
          itemId: impostor,
          mailboxItemId: mailbox.id,
          messageId: "<impostor@x>",
          envelope: {},
        });
      });
      // A Folders item is an item of another database too: its own sync state row stays.
      await trash(ids.folders, mailbox.archive);
      const before = await mailRowVersions();
      expect(before.mail_folder_sync_state).toHaveLength(2);
      expect(before.mail_message_flag_sync_state).toHaveLength(4);
      const guard = await holdThreadGuard();
      const purges: Array<Promise<string[]>> = [];
      try {
        for (const itemId of [plain, impostor, mailbox.archive]) {
          const purged = purge(itemId);
          purges.push(purged);
          // Another transaction holds the guard the whole time: a purge that asked for it would wait here.
          expect({ itemId, waited: await waitsFor(guard.backend, purged) }).toEqual({ itemId, waited: false });
          expect(await purged).toEqual([itemId]);
        }
      } finally {
        await guard.release();
        await Promise.allSettled(purges);
      }

      expect(await mailRowVersions()).toEqual(before);
    });
  });

  describe("a failing delete", () => {
    it("rolls the purge of an Email back, with every mail row and its thread as they were", async () => {
      const ids = await idsOf();
      const email = await inTenant(async (client) =>
        ingest(client, ids, {
          mailbox: await createMailbox(client, ids, "Work"),
          messageId: "<only@x>",
          attachments: ["a.pdf"],
        }),
      );
      const thread = await threadOf(email);
      await trash(ids.emails, email);
      const before = {
        rows: await mailRowVersions(),
        email: await itemState(email),
        thread: await itemState(thread.itemId),
      };
      expect(before.email).toMatchObject([{ trashed: true }]);
      expect(before.thread).toMatchObject([{ trashed: false }]);

      // The flag rows are the hook's last delete: the meta row, the thread and the attachment rows went before it.
      const restore = await failDeletesFrom("mail_message_flag_sync_state");
      try {
        await expect(purge(email)).rejects.toThrow("test mail purge hook failure");
      } finally {
        await restore();
      }

      expect({
        rows: await mailRowVersions(),
        email: await itemState(email),
        thread: await itemState(thread.itemId),
      }).toEqual(before);
      // With the failure gone the same purge succeeds, so the rollback left nothing half-done.
      expect(await purge(email)).toEqual([email]);
      expect(await emailRows(email)).toEqual(NO_EMAIL_ROWS);
      expect(await existingThreads([thread.id])).toEqual([]);
    });

    it("rolls the purge of a mailbox back, with every row of it as it was", async () => {
      const ids = await idsOf();
      const mailbox = await inTenant((client) => createConnectedMailbox(client, ids, "Work"));
      await trash(ids.mailboxes, mailbox.id);
      const before = { rows: await mailRowVersions(), mailbox: await itemState(mailbox.id) };
      expect(before.mailbox).toMatchObject([{ trashed: true }]);

      // The server settings are the hook's last delete: the credential and both sync states went before it.
      const restore = await failDeletesFrom("mail_account_server_settings");
      try {
        await expect(purge(mailbox.id)).rejects.toThrow("test mail purge hook failure");
      } finally {
        await restore();
      }

      expect({ rows: await mailRowVersions(), mailbox: await itemState(mailbox.id) }).toEqual(before);
      expect(await mailboxRows(mailbox)).toEqual(connectedRows(mailbox));
      expect(await purge(mailbox.id)).toEqual([mailbox.id]);
      expect(await mailboxRows(mailbox)).toEqual(NO_MAILBOX_ROWS);
    });
  });

  describe("two tenants", () => {
    /** A trashed Email with an attachment, a generically trashed connected mailbox and a folder without a mailbox that has a sync state. */
    async function seedTenantMail(tenantId: string): Promise<{
      ids: MailIds;
      email: string;
      thread: string;
      mailbox: TestMailbox;
      strayFolder: string;
    }> {
      const ids = await idsOf(tenantId);
      const seeded = await inTenant(async (client) => {
        const mailbox = await createConnectedMailbox(client, ids, "Work");
        const email = await ingest(client, ids, { mailbox, messageId: "<same@x>", attachments: ["a.pdf"] });
        const stray = await createItemWithClient(
          client,
          { databaseId: ids.folders, properties: { name: "stray" } },
          { allowedSystemKeys: ["name"] },
        );
        await ensureMailFolderSyncState(client, stray.id);
        return { email, mailbox, strayFolder: stray.id };
      }, tenantId);
      await trash(ids.emails, seeded.email, tenantId);
      await trash(ids.mailboxes, seeded.mailbox.id, tenantId);
      return { ids, ...seeded, thread: (await threadOf(seeded.email)).id };
    }

    it("deletes the purging tenant's rows and none of another tenant's, which that tenant then purges itself", async () => {
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const own = await seedTenantMail(tenant);
      const theirs = await seedTenantMail(other);
      const theirsBefore = await mailRowVersions(other);
      expect(theirsBefore.mail_folder_sync_state).toHaveLength(3);
      // Row-level security hides this tenant's items from the other: its purge of them removes nothing.
      expect(await purge(own.email, other)).toEqual([]);
      expect(await purge(own.mailbox.id, other)).toEqual([]);
      expect(await mailboxRows(own.mailbox)).toEqual(connectedRows(own.mailbox));

      expect(await purge(own.email)).toEqual([own.email]);
      expect(await purge(own.mailbox.id)).toEqual([own.mailbox.id]);

      expect(await emailRows(own.email)).toEqual(NO_EMAIL_ROWS);
      expect(await existingThreads([own.thread])).toEqual([]);
      expect(await mailboxRows(own.mailbox)).toEqual(NO_MAILBOX_ROWS);
      // The other tenant's rows are untouched, its folder without a mailbox included, and it still sees them.
      expect(await mailRowVersions(other)).toEqual(theirsBefore);
      expect(await mailboxRows(theirs.mailbox, other)).toEqual(connectedRows(theirs.mailbox));
      expect(await emailRows(theirs.email)).toEqual({
        meta: [theirs.thread],
        attachments: ["a.pdf"],
        flags: ["flagged", "read"],
      });

      expect(await purge(theirs.email, other)).toEqual([theirs.email]);
      expect(await purge(theirs.mailbox.id, other)).toEqual([theirs.mailbox.id]);

      expect(await emailRows(theirs.email)).toEqual(NO_EMAIL_ROWS);
      expect(await existingThreads([theirs.thread])).toEqual([]);
      expect(await mailboxRows(theirs.mailbox, other)).toEqual(NO_MAILBOX_ROWS);
      const { rows } = await admin.query<{ item_id: string }>(
        "SELECT item_id::text AS item_id FROM mail_folder_sync_state WHERE item_id = ANY($1::uuid[])",
        [[own.strayFolder, theirs.strayFolder]],
      );
      expect(rows).toEqual([]);
    });

    it("runs in the trash sweep, which purges each tenant's expired mail items in that tenant", async () => {
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const own = await seedTenantMail(tenant);
      const theirs = await seedTenantMail(other);
      const fresh = await inTenant(async (client) =>
        ingest(client, own.ids, { mailbox: await createMailbox(client, own.ids, "Fresh"), messageId: "<fresh@x>" }),
      );
      await trash(own.ids.emails, fresh);
      const freshRows = await emailRows(fresh);
      // Raw SQL: real trash ages over time and no production write sets `deleted_at` to a past instant.
      const expired = [own.email, own.mailbox.id, theirs.email, theirs.mailbox.id];
      const backdated = await admin.query(
        "UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
        [expired],
      );
      expect(backdated.rowCount).toBe(expired.length);

      await handleItemTrashPurgeSweepTask(runtime, storage);

      for (const itemId of expired) expect(await itemState(itemId)).toEqual([]);
      expect(await emailRows(own.email)).toEqual(NO_EMAIL_ROWS);
      expect(await emailRows(theirs.email)).toEqual(NO_EMAIL_ROWS);
      expect(await existingThreads([own.thread, theirs.thread])).toEqual([]);
      expect(await mailboxRows(own.mailbox)).toEqual(NO_MAILBOX_ROWS);
      expect(await mailboxRows(theirs.mailbox, other)).toEqual(NO_MAILBOX_ROWS);
      // A trashed Email younger than the retention is not purged, so its rows stay.
      expect(await itemState(fresh)).toMatchObject([{ trashed: true }]);
      expect(await emailRows(fresh)).toEqual(freshRows);
      expect(freshRows.meta).toHaveLength(1);
    });
  });

  describe("the mail-thread guard", () => {
    it("makes the purge of an Email wait for the guard's holder, and keeps the thread a reply joined meanwhile", async () => {
      const ids = await idsOf();
      const { mailbox, first } = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        return { mailbox, first: await ingest(client, ids, { mailbox, messageId: "<first@x>" }) };
      });
      const thread = await threadOf(first);
      await trash(ids.emails, first);
      let reply: string | undefined;
      // The holder ingests a reply to the trashed message under the guard, after the purge began to wait.
      const guard = await holdThreadGuard(async (client) => {
        reply = await ingest(client, ids, { mailbox, messageId: "<reply@x>", references: ["<first@x>"] });
      });
      let purgeSettled = false;
      const purged = purge(first).finally(() => {
        purgeSettled = true;
      });
      try {
        expect(await waitsFor(guard.backend, purged)).toBe(true);
        expect(purgeSettled).toBe(false);
        // The purge has not committed: the message's rows are all still there.
        expect((await emailRows(first)).meta).toEqual([thread.id]);
      } finally {
        await guard.release();
        await Promise.allSettled([purged]);
      }

      expect(await purged).toEqual([first]);
      expect(await emailRows(first)).toEqual(NO_EMAIL_ROWS);
      // The reply joined the thread before the purge read it, so the thread and its Threads item stay.
      if (reply === undefined) throw new Error("the holder did not ingest the reply");
      expect((await emailRows(reply)).meta).toEqual([thread.id]);
      expect(await existingThreads([thread.id])).toEqual([thread.id]);
      expect(await itemState(thread.itemId)).toMatchObject([{ trashed: false }]);
    });
  });

  describe("the store deletes", () => {
    it("report how many rows they deleted, and the folder delete leaves a folder that has a mailbox alone", async () => {
      const ids = await idsOf();
      const { mailbox, email, stray } = await inTenant(async (client) => {
        const mailbox = await createConnectedMailbox(client, ids, "Work");
        const email = await ingest(client, ids, { mailbox, messageId: "<only@x>", attachments: ["a.pdf", "b.pdf"] });
        const stray = await createItemWithClient(
          client,
          { databaseId: ids.folders, properties: { name: "stray" } },
          { allowedSystemKeys: ["name"] },
        );
        await ensureMailFolderSyncState(client, stray.id);
        // A sync state row whose item is not in the Folders database: the delete below is not asked about it.
        await ensureMailFolderSyncState(client, email);
        return { mailbox, email, stray: stray.id };
      });

      const counts = await inTenant(async (client) => ({
        attachments: await deleteMailAttachmentsOfMessage(client, email),
        attachmentsAgain: await deleteMailAttachmentsOfMessage(client, email),
        flags: await deleteMailMessageFlagSyncStates(client, email),
        flagsAgain: await deleteMailMessageFlagSyncStates(client, email),
        // The Emails database has no `mailbox` relation, so nothing in it counts as a folder without a mailbox.
        notFolders: await deleteMailFolderSyncStatesOfFoldersWithoutMailbox(client, ids.emails),
        folders: await deleteMailFolderSyncStatesOfFoldersWithoutMailbox(client, ids.folders),
        foldersAgain: await deleteMailFolderSyncStatesOfFoldersWithoutMailbox(client, ids.folders),
      }));

      expect(counts).toEqual({
        attachments: 2,
        attachmentsAgain: 0,
        flags: 2,
        flagsAgain: 0,
        notFolders: 0,
        folders: 1,
        foldersAgain: 0,
      });
      const { rows } = await admin.query<{ item_id: string }>(
        "SELECT item_id::text AS item_id FROM mail_folder_sync_state ORDER BY item_id",
      );
      // The folder without a mailbox lost its row; the mailbox's two folders and the Emails item kept theirs.
      expect(rows.map((row) => row.item_id)).toEqual([mailbox.inbox, mailbox.archive, email].sort());
      expect([mailbox.inbox, mailbox.archive, email]).not.toContain(stray);
      expect((await emailRows(email)).meta).toHaveLength(1);
    });
  });
});
