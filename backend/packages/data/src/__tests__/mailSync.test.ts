import { registerGmailMovePreparer, registerGraphMovePreparer } from "../mail/mailMoveProviderAdapters.js";
import { drainGmailMoves, drainGraphMoves, drainImapMoves } from "../mail/mailMessageMoveSync.js";
import { GmailRestClient } from "../mail/gmailRestClient.js";
import { GraphRestClient } from "../mail/graphRestClient.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ensureMailFolderSyncState, recordReconcile } from "../mail/mailFolderSyncStateStore.js";
import { EMAILS_RELATION_CONTEXT } from "../mail/emailsRelationContext.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { CORE_TASK_NAMES, enqueueJob, ensureQueueSchema, grantQueueSchemaPrivileges, runOnce } from "@semprec/queue";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import {
  createLinkEmailToPeopleAction,
  createPersonEmailReindexAction,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
} from "../mail/personLinkingActions.js";
import { lookupPersonIdByEmail, reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { resolveThreadId } from "../mail/threading.js";
import { recordDesiredMailMessageMove, listPendingMoves } from "../mail/mailMessageMoveSyncStore.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import {
  getMailMessageMetaByItemId,
  getMailMessageMetaByMailboxAndMessageId,
  upsertMailMessageMeta,
} from "../mail/mailMessageMetaStore.js";
import { resolveDeliveredToAddress } from "../mail/deliveredTo.js";
import { applyObservedMailMessageFlags } from "../mail/mailFlagObservation.js";
import { isDeliveryStatusReport, parseContentTypeHeader } from "../mail/dsn.js";
import {
  enqueueMailLegacyEmailMigration,
  mailLegacyEmailMigrationJobKey,
  runMailLegacyEmailMigrationJob,
  type LegacyRawMimeFetcher,
} from "../migrationJob/mailLegacyEmailMigration.js";
import type { ClassifiedAttachment } from "../mail/attachments.js";
import { sanitizeMailHtml } from "../mail/htmlSanitize.js";
import { parseMailSearchQuery, reindexItemSearch, searchItems } from "../mail/search.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { storeCredential, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import {
  reconcileImapAccount,
  reconcileImapFolder,
  type ImapFetchedMessage,
  type ImapMailClient,
} from "../mail/imapReconcile.js";
import { reconcileGmailAccount, type GmailMailClient } from "../mail/gmailReconcile.js";
import { reconcileGraphAccount, type GraphMailClient } from "../mail/graphReconcile.js";
import {
  handleMailSearchReindexSweepTask,
  handleSyncMailAccountTask,
  type MailModuleIds,
  type MailSyncAdapterFactory,
} from "../mail/mailSyncJob.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  defaultSyncModeForProvider,
  recordImapActivity,
  recordGmailActivity,
  recordGraphActivity,
  recordSyncError,
} from "../mail/mailAccountSyncStateStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";
import {
  AttachmentCapExceededError,
  MailConnectionLimitError,
  MailReauthorizationRequiredError,
} from "../mail/providerTypes.js";
import { logger } from "../mail/logger.js";
import {
  walkBodyStructure,
  parseHeaderBlock,
  headerValues,
  ImapFlowMailClient,
  isImapConnectionLimitError,
} from "../mail/imapFlowClient.js";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import { IMAP_FLAGGED_FLAG, IMAP_SEEN_FLAG, messageFlagProperties } from "../mail/messageFlags.js";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { listPendingImapFlagWrites, recordConfirmedMailMessageFlag } from "../mail/mailMessageFlagSyncStore.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tenantIt = (name: string, fn: () => unknown, timeout?: number) =>
  it(
    name,
    () =>
      inTenantZero(async () => {
        await fn();
      }),
    timeout,
  );

async function waitForMoveTestSignal<T>(signal: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for owned move test signal")), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function holdMoveBaseline(pool: Pool): { reached: Promise<number>; release: () => void } {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const reached = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = new WeakSet<object>();
  let held = false;
  pool.on("acquire", (client) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    client.query = new Proxy(client.query.bind(client), {
      apply(target, thisArg, args: unknown[]) {
        const result: unknown = Reflect.apply(target, thisArg, args);
        if (
          !held &&
          typeof args[0] === "string" &&
          args[0].includes("SELECT message_item_id, mailbox_item_id, desired_revision, status, operation_token") &&
          result instanceof Promise
        ) {
          held = true;
          return result.then(async (value: unknown) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!pid.rows[0]) throw new Error("Missing baseline backend pid");
            ready(pid.rows[0].pid);
            await gate;
            return value;
          });
        }
        return result;
      },
    });
  });
  return { reached, release };
}

let pool: Pool;
let chokePoint: ChokePoint;

/** The Mailbox item id for ingest cases that exercise no mailbox-scoped behavior — `ingestEmailMessage` only uses it as its dedup scope. */
const TEST_MAILBOX_ITEM_ID = randomUUID();

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** A minimal, structurally valid one-page PDF containing exactly `text`, with a correct xref table (real byte offsets) so pdf-parse/pdfjs-dist parses it via its normal path. */
function buildMinimalPdf(text: string): Buffer {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  objects[5] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

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

function mailRegistry() {
  const registry = createActionRegistry();
  registry.set(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, createPersonEmailReindexAction(pool));
  registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, createLinkEmailToPeopleAction(pool));
  return registry;
}

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, mailRegistry()) });
}

describe("email module seed (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("seeds Mailboxes/Folders/Emails with the expected owner:'system' schema", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const foldersId = await databaseIdFor("folders");
    const emailsId = await databaseIdFor("emails");

    const mailboxProps = await chokePoint.listProperties(mailboxesId);
    expect(mailboxProps.map((p) => p.key).sort()).toEqual([
      "addresses",
      "connectionLimit",
      "folders",
      "name",
      "provider",
      "syncStatus",
    ]);
    expect(mailboxProps.find((p) => p.key === "syncStatus")).toMatchObject({ owner: "system", type: "select" });

    const folderProps = await chokePoint.listProperties(foldersId);
    expect(folderProps.map((p) => p.key).sort()).toEqual([
      "behavior",
      "emails",
      "mailbox",
      "name",
      "providerId",
      "specialPurpose",
    ]);

    const emailProps = await chokePoint.listProperties(emailsId);
    expect(emailProps.map((p) => p.key).sort()).toEqual([
      "attachments",
      "body",
      "date",
      "flagged",
      "folder",
      "name",
      "read",
      "recipients",
      "recipientsPeople",
      "sender",
      "senderPeople",
    ]);
    expect(emailProps.find((p) => p.key === "sender")).toMatchObject({ owner: "system" });
    // The two triage flags are the exception: user state, written through the generic
    // item-update path by the mailbox client (issue #97).
    expect(emailProps.find((p) => p.key === "read")).toMatchObject({ owner: "user", type: "checkbox" });
    expect(emailProps.find((p) => p.key === "flagged")).toMatchObject({ owner: "user", type: "checkbox" });
  });

  it("adds People.emails as a new, user-owned property on the already schema-locked People database", async () => {
    const peopleId = await databaseIdFor("people");
    const props = await chokePoint.listProperties(peopleId);
    expect(props.find((p) => p.key === "emails")).toMatchObject({ owner: "user", type: "longText" });
  });

  it("rejects a direct write to an owner:'system' Emails property through the generic create path", async () => {
    const emailsId = await databaseIdFor("emails");
    await expect(
      chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi", sender: "x@example.com" } }),
    ).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });
});

describe("person <-> email address linking (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("reindexes person_email_index from People.emails and rejects a second person claiming the same address", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({
      databaseId: peopleId,
      properties: { name: "Alice", emails: "alice@example.com\nalice.w@example.com" },
    });
    await withTransaction(pool, (client) =>
      reindexPersonEmails(client, alice.id, ["alice@example.com", "alice.w@example.com"]),
    );

    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "ALICE@Example.com "))).toBe(alice.id);

    const bob = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Bob" } });
    const result = await withTransaction(pool, (client) => reindexPersonEmails(client, bob.id, ["alice@example.com"]));
    expect(result.conflicts).toEqual(["alice@example.com"]);
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBe(alice.id);
  });

  it("the reindex action rejects an action config without peopleDatabaseId and writes no index row", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({
      databaseId: peopleId,
      properties: { name: "Alice", emails: "alice@example.com" },
    });

    const error = await createPersonEmailReindexAction(pool)(
      {},
      { heartbeatId: "hb", projectItemId: "proj", itemId: alice.id },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Malformed action config for mail\.reindexPersonEmails: /);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM person_email_index`);
    expect(rows[0].n).toBe(0);
  });

  it("the link action rejects an action config without its database id and property keys and writes no index row", async () => {
    const error = await createLinkEmailToPeopleAction(pool)(
      {},
      { heartbeatId: "hb", projectItemId: "proj", itemId: randomUUID() },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Malformed action config for mail\.linkPeopleByEmail: /);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM person_email_index`);
    expect(rows[0].n).toBe(0);
  });

  it("releases an address a person no longer claims", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice" } });
    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, ["alice@example.com"]));
    await withTransaction(pool, (client) => reindexPersonEmails(client, alice.id, []));
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBeNull();
  });

  it("end to end: creating a Person with an address, then ingesting a message from it, links senderPeople/recipientsPeople", async () => {
    const peopleId = await databaseIdFor("people");
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const alice = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: peopleId,
        properties: { name: "Alice", emails: "alice@example.com" },
      }),
    );
    await drainQueue(); // onItemEvent 'create' on People -> reindex action

    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const mailboxFolderProperty = (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!;

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "Test", provider: "generic" } }),
    );
    const inbox = await withTransaction(pool, async (client) => {
      const folder = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderProperty.id, callerItemId: folder.id, targetItemId: mailbox.id },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
      return folder;
    });

    const ingestResult = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: inbox.id,
          mailboxItemId: mailbox.id,
          messageId: "<msg1@example.com>",
          subject: "Hello",
          envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
          bodyText: "hi",
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      ),
    );

    await drainQueue(); // onItemEvent 'create' on Emails -> link action

    const email = await chokePoint.getItem(emailsId, ingestResult.itemId);
    expect(email?.properties.name).toBe("Hello");

    const senderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "senderPeople")!;
    const { rows } = await pool.query(
      `SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`,
      [senderProperty.id],
    );
    expect(rows.some((r) => r.item_a === alice.id || r.item_b === alice.id)).toBe(true);
  });
});

describe("conversation threading (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt("gives an unrelated message its own thread", async () => {
    const threadId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<a@x>" }));
    expect(threadId).toBeTruthy();
  });

  tenantIt("threads a reply onto its parent's thread", async () => {
    const parentThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<parent@x>" }),
    );
    await pool.query(
      `INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<parent@x>', $1, '{}')`,
      [parentThreadId],
    );

    const replyThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<reply@x>", inReplyTo: "<parent@x>", references: ["<parent@x>"] }),
    );
    expect(replyThreadId).toBe(parentThreadId);
  });

  tenantIt(
    "self-heals: a message arriving after its reply joins the reply's thread instead of staying separate",
    async () => {
      const replyThreadId = await withTransaction(pool, (client) =>
        resolveThreadId(client, { messageId: "<reply@x>", inReplyTo: "<late-parent@x>" }),
      );
      await pool.query(
        `INSERT INTO mail_message_meta (item_id, message_id, in_reply_to, thread_id, envelope) VALUES (gen_random_uuid(), '<reply@x>', '<late-parent@x>', $1, '{}')`,
        [replyThreadId],
      );

      const parentThreadId = await withTransaction(pool, (client) =>
        resolveThreadId(client, { messageId: "<late-parent@x>" }),
      );
      expect(parentThreadId).toBe(replyThreadId);
    },
  );

  tenantIt("merging two threads deletes the losing thread's now-empty mail_threads row", async () => {
    const threadAId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<a1@x>" }));
    await pool.query(
      `INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<a1@x>', $1, '{}')`,
      [threadAId],
    );

    const threadBId = await withTransaction(pool, (client) => resolveThreadId(client, { messageId: "<b1@x>" }));
    await pool.query(
      `INSERT INTO mail_message_meta (item_id, message_id, thread_id, envelope) VALUES (gen_random_uuid(), '<b1@x>', $1, '{}')`,
      [threadBId],
    );

    const { rows: before } = await pool.query(`SELECT count(*) FROM mail_threads WHERE id = ANY($1::uuid[])`, [
      [threadAId, threadBId],
    ]);
    expect(before[0].count).toBe("2");

    // Bridges the two previously-separate threads: both are found as ancestors, so this
    // resolves to a merge instead of a fresh thread.
    const mergedThreadId = await withTransaction(pool, (client) =>
      resolveThreadId(client, { messageId: "<bridge@x>", references: ["<a1@x>", "<b1@x>"] }),
    );
    expect([threadAId, threadBId]).toContain(mergedThreadId);

    const { rows: after } = await pool.query(`SELECT count(*) FROM mail_threads WHERE id = ANY($1::uuid[])`, [
      [threadAId, threadBId],
    ]);
    expect(after[0].count).toBe("1"); // the losing thread's row is gone, not just unreferenced
  });
});

describe("message ingest dedup (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt("a repeat ingest of the same Message-ID converges onto the same item instead of duplicating", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );

    const input = {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: folderProperty.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      folderItemId: folder.id,
      mailboxItemId: TEST_MAILBOX_ITEM_ID,
      messageId: "<dup@x>",
      envelope: {},
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    const first = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    const second = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.itemId).toBe(first.itemId);

    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId]);
    expect(Number(rows[0].count)).toBe(1);
  });

  tenantIt(
    "stores is_bulk from the bulk headers and sender, and a repeat ingest leaves it unchanged (issue #1502)",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );
      const base = {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId: TEST_MAILBOX_ITEM_ID,
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
      };
      const person = { from: { address: "anna@example.com" } };
      const cases: Array<[string, Partial<Parameters<typeof ingestEmailMessage>[1]>, boolean]> = [
        ["<unsub@x>", { envelope: person, bulkHeaders: { listUnsubscribe: "<mailto:u@example.com>" } }, true],
        ["<listid@x>", { envelope: person, bulkHeaders: { listId: "<l.example.com>" } }, true],
        ["<prec@x>", { envelope: person, bulkHeaders: { precedence: "bulk" } }, true],
        ["<auto@x>", { envelope: person, bulkHeaders: { autoSubmitted: "auto-generated" } }, true],
        ["<noreply@x>", { envelope: { from: { address: "No-Reply@example.com" } } }, true],
        ["<person@x>", { envelope: person, bulkHeaders: { autoSubmitted: "no" } }, false],
      ];
      for (const [messageId, extra, expected] of cases) {
        const { itemId } = await withTransaction(pool, (client) =>
          ingestEmailMessage(client, { ...base, envelope: {}, messageId, ...extra }),
        );
        const { rows } = await pool.query(`SELECT is_bulk FROM mail_message_meta WHERE item_id = $1`, [itemId]);
        expect(rows[0].is_bulk, messageId).toBe(expected);
      }

      // A later pass over an already-ingested message, even one now reporting different headers, keeps the flag.
      const again = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          ...base,
          messageId: "<unsub@x>",
          envelope: person,
          bulkHeaders: { autoSubmitted: "no" },
        }),
      );
      expect(again.created).toBe(false);
      const { rows } = await pool.query(`SELECT is_bulk FROM mail_message_meta WHERE item_id = $1`, [again.itemId]);
      expect(rows[0].is_bulk).toBe(true);
    },
  );
});

describe("mail thread invalidation on ingest (issue #1816)", () => {
  let events: InvalidationEvent[];

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  async function ingestFixture() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const properties = await chokePoint.listProperties(emailsId);
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );
    return (messageId: string, overrides: Partial<Parameters<typeof ingestEmailMessage>[1]> = {}) => ({
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: properties.find((p) => p.key === "folder")!.id,
      attachmentsRelationPropertyId: properties.find((p) => p.key === "attachments")!.id,
      folderItemId: folder.id,
      mailboxItemId: TEST_MAILBOX_ITEM_ID,
      messageId,
      envelope: {},
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
      ...overrides,
    });
  }

  async function threadIdOf(itemId: string): Promise<string> {
    const { rows } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
      [itemId],
    );
    if (!rows[0]) throw new Error("Expected the ingested message to have a thread");
    return rows[0].thread_id;
  }

  tenantIt("announces the thread of a new message once, for the whole tenant, and only after the commit", async () => {
    const input = await ingestFixture();
    let announcedInside: InvalidationEvent[] = [];

    const result = await withTransaction(pool, async (client) => {
      const ingested = await ingestEmailMessage(client, input("<new@x>"));
      announcedInside = [...events];
      return ingested;
    });

    expect(result.created).toBe(true);
    expect(announcedInside).toEqual([]);
    expect(events).toEqual([{ scope: "mailThread", threadId: await threadIdOf(result.itemId) }]);
    expect(events[0]).not.toHaveProperty("userId");
  });

  tenantIt("announces nothing when the ingest transaction rolls back", async () => {
    const input = await ingestFixture();

    await expect(
      withTransaction(pool, async (client) => {
        await ingestEmailMessage(client, input("<rolled-back@x>"));
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(events).toEqual([]);
    const { rows } = await pool.query("SELECT 1 FROM mail_message_meta WHERE message_id = '<rolled-back@x>'");
    expect(rows).toHaveLength(0);
  });

  tenantIt("announces nothing when the message was ingested before", async () => {
    const input = await ingestFixture();
    await withTransaction(pool, (client) => ingestEmailMessage(client, input("<again@x>")));
    events.length = 0;

    const again = await withTransaction(pool, (client) => ingestEmailMessage(client, input("<again@x>")));

    expect(again.created).toBe(false);
    expect(events).toEqual([]);
  });

  tenantIt("announces the shared thread once for each new message of a conversation", async () => {
    const input = await ingestFixture();

    const first = await withTransaction(pool, (client) => ingestEmailMessage(client, input("<root@x>")));
    const reply = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, input("<reply@x>", { inReplyTo: "<root@x>" })),
    );

    const threadId = await threadIdOf(first.itemId);
    expect(await threadIdOf(reply.itemId)).toBe(threadId);
    expect(events).toEqual([
      { scope: "mailThread", threadId },
      { scope: "mailThread", threadId },
    ]);
  });

  tenantIt("announces nothing for a message that converged onto another through the provider id", async () => {
    const input = await ingestFixture();
    const winner = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, input("<winner@x>", { providerMessageId: "same-provider-id" })),
    );
    events.length = 0;

    const loser = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, input("<loser@x>", { providerMessageId: "same-provider-id" })),
    );

    expect(loser).toEqual({ itemId: winner.itemId, created: false });
    expect(events).toEqual([]);
  });
});

describe("per-mailbox message identity (issue #674)", () => {
  const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function relationDefinitionIdFor(propertyId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
      [propertyId],
    );
    return rows[0]!.id;
  }

  /** Two Mailbox items, each with its own INBOX Folder linked through Folders.mailbox. */
  async function setUpTwoMailboxes() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProperties = await chokePoint.listProperties(emailsId);
    const folderProperty = emailProperties.find((p) => p.key === "folder")!;
    const attachmentsProperty = emailProperties.find((p) => p.key === "attachments")!;
    const mailboxFolderProperty = (await chokePoint.listProperties(foldersId)).find((p) => p.key === "mailbox")!;

    async function mailboxWithInbox(name: string) {
      return withTransaction(pool, async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name, provider: "generic" },
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
    }

    const a = await mailboxWithInbox("Work");
    const b = await mailboxWithInbox("Private");

    function ingestInto(mailbox: { mailboxItemId: string; inboxItemId: string }, messageId: string) {
      return withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: mailbox.inboxItemId,
          mailboxItemId: mailbox.mailboxItemId,
          folderUid: 7,
          messageId,
          subject: "Shared",
          envelope: {},
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
          flags: [],
        }),
      );
    }

    async function folderIdsOf(emailItemId: string): Promise<string[]> {
      const folderDefinitionId = await relationDefinitionIdFor(folderProperty.id);
      const { rows } = await pool.query<{ folder_id: string }>(
        `SELECT CASE WHEN item_a = $2 THEN item_b ELSE item_a END AS folder_id
         FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`,
        [folderDefinitionId, emailItemId],
      );
      return rows.map((r) => r.folder_id);
    }

    return {
      emailsId,
      a,
      b,
      ingestInto,
      folderIdsOf,
      folderDefinitionId: await relationDefinitionIdFor(folderProperty.id),
      mailboxFolderDefinitionId: await relationDefinitionIdFor(mailboxFolderProperty.id),
    };
  }

  tenantIt(
    "ingests the same Message-ID for two mailboxes as two items, each linked only to its own mailbox's folder",
    async () => {
      const { emailsId, a, b, ingestInto, folderIdsOf } = await setUpTwoMailboxes();

      const inA = await ingestInto(a, "<shared@x>");
      const inB = await ingestInto(b, "<shared@x>");

      expect(inA.created).toBe(true);
      expect(inB.created).toBe(true);
      expect(inB.itemId).not.toBe(inA.itemId);
      expect(await folderIdsOf(inA.itemId)).toEqual([a.inboxItemId]);
      expect(await folderIdsOf(inB.itemId)).toEqual([b.inboxItemId]);

      const metaA = await getMailMessageMetaByMailboxAndMessageId(pool, a.mailboxItemId, "<shared@x>");
      const metaB = await getMailMessageMetaByMailboxAndMessageId(pool, b.mailboxItemId, "<shared@x>");
      expect(metaA).toMatchObject({ itemId: inA.itemId, mailboxItemId: a.mailboxItemId });
      expect(metaB).toMatchObject({ itemId: inB.itemId, mailboxItemId: b.mailboxItemId });

      await chokePoint.updateItem({ databaseId: emailsId, itemId: inA.itemId, propertiesPatch: { read: true } });
      expect((await chokePoint.getItem(emailsId, inA.itemId))?.properties).toMatchObject({ read: true });
      expect((await chokePoint.getItem(emailsId, inB.itemId))?.properties).toMatchObject({ read: false });
    },
  );

  tenantIt("still converges a repeat ingest of the same Message-ID within one mailbox onto one item", async () => {
    const { emailsId, a, ingestInto, folderIdsOf } = await setUpTwoMailboxes();

    const first = await ingestInto(a, "<again@x>");
    const second = await ingestInto(a, "<again@x>");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.itemId).toBe(first.itemId);
    expect(await folderIdsOf(first.itemId)).toEqual([a.inboxItemId]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [emailsId]);
    expect(rows[0].n).toBe(1);
  });

  tenantIt("resolves a pending flag write for one mailbox only through that mailbox's folder edge", async () => {
    const { emailsId, a, b, ingestInto, folderDefinitionId, mailboxFolderDefinitionId } = await setUpTwoMailboxes();
    const inA = await ingestInto(a, "<flag-shared@x>");
    await ingestInto(b, "<flag-shared@x>");

    await chokePoint.updateItem({ databaseId: emailsId, itemId: inA.itemId, propertiesPatch: { read: true } });

    const pendingFor = (mailboxItemId: string) =>
      listPendingImapFlagWrites(pool, {
        folderRelationDefinitionId: folderDefinitionId,
        mailboxFolderRelationDefinitionId: mailboxFolderDefinitionId,
        mailboxItemId,
      });
    expect(await pendingFor(a.mailboxItemId)).toEqual([
      { messageItemId: inA.itemId, propertyKey: "read", desiredState: true, folderPath: "INBOX", uid: 7 },
    ]);
    expect(await pendingFor(b.mailboxItemId)).toEqual([]);
  });

  tenantIt(
    "the migration backfills mailbox_item_id through the folder -> mailbox edges and leaves an unlinked row NULL",
    async () => {
      const { a, b, ingestInto } = await setUpTwoMailboxes();
      const inA = await ingestInto(a, "<backfill-a@x>");
      const inB = await ingestInto(b, "<backfill-b@x>");
      const orphanItemId = randomUUID();
      await pool.query(
        `INSERT INTO mail_message_meta (item_id, message_id, envelope) VALUES ($1, '<backfill-orphan@x>', '{}')`,
        [orphanItemId],
      );
      // The pre-migration shape of the two linked rows: no mailbox recorded yet.
      await pool.query(`UPDATE mail_message_meta SET mailbox_item_id = NULL WHERE item_id = ANY($1::uuid[])`, [
        [inA.itemId, inB.itemId],
      ]);

      const sql = await readFile(path.join(MIGRATIONS_DIR, "0053_mail_message_meta_per_mailbox.sql"), "utf8");
      await pool.query(sql);
      // Idempotent: a second run changes nothing and does not fail on the already-applied DDL.
      await pool.query(sql);

      expect((await getMailMessageMetaByItemId(pool, inA.itemId))?.mailboxItemId).toBe(a.mailboxItemId);
      expect((await getMailMessageMetaByItemId(pool, inB.itemId))?.mailboxItemId).toBe(b.mailboxItemId);
      expect((await getMailMessageMetaByItemId(pool, orphanItemId))?.mailboxItemId).toBeNull();
    },
  );
});

