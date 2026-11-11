import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemDeleteHook } from "../chokePoint/hooks.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { listItems } from "../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { ingestAttachments, type ClassifiedAttachment } from "../mail/attachments.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { getMailboxRemovalImpact } from "../mail/mailboxRemovalImpact.js";
import { handleMailboxRemovalTask, mailboxRemovalJobKey } from "../mail/mailboxRemovalJob.js";
import { createActionQueueAffinity, createActionRegistry } from "../scheduler/actions.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createApiCoreTaskList } from "../worker.js";

/** The seeded ids every fixture shares, read per tenant. */
interface MailIds {
  mailboxes: string;
  folders: string;
  emails: string;
  files: string;
  emailFolderProperty: string;
  emailAttachmentsProperty: string;
  folderMailboxProperty: string;
}

type FolderPurpose = "inbox" | "archive" | "drafts" | "junk";

/** A Mailboxes item with the four Folders a test files mail into. */
type TestMailbox = { id: string } & Record<FolderPurpose, string>;

/** How one item stands after the job: live, trashed with the mailbox's deletion time, or trashed at a time of its own. */
type Standing = "live" | "withMailbox" | "ownTime";

const taskName = CORE_TASK_NAMES.MAILBOX_REMOVAL;

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;
/** The item whose trash the test delete hook refuses, to interrupt a run; registered once for the file. */
let veto: string | null = null;
/** The storage keys the attachment writer was asked to delete. */
let deletedStorageKeys: string[] = [];

const storage: BlobStorageWriter = {
  async writeStream(_storageKey: string, source: Readable) {
    let byteSize = 0;
    for await (const chunk of source) byteSize += Buffer.byteLength(chunk);
    return { byteSize, contentHash: randomUUID() };
  },
  async delete(storageKey: string) {
    deletedStorageKeys.push(storageKey);
  },
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
    emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
    emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
    folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
  };
}

/** A Mailboxes item and its folders, each linked to it through the production folder edge. */
async function createMailbox(client: PoolClient, ids: MailIds, name: string): Promise<TestMailbox> {
  const mailbox = await createItemWithClient(client, {
    databaseId: ids.mailboxes,
    properties: { name, provider: "generic" },
  });
  const folder = async (purpose: FolderPurpose): Promise<string> => {
    const row = await createItemWithClient(
      client,
      { databaseId: ids.folders, properties: { name: purpose, behavior: "folder", specialPurpose: purpose } },
      { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: ids.folderMailboxProperty, callerItemId: row.id, targetItemId: mailbox.id },
      { ownerProcess: FOLDERS_MODULE_ID },
    );
    return row.id;
  };
  return {
    id: mailbox.id,
    inbox: await folder("inbox"),
    archive: await folder("archive"),
    drafts: await folder("drafts"),
    junk: await folder("junk"),
  };
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

/** One message through the production ingest writer. A repeated `messageId` in the same mailbox joins the same Email, as sync does. */
function ingest(
  client: PoolClient,
  ids: MailIds,
  input: { mailboxId: string; folder: string; messageId: string; references?: string[]; attachments?: string[] },
): Promise<string> {
  const references = input.references ?? [];
  return ingestEmailMessage(client, {
    emailsDatabaseId: ids.emails,
    filesDatabaseId: ids.files,
    folderRelationPropertyId: ids.emailFolderProperty,
    attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
    folderItemId: input.folder,
    mailboxItemId: input.mailboxId,
    messageId: input.messageId,
    inReplyTo: references.at(-1) ?? null,
    references,
    subject: input.messageId,
    envelope: { from: { address: "bob@example.com" }, to: [{ address: "me@example.com" }] },
    attachments: (input.attachments ?? []).map(attachment),
    storage,
    storageKeyPrefix: "removal-job",
  }).then((result) => result.itemId);
}

/** A draft through the production draft writer, with no Message-ID and so no thread, as an unsent draft has. */
async function createDraft(
  client: PoolClient,
  ids: MailIds,
  draftsFolder: string,
  attachments: string[] = [],
): Promise<string> {
  const draft = await createEmailDraft(client, {
    emailsDatabaseId: ids.emails,
    folderRelationPropertyId: ids.emailFolderProperty,
    draftsFolderItemId: draftsFolder,
    subject: "Draft",
    bodyText: "Draft body",
  });
  if (attachments.length > 0) {
    await ingestAttachments(client, {
      messageItemId: draft.id,
      filesDatabaseId: ids.files,
      attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
      attachments: attachments.map(attachment),
      storage,
      storageKeyPrefix: "removal-job",
    });
  }
  return draft.id;
}

/** Soft-deletes one item through the choke point, at a time of its own, and fails if nothing was deleted. */
async function softDelete(databaseId: string, itemId: string, tenantId = tenant): Promise<void> {
  const deleted = await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemId));
  if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
}

