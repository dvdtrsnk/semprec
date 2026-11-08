import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { createEmailDraft } from "../mail/draft.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, ingestEmailMessage } from "../mail/ingest.js";
import { getMailMessageMetaByItemId, upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import { handleMailMessagePreviewBackfillTask } from "../mail/mailMessagePreviewBackfillJob.js";
import { buildMailPreview, htmlToPlainText } from "../mail/mailPlainText.js";
import { sendDraftEmail, type SendEmailModuleIds } from "../mail/send.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { recordingTransport, sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";

const storage: BlobStorageWriter = {
  async writeStream() {
    return { byteSize: 0, contentHash: "" };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

describe("buildMailPreview", () => {
  it("collapses whitespace", () => {
    expect(buildMailPreview("  hello \n\n\t world  ")).toBe("hello world");
  });

  it("keeps a text of exactly 200 characters and cuts a longer one to 200", () => {
    expect(buildMailPreview("a".repeat(200))).toHaveLength(200);
    expect(buildMailPreview("a".repeat(201))).toHaveLength(200);
  });

  it("never splits a surrogate pair at the limit", () => {
    const text = `${"a".repeat(199)}\u{1F600}tail`;
    const preview = buildMailPreview(text);
    expect(preview).toBe("a".repeat(199));
    expect(buildMailPreview(`${"a".repeat(198)}\u{1F600}tail`)).toBe(`${"a".repeat(198)}\u{1F600}`);
  });

  it("htmlToPlainText strips tags", () => {
    expect(htmlToPlainText("<p>Hi <b>there</b></p>")).toBe("Hi there");
  });
});

describe("mail preview and ingest time on ingest and send", () => {
  let pool: Pool;
  let chokePoint: ChokePoint;
  let emailsId: string;
  let foldersId: string;
  let filesId: string;
  let mailboxId: string;
  let folderRelationPropertyId: string;
  let attachmentsRelationPropertyId: string;
  let inboxId: string;
  let moduleIds: SendEmailModuleIds;

  async function databaseIdFor(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  }

  async function createFolder(purpose: string): Promise<string> {
    return withTransaction(pool, async (client) => {
      const folder = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: purpose, behavior: "folder", specialPurpose: purpose } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      const mailboxProperty = (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!;
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxProperty.id, callerItemId: folder.id, targetItemId: mailboxId },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
      return folder.id;
    });
  }

  function ingest(messageId: string, body: { bodyText?: string; bodyHtml?: string }, folderItemId = inboxId) {
    return runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId,
          attachmentsRelationPropertyId,
          folderItemId,
          mailboxItemId: mailboxId,
          messageId,
          subject: "Subject",
          envelope: { from: { address: "bob@example.com" }, to: [{ address: "me@example.com" }] },
          attachments: [],
          storage,
          storageKeyPrefix: "test",
          ...body,
        }),
      ),
    );
  }

  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    emailsId = await databaseIdFor("emails");
    foldersId = await databaseIdFor("folders");
    filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;
    attachmentsRelationPropertyId = emailProps.find((p) => p.key === "attachments")!.id;
    mailboxId = await withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Test", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: mailboxesId,
        mailboxItemId: mailbox.id,
        address: "me@example.com",
      });
      return mailbox.id;
    });
    inboxId = await createFolder("inbox");
    moduleIds = {
      emailsDatabaseId: emailsId,
      foldersDatabaseId: foldersId,
      mailboxesDatabaseId: mailboxesId,
      folderRelationPropertyId,
      mailboxFolderRelationPropertyId: (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!
        .id,
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    };
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: "s3cr3t" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores the collapsed, 200-character preview and ingested_at when a text message is ingested", async () => {
    const before = Date.now();
    const { itemId } = await ingest("<text@example.com>", { bodyText: `Hello\n\n  world ${"x".repeat(300)}` });

    const meta = await getMailMessageMetaByItemId(pool, itemId);
    expect(meta?.previewText).toHaveLength(200);
    expect(meta?.previewText?.startsWith("Hello world xxx")).toBe(true);
    expect(meta?.ingestedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("stores a preview without tags for HTML-only mail", async () => {
    const { itemId } = await ingest("<html@example.com>", { bodyHtml: "<div><p>Hi <b>there</b></p><br/>bye</div>" });

    const meta = await getMailMessageMetaByItemId(pool, itemId);
    expect(meta?.previewText).toBe("Hi therebye");
    expect(meta?.previewText).not.toMatch(/[<>]/);
    expect(meta?.ingestedAt).toBeInstanceOf(Date);
  });

  it("sets both columns on the send claim and keeps them when the Sent-folder sync later converges on it", async () => {
    const draftsId = await createFolder("drafts");
    const sentId = await createFolder("sent");
    const draft = await withTransaction(pool, (client) =>
      createEmailDraft(client, {
        emailsDatabaseId: emailsId,
        folderRelationPropertyId,
        draftsFolderItemId: draftsId,
        subject: "Hello",
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        bodyText: "hi bob",
      }),
    );

    const result = await runInTenant(getTenantZeroId(), () =>
      sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draft.id,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
          bodyHtml: "<p>hi   <i>bob</i></p>",
        },
        moduleIds,
        sendAdapters(transportFor(recordingTransport())),
      ),
    );

    const claimed = await getMailMessageMetaByItemId(pool, draft.id);
    expect(claimed?.previewText).toBe("hi bob");
    expect(claimed?.ingestedAt).toBeInstanceOf(Date);

    await ingest(result.messageId, { bodyText: "a different body seen in the Sent folder" }, sentId);

    const after = await getMailMessageMetaByItemId(pool, draft.id);
    expect(after?.previewText).toBe("hi bob");
    expect(after?.ingestedAt?.getTime()).toBe(claimed?.ingestedAt?.getTime());
  });
});