describe("provider_message_id uniqueness convergence (issue #204)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function baseInput(messageId: string, overrides: Partial<Parameters<typeof ingestEmailMessage>[1]> = {}) {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const properties = await chokePoint.listProperties(emailsId);
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );
    return {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: properties.find((p) => p.key === "folder")!.id,
      attachmentsRelationPropertyId: properties.find((p) => p.key === "attachments")!.id,
      folderItemId: folder.id,
      mailboxItemId: TEST_MAILBOX_ITEM_ID,
      messageId,
      envelope: {},
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
      ...overrides,
    };
  }

  tenantIt(
    "keeps the thread guard after a provider-id savepoint rollback and continues the transaction",
    async () => {
      const winnerInput = await baseInput("<winner@x>", { providerMessageId: "guarded-provider" });
      const conflictInput = await baseInput("<conflict@x>", { providerMessageId: "guarded-provider" });
      const continuationInput = await baseInput("<continuation@x>");
      const nextInput = await baseInput("<next@x>");
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      const operationPids: Array<Promise<number>> = [];
      runtimePool.on("acquire", (client: PoolClient) => {
        operationPids.push(
          client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(({ rows }) => {
            if (rows[0] === undefined) throw new Error("Missing participant PID");
            return rows[0].pid;
          }),
        );
      });
      const winner = await withTransaction(runtimePool, (client) => ingestEmailMessage(client, winnerInput));
      let release: () => void = () => undefined;
      let reportHolder: (pid: number) => void = () => undefined;
      let reportWaiter: (pid: number) => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderStarted = new Promise<number>((resolve) => {
        reportHolder = resolve;
      });
      const waiterStarted = new Promise<number>((resolve) => {
        reportWaiter = resolve;
      });
      async function bounded<T>(promise: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Savepoint overlap timed out")), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const holder = withTransaction(runtimePool, async (client) => {
        const result = await ingestEmailMessage(client, conflictInput);
        expect(result).toEqual({ itemId: winner.itemId, created: false });
        const continuation = await ingestEmailMessage(client, continuationInput);
        expect(continuation.created).toBe(true);
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (pid.rows[0] === undefined) throw new Error("Missing holder PID");
        reportHolder(pid.rows[0].pid);
        await gate;
        return result;
      });
      const holderSettled = holder.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let waiter: Promise<Awaited<ReturnType<typeof ingestEmailMessage>>> | undefined;
      try {
        const role = await runtimePool.query<{ name: string; bypass: boolean; superuser: boolean }>(
          "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows[0]).toEqual({ name: "semprec_data", bypass: false, superuser: false });
        const holderPid = await bounded(holderStarted);
        waiter = withTransaction(runtimePool, async (client) => {
          const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (pid.rows[0] === undefined) throw new Error("Missing waiter PID");
          reportWaiter(pid.rows[0].pid);
          return ingestEmailMessage(client, nextInput);
        });
        const waiterSettled = waiter.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const waiterPid = await bounded(waiterStarted);
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const result = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, waiterPid],
          );
          if (result.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        console.info("MAIL_GUARD_SAVEPOINT", { holderPid, waiterPid });
        release();
        expect(await bounded(holderSettled)).toMatchObject({ value: { itemId: winner.itemId, created: false } });
        expect(await bounded(waiterSettled)).toMatchObject({ value: { created: true } });
        const { rows } = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id)",
        );
        expect(rows[0]?.count).toBe(0);
      } finally {
        release();
        const operations = Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
        try {
          await bounded(operations).catch(async (error: unknown) => {
            const pids = await bounded(Promise.all(operationPids));
            for (const pid of new Set(pids)) await bounded(pool.query("SELECT pg_terminate_backend($1)", [pid]));
            await bounded(operations);
            throw error;
          });
        } finally {
          await bounded(runtimePool.end());
        }
      }
    },
    30000,
  );

  tenantIt(
    "converges two concurrent inserts for distinct Message-IDs sharing one provider id onto a single stable row without a raw Postgres error",
    async () => {
      const inputA = await baseInput("<race-a@x>", { providerMessageId: "provider-race-1" });
      const inputB = await baseInput("<race-b@x>", { providerMessageId: "provider-race-1" });

      const [resultA, resultB] = await Promise.all([
        withTransaction(pool, (client) => ingestEmailMessage(client, inputA)),
        withTransaction(pool, (client) => ingestEmailMessage(client, inputB)),
      ]);

      expect(resultA.itemId).toBe(resultB.itemId);
      expect([resultA.created, resultB.created].sort()).toEqual([false, true]);

      const { rows } = await pool.query(`SELECT count(*) FROM mail_message_meta WHERE provider_message_id = $1`, [
        "provider-race-1",
      ]);
      expect(Number(rows[0].count)).toBe(1);

      const { rows: itemRows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [
        inputA.emailsDatabaseId,
      ]);
      expect(Number(itemRows[0].count)).toBe(1);
    },
  );

  it("fills a null provider_message_id via the message_id upsert's ON CONFLICT DO UPDATE (same-message fill)", async () => {
    const itemId = randomUUID();
    const messageId = "<fill@x>";
    const sharedProviderId = "provider-fill-1";

    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, { itemId, mailboxItemId: TEST_MAILBOX_ITEM_ID, messageId, envelope: {} }),
    );
    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, {
        itemId,
        mailboxItemId: TEST_MAILBOX_ITEM_ID,
        messageId,
        envelope: {},
        providerMessageId: sharedProviderId,
      }),
    );

    const meta = await getMailMessageMetaByItemId(pool, itemId);
    expect(meta?.providerMessageId).toBe(sharedProviderId);
  });

  tenantIt("leaves a null provider_message_id message-id-only, uninvolved in the partial unique index", async () => {
    const input = await baseInput("<nullprovider@x>");
    const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, input));

    const meta = await getMailMessageMetaByItemId(pool, itemId);
    expect(meta?.providerMessageId).toBeNull();
  });
});

describe("mailbox triage flags (issue #97)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function ingestInput(overrides: Partial<Parameters<typeof ingestEmailMessage>[1]> = {}) {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const properties = await chokePoint.listProperties(emailsId);
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );
    return {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId: properties.find((p) => p.key === "folder")!.id,
      attachmentsRelationPropertyId: properties.find((p) => p.key === "attachments")!.id,
      folderItemId: folder.id,
      mailboxItemId: TEST_MAILBOX_ITEM_ID,
      messageId: "<flags@x>",
      envelope: {},
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
      ...overrides,
    };
  }

  it("maps IMAP \\Seen/\\Flagged onto the read/flagged properties, case-insensitively, and leaves both absent without flags", () => {
    expect(messageFlagProperties(["\\Seen", "\\Answered"])).toEqual({ read: true, flagged: false });
    expect(messageFlagProperties(["\\flagged"])).toEqual({ read: false, flagged: true });
    expect(messageFlagProperties([])).toEqual({ read: false, flagged: false });
    expect(messageFlagProperties(undefined)).toEqual({});
  });

  tenantIt("seeds a newly ingested message's read/flag state from the flags the server reported", async () => {
    const input = await ingestInput({ flags: [IMAP_SEEN_FLAG, IMAP_FLAGGED_FLAG] });
    const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, input));

    const item = await chokePoint.getItem(input.emailsDatabaseId, itemId);
    expect(item?.properties).toMatchObject({ read: true, flagged: true });
  });

  tenantIt("does not overwrite the user's own triage state when the same message is ingested again", async () => {
    const input = await ingestInput({ flags: [] });
    const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    await chokePoint.updateItem({ databaseId: input.emailsDatabaseId, itemId, propertiesPatch: { read: true } });

    await withTransaction(pool, (client) => ingestEmailMessage(client, input));

    const item = await chokePoint.getItem(input.emailsDatabaseId, itemId);
    expect(item?.properties.read).toBe(true);
  });

  tenantIt(
    "accepts read/flagged through the generic update path while still refusing an owner:'system' field",
    async () => {
      const input = await ingestInput();
      const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, input));

      const updated = await chokePoint.updateItem({
        databaseId: input.emailsDatabaseId,
        itemId,
        propertiesPatch: { read: true, flagged: true },
      });
      expect(updated.properties).toMatchObject({ read: true, flagged: true });

      await expect(
        chokePoint.updateItem({
          databaseId: input.emailsDatabaseId,
          itemId,
          propertiesPatch: { sender: "spoofed@example.com" },
        }),
      ).rejects.toMatchObject({ name: "ForbiddenError" });
    },
  );
});

describe("attachment ingest (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function attachment(filename: string, bytes: Buffer): ClassifiedAttachment {
    return {
      filename,
      contentType: "application/pdf",
      contentId: null,
      disposition: "attachment",
      openStream: () => Readable.from(bytes),
    };
  }

  tenantIt(
    "streams each attachment to storage, creates a Files item, and dedups identical content by hash",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );

      const sameBytes = Buffer.from("invoice-bytes");
      const result = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<with-attachments@x>",
          envelope: {},
          attachments: [attachment("invoice.pdf", sameBytes), attachment("invoice-copy.pdf", sameBytes)],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const { rows: attachmentRows } = await pool.query(
        `SELECT filename, blob_id, byte_size FROM mail_attachments WHERE message_item_id = $1`,
        [result.itemId],
      );
      expect(attachmentRows).toHaveLength(2);
      expect(new Set(attachmentRows.map((r) => r.blob_id)).size).toBe(1); // same content hash -> one blob
      expect(attachmentRows.every((r) => Number(r.byte_size) === sameBytes.length)).toBe(true);

      const { rows: fileItemRows } = await pool.query(
        `SELECT properties->>'name' AS name FROM items WHERE database_id = $1 ORDER BY 1`,
        [filesId],
      );
      expect(fileItemRows.map((r) => r.name)).toEqual(["invoice-copy.pdf", "invoice.pdf"]);

      const { rows: relationRows } = await pool.query(
        `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`,
        [attachmentsProperty.id],
      );
      expect(Number(relationRows[0].count)).toBe(2);
    },
  );

  tenantIt("extracts PDF attachment text at ingest and folds it into the message's own search index", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );

    // A minimal but structurally valid one-page PDF, with a correct xref table (real byte
    // offsets, not placeholders) — pdf-parse (pdfjs-dist under the hood) needs that to parse
    // via its normal path rather than falling back to a lossy recovery heuristic that
    // (verified while writing this test) can silently truncate the extracted text.
    const minimalPdf = buildMinimalPdf("UniqueInvoiceKeyword");

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId: TEST_MAILBOX_ITEM_ID,
        messageId: "<with-pdf@x>",
        subject: "Has a PDF",
        envelope: {},
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from(minimalPdf),
          },
        ],
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const found = await searchItems(pool, { databaseId: emailsId, query: "UniqueInvoiceKeyword" });
    expect(found.map((f) => f.itemId)).toContain(result.itemId);
  });

  tenantIt("skips an attachment that exceeds the size cap instead of failing the whole message ingest", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );

    // Mirrors the real IMAP adapter: openStream() returns a lazy Readable synchronously, and
    // the cap violation only surfaces as a stream error once something actually consumes it —
    // never as a synchronous throw from openStream() itself.
    async function* oversizedChunks() {
      yield Buffer.from("first-chunk");
      throw new AttachmentCapExceededError("IMAP attachment exceeded the cap");
    }
    const oversized: ClassifiedAttachment = {
      filename: "huge.bin",
      contentType: "application/octet-stream",
      contentId: null,
      disposition: "attachment",
      openStream: () => Readable.from(oversizedChunks()),
    };

    const warnSpy = vi.spyOn(logger, "warn");
    let result: Awaited<ReturnType<typeof ingestEmailMessage>>;
    try {
      result = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<with-oversized-attachment@x>",
          envelope: {},
          attachments: [oversized, attachment("kept.pdf", Buffer.from("kept-bytes"))],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const { rows: attachmentRows } = await pool.query(
        `SELECT filename FROM mail_attachments WHERE message_item_id = $1`,
        [result.itemId],
      );
      expect(attachmentRows.map((r) => r.filename)).toEqual(["kept.pdf"]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        { messageItemId: result.itemId, contentType: "application/octet-stream" },
        "Skipping attachment that exceeded the size cap",
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("huge.bin");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("IMAP BODYSTRUCTURE walking (issue #26)", () => {
  it("finds the text/html body leaf and both non-text leaves as attachment candidates, through nested multipart/related > multipart/mixed", () => {
    const tree: MessageStructureObject = {
      type: "multipart/related",
      childNodes: [
        {
          type: "multipart/mixed",
          childNodes: [
            { part: "1.1", type: "text/html" },
            {
              part: "1.2",
              type: "application/pdf",
              disposition: "attachment",
              dispositionParameters: { filename: "invoice.pdf" },
            },
          ],
        },
        {
          part: "2",
          type: "image/png",
          disposition: "inline",
          id: "<logo123>",
          dispositionParameters: { filename: "logo.png" },
        },
      ],
    };

    const result = walkBodyStructure(tree);
    expect(result.textHtmlPart?.part).toBe("1.1");
    expect(result.textPlainPart).toBeUndefined();
    expect(result.attachmentParts.map((p) => p.dispositionParameters?.filename)).toEqual(["invoice.pdf", "logo.png"]);
  });

  it("treats a single-part (no childNodes) text message as its own body leaf, never as an attachment candidate", () => {
    const tree: MessageStructureObject = { part: "1", type: "text/plain" };
    const result = walkBodyStructure(tree);
    expect(result.textPlainPart?.type).toBe("text/plain");
    expect(result.attachmentParts).toHaveLength(0);
  });

  it("picks both alternative text/plain and text/html leaves, wherever nested", () => {
    const tree: MessageStructureObject = {
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/plain" },
        { part: "2", type: "text/html" },
      ],
    };
    const result = walkBodyStructure(tree);
    expect(result.textPlainPart?.part).toBe("1");
    expect(result.textHtmlPart?.part).toBe("2");
  });
});

describe("HTML sanitization (issue #26)", () => {
  it("strips script tags and event handlers", () => {
    const sanitized = sanitizeMailHtml('<p onclick="steal()">hi</p><script>evil()</script>');
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain("hi");
  });

  it("strips remote images by default but keeps inline cid: images", () => {
    const sanitized = sanitizeMailHtml('<img src="https://tracker.example/pixel.gif"><img src="cid:logo">');
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).toContain("cid:logo");
  });

  it("allows remote images when explicitly requested", () => {
    const sanitized = sanitizeMailHtml('<img src="https://example.com/photo.jpg">', { allowRemoteImages: true });
    expect(sanitized).toContain("https://example.com/photo.jpg");
  });

  it("strips a CSS background-image url from an inline style attribute (a tracking pixel by another door)", () => {
    const sanitized = sanitizeMailHtml(
      '<div style="background-image:url(https://tracker.example/pixel.gif); color: red">hi</div>',
    );
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("url(");
    expect(sanitized).toContain("color:red");
  });

  it("rejects a url() smuggled inside an otherwise-allowed color: rgb(...) value", () => {
    const sanitized = sanitizeMailHtml(
      '<div style="color: rgb(0,0,0) url(https://tracker.example/pixel.gif)">hi</div>',
    );
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("url(");
  });

  it("still allows a plain rgb() color value", () => {
    const sanitized = sanitizeMailHtml('<div style="color: rgb(12, 34, 56)">hi</div>');
    expect(sanitized).toContain("rgb(12, 34, 56)");
  });

  it("strips a <style> block wholesale, including any url() it carries", () => {
    const sanitized = sanitizeMailHtml(
      "<style>body { background: url(https://tracker.example/pixel.gif); }</style><p>hi</p>",
    );
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).toContain("hi");
  });

  // A protocol-relative source names a remote host without a scheme (R1 F1). The forms below are the
  // ones the sanitizer is known to classify as protocol-relative today; entities reach it decoded.
  const PROTOCOL_RELATIVE_SOURCES = [
    ["two slashes", "//tracker.example/p.gif"],
    ["two backslashes", "\\\\tracker.example\\p.gif"],
    ["a slash and a backslash", "/\\tracker.example/p.gif"],
    ["a leading space", " //tracker.example/p.gif"],
    ["an embedded tab", "/\t/tracker.example/p.gif"],
    ["an embedded newline", "/\n/tracker.example/p.gif"],
    ["an embedded comment", "/<!-- x -->/tracker.example/p.gif"],
    ["decimal entities", "&#47;&#47;tracker.example/p.gif"],
    ["hexadecimal entities", "&#x2F;&#x2f;tracker.example/p.gif"],
    ["named entities", "&sol;&sol;tracker.example/p.gif"],
  ] as const;
  const DEFAULT_AND_FALSE = [
    ["by default", undefined],
    ["with allowRemoteImages false", false],
  ] as const;

  it.each(
    PROTOCOL_RELATIVE_SOURCES.flatMap(([form, source]) =>
      DEFAULT_AND_FALSE.map(([mode, allow]) => [form, mode, source, allow] as const),
    ),
  )("strips a protocol-relative image source written with %s %s", (_form, _mode, source, allow) => {
    const html = `<p>hi</p><img src="${source}" alt="pixel">`;
    const sanitized =
      allow === undefined ? sanitizeMailHtml(html) : sanitizeMailHtml(html, { allowRemoteImages: allow });
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).toContain('alt="pixel"');
    expect(sanitized).toContain("hi");
  });

  it.each(PROTOCOL_RELATIVE_SOURCES)(
    "keeps a protocol-relative image source written with %s when remote images are allowed",
    (_form, source) => {
      const sanitized = sanitizeMailHtml(`<img src="${source}" alt="pixel">`, { allowRemoteImages: true });
      expect(sanitized).toContain("tracker.example");
      expect(sanitized).toContain('alt="pixel"');
    },
  );

  it.each([...DEFAULT_AND_FALSE, ["with allowRemoteImages true", true]] as const)(
    "keeps protocol-relative links, inline data:/cid: images and relative sources as before %s",
    (_mode, allow) => {
      const html =
        '<a href="//example.com/x">link</a><img src="data:image/png;base64,AAAA"><img src="cid:logo"><img src="/local.png">';
      const sanitized =
        allow === undefined ? sanitizeMailHtml(html) : sanitizeMailHtml(html, { allowRemoteImages: allow });
      expect(sanitized).toContain('href="//example.com/x"');
      expect(sanitized).toContain('src="data:image/png;base64,AAAA"');
      expect(sanitized).toContain('src="cid:logo"');
      expect(sanitized).toContain('src="/local.png"');
    },
  );
});

describe("full-text search over Emails (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("indexes and finds a message by content", async () => {
    const emailsId = await databaseIdFor("emails");
    const itemId = (
      await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: emailsId, properties: {} }))
    ).id;
    await withTransaction(pool, (client) =>
      reindexItemSearch(client, { itemId, databaseId: emailsId, text: "Invoice for consulting services" }),
    );

    const results = await withTransaction(pool, (client) =>
      searchItems(client, { databaseId: emailsId, query: "invoice" }),
    );
    expect(results.map((r) => r.itemId)).toContain(itemId);

    const noResults = await withTransaction(pool, (client) =>
      searchItems(client, { databaseId: emailsId, query: "nonexistentword" }),
    );
    expect(noResults.map((r) => r.itemId)).not.toContain(itemId);
  });

  it("ranks a more recently indexed match above an older one with identical text relevance", async () => {
    const emailsId = await databaseIdFor("emails");
    const olderId = (
      await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: emailsId, properties: {} }))
    ).id;
    const newerId = (
      await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: emailsId, properties: {} }))
    ).id;
    await withTransaction(pool, (client) =>
      reindexItemSearch(client, { itemId: olderId, databaseId: emailsId, text: "quarterly report" }),
    );
    await withTransaction(pool, (client) =>
      reindexItemSearch(client, { itemId: newerId, databaseId: emailsId, text: "quarterly report" }),
    );
    // Backdate the older row directly — both reindexItemSearch calls above ran within the same
    // instant, so without this the recency blend would have nothing to actually distinguish.
    await pool.query(`UPDATE item_search_index SET updated_at = now() - interval '90 days' WHERE item_id = $1`, [
      olderId,
    ]);

    const results = await withTransaction(pool, (client) =>
      searchItems(client, { databaseId: emailsId, query: "quarterly report" }),
    );
    const olderIndex = results.findIndex((r) => r.itemId === olderId);
    const newerIndex = results.findIndex((r) => r.itemId === newerId);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  describe("Gmail-style search operators", () => {
    it("parseMailSearchQuery splits operators from free text", () => {
      expect(
        parseMailSearchQuery("invoice from:alice@x.com has:attachment before:2026-01-01 after:2025-01-01"),
      ).toEqual({
        freeText: "invoice",
        from: "alice@x.com",
        hasAttachment: true,
        before: "2026-01-01",
        after: "2025-01-01",
      });
      expect(parseMailSearchQuery("just some words")).toEqual({ freeText: "just some words" });
    });

    it("is:read/is:unread and is:flagged/is:unflagged parse into independent boolean dimensions", () => {
      expect(parseMailSearchQuery("invoice is:unread is:unflagged")).toEqual({
        freeText: "invoice",
        read: false,
        flagged: false,
      });
      expect(parseMailSearchQuery("is:read is:flagged")).toEqual({ freeText: "", read: true, flagged: true });
    });

    it("identical repeated is: operators collapse instead of conflicting", () => {
      expect(parseMailSearchQuery("is:unread is:unread")).toEqual({ freeText: "", read: false });
      expect(parseMailSearchQuery("is:flagged is:flagged")).toEqual({ freeText: "", flagged: true });
    });

    it("an unrecognized is: value is left in free text rather than silently discarded", () => {
      expect(parseMailSearchQuery("invoice is:spam")).toEqual({ freeText: "invoice is:spam" });
    });

    it("is:read is:unread fails as a contradictory validation error", () => {
      expect(() => parseMailSearchQuery("is:read is:unread")).toThrow(ValidationError);
      try {
        parseMailSearchQuery("is:read is:unread");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).details).toEqual({ field: "is:read", conflict: ["read", "unread"] });
      }
    });

    it("is:flagged is:unflagged fails as a contradictory validation error", () => {
      try {
        parseMailSearchQuery("is:flagged is:unflagged");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).details).toEqual({ field: "is:flagged", conflict: ["flagged", "unflagged"] });
      }
    });

    tenantIt("from: filters by the sender display text", async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );

      const fromAlice = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<alice@x>",
          subject: "Report",
          envelope: { from: { address: "alice@x.com" } },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );
      await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<bob@x>",
          subject: "Report",
          envelope: { from: { address: "bob@x.com" } },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const results = await searchItems(pool, { databaseId: emailsId, query: "report from:alice@x.com" });
      expect(results.map((r) => r.itemId)).toEqual([fromAlice.itemId]);
    });

    tenantIt(
      "is:read/is:unread and is:flagged/is:unflagged filter on the canonical structured properties (issue #90)",
      async () => {
        const emailsId = await databaseIdFor("emails");
        const foldersId = await databaseIdFor("folders");
        const filesId = await databaseIdFor("files");
        const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
        const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
        const folder = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: foldersId, properties: { name: "INBOX" } },
            { allowedSystemKeys: ["name"] },
          ),
        );

        const ingest = (messageId: string, flags: string[] | undefined) =>
          withTransaction(pool, (client) =>
            ingestEmailMessage(client, {
              emailsDatabaseId: emailsId,
              filesDatabaseId: filesId,
              folderRelationPropertyId: folderProperty.id,
              attachmentsRelationPropertyId: attachmentsProperty.id,
              folderItemId: folder.id,
              mailboxItemId: TEST_MAILBOX_ITEM_ID,
              messageId,
              subject: "Report",
              envelope: { from: { address: "alice@x.com" } },
              attachments: [],
              storage: noopStorage,
              storageKeyPrefix: "test",
              flags,
            }),
          );

        // Legacy row: no flags reported at ingest at all, the documented default is unread/unflagged.
        const legacy = await ingest("<legacy@x>", undefined);
        const readOnly = await ingest("<read@x>", [IMAP_SEEN_FLAG]);
        const flaggedOnly = await ingest("<flagged@x>", [IMAP_FLAGGED_FLAG]);
        const readAndFlagged = await ingest("<both@x>", [IMAP_SEEN_FLAG, IMAP_FLAGGED_FLAG]);

        const unread = await searchItems(pool, { databaseId: emailsId, query: "report is:unread" });
        expect(unread.map((r) => r.itemId).sort()).toEqual([flaggedOnly.itemId, legacy.itemId].sort());

        const read = await searchItems(pool, { databaseId: emailsId, query: "report is:read" });
        expect(read.map((r) => r.itemId).sort()).toEqual([readAndFlagged.itemId, readOnly.itemId].sort());

        const unflagged = await searchItems(pool, { databaseId: emailsId, query: "report is:unflagged" });
        expect(unflagged.map((r) => r.itemId).sort()).toEqual([legacy.itemId, readOnly.itemId].sort());

        const flagged = await searchItems(pool, { databaseId: emailsId, query: "report is:flagged" });
        expect(flagged.map((r) => r.itemId).sort()).toEqual([flaggedOnly.itemId, readAndFlagged.itemId].sort());

        // Read and flagged dimensions compose with AND, and with an unrelated existing operator (from:).
        const readAndFlaggedQuery = await searchItems(pool, {
          databaseId: emailsId,
          query: "report is:read is:flagged from:alice@x.com",
        });
        expect(readAndFlaggedQuery.map((r) => r.itemId)).toEqual([readAndFlagged.itemId]);
      },
    );
  });
});

