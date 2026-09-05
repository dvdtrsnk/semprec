import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ValidationError } from "../errors.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * Emails/Folders are schema-locked, owner:'system' databases — their rows are written by the
 * sync worker through the stores, not through the generic create path — so these fixtures
 * insert directly, exactly the way mail/ingest.ts does. Everything the mailbox *reads* below
 * still goes through the generic choke-point operations.
 */
async function insertSystemItem(databaseId: string, properties: Record<string, unknown>): Promise<string> {
  const client = await pool.connect();
  try {
    const item = await insertItem(client, { databaseId, properties });
    return item.id;
  } finally {
    client.release();
  }
}

async function relationPropertyId(databaseId: string, key: string): Promise<string> {
  const properties = await chokePoint.listProperties(databaseId);
  const property = properties.find((p) => p.key === key);
  if (!property) throw new Error(`Property '${key}' not found`);
  return property.id;
}

describe("mailbox client view (issue #96)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("registration", () => {
    it("seeds the Emails default view as a registered 'mailbox-client' view resolving to a client component", async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");

      const views = await chokePoint.listViewsByDatabase(emailsId);
      const mailbox = views.find((view) => view.type === MAILBOX_CLIENT_VIEW_TYPE);
      expect(mailbox).toBeDefined();
      expect(mailbox?.isDefault).toBe(true);
      expect(mailbox?.config).toMatchObject({ foldersDatabaseId: foldersId, folderRelationKey: "folder", readPropertyKey: "read" });

      // The registered view type is what the client resolves the renderer through — the
      // backend itself never interprets `clientComponent`.
      expect(viewTypeRegistry.get(MAILBOX_CLIENT_VIEW_TYPE)?.clientComponent).toBe("mailboxClient");
    });

    it("rejects a mailbox-client view whose config is missing the Folders database", async () => {
      const emailsId = await databaseIdFor("emails");
      await expect(
        chokePoint.createView({ databaseId: emailsId, type: MAILBOX_CLIENT_VIEW_TYPE, name: "Broken", config: {} }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a mailbox-scoped config that names an item without the database it lives in", async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const mailboxesId = await databaseIdFor("mailboxes");
      const mailboxItemId = await insertSystemItem(mailboxesId, { name: "Personal" });

      await expect(
        chokePoint.createView({
          databaseId: emailsId,
          type: MAILBOX_CLIENT_VIEW_TYPE,
          name: "Scoped",
          config: { foldersDatabaseId: foldersId, mailboxItemId },
        }),
      ).rejects.toThrow(/mailboxItemId requires mailboxesDatabaseId/);
    });
  });

  describe("reading a mailbox through the generic operations", () => {
    async function seedMailbox() {
      const foldersId = await databaseIdFor("folders");
      const emailsId = await databaseIdFor("emails");
      const mailboxesId = await databaseIdFor("mailboxes");

      const mailboxItemId = await insertSystemItem(mailboxesId, { name: "Personal" });
      const inboxId = await insertSystemItem(foldersId, { name: "Inbox", specialPurpose: "inbox", behavior: "folder" });
      const archiveId = await insertSystemItem(foldersId, { name: "Archive", specialPurpose: "archive", behavior: "folder" });

      const folderMailboxRelation = await relationPropertyId(foldersId, "mailbox");
      for (const folderId of [inboxId, archiveId]) {
        await chokePoint.createRelation({ relationPropertyId: folderMailboxRelation, itemId: folderId, targetItemId: mailboxItemId });
      }

      const emailFolderRelation = await relationPropertyId(emailsId, "folder");
      const link = async (properties: Record<string, unknown>, folderId: string) => {
        const itemId = await insertSystemItem(emailsId, properties);
        await chokePoint.createRelation({ relationPropertyId: emailFolderRelation, itemId, targetItemId: folderId });
        return itemId;
      };

      const unread = await link({ name: "Unread inbox message", read: false }, inboxId);
      const neverFlagged = await link({ name: "Message with no read flag at all" }, inboxId);
      const readMessage = await link({ name: "Read inbox message", read: true }, inboxId);
      const archived = await link({ name: "Archived message", read: false }, archiveId);

      return { foldersId, emailsId, mailboxesId, mailboxItemId, inboxId, archiveId, unread, neverFlagged, readMessage, archived };
    }

    it("lists a folder's messages through the Emails-to-Folders relation", async () => {
      const { emailsId, inboxId, archiveId, archived } = await seedMailbox();

      const inbox = await chokePoint.listItems(emailsId, { filter: { type: "relation_contains", property: "folder", value: inboxId } });
      expect(inbox.items.map((item) => item.properties.name).sort()).toEqual([
        "Message with no read flag at all",
        "Read inbox message",
        "Unread inbox message",
      ]);

      const archive = await chokePoint.listItems(emailsId, { filter: { type: "relation_contains", property: "folder", value: archiveId } });
      expect(archive.items.map((item) => item.id)).toEqual([archived]);
    });

    it("counts a folder's unread messages, treating an absent read flag as unread", async () => {
      const { emailsId, inboxId, archiveId } = await seedMailbox();

      const unreadIn = (folderId: string) =>
        chokePoint.countItems(emailsId, {
          filter: {
            type: "and",
            nodes: [
              { type: "relation_contains", property: "folder", value: folderId },
              { type: "not_equals", property: "read", value: true },
            ],
          },
        });

      expect(await unreadIn(inboxId)).toBe(2);
      expect(await unreadIn(archiveId)).toBe(1);
      expect(await chokePoint.countItems(emailsId, { filter: { type: "relation_contains", property: "folder", value: inboxId } })).toBe(3);
    });

    it("excludes a message once it is unlinked from the folder, and a soft-deleted one always", async () => {
      const { emailsId, inboxId, readMessage, unread } = await seedMailbox();
      const emailFolderRelation = await relationPropertyId(emailsId, "folder");

      await chokePoint.deleteRelation({ relationPropertyId: emailFolderRelation, itemId: readMessage, targetItemId: inboxId });
      await chokePoint.softDeleteItem(emailsId, unread);

      const inbox = await chokePoint.listItems(emailsId, { filter: { type: "relation_contains", property: "folder", value: inboxId } });
      expect(inbox.items.map((item) => item.properties.name)).toEqual(["Message with no read flag at all"]);
    });

    it("finds messages not in a folder via relation_not_contains", async () => {
      const { emailsId, inboxId, archived } = await seedMailbox();

      const outside = await chokePoint.listItems(emailsId, { filter: { type: "relation_not_contains", property: "folder", value: inboxId } });
      expect(outside.items.map((item) => item.id)).toEqual([archived]);
    });

    it("rejects a scalar condition on a relation property and a relation condition on a scalar one", async () => {
      const { emailsId, inboxId } = await seedMailbox();

      await expect(chokePoint.listItems(emailsId, { filter: { type: "equals", property: "folder", value: inboxId } })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        chokePoint.listItems(emailsId, { filter: { type: "relation_contains", property: "name", value: inboxId } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a relation value that is not an item id, before it reaches the query", async () => {
      const { emailsId } = await seedMailbox();

      await expect(
        chokePoint.listItems(emailsId, { filter: { type: "relation_contains", property: "folder", value: "not-an-item-id" } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a read that passes both a filter tree and a raw filter hook", async () => {
      const { emailsId, inboxId } = await seedMailbox();

      await expect(
        chokePoint.countItems(emailsId, {
          filter: { type: "relation_contains", property: "folder", value: inboxId },
          buildFilterSql: () => "true",
        }),
      ).rejects.toThrow(/either 'filter' or 'buildFilterSql'/);
    });

    it("resolves one message's full properties through the generic item operation", async () => {
      const { emailsId, readMessage } = await seedMailbox();
      const item = await chokePoint.getItem(emailsId, readMessage);
      expect(item?.properties).toMatchObject({ name: "Read inbox message", read: true });
    });
  });
});
