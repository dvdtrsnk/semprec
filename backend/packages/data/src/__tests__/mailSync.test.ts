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
  insertItemsWithIds,
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
import type { ClassifiedAttachment } from "../mail/attachments.js";
import { sanitizeMailHtml } from "../mail/htmlSanitize.js";
import { parseMailSearchQuery, reindexItemSearch, searchItems } from "../mail/search.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { storeCredential, getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import {
  IMAP_FULL_MESSAGES_PER_PASS,
  reconcileImapAccount,
  reconcileImapFolder,
  type ImapFetchedMessage,
  type ImapFolderRef,
  type ImapMailClient,
} from "../mail/imapReconcile.js";
import { lockMailboxSync } from "../mail/mailboxSyncGuard.js";
import { mailAccountSyncJobKey } from "../mail/mailSyncEnqueue.js";
import { reconcileGmailAccount, type GmailMailClient } from "../mail/gmailReconcile.js";
import {
  reconcileGraphAccount,
  type GraphChangedMessage,
  type GraphDeltaPage,
  type GraphMailClient,
  type GraphMessageEnvelope,
} from "../mail/graphReconcile.js";
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
  listAccountsDueForSync,
  recordImapActivity,
  recordGmailActivity,
  recordGraphActivity,
  recordSyncError,
  clearMailSyncFailure,
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
import { createImapSessionPool } from "../mail/imapSessionPool.js";
import { IMAP_FLAGGED_FLAG, IMAP_SEEN_FLAG, messageFlagProperties } from "../mail/messageFlags.js";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { listPendingImapFlagWrites, recordConfirmedMailMessageFlag } from "../mail/mailMessageFlagSyncStore.js";
import { UNGUARDED_MAIL_SYNC_PASS } from "../testSupport/mailSyncPass.js";
import { recentGmailListing } from "../testSupport/gmailListing.js";
import { backfillOfFetchedSince, fakeFetchedMessage } from "../testSupport/fakeImapMessages.js";
import type { FetchedMessage } from "../mail/providerTypes.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";

const tenantIt = (name: string, fn: () => unknown, timeout?: number) =>
  it(
    name,
    () =>
      inTenantZero(async () => {
        await fn();
      }),
    timeout,
  );

async function withTimeout<T>(signal: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const waitForMoveTestSignal = <T>(signal: Promise<T>): Promise<T> =>
  withTimeout(signal, 10_000, "Timed out waiting for owned move test signal");

/** Runs `body`, then every cleanup, and rethrows the single failure or an AggregateError of all of them. */
async function runWithCleanup(
  label: string,
  body: () => Promise<void>,
  cleanups: Array<() => Promise<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, label, { cause: failures[0] });
}

async function backendPid(client: PoolClient): Promise<number | undefined> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
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

/**
 * The Mailbox item id for ingest cases without mailbox-scoped behavior: `ingestEmailMessage` only uses it
 * as its dedup scope.
 */
const TEST_MAILBOX_ITEM_ID = randomUUID();

/** A full message's ingest input; the IMAP sync tests reach index content through the reconcile. */
type IngestInput = Extract<Parameters<typeof ingestEmailMessage>[1], { contentState: "full" }>;

function useSeededDatabase(): void {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyIdFor(databaseId: string, key: string): Promise<string> {
  const property = (await chokePoint.listProperties(databaseId)).find((p) => p.key === key);
  if (!property) throw new Error(`Property '${key}' was not seeded`);
  return property.id;
}

async function relationDefinitionIdFor(propertyId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
    [propertyId],
  );
  return rows[0]!.id;
}