describe("periodic search reindex sweep (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("indexes an Emails item that was written outside ingestEmailMessage's own standard path", async () => {
    const emailsId = await databaseIdFor("emails");
    // Direct choke-point item creation, bypassing ingestEmailMessage/reindexItemSearch entirely
    // — the exact "migration/backfill wrote outside the standard path" scenario the sweep
    // exists for.
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: emailsId, properties: { name: "Backfilled subject", body: "UnindexedBackfillKeyword" } },
        { allowedSystemKeys: ["name", "body"] },
      ),
    );

    const beforeSweep = await searchItems(pool, { databaseId: emailsId, query: "UnindexedBackfillKeyword" });
    expect(beforeSweep.map((r) => r.itemId)).not.toContain(item.id);

    await handleMailSearchReindexSweepTask(pool);

    const afterSweep = await searchItems(pool, { databaseId: emailsId, query: "UnindexedBackfillKeyword" });
    expect(afterSweep.map((r) => r.itemId)).toContain(item.id);
  });
});

describe("credentials (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("round-trips a stored secret and logs every decryption", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );

    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );
    const decrypted = await withTransaction(pool, (client) =>
      getDecryptedCredential(client, { itemId: mailbox.id, actorType: "sync_worker", purpose: "imap_sync" }),
    );
    expect(decrypted).toBe("s3cr3t");

    const { rows } = await pool.query(`SELECT actor_type, purpose FROM credential_access_log WHERE item_id = $1`, [
      mailbox.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "sync_worker", purpose: "imap_sync" });
  });

  it("returns null and logs nothing when no credential is stored", async () => {
    const missingItemId = randomUUID();
    const decrypted = await withTransaction(pool, (client) =>
      getDecryptedCredential(client, { itemId: missingItemId, actorType: "sync_worker", purpose: "imap_sync" }),
    );
    expect(decrypted).toBeNull();
    const { rows } = await pool.query(`SELECT 1 FROM credential_access_log WHERE item_id = $1`, [missingItemId]);
    expect(rows).toHaveLength(0);
  });
});

describe("sync_mode defaulting by provider (issue #26)", () => {
  it("maps each Mailbox.provider value to its documented default sync_mode", () => {
    expect(defaultSyncModeForProvider("gmail")).toBe("gmail_api");
    expect(defaultSyncModeForProvider("outlook")).toBe("graph_api");
    expect(defaultSyncModeForProvider("icloud")).toBe("imap");
    expect(defaultSyncModeForProvider("generic")).toBe("imap");
  });
});

describe("IMAP reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function fakeImapClient(overrides: Partial<ImapMailClient> = {}): ImapMailClient {
    return {
      appendMessage: async () => {},
      getCapabilities: async () => new Set(["CONDSTORE", "QRESYNC"]),
      listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
      selectFolder: async () => ({ uidvalidity: 111, uidnext: 3, highestModSeq: 5 }),
      fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
        {
          uid: 1,
          message: {
            messageId: "<one@x>",
            envelope: { from: { address: "a@x.com" } },
            subject: "First",
            attachments: [],
          },
        },
        {
          uid: 2,
          message: {
            messageId: "<two@x>",
            envelope: { from: { address: "b@x.com" } },
            subject: "Second",
            attachments: [],
          },
        },
      ],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [1, 2],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {},
      close: async () => {},
      ...overrides,
    };
  }

  tenantIt("initial sync ingests every fetched message and creates the INBOX folder", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );

    await withTransaction(pool, (client) =>
      reconcileImapAccount(client, fakeImapClient(), {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
        mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
        attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
        storage: noopStorage,
        storageKeyPrefix: "test",
      }),
    );

    const { rows: folderRows } = await pool.query(`SELECT properties FROM items WHERE database_id = $1`, [foldersId]);
    expect(folderRows).toHaveLength(1);
    expect(folderRows[0].properties.specialPurpose).toBe("inbox");

    const { rows: emailRows } = await pool.query(
      `SELECT properties FROM items WHERE database_id = $1 ORDER BY properties->>'name'`,
      [emailsId],
    );
    expect(emailRows.map((r) => r.properties.name)).toEqual(["First", "Second"]);
  });

  tenantIt("a UIDVALIDITY change resets folder sync state and forces a full re-fetch", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    const params = {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await withTransaction(pool, (client) => reconcileImapAccount(client, fakeImapClient(), params));

    let fetchCallCount = 0;
    const secondClient = fakeImapClient({
      selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1 }),
      fetchMessagesSince: async (_path, sinceUid) => {
        fetchCallCount++;
        expect(sinceUid).toBe(1); // reset back to the start, not resumed from the old uidnext
        return [];
      },
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, secondClient, params));
    expect(fetchCallCount).toBe(1);

    const { rows } = await pool.query(`SELECT uidvalidity FROM mail_folder_sync_state`);
    expect(rows[0].uidvalidity).toBe("999");
  });

  tenantIt(
    "re-observing the same message under a new UID after a UIDVALIDITY reset updates its edge in place, never adds a second one",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");
      const emailProps = await chokePoint.listProperties(emailsId);
      const folderProps = await chokePoint.listProperties(foldersId);
      const folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      const params = {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        folderRelationPropertyId,
        mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
        attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
        storage: noopStorage,
        storageKeyPrefix: "test",
      };

      const firstPassImap = fakeImapClient({
        fetchMessagesSince: async () => [
          {
            uid: 5,
            message: {
              messageId: "<survivor@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Survivor",
              attachments: [],
            },
          },
        ],
      });
      await withTransaction(pool, (client) => reconcileImapAccount(client, firstPassImap, params));

      const secondPassImap = fakeImapClient({
        selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1 }),
        // Server rebuilt the folder (UIDVALIDITY changed) — the same message now has UID 1, not 5.
        fetchMessagesSince: async () => [
          {
            uid: 1,
            message: {
              messageId: "<survivor@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Survivor",
              attachments: [],
            },
          },
        ],
      });
      await withTransaction(pool, (client) => reconcileImapAccount(client, secondPassImap, params));

      const { rows: emailRows } = await pool.query(`SELECT id FROM items WHERE database_id = $1`, [emailsId]);
      expect(emailRows).toHaveLength(1); // still one Emails item, not a duplicate

      const { rows: edgeRows } = await pool.query(
        `SELECT metadata FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
        [folderRelationPropertyId, emailRows[0].id],
      );
      expect(edgeRows).toHaveLength(1); // one edge, updated in place — not a second, stale-generation edge
      expect(edgeRows[0].metadata).toEqual({ uid: 1 }); // carries the new UID, not the pre-reset one
    },
  );

  tenantIt("removes the folder edge for a vanished UID", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    const params = {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };

    await withTransaction(pool, (client) => reconcileImapAccount(client, fakeImapClient(), params));
    expect((await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId])).rows[0].count).toBe("2");

    const client2 = fakeImapClient({
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [1],
    });
    await withTransaction(pool, (client) => reconcileImapAccount(client, client2, params));

    const { rows } = await pool.query(
      `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1)`,
      [emailProps.find((p) => p.key === "folder")!.id],
    );
    expect(Number(rows[0].count)).toBe(1); // one of the two original edges was removed
  });

  tenantIt(
    "Gmail in IMAP fallback mode: derives label-folder membership from X-GM-LABELS alongside the physical All Mail edge",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");
      const emailProps = await chokePoint.listProperties(emailsId);
      const folderProps = await chokePoint.listProperties(foldersId);

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      const params = {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
        mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
        attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
        storage: noopStorage,
        storageKeyPrefix: "test",
        folderPaths: ["[Gmail]/All Mail"],
      };

      const gmailImap = fakeImapClient({
        listFolders: async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
          {
            uid: 1,
            message: {
              messageId: "<labeled@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Labeled",
              attachments: [],
              gmailLabels: ["\\Inbox", "Work"],
            },
          },
        ],
      });
      await withTransaction(pool, (client) => reconcileImapAccount(client, gmailImap, params));

      const { rows: folderRows } = await pool.query(
        `SELECT properties FROM items WHERE database_id = $1 ORDER BY properties->>'providerId'`,
        [foldersId],
      );
      // All Mail (the physical folder synced) plus the two labels.
      expect(folderRows.map((r) => r.properties.providerId).sort()).toEqual(["Work", "[Gmail]/All Mail", "\\Inbox"]);
      expect(folderRows.find((r) => r.properties.providerId === "\\Inbox")).toMatchObject({
        properties: { behavior: "label", specialPurpose: "inbox" },
      });
      expect(folderRows.find((r) => r.properties.providerId === "Work")).toMatchObject({
        properties: { behavior: "label", specialPurpose: "none" },
      });

      const emailItemId = (await pool.query(`SELECT id FROM items WHERE database_id = $1`, [emailsId])).rows[0].id;
      const { rows: edgeCount } = await pool.query(
        `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
        [emailProps.find((p) => p.key === "folder")!.id, emailItemId],
      );
      expect(Number(edgeCount[0].count)).toBe(3); // All Mail + \Inbox + Work

      // A second pass re-observing the same message with one label dropped removes only that
      // label's edge, keeping the physical All Mail edge and the other label. The fake client's
      // fetchMessagesSince ignores the sinceUid it's called with (same as every other fake
      // client in this file) so it can simply re-report uid 1 with a narrowed label set.
      const gmailImapRelabeled = fakeImapClient({
        listFolders: async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async (): Promise<ImapFetchedMessage[]> => [
          {
            uid: 1,
            message: {
              messageId: "<labeled@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Labeled",
              attachments: [],
              gmailLabels: ["Work"],
            },
          },
        ],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [1],
      });
      await withTransaction(pool, (client) => reconcileImapAccount(client, gmailImapRelabeled, params));

      const { rows: edgeCountAfter } = await pool.query(
        `SELECT count(*) FROM item_relations WHERE relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1) AND (item_a = $2 OR item_b = $2)`,
        [emailProps.find((p) => p.key === "folder")!.id, emailItemId],
      );
      expect(Number(edgeCountAfter[0].count)).toBe(2); // All Mail + Work; \Inbox's edge was dropped
    },
  );
});

describe("Gmail reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function fakeGmailClient(overrides: Partial<GmailMailClient> = {}): GmailMailClient {
    return {
      getCurrentHistoryId: async () => "100",
      listHistorySince: async () => ({
        invalidated: false,
        newHistoryId: "101",
        changedMessageIds: [],
        removedMessageIds: [],
      }),
      listAllMessageIds: async () => ["m1"],
      fetchMessage: async (id) => ({
        id,
        threadId: "t1",
        labelIds: ["INBOX"],
        message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, subject: "Hi", attachments: [] },
      }),
      listLabels: async () => [{ id: "INBOX", name: "INBOX", type: "system" }],
      modifyMessageLabels: async () => {},
      ...overrides,
    };
  }

  async function reconcileParams() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    return {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };
  }

  it("initial sync (no stored historyId) does a full listAllMessageIds pass and stores the returned historyId", async () => {
    const params = await reconcileParams();
    await inTenantZero(() =>
      withTransaction(pool, (client) => reconcileGmailAccount(client, fakeGmailClient(), params)),
    );

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.gmailHistoryId).toBe("100");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("1");
  });

  it("a history.list 404 (invalidated) clears the stored historyId and forces a full resync instead of resuming", async () => {
    const params = await reconcileParams();
    await inTenantZero(() =>
      withTransaction(pool, (client) => reconcileGmailAccount(client, fakeGmailClient(), params)),
    );

    let fullResyncCallCount = 0;
    const secondClient = fakeGmailClient({
      listHistorySince: async () => ({
        invalidated: true,
        newHistoryId: "100",
        changedMessageIds: [],
        removedMessageIds: [],
      }),
      listAllMessageIds: async () => {
        fullResyncCallCount++;
        return ["m2"];
      },
      getCurrentHistoryId: async () => "200",
      fetchMessage: async (id) => ({
        id,
        threadId: "t2",
        labelIds: ["INBOX"],
        message: {
          messageId: `<${id}@x>`,
          envelope: { from: { address: "b@x.com" } },
          subject: "Second",
          attachments: [],
        },
      }),
    });
    await inTenantZero(() => withTransaction(pool, (client) => reconcileGmailAccount(client, secondClient, params)));

    expect(fullResyncCallCount).toBe(1);
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.gmailHistoryId).toBe("200");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("2"); // the first sync's message plus the resync's new one
  });

  it("writes Gmail read and flagged transitions, and a matching history observation converges without an echo", async () => {
    const params = await reconcileParams();
    await inTenantZero(() =>
      withTransaction(pool, (client) => reconcileGmailAccount(client, fakeGmailClient(), params)),
    );
    const emailItemId = (
      await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [params.emailsDatabaseId])
    ).rows[0]!.id;
    const writes: Array<{ id: string; add: string[]; remove: string[] }> = [];
    const writer = fakeGmailClient({
      modifyMessageLabels: async (id, add, remove) => {
        writes.push({ id, add, remove });
      },
    });

    await chokePoint.updateItem({
      databaseId: params.emailsDatabaseId,
      itemId: emailItemId,
      propertiesPatch: { read: true, flagged: true },
    });
    await inTenantZero(() => withTransaction(pool, (client) => reconcileGmailAccount(client, writer, params)));
    expect(writes).toEqual([
      { id: "m1", add: ["STARRED"], remove: [] },
      { id: "m1", add: [], remove: ["UNREAD"] },
    ]);

    await chokePoint.updateItem({
      databaseId: params.emailsDatabaseId,
      itemId: emailItemId,
      propertiesPatch: { read: false, flagged: false },
    });
    await inTenantZero(() => withTransaction(pool, (client) => reconcileGmailAccount(client, writer, params)));
    expect(writes.slice(2)).toEqual([
      { id: "m1", add: [], remove: ["STARRED"] },
      { id: "m1", add: ["UNREAD"], remove: [] },
    ]);

    await chokePoint.updateItem({
      databaseId: params.emailsDatabaseId,
      itemId: emailItemId,
      propertiesPatch: { read: true },
    });
    const observed = fakeGmailClient({
      listHistorySince: async () => ({
        invalidated: false,
        newHistoryId: "102",
        changedMessageIds: ["m1"],
        removedMessageIds: [],
      }),
      fetchMessage: async () => ({
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"],
        message: { messageId: "<m1@x>", envelope: {}, attachments: [], flags: [IMAP_SEEN_FLAG] },
      }),
      modifyMessageLabels: async () => {
        throw new Error("converged Gmail observation must not echo");
      },
    });
    await inTenantZero(() => withTransaction(pool, (client) => reconcileGmailAccount(client, observed, params)));
  });
});

describe("Graph reconcile core (issue #26)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  function fakeGraphClient(overrides: Partial<GraphMailClient> = {}): GraphMailClient {
    return {
      listFolders: async () => [{ id: "f1", displayName: "Inbox", wellKnownName: "inbox" }],
      fetchDelta: async () => ({
        invalidated: false,
        newDeltaLink: "link-1",
        changes: [
          {
            id: "m1",
            parentFolderId: "f1",
            removed: false,
            message: {
              messageId: "<m1@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Hi",
              attachments: [],
            },
          },
        ],
      }),
      patchMessage: async () => {},
      ...overrides,
    };
  }

  async function reconcileParams() {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    return {
      mailboxItemId: mailbox.id,
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      folderRelationPropertyId: emailProps.find((p) => p.key === "folder")!.id,
      mailboxFolderRelationPropertyId: folderProps.find((p) => p.key === "mailbox")!.id,
      attachmentsRelationPropertyId: emailProps.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
    };
  }

  tenantIt("ingests a delta change into its parent folder and stores the returned deltaLink", async () => {
    const params = await reconcileParams();
    await withTransaction(pool, (client) => reconcileGraphAccount(client, fakeGraphClient(), params));

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
    expect(state?.graphDeltaLink).toBe("link-1");
    const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
    expect(rows[0].count).toBe("1");
  });

  tenantIt(
    "keeps Graph item/reference annotations in the message body without creating placeholder Files rows on repeat reconcile",
    async () => {
      const params = await reconcileParams();
      const graphMessage = {
        messageId: "<graph-non-file@x>",
        envelope: { from: { address: "a@x.com" } },
        subject: "Mixed attachments",
        bodyHtml: "<p>Message</p><p>[itemAttachment: meeting]</p><p>[referenceAttachment: shared document]</p>",
        attachments: [
          {
            filename: "report.txt",
            contentType: "text/plain",
            contentId: null,
            disposition: "attachment" as const,
            openStream: () => Readable.from("real file"),
          },
        ],
      };
      const graph = fakeGraphClient({
        fetchDelta: async () => ({
          invalidated: false,
          newDeltaLink: "link-mixed",
          changes: [{ id: "mixed-1", parentFolderId: "f1", removed: false, message: graphMessage }],
        }),
      });

      await withTransaction(pool, (client) => reconcileGraphAccount(client, graph, params));
      await withTransaction(pool, (client) => reconcileGraphAccount(client, graph, params));

      const [emailRows, fileRows, attachmentRows] = await Promise.all([
        pool.query<{ body: string }>(
          `SELECT properties->>'body' AS body FROM items WHERE database_id = $1 AND properties->>'name' = $2`,
          [params.emailsDatabaseId, "Mixed attachments"],
        ),
        pool.query<{ count: string }>(`SELECT count(*) FROM items WHERE database_id = $1`, [params.filesDatabaseId]),
        pool.query<{ count: string }>(
          `SELECT count(*) FROM mail_attachments WHERE message_item_id = (SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = $2)`,
          [params.emailsDatabaseId, "Mixed attachments"],
        ),
      ]);

      expect(emailRows.rows).toHaveLength(1);
      const email = emailRows.rows[0];
      const fileCount = fileRows.rows[0];
      const attachmentCount = attachmentRows.rows[0];
      if (!email || !fileCount || !attachmentCount) throw new Error("Expected reconciled Graph attachment rows");
      expect(email.body).toBe(
        "<p>Message</p><p>[itemAttachment: meeting]</p><p>[referenceAttachment: shared document]</p>",
      );
      expect(fileCount.count).toBe("1");
      expect(attachmentCount.count).toBe("1");
    },
  );

  tenantIt(
    "a deltaLink 410 Gone (invalidated) clears the stored deltaLink and runs a full resync (fetchDelta(null)) instead of resuming",
    async () => {
      const params = await reconcileParams();
      await withTransaction(pool, (client) => reconcileGraphAccount(client, fakeGraphClient(), params));

      const deltaLinksSeen: (string | null)[] = [];
      const secondClient = fakeGraphClient({
        fetchDelta: async (deltaLink) => {
          deltaLinksSeen.push(deltaLink);
          if (deltaLink !== null) {
            return { invalidated: true, newDeltaLink: "", changes: [] };
          }
          return {
            invalidated: false,
            newDeltaLink: "link-2",
            changes: [
              {
                id: "m2",
                parentFolderId: "f1",
                removed: false,
                message: {
                  messageId: "<m2@x>",
                  envelope: { from: { address: "b@x.com" } },
                  subject: "Second",
                  attachments: [],
                },
              },
            ],
          };
        },
      });
      await withTransaction(pool, (client) => reconcileGraphAccount(client, secondClient, params));

      expect(deltaLinksSeen).toEqual(["link-1", null]); // resumed from the stored link, got invalidated, retried from scratch
      const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, params.mailboxItemId));
      expect(state?.graphDeltaLink).toBe("link-2");
      const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [params.emailsDatabaseId]);
      expect(rows[0].count).toBe("2");
    },
  );

  tenantIt(
    "writes Graph read and flagged transitions, and a matching delta observation converges without an echo",
    async () => {
      const params = await reconcileParams();
      await withTransaction(pool, (client) => reconcileGraphAccount(client, fakeGraphClient(), params));
      const emailItemId = (
        await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [params.emailsDatabaseId])
      ).rows[0]!.id;
      const writes: Array<{ id: string; patch: object }> = [];
      const writer = fakeGraphClient({
        patchMessage: async (id, patch) => {
          writes.push({ id, patch });
        },
      });

      await chokePoint.updateItem({
        databaseId: params.emailsDatabaseId,
        itemId: emailItemId,
        propertiesPatch: { read: true, flagged: true },
      });
      await withTransaction(pool, (client) => reconcileGraphAccount(client, writer, params));
      expect(writes).toEqual([
        { id: "m1", patch: { flag: { flagStatus: "flagged" } } },
        { id: "m1", patch: { isRead: true } },
      ]);

      await chokePoint.updateItem({
        databaseId: params.emailsDatabaseId,
        itemId: emailItemId,
        propertiesPatch: { read: false, flagged: false },
      });
      await withTransaction(pool, (client) => reconcileGraphAccount(client, writer, params));
      expect(writes.slice(2)).toEqual([
        { id: "m1", patch: { flag: { flagStatus: "notFlagged" } } },
        { id: "m1", patch: { isRead: false } },
      ]);

      await chokePoint.updateItem({
        databaseId: params.emailsDatabaseId,
        itemId: emailItemId,
        propertiesPatch: { read: true },
      });
      const observed = fakeGraphClient({
        fetchDelta: async () => ({
          invalidated: false,
          newDeltaLink: "link-2",
          changes: [
            {
              id: "m1",
              parentFolderId: "f1",
              removed: false,
              message: { messageId: "<m1@x>", envelope: {}, attachments: [], flags: [IMAP_SEEN_FLAG] },
            },
          ],
        }),
        patchMessage: async () => {
          throw new Error("converged Graph observation must not echo");
        },
      });
      await withTransaction(pool, (client) => reconcileGraphAccount(client, observed, params));
    },
  );
});

