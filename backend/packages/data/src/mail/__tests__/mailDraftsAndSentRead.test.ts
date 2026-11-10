import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool, requireSingleRow, withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { getTestPool, getTenantZeroId, resetDatabase } from "../../testSupport/testDb.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { createEmailDraft } from "../draft.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS } from "../ingest.js";
import { EMAILS_RELATION_CONTEXT } from "../emailsRelationContext.js";
import { runMailDraftsAndSentReadBackfill } from "../mailDraftsAndSentReadBackfill.js";
import { reindexItemSearch, searchItems } from "../search.js";

let adminPool: Pool;
/** Runtime role (semprec_data) pool: row-level security applies to every read and write in this file. */
let dataPool: Pool;

/** The Emails database, its folder relation and the Mailbox's three folders, read from the tenant's own seed. */
interface MailFixture {
  emailsId: string;
  mailboxItemId: string;
  folderPropertyId: string;
  inboxId: string;
  sentId: string;
  draftsId: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/** Creates one Mailbox with its INBOX, Sent and Drafts folders through the production writers. */
async function setUpMail(tenantId: string): Promise<MailFixture> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const emailsId = await requireDatabaseId(client, EMAILS_MODULE_ID);
      const foldersId = await requireDatabaseId(client, FOLDERS_MODULE_ID);
      const mailboxesId = await requireDatabaseId(client, MAILBOXES_MODULE_ID);
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Mailbox", provider: "generic" },
      });
      const mailboxFolderProperty = await propertiesStore.getPropertyByKey(client, foldersId, "mailbox");
      const folderProperty = await propertiesStore.getPropertyByKey(client, emailsId, "folder");
      if (!mailboxFolderProperty || !folderProperty)
        throw new Error("The Emails and Folders relations were not seeded");
      const folder = (providerId: string, specialPurpose: string): Promise<string> =>
        ensureFolderItem(client, {
          foldersDatabaseId: foldersId,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxFolderProperty.id,
          providerId,
          name: providerId,
          behavior: "folder",
          specialPurpose,
        });
      return {
        emailsId,
        mailboxItemId: mailbox.id,
        folderPropertyId: folderProperty.id,
        inboxId: await folder("INBOX", "inbox"),
        sentId: await folder("Sent", "sent"),
        draftsId: await folder("Drafts", "drafts"),
      };
    }),
  );
}

/**
 * A message as it was stored before issue #1461: the fields `createEmailDraft` writes, with no `read`
 * property at all. It is indexed for search, so the unread search can return it.
 */
async function createMessageWithoutReadState(
  client: PoolClient,
  mail: MailFixture,
  folderItemId: string,
  name: string,
): Promise<string> {
  const item = await createItemWithClient(
    client,
    {
      databaseId: mail.emailsId,
      properties: { name, sender: "", recipients: "", body: name, date: new Date().toISOString() },
    },
    { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
  );
  await createRelationWithClient(
    client,
    { relationPropertyId: mail.folderPropertyId, callerItemId: item.id, targetItemId: folderItemId },
    EMAILS_RELATION_CONTEXT,
  );
  await reindexItemSearch(client, { itemId: item.id, databaseId: mail.emailsId, text: name });
  return item.id;
}

/**
 * The item ids the search returns for `query`, sorted, so the assertion does not depend on rank order.
 * The limit is raised above the search's default of 50 so a whole fixture is returned.
 */
async function searchIds(tenantId: string, mail: MailFixture, query: string): Promise<string[]> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const results = await searchItems(client, { databaseId: mail.emailsId, query, limit: 500 });
      return results.map((row) => row.itemId).sort();
    }),
  );
}

interface StoredMessage {
  read: string | null;
  updatedAt: string;
}

/** The stored `read` property (null when absent) and `updated_at` of one item, read through the runtime role. */
async function storedMessage(tenantId: string, itemId: string): Promise<StoredMessage> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ read_value: string | null; updated_at: Date }>(
      `SELECT properties ->> 'read' AS read_value, updated_at FROM items WHERE id = $1`,
      [itemId],
    );
    const row = requireSingleRow(rows, `item ${itemId}`);
    return { read: row.read_value, updatedAt: row.updated_at.toISOString() };
  });
}

