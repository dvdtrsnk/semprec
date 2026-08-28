import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, createRelationWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { runOnce } from "@semprec/queue";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import {
  createLinkEmailToPeopleAction,
  createPersonEmailReindexAction,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
} from "../mail/personLinkingActions.js";
import { lookupPersonIdByEmail, reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { resolveThreadId } from "../mail/threading.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import type { ClassifiedAttachment } from "../mail/attachments.js";
import { sanitizeMailHtml } from "../mail/htmlSanitize.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import { storeCredential, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { reconcileImapAccount, type ImapFetchedMessage, type ImapMailClient } from "../mail/imapReconcile.js";
import { handleSyncMailAccountTask, type MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { ensureMailAccountSyncState, getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { walkBodyStructure } from "../mail/imapFlowClient.js";
import type { MessageStructureObject } from "imapflow";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

const noopStorage: BlobStorageWriter = {
  async writeStream(_key, source) {
    let byteSize = 0;
    const hash = createHash("sha256");
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      byteSize += (chunk as Buffer).length;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
};

function mailRegistry() {
  const registry = createActionRegistry();
  registry.set(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, createPersonEmailReindexAction(pool));
  registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, createLinkEmailToPeopleAction(pool));
  return registry;
}

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, mailRegistry()) });
}

describe("email module seed (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("seeds Mailboxes/Folders/Emails with the expected owner:'system' schema", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const foldersId = await databaseIdFor("folders");
    const emailsId = await databaseIdFor("emails");

    const mailboxProps = await chokePoint.listProperties(mailboxesId);
    expect(mailboxProps.map((p) => p.key).sort()).toEqual(["addresses", "folders", "name", "provider", "syncStatus"]);
    expect(mailboxProps.find((p) => p.key === "syncStatus")).toMatchObject({ owner: "system", type: "select" });

    const folderProps = await chokePoint.listProperties(foldersId);
    expect(folderProps.map((p) => p.key).sort()).toEqual(["behavior", "emails", "mailbox", "name", "providerId", "specialPurpose"]);

    const emailProps = await chokePoint.listProperties(emailsId);
    expect(emailProps.map((p) => p.key).sort()).toEqual([
      "attachments",
      "body",
      "date",
      "folder",
      "name",
      "recipients",
      "recipientsPeople",
      "sender",
      "senderPeople",
    ]);
    expect(emailProps.find((p) => p.key === "sender")).toMatchObject({ owner: "system" });
  });

  it("adds People.emails as a new, user-owned property on the already schema-locked People database", async () => {
    const peopleId = await databaseIdFor("people");
    const props = await chokePoint.listProperties(peopleId);
    expect(props.find((p) => p.key === "emails")).toMatchObject({ owner: "user", type: "longText" });
  });

  it("rejects a direct write to an owner:'system' Emails property through the generic create path", async () => {
    const emailsId = await databaseIdFor("emails");
    await expect(chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi", sender: "x@example.com" } })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });
});

describe("person <-> email address linking (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("reindexes person_email_index from People.emails and rejects a second person claiming the same address", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice", emails: "alice@example.com\nalice.w@example.com" } });
    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, ["alice@example.com", "alice.w@example.com"]));

    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "ALICE@Example.com "))).toBe(alice.id);

    const bob = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Bob" } });
    const result = await withTransaction(pool, (client) => reindexPersonEmails(client, bob.id, ["alice@example.com"]));
    expect(result.conflicts).toEqual(["alice@example.com"]);
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBe(alice.id);
  });

  it("releases an address a person no longer claims", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice" } });
    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, ["alice@example.com"]));
    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, []));
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBeNull();
  });

  it("end to end: creating a Person with an address, then ingesting a message from it, links senderPeople/recipientsPeople", async () => {
    const peopleId = await databaseIdFor("people");
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice", emails: "alice@example.com" } });
    await drainQueue(); // onItemEvent 'create' on People -> reindex action

    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const mailboxFolderProperty = (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!;

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "Test", provider: "generic" } }),
    );
    const inbox = await withTransaction(pool, async (client) => {
      const folder = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(client, { relationPropertyId: mailboxFolderProperty.id, itemId: folder.id, targetItemId: mailbox.id });
      return folder;
    });

    const ingestResult = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: inbox.id,
        messageId: "<msg1@example.com>",
        subject: "Hello",
        envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi",
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    await drainQueue(); // onItemEvent 'create' on Emails -> link action

    const email = await chokePoint.getItem(emailsId, ingestResult.itemId);
    expect(email?.properties.name).toBe("Hello");

    const senderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "senderPeople")!;
    const { rows } = await pool.query(`SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`, [
      senderProperty.id,
    ]);
    expect(rows.some((r) => r.item_a === alice.id || r.item_b === alice.id)).toBe(true);
  });
});