describe("mailMessagePreviewBackfill", () => {
  let admin: Pool;
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;

  async function legacyMessage(tenantId: string, body: string, updatedAt: string): Promise<string> {
    const itemId = await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const emails = await getDatabaseByModuleId(client, "emails");
        if (!emails) throw new Error("Emails database was not seeded");
        const item = await createItemWithClient(
          client,
          { databaseId: emails.id, properties: { name: "Legacy", body } },
          { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
        );
        // No preview or ingest time: this is how a row looked before the columns existed.
        await upsertMailMessageMeta(client, {
          itemId: item.id,
          mailboxItemId: null,
          messageId: `<${randomUUID()}@example.com>`,
          envelope: {},
        });
        return item.id;
      }),
    );
    await admin.query("UPDATE items SET updated_at = $2 WHERE id = $1", [itemId, updatedAt]);
    return itemId;
  }

  async function snapshot(): Promise<{ item_id: string; preview_text: string | null; ingested_at: Date | null }[]> {
    const { rows } = await admin.query(
      "SELECT item_id, preview_text, ingested_at FROM mail_message_meta ORDER BY item_id",
    );
    return rows;
  }

  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(admin);
    await runInTenant(tenantA, () => seedSystem(pool));
    await runInTenant(tenantB, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("fills ingested_at from the item and the preview from its body in every tenant, and a second run changes nothing", async () => {
    const a = await legacyMessage(tenantA, "Hello   from\nA", "2026-01-02T03:04:05.000Z");
    const b = await legacyMessage(tenantB, "y".repeat(500), "2026-02-03T04:05:06.000Z");

    await handleMailMessagePreviewBackfillTask(pool);

    const first = await snapshot();
    const rowA = first.find((r) => r.item_id === a);
    const rowB = first.find((r) => r.item_id === b);
    expect(rowA?.preview_text).toBe("Hello from A");
    expect(rowA?.ingested_at?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(rowB?.preview_text).toBe("y".repeat(200));
    expect(rowB?.ingested_at?.toISOString()).toBe("2026-02-03T04:05:06.000Z");

    await handleMailMessagePreviewBackfillTask(pool);
    expect(await snapshot()).toEqual(first);
  });

  it("does not overwrite values already present", async () => {
    const a = await legacyMessage(tenantA, "from the body", "2026-01-02T03:04:05.000Z");
    await admin.query("UPDATE mail_message_meta SET preview_text = 'kept' WHERE item_id = $1", [a]);

    await handleMailMessagePreviewBackfillTask(pool);

    const row = (await snapshot()).find((r) => r.item_id === a);
    expect(row?.preview_text).toBe("kept");
    expect(row?.ingested_at?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});