describe("mail sync job error handling (issue #26)", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  for (const scenario of [
    "existing",
    "inserted-after-baseline",
    "competing-completion",
    "completed-before-baseline",
    "competing-in-flight",
  ] as const)
    tenantIt(`runs the real Gmail move phase outside transactions before reconcile: ${scenario}`, async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let releaseOwner: () => void = () => {};
      let owner: Promise<void> | undefined;
      let ownerToken: string | null | undefined;
      let releaseBaseline: () => void = () => {};
      let ownerSettlement: Promise<PromiseSettledResult<void>[]> | undefined;
      let jobSettlement: Promise<PromiseSettledResult<void>[]> | undefined;
      let primary: { value: unknown } | undefined;
      const cleanupFailures: unknown[] = [];
      try {
        const moduleIds = {
          emailsDatabaseId: await databaseIdFor("emails"),
          filesDatabaseId: await databaseIdFor("files"),
          foldersDatabaseId: await databaseIdFor("folders"),
          mailboxesDatabaseId: await databaseIdFor("mailboxes"),
        };
        const fixture = await withTransaction(runtime, async (client) => {
          const mailbox = await createItemWithClient(client, {
            databaseId: moduleIds.mailboxesDatabaseId,
            properties: { name: "Mailbox" },
          });
          const message = await createItemWithClient(
            client,
            { databaseId: moduleIds.emailsDatabaseId, properties: { name: "Message" } },
            { allowedSystemKeys: ["name"] },
          );
          await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
          await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "fake" });
          await upsertMailMessageMeta(client, {
            itemId: message.id,
            mailboxItemId: mailbox.id,
            messageId: "<move-job@example.test>",
            providerMessageId: "fake-provider-id",
            envelope: {},
          });
          if (scenario === "existing" || scenario === "completed-before-baseline")
            await recordDesiredMailMessageMove(client, {
              messageItemId: message.id,
              mailboxItemId: mailbox.id,
              desiredPurpose: "archive",
              source: { provider: "gmail", providerMessageId: "fake-provider-id" },
            });
          return { mailbox: mailbox.id, message: message.id };
        });
        if (scenario === "completed-before-baseline") {
          const fetchProvider: typeof fetch = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: ["INBOX"] }))
            .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: [] }));
          await drainGmailMoves(runtime, fixture.mailbox, new GmailRestClient(async () => "fake-token", fetchProvider));
          expect(fetchProvider).toHaveBeenCalledTimes(2);
        }
        const calls: string[] = [];
        const assertNoTransaction = async () => {
          const result = await pool.query<{ pid: number; xact_start: Date | null }>(
            "SELECT pid, xact_start FROM pg_stat_activity WHERE datname = current_database() AND usename = 'semprec_data'",
          );
          expect(result.rows.length).toBeGreaterThan(0);
          expect(result.rows.every((row) => row.xact_start === null)).toBe(true);
        };
        const gmail: GmailMailClient = {
          observeMoveMessage: async () => {
            calls.push("observe");
            await assertNoTransaction();
            return { kind: "found", inTrash: false, inInbox: true, inSent: false };
          },
          getCurrentHistoryId: async () => {
            calls.push("reconcile");
            return "1";
          },
          listHistorySince: async () => ({
            invalidated: false,
            newHistoryId: "1",
            changedMessageIds: [],
            removedMessageIds: [],
          }),
          listAllMessageIds: async () => ["fake-provider-id"],
          fetchMessage: async () => ({
            id: "fake-provider-id",
            threadId: "fake-thread",
            labelIds: ["INBOX"],
            message: { messageId: "<move-job@example.test>", envelope: {}, attachments: [], flags: [IMAP_SEEN_FLAG] },
          }),
          listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
          modifyMessageLabels: async () => {},
        };
        registerGmailMovePreparer(gmail, async () => async () => {
          calls.push("move");
          await assertNoTransaction();
          const state = await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox));
          expect(state[0]).toMatchObject({ operation_phase: "in_flight", operation_step: "modify_labels" });
          return { kind: "acknowledged", inTrash: false, inInbox: false, inSent: false };
        });
        let baselineReady!: (pid: number) => void;
        const baselineReached = new Promise<number>((resolve) => {
          baselineReady = resolve;
        });
        const baselineGate = new Promise<void>((resolve) => {
          releaseBaseline = resolve;
        });
        let held = false;
        const wrapped = new WeakSet<object>();
        if (
          scenario === "inserted-after-baseline" ||
          scenario === "competing-completion" ||
          scenario === "competing-in-flight"
        )
          runtime.on("acquire", (client) => {
            if (wrapped.has(client)) return;
            wrapped.add(client);
            client.query = new Proxy(client.query.bind(client), {
              apply(target, thisArg, args: unknown[]) {
                const result: unknown = Reflect.apply(target, thisArg, args);
                if (
                  !held &&
                  typeof args[0] === "string" &&
                  args[0].includes(
                    "SELECT message_item_id, mailbox_item_id, desired_revision, status, operation_token",
                  ) &&
                  result instanceof Promise
                ) {
                  held = true;
                  return result.then(async (value: unknown) => {
                    const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                    if (!pid.rows[0]) throw new Error("Missing baseline backend pid");
                    baselineReady(pid.rows[0].pid);
                    await baselineGate;
                    return value;
                  });
                }
                return result;
              },
            });
          });
        const job = handleSyncMailAccountTask(
          runtime,
          { mailboxItemId: fixture.mailbox },
          { createGmailClient: () => gmail },
          moduleIds,
          noopStorage,
        );
        jobSettlement = Promise.allSettled([job]);
        if (
          scenario === "inserted-after-baseline" ||
          scenario === "competing-completion" ||
          scenario === "competing-in-flight"
        ) {
          try {
            const baselinePid = await waitForMoveTestSignal(baselineReached);
            const insertPid = await withTransaction(runtime, async (client) => {
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              await recordDesiredMailMessageMove(client, {
                messageItemId: fixture.message,
                mailboxItemId: fixture.mailbox,
                desiredPurpose: "archive",
                source: { provider: "gmail", providerMessageId: "fake-provider-id" },
              });
              return pid.rows[0]?.pid;
            });
            expect(insertPid).toBeTypeOf("number");
            expect(insertPid).not.toBe(baselinePid);
            process.stdout.write(`batch18 move overlap baseline=${baselinePid} inserted=${insertPid}\n`);
            if (scenario === "competing-completion") {
              const fetchProvider: typeof fetch = vi
                .fn()
                .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: ["INBOX"] }))
                .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: [] }));
              await drainGmailMoves(
                runtime,
                fixture.mailbox,
                new GmailRestClient(async () => "fake-token", fetchProvider),
              );
              expect(fetchProvider).toHaveBeenCalledTimes(2);
              expect(await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox))).toEqual([]);
            }
            if (scenario === "competing-in-flight") {
              let dispatchReady!: () => void;
              const dispatched = new Promise<void>((resolve) => {
                dispatchReady = resolve;
              });
              const gate = new Promise<void>((resolve) => {
                releaseOwner = resolve;
              });
              const fetchProvider: typeof fetch = vi
                .fn()
                .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: ["INBOX"] }))
                .mockImplementationOnce(async () => {
                  const state = await withTransaction(runtime, async (client) => ({
                    pid: (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
                    rows: await listPendingMoves(client, fixture.mailbox),
                  }));
                  expect(state.rows).toMatchObject([{ operation_phase: "in_flight" }]);
                  ownerToken = state.rows[0]?.operation_token;
                  expect(ownerToken).toBeTypeOf("string");
                  expect(state.pid).toBeTypeOf("number");
                  process.stdout.write(`batch18 gmail claimed owner=${state.pid}\n`);
                  dispatchReady();
                  await waitForMoveTestSignal(gate);
                  return Response.json({ id: "fake-provider-id", labelIds: [] });
                });
              owner = drainGmailMoves(
                runtime,
                fixture.mailbox,
                new GmailRestClient(async () => "fake-token", fetchProvider),
              );
              ownerSettlement = Promise.allSettled([owner]);
              await waitForMoveTestSignal(dispatched);
              expect(
                await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox)),
              ).toMatchObject([{ operation_phase: "in_flight" }]);
            }
          } finally {
            releaseBaseline();
          }
        }
        await waitForMoveTestSignal(job);
        expect(calls).toEqual(
          scenario === "competing-completion" ||
            scenario === "completed-before-baseline" ||
            scenario === "competing-in-flight"
            ? ["reconcile"]
            : ["observe", "move", "reconcile"],
        );
        if (scenario === "competing-in-flight") {
          expect(await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox))).toMatchObject([
            { operation_phase: "in_flight", operation_token: ownerToken },
          ]);
        } else
          expect(await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox))).toEqual([]);
        const oldEdges = await withTransaction(runtime, (client) =>
          client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM item_relations edge JOIN items folder ON
         (folder.id = edge.item_a OR folder.id = edge.item_b)
         WHERE (edge.item_a = $1 OR edge.item_b = $1) AND folder.properties ->> 'providerId' = 'INBOX'`,
            [fixture.message],
          ),
        );
        expect(oldEdges.rows[0]?.count).toBe(scenario === "completed-before-baseline" ? "1" : "0");
        const observed = await withTransaction(runtime, (client) =>
          client.query<{ read: string | null }>("SELECT properties ->> 'read' AS read FROM items WHERE id = $1", [
            fixture.message,
          ]),
        );
        if (scenario === "completed-before-baseline") expect(observed.rows[0]?.read).toBe("true");
        else expect(observed.rows[0]?.read).not.toBe("true");
        expect(
          (await withTransaction(runtime, (client) => getMailMessageMetaByItemId(client, fixture.message)))
            ?.providerMessageId,
        ).toBe("fake-provider-id");
        if (owner) {
          releaseOwner();
          await waitForMoveTestSignal(owner);
          expect(await withTransaction(runtime, (client) => listPendingMoves(client, fixture.mailbox))).toEqual([]);
        }
      } catch (error) {
        primary = { value: error };
      } finally {
        releaseBaseline();
        releaseOwner();
        for (const settlement of [ownerSettlement, jobSettlement]) {
          if (!settlement) continue;
          for (const result of await settlement) {
            if (result.status === "rejected") cleanupFailures.push(result.reason);
          }
        }
        try {
          await runtime.end();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (primary && cleanupFailures.length)
        throw new AggregateError([primary.value, ...cleanupFailures], "Gmail move test and cleanup failed", {
          cause: primary.value,
        });
      if (primary) throw primary.value;
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Gmail move test cleanup failed");
    });

  for (const provider of ["graph", "imap"] as const)
    for (const scenario of ["competing-completion", "competing-in-flight", "completed-before-baseline"] as const)
      tenantIt(`protects ${provider} job observations for ${scenario}`, async () => {
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        let releaseOwner: () => void = () => {};
        let owner: Promise<void> | undefined;
        let ownerToken: string | null | undefined;
        let releaseBaseline: () => void = () => {};
        let ownerSettlement: Promise<PromiseSettledResult<void>[]> | undefined;
        let jobSettlement: Promise<PromiseSettledResult<void>[]> | undefined;
        let primary: { value: unknown } | undefined;
        const cleanupFailures: unknown[] = [];
        try {
          const moduleIds = {
            emailsDatabaseId: await databaseIdFor("emails"),
            filesDatabaseId: await databaseIdFor("files"),
            foldersDatabaseId: await databaseIdFor("folders"),
            mailboxesDatabaseId: await databaseIdFor("mailboxes"),
          };
          const f = await withTransaction(runtime, async (client) => {
            const emailFolder = await getPropertyByKey(client, moduleIds.emailsDatabaseId, "folder");
            const mailboxFolder = await getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox");
            if (!emailFolder || !mailboxFolder) throw new Error("Missing mail relations");
            const mailbox = await createItemWithClient(client, {
              databaseId: moduleIds.mailboxesDatabaseId,
              properties: { name: "Mailbox" },
            });
            const message = await createItemWithClient(
              client,
              { databaseId: moduleIds.emailsDatabaseId, properties: { name: "Message" } },
              { allowedSystemKeys: ["name"] },
            );
            await ensureMailAccountSyncState(client, {
              itemId: mailbox.id,
              syncMode: provider === "graph" ? "graph_api" : "imap",
            });
            await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "fake" });
            await upsertMailMessageMeta(client, {
              itemId: message.id,
              mailboxItemId: mailbox.id,
              messageId: "<baseline@example.test>",
              ...(provider === "graph" ? { providerMessageId: "old-id" } : {}),
              envelope: {},
            });
            const folder = async (path: string, specialPurpose: string, validity: string) => {
              const id = await ensureFolderItem(client, {
                foldersDatabaseId: moduleIds.foldersDatabaseId,
                mailboxItemId: mailbox.id,
                mailboxRelationPropertyId: mailboxFolder.id,
                providerId: path,
                name: path,
                behavior: "folder",
                specialPurpose,
              });
              if (provider === "imap") {
                await ensureMailFolderSyncState(client, id);
                await recordReconcile(client, {
                  itemId: id,
                  uidvalidity: validity,
                  uidnext: path === "Source" ? "1" : "50",
                  highestmodseq: null,
                });
              }
              return id;
            };
            const source = await folder("Source", "inbox", "11");
            const target = await folder("Destination", "archive", "12");
            await createRelationWithClient(
              client,
              {
                relationPropertyId: emailFolder.id,
                callerItemId: message.id,
                targetItemId: source,
                ...(provider === "imap" ? { metadata: { uid: 7 } } : {}),
              },
              EMAILS_RELATION_CONTEXT,
            );
            return {
              mailbox: mailbox.id,
              message: message.id,
              source,
              target,
              folderProperty: emailFolder.id,
              mailboxProperty: mailboxFolder.id,
            };
          });
          const recordIntent = () =>
            withTransaction(runtime, async (client) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await recordDesiredMailMessageMove(client, {
                messageItemId: f.message,
                mailboxItemId: f.mailbox,
                desiredPurpose: "archive",
                source:
                  provider === "graph"
                    ? { provider: "graph", providerMessageId: "old-id" }
                    : { provider: "imap", folderItemId: f.source, path: "Source", uid: 7, uidValidity: "11" },
              });
              await deleteRelationWithClient(
                client,
                { relationPropertyId: f.folderProperty, callerItemId: f.message, targetItemId: f.source },
                EMAILS_RELATION_CONTEXT,
              );
              await createRelationWithClient(
                client,
                { relationPropertyId: f.folderProperty, callerItemId: f.message, targetItemId: f.target },
                EMAILS_RELATION_CONTEXT,
              );
              return pid;
            });
          let dispatchReady!: () => void;
          const dispatched = new Promise<void>((resolve) => {
            dispatchReady = resolve;
          });
          const ownerGate = new Promise<void>((resolve) => {
            releaseOwner = resolve;
          });
          let dispatchCount = 0;
          const perform = async () => {
            dispatchCount++;
            const state = await withTransaction(runtime, async (client) => ({
              pid: (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
              rows: await listPendingMoves(client, f.mailbox),
            }));
            expect(state.rows).toMatchObject([{ operation_phase: "in_flight" }]);
            ownerToken = state.rows[0]?.operation_token;
            expect(ownerToken).toBeTypeOf("string");
            expect(state.pid).toBeTypeOf("number");
            process.stdout.write(`batch18 ${provider} move owner=${state.pid}\n`);
            dispatchReady();
            if (scenario === "competing-in-flight") await waitForMoveTestSignal(ownerGate);
          };
          const runOwner = (): Promise<void> => {
            if (provider === "graph") {
              const request: typeof fetch = vi
                .fn()
                .mockResolvedValueOnce(Response.json({ id: "old-id", parentFolderId: "Source" }))
                .mockImplementationOnce(async () => {
                  await perform();
                  return Response.json({ id: "new-id" });
                });
              return drainGraphMoves(
                runtime,
                f.mailbox,
                new GraphRestClient(async () => "fake-token", request),
                moduleIds.foldersDatabaseId,
                f.mailboxProperty,
              );
            }
            const unexpected = async (): Promise<never> => {
              throw new Error("Unexpected IMAP move read or append");
            };
            const moveClient: ImapMailClient = {
              prepareMove: async () => ({ uidValidity: "11", capabilities: new Set(["MOVE"]), found: true }),
              executeMoveStep: async () => {
                await perform();
                return { kind: "acknowledged" as const, targetUid: 27, targetUidValidity: "12" };
              },
              getCapabilities: unexpected,
              listFolders: unexpected,
              selectFolder: unexpected,
              fetchMessagesSince: unexpected,
              fetchVanishedSince: unexpected,
              fetchAllUids: unexpected,
              fetchFlagsChangedSince: unexpected,
              setMessageFlag: unexpected,
              appendMessage: unexpected,
              close: async () => {},
            };
            return drainImapMoves(
              runtime,
              f.mailbox,
              async () => moveClient,
              moduleIds.foldersDatabaseId,
              f.mailboxProperty,
              f.folderProperty,
            );
          };
          if (scenario === "completed-before-baseline") {
            await recordIntent();
            await runOwner();
          }
          const graph: GraphMailClient = {
            observeMoveMessage: async () => ({ kind: "found", id: "old-id", parentFolderId: "Source" }),
            listFolders: async () => [
              { id: "Source", displayName: "Source", wellKnownName: "inbox" },
              { id: "Destination", displayName: "Destination", wellKnownName: "archive" },
            ],
            fetchDelta: async () => ({
              invalidated: false,
              newDeltaLink: "delta",
              changes: [
                {
                  id: "old-id",
                  parentFolderId: "Source",
                  removed: false,
                  message: {
                    messageId: "<baseline@example.test>",
                    envelope: {},
                    attachments: [],
                    flags: [IMAP_SEEN_FLAG],
                  },
                },
              ],
            }),
            patchMessage: async () => {
              throw new Error("Unexpected Graph flag mutation");
            },
          };
          registerGraphMovePreparer(graph, async () => async () => {
            throw new Error("Duplicate Graph move dispatch");
          });
          const imap: ImapMailClient = {
            getCapabilities: async () => new Set(),
            listFolders: async () => [
              { path: "Source", specialUse: "\\Inbox" },
              { path: "Destination", specialUse: "\\Archive" },
            ],
            selectFolder: async (path) => ({
              uidvalidity: path === "Source" ? 11 : 12,
              uidnext: 50,
              highestModSeq: null,
            }),
            fetchMessagesSince: async (path) =>
              path === "Source"
                ? [
                    {
                      uid: 7,
                      message: {
                        messageId: "<baseline@example.test>",
                        envelope: {},
                        attachments: [],
                        flags: [IMAP_SEEN_FLAG],
                      },
                    },
                  ]
                : [],
            fetchVanishedSince: async () => null,
            fetchAllUids: async () => [7, 27],
            fetchFlagsChangedSince: async () => [],
            setMessageFlag: async () => {
              throw new Error("Unexpected IMAP flag mutation");
            },
            appendMessage: async () => {},
            close: async () => {},
          };
          const gate = scenario === "completed-before-baseline" ? undefined : holdMoveBaseline(runtime);
          if (gate) releaseBaseline = gate.release;
          const job = handleSyncMailAccountTask(
            runtime,
            { mailboxItemId: f.mailbox },
            { createGraphClient: () => graph, createImapClient: async () => imap },
            moduleIds,
            noopStorage,
          );
          jobSettlement = Promise.allSettled([job]);
          if (gate) {
            try {
              const baselinePid = await waitForMoveTestSignal(gate.reached);
              const intentPid = await recordIntent();
              expect(intentPid).toBeTypeOf("number");
              expect(intentPid).not.toBe(baselinePid);
              process.stdout.write(`batch18 ${provider} baseline=${baselinePid} intent=${intentPid}\n`);
              owner = runOwner();
              ownerSettlement = Promise.allSettled([owner]);
              await waitForMoveTestSignal(dispatched);
              if (scenario === "competing-completion") await waitForMoveTestSignal(owner);
            } finally {
              releaseBaseline();
            }
          }
          await waitForMoveTestSignal(job);
          const rows = await withTransaction(runtime, (client) => listPendingMoves(client, f.mailbox));
          if (scenario === "competing-in-flight")
            expect(rows).toMatchObject([{ operation_phase: "in_flight", operation_token: ownerToken }]);
          else expect(rows).toEqual([]);
          const observed = await withTransaction(runtime, async (client) => ({
            item: (
              await client.query<{ read: string | null }>(
                "SELECT properties ->> 'read' AS read FROM items WHERE id = $1",
                [f.message],
              )
            ).rows[0],
            meta: await getMailMessageMetaByItemId(client, f.message),
            edges: (
              await client.query<{ folder_id: string; uid: string | null }>(
                `SELECT CASE WHEN item_a = $1 THEN item_b ELSE item_a END AS folder_id, metadata ->> 'uid' AS uid FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = ANY($2::uuid[]) OR item_b = ANY($2::uuid[]))`,
                [f.message, [f.source, f.target]],
              )
            ).rows,
          }));
          if (scenario === "completed-before-baseline") expect(observed.item?.read).toBe("true");
          else {
            expect(observed.item?.read).not.toBe("true");
            expect(observed.edges.some((edge) => edge.folder_id === f.source)).toBe(false);
            expect(observed.edges.some((edge) => edge.folder_id === f.target)).toBe(true);
          }
          if (provider === "graph")
            expect(observed.meta?.providerMessageId).toBe(scenario === "competing-in-flight" ? "old-id" : "new-id");
          if (provider === "imap" && scenario === "competing-completion")
            expect(observed.edges.find((edge) => edge.folder_id === f.target)?.uid).toBe("27");
          if (scenario === "completed-before-baseline")
            expect(observed.edges.some((edge) => edge.folder_id === f.source)).toBe(true);
          const foreign = await createTestTenant(pool);
          const foreignView = await withTenantTransaction(runtime, foreign, async (client) => ({
            meta: await getMailMessageMetaByItemId(client, f.message),
            moves: await listPendingMoves(client, f.mailbox),
          }));
          expect(foreignView).toEqual({ meta: null, moves: [] });
          if (owner) {
            releaseOwner();
            await waitForMoveTestSignal(owner);
            expect(await withTransaction(runtime, (client) => listPendingMoves(client, f.mailbox))).toEqual([]);
          }
          if (scenario !== "completed-before-baseline") {
            const final = await withTransaction(runtime, async (client) => ({
              meta: await getMailMessageMetaByItemId(client, f.message),
              edge: (
                await client.query<{ uid: string | null }>(
                  `SELECT metadata ->> 'uid' AS uid FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = $2 OR item_b = $2)`,
                  [f.message, f.target],
                )
              ).rows,
              validity:
                provider === "imap"
                  ? (
                      await client.query<{ uidvalidity: string | null }>(
                        "SELECT uidvalidity FROM mail_folder_sync_state WHERE item_id = $1",
                        [f.target],
                      )
                    ).rows[0]?.uidvalidity
                  : undefined,
            }));
            if (provider === "graph") expect(final.meta?.providerMessageId).toBe("new-id");
            else {
              expect(final.edge).toEqual([{ uid: "27" }]);
              expect(final.validity).toBe("12");
            }
          }
          expect(dispatchCount).toBe(1);
        } catch (error) {
          primary = { value: error };
        } finally {
          releaseBaseline();
          releaseOwner();
          for (const settlement of [ownerSettlement, jobSettlement]) {
            if (!settlement) continue;
            for (const result of await settlement) {
              if (result.status === "rejected") cleanupFailures.push(result.reason);
            }
          }
          try {
            await runtime.end();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
        if (primary && cleanupFailures.length)
          throw new AggregateError([primary.value, ...cleanupFailures], "Move matrix and cleanup failed", {
            cause: primary.value,
          });
        if (primary) throw primary.value;
        if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Move matrix cleanup failed");
      });

  tenantIt(
    "persists last_error and pushes out next_expected_activity_at when a sync pass throws, surviving the aborted transaction's rollback",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );

      const failingImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => {
          throw new Error("connection refused");
        },
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };

      const adapters: MailSyncAdapterFactory = { createImapClient: async () => failingImap };

      await expect(
        handleSyncMailAccountTask(
          pool,
          { mailboxItemId: mailbox.id },
          adapters,
          {
            emailsDatabaseId: emailsId,
            filesDatabaseId: filesId,
            foldersDatabaseId: foldersId,
            mailboxesDatabaseId: mailboxesId,
          },
          noopStorage,
        ),
      ).rejects.toThrow("connection refused");

      const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
      expect(state?.lastError).toBe("connection refused");
      expect(state?.nextExpectedActivityAt).toBeTruthy();
      expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now());

      // The credential access attempt itself is still logged, even though the sync that used it failed later.
      const { rows } = await pool.query(`SELECT purpose FROM credential_access_log WHERE item_id = $1`, [mailbox.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].purpose).toBe("imap_sync");

      // The user-visible Mailbox.syncStatus (distinct from the internal mail_account_sync_state
      // bookkeeping above) also reflects the failure — this is what the mailbox UI would show.
      const item = await withTransaction(pool, (client) =>
        client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]),
      );
      expect(item.rows[0].properties.syncStatus).toBe("error");
    },
  );

  tenantIt(
    "cleans up an attachment already written to disk when a later step in the same pass aborts the transaction",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );

      const writtenKeys: string[] = [];
      const deletedKeys: string[] = [];
      const trackingStorage: BlobStorageWriter = {
        async writeStream(storageKey, source) {
          writtenKeys.push(storageKey);
          let byteSize = 0;
          const hash = createHash("sha256");
          for await (const chunk of source) {
            hash.update(chunk as Buffer);
            byteSize += (chunk as Buffer).length;
          }
          return { byteSize, contentHash: hash.digest("hex") };
        },
        async delete(storageKey) {
          deletedKeys.push(storageKey);
        },
        readStream() {
          throw new Error("readStream is not used by this test");
        },
      };

      const moduleIds = {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      };

      // A brand-new folder's very first reconcile pass never even looks at
      // fetchVanishedSince/fetchAllUids (imapReconcile.ts: nothing to diff against yet) — a
      // first, uneventful pass establishes real uidvalidity/uidnext state so the second pass
      // below actually reaches (and can fail inside) the vanished-UID check.
      const passOneImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };
      await handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        { createImapClient: async () => passOneImap },
        moduleIds,
        trackingStorage,
      );

      const failingAfterAttachmentImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
        fetchMessagesSince: async () => [
          {
            uid: 1,
            message: {
              messageId: "<orphan@x>",
              envelope: { from: { address: "a@x.com" } },
              subject: "Has attachment",
              attachments: [
                {
                  filename: "f.txt",
                  contentType: "text/plain",
                  contentId: null,
                  disposition: "attachment",
                  openStream: () => Readable.from(Buffer.from("orphan-bytes")),
                },
              ],
            },
          },
        ],
        // No QRESYNC (getCapabilities returns an empty set) and uidvalidity is already known
        // (set by passOneImap above) -> imapReconcile.ts's non-CONDSTORE fallback path, which
        // diffs via fetchAllUids.
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => {
          throw new Error("boom after the attachment was already written");
        },
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };

      const adapters: MailSyncAdapterFactory = { createImapClient: async () => failingAfterAttachmentImap };

      await expect(
        handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, adapters, moduleIds, trackingStorage),
      ).rejects.toThrow("boom after the attachment was already written");

      expect(writtenKeys).toHaveLength(1);
      expect(deletedKeys).toEqual(writtenKeys);
      // The transaction rolled back, so no Files item or Email item exists for it either.
      const { rows } = await pool.query(`SELECT count(*) FROM items WHERE database_id = $1`, [emailsId]);
      expect(rows[0].count).toBe("0");
    },
  );

  tenantIt("sets Mailbox.syncStatus to 'ok' after a completed sync pass", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );

    const emptyImap: ImapMailClient = {
      appendMessage: async () => {},
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {},
      close: async () => {},
    };
    const adapters: MailSyncAdapterFactory = { createImapClient: async () => emptyImap };

    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      adapters,
      {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      },
      noopStorage,
    );

    const item = await withTransaction(pool, (client) =>
      client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]),
    );
    expect(item.rows[0].properties.syncStatus).toBe("ok");
  });

  it.each(["list", "select", "fetch", "download"] as const)(
    "sanitizes a secret-bearing IMAP %s library failure at the client boundary",
    async (stage) => {
      const connection = new ImapFlow({
        host: "unused.example.test",
        port: 993,
        secure: true,
        auth: { user: "unused", pass: "unused" },
        logger: false,
      });
      const secret = "IMAP-PRIVATE-SENTINEL";
      const original = Object.assign(new Error(secret), { name: secret, code: secret });
      vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set(),
        uidValidity: 1n,
        uidNext: 2,
        exists: 1,
      });
      if (stage === "list") vi.spyOn(connection, "list").mockRejectedValue(original);
      if (stage === "select") vi.spyOn(connection, "mailboxOpen").mockRejectedValue(original);
      if (stage === "fetch")
        vi.spyOn(connection, "fetch").mockImplementation(async function* () {
          yield await Promise.reject(original);
        });
      if (stage === "download") {
        vi.spyOn(connection, "fetch").mockImplementation(async function* () {
          yield { seq: 1, uid: 1, bodyStructure: { type: "text/plain", part: "1" } };
        });
        vi.spyOn(connection, "download").mockRejectedValue(original);
      }
      const client = new ImapFlowMailClient(connection);
      const work =
        stage === "list"
          ? client.listFolders()
          : stage === "select"
            ? client.selectFolder("INBOX")
            : client.fetchMessagesSince("INBOX", 1);
      const result = await work.then(
        () => null,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      if (!(result instanceof Error)) throw new Error("Missing IMAP provider failure");
      expect(result.message).toBe("IMAP provider operation failed unexpectedly");
      expect(result).not.toHaveProperty("cause");
      expect(`${result.stack} ${JSON.stringify(result)}`).not.toContain(secret);
      vi.restoreAllMocks();
    },
  );

  it.each([
    ["undefined", undefined],
    ["object", { secret: "IMAP-PRIVATE-SENTINEL" }],
    ["aggregate", new AggregateError([new Error("IMAP-PRIVATE-SENTINEL")], "IMAP-PRIVATE-SENTINEL")],
  ])("sanitizes a nonstandard %s IMAP library rejection", async (_name, original) => {
    const connection = new ImapFlow({
      host: "unused.example.test",
      port: 993,
      secure: true,
      auth: { user: "unused", pass: "unused" },
      logger: false,
    });
    const list = vi.spyOn(connection, "list").mockRejectedValue(original);
    const outcome = await new ImapFlowMailClient(connection).listFolders().then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing IMAP provider failure");
    expect(outcome.message).toBe("IMAP provider operation failed unexpectedly");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("IMAP-PRIVATE-SENTINEL");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("retains a failed IMAP fetch and its independent iterator cleanup failure without exposing either", async () => {
    const connection = new ImapFlow({
      host: "unused.example.test",
      port: 993,
      secure: true,
      auth: { user: "unused", pass: "unused" },
      logger: false,
    });
    vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 1n,
      uidNext: 2,
      exists: 1,
    });
    const primary = new Error("IMAP-PRIMARY-PRIVATE-SENTINEL");
    const cleanup = new Error("IMAP-CLEANUP-PRIVATE-SENTINEL");
    const iterator = (async function* (): AsyncGenerator<FetchMessageObject, void, unknown> {})();
    let observedPrimary: unknown;
    let observedCleanup: unknown;
    const next = vi.spyOn(iterator, "next").mockImplementation(async () => {
      observedPrimary = primary;
      throw primary;
    });
    const close = vi.spyOn(iterator, "return").mockImplementation(async () => {
      observedCleanup = cleanup;
      throw cleanup;
    });
    vi.spyOn(connection, "fetch").mockReturnValue(iterator);
    const warn = vi.spyOn(logger, "warn");
    const outcome = await new ImapFlowMailClient(connection).fetchMessagesSince("INBOX", 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(observedPrimary).toBe(primary);
    expect(observedCleanup).toBe(cleanup);
    expect(next).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing IMAP provider failure");
    expect(outcome.message).toBe("IMAP provider operation failed unexpectedly");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(warn.mock.calls)}`).not.toContain("PRIVATE-SENTINEL");
    expect(
      warn.mock.calls.some(
        ([fields]) => typeof fields === "object" && fields !== null && Reflect.get(fields, "stage") === "stream_close",
      ),
    ).toBe(true);
  });

  tenantIt("preserves a non-network storage failure identity through an IMAP sync", async () => {
    const moduleIds = {
      emailsDatabaseId: await databaseIdFor("emails"),
      foldersDatabaseId: await databaseIdFor("folders"),
      filesDatabaseId: await databaseIdFor("files"),
      mailboxesDatabaseId: await databaseIdFor("mailboxes"),
    };
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: moduleIds.mailboxesDatabaseId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "fixture" }),
    );
    const connection = new ImapFlow({
      host: "unused.example.test",
      port: 993,
      secure: true,
      auth: { user: "unused", pass: "unused" },
      logger: false,
    });
    vi.spyOn(connection, "list").mockResolvedValue([
      {
        path: "INBOX",
        pathAsListed: "INBOX",
        name: "INBOX",
        delimiter: "/",
        parent: [],
        parentPath: "",
        flags: new Set(),
        listed: true,
        subscribed: true,
      },
    ]);
    vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 1n,
      uidNext: 2,
      exists: 1,
    });
    vi.spyOn(connection, "fetch").mockImplementation(async function* () {
      yield {
        seq: 1,
        uid: 1,
        envelope: { messageId: "<privacy-storage@example.test>" },
        bodyStructure: { type: "application/pdf", part: "1", disposition: "attachment" },
      };
    });
    vi.spyOn(connection, "download").mockResolvedValue({
      meta: { expectedSize: 3, contentType: "application/pdf" },
      content: Readable.from([Buffer.from("pdf")]),
    });
    vi.spyOn(connection, "logout").mockResolvedValue(undefined);
    vi.spyOn(connection, "close").mockImplementation(() => {});
    const original = new Error("storage failure sentinel");
    const storage: BlobStorageWriter = {
      ...noopStorage,
      writeStream: async () => {
        throw original;
      },
    };
    const outcome = await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      { createImapClient: async () => new ImapFlowMailClient(connection) },
      moduleIds,
      storage,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBe(original);
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state?.lastError).toBe("storage failure sentinel");
  });

  tenantIt("stores and returns a safe IMAP provider failure after the actual job closes its client", async () => {
    const moduleIds = {
      emailsDatabaseId: await databaseIdFor("emails"),
      foldersDatabaseId: await databaseIdFor("folders"),
      filesDatabaseId: await databaseIdFor("files"),
      mailboxesDatabaseId: await databaseIdFor("mailboxes"),
    };
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: moduleIds.mailboxesDatabaseId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "app_password",
        plaintext: "IMAP-PRIVATE-SENTINEL",
      }),
    );
    const connection = new ImapFlow({
      host: "unused.example.test",
      port: 993,
      secure: true,
      auth: { user: "unused", pass: "unused" },
      logger: false,
    });
    const providerFailure = Object.assign(new Error("IMAP-PRIVATE-SENTINEL"), {
      name: "IMAP-PRIVATE-SENTINEL",
      code: "IMAP-PRIVATE-SENTINEL",
    });
    const list = vi.spyOn(connection, "list").mockRejectedValue(providerFailure);
    vi.spyOn(connection, "logout").mockResolvedValue(undefined);
    const close = vi.spyOn(connection, "close").mockImplementation(() => {});
    const adapter = new ImapFlowMailClient(connection);
    try {
      const result = await handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        { createImapClient: async () => adapter },
        moduleIds,
        noopStorage,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      if (!(result instanceof Error)) throw new Error("Missing sync failure");
      expect(result.message).toBe("IMAP provider operation failed unexpectedly");
      expect(result).not.toHaveProperty("cause");
      expect(`${result.stack} ${JSON.stringify(result)}`).not.toContain("IMAP-PRIVATE-SENTINEL");
      expect(list).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
      expect(state?.lastError).toBe("IMAP provider operation failed unexpectedly");
    } finally {
      vi.restoreAllMocks();
    }
  });

  tenantIt(
    "records successful Gmail and Graph activity after a failure without resetting initial completion",
    async () => {
      const mailboxesId = await databaseIdFor("mailboxes");
      for (const mode of ["gmail", "graph"] as const) {
        const mailbox = await withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId: mailboxesId, properties: { name: mode } }),
        );
        await withTransaction(pool, (client) =>
          ensureMailAccountSyncState(client, {
            itemId: mailbox.id,
            syncMode: mode === "gmail" ? "gmail_api" : "graph_api",
          }),
        );
        const success = () =>
          withTransaction(pool, (client) =>
            mode === "gmail"
              ? recordGmailActivity(client, { itemId: mailbox.id, historyId: "1", nextExpectedActivityAt: new Date() })
              : recordGraphActivity(client, {
                  itemId: mailbox.id,
                  deltaLink: "delta",
                  nextExpectedActivityAt: new Date(),
                }),
          );
        const read = () => withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
        await success();
        const first = await read();
        expect(first?.initialSyncCompletedAt).toBe(first?.lastSuccessfulSyncAt);
        expect(first?.initialSyncCompletedAt).toBeTruthy();
        await withTransaction(pool, (client) => recordSyncError(client, mailbox.id, "failure", "other"));
        const failed = await read();
        expect(failed?.failingSince).toBeTruthy();
        expect(failed?.lastFailureKind).toBe("other");
        expect(failed?.lastSuccessfulSyncAt).toBe(first?.lastSuccessfulSyncAt);
        await success();
        const recovered = await read();
        expect(recovered?.initialSyncCompletedAt).toBe(first?.initialSyncCompletedAt);
        expect(recovered?.failingSince).toBeNull();
        expect(recovered?.lastFailureKind).toBeNull();
        expect(recovered?.lastError).toBeNull();
        expect(recovered?.lastSuccessfulSyncAt).toBeTruthy();
      }
    },
  );

  tenantIt(
    "tracks the last successful sync, the failure streak and its kind, and the initial sync across passes (issue #1497)",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");
      const moduleIds = {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      };

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );
      const readState = () => withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
      const readUpdatedAt = async () => {
        const { rows } = await pool.query(`SELECT updated_at FROM items WHERE id = $1`, [mailbox.id]);
        return rows[0].updated_at as Date;
      };
      const run = (adapters: MailSyncAdapterFactory) =>
        handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, adapters, moduleIds, noopStorage);

      const emptyImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };
      const healthy: MailSyncAdapterFactory = { createImapClient: async () => emptyImap };
      const failing = (error: Error): MailSyncAdapterFactory => ({
        createImapClient: async () => {
          throw error;
        },
      });

      await run(healthy);
      const first = await readState();
      expect(first?.lastSuccessfulSyncAt).toBeTruthy();
      expect(first?.initialSyncCompletedAt).toBe(first?.lastSuccessfulSyncAt);
      expect(first?.failingSince).toBeNull();
      expect(first?.lastFailureKind).toBeNull();

      // A second identical pass moves the success timestamp, keeps the initial sync, and leaves
      // the already-'ok' Mailboxes item untouched.
      const updatedAfterFirst = await readUpdatedAt();
      await run(healthy);
      const second = await readState();
      expect(new Date(second!.lastSuccessfulSyncAt!).getTime()).toBeGreaterThan(
        new Date(first!.lastSuccessfulSyncAt!).getTime(),
      );
      expect(second?.initialSyncCompletedAt).toBe(first?.initialSyncCompletedAt);
      expect(await readUpdatedAt()).toEqual(updatedAfterFirst);

      await expect(run(failing(new Error("boom")))).rejects.toThrow("boom");
      const afterFirstFailure = await readState();
      expect(afterFirstFailure?.lastSuccessfulSyncAt).toBe(second?.lastSuccessfulSyncAt);
      expect(afterFirstFailure?.failingSince).toBeTruthy();
      expect(afterFirstFailure?.lastFailureKind).toBe("other");

      await expect(run(failing(new MailReauthorizationRequiredError("revoked")))).rejects.toThrow();
      const afterReauth = await readState();
      expect(afterReauth?.failingSince).toBe(afterFirstFailure?.failingSince);
      expect(afterReauth?.lastFailureKind).toBe("reauthorization");
      expect(afterReauth?.lastSuccessfulSyncAt).toBe(second?.lastSuccessfulSyncAt);

      await run(failing(new MailConnectionLimitError("Too many simultaneous connections.")));
      const afterLimit = await readState();
      expect(afterLimit?.failingSince).toBe(afterFirstFailure?.failingSince);
      expect(afterLimit?.lastFailureKind).toBe("connectionLimit");

      await run(healthy);
      const recovered = await readState();
      expect(recovered?.failingSince).toBeNull();
      expect(recovered?.lastFailureKind).toBeNull();
      expect(recovered?.initialSyncCompletedAt).toBe(first?.initialSyncCompletedAt);
      expect(new Date(recovered!.lastSuccessfulSyncAt!).getTime()).toBeGreaterThan(
        new Date(second!.lastSuccessfulSyncAt!).getTime(),
      );
    },
  );

  it("sets Mailbox.syncStatus to 'needsReauthorization' when the adapter reports a revoked credential, without writing a mail_sync_error notification (issue #149)", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );

    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailReauthorizationRequiredError(
          "OAuth exchange failed: refresh_token=provider-auth-exchange-secret",
        );
      },
    };

    const errorSpy = vi.spyOn(logger, "error");
    try {
      await expect(
        handleSyncMailAccountTask(
          pool,
          { mailboxItemId: mailbox.id },
          adapters,
          {
            emailsDatabaseId: emailsId,
            filesDatabaseId: filesId,
            foldersDatabaseId: foldersId,
            mailboxesDatabaseId: mailboxesId,
          },
          noopStorage,
        ),
      ).rejects.toThrow("provider-auth-exchange-secret");

      const logArguments = JSON.stringify(errorSpy.mock.calls);
      expect(logArguments).not.toContain("provider-auth-exchange-secret");
      expect(logArguments).toContain("reauthorizationRequired");
    } finally {
      errorSpy.mockRestore();
    }

    const item = await withTransaction(pool, (client) =>
      client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]),
    );
    expect(item.rows[0].properties.syncStatus).toBe("needsReauthorization");

    const { rows: notifications } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [mailbox.id]);
    expect(notifications).toHaveLength(0);
  });

  it("writes a mail_sync_error notification on failure, deduped by job id but not across distinct failing jobs (issue #149)", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, {
      email: "owner@example.test",
      passwordHash,
      locale: "en",
      tenantId: getTenantZeroId(),
    });

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    // Deliberately no storeCredential call, same as the "no stored credential" test below —
    // reaches `recordSyncError` without needing a real adapter failure.

    const moduleIds = {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      mailboxesDatabaseId: mailboxesId,
    };

    await expect(
      handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, {}, moduleIds, noopStorage, {
        job: { id: "job-1" },
      }),
    ).rejects.toThrow("has no stored credential");

    const { rows: afterFirst } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [mailbox.id],
    );
    expect(afterFirst).toMatchObject([
      {
        user_id: user.id,
        kind: "mail_sync_error",
        title: "Mail sync failed",
        link_href: `?page=mailbox&id=${mailbox.id}`,
        source_table: "mail_account_sync_state",
        transition_instance: "job-1",
      },
    ]);

    // Redelivery of the same job must not duplicate the notification.
    await expect(
      handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, {}, moduleIds, noopStorage, {
        job: { id: "job-1" },
      }),
    ).rejects.toThrow("has no stored credential");
    const { rows: afterReplay } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [mailbox.id]);
    expect(afterReplay).toHaveLength(1);

    // A later, independent failure (a new job) is a different transition and does insert.
    await expect(
      handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, {}, moduleIds, noopStorage, {
        job: { id: "job-2" },
      }),
    ).rejects.toThrow("has no stored credential");
    const { rows: afterNewTransition } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [
      mailbox.id,
    ]);
    expect(afterNewTransition).toHaveLength(2);
  });

  it("skips the mail_sync_error notification (but still records the sync error) before any user account exists (issue #149)", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );

    const moduleIds = {
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      foldersDatabaseId: foldersId,
      mailboxesDatabaseId: mailboxesId,
    };

    await expect(
      handleSyncMailAccountTask(pool, { mailboxItemId: mailbox.id }, {}, moduleIds, noopStorage, {
        job: { id: "job-1" },
      }),
    ).rejects.toThrow("has no stored credential");

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [mailbox.id]);
    expect(rows).toHaveLength(0);
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state!.lastError).toContain("has no stored credential");
  });

  it("sets Mailbox.syncStatus to 'error' when the credential itself can't be decrypted (a failure before any adapter/transaction runs)", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    // Deliberately no storeCredential call: handleSyncMailAccountTask's own "no stored
    // credential" throw fires before the reconcile transaction ever opens, exercising the same
    // code path a real decrypt failure would.

    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        {},
        {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          foldersDatabaseId: foldersId,
          mailboxesDatabaseId: mailboxesId,
        },
        noopStorage,
      ),
    ).rejects.toThrow("has no stored credential");

    const item = await withTransaction(pool, (client) =>
      client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]),
    );
    expect(item.rows[0].properties.syncStatus).toBe("error");
  });

  it("resolves as a no-op, without ever invoking the adapter, when the Mailbox item has been soft-deleted", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );

    await chokePoint.softDeleteItem(mailboxesId, mailbox.id);

    const createImapClient = vi.fn(async (): Promise<ImapMailClient> => ({
      appendMessage: async () => {},
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {},
      close: async () => {},
    }));
    const adapters: MailSyncAdapterFactory = { createImapClient };

    // On current code, this rejects with a NotFoundError from the closing syncStatus write and
    // the adapter has already run — this test discriminates exactly that.
    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        adapters,
        {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          foldersDatabaseId: foldersId,
          mailboxesDatabaseId: mailboxesId,
        },
        noopStorage,
      ),
    ).resolves.toBeUndefined();

    expect(createImapClient).not.toHaveBeenCalled();
  });

  it("resolves as a no-op, without ever invoking the adapter, when the Mailbox item is missing entirely", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const createImapClient = vi.fn(async (): Promise<ImapMailClient> => ({
      appendMessage: async () => {},
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {},
      close: async () => {},
    }));
    const adapters: MailSyncAdapterFactory = { createImapClient };

    await expect(
      handleSyncMailAccountTask(
        pool,
        { mailboxItemId: "00000000-0000-0000-0000-000000000000" },
        adapters,
        {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          foldersDatabaseId: foldersId,
          mailboxesDatabaseId: mailboxesId,
        },
        noopStorage,
      ),
    ).resolves.toBeUndefined();

    expect(createImapClient).not.toHaveBeenCalled();
  });
});

