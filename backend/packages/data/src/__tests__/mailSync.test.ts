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
import { createMailAccountConnectAction, MAIL_CONNECT_ACCOUNT_ACTION_ID } from "../mail/mailAccountConnectAction.js";
import { reindexStaleEmailSearchEntries } from "../mail/search.js";
import { OAuthRevokedError } from "../mail/oauthTokenExchange.js";
import { lookupPersonIdByEmail, reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { resolveThreadId } from "../mail/threading.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { classifyAttachments } from "../mail/attachments.js";
import { sanitizeMailHtml } from "../mail/htmlSanitize.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import { storeCredential, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { reconcileImapAccount, type ImapFetchedMessage, type ImapMailClient } from "../mail/imapReconcile.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { normalizeMessageId } from "../mail/providerTypes.js";
import { handleSyncMailAccountTask, type MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { ensureMailAccountSyncState, getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { simpleParser } from "mailparser";
import { createHash, randomUUID } from "node:crypto";

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
  registry.set(MAIL_CONNECT_ACCOUNT_ACTION_ID, createMailAccountConnectAction(pool));
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
    // Derived deterministically by mail/personLinkingActions.ts, not user-editable — same
    // reasoning as sender/recipients above.
    expect(emailProps.find((p) => p.key === "senderPeople")).toMatchObject({ owner: "system" });
    expect(emailProps.find((p) => p.key === "recipientsPeople")).toMatchObject({ owner: "system" });
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

  it.each([
    ["gmail", "gmail_api"],
    ["outlook", "graph_api"],
    ["icloud", "imap"],
    ["generic", "imap"],
  ])("defaults sync_mode to %s -> %s from Mailbox.provider on creation", async (provider, expectedSyncMode) => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider } }));
    await drainQueue(); // onItemEvent 'create' on Mailboxes -> connectAccount action
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state?.syncMode).toBe(expectedSyncMode);
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