describe("conversation threading (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("gives an unrelated message its own thread", async () => {
    const threadId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<a@x>" }));
    expect(threadId).toBeTruthy();
  });

  it("threads a reply onto its parent's thread", async () => {
    const parentThreadId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<parent@x>" }));
    await pool.query(`INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<parent@x>', $1, '{}')`, [
      parentThreadId,
    ]);

    const replyThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<reply@x>", inReplyTo: "<parent@x>", references: ["<parent@x>"] }),
    );
    expect(replyThreadId).toBe(parentThreadId);
  });

  it("self-heals: a message arriving after its reply joins the reply's thread instead of staying separate", async () => {
    const replyThreadId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<reply@x>", inReplyTo: "<late-parent@x>" }));
    await pool.query(
      `INSERT INTO mail_message_meta (item_id, message_id, in_reply_to, thread_id, envelope) VALUES (gen_random_uuid(), '<reply@x>', '<late-parent@x>', $1, '{}')`,
      [replyThreadId],
    );

    const parentThreadId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<late-parent@x>" }));
    expect(parentThreadId).toBe(replyThreadId);
  });
});

describe("message ingest dedup (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("a repeat ingest of the same Message-ID converges onto the same item instead of duplicating", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    const input = {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: folderProperty.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      folderItemId: folder.id,
      messageId: "<dup@x>",
      envelope: {},
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    const first = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    const second = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.itemId).toBe(first.itemId);

    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId]);
    expect(Number(rows[0].count)).toBe(1);
  });
});

describe("attachment ingest (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function attachment(filename: string, bytes: Buffer): ClassifiedAttachment {
    return {
      filename,
      contentType: "application/pdf",
      contentId: null,
      disposition: "attachment",
      openStream: () => Readable.from(bytes),
    };
  }

  it("streams each attachment to storage, creates a Files item, and dedups identical content by hash", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    const sameBytes = Buffer.from("invoice-bytes");
    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<with-attachments@x>",
        envelope: {},
        attachments: [attachment("invoice.pdf", sameBytes), attachment("invoice-copy.pdf", sameBytes)],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const { rows: attachmentRows } = await pool.query(`SELECT filename, blob_id, byte_size FROM mail_attachments WHERE message_item_id = $1`, [result.itemId]);
    expect(attachmentRows).toHaveLength(2);
    expect(new Set(attachmentRows.map((r) => r.blob_id)).size).toBe(1); // same content hash -> one blob
    expect(attachmentRows.every((r) => Number(r.byte_size) === sameBytes.length)).toBe(true);

    const { rows: fileItemRows } = await pool.query(`SELECT properties->>'name' AS name FROM items WHERE database_id = $1 ORDER BY 1`, [filesId]);
    expect(fileItemRows.map((r) => r.name)).toEqual(["invoice-copy.pdf", "invoice.pdf"]);

    const { rows: relationRows } = await pool.query(
      `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`,
      [attachmentsProperty.id],
    );
    expect(Number(relationRows[0].count)).toBe(2);
  });
});

