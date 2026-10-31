import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import * as relationOps from "../chokePoint/relationOps.js";
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

async function setup(scopeTenant = tenantId): Promise<Setup> {
  return runInTenant(scopeTenant, () =>
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

async function seedOverlap(params: Setup): Promise<{ folderItemId: string; messageItemId: string }> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: params.foldersDatabaseId,
        mailboxItemId: params.mailboxItemId,
        mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
        providerId: "UNREAD",
        name: "Unread",
        behavior: "label",
        specialPurpose: "none",
      });
      for (const [providerId, purpose] of [
        ["INBOX", "inbox"],
        [GMAIL_ARCHIVE_PROVIDER_ID, "archive"],
      ] as const) {
        await ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId,
          name: purpose,
          behavior: "label",
          specialPurpose: purpose,
        });
      }
      const message = await ingestEmailMessage(client, {
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId,
        mailboxItemId: params.mailboxItemId,
        providerMessageId: "overlap",
        messageId: "<overlap@x>",
        envelope: { from: { address: "sender@example.test" } },
        subject: "Overlap",
        attachments: [],
        storage,
        storageKeyPrefix: "overlap",
      });
      return { folderItemId, messageItemId: message.itemId };
    }),
  );
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
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => LABELS);
    expect(await folderProviderIds(params)).not.toContain("UNREAD");
  });

  it("walks more than one cleanup page and leaves every affected message in Archive", async () => {
    const params = await setup();
    await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const folderItemId = await ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId: "UNREAD",
          name: "Unread",
          behavior: "label",
          specialPurpose: "none",
        });
        for (let index = 0; index < 201; index += 1) {
          await ingestEmailMessage(client, {
            emailsDatabaseId: params.emailsDatabaseId,
            filesDatabaseId: params.filesDatabaseId,
            folderRelationPropertyId: params.folderRelationPropertyId,
            attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
            folderItemId,
            mailboxItemId: params.mailboxItemId,
            providerMessageId: `page-${index}`,
            messageId: `<page-${index}@example.test>`,
            envelope: { from: { address: "sender@example.test" } },
            subject: "Page",
            attachments: [],
            storage,
            storageKeyPrefix: "page-test",
          });
        }
      }),
    );
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => LABELS);
    for (const index of [0, 100, 200]) {
      expect(await foldersOf(params, `page-${index}`)).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    }
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_meta m
        JOIN item_relations r ON r.item_a = m.item_id OR r.item_b = m.item_id
        JOIN items f ON f.id = CASE WHEN r.item_a = m.item_id THEN r.item_b ELSE r.item_a END
        WHERE m.mailbox_item_id = $1 AND f.properties ->> 'providerId' = $2`,
      [params.mailboxItemId, GMAIL_ARCHIVE_PROVIDER_ID],
    );
    expect(rows[0]?.count).toBe("201");
    expect(await folderProviderIds(params)).not.toContain("UNREAD");
  }, 30_000);

  it("rejects missing and system tenant scope before Gmail reconciliation queries", async () => {
    const params = await setup();
    const client = await admin.connect();
    const query = vi.spyOn(client, "query");
    try {
      await expect(reconcileGmailAccount(client, gmailClient({}), params)).rejects.toThrow(/tenant scope/i);
      await expect(
        runAsSystem("gmail-scope-test", () => reconcileGmailAccount(client, gmailClient({}), params)),
      ).rejects.toThrow(/tenant scope/i);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      client.release();
    }
  });

  it("keeps Inbox without Archive when cleanup overlaps a Gmail move to Inbox", async () => {
    const params = await setup();
    const seeded = await seedOverlap(params);
    const cleanupPool = await createRuntimeRolePool(admin, "semprec_data");
    const syncPool = await createRuntimeRolePool(admin, "semprec_data");
    let release: () => void = () => undefined;
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportPid: (pid: number) => void = () => undefined;
    const paused = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const original = relationOps.deleteRelationWithClient;
    const spy = vi
      .spyOn(relationOps, "deleteRelationWithClient")
      .mockImplementation(async (client, input, context, writer) => {
        const result = await original(client, input, context, writer);
        if (input.callerItemId === seeded.messageItemId && input.targetItemId === seeded.folderItemId && result) {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing cleanup backend pid");
          reportPid(pid);
          await mayContinue;
        }
        return result;
      });
    const cleanup = handleMailGmailPseudoFolderCleanupTask(cleanupPool, async () => LABELS);
    const cleanupSettled = Promise.allSettled([cleanup]);
    let syncSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let outcomes: PromiseSettledResult<void>[][];
    let blocked = false;
    let blockedQuery = "";
    try {
      const pid = await Promise.race([
        paused,
        cleanup.then(() => {
          throw new Error("Cleanup ended before barrier");
        }),
      ]);
      const syncing = runInTenant(tenantId, () =>
        withTransaction(syncPool, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          await reconcileGmailAccount(client, gmailClient({ overlap: ["INBOX"] }), params);
        }),
      );
      syncSettled = Promise.allSettled([syncing]);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await admin.query<{ query: string }>(
          "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (rows[0]) {
          blocked = true;
          blockedQuery = rows[0].query;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      outcomes = await Promise.all([cleanupSettled, syncSettled ?? Promise.resolve([])]);
      spy.mockRestore();
      await cleanupPool.end();
      await syncPool.end();
    }
    expect(outcomes.flat().map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(blocked).toBe(true);
    expect(blockedQuery).toMatch(/pg_advisory_xact_lock/i);
    expect(await foldersOf(params, "overlap")).toEqual(["INBOX"]);
  }, 15_000);

  it("waits for an in-flight Gmail move before cleaning the same mailbox", async () => {
    const params = await setup();
    await seedOverlap(params);
    const otherMailbox = await setup();
    const otherTenant = await createTestTenant(admin);
    await runInTenant(otherTenant, () => seedSystem(pool));
    const otherTenantMailbox = await setup(otherTenant);
    const cleanupPool = await createRuntimeRolePool(admin, "semprec_data");
    const syncPool = await createRuntimeRolePool(admin, "semprec_data");
    let release: () => void = () => undefined;
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportPid: (pid: number) => void = () => undefined;
    const paused = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const syncing = runInTenant(tenantId, () =>
      withTransaction(syncPool, async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing sync backend pid");
        const gmail = gmailClient({ overlap: ["INBOX"] });
        gmail.listLabels = async () => {
          reportPid(pid);
          await mayContinue;
          return LABELS;
        };
        await reconcileGmailAccount(client, gmail, params);
      }),
    );
    const syncSettled = Promise.allSettled([syncing]);
    let cleanupSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let outcomes: PromiseSettledResult<void>[][];
    let blockedQuery = "";
    let independentSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let independentCompleted: boolean;
    try {
      const pid = await Promise.race([
        paused,
        syncing.then(() => {
          throw new Error("Sync ended before barrier");
        }),
      ]);
      const independent = [
        { tenant: tenantId, params: otherMailbox, id: "other-mailbox" },
        { tenant: otherTenant, params: otherTenantMailbox, id: "other-tenant" },
      ].map(({ tenant, params: other, id }) =>
        runInTenant(tenant, () =>
          withTransaction(syncPool, async (client) => {
            await client.query("SET LOCAL statement_timeout = '3s'");
            await reconcileGmailAccount(client, gmailClient({ [id]: ["INBOX"] }), other);
          }),
        ),
      );
      independentSettled = Promise.allSettled(independent);
      const results = await independentSettled;
      independentCompleted = results.every((result) => result.status === "fulfilled");
      const cleanup = handleMailGmailPseudoFolderCleanupTask(cleanupPool, async () => LABELS);
      cleanupSettled = Promise.allSettled([cleanup]);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await admin.query<{ query: string }>(
          "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (rows[0]) {
          blockedQuery = rows[0].query;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      outcomes = await Promise.all([
        syncSettled,
        cleanupSettled ?? Promise.resolve([]),
        independentSettled ?? Promise.resolve([]),
      ]);
      await syncPool.end();
      await cleanupPool.end();
    }
    expect(outcomes.flat().map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(independentCompleted).toBe(true);
    expect(await foldersOf(otherMailbox, "other-mailbox")).toEqual(["INBOX"]);
    expect(await foldersOf(otherTenantMailbox, "other-tenant")).toEqual(["INBOX"]);
    expect(blockedQuery).toMatch(/pg_advisory_xact_lock/i);
    expect(await foldersOf(params, "overlap")).toEqual(["INBOX"]);
  }, 15_000);

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
