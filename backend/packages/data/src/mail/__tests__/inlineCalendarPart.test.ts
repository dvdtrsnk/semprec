import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import "../../domainWriteHooks.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { FOLDERS_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getTestPool, inTenantZero, resetDatabase } from "../../testSupport/testDb.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { GmailRestClient } from "../gmailRestClient.js";
import { ImapFlowMailClient } from "../imapFlowClient.js";
import { reconcileImapFolder } from "../imapReconcile.js";
import { ingestEmailMessage } from "../ingest.js";

const pool = getTestPool();
const chokePoint = createChokePoint(pool);

const INVITATION = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:inline@example.test",
  "DTSTART:20261120T090000Z",
  "SUMMARY:Sprint review",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

/** Keeps no bytes: the tests read the `mail_attachments` row and the Files item that ingest recorded. */
const storage: BlobStorageWriter = {
  async writeStream(_storageKey, source) {
    const hash = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      hash.update(bytes);
      byteSize += bytes.length;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error("Missing seeded database");
  return rows[0].id;
}

/** A seeded tenant with one mailbox and its INBOX folder, and the ids `reconcileImapFolder` and `ingestEmailMessage` need. */
async function setUpFolder() {
  const [emailsId, foldersId, filesId, mailboxesId] = await Promise.all([
    databaseIdFor("emails"),
    databaseIdFor("folders"),
    databaseIdFor("files"),
    databaseIdFor("mailboxes"),
  ]);
  const [emailProperties, folderProperties] = await Promise.all([
    chokePoint.listProperties(emailsId),
    chokePoint.listProperties(foldersId),
  ]);
  const mailbox = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "generic" } }),
  );
  const folderRelationPropertyId = emailProperties.find((p) => p.key === "folder")!.id;
  const mailboxFolderRelationPropertyId = folderProperties.find((p) => p.key === "mailbox")!.id;
  const folder = await withTransaction(pool, async (client) => {
    const created = await createItemWithClient(
      client,
      { databaseId: foldersId, properties: { name: "INBOX", behavior: "folder", providerId: "INBOX" } },
      { allowedSystemKeys: ["name", "behavior", "providerId"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: created.id, targetItemId: mailbox.id },
      { ownerProcess: FOLDERS_MODULE_ID },
    );
    return created;
  });
  return {
    emailsId,
    filesId,
    folderRelationPropertyId,
    attachmentsRelationPropertyId: emailProperties.find((p) => p.key === "attachments")!.id,
    mailbox,
    folder,
    foldersId,
    mailboxFolderRelationPropertyId,
  };
}

const attachmentRows = z.array(
  z.object({ filename: z.string(), content_type: z.string(), disposition: z.string(), byte_size: z.string() }),
);

async function storedAttachments() {
  const { rows } = await pool.query(
    "SELECT filename, content_type, disposition, byte_size::text FROM mail_attachments ORDER BY filename",
  );
  return attachmentRows.parse(rows);
}