function remove(mailboxItemId: string, tenantId = tenant): Promise<boolean> {
  return runInTenant(tenantId, () =>
    removeMailbox(runtime, mailboxItemId, { queueAffinity: createActionQueueAffinity() }),
  );
}

function runJob(mailboxItemId: string, options: { chunkSize?: number } = {}, tenantId = tenant): Promise<void> {
  return runInTenant(tenantId, () => handleMailboxRemovalTask(runtime, { mailboxItemId }, options));
}

/**
 * Each item's standing against mailbox `mailboxId`, compared by Postgres at the column's full precision,
 * with the columns a rerun must leave alone. Read in `tenantId`'s scope.
 */
async function standings(
  mailboxId: string,
  itemIds: string[],
  tenantId = tenant,
): Promise<Record<string, { standing: Standing; deletedAt: string | null; updatedAt: string }>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{
      id: string;
      deleted_at: string | null;
      updated_at: string;
      with_mailbox: boolean | null;
    }>(
      `SELECT i.id, i.deleted_at::text AS deleted_at, i.updated_at::text AS updated_at,
              i.deleted_at = (SELECT m.deleted_at FROM items m WHERE m.id = $1) AS with_mailbox
         FROM items i WHERE i.id = ANY($2::uuid[])`,
      [mailboxId, itemIds],
    );
    return Object.fromEntries(
      rows.map((row) => {
        const standing: Standing =
          row.deleted_at === null ? "live" : row.with_mailbox === true ? "withMailbox" : "ownTime";
        return [row.id, { standing, deletedAt: row.deleted_at, updatedAt: row.updated_at }];
      }),
    );
  }, tenantId);
}

async function standingOf(mailboxId: string, itemIds: string[], tenantId = tenant): Promise<Record<string, Standing>> {
  const all = await standings(mailboxId, itemIds, tenantId);
  return Object.fromEntries(Object.entries(all).map(([id, row]) => [id, row.standing]));
}

function allStanding(ids: string[], standing: Standing): Record<string, Standing> {
  return Object.fromEntries(ids.map((id) => [id, standing]));
}

/** The inbox thread list as the route reads it: each listed thread's id and message count. */
function listedThreads(tenantId = tenant): Promise<Array<{ threadId: string; messageCount: number }>> {
  return inTenant(async (client) => {
    const threads = await listMailThreads(client, 200, null, {
      box: "inbox",
      folderId: null,
      unread: false,
      mailboxId: null,
    });
    return threads.map((thread) => ({ threadId: thread.threadId, messageCount: thread.messageCount }));
  }, tenantId);
}

/** The ids the generic list of `databaseId` returns, which leaves trashed items out. */
function listedItemIds(databaseId: string, tenantId = tenant): Promise<string[]> {
  return inTenant(async (client) => {
    const page = await listItems(client, databaseId, { limit: 200 });
    if (page.nextCursor !== null) throw new Error("the fixture outgrew one list page");
    return page.items.map((item) => item.id);
  }, tenantId);
}

async function threadOf(itemId: string): Promise<string> {
  const threadId = await inTenant(async (client) => {
    const { rows } = await client.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
      [itemId],
    );
    return rows[0]?.thread_id ?? null;
  });
  if (threadId === null) throw new Error(`message ${itemId} has no thread`);
  return threadId;
}

/** The queued jobs under one key, from Graphile Worker's public `jobs` view. */
async function queuedJobs(jobKey: string): Promise<Array<{ task_identifier: string; queue_name: string | null }>> {
  const { rows } = await admin.query<{ task_identifier: string; queue_name: string | null }>(
    "SELECT task_identifier, queue_name FROM graphile_worker.jobs WHERE key = $1",
    [jobKey],
  );
  return rows;
}