describe("mailbox Semp problem raised by the sync job (issue #1506)", () => {
  interface MailProblemRow {
    category: string;
    kind: string;
    severity: string;
    source_table: string;
    source_id: string;
    occurrence_count: number;
    first_seen_at: Date;
    resolved_at: Date | null;
    resolution_kind: string | null;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function createOwner(): Promise<void> {
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  }

  async function seededModuleIds(): Promise<MailModuleIds> {
    return {
      emailsDatabaseId: await databaseIdFor("emails"),
      filesDatabaseId: await databaseIdFor("files"),
      foldersDatabaseId: await databaseIdFor("folders"),
      mailboxesDatabaseId: await databaseIdFor("mailboxes"),
    };
  }

  /** A Mailbox with its sync state and, when `withCredential`, a stored app password. */
  async function createMailbox(withCredential: boolean): Promise<string> {
    const { mailboxesDatabaseId } = await seededModuleIds();
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesDatabaseId, properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    if (withCredential) {
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );
    }
    return mailbox.id;
  }

  async function syncPass(
    mailboxItemId: string,
    adapters: MailSyncAdapterFactory,
    jobId: string = randomUUID(),
  ): Promise<void> {
    await handleSyncMailAccountTask(pool, { mailboxItemId }, adapters, await seededModuleIds(), noopStorage, {
      job: { id: jobId },
    });
  }

  async function mailProblems(mailboxItemId: string): Promise<MailProblemRow[]> {
    const { rows } = await pool.query<MailProblemRow>(
      `SELECT category, kind, severity, source_table, source_id, occurrence_count, first_seen_at, resolved_at, resolution_kind
         FROM semp_problems WHERE dedupe_key = $1 ORDER BY first_seen_at`,
      [mailProblemKey(mailboxItemId)],
    );
    return rows;
  }

  const completingImap: ImapMailClient = {
    appendMessage: async () => {},
    getCapabilities: async () => new Set(),
    listFolders: async () => [],
    selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
    fetchMessagesSince: async () => [],
    fetchVanishedSince: async () => [],
    fetchAllUids: async () => [],
    fetchFlagsChangedSince: async () => [],
    setMessageFlag: async () => {},
    close: async () => {},
  };

  const refusingImap: MailSyncAdapterFactory = {
    createImapClient: async () => {
      throw new Error("connection refused");
    },
  };

  it("raises one warning problem per mailbox, merging every failing pass and counting a retry of the same job once", async () => {
    await createOwner();
    const mailboxId = await createMailbox(false);

    // No stored credential: each pass fails before any provider call, with the default severity.
    await expect(syncPass(mailboxId, {}, "job-1")).rejects.toThrow("has no stored credential");
    await expect(syncPass(mailboxId, {}, "job-2")).rejects.toThrow("has no stored credential");
    await expect(syncPass(mailboxId, {}, "job-3")).rejects.toThrow("has no stored credential");
    // A redelivery of job-3 is the same report again.
    await expect(syncPass(mailboxId, {}, "job-3")).rejects.toThrow("has no stored credential");

    const problems = await mailProblems(mailboxId);
    expect(problems).toMatchObject([
      {
        category: "mail",
        kind: "mailSyncError",
        severity: "warning",
        source_table: "mail_account_sync_state",
        source_id: mailboxId,
        occurrence_count: 3,
        resolved_at: null,
      },
    ]);
    // The problem starts when the failure streak did, not when the last report arrived.
    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailboxId));
    expect(problems[0]!.first_seen_at.toISOString()).toBe(state!.failingSince);
  });

  it("raises the problem as critical when the token is revoked, and writes no mail_sync_error notification for it", async () => {
    await createOwner();
    const mailboxId = await createMailbox(true);

    await expect(
      syncPass(mailboxId, {
        createImapClient: async () => {
          throw new MailReauthorizationRequiredError("token revoked");
        },
      }),
    ).rejects.toThrow("token revoked");

    expect(await mailProblems(mailboxId)).toMatchObject([
      { severity: "critical", occurrence_count: 1, resolved_at: null },
    ]);
    const { rows: notifications } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [mailboxId]);
    expect(notifications).toHaveLength(0);
  });

  it("does not count an older retried job after a different job reported the same failure", async () => {
    await createOwner();
    const mailboxId = await createMailbox(false);
    const moduleIds = await seededModuleIds();
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let primary: { value: unknown } | undefined;
    try {
      await inTenantZero(async () => {
        for (const jobId of ["job-a", "job-b", "job-a"]) {
          await expect(
            handleSyncMailAccountTask(runtime, { mailboxItemId: mailboxId }, {}, moduleIds, noopStorage, {
              job: { id: jobId },
            }),
          ).rejects.toThrow("has no stored credential");
        }
        const result = await withTransaction(runtime, (client) =>
          client.query<{ occurrence_count: number; resolved_at: Date | null }>(
            "SELECT occurrence_count, resolved_at FROM semp_problems WHERE dedupe_key = $1",
            [mailProblemKey(mailboxId)],
          ),
        );
        expect(result.rows).toEqual([{ occurrence_count: 2, resolved_at: null }]);
      });
    } catch (error) {
      primary = { value: error };
    }
    try {
      await runtime.end();
    } catch (error) {
      throw new AggregateError(primary ? [primary.value, error] : [error], "Runtime pool cleanup failed", {
        cause: error,
      });
    }
    if (primary) throw primary.value;
  });

  it("raises no problem before any user account exists", async () => {
    const mailboxId = await createMailbox(false);

    await expect(syncPass(mailboxId, {}, "job-1")).rejects.toThrow("has no stored credential");

    expect(await mailProblems(mailboxId)).toEqual([]);
  });

  it("raises no problem when the sync state row disappears during the pass", async () => {
    await createOwner();
    const mailboxId = await createMailbox(true);
    const vanishingState: MailSyncAdapterFactory = {
      createImapClient: async () => {
        // A removal racing the pass: the row the prologue read is gone when the failure is recorded.
        await pool.query("DELETE FROM mail_account_sync_state WHERE item_id = $1", [mailboxId]);
        throw new Error("boom");
      },
    };

    await expect(syncPass(mailboxId, vanishingState)).rejects.toThrow("boom");

    expect(await mailProblems(mailboxId)).toEqual([]);
  });

  tenantIt("resolves the problem in the pass that completes, and a later failure opens a new one", async () => {
    await createOwner();
    const mailboxId = await createMailbox(true);

    // A completed pass with no problem to resolve changes nothing.
    await syncPass(mailboxId, { createImapClient: async () => completingImap });
    expect(await mailProblems(mailboxId)).toEqual([]);

    await expect(syncPass(mailboxId, refusingImap, "job-1")).rejects.toThrow("connection refused");
    expect(await mailProblems(mailboxId)).toMatchObject([{ resolved_at: null, occurrence_count: 1 }]);

    await syncPass(mailboxId, { createImapClient: async () => completingImap }, "job-2");
    expect(await mailProblems(mailboxId)).toMatchObject([
      { resolved_at: expect.any(Date), resolution_kind: "recovered" },
    ]);

    await expect(syncPass(mailboxId, refusingImap, "job-3")).rejects.toThrow("connection refused");
    expect(await mailProblems(mailboxId)).toMatchObject([
      { resolved_at: expect.any(Date) },
      { resolved_at: null, occurrence_count: 1 },
    ]);
  });

  it("raises no problem for a connection-limit rejection on its own", async () => {
    await createOwner();
    const mailboxId = await createMailbox(true);

    await syncPass(mailboxId, {
      createImapClient: async () => {
        throw new MailConnectionLimitError("Too many simultaneous connections.");
      },
    });

    expect(await mailProblems(mailboxId)).toEqual([]);
  });
});

