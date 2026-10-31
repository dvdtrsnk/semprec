import { inTenantZero } from "../../testSupport/tenantFixtures.js";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { convergeObservedEmailFlagsWithClient } from "../../chokePoint/itemWrites.js";
import { upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { mailAccountSyncJobKey } from "../mailSyncJob.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import "../../domainWriteHooks.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { withTransaction } from "../../db/pool.js";
import { ingestEmailMessage } from "../ingest.js";
import { listPendingImapFlagWrites } from "../mailMessageFlagSyncStore.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { createHash } from "node:crypto";

let pool: Pool;
let chokePoint: ChokePoint;

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
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function relationDefinitionIdFor(propertyId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
    [propertyId],
  );
  if (!rows[0]) throw new Error(`Relation definition for property '${propertyId}' was not seeded`);
  return rows[0].id;
}

function tenantIt(name: string, test: () => Promise<void>): void {
  it(name, () => inTenantZero(test));
}
async function queuedSyncs() {
  const { rows } = await pool.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC],
  );
  return rows;
}

/** Issue #659: the mail flag-sync write moves from a direct `chokePoint/itemWrites.ts` import to `mailMessageFlagsItemUpdateHook`, run through the choke point's per-process registry. */
describe("mailMessageFlagsItemUpdateHook, run through the choke point's registry (issue #659)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function ingestedEmail() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProperties = await chokePoint.listProperties(emailsId);
    const folderProperty = emailProperties.find((p) => p.key === "folder")!;
    const attachmentsProperty = emailProperties.find((p) => p.key === "attachments")!;
    const mailboxFolderProperty = (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!;

    const { mailboxItemId, inboxItemId } = await withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Work", provider: "generic" },
      });
      const inbox = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX", behavior: "folder", providerId: "INBOX" } },
        { allowedSystemKeys: ["name", "behavior", "providerId"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderProperty.id, callerItemId: inbox.id, targetItemId: mailbox.id },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
      return { mailboxItemId: mailbox.id, inboxItemId: inbox.id };
    });

    const { itemId } = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: inboxItemId,
        mailboxItemId,
        folderUid: 7,
        messageId: "<hook@example.com>",
        subject: "Hook",
        envelope: {},
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        flags: [],
      }),
    );

    return {
      emailsId,
      itemId,
      folderRelationDefinitionId: await relationDefinitionIdFor(folderProperty.id),
      mailboxFolderRelationDefinitionId: await relationDefinitionIdFor(mailboxFolderProperty.id),
      mailboxItemId,
    };
  }

  tenantIt("records the desired flag state through the registry when an Emails item is patched", async () => {
    const { emailsId, itemId, folderRelationDefinitionId, mailboxFolderRelationDefinitionId, mailboxItemId } =
      await ingestedEmail();

    await chokePoint.updateItem({ databaseId: emailsId, itemId, propertiesPatch: { read: true } });

    const pending = await listPendingImapFlagWrites(pool, {
      folderRelationDefinitionId,
      mailboxFolderRelationDefinitionId,
      mailboxItemId,
    });
    expect(await queuedSyncs()).toEqual([{ key: mailAccountSyncJobKey(mailboxItemId) }]);
    expect(pending).toEqual([
      { messageItemId: itemId, propertyKey: "read", desiredState: true, folderPath: "INBOX", uid: 7 },
    ]);
  });

  tenantIt("leaves no row when the transaction patching the item rolls back", async () => {
    const { emailsId, itemId, folderRelationDefinitionId, mailboxFolderRelationDefinitionId, mailboxItemId } =
      await ingestedEmail();

    await expect(
      withTransaction(pool, async (client) => {
        await updateItemWithClient(client, { databaseId: emailsId, itemId, propertiesPatch: { read: true } });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const pending = await listPendingImapFlagWrites(pool, {
      folderRelationDefinitionId,
      mailboxFolderRelationDefinitionId,
      mailboxItemId,
    });
    expect(pending).toEqual([]);
    expect(await queuedSyncs()).toEqual([]);
  });
  tenantIt("deduplicates patches of two messages in one mailbox", async () => {
    const { emailsId, itemId, mailboxItemId } = await ingestedEmail();
    const second = await withTransaction(pool, async (client) => {
      const row = await createItemWithClient(client, { databaseId: emailsId, properties: {} });
      await upsertMailMessageMeta(client, {
        itemId: row.id,
        messageId: "<second@example.com>",
        mailboxItemId,
        envelope: {},
      });
      return row;
    });
    await chokePoint.updateItem({ databaseId: emailsId, itemId, propertiesPatch: { read: true } });
    await chokePoint.updateItem({ databaseId: emailsId, itemId: second.id, propertiesPatch: { flagged: true } });
    expect(await queuedSyncs()).toEqual([{ key: mailAccountSyncJobKey(mailboxItemId) }]);
  });
  tenantIt("queues a sync for an agent-originated generic patch", async () => {
    const { emailsId, itemId, mailboxItemId } = await ingestedEmail();
    await chokePoint.updateItem(
      { databaseId: emailsId, itemId, propertiesPatch: { flagged: true } },
      undefined,
      undefined,
      { writerKind: "agent" },
    );
    expect(await queuedSyncs()).toEqual([{ key: mailAccountSyncJobKey(mailboxItemId) }]);
  });
  tenantIt("does not queue a provider observation", async () => {
    const { emailsId, itemId } = await ingestedEmail();
    await withTransaction(pool, (client) =>
      convergeObservedEmailFlagsWithClient(client, { databaseId: emailsId, itemId, propertiesPatch: { read: true } }),
    );
    expect(await queuedSyncs()).toEqual([]);
  });
  tenantIt("does not queue a draft without meta", async () => {
    const emailsId = await databaseIdFor("emails");
    const draft = await chokePoint.createItem({ databaseId: emailsId, properties: {} });
    await chokePoint.updateItem({ databaseId: emailsId, itemId: draft.id, propertiesPatch: { read: true } });
    expect(await queuedSyncs()).toEqual([]);
  });
  tenantIt("does not queue a legacy meta row with no mailbox", async () => {
    const emailsId = await databaseIdFor("emails");
    const item = await chokePoint.createItem({ databaseId: emailsId, properties: {} });
    await upsertMailMessageMeta(pool, {
      itemId: item.id,
      messageId: "<legacy@example.com>",
      mailboxItemId: null,
      envelope: {},
    });
    await chokePoint.updateItem({ databaseId: emailsId, itemId: item.id, propertiesPatch: { read: true } });
    expect(await queuedSyncs()).toEqual([]);
  });
  tenantIt("does not queue a patch without flag values", async () => {
    const { emailsId, itemId } = await ingestedEmail();
    await chokePoint.updateItem({ databaseId: emailsId, itemId, propertiesPatch: {} });
    expect(await queuedSyncs()).toEqual([]);
  });
});