beforeEach(async () => {
  await resetDatabase(pool);
  await seedSystem(pool);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an inline text/calendar part of a multipart/alternative message (issue gh-1929)", () => {
  it("is classified by the IMAP adapter and recorded as a mail_attachments row with its Files item by folder sync", async () =>
    inTenantZero(async () => {
      const setup = await setUpFolder();
      const connection = new ImapFlow({
        host: "unused.example.test",
        port: 993,
        secure: true,
        auth: { user: "unused", pass: "unused" },
        logger: false,
      });
      vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set(),
        uidValidity: 1n,
        uidNext: 2,
        exists: 1,
      });
      vi.spyOn(connection, "fetch").mockImplementation(async function* () {
        yield {
          seq: 1,
          uid: 1,
          envelope: { messageId: "<imap-invite@example.test>", from: [{ address: "olga@example.test" }] },
          bodyStructure: {
            type: "multipart/alternative",
            childNodes: [
              { part: "1", type: "text/plain" },
              { part: "2", type: "text/html" },
              {
                part: "3",
                type: "text/calendar",
                disposition: "inline",
                parameters: { method: "REQUEST", charset: "utf-8" },
              },
            ],
          },
        };
      });
      const download = vi.spyOn(connection, "download").mockImplementation(async (_uid, part) => ({
        meta: { expectedSize: 1, contentType: part === "3" ? "text/calendar" : "text/plain" },
        content: Readable.from([Buffer.from(part === "3" ? INVITATION : "body")]),
      }));

      await withTransaction(pool, (client) =>
        reconcileImapFolder(client, new ImapFlowMailClient(connection), {
          folderItemId: setup.folder.id,
          folderPath: "INBOX",
          emailsDatabaseId: setup.emailsId,
          filesDatabaseId: setup.filesId,
          folderRelationPropertyId: setup.folderRelationPropertyId,
          attachmentsRelationPropertyId: setup.attachmentsRelationPropertyId,
          storage,
          storageKeyPrefix: "test",
          mailboxItemId: setup.mailbox.id,
          foldersDatabaseId: setup.foldersId,
          mailboxFolderRelationPropertyId: setup.mailboxFolderRelationPropertyId,
        }),
      );

      expect(download.mock.calls.map((call) => call[1]).sort()).toEqual(["1", "2", "3"]);
      expect(await storedAttachments()).toEqual([
        {
          filename: "attachment",
          content_type: "text/calendar",
          disposition: "inline",
          byte_size: String(Buffer.byteLength(INVITATION)),
        },
      ]);
      const { rows } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
        [setup.filesId],
      );
      expect(rows[0]?.count).toBe(1);
    }));

  it("is classified by the Gmail adapter and recorded as a mail_attachments row with its Files item by message ingest", async () =>
    inTenantZero(async () => {
      const setup = await setUpFolder();
      const encode = (value: string) => Buffer.from(value).toString("base64url");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                id: "gmail-invite-1",
                threadId: "gmail-thread-1",
                payload: {
                  mimeType: "multipart/alternative",
                  headers: [
                    { name: "Message-ID", value: "<gmail-invite@example.test>" },
                    { name: "From", value: "Olga <olga@example.test>" },
                  ],
                  parts: [
                    { mimeType: "text/plain", body: { data: encode("Please join") } },
                    { mimeType: "text/html", body: { data: encode("<p>Please join</p>") } },
                    {
                      mimeType: "text/calendar",
                      filename: "",
                      headers: [{ name: "Content-Type", value: "text/calendar; method=REQUEST; charset=UTF-8" }],
                      body: { size: Buffer.byteLength(INVITATION), data: encode(INVITATION) },
                    },
                  ],
                },
              }),
              { status: 200 },
            ),
        ),
      );
      const fetched = await new GmailRestClient(async () => "test-token").fetchMessage("gmail-invite-1");
      if (!fetched) throw new Error("The stubbed Gmail message was not returned");
      expect(fetched.message.attachments.map((entry) => entry.contentType)).toEqual(["text/calendar"]);

      await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: setup.emailsId,
          filesDatabaseId: setup.filesId,
          folderRelationPropertyId: setup.folderRelationPropertyId,
          attachmentsRelationPropertyId: setup.attachmentsRelationPropertyId,
          folderItemId: setup.folder.id,
          mailboxItemId: setup.mailbox.id,
          messageId: fetched.message.messageId,
          envelope: fetched.message.envelope,
          bodyText: fetched.message.bodyText,
          bodyHtml: fetched.message.bodyHtml,
          attachments: fetched.message.attachments,
          storage,
          storageKeyPrefix: "test",
        }),
      );

      expect(await storedAttachments()).toEqual([
        {
          filename: "attachment",
          content_type: "text/calendar",
          disposition: "attachment",
          byte_size: String(Buffer.byteLength(INVITATION)),
        },
      ]);
      const { rows } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
        [setup.filesId],
      );
      expect(rows[0]?.count).toBe(1);
    }));
});
