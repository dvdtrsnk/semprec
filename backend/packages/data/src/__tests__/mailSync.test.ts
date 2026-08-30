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
import { getMailMessageMetaByItemId } from "../mail/mailMessageMetaStore.js";
import { resolveDeliveredToAddress } from "../mail/deliveredTo.js";
import { isDeliveryStatusReport, parseContentTypeHeader } from "../mail/dsn.js";
import {
  enqueueMailLegacyEmailMigration,
  mailLegacyEmailMigrationJobKey,
  runMailLegacyEmailMigrationJob,
  type LegacyRawMimeFetcher,
} from "../migrationJob/mailLegacyEmailMigration.js";
import type { ClassifiedAttachment } from "../mail/attachments.js";
import { sanitizeMailHtml } from "../mail/htmlSanitize.js";
import { parseMailSearchQuery, reindexItemSearch, searchItems } from "../mail/search.js";
import { storeCredential, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { reconcileImapAccount, type ImapFetchedMessage, type ImapMailClient } from "../mail/imapReconcile.js";
import { reconcileGmailAccount, type GmailMailClient } from "../mail/gmailReconcile.js";
import { reconcileGraphAccount, type GraphMailClient } from "../mail/graphReconcile.js";
import { handleMailSearchReindexSweepTask, handleSyncMailAccountTask, type MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { ensureMailAccountSyncState, getMailAccountSyncState, defaultSyncModeForProvider } from "../mail/mailAccountSyncStateStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { MailConnectionLimitError, MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { walkBodyStructure, parseHeaderBlock, headerValues, ImapFlowMailClient, isImapConnectionLimitError } from "../mail/imapFlowClient.js";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import type { ImapFlow } from "imapflow";
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

/** A minimal, structurally valid one-page PDF containing exactly `text`, with a correct xref table (real byte offsets) so pdf-parse/pdfjs-dist parses it via its normal path. */
function buildMinimalPdf(text: string): Buffer {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  objects[5] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
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
    expect(mailboxProps.map((p) => p.key).sort()).toEqual(["addresses", "connectionLimit", "folders", "name", "provider", "syncStatus"]);
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

  it("merging two threads deletes the losing thread's now-empty mail_threads row", async () => {
    const threadAId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<a1@x>" }));
    await pool.query(`INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<a1@x>', $1, '{}')`, [threadAId]);

    const threadBId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<b1@x>" }));
    await pool.query(`INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<b1@x>', $1, '{}')`, [threadBId]);

    const { rows: before } = await pool.query(`SELECT count(*) FROM mail_threads WHERE id = ANY($1::uuid[])`, [[threadAId, threadBId]]);
    expect(before[0].count).toBe("2");

    // Bridges the two previously-separate threads: both are found as ancestors, so this
    // resolves to a merge instead of a fresh thread.
    const mergedThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<bridge@x>", references: ["<a1@x>", "<b1@x>"] }),
    );
    expect([threadAId, threadBId]).toContain(mergedThreadId);

    const { rows: after } = await pool.query(`SELECT count(*) FROM mail_threads WHERE id = ANY($1::uuid[])`, [[threadAId, threadBId]]);
    expect(after[0].count).toBe("1"); // the losing thread's row is gone, not just unreferenced
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

  it("extracts PDF attachment text at ingest and folds it into the message's own search index", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    // A minimal but structurally valid one-page PDF, with a correct xref table (real byte
    // offsets, not placeholders) — pdf-parse (pdfjs-dist under the hood) needs that to parse
    // via its normal path rather than falling back to a lossy recovery heuristic that
    // (verified while writing this test) can silently truncate the extracted text.
    const minimalPdf = buildMinimalPdf("UniqueInvoiceKeyword");

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<with-pdf@x>",
        subject: "Has a PDF",
        envelope: {},
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from(minimalPdf),
          },
        ],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const found = await searchItems(pool, { databaseId: emailsId, query: "UniqueInvoiceKeyword" });
    expect(found.map((f) => f.itemId)).toContain(result.itemId);
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

  it("rejects a url() smuggled inside an otherwise-allowed color: rgb(...) value", () => {
    const sanitized = sanitizeMailHtml('<div style="color: rgb(0,0,0) url(https://tracker.example/pixel.gif)">hi</div>');
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("url(");
  });

  it("still allows a plain rgb() color value", () => {
    const sanitized = sanitizeMailHtml('<div style="color: rgb(12, 34, 56)">hi</div>');
    expect(sanitized).toContain("rgb(12, 34, 56)");
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
    chokePoint ??= createChokePoint(pool);
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

  it("ranks a more recently indexed match above an older one with identical text relevance", async () => {
    const emailsId = await databaseIdFor("emails");
    const olderId = randomUUID();
    const newerId = randomUUID();
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId: olderId, databaseId: emailsId, text: "quarterly report" }));
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId: newerId, databaseId: emailsId, text: "quarterly report" }));
    // Backdate the older row directly — both reindexItemSearch calls above ran within the same
    // instant, so without this the recency blend would have nothing to actually distinguish.
    await pool.query(`UPDATE item_search_index SET updated_at = now() - interval '90 days' WHERE item_id = $1`, [olderId]);

    const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "quarterly report" }));
    const olderIndex = results.findIndex((r) => r.itemId === olderId);
    const newerIndex = results.findIndex((r) => r.itemId === newerId);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  describe("Gmail-style search operators", () => {
    it("parseMailSearchQuery splits operators from free text", () => {
      expect(parseMailSearchQuery("invoice from:alice@x.com has:attachment before:2026-01-01 after:2025-01-01")).toEqual({
        freeText: "invoice",
        from: "alice@x.com",
        hasAttachment: true,
        before: "2026-01-01",
        after: "2025-01-01",
      });
      expect(parseMailSearchQuery("just some words")).toEqual({ freeText: "just some words" });
    });

    it("from: filters by the sender display text", async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
      );

      const fromAlice = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          messageId: "<alice@x>",
          subject: "Report",
          envelope: { from: { address: "alice@x.com" } },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );
      await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          messageId: "<bob@x>",
          subject: "Report",
          envelope: { from: { address: "bob@x.com" } },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const results = await searchItems(pool, { databaseId: emailsId, query: "report from:alice@x.com" });
      expect(results.map((r) => r.itemId)).toEqual([fromAlice.itemId]);
    });
  });
});