/** How many `mail_message_flag_sync_state` rows exist for these items. Zero means no provider write-back is queued. */
async function flagSyncRowCount(tenantId: string, itemIds: string[]): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mail_message_flag_sync_state WHERE message_item_id = ANY($1::uuid[])`,
      [itemIds],
    );
    return requireSingleRow(rows, "mail_message_flag_sync_state count").n;
  });
}

describe("drafts and sent mail are read by definition (issue #1461)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("a new draft is created read and is not found by is:unread, while an unread Inbox message is", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);

    const draft = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => {
        const created = await createEmailDraft(client, {
          emailsDatabaseId: mail.emailsId,
          folderRelationPropertyId: mail.folderPropertyId,
          draftsFolderItemId: mail.draftsId,
          subject: "Draft",
          bodyText: "Draft body",
        });
        await reindexItemSearch(client, { itemId: created.id, databaseId: mail.emailsId, text: "Draft" });
        return created;
      }),
    );
    const inbox = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => createMessageWithoutReadState(client, mail, mail.inboxId, "Unread inbox")),
    );

    expect(draft.properties.read).toBe(true);
    expect(await searchIds(zero, mail, "is:unread")).toEqual([inbox]);
    expect(await searchIds(zero, mail, "is:read")).toEqual([draft.id]);
  });

  it("a draft that is sent keeps its read state and is not found by is:unread", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);

    const draftId = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => {
        const created = await createEmailDraft(client, {
          emailsDatabaseId: mail.emailsId,
          folderRelationPropertyId: mail.folderPropertyId,
          draftsFolderItemId: mail.draftsId,
          subject: "Sent later",
          bodyText: "Body",
        });
        await reindexItemSearch(client, { itemId: created.id, databaseId: mail.emailsId, text: "Sent later" });
        // Mirrors the folder move in mail/send.ts: the same item leaves Drafts and joins Sent.
        await deleteRelationWithClient(
          client,
          { relationPropertyId: mail.folderPropertyId, callerItemId: created.id, targetItemId: mail.draftsId },
          EMAILS_RELATION_CONTEXT,
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: mail.folderPropertyId, callerItemId: created.id, targetItemId: mail.sentId },
          EMAILS_RELATION_CONTEXT,
        );
        return created.id;
      }),
    );
    const inbox = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => createMessageWithoutReadState(client, mail, mail.inboxId, "Unread inbox")),
    );

    expect((await storedMessage(zero, draftId)).read).toBe("true");
    expect(await searchIds(zero, mail, "is:unread")).toEqual([inbox]);
    expect(await searchIds(zero, mail, "is:read")).toEqual([draftId]);
  });

  it("a sent message that was never marked read is not found by is:unread, while an unread Inbox message is", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);

    const sent = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => createMessageWithoutReadState(client, mail, mail.sentId, "Sent unread")),
    );
    const inbox = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => createMessageWithoutReadState(client, mail, mail.inboxId, "Unread inbox")),
    );

    // Positive control: the free-text search finds the Sent message, so only the is:unread exclusion hides it.
    expect(await searchIds(zero, mail, "Sent unread")).toEqual([sent]);
    expect(await searchIds(zero, mail, "is:unread")).toEqual([inbox]);
    expect(await searchIds(zero, mail, "is:read")).toEqual([]);
  });

  it("the backfill marks old drafts and sent messages read, writes no flag-sync row and leaves unread Inbox mail alone", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);
    const { draft, sent, inbox } = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => ({
        draft: await createMessageWithoutReadState(client, mail, mail.draftsId, "Old draft"),
        sent: await createMessageWithoutReadState(client, mail, mail.sentId, "Old sent"),
        inbox: await createMessageWithoutReadState(client, mail, mail.inboxId, "Unread inbox"),
      })),
    );
    const inboxBefore = await storedMessage(zero, inbox);

    // The composition root that runs this backfill on every deploy, not the function alone.
    await runTenantCutoverMigrations(dataPool);

    expect((await storedMessage(zero, draft)).read).toBe("true");
    expect((await storedMessage(zero, sent)).read).toBe("true");
    expect(await storedMessage(zero, inbox)).toEqual(inboxBefore);
    expect(await flagSyncRowCount(zero, [draft, sent, inbox])).toBe(0);
    expect(await searchIds(zero, mail, "is:unread")).toEqual([inbox]);
  });

  it("a second run of the backfill changes no row", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);
    const { draft, sent, inbox } = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => ({
        draft: await createMessageWithoutReadState(client, mail, mail.draftsId, "Old draft"),
        sent: await createMessageWithoutReadState(client, mail, mail.sentId, "Old sent"),
        inbox: await createMessageWithoutReadState(client, mail, mail.inboxId, "Unread inbox"),
      })),
    );
    await runTenantCutoverMigrations(dataPool);
    const afterFirstRun = [
      await storedMessage(zero, draft),
      await storedMessage(zero, sent),
      await storedMessage(zero, inbox),
    ];

    await runInTenant(zero, () => runMailDraftsAndSentReadBackfill(dataPool));

    expect([
      await storedMessage(zero, draft),
      await storedMessage(zero, sent),
      await storedMessage(zero, inbox),
    ]).toEqual(afterFirstRun);
    expect(await flagSyncRowCount(zero, [draft, sent, inbox])).toBe(0);
  });

  it("pages through more than one page of old drafts and marks every one read", async () => {
    // 201 is one more than the backfill's page size of 200, so the second page is reached.
    const pageSizePlusOne = 201;
    const zero = getTenantZeroId();
    await seedTenant(zero);
    const mail = await setUpMail(zero);
    const drafts = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => {
        const ids: string[] = [];
        for (let index = 0; index < pageSizePlusOne; index += 1) {
          ids.push(await createMessageWithoutReadState(client, mail, mail.draftsId, `Old draft ${index}`));
        }
        return ids;
      }),
    );
    expect(await searchIds(zero, mail, "is:read")).toEqual([]);

    await runInTenant(zero, () => runMailDraftsAndSentReadBackfill(dataPool));

    expect(await searchIds(zero, mail, "is:read")).toEqual([...drafts].sort());
    expect(await flagSyncRowCount(zero, drafts)).toBe(0);
  }, 120_000);

  it("does nothing in a tenant without an Emails database", async () => {
    // beforeEach leaves tenant zero unseeded, so it has no Emails database.
    const zero = getTenantZeroId();

    await expect(runInTenant(zero, () => runMailDraftsAndSentReadBackfill(dataPool))).resolves.toBeUndefined();

    const databaseCount = await runInTenant(zero, async () => {
      const { rows } = await dataPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM databases`);
      return requireSingleRow(rows, "databases count").n;
    });
    expect(databaseCount).toBe(0);
  });
});
