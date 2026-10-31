import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  GMAIL_ARCHIVE_PROVIDER_ID,
  reconcileGmailAccount,
  type GmailLabelRef,
  type GmailMailClient,
} from "../mail/gmailReconcile.js";
import { handleMailGmailPseudoFolderCleanupTask } from "../mail/gmailPseudoFolderCleanupJob.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

let admin: Pool;
let pool: Pool;
let tenantId: string;

const storage: BlobStorageWriter = {
  async writeStream() {
    return { byteSize: 0, contentHash: "0" };
  },
  async delete() {},
  readStream: () => {
    throw new Error("not used");
  },
};

const LABELS: GmailLabelRef[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "CHAT", name: "CHAT", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "Label_1", name: "Work", type: "user" },
];

function gmailClient(messages: Record<string, string[]>): GmailMailClient {
  return {
    getCurrentHistoryId: async () => "100",
    listHistorySince: async () => ({
      invalidated: false,
      newHistoryId: "101",
      changedMessageIds: Object.keys(messages),
      removedMessageIds: [],
    }),
    listAllMessageIds: async () => Object.keys(messages),
    fetchMessage: async (id) => ({
      id,
      threadId: `t-${id}`,
      labelIds: messages[id] ?? [],
      message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, subject: id, attachments: [] },
    }),
    listLabels: async () => LABELS,
    modifyMessageLabels: async () => {},
  };
}

interface Setup {
  mailboxItemId: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
}

async function setup(): Promise<Setup> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const [emails, files, folders, mailboxes] = await Promise.all(
        ["emails", "files", "folders", "mailboxes"].map((m) => getDatabaseByModuleId(client, m)),
      );
      if (!emails || !files || !folders || !mailboxes) throw new Error("mail databases were not seeded");
      const folderProperty = await getPropertyByKey(client, emails.id, "folder");
      const attachmentsProperty = await getPropertyByKey(client, emails.id, "attachments");
      const mailboxProperty = await getPropertyByKey(client, folders.id, "mailbox");
      if (!folderProperty || !attachmentsProperty || !mailboxProperty) throw new Error("schema missing");
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: "M", provider: "gmail" },
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
      return {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emails.id,
        filesDatabaseId: files.id,
        foldersDatabaseId: folders.id,
        folderRelationPropertyId: folderProperty.id,
        mailboxFolderRelationPropertyId: mailboxProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        storage,
        storageKeyPrefix: "test",
      };
    }),
  );
}

async function sync(params: Setup, messages: Record<string, string[]>): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, (client) => reconcileGmailAccount(client, gmailClient(messages), params)),
  );
}

async function folderProviderIds(params: Setup): Promise<string[]> {
  const { rows } = await admin.query<{ pid: string }>(
    `SELECT properties ->> 'providerId' AS pid FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY 1`,
    [params.foldersDatabaseId],
  );
  return rows.map((r) => r.pid);
}

/** Provider ids of the live folders a message (by Message-ID) is linked to. */
async function foldersOf(params: Setup, providerMessageId: string): Promise<string[]> {
  const { rows } = await admin.query<{ pid: string }>(
    `SELECT f.properties ->> 'providerId' AS pid
       FROM mail_message_meta m
       JOIN item_relations r ON r.item_a = m.item_id OR r.item_b = m.item_id
       JOIN items f ON f.id = CASE WHEN r.item_a = m.item_id THEN r.item_b ELSE r.item_a END
      WHERE m.provider_message_id = $1 AND f.database_id = $2 AND f.deleted_at IS NULL
      ORDER BY 1`,
    [providerMessageId, params.foldersDatabaseId],
  );
  return rows.map((r) => r.pid);
}