describe("mail_sync_error recipient in a tenant (issue #1018)", () => {
  let runtimePool: Pool;

  beforeEach(async () => {
    pool ??= getTestPool();
    runtimePool ??= await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
    await runInTenant(getTenantZeroId(), () => resetDatabase(pool));
  });

  afterAll(async () => {
    await runtimePool?.end();
  });

  it("notifies the user of the tenant the sync fails in, never the earlier-created account", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
    const userA = await runInTenant(getTenantZeroId(), () =>
      createUser(pool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }),
    );
    const userB = await runInTenant(tenantB, () =>
      createUser(pool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
    );

    const { mailboxItemId, moduleIds } = await runInTenant(tenantB, async () => {
      await seedSystem(runtimePool);
      const idFor = async (moduleId: string): Promise<string> => {
        const { rows } = await runtimePool.query<{ id: string }>(
          "SELECT id FROM databases WHERE owner_module_id = $1",
          [moduleId],
        );
        if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
        return rows[0].id;
      };
      const ids = {
        emailsDatabaseId: await idFor("emails"),
        filesDatabaseId: await idFor("files"),
        foldersDatabaseId: await idFor("folders"),
        mailboxesDatabaseId: await idFor("mailboxes"),
      };
      const mailbox = await withTransaction(runtimePool, (client) =>
        createItemWithClient(client, { databaseId: ids.mailboxesDatabaseId, properties: { name: "M" } }),
      );
      await withTransaction(runtimePool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      return { mailboxItemId: mailbox.id, moduleIds: ids };
    });

    // No stored credential: reaches `recordSyncError` without a real adapter failure.
    await expect(
      runInTenant(tenantB, () =>
        handleSyncMailAccountTask(runtimePool, { mailboxItemId }, {}, moduleIds, noopStorage, {
          job: { id: "job-b" },
        }),
      ),
    ).rejects.toThrow("has no stored credential");

    const { rows } = await pool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [mailboxItemId],
    );
    expect(rows).toEqual([{ user_id: userB.id, kind: "mail_sync_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});

describe("IMAP raw header parsing (issue #93)", () => {
  it("preserves every occurrence of a repeated header, in the message's own top-to-bottom order", () => {
    const buffer = Buffer.from(
      [
        "Delivered-To: newest@example.com",
        "Delivered-To: oldest@example.com",
        "X-Original-To: xo@example.com",
        "References: <a@x> <b@x>",
      ].join("\r\n") + "\r\n",
    );
    const headers = parseHeaderBlock(buffer);
    expect(headerValues(headers, "delivered-to")).toEqual(["newest@example.com", "oldest@example.com"]);
    expect(headerValues(headers, "x-original-to")).toEqual(["xo@example.com"]);
    // Header-name lookup is case-insensitive, matching RFC 5322.
    expect(headerValues(headers, "Delivered-To")).toEqual(["newest@example.com", "oldest@example.com"]);
  });

  it("unfolds a continuation line (leading whitespace) onto the previous header's value instead of starting a new one", () => {
    const buffer = Buffer.from(
      ["Envelope-To: someone", "  @example.com", "Delivered-To: me@example.com"].join("\r\n") + "\r\n",
    );
    const headers = parseHeaderBlock(buffer);
    expect(headerValues(headers, "envelope-to")).toEqual(["someone @example.com"]);
    expect(headerValues(headers, "delivered-to")).toEqual(["me@example.com"]);
  });

  it("returns nothing for an absent header or an undefined buffer", () => {
    expect(parseHeaderBlock(undefined)).toEqual([]);
    const headers = parseHeaderBlock(Buffer.from("Delivered-To: me@example.com\r\n"));
    expect(headerValues(headers, "x-original-to")).toEqual([]);
  });
});

describe("deliveredToAddress precedence (issue #93)", () => {
  it("prefers the highest (first) Delivered-To occurrence over everything else", () => {
    const result = resolveDeliveredToAddress({
      candidates: {
        deliveredToHeaders: ["newest@example.com", "oldest@example.com"],
        xOriginalTo: "xo@example.com",
        envelopeTo: "et@example.com",
      },
      structuredTo: [{ address: "to@example.com" }],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("newest@example.com");
  });

  it("extracts the bare address out of a 'Name <addr>' Delivered-To value", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: ["Alice Work <Alice@Example.com>"] },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: [],
    });
    expect(result).toBe("alice@example.com");
  });

  it("falls back to X-Original-To when there is no Delivered-To", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [], xOriginalTo: "xo@example.com", envelopeTo: "et@example.com" },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("xo@example.com");
  });

  it("falls back to Envelope-To when there is no Delivered-To or X-Original-To", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [], xOriginalTo: null, envelopeTo: "et@example.com" },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: ["alias@example.com"],
    });
    expect(result).toBe("et@example.com");
  });

  it("falls back to the first registered mailbox alias matching structured To/Cc", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [] },
      structuredTo: [{ address: "someone-else@example.com" }],
      structuredCc: [{ address: "Alias2@Example.com" }],
      mailboxAliases: ["alias1@example.com", "alias2@example.com"],
    });
    expect(result).toBe("alias2@example.com");
  });

  it("falls back to the mailbox's primary (first) address when no alias matches structured To/Cc", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [] },
      structuredTo: [{ address: "nobody-registered@example.com" }],
      structuredCc: [],
      mailboxAliases: ["primary@example.com", "secondary@example.com"],
    });
    expect(result).toBe("primary@example.com");
  });

  it("returns undefined when there are no header candidates and no registered aliases", () => {
    const result = resolveDeliveredToAddress({
      candidates: { deliveredToHeaders: [] },
      structuredTo: [],
      structuredCc: [],
      mailboxAliases: [],
    });
    expect(result).toBeUndefined();
  });
});

describe("deliveredToAddress persisted at ingest (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt(
    "persists deliveredToAddress computed from multiple Delivered-To occurrences, not recomputed later",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );

      const result = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<dta1@example.com>",
          envelope: { from: { address: "sender@example.com" }, to: [{ address: "me@example.com" }] },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
          deliveredToHeaders: ["me+relay2@example.com", "me+relay1@example.com"],
          mailboxAliases: ["me@example.com"],
        }),
      );

      const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, result.itemId));
      expect(meta?.deliveredToAddress).toBe("me+relay2@example.com");
    },
  );

  tenantIt("falls back through to the mailbox's registered alias when no delivery headers are present", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
    const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId: TEST_MAILBOX_ITEM_ID,
        messageId: "<dta2@example.com>",
        envelope: { from: { address: "sender@example.com" }, to: [{ address: "me@example.com" }] },
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        mailboxAliases: ["me@example.com"],
      }),
    );

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, result.itemId));
    expect(meta?.deliveredToAddress).toBe("me@example.com");
  });
});

describe("DSN/bounce detection (issue #93)", () => {
  it("isDeliveryStatusReport requires both multipart/report and report-type=delivery-status", () => {
    expect(isDeliveryStatusReport("multipart/report", { "report-type": "delivery-status" })).toBe(true);
    expect(isDeliveryStatusReport("multipart/report", { "Report-Type": "Delivery-Status" })).toBe(true);
    expect(isDeliveryStatusReport("multipart/report", { "report-type": "disposition-notification" })).toBe(false);
    expect(isDeliveryStatusReport("multipart/mixed", { "report-type": "delivery-status" })).toBe(false);
    expect(isDeliveryStatusReport(undefined, undefined)).toBe(false);
  });

  it("parseContentTypeHeader splits type and parameters out of a raw header value", () => {
    expect(parseContentTypeHeader('multipart/report; report-type="delivery-status"; boundary=abc')).toEqual({
      type: "multipart/report",
      params: { "report-type": "delivery-status", boundary: "abc" },
    });
    expect(parseContentTypeHeader(undefined)).toBeNull();
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt(
    "a DSN threads onto its outgoing message's thread and is tagged messageKind:'dsn', distinct from a human reply",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );

      const outgoing = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<outgoing@example.com>",
          subject: "Original",
          envelope: { from: { address: "me@example.com" }, to: [{ address: "someone@example.com" }] },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );
      const outgoingMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, outgoing.itemId));

      const dsn = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<dsn1@mailer-daemon.example.com>",
          subject: "Undelivered Mail Returned to Sender",
          references: ["<outgoing@example.com>"],
          envelope: { from: { address: "mailer-daemon@example.com" }, to: [{ address: "me@example.com" }] },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
          isDsn: true,
        }),
      );

      const reply = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<reply1@example.com>",
          subject: "Re: Original",
          inReplyTo: "<outgoing@example.com>",
          references: ["<outgoing@example.com>"],
          envelope: { from: { address: "someone@example.com" }, to: [{ address: "me@example.com" }] },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const dsnMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, dsn.itemId));
      const replyMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, reply.itemId));

      expect(dsnMeta?.messageKind).toBe("dsn");
      expect(dsnMeta?.dsnOriginalMessageId).toBe("<outgoing@example.com>");
      expect(dsnMeta?.threadId).toBe(outgoingMeta?.threadId);

      // The ordinary reply is threaded the same way but must not itself be classified as a DSN.
      expect(replyMeta?.messageKind).toBe("message");
      expect(replyMeta?.dsnOriginalMessageId).toBeNull();
      expect(replyMeta?.threadId).toBe(outgoingMeta?.threadId);
    },
  );
});

describe("person <-> email linkage determinism (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("reindexing the same person twice with differently-cased/whitespaced addresses converges on the same normalized index rows", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alice" } });

    await withTransaction(pool, (client) =>
      reindexPersonEmails(client, alice.id, ["  Alice@Example.com ", "ALICE@EXAMPLE.COM"]),
    );
    // Both variants normalize to the same address — this must not attempt to claim it twice
    // (email PRIMARY KEY would reject a literal duplicate insert) and must resolve identically
    // regardless of how a later lookup happens to be cased.
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "alice@example.com"))).toBe(alice.id);
    expect(await withTransaction(pool, (client) => lookupPersonIdByEmail(client, "Alice@Example.com"))).toBe(alice.id);

    const { rows } = await pool.query(`SELECT email FROM person_email_index WHERE item_id = $1`, [alice.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("alice@example.com");
  });
});

describe("legacy Emails migration (issue #93)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  /** Creates an Emails item the way pre-issue-93 legacy data would exist: through the raw item-creation path, bypassing `ingestEmailMessage` entirely, so it has no `mail_message_meta` row at all — the exact "legacy" condition the migration job looks for. */
  async function createLegacyEmailItem(emailsId: string, properties: Record<string, unknown>): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: emailsId, properties },
        { allowedSystemKeys: ["name", "sender", "recipients", "body", "date"] },
      ),
    );
    return item.id;
  }

  tenantIt(
    "reconstructs envelope/threadId/messageId from legacy sender/recipients text and marks migrationStatus 'partial'",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const legacyItemId = await createLegacyEmailItem(emailsId, {
        name: "Old subject",
        sender: "Alice <alice@example.com>",
        recipients: "Bob <bob@example.com>, carol@example.com",
      });

      await runMailLegacyEmailMigrationJob(pool, emailsId);

      const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
      expect(meta).not.toBeNull();
      expect(meta?.migrationStatus).toBe("partial");
      expect(meta?.envelope.from).toEqual({ name: "Alice", address: "alice@example.com" });
      expect(meta?.envelope.to?.map((a) => a.address)).toEqual(["bob@example.com", "carol@example.com"]);
      expect(meta?.messageId).toBeTruthy();
      expect(meta?.threadId).toBeTruthy();

      // The row itself is preserved untouched, not replaced/deleted by the migration.
      const item = await chokePoint.getItem(emailsId, legacyItemId);
      expect(item?.properties.name).toBe("Old subject");
    },
  );

  tenantIt(
    "parses raw MIME when the injected fetcher has it, marking migrationStatus 'done' and recovering real threading headers",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const legacyItemId = await createLegacyEmailItem(emailsId, {
        name: "Old subject",
        sender: "alice@example.com",
        recipients: "bob@example.com",
      });

      const rawMime = Buffer.from(
        [
          "From: Alice <alice@example.com>",
          "To: Bob <bob@example.com>",
          "Subject: Hi",
          "Message-ID: <raw1@example.com>",
          "References: <parent@example.com>",
          "In-Reply-To: <parent@example.com>",
          "Content-Type: text/plain",
          "",
          "Hello",
          "",
        ].join("\r\n"),
      );
      const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

      await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

      const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
      expect(meta?.migrationStatus).toBe("done");
      expect(meta?.messageId).toBe("<raw1@example.com>");
      expect(meta?.inReplyTo).toBe("<parent@example.com>");
      expect(meta?.references).toEqual(["<parent@example.com>"]);
      expect(meta?.envelope.from?.address).toBe("alice@example.com");
      expect(meta?.envelope.to?.[0]?.address).toBe("bob@example.com");
    },
  );

  tenantIt(
    "classifies a DSN recovered from raw MIME as messageKind 'dsn', linked to its original message, not an ordinary reply",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const legacyItemId = await createLegacyEmailItem(emailsId, {
        name: "Undelivered Mail Returned to Sender",
        sender: "mailer-daemon@example.com",
        recipients: "",
      });

      const rawMime = Buffer.from(
        [
          "From: Mail Delivery Subsystem <mailer-daemon@example.com>",
          "To: me@example.com",
          "Subject: Undelivered Mail Returned to Sender",
          "Message-ID: <dsn-raw1@example.com>",
          "References: <outgoing1@example.com>",
          'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/plain",
          "",
          "delivery failed",
          "--b1--",
          "",
        ].join("\r\n"),
      );
      const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

      await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

      const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
      expect(meta?.migrationStatus).toBe("done");
      expect(meta?.messageKind).toBe("dsn");
      expect(meta?.dsnOriginalMessageId).toBe("<outgoing1@example.com>");
    },
  );

  tenantIt(
    "falls back to its own synthetic id (migrationStatus 'partial') instead of stealing another item's mail_message_meta row when the recovered Message-ID collides",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const folderProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "folder")!;
      const attachmentsProperty = (await chokePoint.listProperties(emailsId)).find((p) => p.key === "attachments")!;
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );

      // A live-synced item already owns this exact Message-ID — plausible for pre-#26 legacy
      // rows, which had no dedup at all.
      const liveItem = await withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          folderItemId: folder.id,
          mailboxItemId: TEST_MAILBOX_ITEM_ID,
          messageId: "<dup1@example.com>",
          envelope: { from: { address: "alice@example.com" } },
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
        }),
      );

      const legacyItemId = await createLegacyEmailItem(emailsId, {
        name: "Old subject",
        sender: "alice@example.com",
        recipients: "bob@example.com",
      });
      const rawMime = Buffer.from(
        [
          "From: Alice <alice@example.com>",
          "To: Bob <bob@example.com>",
          "Subject: Hi",
          "Message-ID: <dup1@example.com>",
          "",
          "Hello",
          "",
        ].join("\r\n"),
      );
      const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => (itemId === legacyItemId ? rawMime : null);

      await runMailLegacyEmailMigrationJob(pool, emailsId, fetchRawMime);

      const legacyMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
      const liveMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, liveItem.itemId));

      // The legacy item gets its own row (never null — no infinite-reprocessing hazard) under a
      // synthetic id, and the live item's own row/identity is completely untouched.
      expect(legacyMeta).not.toBeNull();
      expect(legacyMeta?.itemId).toBe(legacyItemId);
      expect(legacyMeta?.messageId).not.toBe("<dup1@example.com>");
      expect(legacyMeta?.migrationStatus).toBe("partial");
      expect(liveMeta?.itemId).toBe(liveItem.itemId);
      expect(liveMeta?.messageId).toBe("<dup1@example.com>");

      // Idempotency check now succeeds for the legacy item too — a retry does not loop forever.
      const { rows } = await pool.query(`SELECT count(*) FROM mail_message_meta WHERE item_id = $1`, [legacyItemId]);
      expect(rows[0].count).toBe("1");
    },
  );

  tenantIt(
    "is resumable: re-running the job after a partial completion never reprocesses an already-migrated row",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const legacyItemId = await createLegacyEmailItem(emailsId, {
        name: "Old subject",
        sender: "alice@example.com",
        recipients: "bob@example.com",
      });

      await runMailLegacyEmailMigrationJob(pool, emailsId);
      const firstPassMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));

      // Simulates a retry after a crash: the job runs again from scratch (no persisted cursor,
      // same as propertyTypeMigration.ts) — the already-migrated row must be left exactly alone.
      await runMailLegacyEmailMigrationJob(pool, emailsId);
      const secondPassMeta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));

      expect(secondPassMeta).toEqual(firstPassMeta);
      const { rows } = await pool.query(`SELECT count(*) FROM mail_message_meta WHERE item_id = $1`, [legacyItemId]);
      expect(rows[0].count).toBe("1");
    },
  );

  it("is queueable via enqueueMailLegacyEmailMigration/runOnce, with a stable per-database jobKey", async () => {
    const emailsId = await databaseIdFor("emails");
    const legacyItemId = await createLegacyEmailItem(emailsId, {
      name: "Old subject",
      sender: "alice@example.com",
      recipients: "",
    });

    await inTenantZero(() => withTransaction(pool, (client) => enqueueMailLegacyEmailMigration(client, emailsId)));
    const { rows: jobRows } = await pool.query(`SELECT key FROM graphile_worker._private_jobs WHERE key = $1`, [
      mailLegacyEmailMigrationJobKey(emailsId),
    ]);
    expect(jobRows).toHaveLength(1);

    await drainQueue();

    const meta = await withTransaction(pool, (client) => getMailMessageMetaByItemId(client, legacyItemId));
    expect(meta?.migrationStatus).toBe("partial");
  });

  tenantIt(
    "fetches an item's raw MIME before opening that item's transaction, not from inside it (issue #267)",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const legacyItemId1 = await createLegacyEmailItem(emailsId, {
        name: "First",
        sender: "a@example.com",
        recipients: "",
      });
      const legacyItemId2 = await createLegacyEmailItem(emailsId, {
        name: "Second",
        sender: "b@example.com",
        recipients: "",
      });

      // No pool-wrapper precedent exists in `backend/` to copy, and `withTransaction` is typed
      // against `pg.Pool` — a `Proxy` over the real pool lets `connect()` be intercepted while
      // everything else (including `pool.query` used elsewhere in this test) still goes straight
      // through to the real pool.
      const log: string[] = [];
      // Postgres pooled clients are reused across separate `connect()` calls — re-wrapping
      // `client.query` on every checkout (instead of once, tracked here) would stack a fresh
      // logging layer on top of the previous checkout's, double- (or triple-) counting BEGIN/COMMIT.
      const originalQueryByClient = new WeakMap<PoolClient, PoolClient["query"]>();
      async function connectAndRecord(): Promise<PoolClient> {
        const client = await pool.connect();
        if (!originalQueryByClient.has(client)) {
          originalQueryByClient.set(client, client.query.bind(client));
          const originalQuery = originalQueryByClient.get(client)!;
          (client as unknown as { query: unknown }).query = (...queryArgs: unknown[]) => {
            const text =
              typeof queryArgs[0] === "string" ? queryArgs[0] : (queryArgs[0] as { text?: string } | undefined)?.text;
            if (text === "BEGIN" || text === "COMMIT") log.push(text);
            return (originalQuery as (...a: unknown[]) => unknown)(...queryArgs);
          };
        }
        return client;
      }
      const recordingPool = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === "connect") return connectAndRecord;
          return Reflect.get(target, prop, receiver);
        },
      });

      const fetchRawMime: LegacyRawMimeFetcher = async (itemId) => {
        log.push(`fetch:${itemId}`);
        return null;
      };

      await runMailLegacyEmailMigrationJob(recordingPool, emailsId, fetchRawMime);

      expect(log.filter((entry) => entry.startsWith("fetch:")).sort()).toEqual(
        [`fetch:${legacyItemId1}`, `fetch:${legacyItemId2}`].sort(),
      );
      const beginIndices = log.reduce<number[]>((acc, entry, index) => (entry === "BEGIN" ? [...acc, index] : acc), []);
      expect(beginIndices.length).toBeGreaterThanOrEqual(2);
      // Every transaction's BEGIN is immediately preceded by that item's fetch marker — proving
      // the fetch happened before the transaction opened, not from inside it.
      for (const index of beginIndices) {
        expect(log[index - 1]).toMatch(/^fetch:/);
      }
    },
  );
});