async function countRows(fromWhere: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${fromWhere}`, params);
  return rows[0]!.n;
}

async function moduleIds(): Promise<MailModuleIds> {
  return {
    emailsDatabaseId: await databaseIdFor("emails"),
    filesDatabaseId: await databaseIdFor("files"),
    foldersDatabaseId: await databaseIdFor("folders"),
    mailboxesDatabaseId: await databaseIdFor("mailboxes"),
  };
}

/**
 * Returns a builder of ingest inputs into `folderItemId`, or into a fresh bare INBOX folder when none is given.
 */
async function ingestFixture(
  folderItemId?: string,
): Promise<(messageId: string, overrides?: Partial<IngestInput>) => IngestInput> {
  const emailsId = await databaseIdFor("emails");
  const filesId = await databaseIdFor("files");
  const foldersId = await databaseIdFor("folders");
  const folderRelationPropertyId = await propertyIdFor(emailsId, "folder");
  const attachmentsRelationPropertyId = await propertyIdFor(emailsId, "attachments");
  const folderId =
    folderItemId ??
    (
      await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: foldersId, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      )
    ).id;
  return (messageId, overrides = {}) => ({
    arrival: "live",
    contentState: "full",
    emailsDatabaseId: emailsId,
    filesDatabaseId: filesId,
    folderRelationPropertyId,
    attachmentsRelationPropertyId,
    folderItemId: folderId,
    mailboxItemId: TEST_MAILBOX_ITEM_ID,
    messageId,
    envelope: {},
    attachments: [],
    storage: noopStorage,
    storageKeyPrefix: "test",
    ...overrides,
  });
}

function ingest(input: IngestInput) {
  return withTransaction(pool, (client) => ingestEmailMessage(client, input));
}

async function messageMeta(itemId: string) {
  return withTransaction(pool, (client) => getMailMessageMetaByItemId(client, itemId));
}

/** A Mailbox item with one INBOX folder linked to it, as folder discovery would create. */
async function createMailboxWithInbox(name: string): Promise<{ mailboxItemId: string; inboxItemId: string }> {
  const mailboxesId = await databaseIdFor("mailboxes");
  const foldersId = await databaseIdFor("folders");
  const mailboxPropertyId = await propertyIdFor(foldersId, "mailbox");
  return withTransaction(pool, async (client) => {
    const mailbox = await createItemWithClient(client, {
      databaseId: mailboxesId,
      properties: { name, provider: "generic" },
    });
    const inbox = await createItemWithClient(
      client,
      {
        databaseId: foldersId,
        properties: { name: "INBOX", behavior: "folder", providerId: "INBOX", specialPurpose: "inbox" },
      },
      { allowedSystemKeys: ["name", "behavior", "providerId", "specialPurpose"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: mailboxPropertyId, callerItemId: inbox.id, targetItemId: mailbox.id },
      { ownerProcess: FOLDERS_MODULE_ID },
    );
    return { mailboxItemId: mailbox.id, inboxItemId: inbox.id };
  });
}

/** Account reconcile parameters for a fresh, provider-less Mailbox item. */
async function reconcileParams() {
  const ids = await moduleIds();
  const mailbox = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: ids.mailboxesDatabaseId, properties: { name: "M" } }),
  );
  return {
    mailboxItemId: mailbox.id,
    emailsDatabaseId: ids.emailsDatabaseId,
    filesDatabaseId: ids.filesDatabaseId,
    foldersDatabaseId: ids.foldersDatabaseId,
    folderRelationPropertyId: await propertyIdFor(ids.emailsDatabaseId, "folder"),
    mailboxFolderRelationPropertyId: await propertyIdFor(ids.foldersDatabaseId, "mailbox"),
    attachmentsRelationPropertyId: await propertyIdFor(ids.emailsDatabaseId, "attachments"),
    storage: noopStorage,
    storageKeyPrefix: "test",
  };
}

/** An IMAP adapter whose connect fails with a plain error: an ordinary sync failure, not a reauthorization. */
const UNEXPECTED_FAILURE = "IMAP connection failed unexpectedly";
const unexpectedlyFailing: MailSyncAdapterFactory = {
  createImapClient: async () => {
    throw new Error(UNEXPECTED_FAILURE);
  },
};

/** A Mailbox item with sync state and, unless `credential` is null, a stored app password. */
async function createSyncMailbox(
  options: {
    properties?: Record<string, unknown>;
    allowedSystemKeys?: string[];
    syncMode?: "imap" | "gmail_api" | "graph_api";
    credential?: string | null;
  } = {},
): Promise<string> {
  const { mailboxesDatabaseId } = await moduleIds();
  const mailbox = await withTransaction(pool, (client) =>
    createItemWithClient(
      client,
      { databaseId: mailboxesDatabaseId, properties: options.properties ?? { name: "M" } },
      options.allowedSystemKeys ? { allowedSystemKeys: options.allowedSystemKeys } : undefined,
    ),
  );
  await withTransaction(pool, (client) =>
    ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: options.syncMode ?? "imap" }),
  );
  const credential = options.credential === undefined ? "s3cr3t" : options.credential;
  if (credential !== null)
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: credential }),
    );
  return mailbox.id;
}

async function runSync(
  mailboxItemId: string,
  adapters: MailSyncAdapterFactory,
  storage: BlobStorageWriter = noopStorage,
  ...rest: [
    helpers?: Parameters<typeof handleSyncMailAccountTask>[5],
    random?: Parameters<typeof handleSyncMailAccountTask>[6],
  ]
): Promise<void> {
  await handleSyncMailAccountTask(pool, { mailboxItemId }, adapters, await moduleIds(), storage, ...rest);
}

function syncState(mailboxItemId: string) {
  return withTransaction(pool, (client) => getMailAccountSyncState(client, mailboxItemId));
}

async function syncStatusOf(mailboxItemId: string): Promise<unknown> {
  const { rows } = await pool.query<{ properties: { syncStatus?: unknown } }>(
    "SELECT properties FROM items WHERE id = $1",
    [mailboxItemId],
  );
  return rows[0]?.properties.syncStatus;
}

async function createOwner(): Promise<{ id: string }> {
  const passwordHash = await hashPassword("s3cret-password");
  return createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
}

const derivedBackfills = new WeakSet<object>();

/**
 * An IMAP client over an empty account; every call succeeds and returns nothing. Unless `overrides` gives its own,
 * `fetchMessagesBefore` serves the messages the client's `fetchMessagesSince` reports, so the backfill of a folder
 * established at its UIDNEXT ingests them.
 */
function fakeImap(overrides: Partial<ImapMailClient> = {}): ImapMailClient {
  const client: ImapMailClient = {
    appendMessage: async () => {},
    getCapabilities: async () => new Set(),
    listFolders: async () => [],
    selectFolder: async () => ({ uidvalidity: 1, uidnext: 1, highestModSeq: null, messages: 0 }),
    fetchMessagesSince: async () => [],
    fetchMessagesBefore: async () => [],
    fetchSnippets: async () => new Map(),
    fetchChangesSince: async () => ({ flags: [], vanished: [] }),
    fetchAllUids: async () => [],
    fetchFlagsChangedSince: async () => [],
    setMessageFlag: async () => {},
    close: async () => {},
    ...overrides,
  };
  const given: unknown = Reflect.get(overrides, "fetchMessagesBefore");
  if (typeof given !== "function" || derivedBackfills.has(given)) {
    const derived = backfillOfFetchedSince(client);
    derivedBackfills.add(derived);
    client.fetchMessagesBefore = derived;
  }
  return client;
}

/** A fetched message from a@x.com, dated now unless `extra` says otherwise, so that its content is stored in full. */
function fetched(uid: number, messageId: string, extra: Partial<FetchedMessage> = {}): ImapFetchedMessage {
  return fakeFetchedMessage(uid, {
    messageId,
    envelope: { from: { address: "a@x.com" } },
    date: new Date(),
    attachments: [],
    ...extra,
  });
}

/** An IMAP account whose folders hold `counts[path]` messages with UIDs 1..n, honouring `sinceUid` and `limit`. */
function fakeImapAccount(folders: Array<ImapFolderRef & { count: number }>): ImapMailClient {
  const countOf = (path: string) => folders.find((folder) => folder.path === path)?.count ?? 0;
  return fakeImap({
    listFolders: async () => folders.map(({ path, specialUse }) => ({ path, ...(specialUse ? { specialUse } : {}) })),
    selectFolder: async (path) => ({ uidvalidity: 7, uidnext: countOf(path) + 1, highestModSeq: null, messages: 0 }),
    fetchMessagesSince: async (path, sinceUid, limit) =>
      Array.from({ length: countOf(path) }, (_, index) => index + 1)
        .filter((uid) => uid >= sinceUid)
        .slice(0, limit)
        .map((uid) => fetched(uid, `<${path}-${uid}@x>`, { subject: `${path} ${uid}` })),
    fetchAllUids: async (path) => Array.from({ length: countOf(path) }, (_, index) => index + 1),
  });
}

/** A real ImapFlow connection that is never opened; tests stub the methods they reach. */
function unopenedImapFlow(): ImapFlow {
  return new ImapFlow({
    host: "unused.example.test",
    port: 993,
    secure: true,
    auth: { user: "unused", pass: "unused" },
    logger: false,
  });
}

function stubInboxOpen(connection: ImapFlow): void {
  vi.spyOn(connection, "search").mockResolvedValue([1]);
  vi.spyOn(connection, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 2,
    exists: 1,
  });
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function expectSafeImapFailure(error: unknown, secret = "IMAP-PRIVATE-SENTINEL"): void {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Missing IMAP provider failure");
  expect(error.message).toBe("IMAP provider operation failed unexpectedly");
  expect(error).not.toHaveProperty("cause");
  expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
}

/**
 * A minimal valid one-page PDF containing exactly `text`, with a correct xref table so pdf-parse parses
 * it via its normal path.
 */
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

function blobStorage(written: string[] = [], deleted: string[] = []): BlobStorageWriter {
  return {
    async writeStream(storageKey, source) {
      written.push(storageKey);
      let byteSize = 0;
      const hash = createHash("sha256");
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        byteSize += (chunk as Buffer).length;
      }
      return { byteSize, contentHash: hash.digest("hex") };
    },
    async delete(storageKey) {
      deleted.push(storageKey);
    },
    readStream() {
      throw new Error("readStream is not used by this test");
    },
  };
}

const noopStorage = blobStorage();

function mailRegistry() {
  const registry = createActionRegistry();
  registry.set(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, createPersonEmailReindexAction(pool));
  registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, createLinkEmailToPeopleAction(pool));
  return registry;
}

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, mailRegistry()) });
}

describe("email module seed", () => {
  useSeededDatabase();

  it("seeds Mailboxes/Folders/Emails with the expected owner:'system' schema and a user-owned People.emails", async () => {
    const keysOf = async (moduleId: string) =>
      (await chokePoint.listProperties(await databaseIdFor(moduleId))).map((p) => p.key).sort();
    expect(await keysOf("mailboxes")).toEqual([
      "addresses",
      "calendars",
      "calendarsEnabled",
      "connectionLimit",
      "folders",
      "mailEnabled",
      "name",
      "provider",
      "syncStatus",
    ]);
    expect(await keysOf("folders")).toEqual(["behavior", "emails", "mailbox", "name", "providerId", "specialPurpose"]);
    expect(await keysOf("emails")).toEqual([
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
    const propertyOf = async (moduleId: string, key: string) =>
      (await chokePoint.listProperties(await databaseIdFor(moduleId))).find((p) => p.key === key);
    expect(await propertyOf("mailboxes", "syncStatus")).toMatchObject({ owner: "system", type: "select" });
    expect(await propertyOf("emails", "sender")).toMatchObject({ owner: "system" });
    // The two triage flags are the exception: user state, written through the generic item-update path by
    // the mailbox client.
    expect(await propertyOf("emails", "read")).toMatchObject({ owner: "user", type: "checkbox" });
    expect(await propertyOf("emails", "flagged")).toMatchObject({ owner: "user", type: "checkbox" });
    expect(await propertyOf("people", "emails")).toMatchObject({ owner: "user", type: "longText" });
  });

  it("rejects a direct write to an owner:'system' Emails property through the generic create path", async () => {
    const emailsId = await databaseIdFor("emails");
    await expect(
      chokePoint.createItem({ databaseId: emailsId, properties: { name: "hi", sender: "x@example.com" } }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("person <-> email address linking", () => {
  useSeededDatabase();

  const lookup = (email: string) => withTransaction(pool, (client) => lookupPersonIdByEmail(client, email));
  const reindex = (itemId: string, emails: string[]) =>
    withTransaction(pool, (client) => reindexPersonEmails(client, itemId, emails));

  it("reindexes person_email_index from People.emails and rejects a second person claiming the same address", async () => {
    const peopleId = await databaseIdFor("people");
    const alice = await chokePoint.createItem({
      databaseId: peopleId,
      properties: { name: "Alice", emails: "alice@example.com\nalice.w@example.com" },
    });
    await reindex(alice.id, ["alice@example.com", "alice.w@example.com"]);
    expect(await lookup("ALICE@Example.com ")).toBe(alice.id);

    const bob = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Bob" } });
    expect((await reindex(bob.id, ["alice@example.com"])).conflicts).toEqual(["alice@example.com"]);
    expect(await lookup("alice@example.com")).toBe(alice.id);
  });

  it("converges differently-cased/whitespaced variants of one address onto one normalized index row", async () => {
    const alice = await chokePoint.createItem({ databaseId: await databaseIdFor("people"), properties: { name: "A" } });
    // Both variants normalize to one address: it must be claimed once (the email PRIMARY KEY rejects a
    // duplicate) and resolve identically whatever the lookup's case.
    await reindex(alice.id, ["  Alice@Example.com ", "ALICE@EXAMPLE.COM"]);
    expect(await lookup("alice@example.com")).toBe(alice.id);
    expect(await lookup("Alice@Example.com")).toBe(alice.id);
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM person_email_index WHERE item_id = $1", [
      alice.id,
    ]);
    expect(rows).toEqual([{ email: "alice@example.com" }]);
  });

  it("releases an address a person no longer claims", async () => {
    const alice = await chokePoint.createItem({ databaseId: await databaseIdFor("people"), properties: { name: "A" } });
    await reindex(alice.id, ["alice@example.com"]);
    await reindex(alice.id, []);
    expect(await lookup("alice@example.com")).toBeNull();
  });

  it.each([
    ["reindex", "mail\\.reindexPersonEmails", () => createPersonEmailReindexAction(pool)],
    ["link", "mail\\.linkPeopleByEmail", () => createLinkEmailToPeopleAction(pool)],
  ])("the %s action rejects a malformed action config and writes no index row", async (_name, id, action) => {
    const alice = await chokePoint.createItem({
      databaseId: await databaseIdFor("people"),
      properties: { name: "Alice", emails: "alice@example.com" },
    });
    const error = await rejectionOf(action()({}, { heartbeatId: "hb", projectItemId: "proj", itemId: alice.id }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`^Malformed action config for ${id}: `));
    expect(await countRows("person_email_index")).toBe(0);
  });

  it("end to end: creating a Person with an address, then ingesting a message from it, links senderPeople", async () => {
    const emailsId = await databaseIdFor("emails");
    const peopleId = await databaseIdFor("people");
    const alice = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: peopleId,
        properties: { name: "Alice", emails: "alice@example.com" },
      }),
    );
    await drainQueue(); // onItemEvent 'create' on People -> reindex action

    const { mailboxItemId, inboxItemId } = await createMailboxWithInbox("Test");
    const input = await ingestFixture(inboxItemId);
    const ingested = await inTenantZero(() =>
      ingest(
        input("<msg1@example.com>", {
          mailboxItemId,
          subject: "Hello",
          envelope: { from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "bob@example.com" }] },
          bodyText: "hi",
        }),
      ),
    );
    await drainQueue(); // onItemEvent 'create' on Emails -> link action

    expect((await chokePoint.getItem(emailsId, ingested.itemId))?.properties.name).toBe("Hello");
    const senderDefinitionId = await relationDefinitionIdFor(await propertyIdFor(emailsId, "senderPeople"));
    const { rows } = await pool.query<{ item_a: string; item_b: string }>(
      "SELECT item_a, item_b FROM item_relations WHERE relation_definition_id = $1",
      [senderDefinitionId],
    );
    expect(rows.some((r) => r.item_a === alice.id || r.item_b === alice.id)).toBe(true);
  });
});

describe("conversation threading", () => {
  useSeededDatabase();

  const resolve = (input: Parameters<typeof resolveThreadId>[1]) =>
    withTransaction(pool, (client) => resolveThreadId(client, input));
  const storeMeta = (messageId: string, threadId: string, inReplyTo: string | null = null) =>
    withTransaction(pool, async (client) => {
      const itemId = randomUUID();
      await insertItemsWithIds(client, [itemId]);
      await client.query(
        "INSERT INTO mail_message_meta (item_id, message_id, in_reply_to, thread_id, envelope, arrival, content_state) VALUES ($1, $2, $3, $4, '{}', 'live', 'full')",
        [itemId, messageId, inReplyTo, threadId],
      );
    });

  tenantIt("gives an unrelated message its own thread, and threads a reply onto its parent's", async () => {
    const parentThreadId = await resolve({ messageId: "<parent@x>" });
    expect(parentThreadId).toBeTruthy();
    await storeMeta("<parent@x>", parentThreadId);
    expect(await resolve({ messageId: "<reply@x>", inReplyTo: "<parent@x>", references: ["<parent@x>"] })).toBe(
      parentThreadId,
    );
  });

  tenantIt("self-heals: a message arriving after its reply joins the reply's thread", async () => {
    const replyThreadId = await resolve({ messageId: "<reply@x>", inReplyTo: "<late-parent@x>" });
    await storeMeta("<reply@x>", replyThreadId, "<late-parent@x>");
    expect(await resolve({ messageId: "<late-parent@x>" })).toBe(replyThreadId);
  });

  tenantIt("merging two threads deletes the losing thread's now-empty mail_threads row", async () => {
    const threadAId = await resolve({ messageId: "<a1@x>" });
    await storeMeta("<a1@x>", threadAId);
    const threadBId = await resolve({ messageId: "<b1@x>" });
    await storeMeta("<b1@x>", threadBId);
    const liveThreads = () => countRows("mail_threads WHERE id = ANY($1::uuid[])", [[threadAId, threadBId]]);
    expect(await liveThreads()).toBe(2);

    // Bridges two separate threads: both are found as ancestors, so this resolves to a merge.
    expect([threadAId, threadBId]).toContain(
      await resolve({ messageId: "<bridge@x>", references: ["<a1@x>", "<b1@x>"] }),
    );
    expect(await liveThreads()).toBe(1); // the losing thread's row is gone, not just unreferenced
  });
});

describe("message ingest dedup", () => {
  useSeededDatabase();

  tenantIt("a repeat ingest of the same Message-ID converges onto the same item instead of duplicating", async () => {
    const input = (await ingestFixture())("<dup@x>");
    const first = await ingest(input);
    const second = await ingest(input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ itemId: first.itemId, created: false });
    expect(await countRows("items WHERE database_id = $1", [input.emailsDatabaseId])).toBe(1);
  });

  tenantIt("stores is_bulk from the bulk headers and sender, and a repeat ingest leaves it unchanged", async () => {
    const input = await ingestFixture();
    const isBulk = async (itemId: string) =>
      (await pool.query<{ is_bulk: boolean }>("SELECT is_bulk FROM mail_message_meta WHERE item_id = $1", [itemId]))
        .rows[0]?.is_bulk;
    const person = { from: { address: "anna@example.com" } };
    const cases: Array<[string, Partial<IngestInput>, boolean]> = [
      ["<unsub@x>", { envelope: person, bulkHeaders: { listUnsubscribe: "<mailto:u@example.com>" } }, true],
      ["<listid@x>", { envelope: person, bulkHeaders: { listId: "<l.example.com>" } }, true],
      ["<prec@x>", { envelope: person, bulkHeaders: { precedence: "bulk" } }, true],
      ["<auto@x>", { envelope: person, bulkHeaders: { autoSubmitted: "auto-generated" } }, true],
      ["<noreply@x>", { envelope: { from: { address: "No-Reply@example.com" } } }, true],
      ["<person@x>", { envelope: person, bulkHeaders: { autoSubmitted: "no" } }, false],
    ];
    for (const [messageId, extra, expected] of cases) {
      const { itemId } = await ingest(input(messageId, extra));
      expect(await isBulk(itemId), messageId).toBe(expected);
    }

    // A later pass over an already-ingested message, even one now reporting different headers, keeps the flag.
    const again = await ingest(input("<unsub@x>", { envelope: person, bulkHeaders: { autoSubmitted: "no" } }));
    expect(again.created).toBe(false);
    expect(await isBulk(again.itemId)).toBe(true);
  });
});

describe("mail thread invalidation on ingest", () => {
  useSeededDatabase();
  let events: InvalidationEvent[];

  beforeEach(() => {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

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
    expect(await countRows("mail_message_meta WHERE message_id = '<rolled-back@x>'")).toBe(0);
  });

  tenantIt("announces nothing for a repeat ingest or a message that converged through the provider id", async () => {
    const input = await ingestFixture();
    await ingest(input("<again@x>"));
    const winner = await ingest(input("<winner@x>", { providerMessageId: "same-provider-id" }));
    events.length = 0;

    expect((await ingest(input("<again@x>"))).created).toBe(false);
    expect(await ingest(input("<loser@x>", { providerMessageId: "same-provider-id" }))).toEqual({
      itemId: winner.itemId,
      created: false,
    });
    expect(events).toEqual([]);
  });

  tenantIt("announces the shared thread once for each new message of a conversation", async () => {
    const input = await ingestFixture();

    const first = await ingest(input("<root@x>"));
    const reply = await ingest(input("<reply@x>", { inReplyTo: "<root@x>" }));

    const threadId = await threadIdOf(first.itemId);
    expect(await threadIdOf(reply.itemId)).toBe(threadId);
    expect(events).toEqual([
      { scope: "mailThread", threadId },
      { scope: "mailThread", threadId },
    ]);
  });
});

describe("per-mailbox message identity", () => {
  useSeededDatabase();

  async function setUpTwoMailboxes() {
    const emailsId = await databaseIdFor("emails");
    const folderPropertyId = await propertyIdFor(emailsId, "folder");
    const a = await createMailboxWithInbox("Work");
    const b = await createMailboxWithInbox("Private");
    const input = await ingestFixture();

    const ingestInto = (mailbox: { mailboxItemId: string; inboxItemId: string }, messageId: string) =>
      ingest(
        input(messageId, {
          folderItemId: mailbox.inboxItemId,
          mailboxItemId: mailbox.mailboxItemId,
          folderUid: 7,
          subject: "Shared",
          flags: [],
        }),
      );

    const folderDefinitionId = await relationDefinitionIdFor(folderPropertyId);
    async function folderIdsOf(emailItemId: string): Promise<string[]> {
      const { rows } = await pool.query<{ folder_id: string }>(
        `SELECT CASE WHEN item_a = $2 THEN item_b ELSE item_a END AS folder_id
         FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`,
        [folderDefinitionId, emailItemId],
      );
      return rows.map((r) => r.folder_id);
    }

    const mailboxFolderDefinitionId = await relationDefinitionIdFor(
      await propertyIdFor(await databaseIdFor("folders"), "mailbox"),
    );
    return { emailsId, a, b, ingestInto, folderIdsOf, folderDefinitionId, mailboxFolderDefinitionId };
  }

  tenantIt(
    "ingests the same Message-ID for two mailboxes as two items, each linked only to its own mailbox's folder",
    async () => {
      const { emailsId, a, b, ingestInto, folderIdsOf } = await setUpTwoMailboxes();

      const inA = await ingestInto(a, "<shared@x>");
      const inB = await ingestInto(b, "<shared@x>");

      expect([inA.created, inB.created]).toEqual([true, true]);
      expect(inB.itemId).not.toBe(inA.itemId);
      expect(await folderIdsOf(inA.itemId)).toEqual([a.inboxItemId]);
      expect(await folderIdsOf(inB.itemId)).toEqual([b.inboxItemId]);

      expect(await getMailMessageMetaByMailboxAndMessageId(pool, a.mailboxItemId, "<shared@x>")).toMatchObject({
        itemId: inA.itemId,
        mailboxItemId: a.mailboxItemId,
      });
      expect(await getMailMessageMetaByMailboxAndMessageId(pool, b.mailboxItemId, "<shared@x>")).toMatchObject({
        itemId: inB.itemId,
        mailboxItemId: b.mailboxItemId,
      });

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
    expect(second).toEqual({ itemId: first.itemId, created: false });
    expect(await folderIdsOf(first.itemId)).toEqual([a.inboxItemId]);
    expect(await countRows("items WHERE database_id = $1", [emailsId])).toBe(1);
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
});

describe("provider_message_id uniqueness convergence", () => {
  useSeededDatabase();

  const baseInput = async (messageId: string, overrides: Partial<IngestInput> = {}) =>
    (await ingestFixture())(messageId, overrides);

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
          backendPid(client).then((pid) => {
            if (pid === undefined) throw new Error("Missing participant PID");
            return pid;
          }),
        );
      });
      const winner = await withTransaction(runtimePool, (client) => ingestEmailMessage(client, winnerInput));
      let release: () => void = () => undefined;
      let reportHolder: (pid: number | undefined) => void = () => undefined;
      let reportWaiter: (pid: number | undefined) => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderStarted = new Promise<number | undefined>((resolve) => {
        reportHolder = resolve;
      });
      const waiterStarted = new Promise<number | undefined>((resolve) => {
        reportWaiter = resolve;
      });
      const bounded = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, 5000, "Savepoint overlap timed out");
      const holder = withTransaction(runtimePool, async (client) => {
        const result = await ingestEmailMessage(client, conflictInput);
        expect(result).toEqual({ itemId: winner.itemId, created: false });
        expect((await ingestEmailMessage(client, continuationInput)).created).toBe(true);
        reportHolder(await backendPid(client));
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
          reportWaiter(await backendPid(client));
          return ingestEmailMessage(client, nextInput);
        });
        const waiterSettled = waiter.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const waiterPid = await bounded(waiterStarted);
        expect(holderPid).toBeTypeOf("number");
        expect(waiterPid).toBeTypeOf("number");
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const result = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, waiterPid],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        release();
        expect(await bounded(holderSettled)).toMatchObject({ value: { itemId: winner.itemId, created: false } });
        expect(await bounded(waiterSettled)).toMatchObject({ value: { created: true } });
        expect(
          await countRows(
            "mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id)",
          ),
        ).toBe(0);
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
    "converges two concurrent inserts for distinct Message-IDs sharing one provider id onto a single stable row",
    async () => {
      const inputA = await baseInput("<race-a@x>", { providerMessageId: "provider-race-1" });
      const inputB = await baseInput("<race-b@x>", { providerMessageId: "provider-race-1" });

      const [resultA, resultB] = await Promise.all([ingest(inputA), ingest(inputB)]);

      expect(resultA.itemId).toBe(resultB.itemId);
      expect([resultA.created, resultB.created].sort()).toEqual([false, true]);
      expect(await countRows("mail_message_meta WHERE provider_message_id = $1", ["provider-race-1"])).toBe(1);
      expect(await countRows("items WHERE database_id = $1", [inputA.emailsDatabaseId])).toBe(1);
    },
  );

  it("fills a null provider_message_id via the message_id upsert's ON CONFLICT DO UPDATE", async () => {
    const itemId = randomUUID();
    const meta = {
      itemId,
      mailboxItemId: TEST_MAILBOX_ITEM_ID,
      messageId: "<fill@x>",
      envelope: {},
      arrival: "live" as const,
      contentState: "full" as const,
    };
    await withTransaction(pool, async (client) => {
      await insertItemsWithIds(client, [itemId]);
      await upsertMailMessageMeta(client, meta);
    });
    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, { ...meta, providerMessageId: "provider-fill-1" }),
    );
    expect((await getMailMessageMetaByItemId(pool, itemId))?.providerMessageId).toBe("provider-fill-1");
  });

  tenantIt("leaves a null provider_message_id message-id-only, uninvolved in the partial unique index", async () => {
    const { itemId } = await ingest(await baseInput("<nullprovider@x>"));
    expect((await getMailMessageMetaByItemId(pool, itemId))?.providerMessageId).toBeNull();
  });
});

describe("mailbox triage flags", () => {
  useSeededDatabase();

  it("maps IMAP \\Seen/\\Flagged onto the read/flagged properties, case-insensitively, and leaves both absent without flags", () => {
    expect(messageFlagProperties(["\\Seen", "\\Answered"])).toEqual({ read: true, flagged: false });
    expect(messageFlagProperties(["\\flagged"])).toEqual({ read: false, flagged: true });
    expect(messageFlagProperties([])).toEqual({ read: false, flagged: false });
    expect(messageFlagProperties(undefined)).toEqual({});
  });

  tenantIt("seeds a newly ingested message's read/flag state from the flags the server reported", async () => {
    const input = (await ingestFixture())("<flags@x>", { flags: [IMAP_SEEN_FLAG, IMAP_FLAGGED_FLAG] });
    const { itemId } = await ingest(input);
    expect((await chokePoint.getItem(input.emailsDatabaseId, itemId))?.properties).toMatchObject({
      read: true,
      flagged: true,
    });
  });

  tenantIt("does not overwrite the user's own triage state when the same message is ingested again", async () => {
    const input = (await ingestFixture())("<flags@x>", { flags: [] });
    const { itemId } = await ingest(input);
    await chokePoint.updateItem({ databaseId: input.emailsDatabaseId, itemId, propertiesPatch: { read: true } });

    await ingest(input);

    expect((await chokePoint.getItem(input.emailsDatabaseId, itemId))?.properties.read).toBe(true);
  });

  tenantIt(
    "accepts read/flagged through the generic update path while still refusing an owner:'system' field",
    async () => {
      const input = (await ingestFixture())("<flags@x>");
      const { itemId } = await ingest(input);
      const update = (propertiesPatch: Record<string, unknown>) =>
        chokePoint.updateItem({ databaseId: input.emailsDatabaseId, itemId, propertiesPatch });

      expect((await update({ read: true, flagged: true })).properties).toMatchObject({ read: true, flagged: true });
      await expect(update({ sender: "spoofed@example.com" })).rejects.toMatchObject({ name: "ForbiddenError" });
    },
  );
});

describe("attachment ingest", () => {
  useSeededDatabase();

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
      const input = (await ingestFixture())("<with-attachments@x>");
      const sameBytes = Buffer.from("invoice-bytes");
      const result = await ingest({
        ...input,
        attachments: [attachment("invoice.pdf", sameBytes), attachment("invoice-copy.pdf", sameBytes)],
      });

      const { rows: attachmentRows } = await pool.query<{ blob_id: string; byte_size: string }>(
        "SELECT blob_id, byte_size FROM mail_attachments WHERE message_item_id = $1",
        [result.itemId],
      );
      expect(attachmentRows).toHaveLength(2);
      expect(new Set(attachmentRows.map((r) => r.blob_id)).size).toBe(1); // same content hash -> one blob
      expect(attachmentRows.every((r) => Number(r.byte_size) === sameBytes.length)).toBe(true);

      const { rows: fileItemRows } = await pool.query<{ name: string }>(
        "SELECT properties->>'name' AS name FROM items WHERE database_id = $1 ORDER BY 1",
        [input.filesDatabaseId],
      );
      expect(fileItemRows.map((r) => r.name)).toEqual(["invoice-copy.pdf", "invoice.pdf"]);
      const attachmentsDefinitionId = await relationDefinitionIdFor(input.attachmentsRelationPropertyId);
      expect(await countRows("item_relations WHERE relation_definition_id = $1", [attachmentsDefinitionId])).toBe(2);
    },
  );

  tenantIt("extracts PDF attachment text at ingest and folds it into the message's own search index", async () => {
    const input = (await ingestFixture())("<with-pdf@x>", { subject: "Has a PDF" });
    // A minimal valid one-page PDF with a correct xref table: pdf-parse otherwise falls back to a lossy
    // recovery heuristic that can truncate the extracted text.
    const result = await ingest({
      ...input,
      attachments: [attachment("invoice.pdf", buildMinimalPdf("UniqueInvoiceKeyword"))],
    });

    const found = await searchItems(pool, { databaseId: input.emailsDatabaseId, query: "UniqueInvoiceKeyword" });
    expect(found.map((f) => f.itemId)).toContain(result.itemId);
  });

  tenantIt("skips an attachment that exceeds the size cap instead of failing the whole message ingest", async () => {
    const input = (await ingestFixture())("<with-oversized-attachment@x>");
    // Mirrors the real IMAP adapter: openStream() returns a lazy Readable synchronously, and the cap
    // violation surfaces as a stream error on consumption, never as a synchronous throw.
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
    try {
      const result = await ingest({
        ...input,
        attachments: [oversized, attachment("kept.pdf", Buffer.from("kept-bytes"))],
      });

      const { rows } = await pool.query<{ filename: string }>(
        "SELECT filename FROM mail_attachments WHERE message_item_id = $1",
        [result.itemId],
      );
      expect(rows.map((r) => r.filename)).toEqual(["kept.pdf"]);
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

describe("IMAP BODYSTRUCTURE walking", () => {
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
    const result = walkBodyStructure({ part: "1", type: "text/plain" });
    expect(result.textPlainPart?.type).toBe("text/plain");
    expect(result.attachmentParts).toHaveLength(0);
  });

  it("picks both alternative body leaves and keeps an inline text/calendar leaf as an attachment candidate", () => {
    const result = walkBodyStructure({
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/plain" },
        { part: "2", type: "text/html" },
        { part: "3", type: "text/calendar", disposition: "inline", parameters: { method: "REQUEST" } },
      ],
    });
    expect(result.textPlainPart?.part).toBe("1");
    expect(result.textHtmlPart?.part).toBe("2");
    expect(result.attachmentParts.map((p) => [p.part, p.type])).toEqual([["3", "text/calendar"]]);
  });
});

describe("HTML sanitization", () => {
  it.each([
    [
      "strips script tags and event handlers",
      '<p onclick="steal()">hi</p><script>evil()</script>',
      undefined,
      ["hi"],
      ["<script>", "onclick"],
    ],
    [
      "strips remote images by default but keeps inline cid: images",
      '<img src="https://tracker.example/pixel.gif"><img src="cid:logo">',
      undefined,
      ["cid:logo"],
      ["tracker.example"],
    ],
    [
      "allows remote images when explicitly requested",
      '<img src="https://example.com/photo.jpg">',
      true,
      ["https://example.com/photo.jpg"],
      [],
    ],
    [
      "strips a CSS background-image url from an inline style attribute",
      '<div style="background-image:url(https://tracker.example/pixel.gif); color: red">hi</div>',
      undefined,
      ["color:red"],
      ["tracker.example", "url("],
    ],
    [
      "rejects a url() smuggled inside an otherwise-allowed color: rgb(...) value",
      '<div style="color: rgb(0,0,0) url(https://tracker.example/pixel.gif)">hi</div>',
      undefined,
      [],
      ["tracker.example", "url("],
    ],
    [
      "still allows a plain rgb() color value",
      '<div style="color: rgb(12, 34, 56)">hi</div>',
      undefined,
      ["rgb(12, 34, 56)"],
      [],
    ],
    [
      "strips a <style> block wholesale, including any url() it carries",
      "<style>body { background: url(https://tracker.example/pixel.gif); }</style><p>hi</p>",
      undefined,
      ["hi"],
      ["tracker.example"],
    ],
  ] as const)("%s", (_name, html, allowRemoteImages, kept, stripped) => {
    const sanitized =
      allowRemoteImages === undefined ? sanitizeMailHtml(html) : sanitizeMailHtml(html, { allowRemoteImages });
    for (const fragment of kept) expect(sanitized).toContain(fragment);
    for (const fragment of stripped) expect(sanitized).not.toContain(fragment);
  });

  // A protocol-relative source names a remote host without a scheme. These are the forms the sanitizer
  // classifies as protocol-relative; entities reach it decoded.
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

describe("full-text search over Emails", () => {
  useSeededDatabase();

  async function indexedEmail(emailsId: string, text: string): Promise<string> {
    const { id } = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: emailsId, properties: {} }),
    );
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId: id, databaseId: emailsId, text }));
    return id;
  }
  const search = async (databaseId: string, query: string) =>
    (await searchItems(pool, { databaseId, query })).map((r) => r.itemId);

  it("indexes and finds a message by content", async () => {
    const emailsId = await databaseIdFor("emails");
    const itemId = await indexedEmail(emailsId, "Invoice for consulting services");
    expect(await search(emailsId, "invoice")).toContain(itemId);
    expect(await search(emailsId, "nonexistentword")).not.toContain(itemId);
  });

  it("indexes text that carries U+0000, as text extracted from a PDF can", async () => {
    const emailsId = await databaseIdFor("emails");
    const itemId = await indexedEmail(emailsId, "Contract\u0000annex\u0000");
    expect(await search(emailsId, "annex")).toContain(itemId);
  });

  it("ranks a more recently indexed match above an older one with identical text relevance", async () => {
    const emailsId = await databaseIdFor("emails");
    const olderId = await indexedEmail(emailsId, "quarterly report");
    const newerId = await indexedEmail(emailsId, "quarterly report");
    // Backdate the older row: both reindexItemSearch calls ran within the same instant, so the recency blend
    // would have nothing to distinguish.
    await pool.query(`UPDATE item_search_index SET updated_at = now() - interval '90 days' WHERE item_id = $1`, [
      olderId,
    ]);
    expect(await search(emailsId, "quarterly report")).toEqual([newerId, olderId]);
  });

  describe("Gmail-style search operators", () => {
    it.each([
      [
        "invoice from:alice@x.com has:attachment before:2026-01-01 after:2025-01-01",
        { freeText: "invoice", from: "alice@x.com", hasAttachment: true, before: "2026-01-01", after: "2025-01-01" },
      ],
      ["just some words", { freeText: "just some words" }],
      ["invoice is:unread is:unflagged", { freeText: "invoice", read: false, flagged: false }],
      ["is:read is:flagged", { freeText: "", read: true, flagged: true }],
      // Identical repeated is: operators collapse instead of conflicting.
      ["is:unread is:unread", { freeText: "", read: false }],
      ["is:flagged is:flagged", { freeText: "", flagged: true }],
      // An unrecognized is: value is left in free text rather than silently discarded.
      ["invoice is:spam", { freeText: "invoice is:spam" }],
    ])("parses %j", (query, expected) => {
      expect(parseMailSearchQuery(query)).toEqual(expected);
    });

    it.each([
      ["is:read is:unread", { field: "is:read", conflict: ["read", "unread"] }],
      ["is:flagged is:unflagged", { field: "is:flagged", conflict: ["flagged", "unflagged"] }],
    ])("rejects the contradictory %j as a validation error", (query, details) => {
      let error: unknown;
      try {
        parseMailSearchQuery(query);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual(details);
    });

    tenantIt("from: and is: operators filter on the sender and the canonical structured flags", async () => {
      const input = await ingestFixture();
      const ingestReport = async (messageId: string, from: string, flags?: string[]) =>
        (await ingest(input(messageId, { subject: "Report", envelope: { from: { address: from } }, flags }))).itemId;
      const emailsId = await databaseIdFor("emails");

      // Legacy row without flags reported at ingest: the default is unread/unflagged.
      const legacy = await ingestReport("<legacy@x>", "alice@x.com");
      const readOnly = await ingestReport("<read@x>", "alice@x.com", [IMAP_SEEN_FLAG]);
      const flaggedOnly = await ingestReport("<flagged@x>", "alice@x.com", [IMAP_FLAGGED_FLAG]);
      const both = await ingestReport("<both@x>", "alice@x.com", [IMAP_SEEN_FLAG, IMAP_FLAGGED_FLAG]);
      const fromBob = await ingestReport("<bob@x>", "bob@x.com", [IMAP_SEEN_FLAG, IMAP_FLAGGED_FLAG]);
      const sorted = (ids: string[]) => [...ids].sort();

      expect(sorted(await search(emailsId, "report from:alice@x.com"))).toEqual(
        sorted([legacy, readOnly, flaggedOnly, both]),
      );
      expect(sorted(await search(emailsId, "report is:unread"))).toEqual(sorted([flaggedOnly, legacy]));
      expect(sorted(await search(emailsId, "report is:read"))).toEqual(sorted([both, readOnly, fromBob]));
      expect(sorted(await search(emailsId, "report is:unflagged"))).toEqual(sorted([legacy, readOnly]));
      expect(sorted(await search(emailsId, "report is:flagged"))).toEqual(sorted([flaggedOnly, both, fromBob]));
      // Read and flagged dimensions compose with AND, and with an unrelated existing operator (from:).
      expect(await search(emailsId, "report is:read is:flagged from:alice@x.com")).toEqual([both]);
    });
  });
});

describe("periodic search reindex sweep", () => {
  useSeededDatabase();

  it("indexes an Emails item that was written outside ingestEmailMessage's own standard path", async () => {
    const emailsId = await databaseIdFor("emails");
    // Direct choke-point item creation, bypassing ingestEmailMessage/reindexItemSearch: the out-of-band write
    // the sweep exists for.
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: emailsId, properties: { name: "Backfilled subject", body: "UnindexedBackfillKeyword" } },
        { allowedSystemKeys: ["name", "body"] },
      ),
    );
    const found = async () =>
      (await searchItems(pool, { databaseId: emailsId, query: "UnindexedBackfillKeyword" })).map((r) => r.itemId);

    expect(await found()).not.toContain(item.id);
    await handleMailSearchReindexSweepTask(pool);
    expect(await found()).toContain(item.id);
  });
});

describe("credentials", () => {
  useSeededDatabase();

  const decrypt = (itemId: string) =>
    withTransaction(pool, (client) =>
      getDecryptedCredential(client, { itemId, actorType: "sync_worker", purpose: "imap_sync" }),
    );
  const accessLog = async (itemId: string) =>
    (await pool.query("SELECT actor_type, purpose FROM credential_access_log WHERE item_id = $1", [itemId])).rows;

  it("round-trips a stored secret and logs every decryption", async () => {
    const mailbox = await withTransaction(pool, async (client) =>
      createItemWithClient(client, { databaseId: await databaseIdFor("mailboxes"), properties: { name: "M" } }),
    );
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
    );
    expect(await decrypt(mailbox.id)).toBe("s3cr3t");
    expect(await accessLog(mailbox.id)).toEqual([{ actor_type: "sync_worker", purpose: "imap_sync" }]);
  });

  it("returns null and logs nothing when no credential is stored", async () => {
    const missingItemId = randomUUID();
    expect(await decrypt(missingItemId)).toBeNull();
    expect(await accessLog(missingItemId)).toEqual([]);
  });
});

it.each([
  ["gmail", "gmail_api"],
  ["outlook", "graph_api"],
  ["icloud", "imap"],
  ["generic", "imap"],
] as const)("defaults the sync_mode of a %s Mailbox to %s", (provider, mode) => {
  expect(defaultSyncModeForProvider(provider)).toBe(mode);
});

describe("IMAP reconcile core", () => {
  useSeededDatabase();

  const twoMessages = fakeImap({
    getCapabilities: async () => new Set(["CONDSTORE", "QRESYNC"]),
    listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
    selectFolder: async () => ({ uidvalidity: 111, uidnext: 3, highestModSeq: 5, messages: 2 }),
    fetchMessagesSince: async () => [
      fetched(1, "<one@x>", { subject: "First" }),
      fetched(2, "<two@x>", { envelope: { from: { address: "b@x.com" } }, subject: "Second" }),
    ],
    fetchAllUids: async () => [1, 2],
  });
  const reconcile = (client: ImapMailClient, params: Awaited<ReturnType<typeof reconcileParams>>) =>
    reconcileImapAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });
  const folderEdges = async (folderRelationPropertyId: string, itemId?: string) =>
    countRows(`item_relations WHERE relation_definition_id = $1 ${itemId ? "AND (item_a = $2 OR item_b = $2)" : ""}`, [
      await relationDefinitionIdFor(folderRelationPropertyId),
      ...(itemId ? [itemId] : []),
    ]);
  const emailIds = async (emailsDatabaseId: string) =>
    (await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [emailsDatabaseId])).rows.map(
      (r) => r.id,
    );

  tenantIt("initial sync ingests every fetched message and creates the INBOX folder", async () => {
    const params = await reconcileParams();
    await reconcile(twoMessages, params);

    const { rows: folderRows } = await pool.query<{ properties: { specialPurpose: string } }>(
      "SELECT properties FROM items WHERE database_id = $1",
      [params.foldersDatabaseId],
    );
    expect(folderRows.map((r) => r.properties.specialPurpose)).toEqual(["inbox"]);
    const { rows: emailRows } = await pool.query<{ name: string }>(
      "SELECT properties->>'name' AS name FROM items WHERE database_id = $1 ORDER BY 1",
      [params.emailsDatabaseId],
    );
    expect(emailRows.map((r) => r.name)).toEqual(["First", "Second"]);
  });

  tenantIt("a UIDVALIDITY change establishes the folder anew and backfills it again from its new UIDNEXT", async () => {
    const params = await reconcileParams();
    await reconcile(twoMessages, params);

    const sinceUids: number[] = [];
    const beforeUids: number[] = [];
    await reconcile(
      fakeImap({
        ...twoMessages,
        selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1, messages: 1 }),
        fetchMessagesSince: async (_path, sinceUid) => {
          sinceUids.push(sinceUid);
          return [];
        },
        fetchMessagesBefore: async (_path, beforeUid) => {
          beforeUids.push(beforeUid);
          return [];
        },
      }),
      params,
    );
    // No live fetch: every message the folder holds under the new UIDVALIDITY is the backfill's.
    expect(sinceUids).toEqual([]);
    expect(beforeUids).toEqual([2]);
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT uidvalidity::text, uidnext::text, live_from_uid::text, backfill_below_uid::text FROM mail_folder_sync_state",
    );
    expect(rows).toEqual([{ uidvalidity: "999", uidnext: "2", live_from_uid: "2", backfill_below_uid: null }]);
  });

  tenantIt(
    "re-observing the same message under a new UID after a UIDVALIDITY reset updates its edge in place",
    async () => {
      const params = await reconcileParams();
      const survivor = (uid: number) => fetched(uid, "<survivor@x>", { subject: "Survivor" });
      await reconcile(fakeImap({ ...twoMessages, fetchMessagesSince: async () => [survivor(5)] }), params);
      // Server rebuilt the folder (UIDVALIDITY changed) — the same message now has UID 1, not 5.
      await reconcile(
        fakeImap({
          ...twoMessages,
          selectFolder: async () => ({ uidvalidity: 999, uidnext: 2, highestModSeq: 1, messages: 0 }),
          fetchMessagesSince: async () => [survivor(1)],
        }),
        params,
      );

      const ids = await emailIds(params.emailsDatabaseId);
      expect(ids).toHaveLength(1);
      const { rows: edgeRows } = await pool.query<{ metadata: unknown }>(
        "SELECT metadata FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)",
        [await relationDefinitionIdFor(params.folderRelationPropertyId), ids[0]],
      );
      expect(edgeRows).toEqual([{ metadata: { uid: 1 } }]); // one edge, updated in place
    },
  );

  tenantIt("removes the folder edge for a vanished UID", async () => {
    const params = await reconcileParams();
    await reconcile(twoMessages, params);
    expect(await emailIds(params.emailsDatabaseId)).toHaveLength(2);

    await reconcile(
      fakeImap({
        ...twoMessages,
        selectFolder: async () => ({ uidvalidity: 111, uidnext: 3, highestModSeq: 6, messages: 1 }),
        fetchMessagesSince: async () => [],
        fetchChangesSince: async () => ({ flags: [], vanished: [1] }),
      }),
      params,
    );
    expect(await folderEdges(params.folderRelationPropertyId)).toBe(1); // one of the two original edges was removed
  });

  tenantIt("a backfill ingests one pass's budget, newest first, then resumes below the last ingested UID", async () => {
    const params = await reconcileParams();
    const account = fakeImapAccount([{ path: "INBOX", specialUse: "\\Inbox", count: IMAP_FULL_MESSAGES_PER_PASS + 3 }]);
    const initialSyncCompletedAt = async () =>
      (
        await pool.query<{ initial_sync_completed_at: Date | null; due: boolean }>(
          `SELECT initial_sync_completed_at, next_expected_activity_at <= now() AS due
           FROM mail_account_sync_state WHERE item_id = $1`,
          [params.mailboxItemId],
        )
      ).rows[0];

    const names = async () =>
      (
        await pool.query<{ name: string }>("SELECT properties->>'name' AS name FROM items WHERE database_id = $1", [
          params.emailsDatabaseId,
        ])
      ).rows.map((row) => row.name);

    expect(await reconcile(account, params)).toEqual({ ran: true, complete: false });
    // UIDs 4 and up, the highest ones.
    expect((await names()).sort()).toEqual(
      Array.from({ length: IMAP_FULL_MESSAGES_PER_PASS }, (_, index) => `INBOX ${index + 4}`).sort(),
    );
    expect(await initialSyncCompletedAt()).toEqual({ initial_sync_completed_at: null, due: true });

    expect(await reconcile(account, params)).toEqual({ ran: true, complete: true });
    expect(await emailIds(params.emailsDatabaseId)).toHaveLength(IMAP_FULL_MESSAGES_PER_PASS + 3);
    expect(await initialSyncCompletedAt()).toEqual({ initial_sync_completed_at: expect.any(Date), due: false });
  });

  tenantIt("a pass syncs the inbox before folders listed ahead of it", async () => {
    const params = await reconcileParams();
    const account = fakeImapAccount([
      { path: "Archive", count: IMAP_FULL_MESSAGES_PER_PASS },
      { path: "INBOX", specialUse: "\\Inbox", count: 2 },
    ]);

    expect(await reconcile(account, params)).toEqual({ ran: true, complete: false });
    const { rows } = await pool.query<{ name: string }>(
      "SELECT properties->>'name' AS name FROM items WHERE database_id = $1 AND properties->>'name' LIKE 'INBOX %' ORDER BY 1",
      [params.emailsDatabaseId],
    );
    expect(rows.map((row) => row.name)).toEqual(["INBOX 1", "INBOX 2"]);
    expect(await emailIds(params.emailsDatabaseId)).toHaveLength(IMAP_FULL_MESSAGES_PER_PASS);
  });

  tenantIt(
    "Gmail in IMAP fallback mode: derives label-folder membership from X-GM-LABELS alongside the physical All Mail edge",
    async () => {
      const params = { ...(await reconcileParams()), folderPaths: ["[Gmail]/All Mail"] };
      const labeled = (gmailLabels: string[], uidnext = 2) =>
        fakeImap({
          ...twoMessages,
          listFolders: async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
          selectFolder: async () => ({ uidvalidity: 1, uidnext, highestModSeq: null, messages: 1 }),
          fetchMessagesSince: async () => [fetched(1, "<labeled@x>", { subject: "Labeled", gmailLabels })],
          fetchAllUids: async () => [1],
        });
      await reconcile(labeled(["\\Inbox", "Work"]), params);

      const { rows: folderRows } = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE database_id = $1",
        [params.foldersDatabaseId],
      );
      // All Mail (the physical folder synced) plus the two labels.
      expect(folderRows.map((r) => r.properties.providerId).sort()).toEqual(["Work", "[Gmail]/All Mail", "\\Inbox"]);
      expect(folderRows.find((r) => r.properties.providerId === "\\Inbox")?.properties).toMatchObject({
        behavior: "label",
        specialPurpose: "inbox",
      });
      expect(folderRows.find((r) => r.properties.providerId === "Work")?.properties).toMatchObject({
        behavior: "label",
        specialPurpose: "none",
      });
      const [emailItemId] = await emailIds(params.emailsDatabaseId);
      expect(await folderEdges(params.folderRelationPropertyId, emailItemId)).toBe(3); // All Mail + \Inbox + Work

      // A second pass re-observing the message with one label dropped removes only that label's edge. The fake
      // client reports a higher UIDNEXT, so the pass searches for new UIDs, and ignores `sinceUid`, so it can
      // re-report uid 1 with a narrowed label set.
      await reconcile(labeled(["Work"], 3), params);
      expect(await folderEdges(params.folderRelationPropertyId, emailItemId)).toBe(2); // \Inbox's edge was dropped
    },
  );
});

describe("Gmail reconcile core", () => {
  useSeededDatabase();

  function fakeGmailClient(overrides: Partial<GmailMailClient> = {}): GmailMailClient {
    return {
      getCurrentHistoryId: async () => "100",
      listHistorySince: async () => ({
        invalidated: false,
        newHistoryId: "101",
        changedMessageIds: [],
        removedMessageIds: [],
      }),
      listMessageIds: recentGmailListing(["m1"]),
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
  const reconcile = (client: GmailMailClient, params: Awaited<ReturnType<typeof reconcileParams>>) =>
    inTenantZero(() => reconcileGmailAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }));

  it("initial sync lists the whole account, and a history.list 404 forces a full resync instead of resuming", async () => {
    const params = await reconcileParams();
    await reconcile(fakeGmailClient(), params);
    expect((await syncState(params.mailboxItemId))?.gmailHistoryId).toBe("100");
    expect(await countRows("items WHERE database_id = $1", [params.emailsDatabaseId])).toBe(1);

    let fullResyncCallCount = 0;
    await reconcile(
      fakeGmailClient({
        listHistorySince: async () => ({
          invalidated: true,
          newHistoryId: "100",
          changedMessageIds: [],
          removedMessageIds: [],
        }),
        listMessageIds: async (query, pageToken) => {
          fullResyncCallCount++;
          return recentGmailListing(["m2"])(query, pageToken);
        },
        getCurrentHistoryId: async () => "200",
      }),
      params,
    );
    // Both listing phases, each one page.
    expect(fullResyncCallCount).toBe(2);
    expect((await syncState(params.mailboxItemId))?.gmailHistoryId).toBe("200");
    // The first sync's message plus the resync's new one.
    expect(await countRows("items WHERE database_id = $1", [params.emailsDatabaseId])).toBe(2);
  });

  it("writes Gmail read and flagged transitions, and a matching history observation converges without an echo", async () => {
    const params = await reconcileParams();
    await reconcile(fakeGmailClient(), params);
    const emailItemId = (
      await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [params.emailsDatabaseId])
    ).rows[0]!.id;
    const writes: Array<{ id: string; add: string[]; remove: string[] }> = [];
    const writer = fakeGmailClient({
      modifyMessageLabels: async (id, add, remove) => {
        writes.push({ id, add, remove });
      },
    });
    const patch = (propertiesPatch: Record<string, boolean>) =>
      chokePoint.updateItem({ databaseId: params.emailsDatabaseId, itemId: emailItemId, propertiesPatch });

    await patch({ read: true, flagged: true });
    await reconcile(writer, params);
    expect(writes).toEqual([
      { id: "m1", add: ["STARRED"], remove: [] },
      { id: "m1", add: [], remove: ["UNREAD"] },
    ]);

    await patch({ read: false, flagged: false });
    await reconcile(writer, params);
    expect(writes.slice(2)).toEqual([
      { id: "m1", add: [], remove: ["STARRED"] },
      { id: "m1", add: ["UNREAD"], remove: [] },
    ]);

    await patch({ read: true });
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
    await reconcile(observed, params);
  });
});

describe("Graph reconcile core", () => {
  useSeededDatabase();

  // Dated now: a delta from scratch stores a message inside the full-content window in full.
  const change = (id: string, message: Partial<GraphMessageEnvelope> = {}): GraphChangedMessage => ({
    id,
    parentFolderId: "f1",
    removed: false,
    message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, date: new Date(), ...message },
  });
  const lastPage = (deltaLink: string, changes: GraphChangedMessage[]): GraphDeltaPage => ({
    changes,
    nextLink: null,
    deltaLink,
  });
  function fakeGraphClient(overrides: Partial<GraphMailClient> = {}): GraphMailClient {
    return {
      listFolders: async () => [{ id: "f1", displayName: "Inbox", wellKnownName: "inbox" }],
      fetchDeltaPage: async () => lastPage("link-1", [change("m1", { subject: "Hi" })]),
      fetchMessageContent: async () => ({ attachments: [] }),
      patchMessage: async () => {},
      ...overrides,
    };
  }
  const reconcile = (client: GraphMailClient, params: Awaited<ReturnType<typeof reconcileParams>>) =>
    reconcileGraphAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });

  tenantIt(
    "stores the returned deltaLink, and a 410 Gone clears it and runs a full resync (a round from scratch) instead of resuming",
    async () => {
      const params = await reconcileParams();
      await reconcile(fakeGraphClient(), params);
      expect((await syncState(params.mailboxItemId))?.graphDeltaLink).toBe("link-1");
      expect(await countRows("items WHERE database_id = $1", [params.emailsDatabaseId])).toBe(1);

      const deltaLinksSeen: (string | null)[] = [];
      await reconcile(
        fakeGraphClient({
          fetchDeltaPage: async (url) => {
            deltaLinksSeen.push(url);
            return url !== null ? null : lastPage("link-2", [change("m2", { subject: "Second" })]);
          },
        }),
        params,
      );
      expect(deltaLinksSeen).toEqual(["link-1", null]); // resumed from the stored link, got invalidated, retried from scratch
      expect((await syncState(params.mailboxItemId))?.graphDeltaLink).toBe("link-2");
      expect(await countRows("items WHERE database_id = $1", [params.emailsDatabaseId])).toBe(2);
    },
  );

  tenantIt(
    "keeps Graph item/reference annotations in the message body without creating placeholder Files rows on repeat reconcile",
    async () => {
      const params = await reconcileParams();
      const body = "<p>Message</p><p>[itemAttachment: meeting]</p><p>[referenceAttachment: shared document]</p>";
      const mixed = change("mixed-1", { subject: "Mixed attachments" });
      const graph = fakeGraphClient({
        fetchDeltaPage: async () => lastPage("link-mixed", [mixed]),
        fetchMessageContent: async () => ({
          bodyHtml: body,
          attachments: [
            {
              filename: "report.txt",
              contentType: "text/plain",
              contentId: null,
              disposition: "attachment",
              openStream: () => Readable.from("real file"),
            },
          ],
        }),
      });

      await reconcile(graph, params);
      await reconcile(graph, params);

      const { rows } = await pool.query<{ id: string; body: string }>(
        "SELECT id, properties->>'body' AS body FROM items WHERE database_id = $1 AND properties->>'name' = $2",
        [params.emailsDatabaseId, "Mixed attachments"],
      );
      expect(rows.map((r) => r.body)).toEqual([body]);
      expect(await countRows("items WHERE database_id = $1", [params.filesDatabaseId])).toBe(1);
      expect(await countRows("mail_attachments WHERE message_item_id = $1", [rows[0]!.id])).toBe(1);
    },
  );

  tenantIt(
    "writes Graph read and flagged transitions, and a matching delta observation converges without an echo",
    async () => {
      const params = await reconcileParams();
      await reconcile(fakeGraphClient(), params);
      const emailItemId = (
        await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [params.emailsDatabaseId])
      ).rows[0]!.id;
      const writes: Array<{ id: string; patch: object }> = [];
      const writer = fakeGraphClient({
        patchMessage: async (id, patch) => {
          writes.push({ id, patch });
        },
      });
      const patch = (propertiesPatch: Record<string, boolean>) =>
        chokePoint.updateItem({ databaseId: params.emailsDatabaseId, itemId: emailItemId, propertiesPatch });

      await patch({ read: true, flagged: true });
      await reconcile(writer, params);
      expect(writes).toEqual([
        { id: "m1", patch: { flag: { flagStatus: "flagged" } } },
        { id: "m1", patch: { isRead: true } },
      ]);

      await patch({ read: false, flagged: false });
      await reconcile(writer, params);
      expect(writes.slice(2)).toEqual([
        { id: "m1", patch: { flag: { flagStatus: "notFlagged" } } },
        { id: "m1", patch: { isRead: false } },
      ]);

      await patch({ read: true });
      const observed = fakeGraphClient({
        fetchDeltaPage: async () => lastPage("link-2", [change("m1", { envelope: {}, flags: [IMAP_SEEN_FLAG] })]),
        patchMessage: async () => {
          throw new Error("converged Graph observation must not echo");
        },
      });
      await reconcile(observed, params);
    },
  );
});

describe("message arrival: live and backfill", () => {
  useSeededDatabase();

  /** Older than any `connected_at` a pass in this suite sets, less the one-day grace. */
  const OLD_DATE = new Date("2001-01-01T00:00:00.000Z");

  async function arrivals(mailboxItemId: string): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ message_id: string; arrival: string }>(
      "SELECT message_id, arrival FROM mail_message_meta WHERE mailbox_item_id = $1 ORDER BY message_id",
      [mailboxItemId],
    );
    return Object.fromEntries(rows.map((row) => [row.message_id, row.arrival]));
  }

  async function liveFromUidOf(mailboxItemId: string): Promise<string | null> {
    const { rows } = await pool.query<{ live_from_uid: string | null }>(
      `SELECT s.live_from_uid FROM mail_folder_sync_state s
         JOIN items f ON f.id = s.item_id
        WHERE f.properties->>'providerId' = 'INBOX'
          AND EXISTS (SELECT 1 FROM item_relations r
                       WHERE (r.item_a = f.id AND r.item_b = $1) OR (r.item_b = f.id AND r.item_a = $1))`,
      [mailboxItemId],
    );
    return rows[0]?.live_from_uid ?? null;
  }

  function rawMessage(messageId: string, date: Date): Buffer {
    return Buffer.from(
      [
        `Message-ID: ${messageId}`,
        "From: Sender <sender@example.test>",
        "To: owner@example.test",
        `Subject: ${messageId}`,
        `Date: ${date.toUTCString()}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "",
      ].join("\r\n"),
    );
  }

  const reconcileImap = async (client: ImapMailClient, params: Awaited<ReturnType<typeof reconcileParams>>) =>
    reconcileImapAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });

  tenantIt(
    "IMAP: the initial backfill is backfill over every pass it takes; a delivery after the first pass is live unless its Date is old",
    async () => {
      const params = await reconcileParams();
      const account = new FakeImapAccount([{ path: "INBOX", specialUse: "\\Inbox" }]);
      const history = Array.from({ length: IMAP_FULL_MESSAGES_PER_PASS + 2 }, (_, index) => `<history-${index}@x>`);
      for (const messageId of history) account.deliver("INBOX", rawMessage(messageId, new Date()));

      expect(await reconcileImap(account.client(), params)).toEqual({ ran: true, complete: false });
      expect(await liveFromUidOf(params.mailboxItemId)).toBe(String(history.length + 1));
      expect((await syncState(params.mailboxItemId))?.connectedAt).not.toBeNull();

      account.deliver("INBOX", rawMessage("<new@x>", new Date()));
      account.deliver("INBOX", rawMessage("<moved-in-old@x>", OLD_DATE));
      expect(await reconcileImap(account.client(), params)).toEqual({ ran: true, complete: true });

      expect(await arrivals(params.mailboxItemId)).toEqual({
        ...Object.fromEntries(history.map((messageId) => [messageId, "backfill"])),
        "<new@x>": "live",
        "<moved-in-old@x>": "backfill",
      });
      expect(await liveFromUidOf(params.mailboxItemId)).toBe(String(history.length + 1));
    },
  );

  tenantIt(
    "IMAP: a UIDVALIDITY reset makes the folder's mail backfill and keeps the arrival of mail already ingested",
    async () => {
      const params = await reconcileParams();
      const folder = (uidvalidity: number, uidnext: number, messages: Array<[number, string]>) =>
        fakeImap({
          listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
          selectFolder: async () => ({ uidvalidity, uidnext, highestModSeq: null, messages: messages.length }),
          fetchMessagesSince: async (_path, sinceUid) =>
            messages.filter(([uid]) => uid >= sinceUid).map(([uid, messageId]) => fetched(uid, messageId)),
          fetchAllUids: async () => messages.map(([uid]) => uid),
        });

      await reconcileImap(
        folder(111, 3, [
          [1, "<one@x>"],
          [2, "<two@x>"],
        ]),
        params,
      );
      await reconcileImap(
        folder(111, 4, [
          [1, "<one@x>"],
          [2, "<two@x>"],
          [3, "<three@x>"],
        ]),
        params,
      );
      expect(await arrivals(params.mailboxItemId)).toEqual({
        "<one@x>": "backfill",
        "<three@x>": "live",
        "<two@x>": "backfill",
      });

      // The server rebuilt the folder: every message has a new UID, and one it never reported before is among them.
      await reconcileImap(
        folder(999, 5, [
          [1, "<one@x>"],
          [2, "<two@x>"],
          [3, "<three@x>"],
          [4, "<four@x>"],
        ]),
        params,
      );
      expect(await arrivals(params.mailboxItemId)).toEqual({
        "<four@x>": "backfill",
        "<one@x>": "backfill",
        "<three@x>": "live",
        "<two@x>": "backfill",
      });
      expect(await liveFromUidOf(params.mailboxItemId)).toBe("5");

      await reconcileImap(
        folder(999, 6, [
          [1, "<one@x>"],
          [2, "<two@x>"],
          [3, "<three@x>"],
          [4, "<four@x>"],
          [5, "<five@x>"],
        ]),
        params,
      );
      expect((await arrivals(params.mailboxItemId))["<five@x>"]).toBe("live");
    },
  );

  tenantIt(
    "Gmail: the full listing is backfill, a message reached through history.list is live, and a resync after invalidation is backfill",
    async () => {
      const params = await reconcileParams();
      const dates: Record<string, Date> = { "old-in-history": OLD_DATE };
      const gmail = (sync: Pick<GmailMailClient, "listHistorySince" | "listMessageIds">): GmailMailClient => ({
        getCurrentHistoryId: async () => "100",
        fetchMessage: async (id) => ({
          id,
          threadId: `thread-${id}`,
          labelIds: ["INBOX"],
          message: {
            messageId: `<${id}@x>`,
            envelope: { from: { address: "a@x.com" } },
            attachments: [],
            date: dates[id] ?? new Date(),
          },
        }),
        listLabels: async () => [{ id: "INBOX", name: "INBOX", type: "system" }],
        modifyMessageLabels: async () => {},
        ...sync,
      });
      const history = (changedMessageIds: string[], invalidated = false) => ({
        listHistorySince: async () => ({ invalidated, newHistoryId: "101", changedMessageIds, removedMessageIds: [] }),
      });
      const reconcile = (client: GmailMailClient) =>
        reconcileGmailAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });

      await reconcile(gmail({ ...history([]), listMessageIds: recentGmailListing(["listed"]) }));
      const connectedAt = (await syncState(params.mailboxItemId))?.connectedAt;
      expect(connectedAt).not.toBeNull();
      await reconcile(
        gmail({
          ...history(["listed", "delivered", "old-in-history"]),
          listMessageIds: async () => {
            throw new Error("a pass with a valid history id must not list every message");
          },
        }),
      );
      await reconcile(gmail({ ...history([], true), listMessageIds: recentGmailListing(["listed", "resynced"]) }));

      expect(await arrivals(params.mailboxItemId)).toEqual({
        "<delivered@x>": "live",
        "<listed@x>": "backfill",
        "<old-in-history@x>": "backfill",
        "<resynced@x>": "backfill",
      });
      expect((await syncState(params.mailboxItemId))?.connectedAt).toBe(connectedAt);
    },
  );

  tenantIt(
    "Graph: a delta from scratch is backfill, a delta from the stored link is live, and the resync after a 410 is backfill",
    async () => {
      const params = await reconcileParams();
      const change = (id: string, date: Date = new Date()): GraphChangedMessage => ({
        id,
        parentFolderId: "f1",
        removed: false,
        message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, date },
      });
      const graph = (fetchDeltaPage: GraphMailClient["fetchDeltaPage"]): GraphMailClient => ({
        listFolders: async () => [{ id: "f1", displayName: "Inbox", wellKnownName: "inbox" }],
        fetchDeltaPage,
        fetchMessageContent: async () => ({ attachments: [] }),
        patchMessage: async () => {},
      });
      const reconcile = (client: GraphMailClient) =>
        reconcileGraphAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });
      const lastPage = (deltaLink: string, changes: GraphChangedMessage[]): GraphDeltaPage => ({
        changes,
        nextLink: null,
        deltaLink,
      });

      await reconcile(graph(async () => lastPage("link-1", [change("scratch")])));
      await reconcile(
        graph(async (url) => {
          expect(url).toBe("link-1");
          return lastPage("link-2", [change("delivered"), change("old-in-delta", OLD_DATE)]);
        }),
      );
      await reconcile(graph(async (url) => (url === null ? lastPage("link-3", [change("resynced")]) : null)));

      expect(await arrivals(params.mailboxItemId)).toEqual({
        "<delivered@x>": "live",
        "<old-in-delta@x>": "backfill",
        "<resynced@x>": "backfill",
        "<scratch@x>": "backfill",
      });
    },
  );
});