describe("mailboxRemoval job (gh-2029)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    // A registry has no unregister: the hook stays for the file and refuses only the item `veto` names.
    registerItemDeleteHook(async (context) => {
      if (veto === context.item.id) throw new Error("removal interrupted");
    });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
    veto = null;
    deletedStorageKeys = [];
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("soft-deletes exactly the folders, messages, drafts and threads the impact report counted, with the mailbox's deletion time, and keeps attachments and other mail", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const seeded = await inTenant(async (client) => {
      const work = await createMailbox(client, ids, "Work");
      const other = await createMailbox(client, ids, "Private");
      const withAttachment = await ingest(client, ids, {
        mailboxId: work.id,
        folder: work.inbox,
        messageId: "<m1@x>",
        attachments: ["a.pdf"],
      });
      const inTwoFolders = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m2@x>" });
      await ingest(client, ids, { mailboxId: work.id, folder: work.archive, messageId: "<m2@x>" });
      const trashedBefore = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m3@x>" });
      const inTrashedFolder = await ingest(client, ids, { mailboxId: work.id, folder: work.junk, messageId: "<m4@x>" });
      const sharedRoot = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<root@x>" });
      const otherReply = await ingest(client, ids, {
        mailboxId: other.id,
        folder: other.inbox,
        messageId: "<reply@x>",
        references: ["<root@x>"],
      });
      const otherSolo = await ingest(client, ids, { mailboxId: other.id, folder: other.inbox, messageId: "<n1@x>" });
      const draft = await createDraft(client, ids, work.drafts, ["e.pdf"]);
      const draftTrashedBefore = await createDraft(client, ids, work.drafts);
      return {
        work,
        other,
        withAttachment,
        inTwoFolders,
        trashedBefore,
        inTrashedFolder,
        sharedRoot,
        otherReply,
        otherSolo,
        draft,
        draftTrashedBefore,
      };
    });
    const { work, other } = seeded;
    await softDelete(ids.emails, seeded.trashedBefore);
    await softDelete(ids.emails, seeded.draftTrashedBefore);
    await softDelete(ids.folders, work.junk);
    const messages = [seeded.withAttachment, seeded.inTwoFolders, seeded.sharedRoot];
    const drafts = [seeded.draft];
    const sharedThread = await threadOf(seeded.sharedRoot);
    expect(await threadOf(seeded.otherReply)).toBe(sharedThread);
    const ownThreads = [await threadOf(seeded.withAttachment), await threadOf(seeded.inTwoFolders)];
    const otherThread = await threadOf(seeded.otherSolo);
    const attachments = () =>
      inTenant(async (client) => {
        const rows = await client.query<{ id: string; blob_id: string }>(
          "SELECT id, blob_id FROM mail_attachments WHERE message_item_id = ANY($1::uuid[]) ORDER BY id",
          [[seeded.withAttachment, seeded.draft]],
        );
        const blobIds = rows.rows.map((row) => row.blob_id);
        const blobs = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM blobs WHERE id = ANY($1::uuid[])",
          [blobIds],
        );
        // The Files item of an attachment names its blob in `properties.file.blobId`.
        const files = await client.query<{ id: string }>(
          `SELECT id FROM items WHERE database_id = $1 AND properties -> 'file' ->> 'blobId' = ANY($2::text[]) ORDER BY id`,
          [ids.files, blobIds],
        );
        return { rows: rows.rows, blobs: blobs.rows[0]?.n, fileItemIds: files.rows.map((row) => row.id) };
      });
    const attachmentsBefore = await attachments();
    expect(attachmentsBefore.rows).toHaveLength(2);
    expect(attachmentsBefore.blobs).toBe(2);
    expect(attachmentsBefore.fileItemIds).toHaveLength(2);
    expect((await listedThreads()).map((thread) => thread.threadId).sort()).toEqual(
      [...ownThreads, sharedThread, otherThread].sort(),
    );

    const impact = await inTenant((client) => getMailboxRemovalImpact(client, work.id));
    expect(impact).toEqual({ messages: 3, drafts: 1, threads: 2, attachmentsKept: 2 });
    expect(await remove(work.id)).toBe(true);
    await runJob(work.id);

    // Exactly the counted members carry the mailbox's deletion time, and so do the folders that were live.
    const members = [...messages, ...drafts];
    const nonMembers = [seeded.trashedBefore, seeded.draftTrashedBefore, seeded.inTrashedFolder];
    expect(await standingOf(work.id, [...members, ...nonMembers])).toEqual({
      ...allStanding(members, "withMailbox"),
      [seeded.trashedBefore]: "ownTime",
      [seeded.draftTrashedBefore]: "ownTime",
      [seeded.inTrashedFolder]: "live",
    });
    expect(await standingOf(work.id, [work.inbox, work.archive, work.drafts, work.junk])).toEqual({
      ...allStanding([work.inbox, work.archive, work.drafts], "withMailbox"),
      [work.junk]: "ownTime",
    });
    expect(messages).toHaveLength(impact?.messages ?? -1);
    expect(drafts).toHaveLength(impact?.drafts ?? -1);

    // The two threads that were this mailbox's alone are gone from the list; the shared one stays with the other mailbox's message.
    const listed = await listedThreads();
    const gone = [...ownThreads, sharedThread].filter((id) => !listed.some((thread) => thread.threadId === id));
    expect(gone.sort()).toEqual([...ownThreads].sort());
    expect(gone).toHaveLength(impact?.threads ?? -1);
    expect(listed.filter((thread) => thread.threadId === sharedThread)).toEqual([
      { threadId: sharedThread, messageCount: 1 },
    ]);
    expect(listed.map((thread) => thread.threadId).sort()).toEqual([sharedThread, otherThread].sort());

    // The generic lists leave the trashed folders and messages out and keep the other mailbox's.
    const otherFolders = [other.inbox, other.archive, other.drafts, other.junk];
    expect((await listedItemIds(ids.folders)).sort()).toEqual([...otherFolders].sort());
    expect((await listedItemIds(ids.emails)).sort()).toEqual(
      [seeded.otherReply, seeded.otherSolo, seeded.inTrashedFolder].sort(),
    );
    expect(await standingOf(work.id, [seeded.otherReply, seeded.otherSolo, ...otherFolders])).toEqual(
      allStanding([seeded.otherReply, seeded.otherSolo, ...otherFolders], "live"),
    );

    // The attachment rows, their Files items and their blobs are kept, and no stored file was deleted.
    expect(await attachments()).toEqual(attachmentsBefore);
    expect(attachmentsBefore.rows).toHaveLength(impact?.attachmentsKept ?? -1);
    expect(await standingOf(work.id, attachmentsBefore.fileItemIds)).toEqual(
      allStanding(attachmentsBefore.fileItemIds, "live"),
    );
    expect(deletedStorageKeys).toEqual([]);
  });

  it("queues no job when the removal rolls back, and one job on the tenant's lane when it commits", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      await upsertMailServerSettings(client, created.id, {
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: null,
        username: "user@example.com",
      });
      return created;
    });
    const jobKey = mailboxRemovalJobKey(mailbox.id);
    expect(jobKey).toBe(`mailbox-removal-${mailbox.id}`);

    // The removal has to fail after its enqueue statement ran, or the test would pass for an enqueue on
    // any connection. The enqueue is the removal's last statement, so the failure is a deferred
    // constraint trigger: it fires at COMMIT, for the server settings row the removal deleted. No
    // production code exposes that seam.
    await admin.query(`CREATE FUNCTION test_mailbox_removal_job_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test mailbox removal failure'; END $$`);
    try {
      await admin.query(
        `CREATE CONSTRAINT TRIGGER test_mailbox_removal_job_fail AFTER DELETE ON mail_account_server_settings
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_mailbox_removal_job_fail()`,
      );
      await expect(remove(mailbox.id)).rejects.toThrow("test mailbox removal failure");
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_mailbox_removal_job_fail ON mail_account_server_settings");
      await admin.query("DROP FUNCTION test_mailbox_removal_job_fail()");
    }
    expect(await queuedJobs(jobKey)).toEqual([]);
    expect(await readJobPayloadsByIdentifier(admin, taskName)).toEqual([]);

    expect(await remove(mailbox.id)).toBe(true);

    expect(await queuedJobs(jobKey)).toEqual([{ task_identifier: taskName, queue_name: `mailbox-removal:${tenant}` }]);
    const payloads = z
      .array(z.object({ tenantId: z.string(), payload: z.unknown() }))
      .parse(await readJobPayloadsByIdentifier(admin, taskName));
    expect(payloads).toEqual([{ tenantId: tenant, payload: { mailboxItemId: mailbox.id } }]);
  });

  it("runs the queued job from the production task list in the tenant of its envelope", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { mailbox, message } = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      return {
        mailbox: created,
        message: await ingest(client, ids, { mailboxId: created.id, folder: created.inbox, messageId: "<m1@x>" }),
      };
    });
    expect(await remove(mailbox.id)).toBe(true);
    expect(await standingOf(mailbox.id, [message, mailbox.inbox])).toEqual(
      allStanding([message, mailbox.inbox], "live"),
    );

    const handler = createApiCoreTaskList(runtime, createActionRegistry())[taskName];
    if (!handler) throw new Error("The mailboxRemoval handler is missing from the production API task list");
    // No tenant scope around the drain: the task list enters the job's tenant from its envelope.
    await runOnce({ pgPool: admin }, { [taskName]: handler });

    expect(await standingOf(mailbox.id, [message, mailbox.inbox])).toEqual(
      allStanding([message, mailbox.inbox], "withMailbox"),
    );
    expect(await queuedJobs(mailboxRemovalJobKey(mailbox.id))).toEqual([]);
  });

  it("keeps the chunks an interrupted run committed, and a rerun finishes without rewriting them", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { mailbox, emails } = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      const made: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        made.push(
          await ingest(client, ids, { mailboxId: created.id, folder: created.inbox, messageId: `<m${index}@x>` }),
        );
      }
      // The job pages in the database's uuid order; node's default sort of canonical uuid text is the same order.
      return { mailbox: created, emails: made.sort() };
    });
    const folders = [mailbox.inbox, mailbox.archive, mailbox.drafts, mailbox.junk];
    const firstChunk = emails.slice(0, 2);
    const rest = emails.slice(2);
    expect(await remove(mailbox.id)).toBe(true);

    // The third email is in the second chunk of two: its refused trash fails that chunk and the run.
    veto = emails[2] ?? null;
    await expect(runJob(mailbox.id, { chunkSize: 2 })).rejects.toThrow("removal interrupted");

    expect(await standingOf(mailbox.id, [...emails, ...folders])).toEqual({
      ...allStanding(firstChunk, "withMailbox"),
      ...allStanding([...rest, ...folders], "live"),
    });
    const afterInterruption = await standings(mailbox.id, firstChunk);

    veto = null;
    await runJob(mailbox.id, { chunkSize: 2 });

    expect(await standingOf(mailbox.id, [...emails, ...folders])).toEqual(
      allStanding([...emails, ...folders], "withMailbox"),
    );
    expect(await standings(mailbox.id, firstChunk)).toEqual(afterInterruption);

    // A further run finds nothing left and changes no row.
    const finished = await standings(mailbox.id, [...emails, ...folders]);
    await runJob(mailbox.id, { chunkSize: 2 });
    expect(await standings(mailbox.id, [...emails, ...folders])).toEqual(finished);
  });

  it("leaves a second tenant's mail untouched, and that tenant's job naming the mailbox does nothing", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { mailbox, message } = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      return {
        mailbox: created,
        message: await ingest(client, ids, { mailboxId: created.id, folder: created.inbox, messageId: "<m1@x>" }),
      };
    });
    const otherTenant = await createTestTenant(admin);
    await provisionTenant(runtime, otherTenant);
    const otherIds = await inTenant((client) => loadIds(client), otherTenant);
    const theirs = await inTenant(async (client) => {
      const created = await createMailbox(client, otherIds, "Theirs");
      return {
        mailbox: created,
        message: await ingest(client, otherIds, {
          mailboxId: created.id,
          folder: created.inbox,
          messageId: "<m1@x>",
        }),
      };
    }, otherTenant);
    const theirRows = [theirs.mailbox.id, theirs.mailbox.inbox, theirs.message];
    const theirsBefore = await standings(theirs.mailbox.id, theirRows, otherTenant);
    expect(await remove(mailbox.id)).toBe(true);

    // The other tenant's job cannot see the mailbox, so it ends as it does for an unknown id.
    await runJob(mailbox.id, {}, otherTenant);
    expect(await standingOf(mailbox.id, [message, mailbox.inbox])).toEqual(
      allStanding([message, mailbox.inbox], "live"),
    );

    await runJob(mailbox.id);
    expect(await standingOf(mailbox.id, [message, mailbox.inbox])).toEqual(
      allStanding([message, mailbox.inbox], "withMailbox"),
    );
    expect(await standings(theirs.mailbox.id, theirRows, otherTenant)).toEqual(theirsBefore);
    expect(Object.values(theirsBefore).map((row) => row.standing)).toEqual(["live", "live", "live"]);
  });

  it("does nothing for a mailbox that is live, restored before the job ran, or unknown", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { live, restored, rows } = await inTenant(async (client) => {
      const liveMailbox = await createMailbox(client, ids, "Live");
      const restoredMailbox = await createMailbox(client, ids, "Restored");
      const liveMessage = await ingest(client, ids, {
        mailboxId: liveMailbox.id,
        folder: liveMailbox.inbox,
        messageId: "<live@x>",
      });
      const restoredMessage = await ingest(client, ids, {
        mailboxId: restoredMailbox.id,
        folder: restoredMailbox.inbox,
        messageId: "<restored@x>",
      });
      return {
        live: liveMailbox,
        restored: restoredMailbox,
        rows: [liveMessage, liveMailbox.inbox, restoredMessage, restoredMailbox.inbox],
      };
    });
    expect(await remove(restored.id)).toBe(true);
    expect(await runInTenant(tenant, () => chokePoint.restoreItem(ids.mailboxes, restored.id))).not.toBeNull();
    const before = await standings(live.id, rows);

    await runJob(live.id);
    await runJob(restored.id);
    await runJob(randomUUID());

    expect(await standings(live.id, rows)).toEqual(before);
    expect(Object.values(before).map((row) => row.standing)).toEqual(["live", "live", "live", "live"]);
  });

  it("waits for a restore of the mailbox that is in flight, and then trashes nothing", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { mailbox, message } = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      return {
        mailbox: created,
        message: await ingest(client, ids, { mailboxId: created.id, folder: created.inbox, messageId: "<m1@x>" }),
      };
    });
    expect(await remove(mailbox.id)).toBe(true);

    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportRestorer: (pid: number) => void = () => {};
    const restorerPid = new Promise<number>((resolve) => {
      reportRestorer = resolve;
    });
    // The restore holds the Mailboxes item FOR UPDATE, uncommitted, until the test releases it.
    const restore = inTenant(async (client) => {
      await restoreItemWithClient(client, ids.mailboxes, mailbox.id, createActionQueueAffinity());
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error("the restore's backend has no pid");
      reportRestorer(pid);
      await released;
    });
    let jobSettled = false;
    const job = runJob(mailbox.id).finally(() => {
      jobSettled = true;
    });
    try {
      const holder = await restorerPid;
      // The job's first chunk waits on the restore's row lock instead of reading the epoch the restore is clearing.
      await vi.waitFor(
        async () => {
          const { rows } = await admin.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [holder],
          );
          expect(rows[0]?.waiting).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      expect(jobSettled).toBe(false);
    } finally {
      release();
      await Promise.allSettled([restore, job]);
    }
    await restore;
    await job;

    expect(await standingOf(mailbox.id, [mailbox.id, message, mailbox.inbox])).toEqual(
      allStanding([mailbox.id, message, mailbox.inbox], "live"),
    );
  });

  it("rejects a payload that is not exactly one mailbox id", async () => {
    await expect(runInTenant(tenant, () => handleMailboxRemovalTask(runtime, {}))).rejects.toThrow();
    await expect(
      runInTenant(tenant, () => handleMailboxRemovalTask(runtime, { mailboxItemId: "not-a-uuid" })),
    ).rejects.toThrow();
    await expect(
      runInTenant(tenant, () => handleMailboxRemovalTask(runtime, { mailboxItemId: randomUUID(), extra: true })),
    ).rejects.toThrow();
  });
});