describe("IMAP PEEK vs explicit mark-read (issue #94)", () => {
  afterEach(() => vi.restoreAllMocks());
  function fakeImapFlow(overrides: Partial<Record<string, unknown>> = {}): ImapFlow {
    const calls: string[] = [];
    return {
      capabilities: new Map(),
      calls,
      async mailboxOpen(path: string) {
        calls.push(`mailboxOpen:${path}`);
        return { uidValidity: 1n, uidNext: 3, highestModseq: undefined, noModseq: true };
      },
      async download() {
        calls.push("download");
        return { content: (async function* () {})() };
      },
      fetch() {
        calls.push("fetch");
        return (async function* () {
          yield {
            uid: 1,
            envelope: { from: [{ address: "a@x.com" }], to: [], cc: [] },
            bodyStructure: { type: "text/plain", part: "1" },
            headers: Buffer.from(""),
          };
        })();
      },
      async messageFlagsAdd(range: string, flags: string[]) {
        calls.push(`messageFlagsAdd:${range}:${flags.join(",")}`);
        return true;
      },
      async messageFlagsRemove(range: string, flags: string[]) {
        calls.push(`messageFlagsRemove:${range}:${flags.join(",")}`);
        return true;
      },
      on() {},
      off() {},
      ...overrides,
    } as unknown as ImapFlow;
  }

  it("never calls messageFlagsAdd while fetching message bodies in the background", async () => {
    const raw = fakeImapFlow() as unknown as { calls: string[] };
    const client = new ImapFlowMailClient(raw as unknown as ImapFlow);

    const fetched = await client.fetchMessagesSince("INBOX", 1);

    // Confirms the fetch actually walked into a real message's body (calling `download`) rather
    // than trivially seeing no flag mutation because nothing was fetched at all.
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.message.bodyText).toBeDefined();
    expect(raw.calls).toContain("download");
    expect(raw.calls.some((c) => c.startsWith("messageFlagsAdd"))).toBe(false);
  });

  async function attachmentStream(client: ImapFlowMailClient): Promise<Readable> {
    const fetched = await client.fetchMessagesSince("INBOX", 1);
    return await fetched[0]!.message.attachments[0]!.openStream();
  }

  function attachmentFetch(): AsyncIterableIterator<FetchMessageObject> {
    return (async function* () {
      yield {
        seq: 1,
        uid: 1,
        envelope: { from: [{ address: "a@x.com" }], to: [], cc: [] },
        bodyStructure: { type: "application/pdf", part: "2", disposition: "attachment" },
        headers: Buffer.from(""),
      };
    })();
  }

  it("keeps a secret-bearing lazy download failure out of serialized fallback diagnostics", async () => {
    const connection = new ImapFlow({
      host: "unused.example.test",
      port: 993,
      secure: true,
      auth: { user: "unused", pass: "unused" },
      logger: false,
    });
    vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
      path: "INBOX",
      delimiter: "/",
      flags: new Set(),
      uidValidity: 1n,
      uidNext: 2,
      exists: 1,
    });
    vi.spyOn(connection, "fetch").mockImplementation(attachmentFetch);
    const original = Object.assign(new Error("IMAP-PRIVATE-SENTINEL"), { name: "IMAP-PRIVATE-SENTINEL" });
    let emitted: unknown;
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("abc");
        emitted = original;
        throw original;
      })(),
    );
    vi.spyOn(connection, "download").mockResolvedValue({
      meta: { expectedSize: 6, contentType: "application/pdf" },
      content: source,
    });
    vi.spyOn(connection, "fetchOne").mockResolvedValue({
      seq: 1,
      uid: 1,
      bodyParts: new Map([["2", Buffer.from("def")]]),
    });
    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!streamSymbol) throw new Error("Missing application log stream");
    const previousStream: unknown = Reflect.get(logger, streamSymbol);
    const previousLevel = logger.level;
    const logs: string[] = [];
    if (
      !Reflect.set(logger, streamSymbol, {
        write: (line: string) => {
          logs.push(line);
          return true;
        },
      })
    ) {
      throw new Error("Could not capture application log stream");
    }
    const failures: unknown[] = [];
    try {
      logger.level = "warn";
      const stream = await attachmentStream(new ImapFlowMailClient(connection));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("abcdef");
      expect(emitted).toBe(original);
      expect(source.destroyed).toBe(true);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain("IMAP-PRIVATE-SENTINEL");
      expect(JSON.parse(logs[0] ?? "null")).toMatchObject({ stage: "attachment_fallback" });
    } catch (error) {
      failures.push(error);
    }
    try {
      logger.level = previousLevel;
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!Reflect.set(logger, streamSymbol, previousStream))
        throw new Error("Could not restore application log stream");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "IMAP fallback diagnostic test and cleanup failed");
  });

  it("replaces a failed attachment download with ordered bounded IMAP partial ranges", async () => {
    const ranges: Array<{ start: number; maxLength: number }> = [];
    const raw = fakeImapFlow({
      async download() {
        return {
          content: Readable.from(
            (async function* () {
              yield Buffer.from("abc");
              throw new Error("midstream failure");
            })(),
          ),
        };
      },
      fetch: attachmentFetch,
      async fetchOne(_uid: string, query: { bodyParts?: Array<{ key: string; start?: number; maxLength?: number }> }) {
        const range = query.bodyParts?.[0];
        if (range?.start === undefined || range.maxLength === undefined) throw new Error("missing partial range");
        ranges.push({ start: range.start, maxLength: range.maxLength });
        return { bodyParts: new Map([[range.key, Buffer.from("def")]]) };
      },
    });

    const stream = await attachmentStream(new ImapFlowMailClient(raw));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString()).toBe("abcdef");
    expect(ranges).toEqual([{ start: 3, maxLength: 64 * 1024 }]);
  });

  it("recognizes EOF from a short partial range and rejects a partial fetch that makes no progress", async () => {
    const eofChunk = Buffer.alloc(100);
    const eofStarts: number[] = [];
    const eofRaw = fakeImapFlow({
      async download() {
        throw new Error("download failed");
      },
      fetch: attachmentFetch,
      async fetchOne(_uid: string, query: { bodyParts?: Array<{ key: string; start?: number }> }) {
        const range = query.bodyParts?.[0];
        if (range?.start === undefined) throw new Error("missing partial range");
        eofStarts.push(range.start);
        return { bodyParts: new Map([[range.key, eofChunk]]) };
      },
    });
    const eofStream = await attachmentStream(new ImapFlowMailClient(eofRaw));
    let eofBytes = 0;
    for await (const chunk of eofStream) eofBytes += Buffer.byteLength(chunk);
    expect(eofBytes).toBe(eofChunk.length);
    expect(eofStarts).toEqual([0]);

    const stalledRaw = fakeImapFlow({
      async download() {
        throw new Error("download failed");
      },
      fetch: attachmentFetch,
      async fetchOne(_uid: string, query: { bodyParts?: Array<{ key: string }> }) {
        const key = query.bodyParts?.[0]?.key;
        if (!key) throw new Error("missing partial range");
        return { bodyParts: new Map([[key, Buffer.alloc(0)]]) };
      },
    });
    const stalledStream = await attachmentStream(new ImapFlowMailClient(stalledRaw));
    await expect(async () => {
      for await (const _chunk of stalledStream) {
        // Draining is required to make the lazy fallback perform its first partial request.
      }
    }).rejects.toThrow("made no progress");
  });

  it("rejects a partial download that reaches the attachment cap and still has bytes", async () => {
    const fullChunk = Buffer.alloc(64 * 1024);
    let fetches = 0;
    const raw = fakeImapFlow({
      async download() {
        throw new Error("download failed");
      },
      fetch: attachmentFetch,
      async fetchOne(_uid: string, query: { bodyParts?: Array<{ key: string }> }) {
        const key = query.bodyParts?.[0]?.key;
        if (!key) throw new Error("missing partial range");
        fetches += 1;
        // 1600 = MAX_ATTACHMENT_BYTES (104_857_600) / IMAP_PARTIAL_FETCH_BYTES (65_536), both
        // private to imapFlowClient.ts so not importable here — the number of full-size chunks
        // needed to reach the cap exactly.
        return { bodyParts: new Map([[key, fetches <= 1600 ? fullChunk : Buffer.from("x")]]) };
      },
    });
    const stream = await attachmentStream(new ImapFlowMailClient(raw));

    await expect(async () => {
      for await (const _chunk of stream) {
        // Draining confirms the cap is enforced by the fallback before storage sees an extra byte.
      }
    }).rejects.toThrow("exceeded the 104857600-byte cap");
    // 1601 = the 1600 full-size chunks above plus the EOF probe fetch that discovers extra bytes.
    expect(fetches).toBe(1601);
  });

  it("setMessageFlag — the only explicit flag-writing path — issues STORE +FLAGS / -FLAGS for the given UID", async () => {
    const raw = fakeImapFlow() as unknown as { calls: string[] };
    const client = new ImapFlowMailClient(raw as unknown as ImapFlow);

    await client.setMessageFlag("INBOX", 42, IMAP_SEEN_FLAG, true);
    await client.setMessageFlag("INBOX", 42, IMAP_FLAGGED_FLAG, false);

    expect(raw.calls).toEqual([
      "mailboxOpen:INBOX",
      "messageFlagsAdd:42:\\Seen",
      "mailboxOpen:INBOX",
      "messageFlagsRemove:42:\\Flagged",
    ]);
  });

  // Compile-time-only guard, never invoked: `setMessageFlag`'s flag parameter is `WritableImapFlag`
  // (the two canonical keys from messageFlags.ts), not a bare `string` — so any other IMAP flag,
  // like `\Deleted`, must fail to typecheck. If `WritableImapFlag` is ever widened back to
  // `string`, this `@ts-expect-error` becomes unused and `tsc`/`pnpm -r run build` fails.
  function _typeAssertion_setMessageFlagRejectsNonCanonicalFlags(client: ImapFlowMailClient): void {
    // @ts-expect-error - "\Deleted" is not a WritableImapFlag
    void client.setMessageFlag("INBOX", 42, "\\Deleted", true);
  }
  // Referenced so `noUnusedLocals` keeps the guard above: unlike parameters, a local
  // declaration gets no leading-underscore exemption from tsc.
  void _typeAssertion_setMessageFlagRejectsNonCanonicalFlags;

  it("isImapConnectionLimitError recognizes a provider's simultaneous-connection BYE, not an ordinary connection failure", () => {
    const gmailBye = Object.assign(new Error("Connection closed"), {
      code: "ClosedAfterConnectText",
      reason: "Too many simultaneous connections.",
    });
    const genericPhrase = new Error("Login failed: too many concurrent connections for this account");
    const unrelated = new Error("ECONNREFUSED");

    expect(isImapConnectionLimitError(gmailBye)).toBe(true);
    expect(isImapConnectionLimitError(genericPhrase)).toBe(true);
    expect(isImapConnectionLimitError(unrelated)).toBe(false);
    expect(isImapConnectionLimitError("not an error")).toBe(false);
  });

  it("does not misclassify a TLS/other pre-auth closure as a connection-limit rejection just because it shares imapflow's ClosedAfterConnectTLS code", () => {
    // imapflow assigns this same code to *any* pre-auth server closure (cert failures, a
    // suspended account, maintenance) — only the reason text, not the code alone, may decide this.
    const tlsFailure = Object.assign(new Error("TLS handshake error"), {
      code: "ClosedAfterConnectTLS",
      reason: "TLS certificate error",
    });
    expect(isImapConnectionLimitError(tlsFailure)).toBe(false);
  });
});

describe("per-account IMAP concurrency limiter (issue #94)", () => {
  it("never runs more than `limit` tasks concurrently for the same account", async () => {
    const limiter = createImapConnectionLimiter();
    let active = 0;
    let maxActive = 0;
    const task = () =>
      limiter.run("account-1", 2, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("does not bound one account's concurrency by another account's limit", async () => {
    const limiter = createImapConnectionLimiter();
    let activeA = 0;
    let maxActiveA = 0;
    let activeB = 0;
    let maxActiveB = 0;

    const taskA = () =>
      limiter.run("account-a", 1, async () => {
        activeA++;
        maxActiveA = Math.max(maxActiveA, activeA);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeA--;
      });
    const taskB = () =>
      limiter.run("account-b", 3, async () => {
        activeB++;
        maxActiveB = Math.max(maxActiveB, activeB);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeB--;
      });

    await Promise.all([taskA(), taskA(), taskA(), taskB(), taskB(), taskB()]);

    expect(maxActiveA).toBe(1);
    expect(maxActiveB).toBe(3);
  });

  it("wakes a queued task immediately when a later call raises the account's limit, instead of waiting for an unrelated task to finish", async () => {
    const limiter = createImapConnectionLimiter();
    let releaseFirst: () => void = () => {};
    const first = limiter.run("account-raise", 1, () => new Promise<void>((resolve) => (releaseFirst = resolve)));

    let secondStarted = false;
    const second = limiter.run("account-raise", 1, async () => {
      secondStarted = true;
    });

    expect(secondStarted).toBe(false); // still queued behind `first` at the original limit of 1

    // A later call for the same account raises the limit to 2 — `second` should be released
    // right away rather than waiting for `first` to finish first.
    await limiter.run("account-raise", 2, async () => {});
    expect(secondStarted).toBe(true);

    releaseFirst();
    await Promise.all([first, second]);
  });

  it("rejects a queued task that waits past the per-account timeout instead of hanging on a stalled connection forever", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createImapConnectionLimiter();
      const blocked = limiter.run("account-stalled", 1, () => new Promise<void>(() => {})); // never resolves — a stuck connection
      const queued = limiter.run("account-stalled", 1, async () => {});
      const expectation = expect(queued).rejects.toThrow(/Timed out/);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);
      await expectation;
      void blocked;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a limit raise's wake-up to the capacity that actually freed up, not every queued waiter", async () => {
    // Resolves once pending microtasks (a woken waiter's `run()` continuation) have had a chance
    // to settle, without advancing real time.
    const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

    const limiter = createImapConnectionLimiter();
    const accountId = "account-bounded-raise";
    let concurrent = 0;
    let maxConcurrent = 0;
    const releasers: Array<() => void> = [];

    const runTask = (limit: number) =>
      limiter.run(accountId, limit, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => releasers.push(resolve));
        concurrent--;
      });

    // One task runs under limit 1; three more queue up behind it.
    const results = [runTask(1), runTask(1), runTask(1), runTask(1)];
    await flushMicrotasks();
    expect(concurrent).toBe(1);

    // Raising the limit to 3 must free up exactly two more slots (3 - 1 active), not all three
    // remaining waiters — this is the capacity-bound the limiter must enforce.
    const raised = runTask(3);
    await flushMicrotasks();
    expect(concurrent).toBe(3);
    expect(maxConcurrent).toBe(3);

    // Release the first task so the queue drains; every queued task eventually runs, and the
    // limit is never exceeded as later waiters get woken to backfill freed slots.
    for (let i = 0; i < 10 && releasers.length > 0; i++) {
      releasers.splice(0).forEach((release) => release());
      await flushMicrotasks();
      expect(concurrent).toBeLessThanOrEqual(3);
    }

    await Promise.all([...results, raised]);
    expect(maxConcurrent).toBe(3);
    expect(concurrent).toBe(0);
  });
});

describe("mail sync connection-limit backoff (issue #94)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("schedules a delayed retry through persisted sync state instead of rethrowing, on a connection-limit rejection", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    // Pre-seeded to 'ok' (not left unset) so the assertion below actually proves the status
    // gets updated on this path, rather than merely being indistinguishable from "never touched".
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: mailboxesId, properties: { name: "M", provider: "gmail", syncStatus: "ok" } },
        { allowedSystemKeys: ["syncStatus"] },
      ),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );

    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailConnectionLimitError("Too many simultaneous connections.");
      },
    };

    // Resolves rather than rejecting: a connection-limit rejection is contention, not a hard
    // failure, and must not also trigger graphile-worker's own immediate job retry on top of
    // the delayed sweep-driven retry recorded below.
    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      adapters,
      {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      },
      noopStorage,
    );

    const state = await withTransaction(pool, (client) => getMailAccountSyncState(client, mailbox.id));
    expect(state?.lastError).toBe("Too many simultaneous connections.");
    expect(state?.nextExpectedActivityAt).toBeTruthy();
    // Gmail's provider-aware backoff (10 minutes) is well past the generic 15-minute window's
    // midpoint, distinguishing it from `recordSyncError`'s fixed backoff.
    expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now() + 8 * 60 * 1000);

    // Mail genuinely isn't syncing right now, so syncStatus reflects that like any other
    // failure — it clears back to 'ok' the same way, via the next successful pass.
    const item = await withTransaction(pool, (client) =>
      client.query(`SELECT properties FROM items WHERE id = $1`, [mailbox.id]),
    );
    expect(item.rows[0].properties.syncStatus).toBe("error");
  });

  tenantIt("routes a real IMAP connection attempt through the injected per-account connection limiter", async () => {
    const emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const filesId = await databaseIdFor("files");
    const mailboxesId = await databaseIdFor("mailboxes");

    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "gmail" } }),
    );
    await withTransaction(pool, (client) =>
      ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );

    const emptyImap: ImapMailClient = {
      appendMessage: async () => {},
      getCapabilities: async () => new Set(),
      listFolders: async () => [],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => [],
      fetchAllUids: async () => [],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {},
      close: async () => {},
    };

    const runCalls: Array<{ accountId: string; limit: number }> = [];
    const recordingLimiter = {
      run: <T>(accountId: string, limit: number, task: () => Promise<T>) => {
        runCalls.push({ accountId, limit });
        return task();
      },
    };

    await handleSyncMailAccountTask(
      pool,
      { mailboxItemId: mailbox.id },
      { createImapClient: async () => emptyImap },
      {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      },
      noopStorage,
      undefined,
      recordingLimiter,
    );

    expect(runCalls).toEqual([{ accountId: mailbox.id, limit: 5 }]); // Gmail's provider default
  });

  tenantIt(
    "uses Mailboxes.connectionLimit instead of the provider default when the user has configured one",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");

      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name: "M", provider: "gmail", connectionLimit: 1 },
        }),
      );
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );

      const emptyImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };

      const runCalls: Array<{ accountId: string; limit: number }> = [];
      const recordingLimiter = {
        run: <T>(accountId: string, limit: number, task: () => Promise<T>) => {
          runCalls.push({ accountId, limit });
          return task();
        },
      };

      await handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        { createImapClient: async () => emptyImap },
        {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          foldersDatabaseId: foldersId,
          mailboxesDatabaseId: mailboxesId,
        },
        noopStorage,
        undefined,
        recordingLimiter,
      );

      expect(runCalls).toEqual([{ accountId: mailbox.id, limit: 1 }]); // user override wins over Gmail's provider default of 5
    },
  );

  tenantIt(
    "holds no pooled database connection while a sync pass waits for an IMAP connection slot (issue #267)",
    async () => {
      const emailsId = await databaseIdFor("emails");
      const foldersId = await databaseIdFor("folders");
      const filesId = await databaseIdFor("files");
      const mailboxesId = await databaseIdFor("mailboxes");
      const moduleIds = {
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        mailboxesDatabaseId: mailboxesId,
      };

      // connectionLimit: 1 forces genuine contention between two concurrent passes for this
      // account — at the default limit of 2 (imapConnectionLimitForProvider) they never wait and
      // this test would pass vacuously even on the unfixed code.
      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", connectionLimit: 1 } }),
      );
      await withTransaction(pool, (client) =>
        ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }),
      );
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );

      // A real (not fake/recording) limiter — the point of this test is genuine queueing.
      const limiter = createImapConnectionLimiter();

      let releaseFirst: () => void = () => {};
      let resolveFirstStarted: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const blockingImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
        selectFolder: async () => {
          resolveFirstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { uidvalidity: 1, uidnext: 1, highestModSeq: null };
        },
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };
      const emptyImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => [],
        fetchAllUids: async () => [],
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };

      // The first pass takes the account's only slot and holds it (blocked inside `selectFolder`,
      // with its write transaction's connection checked out) until `releaseFirst()` is called.
      const firstPass = handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        { createImapClient: async () => blockingImap },
        moduleIds,
        noopStorage,
        undefined,
        limiter,
      );
      await firstStarted;

      const checkedOut = () => pool.totalCount - pool.idleCount;
      const baseline = checkedOut();

      const secondPass = handleSyncMailAccountTask(
        pool,
        { mailboxItemId: mailbox.id },
        { createImapClient: async () => emptyImap },
        moduleIds,
        noopStorage,
        undefined,
        limiter,
      );

      // Waits until the second pass's own credential fetch (which happens before it ever calls
      // the limiter) has been logged — proof it has run its prologue/credential work and is now
      // either calling or blocked in `imapConnectionLimiter.run`, not still doing earlier work.
      for (;;) {
        const { rows } = await pool.query(`SELECT count(*) FROM credential_access_log WHERE item_id = $1`, [
          mailbox.id,
        ]);
        if (Number(rows[0].count) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // One more tick so the second pass's synchronous `imapConnectionLimiter.run(...)` call (and
      // its internal queueing) has actually run.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The second pass is queued behind the first (limit 1, one already active) — it must not
      // have checked out a database connection while it waits. On the unfixed code, the write
      // transaction opened before the limiter wait, so this would be +1.
      expect(checkedOut() - baseline).toBe(0);

      releaseFirst();
      await firstPass;
      await secondPass;
    },
  );
});

describe("mail flag write-back (issue #251)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt(
    "persists desired/current state, writes every IMAP folder copy for all four transitions, and does not echo a converged observation",
    async () => {
      const [emailsId, foldersId, filesId, mailboxesId] = await Promise.all([
        databaseIdFor("emails"),
        databaseIdFor("folders"),
        databaseIdFor("files"),
        databaseIdFor("mailboxes"),
      ]);
      const [emailProperties, folderProperties] = await Promise.all([
        chokePoint.listProperties(emailsId),
        chokePoint.listProperties(foldersId),
      ]);
      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M" } }),
      );
      const params = {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emailsId,
        filesDatabaseId: filesId,
        foldersDatabaseId: foldersId,
        folderRelationPropertyId: emailProperties.find((property) => property.key === "folder")!.id,
        mailboxFolderRelationPropertyId: folderProperties.find((property) => property.key === "mailbox")!.id,
        attachmentsRelationPropertyId: emailProperties.find((property) => property.key === "attachments")!.id,
        storage: noopStorage,
        storageKeyPrefix: "test",
      };
      const message = {
        messageId: "<writeback@x>",
        envelope: {},
        attachments: [],
        flags: [],
      };
      const initial: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [
          { path: "INBOX", specialUse: "\\Inbox" },
          { path: "Archive", specialUse: "\\Archive" },
        ],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
        fetchMessagesSince: async (path) => [{ uid: path === "INBOX" ? 1 : 2, message }],
        fetchVanishedSince: async () => [],
        fetchAllUids: async (path) => (path === "INBOX" ? [1] : [2]),
        fetchFlagsChangedSince: async () => [],
        setMessageFlag: async () => {},
        close: async () => {},
      };
      await withTransaction(pool, (client) => reconcileImapAccount(client, initial, params));

      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [emailsId]);
      const emailItemId = rows[0]!.id;
      await chokePoint.updateItem({
        databaseId: emailsId,
        itemId: emailItemId,
        propertiesPatch: { read: true, flagged: true },
      });

      const writes: Array<{ path: string; flag: string; value: boolean }> = [];
      const writingClient: ImapMailClient = {
        ...initial,
        fetchMessagesSince: async () => [],
        setMessageFlag: async (path, _uid, flag, value) => {
          writes.push({ path, flag, value });
        },
      };
      await withTransaction(pool, (client) => reconcileImapAccount(client, writingClient, params));
      expect(writes).toHaveLength(4);
      expect(writes).toEqual(
        expect.arrayContaining([
          { path: "INBOX", flag: IMAP_FLAGGED_FLAG, value: true },
          { path: "Archive", flag: IMAP_FLAGGED_FLAG, value: true },
          { path: "INBOX", flag: IMAP_SEEN_FLAG, value: true },
          { path: "Archive", flag: IMAP_SEEN_FLAG, value: true },
        ]),
      );

      await chokePoint.updateItem({
        databaseId: emailsId,
        itemId: emailItemId,
        propertiesPatch: { read: false, flagged: false },
      });
      await withTransaction(pool, (client) => reconcileImapAccount(client, writingClient, params));
      expect(writes.slice(4)).toHaveLength(4);
      expect(writes.slice(4)).toEqual(
        expect.arrayContaining([
          { path: "INBOX", flag: IMAP_FLAGGED_FLAG, value: false },
          { path: "Archive", flag: IMAP_FLAGGED_FLAG, value: false },
          { path: "INBOX", flag: IMAP_SEEN_FLAG, value: false },
          { path: "Archive", flag: IMAP_SEEN_FLAG, value: false },
        ]),
      );

      await chokePoint.updateItem({ databaseId: emailsId, itemId: emailItemId, propertiesPatch: { read: true } });
      const observedConvergence: ImapMailClient = {
        ...initial,
        fetchMessagesSince: async (path) => [
          { uid: path === "INBOX" ? 1 : 2, message: { ...message, flags: [IMAP_SEEN_FLAG] } },
        ],
        setMessageFlag: async () => {
          throw new Error("a provider observation matching desired state must not be echoed");
        },
      };
      await withTransaction(pool, (client) => reconcileImapAccount(client, observedConvergence, params));

      await chokePoint.updateItem({ databaseId: emailsId, itemId: emailItemId, propertiesPatch: { flagged: true } });
      const failingClient: ImapMailClient = {
        ...writingClient,
        setMessageFlag: async () => {
          throw new Error("temporary IMAP failure");
        },
      };
      await expect(
        withTransaction(pool, (client) => reconcileImapAccount(client, failingClient, params)),
      ).rejects.toThrow("temporary IMAP failure");
      await withTransaction(pool, (client) => reconcileImapAccount(client, writingClient, params));
      expect(writes.slice(-2)).toHaveLength(2);
      expect(writes.slice(-2)).toEqual(
        expect.arrayContaining([
          { path: "INBOX", flag: IMAP_FLAGGED_FLAG, value: true },
          { path: "Archive", flag: IMAP_FLAGGED_FLAG, value: true },
        ]),
      );
    },
  );
});