describe("mail sync job error handling", () => {
  afterEach(() => vi.restoreAllMocks());
  useSeededDatabase();

  async function rethrowRejected(settlement: Promise<PromiseSettledResult<unknown>[]> | undefined): Promise<void> {
    for (const result of (await settlement) ?? []) if (result.status === "rejected") throw result.reason;
  }
  /** A Gmail REST transport that observes the message in INBOX, then acknowledges the label change. */
  const gmailMoveFetch = (): typeof fetch =>
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: ["INBOX"] }))
      .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: [] }));

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
      const overlaps =
        scenario === "inserted-after-baseline" ||
        scenario === "competing-completion" ||
        scenario === "competing-in-flight";
      const pendingMoves = (mailbox: string) => withTransaction(runtime, (client) => listPendingMoves(client, mailbox));
      const gmailRest = (request: typeof fetch) => new GmailRestClient(async () => "fake-token", request);
      await runWithCleanup(
        "Gmail move test and cleanup failed",
        async () => {
          const ids = await moduleIds();
          const fixture = await withTransaction(runtime, async (client) => {
            const mailbox = await createItemWithClient(client, {
              databaseId: ids.mailboxesDatabaseId,
              properties: { name: "Mailbox" },
            });
            const message = await createItemWithClient(
              client,
              { databaseId: ids.emailsDatabaseId, properties: { name: "Message" } },
              { allowedSystemKeys: ["name"] },
            );
            await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
            await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "fake" });
            await upsertMailMessageMeta(client, {
              arrival: "live",
              contentState: "full",
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
            const fetchProvider = gmailMoveFetch();
            await drainGmailMoves(runtime, fixture.mailbox, gmailRest(fetchProvider));
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
            listMessageIds: recentGmailListing(["fake-provider-id"]),
            fetchMessage: async () => ({
              id: "fake-provider-id",
              threadId: "fake-thread",
              labelIds: ["INBOX"],
              message: {
                messageId: "<move-job@example.test>",
                envelope: {},
                attachments: [],
                flags: [IMAP_SEEN_FLAG],
              },
            }),
            listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
            modifyMessageLabels: async () => {},
          };
          registerGmailMovePreparer(gmail, async () => async () => {
            calls.push("move");
            await assertNoTransaction();
            const state = await pendingMoves(fixture.mailbox);
            expect(state[0]).toMatchObject({ operation_phase: "in_flight", operation_step: "modify_labels" });
            return { kind: "acknowledged", inTrash: false, inInbox: false, inSent: false };
          });
          const gate = overlaps ? holdMoveBaseline(runtime) : undefined;
          if (gate) releaseBaseline = gate.release;
          const job = handleSyncMailAccountTask(
            runtime,
            { mailboxItemId: fixture.mailbox },
            { createGmailClient: () => gmail },
            ids,
            noopStorage,
          );
          jobSettlement = Promise.allSettled([job]);
          if (gate) {
            try {
              const baselinePid = await waitForMoveTestSignal(gate.reached);
              const insertPid = await withTransaction(runtime, async (client) => {
                const pid = await backendPid(client);
                await recordDesiredMailMessageMove(client, {
                  messageItemId: fixture.message,
                  mailboxItemId: fixture.mailbox,
                  desiredPurpose: "archive",
                  source: { provider: "gmail", providerMessageId: "fake-provider-id" },
                });
                return pid;
              });
              expect(insertPid).toBeTypeOf("number");
              expect(insertPid).not.toBe(baselinePid);
              if (scenario === "competing-completion") {
                const fetchProvider = gmailMoveFetch();
                await drainGmailMoves(runtime, fixture.mailbox, gmailRest(fetchProvider));
                expect(fetchProvider).toHaveBeenCalledTimes(2);
                expect(await pendingMoves(fixture.mailbox)).toEqual([]);
              }
              if (scenario === "competing-in-flight") {
                let dispatchReady!: () => void;
                const dispatched = new Promise<void>((resolve) => {
                  dispatchReady = resolve;
                });
                const ownerGate = new Promise<void>((resolve) => {
                  releaseOwner = resolve;
                });
                const fetchProvider: typeof fetch = vi
                  .fn()
                  .mockResolvedValueOnce(Response.json({ id: "fake-provider-id", labelIds: ["INBOX"] }))
                  .mockImplementationOnce(async () => {
                    const state = await withTransaction(runtime, async (client) => ({
                      pid: await backendPid(client),
                      rows: await listPendingMoves(client, fixture.mailbox),
                    }));
                    expect(state.rows).toMatchObject([{ operation_phase: "in_flight" }]);
                    ownerToken = state.rows[0]?.operation_token;
                    expect(ownerToken).toBeTypeOf("string");
                    expect(state.pid).toBeTypeOf("number");
                    dispatchReady();
                    await waitForMoveTestSignal(ownerGate);
                    return Response.json({ id: "fake-provider-id", labelIds: [] });
                  });
                owner = drainGmailMoves(runtime, fixture.mailbox, gmailRest(fetchProvider));
                ownerSettlement = Promise.allSettled([owner]);
                await waitForMoveTestSignal(dispatched);
                expect(await pendingMoves(fixture.mailbox)).toMatchObject([{ operation_phase: "in_flight" }]);
              }
            } finally {
              releaseBaseline();
            }
          }
          await waitForMoveTestSignal(job);
          const skippedMove =
            scenario === "competing-completion" ||
            scenario === "completed-before-baseline" ||
            scenario === "competing-in-flight";
          expect(calls).toEqual(skippedMove ? ["reconcile"] : ["observe", "move", "reconcile"]);
          if (scenario === "competing-in-flight") {
            expect(await pendingMoves(fixture.mailbox)).toMatchObject([
              { operation_phase: "in_flight", operation_token: ownerToken },
            ]);
          } else expect(await pendingMoves(fixture.mailbox)).toEqual([]);
          const observed = await withTransaction(runtime, async (client) => ({
            inboxEdges: (
              await client.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM item_relations edge JOIN items folder ON
               (folder.id = edge.item_a OR folder.id = edge.item_b)
               WHERE (edge.item_a = $1 OR edge.item_b = $1) AND folder.properties ->> 'providerId' = 'INBOX'`,
                [fixture.message],
              )
            ).rows[0]?.count,
            read: (
              await client.query<{ read: string | null }>(
                "SELECT properties ->> 'read' AS read FROM items WHERE id = $1",
                [fixture.message],
              )
            ).rows[0]?.read,
            meta: await getMailMessageMetaByItemId(client, fixture.message),
          }));
          expect(observed.inboxEdges).toBe(scenario === "completed-before-baseline" ? "1" : "0");
          if (scenario === "completed-before-baseline") expect(observed.read).toBe("true");
          else expect(observed.read).not.toBe("true");
          expect(observed.meta?.providerMessageId).toBe("fake-provider-id");
          if (owner) {
            releaseOwner();
            await waitForMoveTestSignal(owner);
            expect(await pendingMoves(fixture.mailbox)).toEqual([]);
          }
        },
        [
          async () => {
            releaseBaseline();
            releaseOwner();
          },
          () => rethrowRejected(ownerSettlement),
          () => rethrowRejected(jobSettlement),
          () => runtime.end(),
        ],
      );
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
        const pendingMoves = (mailbox: string) =>
          withTransaction(runtime, (client) => listPendingMoves(client, mailbox));
        await runWithCleanup(
          "Move matrix and cleanup failed",
          async () => {
            const ids = await moduleIds();
            const f = await withTransaction(runtime, async (client) => {
              const emailFolder = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
              const mailboxFolder = await getPropertyByKey(client, ids.foldersDatabaseId, "mailbox");
              if (!emailFolder || !mailboxFolder) throw new Error("Missing mail relations");
              const mailbox = await createItemWithClient(client, {
                databaseId: ids.mailboxesDatabaseId,
                properties: { name: "Mailbox" },
              });
              const message = await createItemWithClient(
                client,
                { databaseId: ids.emailsDatabaseId, properties: { name: "Message" } },
                { allowedSystemKeys: ["name"] },
              );
              await ensureMailAccountSyncState(client, {
                itemId: mailbox.id,
                syncMode: provider === "graph" ? "graph_api" : "imap",
              });
              await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "fake" });
              await upsertMailMessageMeta(client, {
                arrival: "live",
                contentState: "full",
                itemId: message.id,
                mailboxItemId: mailbox.id,
                messageId: "<baseline@example.test>",
                ...(provider === "graph" ? { providerMessageId: "old-id" } : {}),
                envelope: {},
              });
              const folder = async (path: string, specialPurpose: string, validity: string) => {
                const id = await ensureFolderItem(client, {
                  foldersDatabaseId: ids.foldersDatabaseId,
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
                    liveFromUid: path === "Source" ? "1" : "50",
                    backfillBelowUid: null,
                    highestmodseq: null,
                    messageCount: "0",
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
                const pid = await backendPid(client);
                await recordDesiredMailMessageMove(client, {
                  messageItemId: f.message,
                  mailboxItemId: f.mailbox,
                  desiredPurpose: "archive",
                  source:
                    provider === "graph"
                      ? { provider: "graph", providerMessageId: "old-id" }
                      : { provider: "imap", folderItemId: f.source, path: "Source", uid: 7, uidValidity: "11" },
                });
                const edge = (targetItemId: string) => ({
                  relationPropertyId: f.folderProperty,
                  callerItemId: f.message,
                  targetItemId,
                });
                await deleteRelationWithClient(client, edge(f.source), EMAILS_RELATION_CONTEXT);
                await createRelationWithClient(client, edge(f.target), EMAILS_RELATION_CONTEXT);
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
                pid: await backendPid(client),
                rows: await listPendingMoves(client, f.mailbox),
              }));
              expect(state.rows).toMatchObject([{ operation_phase: "in_flight" }]);
              ownerToken = state.rows[0]?.operation_token;
              expect(ownerToken).toBeTypeOf("string");
              expect(state.pid).toBeTypeOf("number");
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
                  ids.foldersDatabaseId,
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
                fetchMessagesBefore: unexpected,
                fetchSnippets: unexpected,
                fetchChangesSince: unexpected,
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
                ids.foldersDatabaseId,
                f.mailboxProperty,
                f.folderProperty,
              );
            };
            if (scenario === "completed-before-baseline") {
              await recordIntent();
              await runOwner();
            }
            const observedMessage = {
              messageId: "<baseline@example.test>",
              envelope: {},
              attachments: [],
              flags: [IMAP_SEEN_FLAG],
            };
            const graph: GraphMailClient = {
              observeMoveMessage: async () => ({ kind: "found", id: "old-id", parentFolderId: "Source" }),
              listFolders: async () => [
                { id: "Source", displayName: "Source", wellKnownName: "inbox" },
                { id: "Destination", displayName: "Destination", wellKnownName: "archive" },
              ],
              fetchDeltaPage: async () => ({
                changes: [{ id: "old-id", parentFolderId: "Source", removed: false, message: observedMessage }],
                nextLink: null,
                deltaLink: "delta",
              }),
              fetchMessageContent: async () => ({ attachments: [] }),
              patchMessage: async () => {
                throw new Error("Unexpected Graph flag mutation");
              },
            };
            registerGraphMovePreparer(graph, async () => async () => {
              throw new Error("Duplicate Graph move dispatch");
            });
            const imap = fakeImap({
              listFolders: async () => [
                { path: "Source", specialUse: "\\Inbox" },
                { path: "Destination", specialUse: "\\Archive" },
              ],
              selectFolder: async (path) => ({
                uidvalidity: path === "Source" ? 11 : 12,
                uidnext: 50,
                highestModSeq: null,
                messages: 0,
              }),
              fetchMessagesSince: async (path) =>
                path === "Source" ? [fakeFetchedMessage(7, { ...observedMessage, date: new Date() })] : [],
              fetchChangesSince: async () => null,
              fetchAllUids: async () => [7, 27],
              setMessageFlag: async () => {
                throw new Error("Unexpected IMAP flag mutation");
              },
            });
            const gate = scenario === "completed-before-baseline" ? undefined : holdMoveBaseline(runtime);
            if (gate) releaseBaseline = gate.release;
            const job = handleSyncMailAccountTask(
              runtime,
              { mailboxItemId: f.mailbox },
              { createGraphClient: () => graph, createImapClient: async () => imap },
              ids,
              noopStorage,
            );
            jobSettlement = Promise.allSettled([job]);
            if (gate) {
              try {
                const baselinePid = await waitForMoveTestSignal(gate.reached);
                const intentPid = await recordIntent();
                expect(intentPid).toBeTypeOf("number");
                expect(intentPid).not.toBe(baselinePid);
                owner = runOwner();
                ownerSettlement = Promise.allSettled([owner]);
                await waitForMoveTestSignal(dispatched);
                if (scenario === "competing-completion") await waitForMoveTestSignal(owner);
              } finally {
                releaseBaseline();
              }
            }
            await waitForMoveTestSignal(job);
            const rows = await pendingMoves(f.mailbox);
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
            const hasEdgeTo = (folderId: string) => observed.edges.some((edge) => edge.folder_id === folderId);
            if (scenario === "completed-before-baseline") {
              expect(observed.item?.read).toBe("true");
              expect(hasEdgeTo(f.source)).toBe(true);
            } else {
              expect(observed.item?.read).not.toBe("true");
              expect(hasEdgeTo(f.source)).toBe(false);
              expect(hasEdgeTo(f.target)).toBe(true);
            }
            if (provider === "graph")
              expect(observed.meta?.providerMessageId).toBe(scenario === "competing-in-flight" ? "old-id" : "new-id");
            if (provider === "imap" && scenario === "competing-completion")
              expect(observed.edges.find((edge) => edge.folder_id === f.target)?.uid).toBe("27");
            const foreign = await createTestTenant(pool);
            const foreignView = await withTenantTransaction(runtime, foreign, async (client) => ({
              meta: await getMailMessageMetaByItemId(client, f.message),
              moves: await listPendingMoves(client, f.mailbox),
            }));
            expect(foreignView).toEqual({ meta: null, moves: [] });
            if (owner) {
              releaseOwner();
              await waitForMoveTestSignal(owner);
              expect(await pendingMoves(f.mailbox)).toEqual([]);
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
                validity: (
                  await client.query<{ uidvalidity: string | null }>(
                    "SELECT uidvalidity FROM mail_folder_sync_state WHERE item_id = $1",
                    [f.target],
                  )
                ).rows[0]?.uidvalidity,
              }));
              if (provider === "graph") expect(final.meta?.providerMessageId).toBe("new-id");
              else {
                expect(final.edge).toEqual([{ uid: "27" }]);
                expect(final.validity).toBe("12");
              }
            }
            expect(dispatchCount).toBe(1);
          },
          [
            async () => {
              releaseBaseline();
              releaseOwner();
            },
            () => rethrowRejected(ownerSettlement),
            () => rethrowRejected(jobSettlement),
            () => runtime.end(),
          ],
        );
      });

  tenantIt(
    "persists last_error, pushes out next_expected_activity_at and sets syncStatus 'error' when a sync pass throws",
    async () => {
      const mailbox = await createSyncMailbox();
      const failingImap = fakeImap({
        listFolders: async () => {
          throw new Error("connection refused");
        },
      });

      await expect(runSync(mailbox, { createImapClient: async () => failingImap })).rejects.toThrow(
        "connection refused",
      );

      // Survives the aborted transaction's rollback.
      const state = await syncState(mailbox);
      expect(state?.lastError).toBe("connection refused");
      expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now());
      // The credential access attempt itself is still logged, even though the sync that used it failed later.
      const { rows } = await pool.query<{ purpose: string }>(
        "SELECT purpose FROM credential_access_log WHERE item_id = $1",
        [mailbox],
      );
      expect(rows).toEqual([{ purpose: "imap_sync" }]);
      // The user-visible Mailbox.syncStatus (distinct from mail_account_sync_state) also reflects the failure.
      expect(await syncStatusOf(mailbox)).toBe("error");
    },
  );

  /** One fetched message with one attachment named `filename`. */
  const withAttachment = (uid: number, messageId: string, filename: string) =>
    fetched(uid, messageId, {
      subject: "Has attachment",
      attachments: [
        {
          filename,
          contentType: "text/plain",
          contentId: null,
          disposition: "attachment",
          openStream: () => Readable.from(Buffer.from(`${filename}-bytes`)),
        },
      ],
    });

  tenantIt("a provider failure after the messages were fetched writes no Email and no attachment bytes", async () => {
    const mailbox = await createSyncMailbox();
    const writtenKeys: string[] = [];
    const deletedKeys: string[] = [];
    const trackingStorage = blobStorage(writtenKeys, deletedKeys);
    const inbox = { listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }] };

    // A new folder's first reconcile pass never calls fetchChangesSince/fetchAllUids (nothing to diff
    // against), so a first pass establishes uidvalidity/uidnext and the second reaches the vanished-UID check.
    await runSync(
      mailbox,
      { createImapClient: async () => fakeImap({ ...inbox, fetchChangesSince: async () => null }) },
      trackingStorage,
    );

    const failingAfterFetch = fakeImap({
      ...inbox,
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null, messages: 0 }),
      fetchMessagesSince: async () => [withAttachment(1, "<orphan@x>", "f.txt")],
      // No QRESYNC and a known uidvalidity: the non-CONDSTORE fallback, which diffs via fetchAllUids.
      fetchChangesSince: async () => null,
      fetchAllUids: async () => {
        throw new Error("boom after the messages were fetched");
      },
    });
    await expect(
      runSync(mailbox, { createImapClient: async () => failingAfterFetch }, trackingStorage),
    ).rejects.toThrow("boom after the messages were fetched");

    expect(writtenKeys).toEqual([]);
    expect(await countRows("items WHERE database_id = $1", [await databaseIdFor("emails")])).toBe(0);
  });

  tenantIt(
    "a batch whose transaction fails deletes the attachment bytes it wrote and keeps an earlier committed batch's",
    async () => {
      const mailbox = await createSyncMailbox();
      const writtenKeys: string[] = [];
      const deletedKeys: string[] = [];
      const recording = blobStorage(writtenKeys, deletedKeys);
      const failingStorage: BlobStorageWriter = {
        ...recording,
        async writeStream(storageKey, source) {
          const result = await recording.writeStream(storageKey, source);
          if (storageKey.endsWith("fails.txt")) throw new Error("disk full while writing the second batch");
          return result;
        },
      };
      const imap = fakeImap({
        listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Archive" }],
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null, messages: 1 }),
        fetchMessagesSince: async (path) =>
          path === "INBOX"
            ? [withAttachment(1, "<kept@x>", "kept.txt")]
            : [withAttachment(1, "<failed@x>", "fails.txt")],
      });

      await expect(runSync(mailbox, { createImapClient: async () => imap }, failingStorage)).rejects.toThrow(
        "disk full while writing the second batch",
      );

      expect(writtenKeys).toHaveLength(2);
      const [keptKey, failedKey] = writtenKeys;
      expect(keptKey).toMatch(/kept\.txt$/);
      expect(deletedKeys).toEqual([failedKey]);
      const { rows } = await pool.query<{ name: string }>(
        "SELECT properties->>'name' AS name FROM items WHERE database_id = $1",
        [await databaseIdFor("emails")],
      );
      expect(rows).toEqual([{ name: "Has attachment" }]);
    },
  );

  tenantIt("sets Mailbox.syncStatus to 'ok' after a completed sync pass", async () => {
    const mailbox = await createSyncMailbox();
    await runSync(mailbox, { createImapClient: async () => fakeImap() });
    expect(await syncStatusOf(mailbox)).toBe("ok");
  });

  it.each(["list", "select", "fetch", "download"] as const)(
    "sanitizes a secret-bearing IMAP %s library failure at the client boundary",
    async (stage) => {
      const connection = unopenedImapFlow();
      const secret = "IMAP-PRIVATE-SENTINEL";
      const original = Object.assign(new Error(secret), { name: secret, code: secret });
      stubInboxOpen(connection);
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
            : client.fetchMessagesSince("INBOX", 1, 10).then(([message]) => message?.fetchContent());
      expectSafeImapFailure(await rejectionOf(work), secret);
    },
  );

  it.each([
    ["undefined", undefined],
    ["object", { secret: "IMAP-PRIVATE-SENTINEL" }],
    ["aggregate", new AggregateError([new Error("IMAP-PRIVATE-SENTINEL")], "IMAP-PRIVATE-SENTINEL")],
  ])("sanitizes a nonstandard %s IMAP library rejection", async (_name, original) => {
    const connection = unopenedImapFlow();
    const list = vi.spyOn(connection, "list").mockRejectedValue(original);
    expectSafeImapFailure(await rejectionOf(new ImapFlowMailClient(connection).listFolders()));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("retains a failed IMAP fetch and its independent iterator cleanup failure without exposing either", async () => {
    const connection = unopenedImapFlow();
    stubInboxOpen(connection);
    const primary = new Error("IMAP-PRIMARY-PRIVATE-SENTINEL");
    const cleanup = new Error("IMAP-CLEANUP-PRIVATE-SENTINEL");
    const iterator = (async function* (): AsyncGenerator<FetchMessageObject, void, unknown> {})();
    const next = vi.spyOn(iterator, "next").mockRejectedValue(primary);
    const close = vi.spyOn(iterator, "return").mockRejectedValue(cleanup);
    vi.spyOn(connection, "fetch").mockReturnValue(iterator);
    const warn = vi.spyOn(logger, "warn");
    const outcome = await rejectionOf(new ImapFlowMailClient(connection).fetchMessagesSince("INBOX", 1, 10));
    expect(next).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expectSafeImapFailure(outcome, "PRIVATE-SENTINEL");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE-SENTINEL");
    expect(
      warn.mock.calls.some(
        ([fields]) => typeof fields === "object" && fields !== null && Reflect.get(fields, "stage") === "stream_close",
      ),
    ).toBe(true);
  });

  tenantIt("preserves a non-network storage failure identity through an IMAP sync", async () => {
    const mailbox = await createSyncMailbox({ credential: "fixture" });
    const connection = unopenedImapFlow();
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
    stubInboxOpen(connection);
    vi.spyOn(connection, "fetch").mockImplementation(async function* () {
      yield {
        seq: 1,
        uid: 1,
        envelope: { messageId: "<privacy-storage@example.test>", date: new Date() },
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
    const adapters = { createImapClient: async () => new ImapFlowMailClient(connection) };
    expect(await rejectionOf(runSync(mailbox, adapters, storage))).toBe(original);
    expect((await syncState(mailbox))?.lastError).toBe("storage failure sentinel");
  });

  tenantIt("stores and returns a safe IMAP provider failure after the actual job closes its client", async () => {
    const mailbox = await createSyncMailbox({ credential: "IMAP-PRIVATE-SENTINEL" });
    const connection = unopenedImapFlow();
    const providerFailure = Object.assign(new Error("IMAP-PRIVATE-SENTINEL"), {
      name: "IMAP-PRIVATE-SENTINEL",
      code: "IMAP-PRIVATE-SENTINEL",
    });
    const list = vi.spyOn(connection, "list").mockRejectedValue(providerFailure);
    vi.spyOn(connection, "logout").mockResolvedValue(undefined);
    const close = vi.spyOn(connection, "close").mockImplementation(() => {});
    const adapter = new ImapFlowMailClient(connection);

    expectSafeImapFailure(await rejectionOf(runSync(mailbox, { createImapClient: async () => adapter })));
    expect(list).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await syncState(mailbox))?.lastError).toBe("IMAP provider operation failed unexpectedly");
  });

  for (const mode of ["gmail", "graph"] as const)
    tenantIt(`records successful ${mode} activity after a failure without resetting initial completion`, async () => {
      const mailbox = await createSyncMailbox({
        properties: { name: mode },
        syncMode: mode === "gmail" ? "gmail_api" : "graph_api",
        credential: null,
      });
      const success = () =>
        withTransaction(pool, (client) =>
          mode === "gmail"
            ? recordGmailActivity(client, {
                itemId: mailbox,
                nextExpectedActivityAt: new Date(),
                completesInitialSync: true,
              })
            : recordGraphActivity(client, {
                itemId: mailbox,
                nextExpectedActivityAt: new Date(),
                completesInitialSync: true,
              }),
        );
      await success();
      const first = await syncState(mailbox);
      expect(first?.initialSyncCompletedAt).toBeTruthy();
      expect(first?.initialSyncCompletedAt).toBe(first?.lastSuccessfulSyncAt);
      await withTransaction(pool, (client) => recordSyncError(client, mailbox, "failure", "other"));
      expect(await syncState(mailbox)).toMatchObject({
        failingSince: expect.any(String),
        lastFailureKind: "other",
        lastSuccessfulSyncAt: first?.lastSuccessfulSyncAt,
      });
      await success();
      const recovered = await syncState(mailbox);
      expect(recovered).toMatchObject({
        initialSyncCompletedAt: first?.initialSyncCompletedAt,
        failingSince: null,
        lastFailureKind: null,
        lastError: null,
      });
      expect(recovered?.lastSuccessfulSyncAt).toBeTruthy();
    });

  tenantIt(
    "tracks the last successful sync, the failure streak and its kind, and the initial sync across passes",
    async () => {
      const mailbox = await createSyncMailbox();
      const readUpdatedAt = async () =>
        (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM items WHERE id = $1", [mailbox])).rows[0]
          ?.updated_at;
      const time = (value: string | null | undefined) => new Date(value!).getTime();
      const healthy: MailSyncAdapterFactory = { createImapClient: async () => fakeImap() };
      const failing = (error: Error): MailSyncAdapterFactory => ({
        createImapClient: async () => {
          throw error;
        },
      });

      await runSync(mailbox, healthy);
      const first = await syncState(mailbox);
      expect(first?.lastSuccessfulSyncAt).toBeTruthy();
      expect(first).toMatchObject({
        initialSyncCompletedAt: first?.lastSuccessfulSyncAt,
        failingSince: null,
        lastFailureKind: null,
      });

      // A second identical pass moves the success timestamp, keeps the initial sync, and leaves the 'ok'
      // Mailboxes item untouched.
      const updatedAfterFirst = await readUpdatedAt();
      await runSync(mailbox, healthy);
      const second = await syncState(mailbox);
      expect(time(second?.lastSuccessfulSyncAt)).toBeGreaterThan(time(first?.lastSuccessfulSyncAt));
      expect(second?.initialSyncCompletedAt).toBe(first?.initialSyncCompletedAt);
      expect(await readUpdatedAt()).toEqual(updatedAfterFirst);

      await expect(runSync(mailbox, failing(new Error("boom")))).rejects.toThrow("boom");
      const afterFirstFailure = await syncState(mailbox);
      expect(afterFirstFailure?.failingSince).toBeTruthy();
      expect(afterFirstFailure).toMatchObject({
        lastSuccessfulSyncAt: second?.lastSuccessfulSyncAt,
        lastFailureKind: "other",
      });

      await runSync(mailbox, failing(new MailConnectionLimitError("Too many simultaneous connections.")));
      expect(await syncState(mailbox)).toMatchObject({
        failingSince: afterFirstFailure?.failingSince,
        lastFailureKind: "connectionLimit",
      });

      await runSync(mailbox, failing(new MailReauthorizationRequiredError("revoked")));
      const refused = await syncState(mailbox);
      expect(refused).toMatchObject({
        failingSince: afterFirstFailure?.failingSince,
        lastFailureKind: "reauthorization",
        lastSuccessfulSyncAt: second?.lastSuccessfulSyncAt,
      });
      // Only a sign-in again lets the next pass reach the provider.
      await runSync(mailbox, healthy);
      expect(await syncState(mailbox)).toEqual(refused);
      await withTransaction(pool, (client) => clearMailSyncFailure(client, mailbox));

      await runSync(mailbox, healthy);
      const recovered = await syncState(mailbox);
      expect(recovered).toMatchObject({
        failingSince: null,
        lastFailureKind: null,
        initialSyncCompletedAt: first?.initialSyncCompletedAt,
      });
      expect(time(recovered?.lastSuccessfulSyncAt)).toBeGreaterThan(time(second?.lastSuccessfulSyncAt));
    },
  );

  const notificationCount = (mailbox: string) => countRows("notifications WHERE source_id = $1", [mailbox]);

  it("sets Mailbox.syncStatus to 'needsReauthorization' on a revoked credential, without a mail_sync_error notification", async () => {
    await createOwner();
    const mailbox = await createSyncMailbox();
    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailReauthorizationRequiredError(
          "OAuth exchange failed: refresh_token=provider-auth-exchange-secret",
        );
      },
    };

    const errorSpy = vi.spyOn(logger, "error");
    // Recorded, not rethrown: graphile-worker's retries would only be refused again.
    await runSync(mailbox, adapters);
    expect((await syncState(mailbox))?.lastError).toContain("provider-auth-exchange-secret");
    const logArguments = JSON.stringify(errorSpy.mock.calls);
    expect(logArguments).not.toContain("provider-auth-exchange-secret");
    expect(logArguments).toContain("reauthorizationRequired");

    expect(await syncStatusOf(mailbox)).toBe("needsReauthorization");
    expect(await notificationCount(mailbox)).toBe(0);
  });

  it("writes a mail_sync_error notification on failure, deduped by job id but not across distinct failing jobs", async () => {
    const user = await createOwner();
    const mailbox = await createSyncMailbox();
    const failWith = (jobId: string) =>
      expect(runSync(mailbox, unexpectedlyFailing, noopStorage, { job: { id: jobId } })).rejects.toThrow(
        UNEXPECTED_FAILURE,
      );

    await failWith("job-1");
    const { rows: afterFirst } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [mailbox],
    );
    expect(afterFirst).toMatchObject([
      {
        user_id: user.id,
        kind: "mail_sync_error",
        title: "Mail sync failed",
        link_href: `?page=mailbox&id=${mailbox}`,
        source_table: "mail_account_sync_state",
        transition_instance: "job-1",
      },
    ]);

    // Redelivery of the same job must not duplicate the notification.
    await failWith("job-1");
    expect(await notificationCount(mailbox)).toBe(1);
    await failWith("job-2");
    expect(await notificationCount(mailbox)).toBe(2);
  });

  it("sets syncStatus 'error' and records the error, but notifies nobody, when a pass fails before any user exists", async () => {
    const mailbox = await createSyncMailbox();

    await expect(runSync(mailbox, unexpectedlyFailing, noopStorage, { job: { id: "job-1" } })).rejects.toThrow(
      UNEXPECTED_FAILURE,
    );

    expect(await notificationCount(mailbox)).toBe(0);
    expect((await syncState(mailbox))?.lastError).toContain(UNEXPECTED_FAILURE);
    expect(await syncStatusOf(mailbox)).toBe("error");
  });

  it.each([
    ["no status yet", undefined],
    ["status ok", "ok"],
    ["status error", "error"],
  ])(
    "fails a password mailbox without a credential as a reauthorization from %s, and the sweep then leaves it alone",
    async (_name, previousStatus) => {
      await createOwner();
      const mailbox = await createSyncMailbox({
        credential: null,
        properties: { name: "M", provider: "icloud", ...(previousStatus ? { syncStatus: previousStatus } : {}) },
        allowedSystemKeys: ["syncStatus"],
      });
      const errorSpy = vi.spyOn(logger, "error");
      let connects = 0;
      const counting: MailSyncAdapterFactory = {
        createImapClient: async () => {
          connects += 1;
          return fakeImap();
        },
      };
      expect((await inTenantZero(() => withTransaction(pool, listAccountsDueForSync))).map((a) => a.itemId)).toEqual([
        mailbox,
      ]);

      await runSync(mailbox, counting);

      expect(connects).toBe(0);
      expect((await syncState(mailbox))?.lastError).toContain("has no stored credential");
      expect(await syncStatusOf(mailbox)).toBe("needsReauthorization");
      expect(await syncState(mailbox)).toMatchObject({ lastFailureKind: "reauthorization" });
      expect(JSON.stringify(errorSpy.mock.calls)).toContain("reauthorizationRequired");
      expect(await notificationCount(mailbox)).toBe(0);
      expect(await inTenantZero(() => withTransaction(pool, listAccountsDueForSync))).toEqual([]);
    },
  );

  it.each([
    ["has been soft-deleted", true],
    ["is missing entirely", false],
  ])("resolves as a no-op, without ever invoking the adapter, when the Mailbox item %s", async (_case, exists) => {
    let mailbox = "00000000-0000-0000-0000-000000000000";
    if (exists) {
      mailbox = await createSyncMailbox();
      await chokePoint.softDeleteItem(await databaseIdFor("mailboxes"), mailbox);
    }
    const createImapClient = vi.fn(async () => fakeImap());

    // A NotFoundError from the closing syncStatus write after the adapter already ran would fail this test.
    await expect(runSync(mailbox, { createImapClient })).resolves.toBeUndefined();
    expect(createImapClient).not.toHaveBeenCalled();
  });
});
describe("bounded IMAP sync passes", () => {
  useSeededDatabase();

  const queuedSyncJobs = async (mailboxItemId: string) =>
    (
      await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1", [
        mailAccountSyncJobKey(mailboxItemId),
      ])
    ).rows[0]?.count;

  tenantIt("an unfinished backfill queues the next pass with its batch, a finished one does not", async () => {
    const mailbox = await createSyncMailbox();
    const imap = () =>
      fakeImapAccount([{ path: "INBOX", specialUse: "\\Inbox", count: IMAP_FULL_MESSAGES_PER_PASS + 1 }]);

    await runSync(mailbox, { createImapClient: async () => imap() });
    expect(await queuedSyncJobs(mailbox)).toBe("1");
    expect(await syncStatusOf(mailbox)).toBe("ok");
    expect((await syncState(mailbox))?.initialSyncCompletedAt).toBeNull();

    await pool.query("DELETE FROM graphile_worker._private_jobs WHERE key = $1", [mailAccountSyncJobKey(mailbox)]);
    await runSync(mailbox, { createImapClient: async () => imap() });
    expect(await queuedSyncJobs(mailbox)).toBe("0");
    expect((await syncState(mailbox))?.initialSyncCompletedAt).not.toBeNull();
  });

  tenantIt(
    "a pass that finds the mailbox held by another pass is skipped without recording a failure",
    async () => {
      const mailbox = await createSyncMailbox();
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let held: () => void = () => {};
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = withTransaction(pool, async (client) => {
        await lockMailboxSync(client, mailbox);
        held();
        await released;
      });
      try {
        await holding;
        // The folder list is fetched before the pass's first transaction; nothing after it runs.
        const fetchedMessages = vi.fn(async () => []);
        await runSync(mailbox, {
          createImapClient: async () =>
            fakeImap({
              listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
              fetchMessagesSince: fetchedMessages,
            }),
        });
        expect(fetchedMessages).not.toHaveBeenCalled();
      } finally {
        release();
        await holder;
      }
      expect(await syncStatusOf(mailbox)).toBeUndefined();
      expect(await syncState(mailbox)).toMatchObject({ lastError: null, failingSince: null });
    },
    30_000,
  );

  /** Open transactions and advisory locks of other sessions on this worker's database. */
  const heldDatabaseState = async () => {
    const transactions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`,
    );
    const advisoryLocks = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND d.datname = current_database() AND l.pid <> pg_backend_pid()`,
    );
    return { transactions: transactions.rows[0]?.count, advisoryLocks: advisoryLocks.rows[0]?.count };
  };

  /** A promise the fake waits on, and a promise that resolves once the fake has started waiting. */
  function gate() {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    let arrive: () => void = () => {};
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const wait = () => {
      arrive();
      return opened;
    };
    return { open, arrived, wait };
  }

  tenantIt(
    "holds no transaction and no advisory lock while it fetches messages and downloads an attachment",
    async () => {
      const mailbox = await createSyncMailbox();
      const fetching = gate();
      const downloading = gate();
      const imap = fakeImap({
        listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }],
        selectFolder: async () => ({ uidvalidity: 7, uidnext: 3, highestModSeq: null, messages: 0 }),
        fetchMessagesSince: async () => {
          await fetching.wait();
          return [
            fetched(1, "<slow-1@x>", {
              subject: "Slow 1",
              attachments: [
                {
                  filename: "slow.txt",
                  contentType: "text/plain",
                  contentId: null,
                  disposition: "attachment",
                  openStream: async () => {
                    await downloading.wait();
                    return Readable.from(Buffer.from("slow-bytes"));
                  },
                },
              ],
            }),
            fetched(2, "<slow-2@x>", { subject: "Slow 2" }),
          ];
        },
      });
      const pass = runSync(mailbox, { createImapClient: async () => imap }, blobStorage());
      try {
        await fetching.arrived;
        expect(await heldDatabaseState()).toEqual({ transactions: "0", advisoryLocks: "0" });
        fetching.open();
        await downloading.arrived;
        expect(await heldDatabaseState()).toEqual({ transactions: "0", advisoryLocks: "0" });
      } finally {
        fetching.open();
        downloading.open();
        await pass;
      }

      const { rows } = await pool.query<{ message_id: string }>(
        "SELECT message_id FROM mail_message_meta WHERE mailbox_item_id = $1 ORDER BY message_id",
        [mailbox],
      );
      expect(rows.map((row) => row.message_id)).toEqual(["<slow-1@x>", "<slow-2@x>"]);
      expect(await countRows("mail_attachments")).toBe(1);
      expect(await syncStatusOf(mailbox)).toBe("ok");
    },
    30_000,
  );

  tenantIt(
    "a pass whose folder another pass moved on during its fetch writes nothing for it and leaves the cursor as written",
    async () => {
      const mailbox = await createSyncMailbox();
      const folderCursor = async () =>
        (
          await pool.query<{ uidnext: string | null }>(
            `SELECT s.uidnext FROM mail_folder_sync_state s JOIN items f ON f.id = s.item_id
              WHERE f.properties->>'providerId' = 'INBOX'`,
          )
        ).rows.map((row) => row.uidnext);
      const account = () => fakeImapAccount([{ path: "INBOX", specialUse: "\\Inbox", count: 2 }]);
      const overtaken = account();
      const fetchMessagesSince = overtaken.fetchMessagesSince.bind(overtaken);
      overtaken.fetchMessagesSince = async (path, sinceUid, limit) => {
        // Another pass of the same mailbox runs to completion while this one is fetching.
        await runSync(mailbox, { createImapClient: async () => account() });
        return fetchMessagesSince(path, sinceUid, limit);
      };
      await pool.query("DELETE FROM graphile_worker._private_jobs");

      await runSync(mailbox, { createImapClient: async () => overtaken });

      expect(await folderCursor()).toEqual(["3"]);
      expect(await countRows("mail_message_meta WHERE mailbox_item_id = $1", [mailbox])).toBe(2);
      // Left incomplete, so the next pass is queued; it finds nothing new.
      expect(await queuedSyncJobs(mailbox)).toBe("1");
      await runSync(mailbox, { createImapClient: async () => account() });
      expect(await countRows("mail_message_meta WHERE mailbox_item_id = $1", [mailbox])).toBe(2);
      expect(await folderCursor()).toEqual(["3"]);
    },
    30_000,
  );
});

describe("mailbox Semp problem raised by the sync job", () => {
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

  useSeededDatabase();

  const syncPass = (mailboxItemId: string, adapters: MailSyncAdapterFactory, jobId: string = randomUUID()) =>
    runSync(mailboxItemId, adapters, noopStorage, { job: { id: jobId } });

  async function mailProblems(mailboxItemId: string): Promise<MailProblemRow[]> {
    const { rows } = await pool.query<MailProblemRow>(
      `SELECT category, kind, severity, source_table, source_id, occurrence_count, first_seen_at, resolved_at, resolution_kind
         FROM semp_problems WHERE dedupe_key = $1 ORDER BY first_seen_at`,
      [mailProblemKey(mailboxItemId)],
    );
    return rows;
  }

  const completing: MailSyncAdapterFactory = { createImapClient: async () => fakeImap() };
  const failingWith = (error: Error): MailSyncAdapterFactory => ({
    createImapClient: async () => {
      throw error;
    },
  });

  it("raises one warning problem per mailbox, merging every failing pass and counting a retry of the same job once", async () => {
    await createOwner();
    const mailboxId = await createSyncMailbox();

    // Each pass fails at the provider with an ordinary error, so the default severity. The last job-3 is a
    // redelivery of the same report.
    for (const jobId of ["job-1", "job-2", "job-3", "job-3"])
      await expect(syncPass(mailboxId, unexpectedlyFailing, jobId)).rejects.toThrow(UNEXPECTED_FAILURE);

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
    expect(problems[0]!.first_seen_at.toISOString()).toBe((await syncState(mailboxId))!.failingSince);
  });

  it("raises the problem as critical when the token is revoked, and writes no mail_sync_error notification for it", async () => {
    await createOwner();
    const mailboxId = await createSyncMailbox();

    await syncPass(mailboxId, failingWith(new MailReauthorizationRequiredError("token revoked")));

    expect(await mailProblems(mailboxId)).toMatchObject([
      { severity: "critical", occurrence_count: 1, resolved_at: null },
    ]);
    expect(await countRows("notifications WHERE source_id = $1", [mailboxId])).toBe(0);
  });

  it("does not count an older retried job after a different job reported the same failure", async () => {
    await createOwner();
    const mailboxId = await createSyncMailbox();
    const ids = await moduleIds();
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    await runWithCleanup(
      "Runtime pool cleanup failed",
      () =>
        inTenantZero(async () => {
          for (const jobId of ["job-a", "job-b", "job-a"]) {
            await expect(
              handleSyncMailAccountTask(runtime, { mailboxItemId: mailboxId }, unexpectedlyFailing, ids, noopStorage, {
                job: { id: jobId },
              }),
            ).rejects.toThrow(UNEXPECTED_FAILURE);
          }
          const result = await withTransaction(runtime, (client) =>
            client.query<{ occurrence_count: number; resolved_at: Date | null }>(
              "SELECT occurrence_count, resolved_at FROM semp_problems WHERE dedupe_key = $1",
              [mailProblemKey(mailboxId)],
            ),
          );
          expect(result.rows).toEqual([{ occurrence_count: 2, resolved_at: null }]);
        }),
      [() => runtime.end()],
    );
  });

  it("raises no problem before any user account exists", async () => {
    const mailboxId = await createSyncMailbox({ credential: null });
    await syncPass(mailboxId, {}, "job-1");
    expect((await syncState(mailboxId))?.lastError).toContain("has no stored credential");
    expect(await mailProblems(mailboxId)).toEqual([]);
  });

  it("raises no problem when the sync state row disappears during the pass", async () => {
    await createOwner();
    const mailboxId = await createSyncMailbox();
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
    const mailboxId = await createSyncMailbox();
    const refusing = failingWith(new Error("connection refused"));

    await syncPass(mailboxId, completing);
    expect(await mailProblems(mailboxId)).toEqual([]);

    await expect(syncPass(mailboxId, refusing, "job-1")).rejects.toThrow("connection refused");
    expect(await mailProblems(mailboxId)).toMatchObject([{ resolved_at: null, occurrence_count: 1 }]);

    await syncPass(mailboxId, completing, "job-2");
    expect(await mailProblems(mailboxId)).toMatchObject([
      { resolved_at: expect.any(Date), resolution_kind: "recovered" },
    ]);

    await expect(syncPass(mailboxId, refusing, "job-3")).rejects.toThrow("connection refused");
    expect(await mailProblems(mailboxId)).toMatchObject([
      { resolved_at: expect.any(Date) },
      { resolved_at: null, occurrence_count: 1 },
    ]);
  });

  it("raises no problem for a connection-limit rejection on its own", async () => {
    await createOwner();
    const mailboxId = await createSyncMailbox();
    await syncPass(mailboxId, failingWith(new MailConnectionLimitError("Too many simultaneous connections.")));
    expect(await mailProblems(mailboxId)).toEqual([]);
  });
});

describe("mail_sync_error recipient in a tenant", () => {
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
      await withTransaction(runtimePool, (client) =>
        storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" }),
      );
      return { mailboxItemId: mailbox.id, moduleIds: ids };
    });

    await expect(
      runInTenant(tenantB, () =>
        handleSyncMailAccountTask(runtimePool, { mailboxItemId }, unexpectedlyFailing, moduleIds, noopStorage, {
          job: { id: "job-b" },
        }),
      ),
    ).rejects.toThrow(UNEXPECTED_FAILURE);

    const { rows } = await pool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [mailboxItemId],
    );
    expect(rows).toEqual([{ user_id: userB.id, kind: "mail_sync_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});

describe("IMAP raw header parsing", () => {
  const parse = (...lines: string[]) => parseHeaderBlock(Buffer.from(lines.join("\r\n") + "\r\n"));

  it("preserves every occurrence of a repeated header, in the message's own top-to-bottom order", () => {
    const headers = parse(
      "Delivered-To: newest@example.com",
      "Delivered-To: oldest@example.com",
      "X-Original-To: xo@example.com",
      "References: <a@x> <b@x>",
    );
    expect(headerValues(headers, "delivered-to")).toEqual(["newest@example.com", "oldest@example.com"]);
    expect(headerValues(headers, "x-original-to")).toEqual(["xo@example.com"]);
    // Header-name lookup is case-insensitive, matching RFC 5322.
    expect(headerValues(headers, "Delivered-To")).toEqual(["newest@example.com", "oldest@example.com"]);
  });

  it("unfolds a continuation line (leading whitespace) onto the previous header's value instead of starting a new one", () => {
    const headers = parse("Envelope-To: someone", "  @example.com", "Delivered-To: me@example.com");
    expect(headerValues(headers, "envelope-to")).toEqual(["someone @example.com"]);
    expect(headerValues(headers, "delivered-to")).toEqual(["me@example.com"]);
  });

  it("returns nothing for an absent header or an undefined buffer", () => {
    expect(parseHeaderBlock(undefined)).toEqual([]);
    expect(headerValues(parse("Delivered-To: me@example.com"), "x-original-to")).toEqual([]);
  });
});

describe("deliveredToAddress", () => {
  type Candidates = Parameters<typeof resolveDeliveredToAddress>[0]["candidates"];
  it.each<[string, Candidates, string[], string[], string[], string | undefined]>([
    [
      "prefers the highest (first) Delivered-To occurrence over everything else",
      {
        deliveredToHeaders: ["newest@example.com", "oldest@example.com"],
        xOriginalTo: "xo@example.com",
        envelopeTo: "et@example.com",
      },
      ["to@example.com"],
      [],
      ["alias@example.com"],
      "newest@example.com",
    ],
    [
      "extracts the bare address out of a 'Name <addr>' Delivered-To value",
      { deliveredToHeaders: ["Alice Work <Alice@Example.com>"] },
      [],
      [],
      [],
      "alice@example.com",
    ],
    [
      "falls back to X-Original-To when there is no Delivered-To",
      { deliveredToHeaders: [], xOriginalTo: "xo@example.com", envelopeTo: "et@example.com" },
      [],
      [],
      ["alias@example.com"],
      "xo@example.com",
    ],
    [
      "falls back to Envelope-To when there is no Delivered-To or X-Original-To",
      { deliveredToHeaders: [], xOriginalTo: null, envelopeTo: "et@example.com" },
      [],
      [],
      ["alias@example.com"],
      "et@example.com",
    ],
    [
      "falls back to the first registered mailbox alias matching structured To/Cc",
      { deliveredToHeaders: [] },
      ["someone-else@example.com"],
      ["Alias2@Example.com"],
      ["alias1@example.com", "alias2@example.com"],
      "alias2@example.com",
    ],
    [
      "falls back to the mailbox's primary (first) address when no alias matches structured To/Cc",
      { deliveredToHeaders: [] },
      ["nobody-registered@example.com"],
      [],
      ["primary@example.com", "secondary@example.com"],
      "primary@example.com",
    ],
    [
      "returns undefined when there are no header candidates and no registered aliases",
      { deliveredToHeaders: [] },
      [],
      [],
      [],
      undefined,
    ],
  ])("%s", (_name, candidates, to, cc, mailboxAliases, expected) => {
    expect(
      resolveDeliveredToAddress({
        candidates,
        structuredTo: to.map((address) => ({ address })),
        structuredCc: cc.map((address) => ({ address })),
        mailboxAliases,
      }),
    ).toBe(expected);
  });

  describe("persisted at ingest", () => {
    useSeededDatabase();

    const envelope = { from: { address: "sender@example.com" }, to: [{ address: "me@example.com" }] };
    for (const [name, deliveredToHeaders, expected] of [
      [
        "from multiple Delivered-To occurrences",
        ["me+relay2@example.com", "me+relay1@example.com"],
        "me+relay2@example.com",
      ],
      ["through to the mailbox's registered alias without delivery headers", undefined, "me@example.com"],
    ] as const)
      tenantIt(`persists deliveredToAddress computed ${name}`, async () => {
        const input = (await ingestFixture())("<dta@example.com>", {
          envelope,
          mailboxAliases: ["me@example.com"],
          ...(deliveredToHeaders ? { deliveredToHeaders: [...deliveredToHeaders] } : {}),
        });
        expect((await messageMeta((await ingest(input)).itemId))?.deliveredToAddress).toBe(expected);
      });
  });
});

describe("DSN/bounce detection", () => {
  useSeededDatabase();

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

  tenantIt(
    "a DSN threads onto its outgoing message's thread and is tagged messageKind:'dsn', distinct from a human reply",
    async () => {
      const input = await ingestFixture();
      const to = (address: string) => [{ address }];
      const outgoing = await ingest(
        input("<outgoing@example.com>", {
          subject: "Original",
          envelope: { from: { address: "me@example.com" }, to: to("someone@example.com") },
        }),
      );
      const dsn = await ingest(
        input("<dsn1@mailer-daemon.example.com>", {
          subject: "Undelivered Mail Returned to Sender",
          references: ["<outgoing@example.com>"],
          envelope: { from: { address: "mailer-daemon@example.com" }, to: to("me@example.com") },
          isDsn: true,
        }),
      );
      const reply = await ingest(
        input("<reply1@example.com>", {
          subject: "Re: Original",
          inReplyTo: "<outgoing@example.com>",
          references: ["<outgoing@example.com>"],
          envelope: { from: { address: "someone@example.com" }, to: to("me@example.com") },
        }),
      );

      const { threadId } = (await messageMeta(outgoing.itemId))!;
      expect(await messageMeta(dsn.itemId)).toMatchObject({
        messageKind: "dsn",
        dsnOriginalMessageId: "<outgoing@example.com>",
        threadId,
      });
      // The ordinary reply is threaded the same way but must not itself be classified as a DSN.
      expect(await messageMeta(reply.itemId)).toMatchObject({
        messageKind: "message",
        dsnOriginalMessageId: null,
        threadId,
      });
    },
  );
});

describe("ImapFlowMailClient", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A stand-in ImapFlow recording every call; attachment tests override `fetch` and the download methods. */
  function fakeImapFlow(overrides: Partial<Record<string, unknown>> = {}): ImapFlow & { calls: string[] } {
    const calls: string[] = [];
    const flow = {
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
      async search() {
        calls.push("search");
        return [1];
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
    };
    return flow as unknown as ImapFlow & { calls: string[] };
  }

  it("never calls messageFlagsAdd while fetching message bodies in the background", async () => {
    const raw = fakeImapFlow();
    const fetchedMessages = await new ImapFlowMailClient(raw).fetchMessagesSince("INBOX", 1, 10);
    const content = await fetchedMessages[0]!.fetchContent();

    // Proves the fetch reached a real message body (`download` was called), so no flag mutation is not
    // merely an empty fetch.
    expect(fetchedMessages).toHaveLength(1);
    expect(content.bodyText).toBeDefined();
    expect(raw.calls).toContain("download");
    expect(raw.calls.some((c) => c.startsWith("messageFlagsAdd"))).toBe(false);
  });

  it("setMessageFlag — the only explicit flag-writing path — issues STORE +FLAGS / -FLAGS for the given UID", async () => {
    const raw = fakeImapFlow();
    const client = new ImapFlowMailClient(raw);

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
  // like `\Deleted`, must fail to typecheck.
  function _typeAssertion_setMessageFlagRejectsNonCanonicalFlags(client: ImapFlowMailClient): void {
    // @ts-expect-error - "\Deleted" is not a WritableImapFlag
    void client.setMessageFlag("INBOX", 42, "\\Deleted", true);
  }
  // Referenced so `noUnusedLocals` keeps the guard above: a local gets no leading-underscore exemption.
  void _typeAssertion_setMessageFlagRejectsNonCanonicalFlags;

  it("fetchFlagsChangedSince fetches flags for every known UID, passing changedSince only when a modseq is given", async () => {
    const calls: Array<{ criteria: unknown; options: unknown }> = [];
    const raw = fakeImapFlow({
      fetch(criteria: unknown, _query: unknown, options: unknown) {
        calls.push({ criteria, options });
        return (async function* () {
          yield { uid: 1, flags: new Set([IMAP_SEEN_FLAG]) };
          yield { uid: 2, flags: new Set() };
        })();
      },
    });
    const client = new ImapFlowMailClient(raw);

    expect(await client.fetchFlagsChangedSince("INBOX", null)).toEqual([
      { uid: 1, flags: [IMAP_SEEN_FLAG] },
      { uid: 2, flags: [] },
    ]);
    expect(calls[0]).toMatchObject({ criteria: "1:*", options: { uid: true } });

    await client.fetchFlagsChangedSince("INBOX", 42);
    expect(calls[1]).toMatchObject({ criteria: "1:*", options: { uid: true, changedSince: 42n } });
  });

  it.each([
    [
      "a provider's simultaneous-connection BYE",
      Object.assign(new Error("Connection closed"), {
        code: "ClosedAfterConnectText",
        reason: "Too many simultaneous connections.",
      }),
      true,
    ],
    [
      "a generic too-many-connections phrase",
      new Error("Login failed: too many concurrent connections for this account"),
      true,
    ],
    ["an ordinary connection failure", new Error("ECONNREFUSED"), false],
    ["a non-error value", "not an error", false],
    // imapflow assigns this code to any pre-auth server closure (cert failures, a suspended account,
    // maintenance); only the reason text may decide this.
    [
      "a TLS pre-auth closure sharing imapflow's ClosedAfterConnectTLS code",
      Object.assign(new Error("TLS handshake error"), {
        code: "ClosedAfterConnectTLS",
        reason: "TLS certificate error",
      }),
      false,
    ],
  ])("isImapConnectionLimitError classifies %s", (_name, error, expected) => {
    expect(isImapConnectionLimitError(error)).toBe(expected);
  });

  it("reads an empty body part and an empty attachment, which imapflow answers without a stream", async () => {
    const raw = fakeImapFlow({
      download: async () => ({ meta: {} }),
      fetch: () =>
        (async function* () {
          yield {
            seq: 1,
            uid: 1,
            envelope: { from: [{ address: "a@x.com" }], to: [], cc: [] },
            bodyStructure: {
              type: "multipart/mixed",
              childNodes: [
                { type: "text/plain", part: "1" },
                { type: "application/pdf", part: "2", disposition: "attachment" },
              ],
            },
            headers: Buffer.from(""),
          };
        })(),
    });

    const [fetched] = await new ImapFlowMailClient(raw).fetchMessagesSince("INBOX", 1, 10);
    const content = await fetched!.fetchContent();
    expect(content.bodyText).toBe("");
    const chunks: Buffer[] = [];
    for await (const chunk of await content.attachments[0]!.openStream()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toHaveLength(0);
  });

  describe("attachment download fallback", () => {
    const attachmentStream = async (raw: ImapFlow): Promise<Readable> => {
      const messages = await new ImapFlowMailClient(raw).fetchMessagesSince("INBOX", 1, 10);
      return await (await messages[0]!.fetchContent()).attachments[0]!.openStream();
    };
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
    /** A fake whose full download fails and whose partial fetches return what `partial` returns. */
    const partialFlow = (partial: (start: number | undefined) => Buffer, download?: () => Promise<unknown>) =>
      fakeImapFlow({
        download:
          download ??
          (async () => {
            throw new Error("download failed");
          }),
        fetch: attachmentFetch,
        async fetchOne(_uid: string, query: { bodyParts?: Array<{ key: string; start?: number }> }) {
          const range = query.bodyParts?.[0];
          if (!range) throw new Error("missing partial range");
          return { bodyParts: new Map([[range.key, partial(range.start)]]) };
        },
      });
    const drain = async (stream: Readable): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };

    it("keeps a secret-bearing lazy download failure out of serialized fallback diagnostics", async () => {
      const connection = unopenedImapFlow();
      stubInboxOpen(connection);
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
      const capture = {
        write: (line: string) => {
          logs.push(line);
          return true;
        },
      };
      if (!Reflect.set(logger, streamSymbol, capture)) throw new Error("Could not capture application log stream");
      await runWithCleanup(
        "IMAP fallback diagnostic test and cleanup failed",
        async () => {
          logger.level = "warn";
          expect((await drain(await attachmentStream(connection))).toString()).toBe("abcdef");
          expect(emitted).toBe(original);
          expect(source.destroyed).toBe(true);
          expect(logs).toHaveLength(1);
          expect(logs[0]).not.toContain("IMAP-PRIVATE-SENTINEL");
          expect(JSON.parse(logs[0] ?? "null")).toMatchObject({ stage: "attachment_fallback" });
        },
        [
          async () => {
            logger.level = previousLevel;
          },
          async () => {
            if (!Reflect.set(logger, streamSymbol, previousStream))
              throw new Error("Could not restore application log stream");
          },
        ],
      );
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
        async fetchOne(
          _uid: string,
          query: { bodyParts?: Array<{ key: string; start?: number; maxLength?: number }> },
        ) {
          const range = query.bodyParts?.[0];
          if (range?.start === undefined || range.maxLength === undefined) throw new Error("missing partial range");
          ranges.push({ start: range.start, maxLength: range.maxLength });
          return { bodyParts: new Map([[range.key, Buffer.from("def")]]) };
        },
      });

      expect((await drain(await attachmentStream(raw))).toString()).toBe("abcdef");
      expect(ranges).toEqual([{ start: 3, maxLength: 64 * 1024 }]);
    });

    it("recognizes EOF from a short partial range and rejects a partial fetch that makes no progress", async () => {
      const eofStarts: Array<number | undefined> = [];
      const eofStream = await attachmentStream(
        partialFlow((start) => {
          eofStarts.push(start);
          return Buffer.alloc(100);
        }),
      );
      expect((await drain(eofStream)).length).toBe(100);
      expect(eofStarts).toEqual([0]);

      // Draining is required to make the lazy fallback perform its first partial request.
      const stalledStream = await attachmentStream(partialFlow(() => Buffer.alloc(0)));
      await expect(drain(stalledStream)).rejects.toThrow("made no progress");
    });

    it("rejects a partial download that reaches the attachment cap and still has bytes", async () => {
      const fullChunk = Buffer.alloc(64 * 1024);
      let fetches = 0;
      // 1600 = MAX_ATTACHMENT_BYTES (104_857_600) / IMAP_PARTIAL_FETCH_BYTES (65_536), both private to
      // imapFlowClient.ts: the full-size chunks needed to reach the cap exactly.
      const stream = await attachmentStream(partialFlow(() => (++fetches <= 1600 ? fullChunk : Buffer.from("x"))));

      // Draining confirms the cap is enforced by the fallback before storage sees an extra byte.
      await expect(drain(stream)).rejects.toThrow("exceeded the 104857600-byte cap");
      // 1601 = the 1600 full-size chunks above plus the EOF probe fetch that discovers extra bytes.
      expect(fetches).toBe(1601);
    });
  });
});

describe("mail sync connection-limit backoff", () => {
  useSeededDatabase();

  it("schedules a delayed retry through persisted sync state instead of rethrowing, on a connection-limit rejection", async () => {
    // Pre-seeded to 'ok' so the assertion proves the status is updated on this path.
    const mailbox = await createSyncMailbox({
      properties: { name: "M", provider: "gmail", syncStatus: "ok" },
      allowedSystemKeys: ["syncStatus"],
    });
    const adapters: MailSyncAdapterFactory = {
      createImapClient: async () => {
        throw new MailConnectionLimitError("Too many simultaneous connections.");
      },
    };

    // Resolves rather than rejecting: a connection-limit rejection is contention, and must not trigger
    // graphile-worker's immediate retry on top of the sweep-driven retry recorded below.
    await runSync(mailbox, adapters);

    const state = await syncState(mailbox);
    expect(state?.lastError).toBe("Too many simultaneous connections.");
    // Gmail's provider-aware base (10 minutes) puts the first retry at least that far out, past the 5-minute
    // base of `recordSyncError`.
    expect(new Date(state!.nextExpectedActivityAt!).getTime()).toBeGreaterThan(Date.now() + 8 * 60 * 1000);
    // Mail is not syncing, so syncStatus reflects it like any failure and clears to 'ok' on the next
    // successful pass.
    expect(await syncStatusOf(mailbox)).toBe("error");
  });

  it.each([
    ["Gmail's provider default", { name: "M", provider: "gmail" }, 5],
    ["Mailboxes.connectionLimit over the provider default", { name: "M", provider: "gmail", connectionLimit: 1 }, 1],
  ])("opens the pass's IMAP connection under the account's budget with %s", (_name, properties, limit) =>
    inTenantZero(async () => {
      const mailbox = await createSyncMailbox({ properties });
      const opened: Array<{ accountId: string; limit: number }> = [];

      await runSync(mailbox, {
        createImapClient: async (accountId, _credential, accountLimit) => {
          opened.push({ accountId, limit: accountLimit });
          return fakeImap();
        },
      });

      expect(opened).toEqual([{ accountId: mailbox, limit }]);
    }),
  );

  tenantIt("holds no pooled database connection while a sync pass waits for an IMAP connection slot", async () => {
    // connectionLimit: 1 and another holder of the account's only slot (an IDLE session, a move) make the pass wait;
    // with a free slot it would never wait and this test would pass vacuously.
    const mailbox = await createSyncMailbox({ properties: { name: "M", connectionLimit: 1 } });
    const limiter = createImapConnectionLimiter();
    const sessions = createImapSessionPool(limiter);
    const host = "imap.example.test";

    let releaseSlot: () => void = () => {};
    let resolveSlotTaken: () => void = () => {};
    const slotTaken = new Promise<void>((resolve) => {
      resolveSlotTaken = resolve;
    });
    const holder = limiter.run({ accountId: mailbox, accountLimit: 1, host, kind: "idle" }, async () => {
      resolveSlotTaken();
      await new Promise<void>((resolve) => {
        releaseSlot = resolve;
      });
    });
    await slotTaken;

    const checkedOut = () => pool.totalCount - pool.idleCount;
    const baseline = checkedOut();

    let opened = false;
    const pass = runSync(mailbox, {
      createImapClient: (mailboxItemId, credential, accountLimit) =>
        sessions.checkout({
          mailboxItemId,
          accountLimit,
          host,
          signIn: credential,
          connect: async () => {
            opened = true;
            return fakeImap();
          },
        }),
    });

    // Waits until the pass's credential fetch (before it asks for its connection) has been logged, so it is asking or
    // blocked in the limiter.
    while ((await countRows("credential_access_log WHERE item_id = $1", [mailbox])) < 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // One more tick so the pass's checkout has reached the limiter.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(false);

    // The pass is queued behind the holder and must not have checked out a database connection while it waits:
    // the write transaction opens after the limiter wait.
    expect(checkedOut() - baseline).toBe(0);

    releaseSlot();
    await holder;
    await pass;
    expect(opened).toBe(true);
    await sessions.close();
  });
});

describe("mail sync failure backoff", () => {
  useSeededDatabase();

  const failingWith = (error: Error): MailSyncAdapterFactory => ({
    createImapClient: async () => {
      throw error;
    },
  });
  /** The delay the last failure recorded: both columns are written from the same `now()`. */
  const recordedDelayMinutes = async (mailbox: string) => {
    const state = await syncState(mailbox);
    const delayMs = new Date(state!.nextExpectedActivityAt!).getTime() - new Date(state!.lastActivityAt!).getTime();
    return delayMs / 60_000;
  };

  it.each([
    // Decorrelated jitter: uniform between the 5-minute base and three times the previous delay, capped at 6 hours.
    ["the low end", () => 0, [5, 5, 5, 5, 5]],
    ["the high end", () => 1, [15, 45, 135, 360, 360]],
    ["the middle", () => 0.5, [10, 17.5, 28.75, 45.625, 70.9375]],
  ])(
    "pushes an ordinary failure's next pass out further with each failure of the streak, at %s of the jitter",
    (_name, random, expectedMinutes) =>
      inTenantZero(async () => {
        const mailbox = await createSyncMailbox();
        const recorded: number[] = [];
        for (let failure = 0; failure < expectedMinutes.length; failure++) {
          await expect(
            runSync(mailbox, failingWith(new Error("boom")), noopStorage, undefined, random),
          ).rejects.toThrow("boom");
          recorded.push(await recordedDelayMinutes(mailbox));
        }
        expect(recorded).toEqual(expectedMinutes);
      }),
  );

  it("starts a new streak at the base after a pass succeeded", () =>
    inTenantZero(async () => {
      const mailbox = await createSyncMailbox();
      const high = () => 1;
      for (let failure = 0; failure < 2; failure++) {
        await expect(runSync(mailbox, failingWith(new Error("boom")), noopStorage, undefined, high)).rejects.toThrow();
      }
      expect(await recordedDelayMinutes(mailbox)).toBe(45);
      await runSync(mailbox, { createImapClient: async () => fakeImap() });
      await expect(runSync(mailbox, failingWith(new Error("boom")), noopStorage, undefined, high)).rejects.toThrow();
      expect(await recordedDelayMinutes(mailbox)).toBe(15);
    }));

  it("jitters a connection-limit backoff over the provider's base and grows it over the streak", () =>
    inTenantZero(async () => {
      const mailbox = await createSyncMailbox({ properties: { name: "M", provider: "gmail" } });
      const limited = failingWith(new MailConnectionLimitError("Too many simultaneous connections."));
      const recorded: number[] = [];
      for (let failure = 0; failure < 3; failure++) {
        await runSync(mailbox, limited, noopStorage, undefined, () => 0.5);
        recorded.push(await recordedDelayMinutes(mailbox));
      }
      // Gmail's base is 10 minutes: 10 + 0.5 * (30 - 10), then from 20 and from 35 minutes.
      expect(recorded).toEqual([20, 35, 57.5]);
    }));
});

describe("mail sync of an account whose sign-in the provider refused", () => {
  useSeededDatabase();

  it("ends every later pass without reading the credential or calling the provider, until a sign-in clears it", () =>
    inTenantZero(async () => {
      await createOwner();
      const mailbox = await createSyncMailbox();
      const refused = {
        createImapClient: async () => {
          throw new MailReauthorizationRequiredError("The IMAP server rejected the stored login");
        },
      };
      // Resolves: a refused login is recorded, and graphile-worker does not retry it.
      await runSync(mailbox, refused);
      const recorded = await syncState(mailbox);
      expect(recorded?.lastFailureKind).toBe("reauthorization");
      const credentialReads = await countRows("credential_access_log WHERE item_id = $1", [mailbox]);
      const jobs = await countRows("graphile_worker._private_jobs");

      const createImapClient = vi.fn(async () => fakeImap());
      for (let pass = 0; pass < 2; pass++) await runSync(mailbox, { createImapClient });

      expect(createImapClient).not.toHaveBeenCalled();
      expect(await countRows("credential_access_log WHERE item_id = $1", [mailbox])).toBe(credentialReads);
      expect(await syncState(mailbox)).toEqual(recorded);
      expect(await syncStatusOf(mailbox)).toBe("needsReauthorization");
      expect(await countRows("graphile_worker._private_jobs")).toBe(jobs);

      // What both sign-in routes write before they queue the next pass.
      await withTransaction(pool, (client) => clearMailSyncFailure(client, mailbox));
      await runSync(mailbox, { createImapClient });

      expect(createImapClient).toHaveBeenCalledTimes(1);
      expect(await syncStatusOf(mailbox)).toBe("ok");
      expect((await syncState(mailbox))?.lastFailureKind).toBeNull();
    }));
});

describe("mail flag write-back", () => {
  useSeededDatabase();

  tenantIt(
    "persists desired/current state, writes every IMAP folder copy for all four transitions, and does not echo a converged observation",
    async () => {
      const params = await reconcileParams();
      const reconcile = (client: ImapMailClient) =>
        reconcileImapAccount(pool, client, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS });
      const message = { messageId: "<writeback@x>", envelope: {}, attachments: [], flags: [] };
      const initial = fakeImap({
        listFolders: async () => [
          { path: "INBOX", specialUse: "\\Inbox" },
          { path: "Archive", specialUse: "\\Archive" },
        ],
        selectFolder: async (path) => ({
          uidvalidity: 1,
          uidnext: path === "INBOX" ? 2 : 3,
          highestModSeq: null,
          messages: 1,
        }),
        fetchMessagesSince: async (path) => [fetched(path === "INBOX" ? 1 : 2, message.messageId, message)],
        fetchAllUids: async (path) => (path === "INBOX" ? [1] : [2]),
      });
      await reconcile(initial);

      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
        params.emailsDatabaseId,
      ]);
      const patch = (propertiesPatch: Record<string, boolean>) =>
        chokePoint.updateItem({ databaseId: params.emailsDatabaseId, itemId: rows[0]!.id, propertiesPatch });
      const bothCopies = (flag: string, value: boolean) => [
        { path: "INBOX", flag, value },
        { path: "Archive", flag, value },
      ];

      const writes: Array<{ path: string; flag: string; value: boolean }> = [];
      const writingClient: ImapMailClient = {
        ...initial,
        fetchMessagesSince: async () => [],
        setMessageFlag: async (path, _uid, flag, value) => {
          writes.push({ path, flag, value });
        },
      };
      for (const value of [true, false]) {
        await patch({ read: value, flagged: value });
        writes.length = 0;
        await reconcile(writingClient);
        expect(writes).toHaveLength(4);
        expect(writes).toEqual(
          expect.arrayContaining([...bothCopies(IMAP_FLAGGED_FLAG, value), ...bothCopies(IMAP_SEEN_FLAG, value)]),
        );
      }

      await patch({ read: true });
      await reconcile({
        ...initial,
        fetchMessagesSince: async () => [],
        fetchFlagsChangedSince: async (path) => [{ uid: path === "INBOX" ? 1 : 2, flags: [IMAP_SEEN_FLAG] }],
        setMessageFlag: async () => {
          throw new Error("a provider observation matching desired state must not be echoed");
        },
      });

      await patch({ flagged: true });
      await expect(
        reconcile({
          ...writingClient,
          setMessageFlag: async () => {
            throw new Error("temporary IMAP failure");
          },
        }),
      ).rejects.toThrow("temporary IMAP failure");
      writes.length = 0;
      await reconcile(writingClient);
      expect(writes).toHaveLength(2);
      expect(writes).toEqual(expect.arrayContaining(bothCopies(IMAP_FLAGGED_FLAG, true)));
    },
  );
});

describe("flag observation convergence and IMAP known-UID re-fetch", () => {
  useSeededDatabase();

  async function flagStateRowFor(itemId: string, propertyKey: string) {
    const { rows } = await pool.query<{ desired_state: boolean; current_state: boolean }>(
      `SELECT desired_state, current_state FROM mail_message_flag_sync_state
       WHERE message_item_id = $1 AND property_key = $2`,
      [itemId, propertyKey],
    );
    return rows[0];
  }

  async function setUpFolder() {
    const { mailboxItemId, inboxItemId } = await createMailboxWithInbox("M");
    const ids = await moduleIds();
    const params = {
      folderItemId: inboxItemId,
      folderPath: "INBOX",
      emailsDatabaseId: ids.emailsDatabaseId,
      filesDatabaseId: ids.filesDatabaseId,
      folderRelationPropertyId: await propertyIdFor(ids.emailsDatabaseId, "folder"),
      attachmentsRelationPropertyId: await propertyIdFor(ids.emailsDatabaseId, "attachments"),
      storage: noopStorage,
      storageKeyPrefix: "test",
      mailboxItemId,
      foldersDatabaseId: ids.foldersDatabaseId,
      mailboxFolderRelationPropertyId: await propertyIdFor(ids.foldersDatabaseId, "mailbox"),
    };
    const pendingWrites = async () =>
      listPendingImapFlagWrites(pool, {
        folderRelationDefinitionId: await relationDefinitionIdFor(params.folderRelationPropertyId),
        mailboxFolderRelationDefinitionId: await relationDefinitionIdFor(params.mailboxFolderRelationPropertyId),
        mailboxItemId,
      });
    const ingestKnown = async (messageId: string, overrides: Partial<IngestInput> = {}) =>
      ingest((await ingestFixture(inboxItemId))(messageId, { mailboxItemId, folderUid: 1, ...overrides }));
    const readOf = async (itemId: string) => (await chokePoint.getItem(ids.emailsDatabaseId, itemId))?.properties.read;
    const markRead = (itemId: string) =>
      chokePoint.updateItem({ databaseId: ids.emailsDatabaseId, itemId, propertiesPatch: { read: true } });
    return { emailsId: ids.emailsDatabaseId, params, pendingWrites, ingestKnown, readOf, markRead };
  }

  /** A second-pass client over the folder whose only known message is uid 1. */
  const knownUidPass = (overrides: Partial<ImapMailClient>) =>
    fakeImap({
      listFolders: async () => [{ path: "INBOX" }],
      selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: null, messages: 1 }),
      fetchChangesSince: async () => null,
      fetchAllUids: async () => [1],
      setMessageFlag: async () => {
        throw new Error("this pass must not attempt a write-back");
      },
      ...overrides,
    });

  /**
   * Ingests one message (uid 1, unread/unflagged) via reconcileImapFolder's initial-sync pass, so
   * mail_folder_sync_state carries uidnext/uidvalidity for the second pass.
   */
  async function ingestFirstMessage(
    params: Awaited<ReturnType<typeof setUpFolder>>["params"],
    overrides: Partial<ImapMailClient> = {},
  ): Promise<string> {
    const firstPass = knownUidPass({
      fetchMessagesSince: async () => [fetched(1, "<obs@x>", { envelope: {}, flags: [] })],
      ...overrides,
    });
    await reconcileImapFolder(pool, firstPass, params);
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
      params.emailsDatabaseId,
    ]);
    return rows[0]!.id;
  }

  it.each([
    [
      "an observation on a converged flag replaces the item's value and both state halves, leaving no pending write",
      true,
      [],
      false,
      false,
    ],
    [
      "an observation of the old value while a write is pending leaves the item and the pending write untouched",
      false,
      [],
      true,
      true,
    ],
    [
      "an observation equal to the pending desired value converges the row without patching the item",
      false,
      [IMAP_SEEN_FLAG],
      true,
      false,
    ],
  ])("%s", async (_name, confirmed, observedFlags, expectedRead, stillPending) =>
    inTenantZero(async () => {
      const { params, pendingWrites, readOf, markRead } = await setUpFolder();
      const emailItemId = await ingestFirstMessage(params);

      await markRead(emailItemId);
      if (confirmed)
        await withTransaction(pool, (client) => recordConfirmedMailMessageFlag(client, emailItemId, "read", true));
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({ desired_state: true, current_state: confirmed });

      const secondPass = knownUidPass({ fetchFlagsChangedSince: async () => [{ uid: 1, flags: observedFlags }] });
      await reconcileImapFolder(pool, secondPass, params);

      expect(await readOf(emailItemId)).toBe(expectedRead);
      expect(await flagStateRowFor(emailItemId, "read")).toEqual({
        desired_state: expectedRead,
        current_state: !stillPending && expectedRead,
      });
      expect(await pendingWrites()).toEqual(
        stillPending
          ? [{ messageItemId: emailItemId, propertyKey: "read", desiredState: true, folderPath: "INBOX", uid: 1 }]
          : [],
      );
    }),
  );

  tenantIt(
    "a repeat ingest of an already-known message with a pending write-back leaves the item and desired_state untouched",
    async () => {
      const { ingestKnown, readOf, markRead } = await setUpFolder();
      const first = await ingestKnown("<repeat-pending@x>", { flags: [] }); // unread on the provider
      expect(first.created).toBe(true);

      // Marked read but never confirmed by write-back — desired true, current still false.
      await markRead(first.itemId);
      expect(await flagStateRowFor(first.itemId, "read")).toEqual({ desired_state: true, current_state: false });

      // A later fetchMessagesSince pass re-observes the message with the old (unread) flag value, before the
      // pending write-back ran.
      expect(await ingestKnown("<repeat-pending@x>", { flags: [] })).toEqual({
        itemId: first.itemId,
        created: false,
      });
      expect(await readOf(first.itemId)).toBe(true);
      expect(await flagStateRowFor(first.itemId, "read")).toEqual({ desired_state: true, current_state: false });
    },
  );

  describe("applyObservedMailMessageFlags, called directly", () => {
    const observe = (emailsDatabaseId: string, messageItemId: string, flags: string[], folderItemId: string) =>
      withTransaction(pool, (client) =>
        applyObservedMailMessageFlags(client, { emailsDatabaseId, messageItemId, folderItemId, flags }),
      );

    it("throws NotFoundError when the item does not exist", async () => {
      const { emailsId, params } = await setUpFolder();
      await expect(observe(emailsId, randomUUID(), [], params.folderItemId)).rejects.toThrow(NotFoundError);
    });

    tenantIt("patches the item and creates a converged sync-state row when none exists yet", async () => {
      const { emailsId, params, ingestKnown, readOf } = await setUpFolder();
      // No `flags`: ingestEmailMessage's created branch only records observed flags when the caller passes them,
      // so this message lands with no mail_message_flag_sync_state rows at all.
      const { itemId } = await ingestKnown("<no-rows@x>");
      expect(await flagStateRowFor(itemId, "read")).toBeUndefined();

      await observe(emailsId, itemId, [IMAP_SEEN_FLAG], params.folderItemId);

      expect(await readOf(itemId)).toBe(true);
      expect(await flagStateRowFor(itemId, "read")).toEqual({ desired_state: true, current_state: true });
    });

    tenantIt(
      "leaves a pending property untouched while converging a different, non-pending property in the same call",
      async () => {
        const { emailsId, params, ingestKnown, markRead } = await setUpFolder();
        // Unread, unflagged — seeds converged sync-state rows for both properties.
        const { itemId } = await ingestKnown("<pending-plus-converge@x>", { flags: [] });

        // Marked read but never confirmed by write-back — desired true, current still false.
        await markRead(itemId);
        expect(await flagStateRowFor(itemId, "flagged")).toEqual({ desired_state: false, current_state: false });

        await observe(emailsId, itemId, [IMAP_FLAGGED_FLAG], params.folderItemId); // still unread (the old value) but now flagged

        // The pending `read` write survives untouched, while `flagged`, which had no pending write, converges to
        // the observation: both properties were recorded in this one call.
        expect((await chokePoint.getItem(emailsId, itemId))?.properties).toMatchObject({ read: true, flagged: true });
        expect(await flagStateRowFor(itemId, "read")).toEqual({ desired_state: true, current_state: false });
        expect(await flagStateRowFor(itemId, "flagged")).toEqual({ desired_state: true, current_state: true });
      },
    );
  });

  tenantIt(
    "fetchFlagsChangedSince is skipped on the initial sync, called with null without CONDSTORE, and with the stored highestmodseq with it",
    async () => {
      const { params } = await setUpFolder();
      const calls: Array<number | null> = [];
      const recording = {
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: 42, messages: 0 }),
        fetchFlagsChangedSince: async (_path: string, sinceModSeq: number | null) => {
          calls.push(sinceModSeq);
          return [];
        },
      };

      await ingestFirstMessage(params, recording);
      // The very first sync of a folder never calls it: nothing has been observed as "known" yet.
      expect(calls).toEqual([]);

      const noCondstore = knownUidPass(recording);
      await reconcileImapFolder(pool, noCondstore, params);
      expect(calls).toEqual([null]);

      // A flag change since raised the folder's mod-sequence; an unchanged one would skip the fetch.
      const condstore = {
        ...noCondstore,
        getCapabilities: async () => new Set(["CONDSTORE"]),
        selectFolder: async () => ({ uidvalidity: 1, uidnext: 2, highestModSeq: 43, messages: 1 }),
      };
      await reconcileImapFolder(pool, condstore, params);
      expect(calls).toEqual([null, 42]);
    },
  );
});

afterAll(async () => {
  await pool?.end();
});

describe("queued sync status forward repair", () => {
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
  /** Sync state rows with an unclassified error, the shape the sweep repairs. */
  const insertUnclassified = (tenant: string, ids: string[]) =>
    runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        await insertItemsWithIds(client, ids);
        await client.query(
          `INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, next_expected_activity_at)
           SELECT id, 'imap', 'unclassified', '2099-01-01' FROM unnest($1::uuid[]) AS id`,
          [ids],
        );
      }),
    );
  /** Drops test-only database objects; each name is a fixed identifier. */
  const dropIfCreated = (created: () => boolean, ddl: string) => async () => {
    if (created()) await pool.query(ddl);
  };
  const otherRepairCount = async (tenant: string) =>
    countRows("mail_account_sync_state WHERE tenant_id = $1 AND last_failure_kind = 'other'", [tenant]);

  it("skips locked rows and never overwrites competing success or known failure", async () => {
    const success = randomUUID();
    const failed = randomUUID();
    const retry = randomUUID();
    await insertUnclassified(tenantA, [success, failed, retry]);
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
        await recordImapActivity(client, {
          itemId: success,
          nextExpectedActivityAt: new Date("2099-01-01"),
          completesInitialSync: true,
        });
        await recordSyncError(client, failed, "known failure", "reauthorization");
      }),
    );
    holder.catch(failedBeforeLock);
    await runWithCleanup(
      "Sweep race and holder failed",
      async () => {
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
      },
      [
        async () => {
          release();
          await holder;
        },
      ],
    );
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
    await insertUnclassified(tenantA, ids);
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
    let functionCreated = false;
    let triggerCreated = false;
    await runWithCleanup(
      "Concurrent queued sweeps and cleanup failed",
      async () => {
        // `first` comes from randomUUID() and contains only hexadecimal digits and hyphens.
        await pool.query(`CREATE FUNCTION test_sync_repair_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.item_id = '${first}'::uuid THEN PERFORM pg_advisory_xact_lock(421305122); END IF; RETURN NEW; END $$`);
        functionCreated = true;
        await pool.query(`CREATE TRIGGER test_sync_repair_barrier BEFORE UPDATE ON mail_account_sync_state
          FOR EACH ROW EXECUTE FUNCTION test_sync_repair_barrier()`);
        triggerCreated = true;
        const blocker = withTransaction(pool, async (client) => {
          const pid = await backendPid(client);
          if (!pid) throw new Error("Missing blocker PID");
          await client.query("SELECT pg_advisory_xact_lock(421305122)");
          held(pid);
          await barrier;
        });
        participants.push(blocker);
        blocker.catch(rejectHeld);
        const blockerPid = await ready;
        const firstSweep = enqueueSweep();
        participants.push(firstSweep);
        void firstSweep.catch(() => undefined); // its rejection is reported by the cleanup's allSettled
        let blockedPid: number | undefined;
        for (let attempt = 0; attempt < 100 && !blockedPid; attempt++) {
          const result = await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
             AND position('SELECT tenant_id, item_id FROM mail_account_sync_state' in query) > 0`,
            [blockerPid],
          );
          blockedPid = result.rows[0]?.pid;
          if (!blockedPid) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blockedPid).toBeDefined();
        await enqueueSweep();
        const midway = await otherRepairCount(tenantA);
        expect(midway).toBeGreaterThan(0);
        expect(midway).toBeLessThanOrEqual(200);
        release();
        await firstSweep;
        expect(await otherRepairCount(tenantA)).toBe(201);
      },
      [
        async () => {
          release();
          for (const result of await Promise.allSettled(participants))
            if (result.status === "rejected") throw result.reason;
        },
        dropIfCreated(() => triggerCreated, "DROP TRIGGER test_sync_repair_barrier ON mail_account_sync_state"),
        dropIfCreated(() => functionCreated, "DROP FUNCTION test_sync_repair_barrier()"),
      ],
    );
  }, 15_000);

  it("keeps an earlier tenant page committed when a later tenant repair fails", async () => {
    for (const tenant of [tenantA, tenantB]) await insertUnclassified(tenant, [randomUUID()]);
    let sequenceCreated = false;
    let functionCreated = false;
    let triggerCreated = false;
    await runWithCleanup(
      "Tenant repair failure test and cleanup failed",
      async () => {
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
        const sequence = await pool.query<{ last_value: string }>("SELECT last_value FROM test_sync_repair_order");
        expect(sequence.rows).toEqual([{ last_value: "2" }]);
      },
      [
        dropIfCreated(() => triggerCreated, "DROP TRIGGER test_sync_repair_failure ON mail_account_sync_state"),
        dropIfCreated(() => functionCreated, "DROP FUNCTION test_sync_repair_failure()"),
        dropIfCreated(() => sequenceCreated, "DROP SEQUENCE test_sync_repair_order"),
      ],
    );
  });

  it("repairs at most 200 per active tenant per queued sweep, preserving exclusions and state", async () => {
    for (const tenant of [tenantA, tenantB]) {
      await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const ids = Array.from({ length: 204 }, () => randomUUID());
          await insertItemsWithIds(client, ids);
          await client.query(
            `INSERT INTO mail_account_sync_state (item_id, sync_mode, last_error, next_expected_activity_at)
             SELECT id, 'imap', 'unclassified', '2099-01-01' FROM unnest($1::uuid[]) AS id`,
            [ids.slice(0, 201)],
          );
          await client.query(
            `INSERT INTO mail_account_sync_state
             (item_id, sync_mode, last_error, last_activity_at, last_failure_kind, next_expected_activity_at)
             VALUES ($1, 'imap', 'known', NULL, 'reauthorization', '2099-01-01'),
                    ($2, 'imap', 'active', '2026-01-01', NULL, '2099-01-01'),
                    ($3, 'imap', NULL, NULL, NULL, '2099-01-01')`,
            ids.slice(201),
          );
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