describe("normalizeMessageId (issue #26)", () => {
  it("ensures exactly one pair of angle brackets regardless of adapter-supplied format", () => {
    expect(normalizeMessageId("<abc@example.com>")).toBe("<abc@example.com>");
    expect(normalizeMessageId("abc@example.com")).toBe("<abc@example.com>");
    expect(normalizeMessageId("  <abc@example.com>  ")).toBe("<abc@example.com>");
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

  it("merges two separate threads when a message bridges them, and deletes the absorbed thread's now-empty row", async () => {
    const threadA = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<a@x>" }));
    await pool.query(`INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<a@x>', $1, '{}')`, [threadA]);
    const threadB = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<b@x>" }));
    await pool.query(`INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<b@x>', $1, '{}')`, [threadB]);
    expect(threadA).not.toBe(threadB);

    const bridgeThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<bridge@x>", references: ["<a@x>", "<b@x>"] }),
    );
    expect([threadA, threadB]).toContain(bridgeThreadId);

    const { rows } = await pool.query(`SELECT id FROM mail_threads WHERE id = ANY($1::uuid[])`, [[threadA, threadB]]);
    expect(rows.map((r) => r.id)).toEqual([bridgeThreadId]); // the absorbed thread's row is gone, not just orphaned
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

describe("attachment classification (issue #26)", () => {
  it("excludes an inline part referenced via cid: from the HTML body, includes a real attachment", async () => {
    const raw = [
      "Content-Type: multipart/related; boundary=BOUNDARY",
      "",
      "--BOUNDARY",
      "Content-Type: multipart/mixed; boundary=INNER",
      "",
      "--INNER",
      "Content-Type: text/html",
      "",
      '<p>Hi <img src="cid:logo123"></p>',
      "--INNER",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=invoice.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("pdf-bytes").toString("base64"),
      "--INNER--",
      "--BOUNDARY",
      "Content-Type: image/png",
      "Content-ID: <logo123>",
      "Content-Disposition: inline; filename=logo.png",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("png-bytes").toString("base64"),
      "--BOUNDARY--",
    ].join("\r\n");

    const parsed = await simpleParser(raw, { keepCidLinks: true });
    const classified = classifyAttachments(parsed);
    expect(classified.map((a) => a.filename)).toEqual(["invoice.pdf"]);
    expect(classified[0].disposition).toBe("attachment");
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

  it("strips a background-image url() from style — the same tracking-pixel vector as img src, via CSS instead", () => {
    const sanitized = sanitizeMailHtml('<div style="background-image:url(https://tracker.example/pixel.gif); color: red">hi</div>');
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("background-image");
    expect(sanitized).toContain("color");
  });

  it("allows remote images when explicitly requested", () => {
    const sanitized = sanitizeMailHtml('<img src="https://example.com/photo.jpg">', { allowRemoteImages: true });
    expect(sanitized).toContain("https://example.com/photo.jpg");
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
    // searchItems joins item_search_index back to items (for recency blending) — a real
    // Emails item, not a synthetic id, matches how reindexItemSearch is actually called
    // (mail/ingest.ts, in the same transaction as the item's own creation).
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: emailsId, properties: { name: "Invoice" } }, { allowedSystemKeys: ["name"] }),
    );
    const itemId = item.id;
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId, databaseId: emailsId, text: "Invoice for consulting services" }));

    const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "invoice" }));
    expect(results.map((r) => r.itemId)).toContain(itemId);

    const noResults = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "nonexistentword" }));
    expect(noResults.map((r) => r.itemId)).not.toContain(itemId);
  });

  it("reindexStaleEmailSearchEntries backfills an Emails item that was never indexed (a write outside the standard ingest path)", async () => {
    const emailsId = await databaseIdFor("emails");
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: emailsId, properties: { name: "Quarterly Report", body: "<p>Revenue figures attached</p>" } }, { allowedSystemKeys: ["name", "body"] }),
    );

    const reindexed = await withTransaction(pool, (client) => reindexStaleEmailSearchEntries(client, emailsId));
    expect(reindexed).toBe(1);

    const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query: "revenue" }));
    expect(results.map((r) => r.itemId)).toContain(item.id);

    // A second pass over the same (now up-to-date) row is a no-op.
    const reindexedAgain = await withTransaction(pool, (client) => reindexStaleEmailSearchEntries(client, emailsId));
    expect(reindexedAgain).toBe(0);
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
      fetchFlagsChangedSince: async () => [],
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

  it("a CHANGEDSINCE(FLAGS) pass merges new flags onto an already-known folder edge without touching its uid", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
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

    await withTransaction(pool, (client) => reconcileImapAccount(client, fakeImapClient(), params));

    const client2 = fakeImapClient({
      fetchMessagesSince: async () => [],
      fetchFlagsChangedSince: async () => [{ uid: 1, flags: ["\\Seen"] }],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, client2, params));

    const { rows } = await pool.query(`SELECT metadata FROM item_relations WHERE metadata ->> 'uid' = '1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ uid: 1, flags: ["\\Seen"] });
  });

  it("ensureFolderItem updates name/behavior/specialPurpose on an already-known providerId instead of freezing it at first discovery", async () => {
    const foldersDatabaseId = await databaseIdFor("folders");
    const mailboxesId = await databaseIdFor("mailboxes");
    const folderProps = await chokePoint.listProperties(foldersDatabaseId);
    const mailbox = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }));
    const mailboxRelationPropertyId = folderProps.find((p) => p.key === "mailbox")!.id;

    const firstId = await withTransaction(pool, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId,
        providerId: "Label_1",
        name: "Old Name",
        behavior: "label",
        specialPurpose: "none",
      }),
    );

    const secondId = await withTransaction(pool, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId,
        providerId: "Label_1",
        name: "New Name",
        behavior: "label",
        specialPurpose: "archive",
      }),
    );

    expect(secondId).toBe(firstId); // same providerId converges onto the same Folder item, not a duplicate
    const { rows } = await pool.query(`SELECT properties FROM items WHERE id = $1`, [firstId]);
    expect(rows[0].properties).toMatchObject({ name: "New Name", specialPurpose: "archive" });
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
      fetchFlagsChangedSince: async () => [],
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
  });

  it("a revoked OAuth refresh token sets syncStatus:'needsReauthorization' and stops retrying on the usual 15-minute cadence", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "gmail" } }),
    );
    await withTransaction(pool, (client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" }));
    await withTransaction(pool, (client) => storeCredential(client, { itemId: mailbox.id, credentialType: "oauth2_refresh_token", plaintext: "refresh-token" }));

    const adapters: MailSyncAdapterFactory = {
      createGmailClient: () => {
        throw new OAuthRevokedError("https://oauth2.googleapis.com/token");
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
    ).rejects.toThrow(OAuthRevokedError);

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    // Well past the 15-minute cadence a plain transient failure gets (see the test above) —
    // there's nothing to retry until the user reconnects the account.
    expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(`SELECT properties->>'syncStatus' AS sync_status FROM items WHERE id = $1`, [mailbox.id]);
    expect(rows[0].sync_status).toBe("needsReauthorization");
  });
});

afterAll(async () => {
  await pool?.end();
});
