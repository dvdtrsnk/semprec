import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import type { Pool, PoolClient } from "pg";
import { createRuntimeRolePool, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { createEmailDraft } from "../mail/draft.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { runMailboxAddressesOwnerCutoverMigration } from "../mail/mailboxAddressesOwnerCutoverMigration.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import {
  getMailMessageMetaByItemId,
  getMailMessageMetaByMailboxAndMessageId,
  resolveMergedThreadId,
} from "../mail/mailMessageMetaStore.js";
import {
  sendDraftEmail,
  assertEmailSendAuthorized,
  noopMailSendAdapterFactory,
  type SendEmailModuleIds,
} from "../mail/send.js";
import { createSentCopySaver, createSmtpMailTransport, type MailTransport } from "../mail/mailTransport.js";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { linkEmailEnvelopeToPeople } from "../mail/personLinkingActions.js";
import { recordingTransport, sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";

const tenantIt = (name: string, fn: () => unknown, timeout?: number) =>
  it(
    name,
    () =>
      inTenantZero(async () => {
        await fn();
      }),
    timeout,
  );

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

  tenantIt(
    "email.draft.create writes through the generic item-create path with no authorization check, linked into Drafts",
    async () => {
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
    },
  );

  tenantIt(
    "rejects a direct write to an owner:'system' Emails property through the generic create path even for drafting",
    async () => {
      await expect(chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi" } })).rejects.toMatchObject({
        name: "ForbiddenError",
      });
    },
  );

  tenantIt(
    "rejects a direct write to emailSendAutonomous through the generic update path — it isn't even a declared property, only direct DB access can grant it",
    async () => {
      await expect(
        chokePoint.updateItem({
          databaseId: projectsId,
          itemId: emailProjectId,
          propertiesPatch: { emailSendAutonomous: true },
        }),
      ).rejects.toMatchObject({ name: "ValidationError" });
      const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
      expect(manifest.capabilities.email.send.autonomous).toBe(false);
    },
  );

  tenantIt("a user actor is always authorized to send, no manifest needed", () => {
    expect(() => assertEmailSendAuthorized({ type: "user" })).not.toThrow();
  });

  tenantIt("an ai_agent actor without capabilities.email.send.autonomous is rejected", async () => {
    const manifest = await withTransaction(pool, (client) => generatePermissionManifest(client, emailProjectId));
    expect(manifest.capabilities.email.send.autonomous).toBe(false);
    expect(() => assertEmailSendAuthorized({ type: "ai_agent", manifest })).toThrow(
      /capabilities.email.send.autonomous/,
    );
  });

  tenantIt("an ai_agent actor is authorized once a human grants capabilities.email.send.autonomous", async () => {
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

  tenantIt(
    "a user send submits exactly once over SMTP, moves the draft from Drafts to Sent, and stores a generated Message-ID",
    async () => {
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
    },
  );

  tenantIt("two genuinely concurrent sends of the same draft submit over SMTP exactly once between them", async () => {
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

  tenantIt("undoes the send claim when SMTP itself fails, so a genuine retry can still send", async () => {
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

  tenantIt(
    "an ungranted agent actor gets a 403, no SMTP call, and the draft (folder membership + missing meta) is left unchanged",
    async () => {
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
    },
  );

  tenantIt("a granted agent actor sends successfully, exactly like a user", async () => {
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

  tenantIt("throws when no SMTP adapter is configured for the composition root, without side effects", async () => {
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

  tenantIt("throws when the transports are configured but no attachment storage is, without side effects", async () => {
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

  tenantIt(
    "rejects a From address that isn't one of the mailbox's registered addresses, before any claim or SMTP call",
    async () => {
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
    },
  );

  tenantIt("rejects an unknown mailboxItemId with NotFoundError, before the from-address check", async () => {
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

  tenantIt("rejects sending over a soft-deleted mailbox with NotFoundError, not ForbiddenError", async () => {
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

  tenantIt(
    "a later IMAP-style reconcile pass observing the same generated Message-ID in Sent converges onto the same item instead of duplicating it",
    async () => {
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

      const sentId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'sent'`,
          [foldersId],
        )
      ).rows[0]!.id;
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: foldersId,
            itemId: sentId,
            propertiesPatch: { providerId: "Sent" },
          },
          { allowedSystemKeys: ["providerId"] },
        ),
      );
      const imapEndpoint = { host: "mail.example.test", port: 993, security: "tls" } as const;
      const smtpEndpoint = { host: "mail.example.test", port: 465, security: "tls" } as const;
      await upsertMailServerSettings(pool, mailboxId, { imap: imapEndpoint, smtp: smtpEndpoint, username: "fixture" });
      const imap = new ImapFlow({ host: "unused.example.test", port: 993, secure: true, logger: false });
      let accepted: Buffer | undefined;
      let copied: Buffer | undefined;
      vi.spyOn(imap, "append").mockImplementation(async (path, raw, flags) => {
        expect(path).toBe("Sent");
        expect(flags).toEqual(["\\Seen"]);
        if (!Buffer.isBuffer(raw)) throw new Error("Expected raw MIME bytes");
        copied = Buffer.from(raw);
        return { destination: "Sent", uidValidity: 1n, uid: 7 };
      });
      vi.spyOn(imap, "logout").mockResolvedValue(undefined);
      vi.spyOn(imap, "close").mockImplementation(() => {});
      const smtp = createSmtpMailTransport(
        mailboxId,
        { endpoint: smtpEndpoint, username: "fixture" },
        { password: "fixture" },
        () => ({
          verify: async () => true,
          sendMail: async (message) => {
            if (!Buffer.isBuffer(message.raw)) throw new Error("Expected raw MIME bytes");
            accepted = Buffer.from(message.raw);
            return { refusedRecipientCount: 0 };
          },
          close: () => {},
        }),
        createSentCopySaver(pool, mailboxId, { password: "fixture" }, async () => new ImapFlowMailClient(imap)),
      );
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

      expect(copied).toBeDefined();
      expect(copied).toEqual(accepted);
      if (!copied) throw new Error("Sent copy was not appended");
      const parsed = await simpleParser(copied);
      expect(parsed.messageId).toBe(result.messageId);
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
          messageId: parsed.messageId ?? "",
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
    },
  );

  tenantIt("a send with an HTML body carries the HTML part beside the text part in the raw message", async () => {
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

  tenantIt("bcc recipients reach the SMTP envelope and no header of the raw message", async () => {
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

  tenantIt("a transport that cannot be built leaves the draft unclaimed, in Drafts, and sends nothing", async () => {
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

    tenantIt("uses the sync mode of the mailbox's sync-state row when one exists", async () => {
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailboxId, syncMode: "gmail_api" }),
      );
      expect(await sendAndRecordMode()).toEqual(["gmail_api"]);
    });

    tenantIt("without a sync-state row, uses the default mode of the mailbox's provider", async () => {
      // raw SQL: the fixture mailbox has no sync-state row yet, and the test needs its provider to be gmail.
      await pool.query(`UPDATE items SET properties = properties || '{"provider":"gmail"}'::jsonb WHERE id = $1`, [
        mailboxId,
      ]);
      expect(await sendAndRecordMode()).toEqual(["gmail_api"]);
    });

    tenantIt("without a sync-state row or a provider property, uses the generic default, IMAP", async () => {
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

    async function ingestSynced(
      messageId: string,
      mailbox = mailboxId,
      folder?: string,
      inReplyTo?: string,
      references?: string[],
      operationPool: Pool = pool,
    ): Promise<void> {
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      await withTransaction(operationPool, async (client) => {
        await ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: await databaseIdFor("files"),
          folderRelationPropertyId,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder ?? (await sentFolderId()),
          mailboxItemId: mailbox,
          messageId,
          inReplyTo,
          references,
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

    function send(
      draftItemId: string,
      smtp: MailTransport,
      threadHeaders: { inReplyTo?: string } = {},
      operationPool: Pool = pool,
    ) {
      return sendDraftEmail(
        operationPool,
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

    for (const competitor of ["send", "ingest", "bridge"] as const) {
      for (const order of ["competitor-first", "cleanup-first"] as const) {
        tenantIt(
          `serializes ${competitor} and failed-send cleanup with ${order}`,
          async () => {
            const ownerPool = pool;
            const runtimePool = await createRuntimeRolePool(ownerPool, "semprec_data");
            const failedPool = await createRuntimeRolePool(ownerPool, "semprec_data");
            const competitorPool = await createRuntimeRolePool(ownerPool, "semprec_data");
            const failedPids: Array<Promise<number>> = [];
            const competitorPids: Array<Promise<number>> = [];
            const recordPid = (client: PoolClient, pids: Array<Promise<number>>) => {
              pids.push(
                client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(({ rows }) => {
                  if (rows[0] === undefined) throw new Error("Missing participant PID");
                  return rows[0].pid;
                }),
              );
            };
            failedPool.on("acquire", (client: PoolClient) => recordPid(client, failedPids));
            competitorPool.on("acquire", (client: PoolClient) => recordPid(client, competitorPids));
            const controller = await ownerPool.connect();
            await controller.query("SET statement_timeout = '3s'");
            await controller.query("SET lock_timeout = '2s'");
            pool = runtimePool;
            const { rows: controllerRows } = await controller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const controllerPid = controllerRows[0]?.pid;
            if (controllerPid === undefined) throw new Error("Missing controller PID");
            let releaseSmtp: () => void = () => undefined;
            let notifySmtp: (id: string) => void = () => undefined;
            const started = new Promise<string>((resolve) => {
              notifySmtp = resolve;
            });
            const smtpGate = new Promise<void>((resolve) => {
              releaseSmtp = resolve;
            });
            const smtp = recordingTransport({
              async send(message) {
                const match = /^Message-ID: (.+)\r$/m.exec(message.raw.toString("utf8"));
                if (!match?.[1]) throw new Error("Missing Message-ID");
                notifySmtp(match[1]);
                await smtpGate;
                throw new Error("owned SMTP refusal");
              },
            });
            let failedSend: Promise<unknown> | undefined;
            let other: Promise<{ success: true; value: unknown } | { success: false; error: unknown }> | undefined;
            async function bounded<T>(promise: Promise<T>): Promise<T> {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  promise,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Mail overlap timed out")), 5000);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            const waitBlocked = async (
              holder: number,
              queryText: string,
              pids: Array<Promise<number>>,
            ): Promise<number> => {
              const deadline = Date.now() + 5000;
              while (Date.now() < deadline) {
                const { rows } = await ownerPool.query<{ pid: number; blockers: number[]; query: string }>(
                  "SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
                );
                const owned = await bounded(Promise.all(pids));
                const blocked = rows.find(
                  (row) => owned.includes(row.pid) && row.blockers.includes(holder) && row.query.includes(queryText),
                );
                if (blocked) return blocked.pid;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              throw new Error(`No backend blocked by ${holder} during ${queryText}`);
            };
            try {
              const runtimeRole = await runtimePool.query<{ name: string; bypass: boolean; superuser: boolean }>(
                "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
              );
              expect(runtimeRole.rows[0]).toEqual({ name: "semprec_data", bypass: false, superuser: false });
              const anchorIds: string[] = [];
              if (competitor === "bridge") {
                for (const id of ["<bridge-anchor@example.com>", "<bridge-other@example.com>"]) {
                  await ingestSynced(id);
                  const meta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, id);
                  if (!meta?.threadId) throw new Error("Missing bridge anchor thread");
                  anchorIds.push(meta.threadId);
                }
                expect(new Set(anchorIds).size).toBe(2);
              }
              const failedDraft = await newDraft();
              const otherDraft = competitor === "send" ? await newDraft() : undefined;
              failedSend = send(failedDraft, smtp, {}, failedPool).then(
                () => ({ success: true }),
                (error: unknown) => ({ success: false, error }),
              );
              const messageId = await bounded(started);
              const original = await getMailMessageMetaByItemId(pool, failedDraft);
              if (!original?.threadId) throw new Error("Missing original claim thread");
              await controller.query("SELECT pg_advisory_lock(712340002)");
              // Fixed test triggers pause a real production statement without changing its behavior.
              if (order === "competitor-first") {
                await ownerPool.query(
                  "CREATE FUNCTION test_mail_guard_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(712340002); RETURN NEW; END $$",
                );
                await ownerPool.query(
                  "CREATE TRIGGER test_mail_guard_gate AFTER INSERT ON mail_message_meta FOR EACH ROW WHEN (NEW.in_reply_to IS NOT NULL) EXECUTE FUNCTION test_mail_guard_gate()",
                );
              } else {
                await ownerPool.query(
                  "CREATE FUNCTION test_mail_guard_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(712340002); RETURN OLD; END $$",
                );
                await ownerPool.query(
                  "CREATE TRIGGER test_mail_guard_gate BEFORE DELETE ON mail_threads FOR EACH ROW EXECUTE FUNCTION test_mail_guard_gate()",
                );
              }
              const startCompetitor = () =>
                competitor === "send"
                  ? send(otherDraft ?? "", recordingTransport(), { inReplyTo: messageId }, competitorPool)
                  : ingestSynced(
                      "<guarded-reply@example.com>",
                      mailboxId,
                      undefined,
                      messageId,
                      competitor === "bridge"
                        ? ["<bridge-anchor@example.com>", "<bridge-other@example.com>"]
                        : undefined,
                      competitorPool,
                    );
              let holderPid: number;
              let waiterPid: number;
              if (order === "competitor-first") {
                other = startCompetitor().then(
                  (value) => ({ success: true, value }),
                  (error: unknown) => ({ success: false, error }),
                );
                holderPid = await waitBlocked(controllerPid, "INSERT INTO mail_message_meta", competitorPids);
                releaseSmtp();
                waiterPid = await waitBlocked(holderPid, "pg_advisory_xact_lock", failedPids);
              } else {
                releaseSmtp();
                holderPid = await waitBlocked(controllerPid, "DELETE FROM mail_threads", failedPids);
                other = startCompetitor().then(
                  (value) => ({ success: true, value }),
                  (error: unknown) => ({ success: false, error }),
                );
                waiterPid = await waitBlocked(holderPid, "pg_advisory_xact_lock", competitorPids);
              }
              expect(waiterPid).not.toBe(holderPid);
              console.info("MAIL_GUARD_OVERLAP", { competitor, order, holderPid, waiterPid });
              await controller.query("SELECT pg_advisory_unlock(712340002)");
              const [failure, outcome] = await bounded(Promise.all([failedSend, other]));
              expect(failure).toMatchObject({
                success: false,
                error: expect.objectContaining({ message: "owned SMTP refusal" }),
              });
              expect(await getMailMessageMetaByItemId(pool, failedDraft)).toBeNull();
              if (!outcome.success) throw outcome.error;
              const result = outcome.value;
              const otherId =
                competitor === "send" &&
                typeof result === "object" &&
                result !== null &&
                "messageId" in result &&
                typeof result.messageId === "string"
                  ? result.messageId
                  : "<guarded-reply@example.com>";
              const otherMeta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, otherId);
              expect(otherMeta?.threadId).toBeTruthy();
              if (competitor === "bridge") {
                const anchor = await getMailMessageMetaByMailboxAndMessageId(
                  pool,
                  mailboxId,
                  "<bridge-anchor@example.com>",
                );
                expect(otherMeta?.threadId).toBe(anchor?.threadId);
                if (!otherMeta?.threadId) throw new Error("Missing merged bridge thread");
                for (const id of anchorIds) {
                  expect(await withTransaction(pool, (client) => resolveMergedThreadId(client, id))).toBe(
                    otherMeta.threadId,
                  );
                }
                const aliases = await pool.query<{ from_thread_id: string; to_thread_id: string }>(
                  "SELECT from_thread_id, to_thread_id FROM mail_thread_aliases WHERE from_thread_id = ANY($1::uuid[])",
                  [anchorIds],
                );
                expect(aliases.rows.length).toBeGreaterThanOrEqual(1);
                expect(aliases.rows.every((row) => row.to_thread_id === otherMeta.threadId)).toBe(true);
              } else if (order === "competitor-first") expect(otherMeta?.threadId).toBe(original.threadId);
              else expect(otherMeta?.threadId).not.toBe(original.threadId);
              const { rows: orphans } = await pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id)",
              );
              expect(orphans[0]?.count).toBe(0);
              const retry = await send(failedDraft, recordingTransport());
              expect(
                (await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, retry.messageId))?.threadId,
              ).toBeTruthy();
            } finally {
              releaseSmtp();
              const operations = Promise.allSettled([...(failedSend ? [failedSend] : []), ...(other ? [other] : [])]);
              try {
                await bounded(controller.query("SELECT pg_advisory_unlock_all()"));
                await bounded(operations).catch(async (error: unknown) => {
                  const pids = await bounded(Promise.all([...failedPids, ...competitorPids]));
                  for (const pid of new Set(pids)) {
                    await bounded(controller.query("SELECT pg_terminate_backend($1)", [pid]));
                  }
                  await bounded(operations);
                  throw error;
                });
              } finally {
                try {
                  await bounded(
                    controller.query(
                      order === "competitor-first"
                        ? "DROP TRIGGER IF EXISTS test_mail_guard_gate ON mail_message_meta"
                        : "DROP TRIGGER IF EXISTS test_mail_guard_gate ON mail_threads",
                    ),
                  );
                  await bounded(controller.query("DROP FUNCTION IF EXISTS test_mail_guard_gate()"));
                } finally {
                  controller.release(true);
                  pool = ownerPool;
                  await bounded(Promise.all([runtimePool.end(), failedPool.end(), competitorPool.end()]));
                }
              }
            }
          },
          30000,
        );
      }
    }

    tenantIt("a reply to a synced message joins that message's thread", async () => {
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

    tenantIt("threads an outgoing reply using an ancestor in another mailbox of the same tenant", async () => {
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

    tenantIt("a send without ancestors starts a new thread that a later reply joins", async () => {
      const first = await send(await newDraft(), recordingTransport());
      const firstMeta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, first.messageId);
      expect(firstMeta?.threadId).toBeTruthy();
      expect(await threadCount()).toBe(1);

      const second = await send(await newDraft(), recordingTransport(), { inReplyTo: first.messageId });
      const secondMeta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, second.messageId);
      expect(secondMeta?.threadId).toBe(firstMeta?.threadId);
      expect(await threadCount()).toBe(1);
    });

    tenantIt("a later Sent-folder sync of the same message id keeps the thread and creates no second one", async () => {
      const result = await send(await newDraft(), recordingTransport());
      const before = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);

      await ingestSynced(result.messageId);

      const after = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
      expect(after?.threadId).toBe(before?.threadId);
      expect(await threadCount()).toBe(1);
    });

    tenantIt("an SMTP failure removes the claim and leaves no orphan thread, and a retry threads again", async () => {
      const draftId = await newDraft();
      let threadItemId: string | undefined;
      const failing = recordingTransport({
        async send() {
          const { rows } = await pool.query<{ item_id: string }>(
            "SELECT t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.item_id = $1",
            [draftId],
          );
          threadItemId = rows[0]?.item_id;
          throw new Error("SMTP server rejected the message");
        },
      });
      await expect(send(draftId, failing)).rejects.toThrow(/SMTP server rejected/);
      expect(await getMailMessageMetaByItemId(pool, draftId)).toBeNull();
      expect(await threadCount()).toBe(0);
      if (!threadItemId) throw new Error("Missing claimed Threads item");
      const deleted = await pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id = $1", [
        threadItemId,
      ]);
      expect(deleted.rows).toHaveLength(1);
      expect(deleted.rows[0]?.deleted_at).toBeInstanceOf(Date);

      const result = await send(draftId, recordingTransport());
      const meta = await getMailMessageMetaByMailboxAndMessageId(pool, mailboxId, result.messageId);
      expect(meta?.threadId).toBeTruthy();
      expect(await threadCount()).toBe(1);
    });

    tenantIt("an SMTP failure on a reply keeps the shared thread", async () => {
      await ingestSynced("<orig@example.com>");
      const before = await pool.query<{ item_id: string }>("SELECT item_id FROM mail_threads");
      if (!before.rows[0]) throw new Error("Missing shared Threads item");
      const failing = recordingTransport({
        async send() {
          throw new Error("SMTP server rejected the message");
        },
      });
      await expect(send(await newDraft(), failing, { inReplyTo: "<orig@example.com>" })).rejects.toThrow(/rejected/);
      expect(await threadCount()).toBe(1);
      const retained = await pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id = $1", [
        before.rows[0].item_id,
      ]);
      expect(retained.rows).toEqual([{ deleted_at: null }]);
    });

    tenantIt("preserves the SMTP error and claim when compensating cleanup itself fails", async () => {
      const draftId = await newDraft();
      await pool.query(
        "CREATE FUNCTION test_mail_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup failed'; END $$",
      );
      try {
        await pool.query(
          "CREATE TRIGGER test_mail_cleanup_failure BEFORE DELETE ON mail_message_meta FOR EACH ROW EXECUTE FUNCTION test_mail_cleanup_failure()",
        );
        const smtpError = new Error("SMTP original failure");
        const failing = recordingTransport({
          async send() {
            throw smtpError;
          },
        });
        await expect(send(draftId, failing)).rejects.toBe(smtpError);
        const claim = await getMailMessageMetaByItemId(pool, draftId);
        expect(claim?.threadId).toBeTruthy();
        expect(await threadCount()).toBe(1);
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS test_mail_cleanup_failure ON mail_message_meta");
        await pool.query("DROP FUNCTION IF EXISTS test_mail_cleanup_failure()");
      }
    });

    tenantIt("a lost claim race ends in ConflictError and leaves no extra thread", async () => {
      const draftId = await newDraft();
      await send(draftId, recordingTransport());
      await expect(send(draftId, recordingTransport())).rejects.toThrow(/already being sent or was already sent/);
      expect(await threadCount()).toBe(1);
    });
  });

  describe("people linking of sent mail (issue #1480)", () => {
    let ownerPool: Pool;

    beforeEach(async () => {
      ownerPool = pool;
      pool = await createRuntimeRolePool(ownerPool, "semprec_data");
      const role = await pool.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      chokePoint = createChokePoint(pool);
    });

    afterEach(async () => {
      const runtimePool = pool;
      pool = ownerPool;
      chokePoint = createChokePoint(pool);
      await runtimePool.end();
    });

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

    tenantIt("reads and sends from a historically user-owned mailbox after the owner cutover", async () => {
      // Recreate the pre-cutover schema; the earlier release binary is not run here.
      await ownerPool.query("UPDATE properties SET owner = 'user' WHERE database_id = $1 AND key = 'addresses'", [
        mailboxesId,
      ]);
      await chokePoint.updateItem({
        databaseId: mailboxesId,
        itemId: mailboxId,
        propertiesPatch: { addresses: "me@example.com" },
      });
      const before = await chokePoint.getItem(mailboxesId, mailboxId);
      expect(before?.properties.addresses).toBe("me@example.com");
      await runMailboxAddressesOwnerCutoverMigration(pool);
      const after = await chokePoint.getItem(mailboxesId, mailboxId);
      expect(after?.properties.addresses).toBe(before?.properties.addresses);
      const transport = recordingTransport();
      const draftId = await newDraftWithSubject("Legacy mailbox");
      await sendDraftEmail(
        pool,
        {
          mailboxItemId: mailboxId,
          draftItemId: draftId,
          actor: { type: "user" },
          from: { address: "me@example.com" },
          to: [{ address: "bob@example.com" }],
          subject: "Legacy mailbox",
          bodyText: "hi",
        },
        moduleIds,
        sendAdapters(transportFor(transport)),
      );
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.envelope.from).toBe("me@example.com");
      expect((await chokePoint.getItem(emailsId, draftId))?.properties.read).toBe(true);
    });

    tenantIt("actual send preserves read and unscoped unread search returns only an inbox message", async () => {
      const sentId = await sendMail({ to: ["bob@example.com"] });
      const inboxMessageId = await withTransaction(pool, async (client) => {
        const mailboxProperty = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'mailbox'",
          [foldersId],
        );
        const attachments = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'attachments'",
          [emailsId],
        );
        const mailboxPropertyId = mailboxProperty.rows[0]?.id;
        const attachmentsId = attachments.rows[0]?.id;
        if (!mailboxPropertyId || !attachmentsId) throw new Error("Missing mail properties");
        const folder = await ensureFolderItem(client, {
          foldersDatabaseId: foldersId,
          mailboxItemId: mailboxId,
          mailboxRelationPropertyId: mailboxPropertyId,
          providerId: "INBOX",
          name: "INBOX",
          behavior: "folder",
          specialPurpose: "inbox",
        });
        const received = await ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: await databaseIdFor("files"),
          folderRelationPropertyId,
          attachmentsRelationPropertyId: attachmentsId,
          folderItemId: folder,
          mailboxItemId: mailboxId,
          messageId: "<unread-positive@example.test>",
          subject: "Unread positive",
          envelope: {},
          bodyText: "hello",
          attachments: [],
          storage: {
            async writeStream() {
              throw new Error("Unexpected attachment write");
            },
            async delete() {
              throw new Error("Unexpected attachment delete");
            },
            readStream() {
              throw new Error("Unexpected attachment read");
            },
          },
          storageKeyPrefix: "test",
        });
        // Drafts are indexed by the normal search indexer; establish the sent item as a positive searchable row.
        await reindexItemSearch(client, { itemId: sentId, databaseId: emailsId, text: "Sent positive" });
        return received.itemId;
      });
      const { rows } = await pool.query<{ read: boolean | null }>(
        "SELECT (properties ->> 'read')::boolean AS read FROM items WHERE id = $1",
        [sentId],
      );
      expect(rows).toEqual([{ read: true }]);
      const unread = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: emailsId, query: "is:unread" }),
      );
      expect(unread.map((row) => row.itemId)).toEqual([inboxMessageId]);
      const searchable = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: emailsId, query: "Sent positive" }),
      );
      expect(searchable.map((row) => row.itemId)).toContain(sentId);
    });

    tenantIt("a sent message to an address a person owns gets a recipientsPeople edge to that person", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([]);
    });

    tenantIt(
      "a sent message from a mailbox address a person owns gets a senderPeople edge to that person",
      async () => {
        const me = await personOwning("Me", ["me@example.com"]);
        const mailId = await sendMail({ to: ["nobody@example.com"] });

        expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([me]);
        expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([]);
      },
    );

    tenantIt("an address no person owns leaves both people relations empty", async () => {
      await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["stranger@example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([]);
      expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([]);
    });

    tenantIt("two sent emails to the same person both link, and neither send fails", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const me = await personOwning("Me", ["me@example.com"]);
      const first = await sendMail({ to: ["bob@example.com"], subject: "First" });
      const second = await sendMail({ to: ["bob@example.com"], subject: "Second" });

      expect(await linkedPersonIds(first, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(second, "recipientsPeople")).toEqual([bob]);
      expect(await linkedPersonIds(first, "senderPeople")).toEqual([me]);
      expect(await linkedPersonIds(second, "senderPeople")).toEqual([me]);
    });

    tenantIt("a person listed in both To and Cc gets a single recipientsPeople edge", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"], cc: ["BOB@Example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
    });

    tenantIt("linking an email that is already linked adds no duplicate edge and raises no error", async () => {
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

    tenantIt(
      "a people link that fails rolls back the whole finalization: the draft keeps its subject and stays in Drafts",
      async () => {
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
      },
    );
  });
});
