import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemDeleteHook, registerItemRestoreHook } from "../chokePoint/hooks.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { listItems, lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { getDecryptedCredential, hasCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import type { GmailMailClient } from "../mail/gmailReconcile.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import {
  ensureMailAccountSyncState,
  listAccountsDueForSync,
  recordGmailActivity,
  recordProviderAccountAddress,
  recordSyncError,
} from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import {
  createMailboxReauthorizeRouteHandler,
  createMailOauthCompleteRouteHandler,
} from "../mail/mailOauthRouteHandlers.js";
import { createMailSummaryRouteHandler } from "../mail/mailSummary.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { handleMailboxRemovalTask } from "../mail/mailboxRemovalJob.js";
import { GOOGLE_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { mailProblemKey } from "../semp/sourceProblemKeys.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

/** The seeded ids every fixture shares, read per tenant. */
interface MailIds {
  mailboxes: string;
  folders: string;
  emails: string;
  files: string;
  emailFolderProperty: string;
  emailAttachmentsProperty: string;
  folderMailboxProperty: string;
}

type FolderPurpose = "inbox" | "archive" | "junk";

/** A Mailboxes item with the three Folders a test files mail into. */
type TestMailbox = { id: string } & Record<FolderPurpose, string>;

/** What one restore hook call of a test saw, recorded by the hook this file registers. */
interface RestoreCall {
  itemId: string;
  rootItemId: string;
  writerKind: string;
  agentRunId: string | undefined;
  actingUserId: string | undefined;
}

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const OAUTH = {
  gmail: { clientId: "gmail-client-id", clientSecret: "gmail-client-secret" },
  redirectBaseUrl: "https://app.example.test",
};
const GOOGLE_ACCOUNT = "restored.user@gmail.com";
const OLD_REFRESH_TOKEN = "refresh-token-before-the-removal";
const NEW_REFRESH_TOKEN = "refresh-token-of-the-new-sign-in";

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;
/** The item whose trash the test delete hook refuses, to interrupt a removal job; registered once for the file. */
let vetoedTrash: string | null = null;
/** The item whose restore the test restore hook refuses; registered once for the file. */
let vetoedRestore: string | null = null;
let restoreCalls: RestoreCall[] = [];

/** No fixture of this file has an attachment, so nothing is written to storage. */
const storage: BlobStorageWriter = {
  async writeStream(_storageKey: string, _source: Readable) {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function loadIds(client: PoolClient): Promise<MailIds> {
  const mail = await resolveMailModuleIds(client);
  const propertyId = async (databaseId: string, key: string): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [databaseId, key],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`property '${key}' is not seeded`);
    return id;
  };
  return {
    mailboxes: mail.mailboxesDatabaseId,
    folders: mail.foldersDatabaseId,
    emails: mail.emailsDatabaseId,
    files: mail.filesDatabaseId,
    emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
    emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
    folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
  };
}

/**
 * A Mailboxes item with `syncStatus` `ok` and its folders, each created by the production folder
 * discovery. `provider` `null` leaves the property unset. It has no sync state and no credential.
 */
async function createMailbox(
  client: PoolClient,
  ids: MailIds,
  name: string,
  provider: string | null = "gmail",
): Promise<TestMailbox> {
  const mailbox = await createItemWithClient(
    client,
    { databaseId: ids.mailboxes, properties: { name, syncStatus: "ok", ...(provider === null ? {} : { provider }) } },
    { allowedSystemKeys: ["syncStatus"] },
  );
  const folder = (purpose: FolderPurpose): Promise<string> =>
    ensureFolderItem(client, {
      foldersDatabaseId: ids.folders,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId: ids.folderMailboxProperty,
      providerId: purpose,
      name: purpose,
      behavior: "folder",
      specialPurpose: purpose,
    });
  return { id: mailbox.id, inbox: await folder("inbox"), archive: await folder("archive"), junk: await folder("junk") };
}

/**
 * Connects `mailboxId` as a Gmail account that has synced before: an OAuth credential and a sync state
 * that holds a history cursor, an activity record and the account's address, none of which a default
 * row has.
 */
async function connect(client: PoolClient, mailboxId: string): Promise<void> {
  await storeCredential(client, {
    itemId: mailboxId,
    credentialType: "oauth2_refresh_token",
    plaintext: OLD_REFRESH_TOKEN,
  });
  await ensureMailAccountSyncState(client, { itemId: mailboxId, syncMode: "gmail_api" });
  await recordProviderAccountAddress(client, mailboxId, GOOGLE_ACCOUNT);
  await recordGmailActivity(client, {
    itemId: mailboxId,
    historyId: "4711",
    nextExpectedActivityAt: new Date("2031-01-01T00:00:00Z"),
  });
}

/** One message through the production ingest writer. A repeated `messageId` in the same mailbox joins the same Email, as sync does. */
function ingest(
  client: PoolClient,
  ids: MailIds,
  input: { mailboxId: string; folder: string; messageId: string },
): Promise<string> {
  return ingestEmailMessage(client, {
    emailsDatabaseId: ids.emails,
    filesDatabaseId: ids.files,
    folderRelationPropertyId: ids.emailFolderProperty,
    attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
    folderItemId: input.folder,
    mailboxItemId: input.mailboxId,
    messageId: input.messageId,
    inReplyTo: null,
    references: [],
    subject: input.messageId,
    envelope: { from: { address: "bob@example.com" }, to: [{ address: "me@example.com" }] },
    attachments: [],
    storage,
    storageKeyPrefix: "mailbox-restore",
  }).then((result) => result.itemId);
}

/** Soft-deletes one item through the choke point, at a time of its own, and fails if nothing was deleted. */
async function softDelete(databaseId: string, itemId: string, tenantId = tenant): Promise<void> {
  const deleted = await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemId));
  if (deleted === null) throw new Error(`item ${itemId} was not soft-deleted`);
}

/** Removes the mailbox through the production removal and fails if it removed nothing. */
async function remove(mailboxItemId: string, tenantId = tenant): Promise<void> {
  const removed = await runInTenant(tenantId, () =>
    removeMailbox(runtime, mailboxItemId, { queueAffinity: createActionQueueAffinity() }),
  );
  if (!removed) throw new Error(`mailbox ${mailboxItemId} was not removed`);
}

/** The `mailboxRemoval` job of the removed mailbox, as the worker runs it. */
function runRemovalJob(mailboxItemId: string, options: { chunkSize?: number } = {}, tenantId = tenant): Promise<void> {
  return runInTenant(tenantId, () => handleMailboxRemovalTask(runtime, { mailboxItemId }, options));
}

