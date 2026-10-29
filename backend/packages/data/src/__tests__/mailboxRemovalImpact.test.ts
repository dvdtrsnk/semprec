import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { ingestAttachments, type ClassifiedAttachment } from "../mail/attachments.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import {
  createMailboxRemovalImpactRouteHandler,
  getMailboxRemovalImpact,
  type MailboxRemovalImpact,
} from "../mail/mailboxRemovalImpact.js";
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

/** The seeded ids every fixture shares, read once per test from the tenant under test. */
interface MailIds {
  mailboxes: string;
  folders: string;
  emails: string;
  files: string;
  /** Emails.folder, the Email side of the folder edge. */
  emailFolderProperty: string;
  /** Emails.attachments, the relation a Files item hangs off. */
  emailAttachmentsProperty: string;
  /** Folders.mailbox, the Folder side of the mailbox edge. */
  folderMailboxProperty: string;
}

/** A Mailboxes item with the three Folders a test files mail into. */
interface TestMailbox {
  id: string;
  inbox: string;
  archive: string;
  drafts: string;
}

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;
let ids: MailIds;

/** Consumes each attachment stream, so the write completes as a real storage write does. */
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

/** A Mailboxes item and its inbox, archive and drafts folders, each linked to it through the production folder edge. */
async function createMailbox(client: PoolClient, name: string): Promise<TestMailbox> {
  const mailbox = await createItemWithClient(client, {
    databaseId: ids.mailboxes,
    properties: { name, provider: "generic" },
  });
  const folder = async (purpose: "inbox" | "archive" | "drafts"): Promise<string> => {
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
    storageKeyPrefix: "removal-impact",
  }).then((result) => result.itemId);
}

/** A draft through the production draft writer, with no Message-ID and so no `mail_message_meta` row, as an unsent draft has. */
async function createDraft(client: PoolClient, draftsFolder: string, attachments: string[] = []): Promise<string> {
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
      storageKeyPrefix: "removal-impact",
    });
  }
  return draft.id;
}

/** Soft-deletes one item through the choke point, after its fixture committed, and fails if nothing was deleted. */
async function softDelete(databaseId: string, itemId: string): Promise<void> {
  const deleted = await runInTenant(tenant, () => chokePoint.softDeleteItem(databaseId, itemId));
  if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
}

function impactOf(mailboxId: string): Promise<MailboxRemovalImpact | null> {
  return inTenant((client) => getMailboxRemovalImpact(client, mailboxId));
}

async function threadOf(itemId: string): Promise<string | null> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
      [itemId],
    );
    return rows[0]?.thread_id ?? null;
  });
}

