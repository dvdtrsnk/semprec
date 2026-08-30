import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, createRelationWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { createEmailDraft } from "../mail/draft.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { getMailMessageMetaByItemId, getMailMessageMetaByMessageId } from "../mail/mailMessageMetaStore.js";
import { sendDraftEmail, assertEmailSendAuthorized, noopMailSendAdapterFactory, type SendEmailModuleIds } from "../mail/send.js";
import type { MailSmtpClient, OutgoingMailMessage } from "../mail/smtpClient.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function fakeSmtpClient(overrides: Partial<MailSmtpClient> = {}): MailSmtpClient & { sent: OutgoingMailMessage[] } {
  const sent: OutgoingMailMessage[] = [];
  return {
    sent,
    async sendMail(message) {
      sent.push(message);
    },
    ...overrides,
  };
}

describe("drafts and authorized SMTP sending (issue #95)", () => {
  let emailsId: string;
  let foldersId: string;
  let mailboxesId: string;
  let folderRelationPropertyId: string;
  let mailboxFolderRelationPropertyId: string;
  let mailboxId: string;
  let projectsId: string;
  let emailProjectId: string;
  let moduleIds: SendEmailModuleIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);

    emailsId = await databaseIdFor("emails");
    foldersId = await databaseIdFor("folders");
    mailboxesId = await databaseIdFor("mailboxes");

    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;
    mailboxFolderRelationPropertyId = folderProps.find((p) => p.key === "mailbox")!.id;

    projectsId = await databaseIdFor("projects");
    const { rows: emailProjectRows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'name' = 'Email'`,
      [projectsId],
    );
    emailProjectId = emailProjectRows[0].id;

    mailboxId = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "Test", provider: "generic" } }),
    ).then((item) => item.id);

    await withTransaction(pool, async (client) => {
      const drafts = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "Drafts", behavior: "folder", specialPurpose: "drafts" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(client, { relationPropertyId: mailboxFolderRelationPropertyId, itemId: drafts.id, targetItemId: mailboxId });

      const sent = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "Sent", behavior: "folder", specialPurpose: "sent" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(client, { relationPropertyId: mailboxFolderRelationPropertyId, itemId: sent.id, targetItemId: mailboxId });
    });

    moduleIds = { emailsDatabaseId: emailsId, foldersDatabaseId: foldersId, folderRelationPropertyId, mailboxFolderRelationPropertyId };

    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: "s3cr3t" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function draftsFolderId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'drafts'`, [
      foldersId,
    ]);
    return rows[0].id;
  }

  it("email.draft.create writes through the generic item-create path with no authorization check, linked into Drafts", async () => {
    const draftsId = await draftsFolderId();
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

    expect(draft.properties.name).toBe("Hello");
    expect(draft.properties.recipients).toBe("bob@example.com");
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();

    const { rows } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, draftsId],
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects a direct write to an owner:'system' Emails property through the generic create path even for drafting", async () => {
    await expect(chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi" } })).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("rejects a direct write to Projects.emailSendAutonomous through the generic update path — only direct DB access can grant it", async () => {
    await expect(
      chokePoint.updateItem({ databaseId: projectsId, itemId: emailProjectId, propertiesPatch: { emailSendAutonomous: true } }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(false);
  });

  it("a user actor is always authorized to send, no manifest needed", () => {
    expect(() => assertEmailSendAuthorized({ type: "user" })).not.toThrow();
  });

  it("an ai_agent actor without capabilities.email.send.autonomous is rejected", async () => {
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(false);
    expect(() => assertEmailSendAuthorized({ type: "ai_agent", manifest })).toThrow(/capabilities.email.send.autonomous/);
  });

  it("an ai_agent actor is authorized once a human grants capabilities.email.send.autonomous", async () => {
    // No generic write path ever sets this (owner: 'system', no declared writer) — a human
    // grants it via direct DB access, exactly as the epic's "project-level authorization
    // decision" describes.
    await pool.query(`UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`, [emailProjectId]);
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(true);
    expect(() => assertEmailSendAuthorized({ type: "ai_agent", manifest })).not.toThrow();
  });

  it("a user send submits exactly once over SMTP, moves the draft from Drafts to Sent, and stores a generated Message-ID", async () => {
    const draftsId = await draftsFolderId();
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

    const smtp = fakeSmtpClient();
    const result = await sendDraftEmail(
      pool,
      {
        mailboxItemId: mailboxId,
        draftItemId: draft.id,
        actor: { type: "user" },
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hello",
        bodyText: "hi bob",
      },
      moduleIds,
      { createSmtpClient: async () => smtp },
    );

    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0].messageId).toBe(result.messageId);
    expect(result.messageId).toMatch(/^<.+@example\.com>$/);

    const meta = await getMailMessageMetaByItemId(pool, draft.id);
    expect(meta?.messageId).toBe(result.messageId);

    const sentId = (await pool.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`, [foldersId]))
      .rows[0].id;
    const { rows: sentRelation } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, sentId],
    );
    expect(sentRelation).toHaveLength(1);

    const { rows: draftRelation } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, draftsId],
    );
    expect(draftRelation).toHaveLength(0);

    // A retried/duplicated call for the same already-sent draft (client retry after a
    // timeout, a double-click) must not submit the message a second time.
    const secondSmtp = fakeSmtpClient();
    await expect(
      sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draft.id,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
          bodyText: "hi bob",
        },
        moduleIds,
        { createSmtpClient: async () => secondSmtp },
      ),
    ).rejects.toMatchObject({ name: "ConflictError" });
    expect(secondSmtp.sent).toHaveLength(0);
  });

  it("an ungranted agent actor gets a 403, no SMTP call, and the draft (folder membership + missing meta) is left unchanged", async () => {
    const draftsId = await draftsFolderId();
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

    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    const smtp = fakeSmtpClient();
    const createSmtpClient = vi.fn(async () => smtp);

    await expect(
      sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draft.id,
          actor: { type: "ai_agent", manifest },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
          bodyText: "hi bob",
        },
        moduleIds,
        { createSmtpClient },
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError", status: 403 });

    expect(createSmtpClient).not.toHaveBeenCalled();
    expect(smtp.sent).toHaveLength(0);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();

    const { rows: draftRelation } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, draftsId],
    );
    expect(draftRelation).toHaveLength(1);

    const refreshed = await chokePoint.getItem(emailsId, draft.id);
    expect(refreshed?.properties.name).toBe("Hello");

    // No approval-queue mechanism exists in this codebase for this case by design (epic #92) —
    // nothing to assert beyond "no such row was created" since no such table exists at all.
  });

  it("a granted agent actor sends successfully, exactly like a user", async () => {
    await pool.query(`UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`, [emailProjectId]);
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));

    const draftsId = await draftsFolderId();
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

    const smtp = fakeSmtpClient();
    const result = await sendDraftEmail(
      pool,
      {
        mailboxItemId: mailboxId,
        draftItemId: draft.id,
        actor: { type: "ai_agent", manifest },
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hello",
        bodyText: "hi bob",
      },
      moduleIds,
      { createSmtpClient: async () => smtp },
    );

    expect(smtp.sent).toHaveLength(1);
    expect(result.itemId).toBe(draft.id);
  });

  it("throws when no SMTP adapter is configured for the composition root, without side effects", async () => {
    const draftsId = await draftsFolderId();
    const draft = await withTransaction(pool, (client) =>
      createEmailDraft(client, {
        emailsDatabaseId: emailsId,
        folderRelationPropertyId,
        draftsFolderItemId: draftsId,
        subject: "Hello",
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
      }),
    );

    await expect(
      sendDraftEmail(
        pool,
        { mailboxItemId: mailboxId, draftItemId: draft.id, actor: { type: "user" }, from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }], subject: "Hello" },
        moduleIds,
        noopMailSendAdapterFactory,
      ),
    ).rejects.toThrow(/No SMTP adapter configured/);
  });

  it("a later IMAP-style reconcile pass observing the same generated Message-ID in Sent converges onto the same item instead of duplicating it", async () => {
    const draftsId = await draftsFolderId();
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

    const smtp = fakeSmtpClient();
    const result = await sendDraftEmail(
      pool,
      {
        mailboxItemId: mailboxId,
        draftItemId: draft.id,
        actor: { type: "user" },
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hello",
        bodyText: "hi bob",
      },
      moduleIds,
      { createSmtpClient: async () => smtp },
    );

    const sentId = (await pool.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`, [foldersId]))
      .rows[0].id;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const filesId = await databaseIdFor("files");

    const reconciled = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: sentId,
        messageId: result.messageId,
        subject: "Hello",
        envelope: { from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi bob",
        attachments: [],
        storage: { async writeStream() { return { byteSize: 0, contentHash: "" }; }, async delete() {} },
        storageKeyPrefix: "test",
      }),
    );

    expect(reconciled.created).toBe(false);
    expect(reconciled.itemId).toBe(draft.id);

    const { rows: itemCount } = await pool.query(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [emailsId]);
    expect(itemCount[0].n).toBe(1);

    const meta = await getMailMessageMetaByMessageId(pool, result.messageId);
    expect(meta?.itemId).toBe(draft.id);
  });
});
