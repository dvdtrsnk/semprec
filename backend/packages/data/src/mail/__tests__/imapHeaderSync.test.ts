import { beforeEach, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import "../../domainWriteHooks.js";
import { getTestPool, inTenantZero, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { withTransaction } from "../../db/pool.js";
import { reconcileImapFolder } from "../imapReconcile.js";
import { ImapFlowMailClient } from "../imapFlowClient.js";
import type { BlobStorageWriter } from "../blobStorage.js";

const pool = getTestPool();
const chokePoint = createChokePoint(pool);
const noopStorage: BlobStorageWriter = {
  async writeStream() {
    throw new Error("Unexpected attachment");
  },
  async delete() {},
  readStream() {
    throw new Error("Unexpected read");
  },
};
async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error("Missing seeded database");
  return rows[0].id;
}
beforeEach(async () => {
  await resetDatabase(pool);
  await seedSystem(pool);
});
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
  const params = {
    folderItemId: folder.id,
    folderPath: "INBOX",
    emailsDatabaseId: emailsId,
    filesDatabaseId: filesId,
    folderRelationPropertyId,
    attachmentsRelationPropertyId: emailProperties.find((p) => p.key === "attachments")!.id,
    storage: noopStorage,
    storageKeyPrefix: "test",
    mailboxItemId: mailbox.id,
    foldersDatabaseId: foldersId,
    mailboxFolderRelationPropertyId,
  };
  return { emailsId, mailbox, folder, params };
}

it("persists IMAP Reply-To and each bulk signal through the adapter and folder sync", async () =>
  inTenantZero(async () => {
    const { params } = await setUpFolder();
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
      uidNext: 7,
      exists: 6,
    });
    const rawHeaders = [
      "List-Unsubscribe: <mailto:leave@example.test>\r\n",
      "List-Id: <list.example.test>\r\n",
      "Precedence: bulk\r\n",
      "Auto-Submitted: auto-generated\r\n",
      "",
      "Auto-Submitted: no\r\n",
    ];
    const fetch = vi.spyOn(connection, "fetch").mockImplementation(async function* () {
      for (let index = 0; index < rawHeaders.length; index++) {
        yield {
          seq: index + 1,
          uid: index + 1,
          envelope: {
            messageId: `<imap-bulk-${index}@example.test>`,
            from: [{ name: "Sender", address: index === 4 ? "No-Reply@example.test" : "person@example.test" }],
            ...(index === 0 ? { replyTo: [{ name: "Support", address: "support@example.test" }] } : {}),
            ...(index === 5 ? { replyTo: [{ address: "" }] } : {}),
          },
          headers: Buffer.from(rawHeaders[index]!),
        };
      }
    });
    const adapter = new ImapFlowMailClient(connection);
    await withTransaction(pool, (client) => reconcileImapFolder(client, adapter, params));
    const query = fetch.mock.calls[0]?.[1];
    expect(query?.headers).toEqual(
      expect.arrayContaining(["list-unsubscribe", "list-id", "precedence", "auto-submitted"]),
    );
    const { rows } = await pool.query<{ message_id: string; is_bulk: boolean; envelope: unknown }>(
      "SELECT message_id, is_bulk, envelope FROM mail_message_meta ORDER BY message_id",
    );
    expect(rows.map((row) => row.is_bulk)).toEqual([true, true, true, true, true, false]);
    expect(rows[0]?.envelope).toEqual({
      from: { name: "Sender", address: "person@example.test" },
      to: [],
      cc: [],
      bcc: [],
      replyTo: [{ name: "Support", address: "support@example.test" }],
    });
    expect(rows[3]?.envelope).not.toHaveProperty("replyTo");
    expect(rows[5]?.envelope).toEqual({
      from: { name: "Sender", address: "person@example.test" },
      to: [],
      cc: [],
      bcc: [],
    });
  }));