describe("flag observation convergence and IMAP known-UID re-fetch (issue #681)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function relationDefinitionIdFor(propertyId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
      [propertyId],
    );
    return rows[0]!.id;
  }

  async function flagStateRowFor(itemId: string, propertyKey: string) {
    const { rows } = await pool.query<{ desired_state: boolean; current_state: boolean }>(
      `SELECT desired_state, current_state FROM mail_message_flag_sync_state
       WHERE message_item_id = $1 AND property_key = $2`,
      [itemId, propertyKey],
    );
    return rows[0];
  }

  /** One Mailbox with one Folder, and the params reconcileImapFolder needs for it. */
  async function setUpFolder() {
    const [emailsId, foldersId, filesId, mailboxesId] = await Promise.all([
      databaseIdFor("emails"),
      databaseIdFor("folders"),
      databaseIdFor("files"),
      databaseIdFor("mailboxes"),
    ]);
    const [emailProperties, folderProperties] = await Promise.all([
      chokePoint.listProperties(emailsId),
      chokePoint.listProperties(foldersId),
    ]);
    const mailbox = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "M", provider: "generic" } }),
    );
    const folderRelationPropertyId = emailProperties.find((p) => p.key === "folder")!.id;
    const mailboxFolderRelationPropertyId = folderProperties.find((p) => p.key === "mailbox")!.id;
    const folder = await withTransaction(pool, async (client) => {
      const created = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX", behavior: "folder", providerId: "INBOX" } },
        { allowedSystemKeys: ["name", "behavior", "providerId"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: created.id, targetItemId: mailbox.id },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
      return created;
    });
    const params = {
      folderItemId: folder.id,
      folderPath: "INBOX",
      emailsDatabaseId: emailsId,
      filesDatabaseId: filesId,
      folderRelationPropertyId,
      attachmentsRelationPropertyId: emailProperties.find((p) => p.key === "attachments")!.id,
      storage: noopStorage,
      storageKeyPrefix: "test",
      mailboxItemId: mailbox.id,
      foldersDatabaseId: foldersId,
      mailboxFolderRelationPropertyId,
    };
    return { emailsId, mailbox, folder, params };
  }

  /** Ingests one message (uid 1, unread/unflagged) via reconcileImapFolder's own initial-sync pass, so mail_folder_sync_state carries real uidnext/uidvalidity for the second pass to build on. */
  async function ingestFirstMessage(
    params: Awaited<ReturnType<typeof setUpFolder>>["params"],
    overrides: Partial<ImapMailClient> = {},
  ): Promise<string> {
    const firstPassImap: ImapMailClient = {
      appendMessage: async () => {},
      getCapabilities: async () => new Set(),
      listFolders: async () => [{ path: "INBOX" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
      fetchMessagesSince: async () => [
        { uid: 1, message: { messageId: "<obs@x>", envelope: {}, attachments: [], flags: [] } },
      ],
      fetchVanishedSince: async () => null,
      fetchAllUids: async () => [1],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: async () => {
        throw new Error("write-back is out of scope for this test");
      },
      close: async () => {},
      ...overrides,
    };
    await withTransaction(pool, (client) => reconcileImapFolder(client, firstPassImap, params));
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
      params.emailsDatabaseId,
    ]);
    return rows[0]!.id;
  }

  tenantIt(
    "(a) an observation on a converged flag replaces the item's value and both state halves, leaving no pending write",
    async () => {
      const { emailsId, mailbox, params } = await setUpFolder();
      const emailItemId = await ingestFirstMessage(params);

      await chokePoint.updateItem({ databaseId: emailsId, itemId: emailItemId, propertiesPatch: { read: true } });
      await withTransaction(pool, (client) => recordConfirmedMailMessageFlag(client, emailItemId, "read", true));
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: true });

      const secondPassImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => [1],
        fetchFlagsChangedSince: async () => [{ uid: 1, flags: [] }], // observed unread
        setMessageFlag: async () => {
          throw new Error("a converged observation must not be echoed as a write-back");
        },
        close: async () => {},
      };
      await withTransaction(pool, (client) => reconcileImapFolder(client, secondPassImap, params));

      expect((await chokePoint.getItem(emailsId, emailItemId))?.properties.read).toBe(false);
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: false, current_state: false });

      const folderRelationDefinitionId = await relationDefinitionIdFor(params.folderRelationPropertyId);
      const mailboxFolderRelationDefinitionId = await relationDefinitionIdFor(params.mailboxFolderRelationPropertyId);
      expect(
        await listPendingImapFlagWrites(pool, {
          folderRelationDefinitionId,
          mailboxFolderRelationDefinitionId,
          mailboxItemId: mailbox.id,
        }),
      ).toEqual([]);
    },
  );

  tenantIt(
    "(b) an observation of the old value while a write is pending leaves the item and the pending write untouched",
    async () => {
      const { emailsId, mailbox, params } = await setUpFolder();
      const emailItemId = await ingestFirstMessage(params);

      // Marked read but never confirmed by write-back — desired true, current still false.
      await chokePoint.updateItem({ databaseId: emailsId, itemId: emailItemId, propertiesPatch: { read: true } });
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: false });

      const secondPassImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => [1],
        fetchFlagsChangedSince: async () => [{ uid: 1, flags: [] }], // observed unread, the old value
        setMessageFlag: async () => {
          throw new Error("this pass must not attempt a write-back itself");
        },
        close: async () => {},
      };
      await withTransaction(pool, (client) => reconcileImapFolder(client, secondPassImap, params));

      expect((await chokePoint.getItem(emailsId, emailItemId))?.properties.read).toBe(true);
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: false });

      const folderRelationDefinitionId = await relationDefinitionIdFor(params.folderRelationPropertyId);
      const mailboxFolderRelationDefinitionId = await relationDefinitionIdFor(params.mailboxFolderRelationPropertyId);
      expect(
        await listPendingImapFlagWrites(pool, {
          folderRelationDefinitionId,
          mailboxFolderRelationDefinitionId,
          mailboxItemId: mailbox.id,
        }),
      ).toEqual([{ messageItemId: emailItemId, propertyKey: "read", desiredState: true, folderPath: "INBOX", uid: 1 }]);
    },
  );

  tenantIt(
    "(c) an observation equal to the pending desired value converges the row without patching the item",
    async () => {
      const { emailsId, mailbox, params } = await setUpFolder();
      const emailItemId = await ingestFirstMessage(params);

      await chokePoint.updateItem({ databaseId: emailsId, itemId: emailItemId, propertiesPatch: { read: true } });
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: false });

      const secondPassImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => [1],
        fetchFlagsChangedSince: async () => [{ uid: 1, flags: [IMAP_SEEN_FLAG] }], // observed read, matching desired
        setMessageFlag: async () => {
          throw new Error("an observation matching desired state must not be echoed as a write-back");
        },
        close: async () => {},
      };
      await withTransaction(pool, (client) => reconcileImapFolder(client, secondPassImap, params));

      expect((await chokePoint.getItem(emailsId, emailItemId))?.properties.read).toBe(true);
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: true });

      const folderRelationDefinitionId = await relationDefinitionIdFor(params.folderRelationPropertyId);
      const mailboxFolderRelationDefinitionId = await relationDefinitionIdFor(params.mailboxFolderRelationPropertyId);
      expect(
        await listPendingImapFlagWrites(pool, {
          folderRelationDefinitionId,
          mailboxFolderRelationDefinitionId,
          mailboxItemId: mailbox.id,
        }),
      ).toEqual([]);
    },
  );

  tenantIt(
    "a repeat ingest of an already-known message with a pending write-back leaves the item and desired_state untouched",
    async () => {
      const { emailsId, params } = await setUpFolder();
      const ingestArgs = {
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId: params.folderItemId,
        mailboxItemId: params.mailboxItemId,
        folderUid: 1,
        messageId: "<repeat-pending@x>",
        envelope: {},
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        flags: [], // unread on the provider
      };

      const first = await withTransaction(pool, (client) => ingestEmailMessage(client, ingestArgs));
      expect(first.created).toBe(true);

      // Marked read but never confirmed by write-back — desired true, current still false.
      await chokePoint.updateItem({ databaseId: emailsId, itemId: first.itemId, propertiesPatch: { read: true } });
      expect(await flagStateRowFor(first.itemId, "read")).toEqual({ desired_state: true, current_state: false });

      // A later fetchMessagesSince pass re-observes the same message, still carrying the old
      // (unread) flag value the provider had before the pending write-back has had a chance to run.
      const second = await withTransaction(pool, (client) => ingestEmailMessage(client, ingestArgs));
      expect(second.created).toBe(false);
      expect(second.itemId).toBe(first.itemId);

      expect((await chokePoint.getItem(emailsId, first.itemId))?.properties.read).toBe(true);
      expect(await flagStateRowFor(first.itemId, "read")).toEqual({ desired_state: true, current_state: false });
    },
  );

  describe("applyObservedMailMessageFlags, called directly", () => {
    it("throws NotFoundError when the item does not exist", async () => {
      const { params } = await setUpFolder();
      await expect(
        withTransaction(pool, (client) =>
          applyObservedMailMessageFlags(client, {
            emailsDatabaseId: params.emailsDatabaseId,
            messageItemId: randomUUID(),
            flags: [],
          }),
        ),
      ).rejects.toThrow(NotFoundError);
    });

    tenantIt("patches the item and creates a converged sync-state row when none exists yet", async () => {
      const { emailsId, params } = await setUpFolder();
      const ingestArgs = {
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId: params.folderItemId,
        mailboxItemId: params.mailboxItemId,
        folderUid: 1,
        messageId: "<no-rows@x>",
        envelope: {},
        attachments: [],
        storage: noopStorage,
        storageKeyPrefix: "test",
        // No `flags`: ingestEmailMessage's created branch only records observed flags when the
        // caller passes them, so this message lands with no mail_message_flag_sync_state rows
        // at all — the no-prior-row branch applyObservedMailMessageFlags has to handle itself.
      };
      const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, ingestArgs));
      expect(await flagStateRowFor(itemId, "read")).toBeUndefined();

      await withTransaction(pool, (client) =>
        applyObservedMailMessageFlags(client, {
          emailsDatabaseId: params.emailsDatabaseId,
          messageItemId: itemId,
          flags: [IMAP_SEEN_FLAG],
        }),
      );

      expect((await chokePoint.getItem(emailsId, itemId))?.properties.read).toBe(true);
      expect(await flagStateRowFor(itemId, "read")).toEqual({ desired_state: true, current_state: true });
    });

    tenantIt(
      "leaves a pending property untouched while converging a different, non-pending property in the same call",
      async () => {
        const { emailsId, params } = await setUpFolder();
        const ingestArgs = {
          emailsDatabaseId: params.emailsDatabaseId,
          filesDatabaseId: params.filesDatabaseId,
          folderRelationPropertyId: params.folderRelationPropertyId,
          attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
          folderItemId: params.folderItemId,
          mailboxItemId: params.mailboxItemId,
          folderUid: 1,
          messageId: "<pending-plus-converge@x>",
          envelope: {},
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "test",
          flags: [], // unread, unflagged — seeds converged sync-state rows for both properties
        };
        const { itemId } = await withTransaction(pool, (client) => ingestEmailMessage(client, ingestArgs));

        // Marked read but never confirmed by write-back — desired true, current still false.
        await chokePoint.updateItem({ databaseId: emailsId, itemId, propertiesPatch: { read: true } });
        expect(await flagStateRowFor(itemId, "read")).toEqual({ desired_state: true, current_state: false });
        expect(await flagStateRowFor(itemId, "flagged")).toEqual({ desired_state: false, current_state: false });

        await withTransaction(pool, (client) =>
          applyObservedMailMessageFlags(client, {
            emailsDatabaseId: params.emailsDatabaseId,
            messageItemId: itemId,
            flags: [IMAP_FLAGGED_FLAG], // still unread (the old value) but now flagged
          }),
        );

        const item = await chokePoint.getItem(emailsId, itemId);
        // The pending `read` write survives untouched...
        expect(item?.properties.read).toBe(true);
        expect(await flagStateRowFor(itemId, "read")).toEqual({ desired_state: true, current_state: false });
        // ...while `flagged`, which had no pending write, converges to the observation — proof
        // recordObservedMailMessageFlags ran for both properties in this one call, not just the
        // one that happened to change the item.
        expect(item?.properties.flagged).toBe(true);
        expect(await flagStateRowFor(itemId, "flagged")).toEqual({ desired_state: true, current_state: true });
      },
    );
  });

  tenantIt(
    "(d) fetchFlagsChangedSince is skipped on the initial sync, called with null without CONDSTORE, and with the stored highestmodseq with it",
    async () => {
      const { params } = await setUpFolder();
      const calls: Array<number | null> = [];

      await ingestFirstMessage(params, {
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: 42 }),
        fetchFlagsChangedSince: async (_path, sinceModSeq) => {
          calls.push(sinceModSeq);
          return [];
        },
      });
      // The very first sync of a folder never calls it: nothing has been observed as "known" yet.
      expect(calls).toEqual([]);

      const noCondstoreImap: ImapMailClient = {
        appendMessage: async () => {},
        getCapabilities: async () => new Set(),
        listFolders: async () => [{ path: "INBOX" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: 42 }),
        fetchMessagesSince: async () => [],
        fetchVanishedSince: async () => null,
        fetchAllUids: async () => [1],
        fetchFlagsChangedSince: async (_path, sinceModSeq) => {
          calls.push(sinceModSeq);
          return [];
        },
        setMessageFlag: async () => {},
        close: async () => {},
      };
      await withTransaction(pool, (client) => reconcileImapFolder(client, noCondstoreImap, params));
      expect(calls).toEqual([null]);

      const condstoreImap: ImapMailClient = { ...noCondstoreImap, getCapabilities: async () => new Set(["CONDSTORE"]) };
      await withTransaction(pool, (client) => reconcileImapFolder(client, condstoreImap, params));
      expect(calls).toEqual([null, 42]);
    },
  );
});

describe("ImapFlowMailClient.fetchFlagsChangedSince (issue #681)", () => {
  function fakeImapFlow(): ImapFlow {
    const calls: Array<{ criteria: unknown; query: unknown; options: unknown }> = [];
    return {
      calls,
      async mailboxOpen() {
        return { uidValidity: 1n, uidNext: 3, highestModseq: undefined, noModseq: true };
      },
      fetch(criteria: unknown, query: unknown, options: unknown) {
        calls.push({ criteria, query, options });
        return (async function* () {
          yield { uid: 1, flags: new Set([IMAP_SEEN_FLAG]) };
          yield { uid: 2, flags: new Set() };
        })();
      },
    } as unknown as ImapFlow;
  }

  it("(e) fetches flags for every known UID, passing changedSince only when a modseq is given", async () => {
    const raw = fakeImapFlow() as unknown as { calls: Array<{ criteria: unknown; query: unknown; options: unknown }> };
    const client = new ImapFlowMailClient(raw as unknown as ImapFlow);

    const withoutModseq = await client.fetchFlagsChangedSince("INBOX", null);
    expect(withoutModseq).toEqual([
      { uid: 1, flags: [IMAP_SEEN_FLAG] },
      { uid: 2, flags: [] },
    ]);
    expect(raw.calls[0]).toMatchObject({ criteria: "1:*", options: { uid: true } });

    await client.fetchFlagsChangedSince("INBOX", 42);
    expect(raw.calls[1]).toMatchObject({ criteria: "1:*", options: { uid: true, changedSince: 42n } });
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("queued sync status forward repair (issue #1497)", () => {
  let runtime: Pool;
  let tenantA: string;
  let tenantB: string;
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    await ensureQueueSchema(pool);
    await grantQueueSchemaPrivileges(pool);
    runtime = await createRuntimeRolePool(pool, "semprec_data");
  });
  afterEach(async () => {
    await runtime?.end();
  });

  async function enqueueSweep() {
    await runAsSystem("test sweep", () => enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP, {}));
    await runOnce({ pgPool: runtime, taskList: createCoreTaskList(runtime, new Map()) });
  }

  it("skips locked rows and never overwrites competing success or known failure", async () => {
    const success = randomUUID();
    const failed = randomUUID();
    const retry = randomUUID();
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) =>
        client.query(
          `INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, next_expected_activity_at)
       SELECT id, 'imap', 'unclassified', '2099-01-01' FROM unnest($1::uuid[]) AS id`,
          [[success, failed, retry]],
        ),
      ),
    );
    let locked!: () => void;
    let failedBeforeLock!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      locked = resolve;
      failedBeforeLock = reject;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = runInTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        await client.query("SELECT item_id FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[]) FOR UPDATE", [
          [success, failed, retry],
        ]);
        locked();
        await proceed;
        await recordImapActivity(client, { itemId: success, nextExpectedActivityAt: new Date("2099-01-01") });
        await recordSyncError(client, failed, "known failure", "reauthorization");
      }),
    );
    const observedHolder = holder.then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        failedBeforeLock(error);
        return { ok: false as const, error };
      },
    );
    const failures: unknown[] = [];
    try {
      await ready;
      await enqueueSweep();
      const pending = await pool.query<{ last_failure_kind: string | null }>(
        "SELECT last_failure_kind FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
        [[success, failed, retry]],
      );
      expect(pending.rows).toEqual([
        { last_failure_kind: null },
        { last_failure_kind: null },
        { last_failure_kind: null },
      ]);
    } catch (error) {
      failures.push(error);
    }
    release();
    const holderResult = await observedHolder;
    if (!holderResult.ok && !failures.includes(holderResult.error)) failures.push(holderResult.error);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Sweep race and holder failed");
    await enqueueSweep();
    const rows = await pool.query<{ item_id: string; last_error: string | null; last_failure_kind: string | null }>(
      "SELECT item_id, last_error, last_failure_kind FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
      [[success, failed, retry]],
    );
    const byId = new Map(rows.rows.map((row) => [row.item_id, row]));
    expect(byId.get(success)).toMatchObject({ last_error: null, last_failure_kind: null });
    expect(byId.get(failed)).toMatchObject({ last_error: "known failure", last_failure_kind: "reauthorization" });
    expect(byId.get(retry)).toMatchObject({ last_error: "unclassified", last_failure_kind: "other" });
  });

  it("runs two queued sweeps while the first holds repair row locks", async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID()).sort();
    const first = ids[0];
    if (!first) throw new Error("Missing first repair row");
    await runInTenant(tenantA, () =>
      withTransaction(runtime, (client) =>
        client.query(
          `INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, next_expected_activity_at)
       SELECT id, 'imap', 'unclassified', '2099-01-01' FROM unnest($1::uuid[]) AS id`,
          [ids],
        ),
      ),
    );
    let release!: () => void;
    let held!: (pid: number) => void;
    let rejectHeld!: (reason: unknown) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve, reject) => {
      held = resolve;
      rejectHeld = reject;
    });
    const participants: Promise<unknown>[] = [];
    const failures: unknown[] = [];
    let functionCreated = false;
    let triggerCreated = false;
    try {
      // first comes exclusively from randomUUID() and contains only hexadecimal digits and hyphens.
      await pool.query(`CREATE FUNCTION test_sync_repair_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.item_id = '${first}'::uuid THEN PERFORM pg_advisory_xact_lock(421305122); END IF; RETURN NEW; END $$`);
      functionCreated = true;
      await pool.query(`CREATE TRIGGER test_sync_repair_barrier BEFORE UPDATE ON mail_account_sync_state
        FOR EACH ROW EXECUTE FUNCTION test_sync_repair_barrier()`);
      triggerCreated = true;
      const blocker = withTransaction(pool, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (!pid) throw new Error("Missing blocker PID");
        await client.query("SELECT pg_advisory_xact_lock(421305122)");
        held(pid);
        await barrier;
      });
      participants.push(blocker);
      blocker.catch(rejectHeld);
      const blockerPid = await ready;
      const firstSweep = enqueueSweep();
      const firstObserved = firstSweep.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      participants.push(firstObserved);
      let blockedPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
           AND position('SELECT tenant_id, item_id FROM mail_account_sync_state' in query) > 0`,
          [blockerPid],
        );
        blockedPid = result.rows[0]?.pid;
        if (blockedPid) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blockedPid).toBeDefined();
      await enqueueSweep();
      const midway = await pool.query<{ count: string }>(
        "SELECT count(*) FROM mail_account_sync_state WHERE tenant_id = $1 AND last_failure_kind = 'other'",
        [tenantA],
      );
      expect(Number(midway.rows[0]?.count)).toBeGreaterThan(0);
      expect(Number(midway.rows[0]?.count)).toBeLessThanOrEqual(200);
      release();
      const firstResult = await firstObserved;
      if (!firstResult.ok) throw firstResult.error;
      const final = await pool.query<{ count: string }>(
        "SELECT count(*) FROM mail_account_sync_state WHERE tenant_id = $1 AND last_failure_kind = 'other'",
        [tenantA],
      );
      expect(Number(final.rows[0]?.count)).toBe(201);
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const result of await Promise.allSettled(participants)) {
      if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
      if (
        result.status === "fulfilled" &&
        typeof result.value === "object" &&
        result.value !== null &&
        "ok" in result.value &&
        result.value.ok === false &&
        "error" in result.value &&
        !failures.includes(result.value.error)
      )
        failures.push(result.value.error);
    }
    for (const cleanup of [
      async () => {
        if (triggerCreated) await pool.query("DROP TRIGGER test_sync_repair_barrier ON mail_account_sync_state");
      },
      async () => {
        if (functionCreated) await pool.query("DROP FUNCTION test_sync_repair_barrier()");
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Concurrent queued sweeps and cleanup failed");
  }, 15_000);

  it("keeps an earlier tenant page committed when a later tenant repair fails", async () => {
    for (const tenant of [tenantA, tenantB]) {
      await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query(
            "INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, next_expected_activity_at) VALUES ($1, 'imap', 'unclassified', '2099-01-01')",
            [randomUUID()],
          ),
        ),
      );
    }
    const failures: unknown[] = [];
    let sequenceCreated = false;
    let functionCreated = false;
    let triggerCreated = false;
    try {
      await pool.query("CREATE SEQUENCE test_sync_repair_order");
      sequenceCreated = true;
      await pool.query("GRANT USAGE ON SEQUENCE test_sync_repair_order TO semprec_data");
      await pool.query(`CREATE FUNCTION test_sync_repair_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF nextval('test_sync_repair_order') > 1 THEN RAISE EXCEPTION 'test later tenant repair failure'; END IF;
        RETURN NEW; END $$`);
      functionCreated = true;
      await pool.query(`CREATE TRIGGER test_sync_repair_failure BEFORE UPDATE ON mail_account_sync_state
        FOR EACH ROW EXECUTE FUNCTION test_sync_repair_failure()`);
      triggerCreated = true;
      await enqueueSweep();
      const rows = await pool.query<{ last_failure_kind: string | null }>(
        "SELECT last_failure_kind FROM mail_account_sync_state ORDER BY last_failure_kind NULLS FIRST",
      );
      expect(rows.rows).toEqual([{ last_failure_kind: null }, { last_failure_kind: "other" }]);
      const task = await pool.query<{ last_error: string | null }>(
        `SELECT j.last_error FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE t.identifier = $1`,
        [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP],
      );
      expect(task.rows).toHaveLength(1);
      expect(task.rows[0]?.last_error).toContain("forEachActiveTenant: 1 of 2 tenants failed");
      expect((await pool.query<{ last_value: string }>("SELECT last_value FROM test_sync_repair_order")).rows).toEqual([
        { last_value: "2" },
      ]);
    } catch (error) {
      failures.push(error);
    }
    for (const cleanup of [
      async () => {
        if (triggerCreated) await pool.query("DROP TRIGGER test_sync_repair_failure ON mail_account_sync_state");
      },
      async () => {
        if (functionCreated) await pool.query("DROP FUNCTION test_sync_repair_failure()");
      },
      async () => {
        if (sequenceCreated) await pool.query("DROP SEQUENCE test_sync_repair_order");
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Tenant repair failure test and cleanup failed");
  });

  it("repairs at most 200 per active tenant per queued sweep, preserving exclusions and state", async () => {
    for (const tenant of [tenantA, tenantB]) {
      await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          await client.query(`INSERT INTO mail_account_sync_state
          (item_id, sync_mode, last_error, next_expected_activity_at)
          SELECT gen_random_uuid(), 'imap', 'unclassified', '2099-01-01' FROM generate_series(1, 201)`);
          await client.query(`INSERT INTO mail_account_sync_state
          (item_id, sync_mode, last_error, last_activity_at, last_failure_kind, next_expected_activity_at)
          VALUES (gen_random_uuid(), 'imap', 'known', NULL, 'reauthorization', '2099-01-01'),
                 (gen_random_uuid(), 'imap', 'active', '2026-01-01', NULL, '2099-01-01'),
                 (gen_random_uuid(), 'imap', NULL, NULL, NULL, '2099-01-01')`);
        }),
      );
    }
    const before = await pool.query<{ tenant_id: string; item_id: string; state: unknown }>(
      `SELECT tenant_id, item_id, to_jsonb(s) - 'last_failure_kind' AS state FROM mail_account_sync_state s ORDER BY tenant_id, item_id`,
    );
    const itemsBefore = await pool.query<{ count: string }>("SELECT count(*) FROM items");
    const notificationsBefore = await pool.query<{ count: string }>("SELECT count(*) FROM notifications");
    await enqueueSweep();
    const counts = () =>
      pool.query<{ tenant_id: string; repaired: string; pending: string }>(
        `SELECT tenant_id, count(*) FILTER (WHERE last_error = 'unclassified' AND last_failure_kind = 'other') AS repaired,
       count(*) FILTER (WHERE last_error = 'unclassified' AND last_failure_kind IS NULL) AS pending
       FROM mail_account_sync_state GROUP BY tenant_id ORDER BY tenant_id`,
      );
    expect((await counts()).rows.map(({ repaired, pending }) => [repaired, pending])).toEqual([
      ["200", "1"],
      ["200", "1"],
    ]);
    await enqueueSweep();
    expect((await counts()).rows.map(({ repaired, pending }) => [repaired, pending])).toEqual([
      ["201", "0"],
      ["201", "0"],
    ]);
    const after = await pool.query<{ tenant_id: string; item_id: string; state: unknown }>(
      `SELECT tenant_id, item_id, to_jsonb(s) - 'last_failure_kind' AS state FROM mail_account_sync_state s ORDER BY tenant_id, item_id`,
    );
    expect(after.rows).toEqual(before.rows);
    const exclusions = await pool.query<{ last_error: string | null; last_failure_kind: string | null }>(
      "SELECT last_error, last_failure_kind FROM mail_account_sync_state WHERE last_error IS DISTINCT FROM 'unclassified' ORDER BY last_error NULLS FIRST, tenant_id",
    );
    expect(exclusions.rows).toEqual([
      { last_error: null, last_failure_kind: null },
      { last_error: null, last_failure_kind: null },
      { last_error: "active", last_failure_kind: null },
      { last_error: "active", last_failure_kind: null },
      { last_error: "known", last_failure_kind: "reauthorization" },
      { last_error: "known", last_failure_kind: "reauthorization" },
    ]);
    expect((await pool.query("SELECT count(*) FROM items")).rows).toEqual(itemsBefore.rows);
    expect((await pool.query("SELECT count(*) FROM notifications")).rows).toEqual(notificationsBefore.rows);
    await enqueueSweep();
    expect((await counts()).rows.map(({ repaired, pending }) => [repaired, pending])).toEqual([
      ["201", "0"],
      ["201", "0"],
    ]);
  });
});