describe("periodic search reindex sweep (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("indexes an Emails item that was written outside ingestEmailMessage's own standard path", async () => {
    const emailsId = await databaseIdFor("emails");
    // Direct choke-point item creation, bypassing ingestEmailMessage/reindexItemSearch entirely
    // — the exact "migration/backfill wrote outside the standard path" scenario the sweep
    // exists for.
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: emailsId, properties: { name: "Backfilled subject", body: "UnindexedBackfillKeyword" } },
        { allowedSystemKeys: ["name", "body"] },
      ),
    );

    const beforeSweep = await searchItems(pool, { databaseId: emailsId, query: "UnindexedBackfillKeyword" });
    expect(beforeSweep.map((r) => r.itemId)).not.toContain(item.id);

    await handleMailSearchReindexSweepTask(pool, emailsId);

    const afterSweep = await searchItems(pool, { databaseId: emailsId, query: "UnindexedBackfillKeyword" });
    expect(afterSweep.map((r) => r.itemId)).toContain(item.id);
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

describe("sync_mode defaulting by provider (issue #26)", () => {
  it("maps each Mailbox.provider value to its documented default sync_mode", () => {
    expect(defaultSyncModeForProvider("gmail")).toBe("gmail_api");
    expect(defaultSyncModeForProvider("outlook")).toBe("graph_api");
    expect(defaultSyncModeForProvider("icloud")).toBe("imap");
    expect(defaultSyncModeForProvider("generic")).toBe("imap");
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
      markSeen: async () => {},
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

  it("re-observing the same message under a new UID after a UIDVALIDITY reset updates its edge in place, never adds a second one", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    const params = {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    const firstPassImap = fakeImapClient({
      fetchMessagesSince: async () => [{ uid: 5, message: { messageId: "<survivor@x>", envelope: { from: { address: "a@x.com" } }, subject: "Survivor", attachments: [] } }],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, firstPassImap, params));

    const secondPassImap = fakeImapClient({
      selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1 }),
      // Server rebuilt the folder (UIDVALIDITY changed) — the same message now has UID 1, not 5.
      fetchMessagesSince: async () => [{ uid: 1, message: { messageId: "<survivor@x>", envelope: { from: { address: "a@x.com" } }, subject: "Survivor", attachments: [] } }],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, secondPassImap, params));

    const { rows: emailRows } = await pool.query(`SELECT id FROM items WHERE database_id = $1`, [emailsId]);
    expect(emailRows).toHaveLength(1); // still one Emails item, not a duplicate

    const { rows: edgeRows } = await pool.query(
      `SELECT metadata FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
      [folderRelationPropertyId, emailRows[0].id],
    );
    expect(edgeRows).toHaveLength(1); // one edge, updated in place — not a second, stale-generation edge
    expect(edgeRows[0].metadata).toEqual({ uid: 1 }); // carries the new UID, not the pre-reset one
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

  it("Gmail in IMAP fallback mode: derives label-folder membership from X-GM-LABELS alongside the physical All Mail edge", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
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
      folderPaths: ["[Gmail]/All Mail"],
    };

    const gmailImap = fakeImapClient({
      listFolders: async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
        {
          uid: 1,
          message: {
            messageId: "<labeled@x>",
            envelope: { from: { address: "a@x.com" } },
            subject: "Labeled",
            attachments: [],
            gmailLabels: ["\\Inbox", "Work"],
          },
        },
      ],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, gmailImap, params));

    const { rows: folderRows } = await pool.query(`SELECT properties FROM items WHERE database_id = $1 ORDER BY properties->>'providerId'`, [foldersId]);
    // All Mail (the physical folder synced) plus the two labels.
    expect(folderRows.map((r) => r.properties.providerId).sort()).toEqual(["Work", "[Gmail]/All Mail", "\\Inbox"]);
    expect(folderRows.find((r) => r.properties.providerId === "\\Inbox")).toMatchObject({ properties: { behavior: "label", specialPurpose: "inbox" } });
    expect(folderRows.find((r) => r.properties.providerId === "Work")).toMatchObject({ properties: { behavior: "label", specialPurpose: "none" } });

    const emailItemId = (await pool.query(`SELECT id FROM items WHERE database_id = $1`, [emailsId])).rows[0].id;
    const { rows: edgeCount } = await pool.query(
      `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
      [emailProps.find((p) => p.key === "folder")!.id, emailItemId],
    );
    expect(Number(edgeCount[0].count)).toBe(3); // All Mail + \Inbox + Work

    // A second pass re-observing the same message with one label dropped removes only that
    // label's edge, keeping the physical All Mail edge and the other label. The fake client's
    // fetchMessagesSince ignores the sinceUid it's called with (same as every other fake
    // client in this file) so it can simply re-report uid 1 with a narrowed label set.
    const gmailImapRelabeled = fakeImapClient({
      listFolders: async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
        {
          uid: 1,
          message: {
            messageId: "<labeled@x>",
            envelope: { from: { address: "a@x.com" } },
            subject: "Labeled",
            attachments: [],
            gmailLabels: ["Work"],
          },
        },
      ],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [1],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, gmailImapRelabeled, params));

    const { rows: edgeCountAfter } = await pool.query(
      `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
      [emailProps.find((p) => p.key === "folder")!.id, emailItemId],
    );
    expect(Number(edgeCountAfter[0].count)).toBe(2); // All Mail + Work; \Inbox's edge was dropped
  });
});

describe("Gmail reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function fakeGmailClient(overrides: Partial<GmailMailClient> = {}): GmailMailClient {
    return {
      getCurrentHistoryId: async () => "100",
      listHistorySince: async () => ({ invalidated: false, newHistoryId: "101", changedMessageIds: [], removedMessageIds: [] }),
      listAllMessageIds: async () => ["m1"],
      fetchMessage: async (id) => ({
        id,
        threadId: "t1",
        labelIds: ["INBOX"],
        message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, subject: "Hi", attachments: [] },
      }),
      listLabels: async () => [{ id: "INBOX", name: "INBOX", type: "system" }],
      ...overrides,
    };
  }

  async function reconcileParams() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    return {
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
  }

  it("initial sync (no stored historyId) does a full listAllMessageIds pass and stores the returned historyId", async () => {
    const params = await reconcileParams();
    await withTransaction(pool, (client) => reconcileGmailAccount(client, fakeGmailClient(), params));

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.gmailHistoryId).toBe("100");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("1");
  });

  it("a history.list 404 (invalidated) clears the stored historyId and forces a full resync instead of resuming", async () => {
    const params = await reconcileParams();
    await withTransaction(pool, (client) => reconcileGmailAccount(client, fakeGmailClient(), params));

    let fullResyncCallCount = 0;
    const secondClient = fakeGmailClient({
      listHistorySince: async () => ({ invalidated: true, newHistoryId: "100", changedMessageIds: [], removedMessageIds: [] }),
      listAllMessageIds: async () => {
        fullResyncCallCount++;
        return ["m2"];
      },
      getCurrentHistoryId: async () => "200",
      fetchMessage: async (id) => ({
        id,
        threadId: "t2",
        labelIds: ["INBOX"],
        message: { messageId: `<${id}@x>`, envelope: { from: { address: "b@x.com" } }, subject: "Second", attachments: [] },
      }),
    });
    await withTransaction(pool, (client) => reconcileGmailAccount(client, secondClient, params));

    expect(fullResyncCallCount).toBe(1);
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.gmailHistoryId).toBe("200");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("2"); // the first sync's message plus the resync's new one
  });
});

describe("Graph reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function fakeGraphClient(overrides: Partial<GraphMailClient> = {}): GraphMailClient {
    return {
      listFolders: async () => [{ id: "f1", displayName: "Inbox", wellKnownName: "inbox" }],
      fetchDelta: async () => ({
        invalidated: false,
        newDeltaLink: "link-1",
        changes: [
          {
            id: "m1",
            parentFolderId: "f1",
            removed: false,
            message: { messageId: "<m1@x>", envelope: { from: { address: "a@x.com" } }, subject: "Hi", attachments: [] },
          },
        ],
      }),
      ...overrides,
    };
  }

  async function reconcileParams() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    return {
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
  }

  it("ingests a delta change into its parent folder and stores the returned deltaLink", async () => {
    const params = await reconcileParams();
    await withTransaction(pool, (client) => reconcileGraphAccount(client, fakeGraphClient(), params));

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.graphDeltaLink).toBe("link-1");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("1");
  });

  it("a deltaLink 410 Gone (invalidated) clears the stored deltaLink and runs a full resync (fetchDelta(null)) instead of resuming", async () => {
    const params = await reconcileParams();
    await withTransaction(pool, (client) => reconcileGraphAccount(client, fakeGraphClient(), params));

    const deltaLinksSeen: (string | null)[] = [];
    const secondClient = fakeGraphClient({
      fetchDelta: async (deltaLink) => {
        deltaLinksSeen.push(deltaLink);
        if (deltaLink !== null) {
          return { invalidated: true, newDeltaLink: "", changes: [] };
        }
        return {
          invalidated: false,
          newDeltaLink: "link-2",
          changes: [
            {
              id: "m2",
              parentFolderId: "f1",
              removed: false,
              message: { messageId: "<m2@x>", envelope: { from: { address: "b@x.com" } }, subject: "Second", attachments: [] },
            },
          ],
        };
      },
    });
    await withTransaction(pool, (client) => reconcileGraphAccount(client, secondClient, params));

    expect(deltaLinksSeen).toEqual(["link-1", null]); // resumed from the stored link, got invalidated, retried from scratch
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.graphDeltaLink).toBe("link-2");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("2");
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
      markSeen: async () => {},
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

  it("cleans up an attachment already written to disk when a later step in the same pass aborts the transaction", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const writtenKeys: string[] = [];
    const deletedKeys: string[] = [];
    const trackingStorage: BlobStorageWriter = {
      async writeStream(storageKey, source) {
        writtenKeys.push(storageKey);
        let byteSize = 0;
        const hash = createHash("sha256");
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          byteSize += (chunk as Buffer).length;
        }
        return { byteSize, contentHash: hash.digest("hex") };
      },
      async delete(storageKey) {
        deletedKeys.push(storageKey);
      },
    };

    const moduleIds = { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId };

    // A brand-new folder's very first reconcile pass never even looks at
    // fetchVanishedSince/fetchAllUids (imapReconcile.ts: nothing to diff against yet) — a
    // first, uneventful pass establishes real uidvalidity/uidnext state so the second pass
    // below actually reaches (and can fail inside) the vanished-UID check.
    const passOneImap: ImapMailClient = {
      getCapabilities: async () => new Set(),
      listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => null,
      fetchAllUids: async () => [],
      markSeen: async () => {},
    };
    await handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, { createImapClient: async () => passOneImap }, moduleIds, trackingStorage);

    const failingAfterAttachmentImap: ImapMailClient = {
      getCapabilities: async () => new Set(),
      listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
      fetchMessagesSince: async () => [
        {
          uid: 1,
          message: {
            messageId: "<orphan@x>",
            envelope: { from: { address: "a@x.com" } },
            subject: "Has attachment",
            attachments: [
              {
                filename: "f.txt",
                contentType: "text/plain",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(Buffer.from("orphan-bytes")),
              },
            ],
          },
        },
      ],
      // No QRESYNC (getCapabilities returns an empty set) and uidvalidity is already known
      // (set by passOneImap above) -> imapReconcile.ts's non-CONDSTORE fallback path, which
      // diffs via fetchAllUids.
      fetchVanishedSince: async () => null,
      fetchAllUids: async () => {
        throw new Error("boom after the attachment was already written");
      },
      markSeen: async () => {},
    };

    const adapters: MailSyncAdapterFactory = { createImapClient: async () => failingAfterAttachmentImap };

    await expect(handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, adapters, moduleIds, trackingStorage)).rejects.toThrow(
      "boom after the attachment was already written",
    );

    expect(writtenKeys).toHaveLength(1);
    expect(deletedKeys).toEqual(writtenKeys);
    // The transaction rolled back, so no Files item or Email item exists for it either.
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId]);
    expect(rows[0].count).toBe("0");
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
      markSeen: async () => {},
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

  it("sets Mailbox.syncStatus to 'error' when the credential itself can't be decrypted (a failure before any adapter/transaction runs)", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    // Deliberately no storeCredential call: handleSyncMailAccountTask's own "no stored
    // credential" throw fires before the reconcile transaction ever opens, exercising the same
    // code path a real decrypt failure would.

    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        {},
        { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
        noopStorage,
      ),
    ).rejects.toThrow("has no stored credential");

    const item = await withTransaction(pool, (client) => client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]));
    expect(item.rows[0].properties.syncStatus).toBe("error");
  });
});

describe("IMAP raw header parsing (issue #93)", () => {
  it("preserves every occurrence of a repeated header, in the message's own top-to-bottom order", () => {
    const buffer = Buffer.from(
      ["Delivered-To: newest@example.com", "Delivered-To: oldest@example.com", "X-Original-To: xo@example.com", "References: <a@x> <b@x>"].join(
        "\r\n",
      ) + "\r\n",
    );
    const headers = parseHeaderBlock(buffer);
    expect(headerValues(headers, "delivered-to")).toEqual(["newest@example.com", "oldest@example.com"]);
    expect(headerValues(headers, "x-original-to")).toEqual(["xo@example.com"]);
    // Header-name lookup is case-insensitive, matching RFC 5322.
    expect(headerValues(headers, "Delivered-To")).toEqual(["newest@example.com", "oldest@example.com"]);
  });

  it("unfolds a continuation line (leading whitespace) onto the previous header's value instead of starting a new one", () => {
    const buffer = Buffer.from(["Envelope-To: someone", "  @example.com", "Delivered-To: me@example.com"].join("\r\n") + "\r\n");
    const headers = parseHeaderBlock(buffer);
    expect(headerValues(headers, "envelope-to")).toEqual(["someone @example.com"]);
    expect(headerValues(headers, "delivered-to")).toEqual(["me@example.com"]);
  });

  it("returns nothing for an absent header or an undefined buffer", () => {
    expect(parseHeaderBlock(undefined)).toEqual([]);
    const headers = parseHeaderBlock(Buffer.from("Delivered-To: me@example.com\r\n"));
    expect(headerValues(headers, "x-original-to")).toEqual([]);
  });
});

describe("deliveredToAddress precedence (issue #93)", () => {
  it("prefers the highest (first) Delivered-To occurrence over everything else", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: ["newest@example.com", "oldest@example.com"], xOriginalTo: "xo@example.com", envelopeTo: "et@example.com" },
      structuredTo: [{ address: "to@example.com" }],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("newest@example.com");
  });

  it("extracts the bare address out of a 'Name <addr>' Delivered-To value", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: ["Alice Work <Alice@Example.com>"] },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: [],
    });
    expect(result).toBe("alice@example.com");
  });

  it("falls back to X-Original-To when there is no Delivered-To", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [], xOriginalTo: "xo@example.com", envelopeTo: "et@example.com" },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("xo@example.com");
  });

  it("falls back to Envelope-To when there is no Delivered-To or X-Original-To", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [], xOriginalTo: null, envelopeTo: "et@example.com" },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("et@example.com");
  });

  it("falls back to the first registered mailbox alias matching structured To/Cc", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [] },
      structuredTo: [{ address: "someone-else@example.com" }],
      structuredCc: [{ address: "Alias2@Example.com" }],
      mailboxAliases: ["alias1@example.com", "alias2@example.com"],
    });
    expect(result).toBe("alias2@example.com");
  });

  it("falls back to the mailbox's primary (first) address when no alias matches structured To/Cc", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [] },
      structuredTo: [{ address: "nobody-registered@example.com" }],
      structuredCc: [],
      mailboxAliases: ["primary@example.com", "secondary@example.com"],
    });
    expect(result).toBe("primary@example.com");
  });

  it("returns undefined when there are no header candidates and no registered aliases", () => {
    const result = resolveDeliveredToAddress({ candidates: { deliveredToHeaders: [] }, structuredTo: [], structuredCc: [], mailboxAliases: [] });
    expect(result).toBeUndefined();
  });
});

describe("deliveredToAddress persisted at ingest (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("persists deliveredToAddress computed from multiple Delivered-To occurrences, not recomputed later", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<dta1@example.com>",
        envelope: { from: { address: "sender@example.com" }, to: [{ address: "me@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        deliveredToHeaders: ["me+relay2@example.com", "me+relay1@example.com"],
        mailboxAliases: ["me@example.com"],
      }),
    );

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, result.itemId));
    expect(meta?.deliveredToAddress).toBe("me+relay2@example.com");
  });

  it("falls back through to the mailbox's registered alias when no delivery headers are present", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<dta2@example.com>",
        envelope: { from: { address: "sender@example.com" }, to: [{ address: "me@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        mailboxAliases: ["me@example.com"],
      }),
    );

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, result.itemId));
    expect(meta?.deliveredToAddress).toBe("me@example.com");
  });
});

describe("DSN/bounce detection (issue #93)", () => {
  it("isDeliveryStatusReport requires both multipart/report and report-type=delivery-status", () => {
    expect(isDeliveryStatusReport("multipart/report", { "report-type": "delivery-status" })).toBe(true);
    expect(isDeliveryStatusReport("multipart/report", { "Report-Type": "Delivery-Status" })).toBe(true);
    expect(isDeliveryStatusReport("multipart/report", { "report-type": "disposition-notification" })).toBe(false);
    expect(isDeliveryStatusReport("multipart/mixed", { "report-type": "delivery-status" })).toBe(false);
    expect(isDeliveryStatusReport(undefined, undefined)).toBe(false);
  });

  it("parseContentTypeHeader splits type and parameters out of a raw header value", () => {
    expect(parseContentTypeHeader('multipart/report; report-type="delivery-status"; boundary=abc')).toEqual({
      type: "multipart/report",
      params: { "report-type": "delivery-status", boundary: "abc" },
    });
    expect(parseContentTypeHeader(undefined)).toBeNull();
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("a DSN threads onto its outgoing message's thread and is tagged messageKind:'dsn', distinct from a human reply", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    const outgoing = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<outgoing@example.com>",
        subject: "Original",
        envelope: { from: { address: "me@example.com" }, to: [{ address: "someone@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );
    const outgoingMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, outgoing.itemId));

    const dsn = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<dsn1@mailer-daemon.example.com>",
        subject: "Undelivered Mail Returned to Sender",
        references: ["<outgoing@example.com>"],
        envelope: { from: { address: "mailer-daemon@example.com" }, to: [{ address: "me@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        isDsn: true,
      }),
    );

    const reply = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<reply1@example.com>",
        subject: "Re: Original",
        inReplyTo: "<outgoing@example.com>",
        references: ["<outgoing@example.com>"],
        envelope: { from: { address: "someone@example.com" }, to: [{ address: "me@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const dsnMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, dsn.itemId));
    const replyMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, reply.itemId));

    expect(dsnMeta?.messageKind).toBe("dsn");
    expect(dsnMeta?.dsnOriginalMessageId).toBe("<outgoing@example.com>");
    expect(dsnMeta?.threadId).toBe(outgoingMeta?.threadId);

    // The ordinary reply is threaded the same way but must not itself be classified as a DSN.
    expect(replyMeta?.messageKind).toBe("message");
    expect(replyMeta?.dsnOriginalMessageId).toBeNull();
    expect(replyMeta?.threadId).toBe(outgoingMeta?.threadId);
  });
});

describe("person <-> email linkage determinism (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("reindexing the same person twice with differently-cased/whitespaced addresses converges on the same normalized index rows", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice" } });

    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, ["  Alice@Example.com ", "ALICE@EXAMPLE.COM"]));
    // Both variants normalize to the same address — this must not attempt to claim it twice
    // (email PRIMARY KEY would reject a literal duplicate insert) and must resolve identically
    // regardless of how a later lookup happens to be cased.
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBe(alice.id);
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "Alice@Example.com"))).toBe(alice.id);

    const { rows } = await pool.query(`SELECT email FROM person_email_index WHERE item_id = $1`, [alice.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("alice@example.com");
  });
});

describe("legacy Emails migration (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  /** Creates an Emails item the way pre-issue-93 legacy data would exist: through the raw item-creation path, bypassing `ingestEmailMessage` entirely, so it has no `mail_message_meta` row at all — the exact "legacy" condition the migration job looks for. */
  async function createLegacyEmailItem(emailsId: string, properties: Record<string, unknown>): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: emailsId, properties }, { allowedSystemKeys: ["name", "sender", "recipients", "body", "date"] }),
    );
    return item.id;
  }

  it("reconstructs envelope/threadId/messageId from legacy sender/recipients text and marks migrationStatus 'partial'", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, {
      name: "Old subject",
      sender: "Alice <alice@example.com>",
      recipients: "Bob <bob@example.com>, carol@example.com",
    });

    await runMailLegacyEmailMigrationJob(pool, emailsId);

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    expect(meta).not.toBeNull();
    expect(meta?.migrationStatus).toBe("partial");
    expect(meta?.envelope.from).toEqual({ name: "Alice", address: "alice@example.com" });
    expect(meta?.envelope.to?.map((a) => a.address)).toEqual(["bob@example.com", "carol@example.com"]);
    expect(meta?.messageId).toBeTruthy();
    expect(meta?.threadId).toBeTruthy();

    // The row itself is preserved untouched, not replaced/deleted by the migration.
    const item = await chokePoint.getItem(emailsId, legacyItemId);
    expect(item?.properties.name).toBe("Old subject");
  });

  it("parses raw MIME when the injected fetcher has it, marking migrationStatus 'done' and recovering real threading headers", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, { name: "Old subject", sender: "alice@example.com", recipients: "bob@example.com" });

    const rawMime = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Hi",
        "Message-ID: <raw1@example.com>",
        "References: <parent@example.com>",
        "In-Reply-To: <parent@example.com>",
        "Content-Type: text/plain",
        "",
        "Hello",
        "",
      ].join("\r\n"),
    );
    const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

    await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    expect(meta?.migrationStatus).toBe("done");
    expect(meta?.messageId).toBe("<raw1@example.com>");
    expect(meta?.inReplyTo).toBe("<parent@example.com>");
    expect(meta?.references).toEqual(["<parent@example.com>"]);
    expect(meta?.envelope.from?.address).toBe("alice@example.com");
    expect(meta?.envelope.to?.[0]?.address).toBe("bob@example.com");
  });

  it("classifies a DSN recovered from raw MIME as messageKind 'dsn', linked to its original message, not an ordinary reply", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, { name: "Undelivered Mail Returned to Sender", sender: "mailer-daemon@example.com", recipients: "" });

    const rawMime = Buffer.from(
      [
        "From: Mail Delivery Subsystem <mailer-daemon@example.com>",
        "To: me@example.com",
        "Subject: Undelivered Mail Returned to Sender",
        "Message-ID: <dsn-raw1@example.com>",
        "References: <outgoing1@example.com>",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "delivery failed",
        "--b1--",
        "",
      ].join("\r\n"),
    );
    const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

    await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    expect(meta?.migrationStatus).toBe("done");
    expect(meta?.messageKind).toBe("dsn");
    expect(meta?.dsnOriginalMessageId).toBe("<outgoing1@example.com>");
  });

  it("falls back to its own synthetic id (migrationStatus 'partial') instead of stealing another item's mail_message_meta row when the recovered Message-ID collides", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: foldersId, properties: { name: "INBOX" } }, { allowedSystemKeys: ["name"] }),
    );

    // A live-synced item already owns this exact Message-ID — plausible for pre-#26 legacy
    // rows, which had no dedup at all.
    const liveItem = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        messageId: "<dup1@example.com>",
        envelope: { from: { address: "alice@example.com" } },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const legacyItemId = await createLegacyEmailItem(emailsId, { name: "Old subject", sender: "alice@example.com", recipients: "bob@example.com" });
    const rawMime = Buffer.from(
      ["From: Alice <alice@example.com>", "To: Bob <bob@example.com>", "Subject: Hi", "Message-ID: <dup1@example.com>", "", "Hello", ""].join("\r\n"),
    );
    const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

    await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

    const legacyMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    const liveMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, liveItem.itemId));

    // The legacy item gets its own row (never null — no infinite-reprocessing hazard) under a
    // synthetic id, and the live item's own row/identity is completely untouched.
    expect(legacyMeta).not.toBeNull();
    expect(legacyMeta?.itemId).toBe(legacyItemId);
    expect(legacyMeta?.messageId).not.toBe("<dup1@example.com>");
    expect(legacyMeta?.migrationStatus).toBe("partial");
    expect(liveMeta?.itemId).toBe(liveItem.itemId);
    expect(liveMeta?.messageId).toBe("<dup1@example.com>");

    // Idempotency check now succeeds for the legacy item too — a retry does not loop forever.
    const { rows } = await pool.query(`SELECT count(*) FROM mail_message_meta WHERE item_id = $1`, [legacyItemId]);
    expect(rows[0].count).toBe("1");
  });

  it("is resumable: re-running the job after a partial completion never reprocesses an already-migrated row", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, { name: "Old subject", sender: "alice@example.com", recipients: "bob@example.com" });

    await runMailLegacyEmailMigrationJob(pool, emailsId);
    const firstPassMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));

    // Simulates a retry after a crash: the job runs again from scratch (no persisted cursor,
    // same as propertyTypeMigration.ts) — the already-migrated row must be left exactly alone.
    await runMailLegacyEmailMigrationJob(pool, emailsId);
    const secondPassMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));

    expect(secondPassMeta).toEqual(firstPassMeta);
    const { rows } = await pool.query(`SELECT count(*) FROM mail_message_meta WHERE item_id = $1`, [legacyItemId]);
    expect(rows[0].count).toBe("1");
  });

  it("is queueable via enqueueMailLegacyEmailMigration/runOnce, with a stable per-database jobKey", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, { name: "Old subject", sender: "alice@example.com", recipients: "" });

    await withTransaction(pool, (client) => enqueueMailLegacyEmailMigration(client, emailsId));
    const { rows: jobRows } = await pool.query(`SELECT key FROM graphile_worker._private_jobs WHERE key = $1`, [mailLegacyEmailMigrationJobKey(emailsId)]);
    expect(jobRows).toHaveLength(1);

    await drainQueue();

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    expect(meta?.migrationStatus).toBe("partial");
  });
});

describe("IMAP PEEK vs explicit mark-read (issue #94)", () => {
  function fakeImapFlow(overrides: Partial<Record<string, unknown>> = {}): ImapFlow {
    const calls: string[] = [];
    return {
      capabilities: new Map(),
      calls,
      async mailboxOpen(path: string) {
        calls.push(`mailboxOpen:${path}`);
        return { uidValidity: 1n, uidNext: 3, highestModseq: undefined, noModseq: true };
      },
      async download() {
        calls.push("download");
        return { content: (async function* () {})() };
      },
      fetch() {
        calls.push("fetch");
        return (async function* () {})();
      },
      async messageFlagsAdd(range: string, flags: string[]) {
        calls.push(`messageFlagsAdd:${range}:${flags.join(",")}`);
        return true;
      },
      on() {},
      off() {},
      ...overrides,
    } as unknown as ImapFlow;
  }

  it("never calls messageFlagsAdd while fetching message bodies in the background", async () => {
    const raw = fakeImapFlow() as unknown as { calls: string[] };
    const client = new ImapFlowMailClient(raw as unknown as ImapFlow);

    await client.fetchMessagesSince("INBOX", 1);

    expect(raw.calls.some((c) => c.startsWith("messageFlagsAdd"))).toBe(false);
  });

  it("markSeen — the only explicit mark-read path — issues STORE +FLAGS (\\Seen) for the given UID", async () => {
    const raw = fakeImapFlow() as unknown as { calls: string[] };
    const client = new ImapFlowMailClient(raw as unknown as ImapFlow);

    await client.markSeen("INBOX", 42);

    expect(raw.calls).toEqual(["mailboxOpen:INBOX", "messageFlagsAdd:42:\\Seen"]);
  });

  it("isImapConnectionLimitError recognizes a provider's simultaneous-connection BYE, not an ordinary connection failure", () => {
    const gmailBye = Object.assign(new Error("Connection closed"), { code: "ClosedAfterConnectText", reason: "Too many simultaneous connections." });
    const genericPhrase = new Error("Login failed: too many concurrent connections for this account");
    const unrelated = new Error("ECONNREFUSED");

    expect(isImapConnectionLimitError(gmailBye)).toBe(true);
    expect(isImapConnectionLimitError(genericPhrase)).toBe(true);
    expect(isImapConnectionLimitError(unrelated)).toBe(false);
    expect(isImapConnectionLimitError("not an error")).toBe(false);
  });
});

describe("per-account IMAP concurrency limiter (issue #94)", () => {
  it("never runs more than `limit` tasks concurrently for the same account", async () => {
    const limiter = createImapConnectionLimiter();
    let active = 0;
    let maxActive = 0;
    const task = () =>
      limiter.run("account-1", 2, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("does not bound one account's concurrency by another account's limit", async () => {
    const limiter = createImapConnectionLimiter();
    let activeA = 0;
    let maxActiveA = 0;
    let activeB = 0;
    let maxActiveB = 0;

    const taskA = () =>
      limiter.run("account-a", 1, async () => {
        activeA++;
        maxActiveA = Math.max(maxActiveA, activeA);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeA--;
      });
    const taskB = () =>
      limiter.run("account-b", 3, async () => {
        activeB++;
        maxActiveB = Math.max(maxActiveB, activeB);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeB--;
      });

    await Promise.all([taskA(), taskA(), taskA(), taskB(), taskB(), taskB()]);

    expect(maxActiveA).toBe(1);
    expect(maxActiveB).toBe(3);
  });
});

describe("mail sync connection-limit backoff (issue #94)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("schedules a delayed retry through persisted sync state instead of rethrowing, on a connection-limit rejection", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "gmail" } }),
    );
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailConnectionLimitError("Too many simultaneous connections.");
      },
    };

    // Resolves rather than rejecting: a connection-limit rejection is contention, not a hard
    // failure, and must not also trigger graphile-worker's own immediate job retry on top of
    // the delayed sweep-driven retry recorded below.
    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      adapters,
      { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
      noopStorage,
    );

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state?.lastError).toBe("Too many simultaneous connections.");
    expect(state?.nextExpectedActivityAt).toBeTruthy();
    // Gmail's provider-aware backoff (10 minutes) is well past the generic 15-minute window's
    // midpoint, distinguishing it from `recordSyncError`'s fixed backoff.
    expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now() + 8 * 60 * 1000);

    // Not an account failure — syncStatus is left exactly as it was (never initialized to 'error').
    const item = await withTransaction(pool, (client) => client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]));
    expect(item.rows[0].properties.syncStatus).toBeUndefined();
  });

  it("routes a real IMAP connection attempt through the injected per-account connection limiter", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "gmail" } }),
    );
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }));

    const emptyImap: ImapMailClient = {
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
      markSeen: async () => {},
    };

    const runCalls: Array<{ accountId: string; limit: number }> = [];
    const recordingLimiter = {
      run: <T>(accountId: string, limit: number, task: () => Promise<T>) => {
        runCalls.push({ accountId, limit });
        return task();
      },
    };

    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      { createImapClient: async () => emptyImap },
      { emailsDatabaseId: emailsId, filesDatabaseId: filesId, foldersDatabaseId: foldersId, mailboxesDatabaseId: mailboxesId },
      noopStorage,
      recordingLimiter,
    );

    expect(runCalls).toEqual([{ accountId: mailbox.id, limit: 5 }]); // Gmail's provider default
  });
});

afterAll(async () => {
  await pool?.end();
});