describe("getMailboxRemovalImpact (gh-1501)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
    ids = await inTenant((client) => loadIds(client));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("counts the non-deleted messages, drafts and attachments, and nothing of another mailbox", async () => {
    const { mailbox, deletedMessage, deletedDraft } = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      const other = await createMailbox(client, "Private");
      await ingest(client, {
        mailboxId: mailbox.id,
        folder: mailbox.inbox,
        messageId: "<m1@x>",
        attachments: ["a.pdf", "b.pdf"],
      });
      const m2 = "<m2@x>";
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: m2, attachments: ["c.pdf"] });
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.archive, messageId: m2 });
      const deletedMessage = await ingest(client, {
        mailboxId: mailbox.id,
        folder: mailbox.inbox,
        messageId: "<m3@x>",
        attachments: ["d.pdf"],
      });
      await createDraft(client, mailbox.drafts, ["e.pdf"]);
      const deletedDraft = await createDraft(client, mailbox.drafts, ["f.pdf"]);
      await ingest(client, {
        mailboxId: other.id,
        folder: other.inbox,
        messageId: "<n1@x>",
        attachments: ["g.pdf"],
      });
      return { mailbox, deletedMessage, deletedDraft };
    });
    await softDelete(ids.emails, deletedMessage);
    await softDelete(ids.emails, deletedDraft);

    // Messages m1 and m2 (m2 once, in two folders), the one live draft, and the attachments of those
    // three (a.pdf, b.pdf, c.pdf, e.pdf). m1 and m2 each form a thread; the draft has none.
    expect(await impactOf(mailbox.id)).toEqual({ messages: 2, drafts: 1, threads: 2, attachmentsKept: 4 });
  });

  it("counts an email in two folders of the mailbox once, and an email in its Drafts folder as a draft only", async () => {
    const mailbox = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      const inTwoFolders = "<both@x>";
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: inTwoFolders });
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.archive, messageId: inTwoFolders });
      const draftAndInbox = "<draft-and-inbox@x>";
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: draftAndInbox });
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.drafts, messageId: draftAndInbox });
      return mailbox;
    });

    expect(await impactOf(mailbox.id)).toEqual({ messages: 1, drafts: 1, threads: 2, attachmentsKept: 0 });
  });

  it("does not count a thread that also holds a message of another mailbox", async () => {
    const { mailbox, other, root, child } = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      const other = await createMailbox(client, "Private");
      const root = await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<root@x>" });
      const child = await ingest(client, {
        mailboxId: other.id,
        folder: other.inbox,
        messageId: "<child@x>",
        references: ["<root@x>"],
      });
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<solo@x>" });
      return { mailbox, other, root, child };
    });
    // The precondition of this test: the other mailbox's reply joined the thread of this mailbox's root.
    const sharedThread = await threadOf(root);
    expect(sharedThread).not.toBeNull();
    expect(await threadOf(child)).toBe(sharedThread);

    // The shared thread is not counted; the solo message's own thread is.
    expect(await impactOf(mailbox.id)).toEqual({ messages: 2, drafts: 0, threads: 1, attachmentsKept: 0 });
    expect(await impactOf(other.id)).toEqual({ messages: 1, drafts: 0, threads: 0, attachmentsKept: 0 });
  });

  it("counts a thread whose other-mailbox message is soft-deleted, because only live messages decide", async () => {
    const { mailbox, child } = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      const other = await createMailbox(client, "Private");
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<root@x>" });
      const child = await ingest(client, {
        mailboxId: other.id,
        folder: other.inbox,
        messageId: "<child@x>",
        references: ["<root@x>"],
      });
      return { mailbox, child };
    });
    await softDelete(ids.emails, child);

    expect(await impactOf(mailbox.id)).toEqual({ messages: 1, drafts: 0, threads: 1, attachmentsKept: 0 });
  });

  it("does not count a message that sits only in a soft-deleted folder of the mailbox", async () => {
    const mailbox = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.archive, messageId: "<archived@x>" });
      await ingest(client, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<inbox@x>" });
      return mailbox;
    });
    await softDelete(ids.folders, mailbox.archive);

    expect(await impactOf(mailbox.id)).toEqual({ messages: 1, drafts: 0, threads: 1, attachmentsKept: 0 });
  });

  it("answers null for an unknown mailbox and for a soft-deleted one", async () => {
    const mailbox = await inTenant((client) => createMailbox(client, "Work"));

    expect(await impactOf(randomUUID())).toBeNull();
    await softDelete(ids.mailboxes, mailbox.id);
    expect(await impactOf(mailbox.id)).toBeNull();
  });

  it("answers null in a tenant with no Mailboxes database, without resolving the other mail databases", async () => {
    const unprovisioned = await createTestTenant(admin);

    expect(await inTenant((client) => getMailboxRemovalImpact(client, randomUUID()), unprovisioned)).toBeNull();
    const handler = createMailboxRemovalImpactRouteHandler(runtime);
    await expect(runInTenant(unprovisioned, () => handler({ params: { id: randomUUID() } }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("answers null for another tenant's mailbox, and that tenant's scope does not see its row", async () => {
    const mailbox = await inTenant((client) => createMailbox(client, "Work"));
    const other = await createTestTenant(admin);
    await provisionTenant(runtime, other);

    const seen = await inTenant(async (client) => {
      const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE id = $1", [
        mailbox.id,
      ]);
      return { impact: await getMailboxRemovalImpact(client, mailbox.id), visible: rows[0]?.n };
    }, other);
    expect(seen).toEqual({ impact: null, visible: 0 });
    expect(await impactOf(mailbox.id)).not.toBeNull();
  });

  it("answers the counts with 200, and answers a malformed id and an unknown id with the same 404", async () => {
    const mailbox = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, "Work");
      await ingest(client, {
        mailboxId: mailbox.id,
        folder: mailbox.inbox,
        messageId: "<one@x>",
        attachments: ["h.pdf"],
      });
      return mailbox;
    });
    const handler = createMailboxRemovalImpactRouteHandler(runtime);

    const answer = await runInTenant(tenant, () => handler({ params: { id: mailbox.id } }));
    expect(answer).toEqual({ status: 200, body: { messages: 1, drafts: 0, threads: 1, attachmentsKept: 1 } });
    for (const id of [randomUUID(), "not-a-uuid"]) {
      await expect(runInTenant(tenant, () => handler({ params: { id } }))).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