describe("IMAP BODYSTRUCTURE walking (issue #26)", () => {
  it("finds the text/html body leaf and both non-text leaves as attachment candidates, through nested multipart/related > multipart/mixed", () => {
    const tree: MessageStructureObject = {
      type: "multipart/related",
      childNodes: [
        {
          type: "multipart/mixed",
          childNodes: [
            { part: "1.1", type: "text/html" },
            { part: "1.2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "invoice.pdf" } },
          ],
        },
        { part: "2", type: "image/png", disposition: "inline", id: "<logo123>", dispositionParameters: { filename: "logo.png" } },
      ],
    };

    const result = walkBodyStructure(tree);
    expect(result.textHtmlPart?.part).toBe("1.1");
    expect(result.textPlainPart).toBeUndefined();
    expect(result.attachmentParts.map((p) => p.dispositionParameters?.filename)).toEqual(["invoice.pdf", "logo.png"]);
  });

  it("treats a single-part (no childNodes) text message as its own body leaf, never as an attachment candidate", () => {
    const tree: MessageStructureObject = { part: "1", type: "text/plain" };
    const result = walkBodyStructure(tree);
    expect(result.textPlainPart?.type).toBe("text/plain");
    expect(result.attachmentParts).toHaveLength(0);
  });

  it("picks both alternative text/plain and text/html leaves, wherever nested", () => {
    const tree: MessageStructureObject = {
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/plain" },
        { part: "2", type: "text/html" },
      ],
    };
    const result = walkBodyStructure(tree);
    expect(result.textPlainPart?.part).toBe("1");
    expect(result.textHtmlPart?.part).toBe("2");
  });
});

describe("HTML sanitization (issue #26)", () => {
  it("strips script tags and event handlers", () => {
    const sanitized = sanitizeMailHtml('<p onclick="steal()">hi</p><script>evil()</script>');
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain("hi");
  });

  it("strips remote images by default but keeps inline cid: images", () => {
    const sanitized = sanitizeMailHtml('<img src="https://tracker.example/pixel.gif"><img src="cid:logo">');
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).toContain("cid:logo");
  });

  it("allows remote images when explicitly requested", () => {
    const sanitized = sanitizeMailHtml('<img src="https://example.com/photo.jpg">', { allowRemoteImages: true });
    expect(sanitized).toContain("https://example.com/photo.jpg");
  });

  it("strips a CSS background-image url from an inline style attribute (a tracking pixel by another door)", () => {
    const sanitized = sanitizeMailHtml('<div style="background-image:url(https://tracker.example/pixel.gif); color: red">hi</div>');
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("url(");
    expect(sanitized).toContain("color:red");
  });

  it("strips a <style> block wholesale, including any url() it carries", () => {
    const sanitized = sanitizeMailHtml("<style>body { background: url(https://tracker.example/pixel.gif); }</style><p>hi</p>");
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).toContain("hi");
  });
});

describe("full-text search over Emails (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("indexes and finds a message by content", async () => {
    const emailsId = await databaseIdFor("emails");
    const itemId = randomUUID();
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId, databaseId: emailsId, text: "Invoice for consulting services" }));

    const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "invoice" }));
    expect(results.map((r) => r.itemId)).toContain(itemId);

    const noResults = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "nonexistentword" }));
    expect(noResults.map((r) => r.itemId)).not.toContain(itemId);
  });
});

describe("credentials (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("round-trips a stored secret and logs every decryption", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );

    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));
    const decrypted = await withTransaction(pool, (client) =>
      getDecryptedCredential(client, { itemId: mailbox.id, actorType: "sync_worker", purpose: "imap_sync" }),
    );
    expect(decrypted).toBe("s3cr3t");

    const { rows } = await pool.query(`SELECT actor_type, purpose FROM credential_access_log WHERE item_id = $1`, [mailbox.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "sync_worker", purpose: "imap_sync" });
  });

  it("returns null and logs nothing when no credential is stored", async () => {
    const missingItemId = randomUUID();
    const decrypted = await withTransaction(pool, (client) =>
      getDecryptedCredential(client, { itemId: missingItemId, actorType: "sync_worker", purpose: "imap_sync" }),
    );
    expect(decrypted).toBeNull();
    const { rows } = await pool.query(`SELECT 1 FROM credential_access_log WHERE item_id = $1`, [missingItemId]);
    expect(rows).toHaveLength(0);
  });
});