/** The removal and its whole job: the mailbox, its live folders and their live messages are in the trash afterwards. */
async function removeWithMail(mailboxItemId: string, tenantId = tenant): Promise<void> {
  await remove(mailboxItemId, tenantId);
  await runRemovalJob(mailboxItemId, {}, tenantId);
}

/** Restores the mailbox through the choke point's restore, the write `POST /api/items/:id/restore` makes. */
function restore(
  ids: MailIds,
  mailboxItemId: string,
  options: { actingUserId?: string; writer?: WriterIdentity; tenantId?: string } = {},
) {
  return runInTenant(options.tenantId ?? tenant, () =>
    chokePoint.restoreItem(ids.mailboxes, mailboxItemId, options.actingUserId, options.writer),
  );
}

/** Each item's `deleted_at` as stored, `null` for a live item, read in `tenantId`'s scope; an item that scope cannot see is absent. */
function trashTimes(itemIds: string[], tenantId = tenant): Promise<Record<string, string | null>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ id: string; deleted_at: string | null }>(
      "SELECT id, deleted_at::text AS deleted_at FROM items WHERE id = ANY($1::uuid[])",
      [itemIds],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.deleted_at]));
  }, tenantId);
}

function allLive(itemIds: string[]): Record<string, null> {
  return Object.fromEntries(itemIds.map((id) => [id, null]));
}

const syncStateRowSchema = z.record(z.string(), z.unknown());

/** Every column of the mailbox's `mail_account_sync_state` rows, as stored, read in `tenantId`'s scope. */
function syncStateRows(mailboxItemId: string, tenantId = tenant): Promise<Array<Record<string, unknown>>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ state: unknown }>(
      "SELECT to_jsonb(s) AS state FROM mail_account_sync_state s WHERE s.item_id = $1",
      [mailboxItemId],
    );
    return rows.map((row) => syncStateRowSchema.parse(row.state));
  }, tenantId);
}

/**
 * Asserts that the mailbox has exactly one sync state row and that it is a default one: the row
 * `ensureMailAccountSyncState` inserts for a new mailbox sets the mailbox, the tenant and the sync mode
 * and leaves every other column null.
 */
async function expectDefaultSyncState(mailboxItemId: string, syncMode: string, tenantId = tenant): Promise<void> {
  const rows = await syncStateRows(mailboxItemId, tenantId);
  expect(rows).toHaveLength(1);
  const row = rows[0] ?? {};
  expect({ item_id: row.item_id, tenant_id: row.tenant_id, sync_mode: row.sync_mode }).toEqual({
    item_id: mailboxItemId,
    tenant_id: tenantId,
    sync_mode: syncMode,
  });
  const set = Object.entries(row)
    .filter(([, value]) => value !== null)
    .map(([column]) => column);
  expect(set.sort()).toEqual(["item_id", "sync_mode", "tenant_id"]);
}

/** The mailbox's stored `syncStatus`, read in `tenantId`'s scope. */
function syncStatusOf(mailboxItemId: string, tenantId = tenant): Promise<unknown> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE id = $1",
      [mailboxItemId],
    );
    return rows[0]?.properties.syncStatus;
  }, tenantId);
}

/** The ids the generic list of `databaseId` returns, which leaves trashed items out. */
function listedItemIds(databaseId: string, tenantId = tenant): Promise<string[]> {
  return inTenant(async (client) => {
    const page = await listItems(client, databaseId, { limit: 200 });
    if (page.nextCursor !== null) throw new Error("the fixture outgrew one list page");
    return page.items.map((item) => item.id);
  }, tenantId);
}

/** How many threads the inbox thread list returns, as the route reads it. */
function listedThreadCount(tenantId = tenant): Promise<number> {
  return inTenant(async (client) => {
    const threads = await listMailThreads(client, 200, null, {
      box: "inbox",
      folderId: null,
      unread: false,
      mailboxId: null,
    });
    return threads.length;
  }, tenantId);
}

