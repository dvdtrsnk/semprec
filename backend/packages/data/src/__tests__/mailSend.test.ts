import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { createEmailDraft } from "../mail/draft.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { getMailMessageMetaByItemId, getMailMessageMetaByMailboxAndMessageId } from "../mail/mailMessageMetaStore.js";
import {
  sendDraftEmail,
  assertEmailSendAuthorized,
  noopMailSendAdapterFactory,
  type SendEmailModuleIds,
} from "../mail/send.js";
import type { MailTransport } from "../mail/mailTransport.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { linkEmailEnvelopeToPeople } from "../mail/personLinkingActions.js";
import { recordingTransport, sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
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
    emailProjectId = emailProjectRows[0]!.id;

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

    await withTransaction(pool, async (client) => {
      const drafts = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "Drafts", behavior: "folder", specialPurpose: "drafts" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: drafts.id, targetItemId: mailboxId },
        { ownerProcess: FOLDERS_MODULE_ID },
      );

      const sent = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "Sent", behavior: "folder", specialPurpose: "sent" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: sent.id, targetItemId: mailboxId },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
    });

    moduleIds = {
      emailsDatabaseId: emailsId,
      foldersDatabaseId: foldersId,
      mailboxesDatabaseId: mailboxesId,
      folderRelationPropertyId,
      mailboxFolderRelationPropertyId,
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    };

    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: "s3cr3t" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function draftsFolderId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'drafts'`,
      [foldersId],
    );
    return rows[0]!.id;
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
    await expect(chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi" } })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("rejects a direct write to emailSendAutonomous through the generic update path — it isn't even a declared property, only direct DB access can grant it", async () => {
    await expect(
      chokePoint.updateItem({
        databaseId: projectsId,
        itemId: emailProjectId,
        propertiesPatch: { emailSendAutonomous: true },
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(false);
  });

  it("a user actor is always authorized to send, no manifest needed", () => {
    expect(() => assertEmailSendAuthorized({ type: "user" })).not.toThrow();
  });

  it("an ai_agent actor without capabilities.email.send.autonomous is rejected", async () => {
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(false);
    expect(() => assertEmailSendAuthorized({ type: "ai_agent", manifest })).toThrow(
      /capabilities.email.send.autonomous/,
    );
  });

  it("an ai_agent actor is authorized once a human grants capabilities.email.send.autonomous", async () => {
    // No generic write path ever sets this (owner: 'system', no declared writer) — a human
    // grants it via direct DB access, exactly as the epic's "project-level authorization
    // decision" describes.
    await pool.query(
      `UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`,
      [emailProjectId],
    );
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

    const smtp = recordingTransport();
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
      sendAdapters(transportFor(smtp)),
    );

    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.raw.toString("utf8")).toContain(`Message-ID: ${result.messageId}\r\n`);
    expect(smtp.sent[0]!.envelope).toEqual({ from: "me@example.com", recipients: ["bob@example.com"] });
    expect(result.messageId).toMatch(/^<.+@example\.com>$/);

    const meta = await getMailMessageMetaByItemId(pool, draft.id);
    expect(meta?.messageId).toBe(result.messageId);

    const sentId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`,
        [foldersId],
      )
    ).rows[0]!.id;
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
    const secondSmtp = recordingTransport();
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
        sendAdapters(transportFor(secondSmtp)),
      ),
    ).rejects.toMatchObject({ name: "ConflictError" });
    expect(secondSmtp.sent).toHaveLength(0);
  });

  it("two genuinely concurrent sends of the same draft submit over SMTP exactly once between them", async () => {
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

    const smtpA = recordingTransport();
    const smtpB = recordingTransport();
    const send = (smtp: ReturnType<typeof recordingTransport>) =>
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
        sendAdapters(transportFor(smtp)),
      );

    const [a, b] = await Promise.allSettled([send(smtpA), send(smtpB)]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ name: "ConflictError" });

    // The claim (mail_message_meta insert) is what arbitrates the race, before either call
    // reaches SMTP — so at most one of the two clients should ever have sent anything.
    expect(smtpA.sent.length + smtpB.sent.length).toBe(1);
  });

  it("undoes the send claim when SMTP itself fails, so a genuine retry can still send", async () => {
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

    const failingSmtp = recordingTransport({
      async send() {
        throw new Error("SMTP server rejected the message");
      },
    });

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
        sendAdapters(transportFor(failingSmtp)),
      ),
    ).rejects.toThrow(/SMTP server rejected/);

    // The failed attempt's claim must not persist — the draft is neither "sent" nor stuck.
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    const { rows: draftRelation } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, draftsId],
    );
    expect(draftRelation).toHaveLength(1);

    const workingSmtp = recordingTransport();
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
      sendAdapters(transportFor(workingSmtp)),
    );
    expect(workingSmtp.sent).toHaveLength(1);
    expect(result.itemId).toBe(draft.id);
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
    const smtp = recordingTransport();
    const forMailbox = vi.fn(async () => smtp);

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
        sendAdapters({ forMailbox }),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError", status: 403 });

    expect(forMailbox).not.toHaveBeenCalled();
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
    await pool.query(
      `UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`,
      [emailProjectId],
    );
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

    const smtp = recordingTransport();
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
      sendAdapters(transportFor(smtp)),
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
        {
          mailboxItemId: mailboxId,
          draftItemId: draft.id,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
        },
        moduleIds,
        noopMailSendAdapterFactory,
      ),
    ).rejects.toThrow(/No SMTP adapter configured/);
  });

  it("throws when the transports are configured but no attachment storage is, without side effects", async () => {
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

    const smtp = recordingTransport();
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
        },
        moduleIds,
        { transports: transportFor(smtp) },
      ),
    ).rejects.toThrow(/No SMTP adapter configured/);

    expect(smtp.sent).toHaveLength(0);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
  });

  it("rejects a From address that isn't one of the mailbox's registered addresses, before any claim or SMTP call", async () => {
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

    const smtp = recordingTransport();
    await expect(
      sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draft.id,
          actor: { type: "user" },
          from: { address: "spoofed@somewhere-else.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
        },
        moduleIds,
        sendAdapters(transportFor(smtp)),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });

    expect(smtp.sent).toHaveLength(0);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
  });

  it("rejects an unknown mailboxItemId with NotFoundError, before the from-address check", async () => {
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

    const smtp = recordingTransport();
    const unknownMailboxId = "00000000-0000-0000-0000-000000000000";
    await expect(
      sendDraftEmail(
        pool,
        {
          mailboxItemId: unknownMailboxId,
          draftItemId: draft.id,
          actor: { type: "user" },
          from: { address: "spoofed@somewhere-else.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
        },
        moduleIds,
        sendAdapters(transportFor(smtp)),
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });

    expect(smtp.sent).toHaveLength(0);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
  });

  it("rejects sending over a soft-deleted mailbox with NotFoundError, not ForbiddenError", async () => {
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

    await chokePoint.softDeleteItem(mailboxesId, mailboxId);

    const smtp = recordingTransport();
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
        },
        moduleIds,
        sendAdapters(transportFor(smtp)),
      ),
    ).rejects.toMatchObject({ name: "NotFoundError" });

    expect(smtp.sent).toHaveLength(0);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
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

    const smtp = recordingTransport();
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
      sendAdapters(transportFor(smtp)),
    );

    const sentId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`,
        [foldersId],
      )
    ).rows[0]!.id;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const filesId = await databaseIdFor("files");

    const reconciled = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: sentId,
        mailboxItemId: mailboxId,
        messageId: result.messageId,
        subject: "Hello",
        envelope: { from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }] },
        bodyText: "hi bob",
        attachments: [],
        storage: {
          async writeStream() {
            return { byteSize: 0, contentHash: "" };
          },
          async delete() {},
          readStream() {
            throw new Error("readStream is not used by this test");
          },
        },
        storageKeyPrefix: "test",
      }),
    );

    expect(reconciled.created).toBe(false);
    expect(reconciled.itemId).toBe(draft.id);

    const { rows: itemCount } = await pool.query(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [
      emailsId,
    ]);
    expect(itemCount[0].n).toBe(1);

    const meta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
    expect(meta?.itemId).toBe(draft.id);
    expect(meta?.mailboxItemId).toBe(mailboxId);
  });

  it("a send with an HTML body carries the HTML part beside the text part in the raw message", async () => {
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

    const smtp = recordingTransport();
    await sendDraftEmail(
      pool,
      {
        mailboxItemId: mailboxId,
        draftItemId: draft.id,
        actor: { type: "user" },
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hello",
        bodyText: "hi bob",
        bodyHtml: "<p>hi <b>bob</b></p>",
      },
      moduleIds,
      sendAdapters(transportFor(smtp)),
    );

    const raw = smtp.sent[0]!.raw.toString("utf8");
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).toContain("<p>hi <b>bob</b></p>");
  });

  it("bcc recipients reach the SMTP envelope and no header of the raw message", async () => {
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

    const smtp = recordingTransport();
    await sendDraftEmail(
      pool,
      {
        mailboxItemId: mailboxId,
        draftItemId: draft.id,
        actor: { type: "user" },
        from: { address: "me@example.com" },
        to: [{ address: "bob@example.com" }],
        bcc: [{ address: "hidden@example.com" }],
        subject: "Hello",
        bodyText: "hi bob",
      },
      moduleIds,
      sendAdapters(transportFor(smtp)),
    );

    expect(smtp.sent[0]!.envelope).toEqual({
      from: "me@example.com",
      recipients: ["bob@example.com", "hidden@example.com"],
    });
    expect(smtp.sent[0]!.raw.toString("utf8")).not.toContain("hidden@example.com");
  });

  it("a transport that cannot be built leaves the draft unclaimed, in Drafts, and sends nothing", async () => {
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

    const forMailbox = vi.fn(async () => {
      throw new Error("Mailbox has no SMTP server settings");
    });
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
        sendAdapters({ forMailbox }),
      ),
    ).rejects.toThrow(/no SMTP server settings/);

    expect(forMailbox).toHaveBeenCalledTimes(1);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    const { rows: draftRelation } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, draft.id, draftsId],
    );
    expect(draftRelation).toHaveLength(1);
  });

  describe("transport choice by sync mode", () => {
    async function draftId(): Promise<string> {
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
      return draft.id;
    }

    /** Sends one draft and returns the sync mode the factory was asked for. */
    async function sendAndRecordMode(): Promise<string[]> {
      const requested: string[] = [];
      const smtp = recordingTransport();
      await sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: await draftId(),
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Hello",
          bodyText: "hi bob",
        },
        moduleIds,
        sendAdapters({
          forMailbox: async (_mailboxItemId, syncMode) => {
            requested.push(syncMode);
            return smtp;
          },
        }),
      );
      return requested;
    }

    it("uses the sync mode of the mailbox's sync-state row when one exists", async () => {
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailboxId, syncMode: "gmail_api" }),
      );
      expect(await sendAndRecordMode()).toEqual(["gmail_api"]);
    });

    it("without a sync-state row, uses the default mode of the mailbox's provider", async () => {
      // raw SQL: the fixture mailbox has no sync-state row yet, and the test needs its provider to be gmail.
      await pool.query(`UPDATE items SET properties = properties || '{"provider":"gmail"}'::jsonb WHERE id = $1`, [
        mailboxId,
      ]);
      expect(await sendAndRecordMode()).toEqual(["gmail_api"]);
    });

    it("without a sync-state row or a provider property, uses the generic default, IMAP", async () => {
      // raw SQL: removes the provider the fixture sets, so the mailbox has no provider property at all.
      await pool.query(`UPDATE items SET properties = properties - 'provider' WHERE id = $1`, [mailboxId]);
      expect(await sendAndRecordMode()).toEqual(["imap"]);
    });
  });

  describe("threading of sent messages (issue #1474)", () => {
    const storage = {
      async writeStream() {
        return { byteSize: 0, contentHash: "" };
      },
      async delete() {},
      readStream(): never {
        throw new Error("readStream is not used by this test");
      },
    };

    async function sentFolderId(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`,
        [foldersId],
      );
      return rows[0]!.id;
    }

    async function ingestSynced(messageId: string, mailbox = mailboxId, folder?: string): Promise<void> {
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      await withTransaction(pool, async (client) => {
        await ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: await databaseIdFor("files"),
          folderRelationPropertyId,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder ?? (await sentFolderId()),
          mailboxItemId: mailbox,
          messageId,
          subject: "Original",
          envelope: { from: { address: "bob@example.com" }, to: [{ address: "me@example.com" }] },
          bodyText: "question",
          attachments: [],
          storage,
          storageKeyPrefix: "test",
        });
      });
    }

    async function newDraft(): Promise<string> {
      const draft = await withTransaction(pool, async (client) =>
        createEmailDraft(client, {
          emailsDatabaseId: emailsId,
          folderRelationPropertyId,
          draftsFolderItemId: await draftsFolderId(),
          subject: "Re: Original",
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          bodyText: "answer",
        }),
      );
      return draft.id;
    }

    function send(draftItemId: string, smtp: MailTransport, threadHeaders: { inReplyTo?: string } = {}) {
      return sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Re: Original",
          bodyText: "answer",
          inReplyTo: threadHeaders.inReplyTo,
          references: threadHeaders.inReplyTo ? [threadHeaders.inReplyTo] : undefined,
        },
        moduleIds,
        sendAdapters(transportFor(smtp)),
      );
    }

    async function threadCount(): Promise<number> {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_threads`);
      return rows[0]!.n;
    }

    it("a reply to a synced message joins that message's thread", async () => {
      await ingestSynced("<orig@example.com>");
      const original = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, "<orig@example.com>");
      expect(original?.threadId).toBeTruthy();

      const smtp = recordingTransport();
      const result = await send(await newDraft(), smtp, { inReplyTo: "<orig@example.com>" });

      const sent = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
      expect(sent?.threadId).toBe(original?.threadId);
      expect(await threadCount()).toBe(1);
      expect(smtp.sent).toHaveLength(1);
      const raw = smtp.sent[0]?.raw.toString("utf8");
      expect(raw).toContain(`Message-ID: ${result.messageId}\r\n`);
      expect(raw).toContain("In-Reply-To: <orig@example.com>\r\n");
      expect(raw).toContain("References: <orig@example.com>\r\n");
    });

    it("threads an outgoing reply using an ancestor in another mailbox of the same tenant", async () => {
      const other = await withTransaction(pool, async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name: "Other", provider: "generic" },
        });
        const folder = await createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "Other Sent", behavior: "folder", specialPurpose: "sent" } },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: folder.id, targetItemId: mailbox.id },
          { ownerProcess: FOLDERS_MODULE_ID },
        );
        return { mailboxId: mailbox.id, folderId: folder.id };
      });
      await ingestSynced("<other@example.com>", other.mailboxId, other.folderId);
      const ancestor = await getMailMessageMetaByMailboxAndMessageId(pool, other.mailboxId, "<other@example.com>");
      const smtp = recordingTransport();
      const sent = await send(await newDraft(), smtp, { inReplyTo: "<other@example.com>" });
      const meta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, sent.messageId);
      expect(ancestor?.threadId).toBeTruthy();
      expect(meta?.threadId).toBe(ancestor?.threadId);
      expect(meta?.itemId).not.toBe(ancestor?.itemId);
      expect(smtp.sent).toHaveLength(1);
      expect(smtp.sent[0]?.raw.toString("utf8")).toContain("In-Reply-To: <other@example.com>\r\n");
      expect(await threadCount()).toBe(1);
    });

    it("a send without ancestors starts a new thread that a later reply joins", async () => {
      const first = await send(await newDraft(), recordingTransport());
      const firstMeta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, first.messageId);
      expect(firstMeta?.threadId).toBeTruthy();
      expect(await threadCount()).toBe(1);

      const second = await send(await newDraft(), recordingTransport(), { inReplyTo: first.messageId });
      const secondMeta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, second.messageId);
      expect(secondMeta?.threadId).toBe(firstMeta?.threadId);
      expect(await threadCount()).toBe(1);
    });

    it("a later Sent-folder sync of the same message id keeps the thread and creates no second one", async () => {
      const result = await send(await newDraft(), recordingTransport());
      const before = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);

      await ingestSynced(result.messageId);

      const after = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
      expect(after?.threadId).toBe(before?.threadId);
      expect(await threadCount()).toBe(1);
    });

    it("an SMTP failure removes the claim and leaves no orphan thread, and a retry threads again", async () => {
      const draftId = await newDraft();
      const failing = recordingTransport({
        async send() {
          throw new Error("SMTP server rejected the message");
        },
      });
      await expect(send(draftId, failing)).rejects.toThrow(/SMTP server rejected/);
      expect(await getMailMessageMetaByItemId(pool, draftId)).toBeNull();
      expect(await threadCount()).toBe(0);

      const result = await send(draftId, recordingTransport());
      const meta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
      expect(meta?.threadId).toBeTruthy();
      expect(await threadCount()).toBe(1);
    });

    it("an SMTP failure on a reply keeps the shared thread", async () => {
      await ingestSynced("<orig@example.com>");
      const failing = recordingTransport({
        async send() {
          throw new Error("SMTP server rejected the message");
        },
      });
      await expect(send(await newDraft(), failing, { inReplyTo: "<orig@example.com>" })).rejects.toThrow(/rejected/);
      expect(await threadCount()).toBe(1);
    });

    it("a lost claim race ends in ConflictError and leaves no extra thread", async () => {
      const draftId = await newDraft();
      await send(draftId, recordingTransport());
      await expect(send(draftId, recordingTransport())).rejects.toThrow(/already being sent or was already sent/);
      expect(await threadCount()).toBe(1);
    });
  });

  describe("people linking of sent mail (issue #1480)", () => {
    /** A Person whose `emails` property and `person_email_index` rows both list the given addresses. */
    async function personOwning(name: string, addresses: string[]): Promise<string> {
      const peopleId = await databaseIdFor("people");
      const person = await chokePoint.createItem({
        databaseId: peopleId,
        properties: { name, emails: addresses.join("\n") },
      });
      await withTransaction(pool, (client) => reindexPersonEmails(client, person.id, addresses));
      return person.id;
    }

    /** Creates a draft with the given subject and returns its Emails item id, without sending it. */
    async function newDraftWithSubject(subject: string): Promise<string> {
      const draftsId = await draftsFolderId();
      const draft = await withTransaction(pool, (client) =>
        createEmailDraft(client, {
          emailsDatabaseId: emailsId,
          folderRelationPropertyId,
          draftsFolderItemId: draftsId,
          subject,
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          bodyText: "hi",
        }),
      );
      return draft.id;
    }

    /** Drafts and sends one message from the mailbox, returning its Emails item id. */
    async function sendMail(options: { to: string[]; cc?: string[]; subject?: string }): Promise<string> {
      const subject = options.subject ?? "Hello";
      const draftId = await newDraftWithSubject(subject);
      await sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draftId,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: options.to.map((address) => ({ address })),
          cc: options.cc?.map((address) => ({ address })),
          subject,
          bodyText: "hi",
        },
        moduleIds,
        sendAdapters(transportFor(recordingTransport())),
      );
      return draftId;
    }

    /** The Person item ids joined to an Emails item through one people relation, sorted. */
    async function linkedPersonIds(
      emailItemId: string,
      propertyKey: "senderPeople" | "recipientsPeople",
    ): Promise<string[]> {
      const { rows } = await pool.query<{ person_id: string }>(
        `SELECT CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END AS person_id
           FROM item_relations r
          WHERE r.relation_definition_id = (
                  SELECT rd.id FROM relation_definitions rd
                    JOIN properties p ON p.id = rd.property_id_a
                   WHERE p.database_id = $1 AND p.key = $3)
            AND (r.item_a = $2 OR r.item_b = $2)
          ORDER BY person_id`,
        [emailsId, emailItemId, propertyKey],
      );
      return rows.map((row) => row.person_id);
    }

    it("a sent message to an address a person owns gets a recipientsPeople edge to that person", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([]);
    });

    it("a sent message from a mailbox address a person owns gets a senderPeople edge to that person", async () => {
      const me = await personOwning("Me", ["me@example.com"]);
      const mailId = await sendMail({ to: ["nobody@example.com"] });

      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([me]);
      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([]);
    });

    it("an address no person owns leaves both people relations empty", async () => {
      await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["stranger@example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([]);
      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([]);
    });

    it("two sent emails to the same person both link, and neither send fails", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const me = await personOwning("Me", ["me@example.com"]);
      const first = await sendMail({ to: ["bob@example.com"], subject: "First" });
      const second = await sendMail({ to: ["bob@example.com"], subject: "Second" });

      expect(await linkedPersonIds(first, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(second, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(first, "senderPeople")).toEqual([me]);
      expect(await linkedPersonIds(second, "senderPeople")).toEqual([me]);
    });

    it("a person listed in both To and Cc gets a single recipientsPeople edge", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"], cc: ["BOB@Example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
    });

    it("linking an email that is already linked adds no duplicate edge and raises no error", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const me = await personOwning("Me", ["me@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"] });
      const envelope = { from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }] };

      await withTransaction(pool, (client) =>
        linkEmailEnvelopeToPeople(client, {
          itemId: mailId,
          envelope,
          emailsDatabaseId: emailsId,
          senderPeopleKey: "senderPeople",
          recipientsPeopleKey: "recipientsPeople",
        }),
      );

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([me]);
    });

    it("a people link that fails rolls back the whole finalization: the draft keeps its subject and stays in Drafts", async () => {
      const peopleId = await databaseIdFor("people");
      const bob = await personOwning("Bob", ["bob@example.com"]);
      // The address index still maps bob@example.com to Bob after he is soft-deleted, so the link
      // is attempted against a deleted endpoint and refused by the choke point.
      await chokePoint.softDeleteItem(peopleId, bob);
      const draftId = await newDraftWithSubject("Draft subject");

      await expect(
        sendDraftEmail(
          pool,
          {
            mailboxItemId: mailboxId,
            draftItemId: draftId,
            actor: { type: "user" },
            from: { address: "me@example.com" },
            to: [{ address: "bob@example.com" }],
            subject: "Final subject",
            bodyText: "hi",
          },
          moduleIds,
          sendAdapters(transportFor(recordingTransport())),
        ),
      ).rejects.toMatchObject({ name: "ValidationError" });

      const { rows: names } = await pool.query<{ name: string }>(
        `SELECT properties ->> 'name' AS name FROM items WHERE id = $1`,
        [draftId],
      );
      expect(names[0]!.name).toBe("Draft subject");
      expect(await linkedPersonIds(draftId, "recipientsPeople")).toEqual([]);
      const { rows: drafts } = await pool.query(
        `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
        [folderRelationPropertyId, draftId, await draftsFolderId()],
      );
      expect(drafts).toHaveLength(1);
    });
  });
});