describe("IMAP reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });


  function fakeImapClient(overrides: Partial<ImapMailClient> = {}): ImapMailClient {
    return {
      getCapabilities: async () => new Set(["CONDSTORE", "QRESYNC"]),
      listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
      selectFolder: async () => ({ uidvalidity: 111, uidnext: 3, highestModSeq: 5 }),
      fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
        {
          uid: 1,
          message: { messageId: "<one@x>", envelope: { from: { address: "a@x.com" } }, subject: "First", attachments: [] },
        },
        {
          uid: 2,
          message: { messageId: "<two@x>", envelope: { from: { address: "b@x.com" } }, subject: "Second", attachments: [] },
        },
      ],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [1, 2],
      ...overrides,
    };
  }

  it("initial sync ingests every fetched message and creates the INBOX folder", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );

    await withTransaction(pool, (client) =>
      reconcileImapAccount(client, fakeImapClient(), {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
        mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
        attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const { rows: folderRows } = await pool.query(`SELECT properties FROM items WHERE database_id = $1`, [foldersId]);
    expect(folderRows).toHaveLength(1);
    expect(folderRows[0].properties.specialPurpose).toBe("inbox");

    const { rows: emailRows } = await pool.query(`SELECT properties FROM items WHERE database_id = $1 ORDER BY properties->>'name'`, [emailsId]);
    expect(emailRows.map((r) => r.properties.name)).toEqual(["First", "Second"]);
  });

  it("a UIDVALIDITY change resets folder sync state and forces a full re-fetch", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    const params = {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await withTransaction(pool, (client) => reconcileImapAccount(client, fakeImapClient(), params));

    let fetchCallCount = 0;
    const secondClient = fakeImapClient({
      selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1 }),
      fetchMessagesSince: async (_path, sinceUid) => {
        fetchCallCount++;
        expect(sinceUid).toBe(1); // reset back to the start, not resumed from the old uidnext
        return [];
      },
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, secondClient, params));
    expect(fetchCallCount).toBe(1);

    const { rows } = await pool.query(`SELECT uidvalidity FROM mail_folder_sync_state`);
    expect(rows[0].uidvalidity).toBe("999");
  });

  it("removes the folder edge for a vanished UID", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    const params = {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await withTransaction(pool, (client) => reconcileImapAccount(client, fakeImapClient(), params));
    expect((await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId])).rows[0].count).toBe("2");

    const client2 = fakeImapClient({
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [1],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, client2, params));

    const { rows } = await pool.query(
      `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`,
      [emailProps.find((p) => p.key === "folder")!.id],
    );
    expect(Number(rows[0].count)).toBe(1); // one of the two original edges was removed
  });
});

describe("mail sync job error handling (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("persists last_error and pushes out next_expected_activity_at when a sync pass throws, surviving the aborted transaction's rollback", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const failingImap: ImapMailClient = {
      getCapabilities: async () => new Set(),
      listFolders: async () => {
        throw new Error("connection refused");
      },
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
    };

    const adapters: MailSyncAdapterFactory = { createImapClient: async () => failingImap };

    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        adapters,
        { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
        noopStorage,
      ),
    ).rejects.toThrow("connection refused");

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state?.lastError).toBe("connection refused");
    expect(state?.nextExpectedActivityAt).toBeTruthy();
    expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now());

    // The credential access attempt itself is still logged, even though the sync that used it failed later.
    const { rows } = await pool.query(`SELECT purpose FROM credential_access_log WHERE item_id = $1`, [mailbox.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("imap_sync");

    // The user-visible Mailbox.syncStatus (distinct from the internal mail_account_sync_state
    // bookkeeping above) also reflects the failure — this is what the mailbox UI would show.
    const item = await withTransaction(pool, (client) => client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]));
    expect(item.rows[0].properties.syncStatus).toBe("error");
  });

  it("sets Mailbox.syncStatus to 'ok' after a completed sync pass", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const emptyImap: ImapMailClient = {
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
    };
    const adapters: MailSyncAdapterFactory = { createImapClient: async () => emptyImap };

    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      adapters,
      { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
      noopStorage,
    );

    const item = await withTransaction(pool, (client) => client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]));
    expect(item.rows[0].properties.syncStatus).toBe("ok");
  });

  it("sets Mailbox.syncStatus to 'needsReauthorization' when the adapter reports a revoked credential", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailReauthorizationRequiredError("refresh token revoked");
      },
    };

    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        adapters,
        { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
        noopStorage,
      ),
    ).rejects.toThrow("refresh token revoked");

    const item = await withTransaction(pool, (client) => client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]));
    expect(item.rows[0].properties.syncStatus).toBe("needsReauthorization");
  });
});

afterAll(async () => {
  await pool?.end();
});