/** The ids of every Folders item related to the mailbox, live or trashed. */
function folderIdsOf(ids: MailIds, mailboxItemId: string): Promise<string[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS id
         FROM item_relations r
         JOIN relation_definitions rd ON rd.id = r.relation_definition_id
        WHERE $2 IN (rd.property_id_a, rd.property_id_b) AND (r.item_a = $1 OR r.item_b = $1)
        ORDER BY id`,
      [mailboxItemId, ids.folderMailboxProperty],
    );
    return rows.map((row) => row.id);
  });
}

/** The mailbox's messages as sync knows them: the provider's message id and the Emails item it is stored as. */
function messagesOf(mailboxItemId: string): Promise<Array<{ providerMessageId: string | null; itemId: string }>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ providerMessageId: string | null; itemId: string }>(
      `SELECT provider_message_id AS "providerMessageId", item_id AS "itemId"
         FROM mail_message_meta WHERE mailbox_item_id = $1 ORDER BY provider_message_id`,
      [mailboxItemId],
    );
    return rows;
  });
}

/** A Gmail account that holds `messageIds` in its inbox; `calls` lists the listing calls a pass made. */
function gmailAccount(messageIds: string[]): { client: GmailMailClient; calls: string[] } {
  const calls: string[] = [];
  const client: GmailMailClient = {
    getCurrentHistoryId: async () => "9000",
    listHistorySince: async () => {
      calls.push("listHistorySince");
      return { invalidated: false, newHistoryId: "9000", changedMessageIds: [], removedMessageIds: [] };
    },
    listAllMessageIds: async () => {
      calls.push("listAllMessageIds");
      return messageIds;
    },
    listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
    fetchMessage: async (id) =>
      messageIds.includes(id)
        ? {
            id,
            threadId: `thread-of-${id}`,
            labelIds: ["INBOX"],
            message: {
              messageId: `<${id}@mail.example.test>`,
              subject: id,
              envelope: { from: { address: "sender@example.test" } },
              attachments: [],
            },
          }
        : null,
    modifyMessageLabels: async () => undefined,
  };
  return { client, calls };
}

/** One `mailAccountSync` pass through the production handler; returns the credentials it presented to the provider. */
async function syncPass(mailboxItemId: string, gmail: GmailMailClient): Promise<string[]> {
  const presented: string[] = [];
  await runInTenant(tenant, async () => {
    const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    await handleSyncMailAccountTask(
      runtime,
      { mailboxItemId },
      {
        createGmailClient: (_mailboxItemId, credential) => {
          presented.push(credential);
          return gmail;
        },
      },
      moduleIds,
      storage,
    );
  });
  return presented;
}

/** A transaction of the tenant that has run its first statements and stays open until `release()`. */
interface OpenTransaction {
  /** The transaction's backend, for `pg_blocking_pids`. */
  pid: number;
  /** Lets the transaction run its last statements and commit. */
  release: () => void;
  /** Settles when the transaction has ended, with its error when it failed. */
  ended: Promise<void>;
}

/**
 * Runs `hold` in a transaction of the tenant and resolves once those statements have run, with the
 * transaction still open. After `release()` it runs `afterRelease` and commits. A `hold` that fails
 * rejects this call with its error.
 */
async function holdTransactionOpen(
  hold: (client: PoolClient) => Promise<void>,
  afterRelease: (client: PoolClient) => Promise<void> = async () => {},
): Promise<OpenTransaction> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportPid: (pid: number) => void = () => {};
  const started = new Promise<number>((resolve) => {
    reportPid = resolve;
  });
  const ended = inTenant(async (client) => {
    await hold(client);
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error("the open transaction's backend has no pid");
    reportPid(pid);
    await released;
    await afterRelease(client);
  });
  const pid = await Promise.race([
    started,
    ended.then(() => {
      throw new Error("the transaction ended before it reported its backend");
    }),
  ]);
  return { pid, release, ended };
}

/**
 * Whether an operation in flight waits for a lock of backend `pid`: `false` as soon as `settled()` says the
 * operation has ended, `true` as soon as one backend shows up as blocked by `pid`.
 */
function waitsForBackend(pid: number, settled: () => boolean): Promise<boolean> {
  return vi.waitFor(
    async () => {
      if (settled()) return false;
      const { rows } = await admin.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      if (rows[0]?.waiting !== 1) throw new Error("the operation has neither ended nor started to wait");
      return true;
    },
    { timeout: 10_000, interval: 25 },
  );
}

/** The kinds of the notifications written about the mailbox. */
function notificationKindsOf(mailboxItemId: string): Promise<string[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ kind: string }>(
      "SELECT kind FROM notifications WHERE source_id = $1 ORDER BY kind",
      [mailboxItemId],
    );
    return rows.map((row) => row.kind);
  });
}

/** The mailbox's Semp problem (issue #1506): its severity, how many passes reported it and whether it is resolved. */
function mailProblemsOf(
  mailboxItemId: string,
): Promise<Array<{ severity: string; occurrences: number; resolved: boolean }>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ severity: string; occurrences: number; resolved: boolean }>(
      `SELECT severity, occurrence_count AS occurrences, resolved_at IS NOT NULL AS resolved
         FROM semp_problems WHERE dedupe_key = $1`,
      [mailProblemKey(mailboxItemId)],
    );
    return rows;
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Google answering a sign-in of `GOOGLE_ACCOUNT` with `NEW_REFRESH_TOKEN`. */
const googleSignIn: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === GOOGLE_TOKEN_URL) {
    return json({
      access_token: "access-token",
      expires_in: 3600,
      refresh_token: NEW_REFRESH_TOKEN,
      token_type: "Bearer",
    });
  }
  if (url === GMAIL_PROFILE_URL) return json({ emailAddress: GOOGLE_ACCOUNT });
  if (url === GMAIL_SEND_AS_URL) return json({ sendAs: [] });
  throw new Error(`unexpected provider request to ${url}`);
};

/**
 * The reauthorization of issue gh-1742 as the two routes run it: `POST /api/mail/mailboxes/:id/reauthorize`,
 * then `POST /api/mail/mailboxes/oauth/complete` with the state of the answered URL. Returns the
 * completion's answer and the mailboxes whose live-sync lifecycle it restarted.
 */
async function reauthorize(
  mailboxItemId: string,
  userId: string,
): Promise<{ answer: { status: number; body: unknown }; restarted: string[] }> {
  const identity = { user: { id: userId } };
  const started = await runInTenant(tenant, () =>
    createMailboxReauthorizeRouteHandler(runtime, { oauth: OAUTH })({ identity, params: { id: mailboxItemId } }),
  );
  const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(started.body);
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (state === null) throw new Error("the authorization URL carries no state");
  const restarted: string[] = [];
  const complete = createMailOauthCompleteRouteHandler(runtime, {
    oauth: OAUTH,
    outboundHttp: googleSignIn,
    mailLiveSync: {
      async restartAccount(id) {
        restarted.push(id);
      },
    },
  });
  const answer = await runInTenant(tenant, () => complete({ identity, body: { state, code: "authorization-code" } }));
  return { answer, restarted };
}

describe("mailbox restore hook (gh-2032)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    // A registry has no unregister: both hooks stay for the file and refuse only the item a test names.
    registerItemDeleteHook(async (context) => {
      if (vetoedTrash === context.item.id) throw new Error("removal interrupted");
    });
    registerItemRestoreHook(async (context) => {
      restoreCalls.push({
        itemId: context.item.id,
        rootItemId: context.rootItemId,
        writerKind: context.writerKind,
        agentRunId: context.agentRunId,
        actingUserId: context.actingUserId,
      });
      if (vetoedRestore === context.item.id) throw new Error("restore refused");
    });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
    vetoedTrash = null;
    vetoedRestore = null;
    restoreCalls = [];
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("brings a removed mailbox back with a default sync state, syncStatus needsReauthorization and its folders and messages, and leaves what was trashed on its own in the trash", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const seeded = await inTenant(async (client) => {
      const work = await createMailbox(client, ids, "Work");
      await connect(client, work.id);
      const other = await createMailbox(client, ids, "Private");
      const inInbox = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m1@x>" });
      const inTwoFolders = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m2@x>" });
      await ingest(client, ids, { mailboxId: work.id, folder: work.archive, messageId: "<m2@x>" });
      const trashedBefore = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m3@x>" });
      const inTrashedFolder = await ingest(client, ids, { mailboxId: work.id, folder: work.junk, messageId: "<m4@x>" });
      const otherMessage = await ingest(client, ids, { mailboxId: other.id, folder: other.inbox, messageId: "<n1@x>" });
      return { work, other, inInbox, inTwoFolders, trashedBefore, inTrashedFolder, otherMessage };
    });
    const { work, other } = seeded;
    // A message and a folder the user trashed before the removal, each at a time of its own.
    await softDelete(ids.emails, seeded.trashedBefore);
    await softDelete(ids.folders, work.junk);
    const members = [seeded.inInbox, seeded.inTwoFolders, work.inbox, work.archive];
    const trashedOnTheirOwn = [seeded.trashedBefore, work.junk];
    const otherFolders = [other.inbox, other.archive, other.junk];
    const threadsBefore = await listedThreadCount();

    await removeWithMail(work.id);

    const removed = await trashTimes([work.id, ...members, ...trashedOnTheirOwn]);
    // The removal job gave its members the mailbox's deletion time; the two others kept their own.
    const epoch = removed[work.id];
    expect(epoch).not.toBeNull();
    expect(members.map((id) => removed[id])).toEqual(members.map(() => epoch));
    for (const id of trashedOnTheirOwn) {
      expect(removed[id]).not.toBeNull();
      expect(removed[id]).not.toBe(epoch);
    }
    expect(await syncStateRows(work.id)).toEqual([]);
    expect((await listedItemIds(ids.folders)).sort()).toEqual([...otherFolders].sort());
    expect((await listedItemIds(ids.emails)).sort()).toEqual([seeded.inTrashedFolder, seeded.otherMessage].sort());
    expect(await listedThreadCount()).toBeLessThan(threadsBefore);

    const restored = await restore(ids, work.id);

    expect(restored?.id).toBe(work.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.properties.syncStatus).toBe("needsReauthorization");
    expect(await syncStatusOf(work.id)).toBe("needsReauthorization");
    // A default row for the provider: the cursor, the activity record and the address of the old row are gone.
    await expectDefaultSyncState(work.id, "gmail_api");
    // The credential is not restored: the user signs in again.
    expect(await inTenant((client) => hasCredential(client, work.id))).toBe(false);

    // The mailbox, its folders and its messages are live and listed again.
    const after = await trashTimes([work.id, ...members, ...trashedOnTheirOwn, seeded.inTrashedFolder]);
    expect(after).toEqual({
      ...allLive([work.id, ...members, seeded.inTrashedFolder]),
      // What was trashed on its own is still in the trash, with the deletion time it had.
      [seeded.trashedBefore]: removed[seeded.trashedBefore],
      [work.junk]: removed[work.junk],
    });
    expect((await listedItemIds(ids.mailboxes)).sort()).toEqual([work.id, other.id].sort());
    expect((await listedItemIds(ids.folders)).sort()).toEqual([work.inbox, work.archive, ...otherFolders].sort());
    expect((await listedItemIds(ids.emails)).sort()).toEqual(
      [seeded.inInbox, seeded.inTwoFolders, seeded.inTrashedFolder, seeded.otherMessage].sort(),
    );
    expect(await listedThreadCount()).toBe(threadsBefore);
  });

  it("restores what an interrupted removal job had trashed while its folders are still live, and the job then leaves the mailbox alone", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const { mailbox, emails } = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      const made: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        made.push(
          await ingest(client, ids, { mailboxId: created.id, folder: created.inbox, messageId: `<m${index}@x>` }),
        );
      }
      // The job pages in the database's uuid order; node's default sort of canonical uuid text is the same order.
      return { mailbox: created, emails: made.sort() };
    });
    const folders = [mailbox.inbox, mailbox.archive, mailbox.junk];
    await remove(mailbox.id);
    // The third message is in the second chunk of two: its refused trash fails that chunk and the run.
    vetoedTrash = emails[2] ?? null;
    await expect(runRemovalJob(mailbox.id, { chunkSize: 2 })).rejects.toThrow("removal interrupted");
    vetoedTrash = null;
    const interrupted = await trashTimes([mailbox.id, ...emails, ...folders]);
    const epoch = interrupted[mailbox.id];
    expect(epoch).not.toBeNull();
    expect(interrupted).toEqual({
      [mailbox.id]: epoch,
      ...Object.fromEntries(emails.slice(0, 2).map((id) => [id, epoch])),
      ...allLive([...emails.slice(2), ...folders]),
    });

    expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();

    expect(await trashTimes([mailbox.id, ...emails, ...folders])).toEqual(allLive([mailbox.id, ...emails, ...folders]));
    // A rerun of the job finds the mailbox live and trashes nothing.
    await runRemovalJob(mailbox.id, { chunkSize: 2 });
    expect(await trashTimes([mailbox.id, ...emails, ...folders])).toEqual(allLive([mailbox.id, ...emails, ...folders]));
  });

  it("creates one sync state row when the mailbox is restored twice, and again one after a second removal", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant(async (client) => {
      const created = await createMailbox(client, ids, "Work");
      await connect(client, created.id);
      return created;
    });
    await removeWithMail(mailbox.id);

    expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();
    await expectDefaultSyncState(mailbox.id, "gmail_api");
    // The sign-in that follows a restore records the account on the row.
    await inTenant((client) => recordProviderAccountAddress(client, mailbox.id, GOOGLE_ACCOUNT));
    const afterFirst = await syncStateRows(mailbox.id);

    // The mailbox is live, so a second restore changes nothing.
    expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();
    expect(await syncStateRows(mailbox.id)).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(1);

    // A second removal deletes the row, and the restore after it creates one default row again.
    await removeWithMail(mailbox.id);
    expect(await syncStateRows(mailbox.id)).toEqual([]);
    expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();
    await expectDefaultSyncState(mailbox.id, "gmail_api");
  });

  it("leaves a sync state row that already exists exactly as it is", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant((client) => createMailbox(client, ids, "Work"));
    await removeWithMail(mailbox.id);
    // A trashed mailbox can have a row: the live-sync discovery inserts one for a mailbox it listed just
    // before the removal committed. This one has what a default row lacks, and another mode than the
    // provider's default.
    await inTenant(async (client) => {
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      await recordProviderAccountAddress(client, mailbox.id, GOOGLE_ACCOUNT);
      await recordGmailActivity(client, {
        itemId: mailbox.id,
        historyId: "4711",
        nextExpectedActivityAt: new Date("2031-01-01T00:00:00Z"),
      });
    });
    const before = await syncStateRows(mailbox.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      sync_mode: "imap",
      gmail_history_id: "4711",
      provider_account_address: GOOGLE_ACCOUNT,
    });

    expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();

    expect(await syncStateRows(mailbox.id)).toEqual(before);
    expect(await trashTimes([mailbox.id, mailbox.inbox])).toEqual(allLive([mailbox.id, mailbox.inbox]));
  });

  it("creates the sync mode of the mailbox's provider, and imap for a mailbox without one", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const cases: Array<{ provider: string | null; syncMode: string }> = [
      { provider: "gmail", syncMode: "gmail_api" },
      { provider: "outlook", syncMode: "graph_api" },
      { provider: "icloud", syncMode: "imap" },
      { provider: "generic", syncMode: "imap" },
      { provider: null, syncMode: "imap" },
    ];
    const mailboxes = await inTenant(async (client) => {
      const created: TestMailbox[] = [];
      for (const { provider } of cases) {
        created.push(await createMailbox(client, ids, `Mailbox ${provider ?? "without a provider"}`, provider));
      }
      return created;
    });
    for (const mailbox of mailboxes) await remove(mailbox.id);

    for (const mailbox of mailboxes) expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();

    for (const [index, { syncMode }] of cases.entries()) {
      await expectDefaultSyncState(mailboxes[index]?.id ?? "", syncMode);
    }
  });

  describe("a failing hook", () => {
    /** The removed mailbox's rows, as the failed restore must leave them. */
    async function removedMailbox() {
      const ids = await inTenant((client) => loadIds(client));
      const seeded = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        await connect(client, mailbox.id);
        const first = await ingest(client, ids, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<m1@x>" });
        const second = await ingest(client, ids, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<m2@x>" });
        return { mailbox, emails: [first, second].sort() };
      });
      await removeWithMail(seeded.mailbox.id);
      const rows = [
        seeded.mailbox.id,
        seeded.mailbox.inbox,
        seeded.mailbox.archive,
        seeded.mailbox.junk,
        ...seeded.emails,
      ];
      const before = await trashTimes(rows);
      expect(Object.values(before)).toEqual(rows.map(() => before[seeded.mailbox.id]));
      expect(before[seeded.mailbox.id]).not.toBeNull();
      return { ids, ...seeded, rows, before };
    }

    it("leaves the mailbox, its folders and its messages in the trash when the sync state cannot be created", async () => {
      const { ids, mailbox, rows, before } = await removedMailbox();
      const events: InvalidationEvent[] = [];

      // A trigger is the only way to fail the hook's first statement; no production code exposes that seam.
      await admin.query(`CREATE FUNCTION test_mailbox_restore_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test mailbox restore failure'; END $$`);
      try {
        await admin.query(
          `CREATE TRIGGER test_mailbox_restore_fail BEFORE INSERT ON mail_account_sync_state
             FOR EACH ROW EXECUTE FUNCTION test_mailbox_restore_fail()`,
        );
        setInvalidationHook((event) => events.push(event));
        await expect(restore(ids, mailbox.id)).rejects.toThrow("test mailbox restore failure");
      } finally {
        setInvalidationHook(() => {});
        await admin.query("DROP TRIGGER IF EXISTS test_mailbox_restore_fail ON mail_account_sync_state");
        await admin.query("DROP FUNCTION test_mailbox_restore_fail()");
      }

      expect(await trashTimes(rows)).toEqual(before);
      expect(await syncStateRows(mailbox.id)).toEqual([]);
      expect(await syncStatusOf(mailbox.id)).toBe("needsReauthorization");
      expect((await listedItemIds(ids.mailboxes)).includes(mailbox.id)).toBe(false);
      // The rolled-back restore announced nothing.
      expect(events).toEqual([]);

      // With the failure gone the same restore succeeds, so the rollback left nothing half-done.
      expect((await restore(ids, mailbox.id))?.deletedAt).toBeNull();
      expect(await trashTimes(rows)).toEqual(allLive(rows));
      await expectDefaultSyncState(mailbox.id, "gmail_api");
    });

    it("rolls the sync state and the folders already restored back when the restore of the last message fails", async () => {
      const { ids, mailbox, emails, rows, before } = await removedMailbox();
      const lastEmail = emails.at(-1) ?? "";

      vetoedRestore = lastEmail;
      await expect(restore(ids, mailbox.id)).rejects.toThrow("restore refused");
      vetoedRestore = null;

      // The hook had created the sync state and restored the folders and the first message by then.
      // Its nested restores ran before the mailbox's own call of the recording hook, which it never reached.
      expect(restoreCalls.map((call) => call.itemId)).toEqual([
        ...[mailbox.inbox, mailbox.archive, mailbox.junk].sort(),
        ...emails,
      ]);
      expect(await trashTimes(rows)).toEqual(before);
      expect(await syncStateRows(mailbox.id)).toEqual([]);
      expect((await listedItemIds(ids.folders)).length).toBe(0);
      expect((await listedItemIds(ids.emails)).length).toBe(0);
    });
  });

  it("restores the folders and messages with the writer and the acting user of the mailbox's restore", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const seeded = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, ids, "Work");
      const email = await ingest(client, ids, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<m1@x>" });
      return { mailbox, email };
    });
    const { mailbox, email } = seeded;
    const nested = [mailbox.inbox, mailbox.archive, mailbox.junk, email];
    const actingUserId = randomUUID();
    const agentRunId = randomUUID();
    await removeWithMail(mailbox.id);
    const events: InvalidationEvent[] = [];

    setInvalidationHook((event) => events.push(event));
    try {
      await restore(ids, mailbox.id, { actingUserId, writer: { writerKind: "agent", agentRunId } });
    } finally {
      setInvalidationHook(() => {});
    }

    // Each folder and message is the root of its own nested restore, made by the same writer for the same user.
    expect([...restoreCalls].sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
      [mailbox.id, ...nested]
        .sort()
        .map((itemId) => ({ itemId, rootItemId: itemId, writerKind: "agent", agentRunId, actingUserId })),
    );
    const announced = events.flatMap((event) =>
      event.scope === "item" ? [{ itemId: event.itemId, op: event.op, userId: event.userId }] : [],
    );
    expect(announced.sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
      [mailbox.id, ...nested].sort().map((itemId) => ({ itemId, op: "update", userId: actingUserId })),
    );

    // A restore that names no writer and no user restores them as the system.
    await removeWithMail(mailbox.id);
    restoreCalls = [];
    await restore(ids, mailbox.id);
    expect([...restoreCalls].sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
      [mailbox.id, ...nested].sort().map((itemId) => ({
        itemId,
        rootItemId: itemId,
        writerKind: "system",
        agentRunId: undefined,
        actingUserId: undefined,
      })),
    );
  });

  it("does nothing for a restored item of another database, also one that is not a system database and carries the mailboxes module id", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant((client) => createMailbox(client, ids, "Work"));
    const userDatabase = await runInTenant(tenant, () =>
      chokePoint.createDatabase({ name: "Notes", ownerModuleId: MAILBOXES_MODULE_ID }),
    );
    expect(userDatabase.system).toBe(false);
    const note = await inTenant((client) =>
      createItemWithClient(client, { databaseId: userDatabase.id, properties: {} }),
    );
    await softDelete(ids.folders, mailbox.junk);
    await softDelete(userDatabase.id, note.id);

    // A system database that is not Mailboxes, and a database of the user's own.
    expect((await runInTenant(tenant, () => chokePoint.restoreItem(ids.folders, mailbox.junk)))?.deletedAt).toBeNull();
    expect((await runInTenant(tenant, () => chokePoint.restoreItem(userDatabase.id, note.id)))?.deletedAt).toBeNull();

    // The restore hooks ran for both items, and the tenant still has no sync state row at all.
    expect(restoreCalls.map((call) => call.itemId)).toEqual([mailbox.junk, note.id]);
    const { rows } = await inTenant((client) =>
      client.query<{ n: number }>("SELECT count(*)::int AS n FROM mail_account_sync_state"),
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("leaves another mailbox's folder and message in the trash although they carry the mailbox's deletion time", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const seeded = await inTenant(async (client) => {
      const work = await createMailbox(client, ids, "Work");
      const other = await createMailbox(client, ids, "Private");
      const mine = await ingest(client, ids, { mailboxId: work.id, folder: work.inbox, messageId: "<m1@x>" });
      const theirs = await ingest(client, ids, { mailboxId: other.id, folder: other.inbox, messageId: "<n1@x>" });
      return { work, other, mine, theirs };
    });
    const { work, other } = seeded;
    await removeWithMail(work.id);
    // The other mailbox stays live. Its message and one of its folders join this mailbox's deletion time
    // through the choke point's own option, the one way to give two unrelated rows one `deleted_at`.
    await inTenant(async (client) => {
      const deletedAtExact = await lockItemTrashEpoch(client, ids.mailboxes, work.id);
      if (deletedAtExact === null) throw new Error("the removed mailbox has no trash epoch");
      const options = { queueAffinity: createActionQueueAffinity(), deletedAtExact };
      await itemDeleteWithClient(client, ids.emails, seeded.theirs, options);
      await itemDeleteWithClient(client, ids.folders, other.archive, options);
    });
    const removed = await trashTimes([work.id, seeded.mine, seeded.theirs, other.archive]);
    expect(removed[work.id]).not.toBeNull();
    expect(Object.values(removed)).toEqual(Array.from({ length: 4 }, () => removed[work.id]));

    expect((await restore(ids, work.id))?.deletedAt).toBeNull();

    expect(await trashTimes([work.id, work.inbox, seeded.mine, seeded.theirs, other.archive])).toEqual({
      ...allLive([work.id, work.inbox, seeded.mine]),
      [seeded.theirs]: removed[seeded.theirs],
      [other.archive]: removed[other.archive],
    });
  });

  it.each(["folder", "message"] as const)(
    "leaves a %s in the trash that another transaction restored and trashed again while the restore waited for its row",
    async (kind) => {
      const ids = await inTenant((client) => loadIds(client));
      const seeded = await inTenant(async (client) => {
        const mailbox = await createMailbox(client, ids, "Work");
        const email = await ingest(client, ids, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<m1@x>" });
        return { mailbox, email };
      });
      const { mailbox, email } = seeded;
      await removeWithMail(mailbox.id);
      const contested =
        kind === "folder"
          ? { databaseId: ids.folders, itemId: mailbox.archive }
          : { databaseId: ids.emails, itemId: email };
      const others = [mailbox.id, mailbox.inbox, mailbox.archive, mailbox.junk, email].filter(
        (id) => id !== contested.itemId,
      );
      const epoch = (await trashTimes([contested.itemId]))[contested.itemId];
      expect(epoch).not.toBeNull();

      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reportHolder: (pid: number) => void = () => {};
      const holderPid = new Promise<number>((resolve) => {
        reportHolder = resolve;
      });
      // The holder restores the row and trashes it again, at its own time, and stays uncommitted: every
      // other transaction still reads the row with the mailbox's deletion time.
      const holder = inTenant(async (client) => {
        const queueAffinity = createActionQueueAffinity();
        await restoreItemWithClient(client, contested.databaseId, contested.itemId, queueAffinity);
        await itemDeleteWithClient(client, contested.databaseId, contested.itemId, { queueAffinity });
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("the holder's backend has no pid");
        reportHolder(pid);
        await released;
      });
      let restoreSettled = false;
      let restoring: ReturnType<typeof restore> | undefined;
      try {
        const pid = await holderPid;
        restoring = restore(ids, mailbox.id).finally(() => {
          restoreSettled = true;
        });
        await vi.waitFor(
          async () => {
            const { rows } = await admin.query<{ waiting: number }>(
              "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [pid],
            );
            expect(rows[0]?.waiting).toBe(1);
          },
          { timeout: 10_000, interval: 25 },
        );
        expect(restoreSettled).toBe(false);
      } finally {
        release();
        await Promise.allSettled([holder, restoring]);
      }
      await holder;
      expect((await restoring)?.deletedAt).toBeNull();

      // The row no longer has the mailbox's deletion time, so it stays in the trash with the holder's.
      const after = await trashTimes([contested.itemId, ...others]);
      expect(after[contested.itemId]).not.toBeNull();
      expect(after[contested.itemId]).not.toBe(epoch);
      expect(others.map((id) => after[id])).toEqual(others.map(() => null));
    },
  );

  it("does not wait for an uncommitted update of the mailbox's sync state row, so a sync pass that records a failure and then writes syncStatus does not deadlock with the restore", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant((client) => createMailbox(client, ids, "Work"));
    await removeWithMail(mailbox.id);
    // A trashed mailbox can have a row: the live-sync discovery inserts one for a mailbox it listed just
    // before the removal committed. This one has what a default row of the provider lacks.
    await inTenant(async (client) => {
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      await recordProviderAccountAddress(client, mailbox.id, GOOGLE_ACCOUNT);
    });
    const before = await syncStateRows(mailbox.id);
    expect(before).toHaveLength(1);

    // The failure record of a sync pass that read the mailbox before its removal, in the order
    // `handleSyncMailAccountTask` writes it: the sync state row first, and the Mailboxes item second,
    // once the restore has had its turn.
    const failingPass = await holdTransactionOpen(
      async (client) => {
        await recordSyncError(client, mailbox.id, "connection refused", "other");
      },
      async (client) => {
        await updateItemWithClient(
          client,
          { databaseId: ids.mailboxes, itemId: mailbox.id, propertiesPatch: { syncStatus: "error" } },
          { allowedSystemKeys: ["syncStatus"] },
        );
      },
    );
    let restoreSettled = false;
    let restoring: ReturnType<typeof restore> | undefined;
    try {
      restoring = restore(ids, mailbox.id).finally(() => {
        restoreSettled = true;
      });
      // The restore holds the Mailboxes item. Waiting for the row here would be the other half of a deadlock.
      expect(await waitsForBackend(failingPass.pid, () => restoreSettled)).toBe(false);
      expect((await restoring)?.deletedAt).toBeNull();
      // The restore committed while the other transaction was open, and wrote nothing on the row.
      expect(await syncStateRows(mailbox.id)).toEqual(before);
    } finally {
      failingPass.release();
      await Promise.allSettled([failingPass.ended, restoring]);
    }
    await failingPass.ended;

    // Both transactions committed: the mailbox is live, with the failure the pass recorded on its old row.
    expect(await trashTimes([mailbox.id])).toEqual(allLive([mailbox.id]));
    expect(await syncStatusOf(mailbox.id)).toBe("error");
    const after = await syncStateRows(mailbox.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      sync_mode: "imap",
      provider_account_address: GOOGLE_ACCOUNT,
      last_error: "connection refused",
      last_failure_kind: "other",
    });
  });

  it("waits for a transaction that has inserted the mailbox's sync state row and then keeps that row as it is", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mailbox = await inTenant((client) => createMailbox(client, ids, "Work"));
    await removeWithMail(mailbox.id);
    expect(await syncStateRows(mailbox.id)).toEqual([]);

    // The insert the live-sync discovery makes for a mailbox it listed just before the removal committed,
    // still uncommitted. It has another mode than the provider's default, to tell it from the hook's row.
    const discovery = await holdTransactionOpen(async (client) => {
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
    });
    let restoreSettled = false;
    let restoring: ReturnType<typeof restore> | undefined;
    try {
      restoring = restore(ids, mailbox.id).finally(() => {
        restoreSettled = true;
      });
      // The hook reads no row and inserts one, and that insert waits for the one in flight.
      expect(await waitsForBackend(discovery.pid, () => restoreSettled)).toBe(true);
      expect(restoreSettled).toBe(false);
    } finally {
      discovery.release();
      await Promise.allSettled([discovery.ended, restoring]);
    }
    await discovery.ended;
    expect((await restoring)?.deletedAt).toBeNull();

    const rows = await syncStateRows(mailbox.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item_id: mailbox.id, sync_mode: "imap" });
    expect(await trashTimes([mailbox.id, mailbox.inbox])).toEqual(allLive([mailbox.id, mailbox.inbox]));
  });

  it("leaves a second tenant's removed mailbox untouched, and that tenant cannot restore this one", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const mine = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, ids, "Work");
      await connect(client, mailbox.id);
      const email = await ingest(client, ids, { mailboxId: mailbox.id, folder: mailbox.inbox, messageId: "<m1@x>" });
      return { mailbox, email };
    });
    const otherTenant = await createTestTenant(admin);
    await provisionTenant(runtime, otherTenant);
    const otherIds = await inTenant((client) => loadIds(client), otherTenant);
    const theirs = await inTenant(async (client) => {
      const mailbox = await createMailbox(client, otherIds, "Theirs");
      const email = await ingest(client, otherIds, {
        mailboxId: mailbox.id,
        folder: mailbox.inbox,
        messageId: "<m1@x>",
      });
      return { mailbox, email };
    }, otherTenant);
    await removeWithMail(mine.mailbox.id);
    await removeWithMail(theirs.mailbox.id, otherTenant);
    const myRows = [mine.mailbox.id, mine.mailbox.inbox, mine.mailbox.archive, mine.mailbox.junk, mine.email];
    const theirRows = [
      theirs.mailbox.id,
      theirs.mailbox.inbox,
      theirs.mailbox.archive,
      theirs.mailbox.junk,
      theirs.email,
    ];
    const mineRemoved = await trashTimes(myRows);
    const theirsRemoved = await trashTimes(theirRows, otherTenant);
    expect(Object.values(theirsRemoved).every((deletedAt) => deletedAt !== null)).toBe(true);
    expect(Object.keys(theirsRemoved)).toHaveLength(theirRows.length);

    // The other tenant names this tenant's mailbox: row-level security hides it, as it hides an unknown id.
    expect(
      await runInTenant(otherTenant, () => chokePoint.restoreItem(otherIds.mailboxes, mine.mailbox.id)),
    ).toBeNull();
    expect(await runInTenant(otherTenant, () => chokePoint.restoreItem(otherIds.mailboxes, randomUUID()))).toBeNull();
    expect(await trashTimes(myRows)).toEqual(mineRemoved);
    expect(await syncStateRows(mine.mailbox.id)).toEqual([]);
    expect(await trashTimes(myRows, otherTenant)).toEqual({});

    expect((await restore(ids, mine.mailbox.id))?.deletedAt).toBeNull();

    expect(await trashTimes(myRows)).toEqual(allLive(myRows));
    await expectDefaultSyncState(mine.mailbox.id, "gmail_api");
    // The other tenant's mailbox, folders and message are still in the trash, and it has no sync state.
    expect(await trashTimes(theirRows, otherTenant)).toEqual(theirsRemoved);
    expect(await syncStateRows(theirs.mailbox.id, otherTenant)).toEqual([]);
    expect(await syncStateRows(mine.mailbox.id, otherTenant)).toEqual([]);
    expect(await listedItemIds(otherIds.emails, otherTenant)).toEqual([]);

    // Its own restore then brings its own rows back, and only those.
    expect((await restore(otherIds, theirs.mailbox.id, { tenantId: otherTenant }))?.deletedAt).toBeNull();
    expect(await trashTimes(theirRows, otherTenant)).toEqual(allLive(theirRows));
    await expectDefaultSyncState(theirs.mailbox.id, "gmail_api", otherTenant);
    expect(await syncStateRows(mine.mailbox.id)).toHaveLength(1);
  });

  it("keeps syncStatus needsReauthorization through the sync passes that run before the user signs in again, and writes no mail_sync_error notification for them", async () => {
    const ids = await inTenant((client) => loadIds(client));
    // The tenant's user: the one a `mail_sync_error` notification and the mailbox's problem are written for.
    const userId = (
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" })
    ).id;
    const mailboxId = await inTenant(async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxes,
        properties: { name: "Work", provider: "gmail" },
      });
      await connect(client, mailbox.id);
      return mailbox.id;
    });
    await removeWithMail(mailboxId);
    expect((await restore(ids, mailboxId))?.deletedAt).toBeNull();
    expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
    // The default row is due at once, so the periodic sweep queues a pass before the user has signed in.
    expect((await inTenant((client) => listAccountsDueForSync(client))).map((account) => account.itemId)).toEqual([
      mailboxId,
    ]);

    // Two passes, as two sweeps queue them. Neither finds a credential, and neither reaches the provider.
    const gmail = gmailAccount([]);
    for (let pass = 0; pass < 2; pass += 1) {
      const failed = syncPass(mailboxId, gmail.client);
      await expect(failed).rejects.toBeInstanceOf(MailReauthorizationRequiredError);
      await expect(failed).rejects.toThrow("has no stored credential");
    }
    expect(gmail.calls).toEqual([]);

    // The mailbox is still waiting for the sign-in: that is what the status, the failure kind, the
    // critical problem and the mail summary say, and no "mail sync failed" notification was written.
    expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
    const waiting = await syncStateRows(mailboxId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ sync_mode: "gmail_api", last_failure_kind: "reauthorization" });
    expect(waiting[0]?.failing_since).not.toBeNull();
    expect(await notificationKindsOf(mailboxId)).toEqual([]);
    expect(await mailProblemsOf(mailboxId)).toEqual([{ severity: "critical", occurrences: 2, resolved: false }]);
    const summary = await runInTenant(tenant, () => createMailSummaryRouteHandler(runtime)());
    expect(summary.body.accountsNeedingReauth).toEqual([{ id: mailboxId, name: "Work" }]);

    // The sign-in still works after those passes, and the pass it queues clears all of it.
    const { answer } = await reauthorize(mailboxId, userId);
    expect(answer).toEqual({ status: 200, body: { mailboxId } });
    expect(await syncPass(mailboxId, gmail.client)).toEqual([NEW_REFRESH_TOKEN]);
    expect(await syncStatusOf(mailboxId)).toBe("ok");
    expect((await syncStateRows(mailboxId))[0]).toMatchObject({
      last_error: null,
      last_failure_kind: null,
      failing_since: null,
    });
    expect(await notificationKindsOf(mailboxId)).toEqual([]);
    expect(await mailProblemsOf(mailboxId)).toEqual([{ severity: "critical", occurrences: 2, resolved: true }]);
  });

  it("lets the user sign in again after the restore: sync resumes with the new token and duplicates neither the restored messages nor their folders", async () => {
    const ids = await inTenant((client) => loadIds(client));
    const userId = (
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" })
    ).id;
    const mailboxId = await inTenant(async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxes,
        properties: { name: "Work", provider: "gmail" },
      });
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "oauth2_refresh_token",
        plaintext: OLD_REFRESH_TOKEN,
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
      await recordProviderAccountAddress(client, mailbox.id, GOOGLE_ACCOUNT);
      return mailbox.id;
    });
    // The first sync brings in two messages and creates the mailbox's folders.
    expect(await syncPass(mailboxId, gmailAccount(["g1", "g2"]).client)).toEqual([OLD_REFRESH_TOKEN]);
    const synced = await messagesOf(mailboxId);
    expect(synced.map((message) => message.providerMessageId)).toEqual(["g1", "g2"]);
    const syncedEmailIds = synced.map((message) => message.itemId);
    const syncedFolderIds = await folderIdsOf(ids, mailboxId);
    expect(syncedFolderIds.length).toBeGreaterThan(0);
    expect((await listedItemIds(ids.emails)).sort()).toEqual([...syncedEmailIds].sort());

    await removeWithMail(mailboxId);
    expect(await listedItemIds(ids.emails)).toEqual([]);
    expect(await listedItemIds(ids.folders)).toEqual([]);
    expect((await restore(ids, mailboxId))?.deletedAt).toBeNull();
    expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
    await expectDefaultSyncState(mailboxId, "gmail_api");

    const { answer, restarted } = await reauthorize(mailboxId, userId);

    expect(answer).toEqual({ status: 200, body: { mailboxId } });
    expect(restarted).toEqual([mailboxId]);
    expect(
      await inTenant((client) =>
        getDecryptedCredential(client, { itemId: mailboxId, actorType: "sync_worker", purpose: "test" }),
      ),
    ).toBe(NEW_REFRESH_TOKEN);
    const reauthorized = await syncStateRows(mailboxId);
    expect(reauthorized).toHaveLength(1);
    expect(reauthorized[0]).toMatchObject({
      sync_mode: "gmail_api",
      provider_account_address: GOOGLE_ACCOUNT,
      gmail_history_id: null,
    });
    const queued = await admin.query<{ due: boolean }>(
      "SELECT run_at <= now() AS due FROM graphile_worker.jobs WHERE key = $1",
      [`mail-account-sync:${mailboxId}`],
    );
    expect(queued.rows).toEqual([{ due: true }]);

    // The queued sync, as the worker runs it: the account still holds the two messages, and a third arrived.
    const gmail = gmailAccount(["g1", "g2", "g3"]);
    expect(await syncPass(mailboxId, gmail.client)).toEqual([NEW_REFRESH_TOKEN]);

    // The default row has no cursor, so the pass listed the whole account, and matched what it already had.
    expect(gmail.calls).toEqual(["listAllMessageIds"]);
    const resumed = await messagesOf(mailboxId);
    expect(resumed.map((message) => message.providerMessageId)).toEqual(["g1", "g2", "g3"]);
    expect(resumed.slice(0, 2)).toEqual(synced);
    const newEmailId = resumed[2]?.itemId ?? "";
    expect(syncedEmailIds).not.toContain(newEmailId);
    expect((await listedItemIds(ids.emails)).sort()).toEqual([...syncedEmailIds, newEmailId].sort());
    expect(await folderIdsOf(ids, mailboxId)).toEqual(syncedFolderIds);
    expect((await listedItemIds(ids.folders)).sort()).toEqual([...syncedFolderIds].sort());
    expect(await syncStatusOf(mailboxId)).toBe("ok");
    expect((await syncStateRows(mailboxId))[0]).toMatchObject({ gmail_history_id: "9000" });
  });
});
