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
import { createEmailDraft, type CreateEmailDraftInput } from "../mail/draft.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
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
  noopMailSendAdapterFactory,
  type MailSendAdapterFactory,
  type SendEmailModuleIds,
  type UserSendEmailInput,
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

/** One `tenantIt` per case. */
function tenantEach<T>(cases: readonly T[], name: (testCase: T) => string, fn: (testCase: T) => unknown): void {
  for (const testCase of cases) tenantIt(name(testCase), () => fn(testCase));
}

/** Attachment storage for ingests that carry no attachments. */
const unusedStorage = {
  async writeStream(): Promise<never> {
    throw new Error("Unexpected attachment write");
  },
  async delete(): Promise<never> {
    throw new Error("Unexpected attachment delete");
  },
  readStream(): never {
    throw new Error("Unexpected attachment read");
  },
};

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("drafts and authorized SMTP sending", () => {
  let emailsId: string;
  let foldersId: string;
  let mailboxesId: string;
  let folderRelationPropertyId: string;
  let mailboxFolderRelationPropertyId: string;
  let mailboxId: string;
  let projectsId: string;
  let emailProjectId: string;
  let moduleIds: SendEmailModuleIds;

  async function createFolderOf(client: PoolClient, mailboxItemId: string, name: string, specialPurpose: string) {
    const folder = await createItemWithClient(
      client,
      { databaseId: foldersId, properties: { name, behavior: "folder", specialPurpose } },
      { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: folder.id, targetItemId: mailboxItemId },
      { ownerProcess: FOLDERS_MODULE_ID },
    );
    return folder.id;
  }

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
      await createFolderOf(client, mailbox.id, "Drafts", "drafts");
      await createFolderOf(client, mailbox.id, "Sent", "sent");
      return mailbox.id;
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

  async function specialFolderId(purpose: "drafts" | "sent"): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = $2`,
      [foldersId, purpose],
    );
    return rows[0]!.id;
  }
  const draftsFolderId = () => specialFolderId("drafts");
  const sentFolderId = () => specialFolderId("sent");

  /** The fields a draft and its send share unless a test overrides them. */
  const MESSAGE = {
    subject: "Hello",
    from: { address: "me@example.com" },
    to: [{ address: "bob@example.com" }],
    bodyText: "hi bob",
  };

  async function createDraft(overrides: Partial<CreateEmailDraftInput> = {}) {
    const draftsFolderItemId = await draftsFolderId();
    return withTransaction(pool, (client) =>
      createEmailDraft(client, {
        emailsDatabaseId: emailsId,
        folderRelationPropertyId,
        draftsFolderItemId,
        ...MESSAGE,
        ...overrides,
      }),
    );
  }

  /** A user send of the draft; the pool is read at call time because some tests swap it for a runtime-role pool. */
  function sendAsUser(
    draftItemId: string,
    adapters: MailSendAdapterFactory,
    overrides: Partial<UserSendEmailInput> = {},
    operationPool: Pool = pool,
  ) {
    return sendDraftEmail(
      operationPool,
      { mailboxItemId: mailboxId, draftItemId, actor: { type: "user" }, ...MESSAGE, ...overrides },
      moduleIds,
      adapters,
    );
  }

  async function folderLinkCount(itemId: string, folderId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT 1 FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
      [folderRelationPropertyId, itemId, folderId],
    );
    return rows.length;
  }

  tenantIt(
    "email.draft.create writes through the generic item-create path with no authorization check, linked into Drafts",
    async () => {
      const draft = await createDraft();

      expect(draft.properties.name).toBe("Hello");
      expect(draft.properties.recipients).toBe("bob@example.com");
      expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
      expect(await folderLinkCount(draft.id, await draftsFolderId())).toBe(1);
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

  tenantIt(
    "a user send submits exactly once over SMTP, moves the draft from Drafts to Sent, and stores a generated Message-ID",
    async () => {
      const draft = await createDraft();
      const smtp = recordingTransport();
      const result = await sendAsUser(draft.id, sendAdapters(transportFor(smtp)));

      expect(smtp.sent).toHaveLength(1);
      expect(smtp.sent[0]!.raw.toString("utf8")).toContain(`Message-ID: ${result.messageId}\r\n`);
      expect(smtp.sent[0]!.envelope).toEqual({ from: "me@example.com", recipients: ["bob@example.com"] });
      expect(result.messageId).toMatch(/^<.+@example\.com>$/);

      const meta = await getMailMessageMetaByItemId(pool, draft.id);
      expect(meta?.messageId).toBe(result.messageId);
      expect(result.threadId).toBe(meta?.threadId);
      expect(result.sentAt).toBeInstanceOf(Date);
      // A plain Emails draft has no `mail_drafts` row, and sending it does not write one.
      const { rows: draftRows } = await pool.query("SELECT 1 FROM mail_drafts WHERE email_item_id = $1", [draft.id]);
      expect(draftRows).toHaveLength(0);
      expect(await folderLinkCount(draft.id, await sentFolderId())).toBe(1);
      expect(await folderLinkCount(draft.id, await draftsFolderId())).toBe(0);

      // A retried or duplicated call for an already-sent draft must not submit the message again.
      const secondSmtp = recordingTransport();
      await expect(sendAsUser(draft.id, sendAdapters(transportFor(secondSmtp)))).rejects.toMatchObject({
        name: "MailSendClaimLostError",
        code: "version_conflict",
      });
      expect(secondSmtp.sent).toHaveLength(0);
    },
  );

  tenantIt("two genuinely concurrent sends of the same draft submit over SMTP exactly once between them", async () => {
    const draft = await createDraft();
    const smtpA = recordingTransport();
    const smtpB = recordingTransport();
    const send = (smtp: ReturnType<typeof recordingTransport>) =>
      sendAsUser(draft.id, sendAdapters(transportFor(smtp)));

    const outcomes = await Promise.allSettled([send(smtpA), send(smtpB)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ name: "MailSendClaimLostError", code: "version_conflict" });

    // The claim (mail_message_meta insert) arbitrates the race before either call reaches SMTP, so at most
    // one client sends.
    expect(smtpA.sent.length + smtpB.sent.length).toBe(1);
  });

  tenantIt("undoes the send claim when SMTP itself fails, so a genuine retry can still send", async () => {
    const draft = await createDraft();
    const failingSmtp = recordingTransport({
      async send() {
        throw new Error("SMTP server rejected the message");
      },
    });

    await expect(sendAsUser(draft.id, sendAdapters(transportFor(failingSmtp)))).rejects.toThrow(/SMTP server rejected/);

    // The failed attempt's claim must not persist: the draft is neither "sent" nor stuck.
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    expect(await folderLinkCount(draft.id, await draftsFolderId())).toBe(1);

    const workingSmtp = recordingTransport();
    const result = await sendAsUser(draft.id, sendAdapters(transportFor(workingSmtp)));
    expect(workingSmtp.sent).toHaveLength(1);
    expect(result.itemId).toBe(draft.id);
  });

  tenantEach(
    [
      ["no SMTP adapter is configured for the composition root", () => noopMailSendAdapterFactory],
      [
        "the transports are configured but no attachment storage is",
        (smtp: MailTransport) => ({ transports: transportFor(smtp) }),
      ],
    ] as const,
    ([label]) => `throws when ${label}, without side effects`,
    async ([, adapters]) => {
      const draft = await createDraft();
      const smtp = recordingTransport();
      await expect(sendAsUser(draft.id, adapters(smtp))).rejects.toThrow(/No SMTP adapter configured/);

      expect(smtp.sent).toHaveLength(0);
      expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    },
  );

  tenantEach(
    [
      [
        "a From address that isn't one of the mailbox's registered addresses with ForbiddenError, before any claim or SMTP call",
        "ForbiddenError",
        async () => ({ from: { address: "spoofed@somewhere-else.com" } }),
      ],
      [
        "an unknown mailboxItemId with NotFoundError, before the from-address check",
        "NotFoundError",
        async () => ({
          mailboxItemId: "00000000-0000-0000-0000-000000000000",
          from: { address: "spoofed@somewhere-else.com" },
        }),
      ],
      [
        "sending over a soft-deleted mailbox with NotFoundError, not ForbiddenError",
        "NotFoundError",
        async () => {
          await chokePoint.softDeleteItem(mailboxesId, mailboxId);
          return {};
        },
      ],
    ] as const,
    ([label]) => `rejects ${label}`,
    async ([, name, arrange]) => {
      const draft = await createDraft();
      const overrides = await arrange();
      const smtp = recordingTransport();
      await expect(sendAsUser(draft.id, sendAdapters(transportFor(smtp)), overrides)).rejects.toMatchObject({ name });

      expect(smtp.sent).toHaveLength(0);
      expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    },
  );

  tenantIt(
    "a later IMAP-style reconcile pass observing the same generated Message-ID in Sent converges onto the same item instead of duplicating it",
    async () => {
      const draft = await createDraft();
      const sentId = await sentFolderId();
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: foldersId, itemId: sentId, propertiesPatch: { providerId: "Sent" } },
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
      const result = await sendAsUser(draft.id, sendAdapters(transportFor(smtp)));

      expect(copied).toBeDefined();
      expect(copied).toEqual(accepted);
      if (!copied) throw new Error("Sent copy was not appended");
      const parsed = await simpleParser(copied);
      expect(parsed.messageId).toBe(result.messageId);
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;

      const reconciled = await withTransaction(pool, async (client) =>
        ingestEmailMessage(client, {
          arrival: "live",
          contentState: "full",
          emailsDatabaseId: emailsId,
          filesDatabaseId: await databaseIdFor("files"),
          folderRelationPropertyId,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: sentId,
          mailboxItemId: mailboxId,
          messageId: parsed.messageId ?? "",
          subject: "Hello",
          envelope: { from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }] },
          bodyText: "hi bob",
          attachments: [],
          storage: unusedStorage,
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
    const smtp = recordingTransport();
    await sendAsUser((await createDraft()).id, sendAdapters(transportFor(smtp)), {
      bodyHtml: "<p>hi <b>bob</b></p>",
    });

    const raw = smtp.sent[0]!.raw.toString("utf8");
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).toContain("<p>hi <b>bob</b></p>");
  });

  tenantIt("bcc recipients reach the SMTP envelope and no header of the raw message", async () => {
    const smtp = recordingTransport();
    await sendAsUser((await createDraft()).id, sendAdapters(transportFor(smtp)), {
      bcc: [{ address: "hidden@example.com" }],
    });

    expect(smtp.sent[0]!.envelope).toEqual({
      from: "me@example.com",
      recipients: ["bob@example.com", "hidden@example.com"],
    });
    expect(smtp.sent[0]!.raw.toString("utf8")).not.toContain("hidden@example.com");
  });

  tenantIt("a transport that cannot be built leaves the draft unclaimed, in Drafts, and sends nothing", async () => {
    const draft = await createDraft();
    const forMailbox = vi.fn(async () => {
      throw new Error("Mailbox has no SMTP server settings");
    });
    await expect(sendAsUser(draft.id, sendAdapters({ forMailbox }))).rejects.toThrow(/no SMTP server settings/);

    expect(forMailbox).toHaveBeenCalledTimes(1);
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    expect(await folderLinkCount(draft.id, await draftsFolderId())).toBe(1);
  });

  describe("transport choice by sync mode", () => {
    async function sendAndRecordMode(): Promise<string[]> {
      const requested: string[] = [];
      const smtp = recordingTransport();
      await sendAsUser(
        (await createDraft()).id,
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

  describe("threading of sent messages", () => {
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
          arrival: "live",
          contentState: "full",
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
          storage: unusedStorage,
          storageKeyPrefix: "test",
        });
      });
    }

    const REPLY = { subject: "Re: Original", bodyText: "answer" };
    const newDraft = async () => (await createDraft(REPLY)).id;

    function send(
      draftItemId: string,
      smtp: MailTransport,
      threadHeaders: { inReplyTo?: string } = {},
      operationPool: Pool = pool,
    ) {
      return sendAsUser(
        draftItemId,
        sendAdapters(transportFor(smtp)),
        {
          ...REPLY,
          inReplyTo: threadHeaders.inReplyTo,
          references: threadHeaders.inReplyTo ? [threadHeaders.inReplyTo] : undefined,
        },
        operationPool,
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

  describe("people linking of sent mail", () => {
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

    async function personOwning(name: string, addresses: string[]): Promise<string> {
      const person = await chokePoint.createItem({
        databaseId: await databaseIdFor("people"),
        properties: { name, emails: addresses.join("\n") },
      });
      await withTransaction(pool, (client) => reindexPersonEmails(client, person.id, addresses));
      return person.id;
    }

    async function sendMail(options: { to: string[]; cc?: string[]; subject?: string }): Promise<string> {
      const subject = options.subject ?? "Hello";
      const draft = await createDraft({ subject, bodyText: "hi" });
      await sendAsUser(draft.id, sendAdapters(transportFor(recordingTransport())), {
        to: options.to.map((address) => ({ address })),
        cc: options.cc?.map((address) => ({ address })),
        subject,
        bodyText: "hi",
      });
      return draft.id;
    }

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
          arrival: "live",
          contentState: "full",
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
          storage: unusedStorage,
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

    tenantEach(
      [
        [
          "a recipient address a person owns gets a recipientsPeople edge",
          "Bob",
          "bob@example.com",
          "recipientsPeople",
        ],
        ["a mailbox address a person owns gets a senderPeople edge", "Me", "nobody@example.com", "senderPeople"],
        ["an address no person owns leaves both people relations empty", "Bob", "stranger@example.com", null],
      ] as const,
      ([label]) => label,
      async ([, owner, to, linkedAs]) => {
        const person = await personOwning(owner, [owner === "Me" ? "me@example.com" : "bob@example.com"]);
        const mailId = await sendMail({ to: [to] });

        for (const key of ["recipientsPeople", "senderPeople"] as const)
          expect(await linkedPersonIds(mailId, key)).toEqual(key === linkedAs ? [person] : []);
      },
    );

    tenantIt(
      "two sent emails to the same person both link, and relinking an already linked email adds no duplicate edge and raises no error",
      async () => {
        const bob = await personOwning("Bob", ["bob@example.com"]);
        const me = await personOwning("Me", ["me@example.com"]);
        const first = await sendMail({ to: ["bob@example.com"], subject: "First" });
        const second = await sendMail({ to: ["bob@example.com"], subject: "Second" });
        await withTransaction(pool, (client) =>
          linkEmailEnvelopeToPeople(client, {
            itemId: first,
            envelope: { from: { address: "me@example.com" }, to: [{ address: "bob@example.com" }] },
            emailsDatabaseId: emailsId,
            senderPeopleKey: "senderPeople",
            recipientsPeopleKey: "recipientsPeople",
          }),
        );

        for (const mailId of [first, second]) {
          expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
          expect(await linkedPersonIds(mailId, "senderPeople")).toEqual([me]);
        }
      },
    );

    tenantIt("a person listed in both To and Cc gets a single recipientsPeople edge", async () => {
      const bob = await personOwning("Bob", ["bob@example.com"]);
      const mailId = await sendMail({ to: ["bob@example.com"], cc: ["BOB@Example.com"] });

      expect(await linkedPersonIds(mailId, "recipientsPeople")).toEqual([bob]);
    });

    tenantIt(
      "a people link that fails rolls back the whole finalization: the draft keeps its subject and stays in Drafts",
      async () => {
        const bob = await personOwning("Bob", ["bob@example.com"]);
        // The address index still maps bob@example.com to Bob after his soft delete, so the link is attempted
        // against a deleted endpoint and refused by the choke point.
        await chokePoint.softDeleteItem(await databaseIdFor("people"), bob);
        const draft = await createDraft({ subject: "Draft subject", bodyText: "hi" });

        await expect(
          sendAsUser(draft.id, sendAdapters(transportFor(recordingTransport())), {
            subject: "Final subject",
            bodyText: "hi",
          }),
        ).rejects.toMatchObject({ name: "ValidationError" });

        const { rows: names } = await pool.query<{ name: string }>(
          `SELECT properties ->> 'name' AS name FROM items WHERE id = $1`,
          [draft.id],
        );
        expect(names[0]!.name).toBe("Draft subject");
        expect(await linkedPersonIds(draft.id, "recipientsPeople")).toEqual([]);
        expect(await folderLinkCount(draft.id, await draftsFolderId())).toBe(1);
      },
    );
  });
});