describe("Gmail label folders (issue #1496)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantId = getTenantZeroId();
    await runInTenant(tenantId, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates folders only for user labels, the five system labels and Archive", async () => {
    const params = await setup();
    await sync(params, { m1: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    expect(await folderProviderIds(params)).toEqual(
      ["DRAFT", "INBOX", "Label_1", "SENT", GMAIL_ARCHIVE_PROVIDER_ID].sort(),
    );
    expect(await foldersOf(params, "m1")).toEqual(["INBOX"]);
  });

  it("puts archived mail in Archive, a sent mail and a draft not", async () => {
    const params = await setup();
    await sync(params, {
      archived: ["IMPORTANT", "UNREAD"],
      withUserLabel: ["Label_1"],
      sent: ["SENT"],
      draft: ["DRAFT", "UNREAD"],
    });
    expect(await foldersOf(params, "archived")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    expect(await foldersOf(params, "withUserLabel")).toEqual(["Label_1", GMAIL_ARCHIVE_PROVIDER_ID].sort());
    expect(await foldersOf(params, "sent")).toEqual(["SENT"]);
    expect(await foldersOf(params, "draft")).toEqual(["DRAFT"]);
  });

  it("ingests a message with no labels into Archive", async () => {
    const params = await setup();
    await sync(params, { bare: [] });
    expect(await foldersOf(params, "bare")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
  });

  it("removes the Archive edge when the message moves back to the inbox, and the INBOX edge when archived", async () => {
    const params = await setup();
    await sync(params, { m1: ["UNREAD"] });
    expect(await foldersOf(params, "m1")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    await sync(params, { m1: ["INBOX"] });
    expect(await foldersOf(params, "m1")).toEqual(["INBOX"]);
    await sync(params, { m1: [] });
    expect(await foldersOf(params, "m1")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
  });

  it("fails before deleting a mailbox folder when its label inventory is unavailable or ambiguous", async () => {
    const params = await setup();
    await runInTenant(tenantId, () =>
      withTransaction(pool, (client) =>
        ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId: "UNREAD",
          name: "Unread",
          behavior: "label",
          specialPurpose: "none",
        }),
      ),
    );
    const before = await folderProviderIds(params);
    await expect(handleMailGmailPseudoFolderCleanupTask(pool, undefined)).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
    await expect(
      handleMailGmailPseudoFolderCleanupTask(pool, async () => {
        throw new Error("provider offline");
      }),
    ).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
    await expect(
      handleMailGmailPseudoFolderCleanupTask(pool, async () => [
        { id: "UNREAD", name: "Unread", type: "system" },
        { id: "UNREAD", name: "Unread", type: "user" },
      ]),
    ).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
  });

  it("cleanup removes pseudo-folders, keeps archived mail visible through Archive, and a second run changes nothing", async () => {
    const params = await setup();
    const inventory: GmailLabelRef[] = [
      ...LABELS,
      { id: "opaque-user", name: "Private", type: "user" },
      { id: "opaque-system", name: "System", type: "system" },
    ];
    const storedLabels: GmailLabelRef[] = [...inventory, { id: "absent-id", name: "Unknown", type: "user" }];
    // The state an older sync left behind: a folder for every label, mail linked to each.
    const messageIdsByLabels: Record<string, string[]> = {
      inboxUnread: ["INBOX", "UNREAD"],
      archivedUnread: ["UNREAD", "CATEGORY_PROMOTIONS"],
      archivedWork: ["STARRED", "Label_1"],
      sentStarred: ["SENT", "STARRED"],
      opaque: ["opaque-system", "opaque-user", "absent-id"],
    };
    await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const folderIds = new Map<string, string>();
        for (const label of storedLabels) {
          folderIds.set(
            label.id,
            await ensureFolderItem(client, {
              foldersDatabaseId: params.foldersDatabaseId,
              mailboxItemId: params.mailboxItemId,
              mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
              providerId: label.id,
              name: label.name,
              behavior: "label",
              specialPurpose: "none",
            }),
          );
        }
        for (const [messageId, labelIds] of Object.entries(messageIdsByLabels)) {
          for (const labelId of labelIds) {
            await ingestEmailMessage(client, {
              emailsDatabaseId: params.emailsDatabaseId,
              filesDatabaseId: params.filesDatabaseId,
              folderRelationPropertyId: params.folderRelationPropertyId,
              attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
              folderItemId: folderIds.get(labelId)!,
              mailboxItemId: params.mailboxItemId,
              providerMessageId: messageId,
              providerThreadId: `t-${messageId}`,
              storage,
              storageKeyPrefix: "test",
              messageId: `<${messageId}@x>`,
              envelope: { from: { address: "a@x.com" } },
              subject: messageId,
              attachments: [],
            });
          }
        }
      }),
    );

    await handleMailGmailPseudoFolderCleanupTask(pool, async () => inventory);

    expect(await folderProviderIds(params)).toEqual(
      ["DRAFT", "INBOX", "Label_1", "SENT", "opaque-user", "absent-id", GMAIL_ARCHIVE_PROVIDER_ID].sort(),
    );
    expect(await foldersOf(params, "inboxUnread")).toEqual(["INBOX"]);
    expect(await foldersOf(params, "archivedUnread")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    expect(await foldersOf(params, "archivedWork")).toEqual(["Label_1", GMAIL_ARCHIVE_PROVIDER_ID].sort());
    expect(await foldersOf(params, "sentStarred")).toEqual(["SENT"]);
    expect(await foldersOf(params, "opaque")).toEqual(["opaque-user", "absent-id", GMAIL_ARCHIVE_PROVIDER_ID].sort());

    const snapshot = async () =>
      (await admin.query("SELECT * FROM item_relations ORDER BY id")).rows.map((r) => JSON.stringify(r));
    const edgesAfterFirst = await snapshot();
    const { rows: itemsAfterFirst } = await admin.query("SELECT id, deleted_at FROM items ORDER BY id");
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => inventory);
    expect(await snapshot()).toEqual(edgesAfterFirst);
    expect((await admin.query("SELECT id, deleted_at FROM items ORDER BY id")).rows).toEqual(itemsAfterFirst);
  });
});
