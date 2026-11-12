import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant, TenantScopeMissingError } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import type { GmailMailClient } from "../mail/gmailReconcile.js";
import type { GraphMailClient } from "../mail/graphReconcile.js";
import type { ImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import {
  deleteMailAccountSyncState,
  ensureMailAccountSyncState,
  SYNC_MODES,
  type SyncMode,
} from "../mail/mailAccountSyncStateStore.js";
import { deleteMailFolderSyncStatesOfMailbox, ensureMailFolderSyncState } from "../mail/mailFolderSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { handleSyncMailAccountTask, type MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { createMailboxRemovalRouteHandler, removeMailbox } from "../mail/mailboxRemoval.js";
import { lockMailboxSync } from "../mail/mailboxSyncGuard.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

/** A Mailboxes item with two Folders, each related to it through the production folder edge. */
interface TestMailbox {
  id: string;
  inbox: string;
  archive: string;
}

/** Everything the removal writes or deletes for one mailbox, as stored. */
interface MailboxSnapshot {
  item: Array<{ properties: unknown; updatedAt: string; deletedAt: string | null }>;
  credential: Array<{ ciphertext: string; nonce: string }>;
  accountState: Array<{ syncMode: string }>;
  folderStates: string[];
  serverSettings: Array<{ imapHost: string | null; smtpHost: string | null; username: string }>;
}

const REMOVED: Omit<MailboxSnapshot, "item"> = {
  credential: [],
  accountState: [],
  folderStates: [],
  serverSettings: [],
};

/** The tables the removal deletes from, in its order; a closed list, see `failDeletesFrom`. */
const DELETED_TABLES = [
  "external_credentials",
  "mail_account_sync_state",
  "mail_folder_sync_state",
  "mail_account_server_settings",
] as const;

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let tenant: string;

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A connected mailbox: a credential, an account sync state, a sync state for both folders and server settings. */
async function createConnectedMailbox(
  client: PoolClient,
  name: string,
  syncMode: SyncMode = "imap",
): Promise<TestMailbox> {
  const mailbox = await createBareMailbox(client, name);
  await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: `secret of ${name}` });
  await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode });
  await ensureMailFolderSyncState(client, mailbox.inbox);
  await ensureMailFolderSyncState(client, mailbox.archive);
  await upsertMailServerSettings(client, mailbox.id, {
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    username: "user@example.com",
  });
  return mailbox;
}

/** A mailbox that never connected: the item with `syncStatus` `ok` and its two folders, and none of the four kinds of rows. */
async function createBareMailbox(client: PoolClient, name: string): Promise<TestMailbox> {
  const mail = await resolveMailModuleIds(client);
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM properties WHERE database_id = $1 AND key = 'mailbox'",
    [mail.foldersDatabaseId],
  );
  const mailboxRelationPropertyId = rows[0]?.id;
  if (!mailboxRelationPropertyId) throw new Error("Folders.mailbox is not seeded");
  const mailbox = await createItemWithClient(
    client,
    { databaseId: mail.mailboxesDatabaseId, properties: { name, provider: "generic", syncStatus: "ok" } },
    { allowedSystemKeys: ["syncStatus"] },
  );
  const folder = (purpose: "inbox" | "archive"): Promise<string> =>
    ensureFolderItem(client, {
      foldersDatabaseId: mail.foldersDatabaseId,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId,
      providerId: purpose,
      name: purpose,
      behavior: "folder",
      specialPurpose: purpose,
    });
  return { id: mailbox.id, inbox: await folder("inbox"), archive: await folder("archive") };
}

/** Reads the mailbox's rows in `tenantId`'s scope, so a row of another tenant is absent from the snapshot. */
function snapshot(mailbox: TestMailbox, tenantId = tenant): Promise<MailboxSnapshot> {
  return inTenant(async (client) => {
    const item = await client.query<{ properties: unknown; updatedAt: string; deletedAt: string | null }>(
      `SELECT properties, updated_at::text AS "updatedAt", deleted_at::text AS "deletedAt" FROM items WHERE id = $1`,
      [mailbox.id],
    );
    const credential = await client.query<{ ciphertext: string; nonce: string }>(
      "SELECT encode(ciphertext, 'hex') AS ciphertext, encode(nonce, 'hex') AS nonce FROM external_credentials WHERE item_id = $1",
      [mailbox.id],
    );
    const accountState = await client.query<{ syncMode: string }>(
      `SELECT sync_mode AS "syncMode" FROM mail_account_sync_state WHERE item_id = $1`,
      [mailbox.id],
    );
    const folderStates = await client.query<{ item_id: string }>(
      "SELECT item_id FROM mail_folder_sync_state WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
      [[mailbox.inbox, mailbox.archive]],
    );
    const serverSettings = await client.query<{ imapHost: string | null; smtpHost: string | null; username: string }>(
      `SELECT imap_host AS "imapHost", smtp_host AS "smtpHost", username
         FROM mail_account_server_settings WHERE mailbox_item_id = $1`,
      [mailbox.id],
    );
    return {
      item: item.rows,
      credential: credential.rows,
      accountState: accountState.rows,
      folderStates: folderStates.rows.map((row) => row.item_id),
      serverSettings: serverSettings.rows,
    };
  }, tenantId);
}

function remove(mailboxItemId: string, tenantId = tenant): Promise<boolean> {
  return runInTenant(tenantId, () =>
    removeMailbox(runtime, mailboxItemId, { queueAffinity: createActionQueueAffinity() }),
  );
}

/** The trashed item of a removed mailbox: in the trash, with `syncStatus` `needsReauthorization`. */
function expectTrashedAsNeedsReauthorization(after: MailboxSnapshot): void {
  expect(after.item).toHaveLength(1);
  expect(after.item[0]?.deletedAt).not.toBeNull();
  expect(after.item[0]?.properties).toMatchObject({ syncStatus: "needsReauthorization" });
}

/**
 * Makes every row delete from `table` fail until the returned function runs. A trigger is the only
 * way to fail one statement of the removal's transaction; no production code exposes that seam.
 */
async function failDeletesFrom(table: (typeof DELETED_TABLES)[number]): Promise<() => Promise<void>> {
  await admin.query(`CREATE FUNCTION test_mailbox_removal_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test mailbox removal failure'; END $$`);
  // `table` is one of the literals of DELETED_TABLES, so it cannot break out of the statement;
  // CREATE TRIGGER and DROP TRIGGER accept no bind parameters.
  await admin.query(
    `CREATE TRIGGER test_mailbox_removal_fail BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_mailbox_removal_fail()`,
  );
  return async () => {
    await admin.query(`DROP TRIGGER test_mailbox_removal_fail ON ${table}`);
    await admin.query("DROP FUNCTION test_mailbox_removal_fail()");
  };
}

/** The passes of these tests ingest no attachment, so nothing is written to storage. */
const unusedStorage: BlobStorageWriter = {
  writeStream() {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

/**
 * Stub providers of an account without messages, one per sync mode. `calls` lists every provider call
 * a pass made, in order. `folders` are the IMAP folder paths, and `onSelectFolder` runs before the
 * IMAP stub answers the selection of a folder.
 */
function stubProviders(options: { folders?: string[]; onSelectFolder?: (path: string) => Promise<void> } = {}): {
  calls: string[];
  adapters: MailSyncAdapterFactory;
} {
  const calls: string[] = [];
  const called = <T>(name: string, answer: T): T => {
    calls.push(name);
    return answer;
  };
  const imap: ImapMailClient = {
    getCapabilities: async () => called("getCapabilities", new Set<string>()),
    listFolders: async () =>
      called(
        "listFolders",
        (options.folders ?? []).map((path) => ({ path })),
      ),
    selectFolder: async (path) => {
      calls.push(`selectFolder ${path}`);
      await options.onSelectFolder?.(path);
      return { uidvalidity: 1, uidnext: 1, highestModSeq: null };
    },
    fetchMessagesSince: async () => called("fetchMessagesSince", []),
    fetchVanishedSince: async () => called("fetchVanishedSince", []),
    fetchAllUids: async () => called("fetchAllUids", []),
    fetchFlagsChangedSince: async () => called("fetchFlagsChangedSince", []),
    setMessageFlag: async () => called("setMessageFlag", undefined),
    appendMessage: async () => called("appendMessage", undefined),
    close: async () => called("close", undefined),
  };
  const gmail: GmailMailClient = {
    getCurrentHistoryId: async () => called("getCurrentHistoryId", "1"),
    listHistorySince: async () =>
      called("listHistorySince", {
        invalidated: false,
        newHistoryId: "1",
        changedMessageIds: [],
        removedMessageIds: [],
      }),
    listAllMessageIds: async () => called("listAllMessageIds", []),
    fetchMessage: async () => called("fetchMessage", null),
    listLabels: async () => called("listLabels", []),
    modifyMessageLabels: async () => called("modifyMessageLabels", undefined),
  };
  const graph: GraphMailClient = {
    listFolders: async () => called("listFolders", []),
    fetchDelta: async () => called("fetchDelta", { invalidated: false, newDeltaLink: "delta-1", changes: [] }),
    patchMessage: async () => called("patchMessage", undefined),
  };
  return {
    calls,
    adapters: {
      createImapClient: async () => called("createImapClient", imap),
      createGmailClient: () => gmail,
      createGraphClient: () => graph,
    },
  };
}

/** One `mailAccountSync` pass through the production handler, in the tenant's scope on the runtime role. */
function syncPass(
  mailboxItemId: string,
  adapters: MailSyncAdapterFactory,
  limiter?: ImapConnectionLimiter,
): Promise<void> {
  return runInTenant(tenant, async () => {
    const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    await handleSyncMailAccountTask(runtime, { mailboxItemId }, adapters, moduleIds, unusedStorage, undefined, limiter);
  });
}

/** A promise with its resolver, for the explicit signals of the concurrent tests. */
function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Waits for `reached`, and fails as soon as `work` ends first: its work was meant to stop at that point. */
function reachedBeforeEnd<T>(reached: Promise<T>, work: Promise<unknown>, what: string): Promise<T> {
  return Promise.race([
    reached,
    work.then(() => {
      throw new Error(`${what} ended before it reached its stop`);
    }),
  ]);
}

/** The backends of this database that wait for a lock, with the kind of lock each waits for. */
async function lockWaits(): Promise<Array<{ pid: number; lock: string }>> {
  const { rows } = await admin.query<{ pid: number; lock: string }>(
    `SELECT pid, wait_event AS lock FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' ORDER BY pid`,
  );
  return rows;
}

/** The backends that wait for a lock backend `holder` holds. */
async function backendsBlockedBy(holder: number): Promise<number[]> {
  const { rows } = await admin.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) ORDER BY pid",
    [holder],
  );
  return rows.map((row) => row.pid);
}

/**
 * How many transaction ids backend `pid` holds. A transaction gets its id with its first row lock or
 * write, so none means that it holds no row lock and has written nothing.
 */
async function transactionIdsHeldBy(pid: number): Promise<number> {
  const { rows } = await admin.query<{ held: number }>(
    "SELECT count(*)::int AS held FROM pg_locks WHERE pid = $1 AND locktype = 'transactionid' AND granted",
    [pid],
  );
  const held = rows[0]?.held;
  if (held === undefined) throw new Error("pg_locks returned no count");
  return held;
}

describe("mailbox removal (gh-1690)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("removeMailbox", () => {
    it("deletes the credential, both sync states and the server settings, trashes the mailbox as needsReauthorization and leaves another mailbox alone", async () => {
      const { mailbox, other } = await inTenant(async (client) => ({
        mailbox: await createConnectedMailbox(client, "Work"),
        other: await createConnectedMailbox(client, "Private"),
      }));
      // A trashed folder is still one of the mailbox's folders: its sync state goes too.
      const folders = await inTenant(async (client) => (await resolveMailModuleIds(client)).foldersDatabaseId);
      expect(await runInTenant(tenant, () => chokePoint.softDeleteItem(folders, mailbox.archive))).not.toBeNull();
      const before = await snapshot(mailbox);
      expect(before.credential).toHaveLength(1);
      expect(before.accountState).toEqual([{ syncMode: "imap" }]);
      expect(before.folderStates).toEqual([mailbox.inbox, mailbox.archive].sort());
      expect(before.serverSettings).toHaveLength(1);
      const otherBefore = await snapshot(other);

      expect(await remove(mailbox.id)).toBe(true);

      const after = await snapshot(mailbox);
      expect(after).toMatchObject(REMOVED);
      expectTrashedAsNeedsReauthorization(after);
      expect(await snapshot(other)).toEqual(otherBefore);
      expect(otherBefore.folderStates).toEqual([other.inbox, other.archive].sort());
    });

    it("removes a mailbox that never connected and so has none of the four kinds of rows", async () => {
      const mailbox = await inTenant((client) => createBareMailbox(client, "Never connected"));
      expect(await snapshot(mailbox)).toMatchObject(REMOVED);

      expect(await remove(mailbox.id)).toBe(true);

      const after = await snapshot(mailbox);
      expect(after).toMatchObject(REMOVED);
      expectTrashedAsNeedsReauthorization(after);
    });

    it.each(DELETED_TABLES)("leaves every row as it was when the delete from %s fails", async (table) => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const before = await snapshot(mailbox);
      expect(before.item[0]?.properties).toMatchObject({ syncStatus: "ok" });

      const restore = await failDeletesFrom(table);
      try {
        await expect(remove(mailbox.id)).rejects.toThrow("test mailbox removal failure");
      } finally {
        await restore();
      }

      // The status write and the trash ran before the failing delete and are rolled back with it.
      expect(await snapshot(mailbox)).toEqual(before);
      expect(before.item[0]?.deletedAt).toBeNull();
      expect(before.credential).toHaveLength(1);
      expect(before.accountState).toHaveLength(1);
      expect(before.folderStates).toHaveLength(2);
      expect(before.serverSettings).toHaveLength(1);
      // With the failure gone the same removal succeeds, so the rollback left nothing half-done.
      expect(await remove(mailbox.id)).toBe(true);
      expect(await snapshot(mailbox)).toMatchObject(REMOVED);
    });

    it("answers false for another tenant's mailbox and leaves it unchanged, while that tenant removes its own", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const before = await snapshot(mailbox);
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const own = await inTenant((client) => createConnectedMailbox(client, "Theirs"), other);

      // Row-level security hides the foreign mailbox's rows from the other tenant's scope altogether.
      expect(await snapshot(mailbox, other)).toEqual({ item: [], ...REMOVED });
      expect(await remove(mailbox.id, other)).toBe(false);
      expect(await snapshot(mailbox)).toEqual(before);
      expect(before.item[0]?.deletedAt).toBeNull();
      expect(before.credential).toHaveLength(1);

      expect(await remove(own.id, other)).toBe(true);
      expect(await snapshot(own, other)).toMatchObject(REMOVED);
      expect(await snapshot(mailbox)).toEqual(before);
    });

    it("answers false for a second removal of the same mailbox and writes nothing more", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      expect(await remove(mailbox.id)).toBe(true);
      const removed = await snapshot(mailbox);

      expect(await remove(mailbox.id)).toBe(false);

      expect(await snapshot(mailbox)).toEqual(removed);
    });

    it("answers false for a mailbox trashed by the generic delete and keeps its rows", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const mailboxes = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);
      expect(await runInTenant(tenant, () => chokePoint.softDeleteItem(mailboxes, mailbox.id))).not.toBeNull();
      const trashed = await snapshot(mailbox);

      expect(await remove(mailbox.id)).toBe(false);

      expect(await snapshot(mailbox)).toEqual(trashed);
      expect(trashed.credential).toHaveLength(1);
      expect(trashed.item[0]?.properties).toMatchObject({ syncStatus: "ok" });
    });

    it("answers false for an unknown id, and in a tenant that has no Mailboxes database", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const before = await snapshot(mailbox);
      const unprovisioned = await createTestTenant(admin);

      expect(await remove(randomUUID())).toBe(false);
      expect(await remove(mailbox.id, unprovisioned)).toBe(false);

      expect(await snapshot(mailbox)).toEqual(before);
    });

    it("lets exactly one of two concurrent removals remove the mailbox", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));

      const results = await Promise.all([remove(mailbox.id), remove(mailbox.id)]);

      expect([...results].sort()).toEqual([false, true]);
      const after = await snapshot(mailbox);
      expect(after).toMatchObject(REMOVED);
      expectTrashedAsNeedsReauthorization(after);
    });
  });

  describe("a removal and a sync pass of the same mailbox", () => {
    it("makes a removal that arrives during a pass wait for it, holding no row lock, and then removes the mailbox", async () => {
      const { mailbox, sibling } = await inTenant(async (client) => ({
        mailbox: await createConnectedMailbox(client, "Work"),
        sibling: await createConnectedMailbox(client, "Private"),
      }));
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const secondFolder = signal();
      const released = signal();
      // The pass stops while it selects its second folder. Its first folder is reconciled by then, so
      // the pass holds the row lock on that folder's sync state.
      const providers = stubProviders({
        folders: ["inbox", "archive"],
        onSelectFolder: async (path) => {
          if (path !== "archive") return;
          secondFolder.resolve();
          await released.promise;
        },
      });
      let passSettled = false;
      let removalSettled = false;
      const pass = syncPass(mailbox.id, providers.adapters).finally(() => {
        passSettled = true;
      });
      let removal: Promise<boolean> | undefined;
      try {
        await reachedBeforeEnd(secondFolder.promise, pass, "the pass");
        removal = remove(mailbox.id).finally(() => {
          removalSettled = true;
        });
        const waits = await vi.waitFor(
          async () => {
            const found = await lockWaits();
            expect(found).toHaveLength(1);
            return found;
          },
          { timeout: 10_000, interval: 25 },
        );
        // The one waiting backend is the removal, at the guard, before its first row lock.
        expect(waits.map((wait) => wait.lock)).toEqual(["advisory"]);
        expect(await transactionIdsHeldBy(waits[0]?.pid ?? -1)).toBe(0);
        expect(removalSettled).toBe(false);
        expect(passSettled).toBe(false);
        // The guard's key names the tenant and the mailbox: another tenant's request for the same id
        // does not wait, and neither does the removal of another mailbox of this tenant.
        expect(await remove(mailbox.id, other)).toBe(false);
        expect(await remove(sibling.id)).toBe(true);
        expect(removalSettled).toBe(false);
      } finally {
        released.resolve();
        await Promise.allSettled([pass, removal]);
      }

      await pass;
      expect(await removal).toBe(true);
      expect(providers.calls.filter((call) => call.startsWith("selectFolder"))).toEqual([
        "selectFolder inbox",
        "selectFolder archive",
      ]);
      const after = await snapshot(mailbox);
      expect(after).toMatchObject(REMOVED);
      expectTrashedAsNeedsReauthorization(after);
      expect(await snapshot(sibling)).toMatchObject(REMOVED);
    });

    it.each(SYNC_MODES)(
      "makes a %s pass that read the mailbox before the removal committed do no work and write no sync state",
      async (syncMode) => {
        const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work", syncMode));
        const providers = stubProviders({ folders: ["inbox", "archive"] });
        const holderBackend = signal<number>();
        const released = signal();
        // A row lock is the only way to stop the removal between two of its statements. It holds the
        // guard and has deleted the credential and both sync states when it waits here, uncommitted,
        // at its last delete.
        const holder = inTenant(async (client) => {
          await client.query<{ held: number }>(
            "SELECT 1 AS held FROM mail_account_server_settings WHERE mailbox_item_id = $1 FOR UPDATE",
            [mailbox.id],
          );
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("the holder's backend has no pid");
          holderBackend.resolve(pid);
          await released.promise;
        });
        let passSettled = false;
        let removal: Promise<boolean> | undefined;
        let pass: Promise<void> | undefined;
        try {
          const holderPid = await reachedBeforeEnd(holderBackend.promise, holder, "the lock holder");
          removal = remove(mailbox.id);
          const removalPids = await vi.waitFor(
            async () => {
              const blocked = await backendsBlockedBy(holderPid);
              expect(blocked).toHaveLength(1);
              return blocked;
            },
            { timeout: 10_000, interval: 25 },
          );
          // The pass reads the mailbox, its sync state and its credential as they were before the
          // removal, which has not committed, and then waits for the removal.
          pass = syncPass(mailbox.id, providers.adapters).finally(() => {
            passSettled = true;
          });
          await vi.waitFor(async () => expect(await backendsBlockedBy(removalPids[0] ?? -1)).toHaveLength(1), {
            timeout: 10_000,
            interval: 25,
          });
          expect(passSettled).toBe(false);
        } finally {
          released.resolve();
          await Promise.allSettled([holder, removal, pass]);
        }

        await holder;
        expect(await removal).toBe(true);
        await pass;
        // No reconcile call reached a provider. The IMAP pass opens its connection before its first
        // statement, and closed it.
        expect(providers.calls).toEqual(syncMode === "imap" ? ["createImapClient", "close"] : []);
        const after = await snapshot(mailbox);
        expect(after).toMatchObject(REMOVED);
        expectTrashedAsNeedsReauthorization(after);
      },
    );

    /**
     * One IMAP pass of `mailbox` during which `change` happens after the pass has read the mailbox, its
     * sync state and its credential and before its write transaction: the connection limiter grants
     * the slot in between. Returns the provider calls the pass made and the mailbox's rows right after
     * `change`.
     */
    async function passAfter(
      mailbox: TestMailbox,
      change: () => Promise<void>,
    ): Promise<{ calls: string[]; changed: MailboxSnapshot }> {
      const providers = stubProviders({ folders: ["inbox", "archive"] });
      let changed: MailboxSnapshot | undefined;
      const limiter: ImapConnectionLimiter = {
        async run<T>(_accountId: string, _limit: number, task: () => Promise<T>): Promise<T> {
          await change();
          changed = await snapshot(mailbox);
          return task();
        },
      };
      await syncPass(mailbox.id, providers.adapters, limiter);
      if (changed === undefined) throw new Error("the pass never asked for its connection slot");
      return { calls: providers.calls, changed };
    }

    /** What a pass that did no work called: it opens its connection before its first statement, and closes it. */
    const NO_RECONCILE = ["createImapClient", "close"];

    it("makes a pass do no work for a live mailbox whose sync state was deleted while the pass waited for its connection", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));

      const { calls, changed } = await passAfter(mailbox, async () => {
        // The store's delete, called directly: the removal deletes the row of a mailbox it trashes, and
        // since issue gh-2032 the restore of that mailbox inserts one again.
        expect(await inTenant((client) => deleteMailAccountSyncState(client, mailbox.id))).toBe(true);
      });

      // The mailbox is live, but it has no sync state: there is nothing to sync.
      expect(calls).toEqual(NO_RECONCILE);
      const after = await snapshot(mailbox);
      expect(after).toEqual(changed);
      expect(after.accountState).toEqual([]);
      expect(after.item[0]?.deletedAt).toBeNull();
      expect(after.credential).toHaveLength(1);
      expect(after.folderStates).toHaveLength(2);
    });

    it("lets a pass that waited for its connection reconcile a mailbox that was removed and restored meanwhile, which has a sync state again", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const mailboxes = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);

      const { calls, changed } = await passAfter(mailbox, async () => {
        expect(await remove(mailbox.id)).toBe(true);
        expect(await runInTenant(tenant, () => chokePoint.restoreItem(mailboxes, mailbox.id))).not.toBeNull();
      });

      // The restore hook of issue gh-2032 gave the mailbox a default sync state, and nothing else back.
      expect(changed).toMatchObject({ ...REMOVED, accountState: [{ syncMode: "imap" }] });
      expect(changed.item[0]?.deletedAt).toBeNull();
      expect(changed.item[0]?.properties).toMatchObject({ syncStatus: "needsReauthorization" });
      // The pass finds a live mailbox with a sync state, so it reconciles both folders with the
      // credential it read before the removal deleted it.
      expect(calls.filter((call) => call.startsWith("selectFolder"))).toEqual([
        "selectFolder inbox",
        "selectFolder archive",
      ]);
      const after = await snapshot(mailbox);
      expect(after.folderStates).toEqual([mailbox.inbox, mailbox.archive].sort());
      expect(after.accountState).toEqual([{ syncMode: "imap" }]);
      // It stores no credential, and it leaves the status the removal wrote: it read `ok` before the
      // removal and ends as `ok`, so it writes no status.
      expect(after.credential).toEqual([]);
      expect(after.serverSettings).toEqual([]);
      expect(after.item).toEqual(changed.item);
    });

    it("makes a pass do no work for a mailbox that the generic delete trashed while the pass waited for its connection", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const mailboxes = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);

      const { calls, changed } = await passAfter(mailbox, async () => {
        expect(await runInTenant(tenant, () => chokePoint.softDeleteItem(mailboxes, mailbox.id))).not.toBeNull();
      });

      // The generic delete keeps the sync state, so only the trashed item tells the pass to stop.
      expect(calls).toEqual(NO_RECONCILE);
      const after = await snapshot(mailbox);
      expect(after).toEqual(changed);
      expect(after.item[0]?.deletedAt).not.toBeNull();
      expect(after.accountState).toHaveLength(1);
      expect(after.folderStates).toHaveLength(2);
    });

    it("makes a pass do no work for a mailbox whose item was purged while the pass waited for its connection", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));

      const { calls, changed } = await passAfter(mailbox, async () => {
        // Raw SQL: the trash purge deletes an item only after its retention, which a test cannot wait for.
        const purged = await admin.query("DELETE FROM items WHERE id = $1", [mailbox.id]);
        expect(purged.rowCount).toBe(1);
      });

      expect(calls).toEqual(NO_RECONCILE);
      const after = await snapshot(mailbox);
      expect(after).toEqual(changed);
      expect(after.item).toEqual([]);
      expect(after.accountState).toHaveLength(1);
    });

    it("refuses the sync guard outside a tenant scope", async () => {
      const client = await runtime.connect();
      try {
        await expect(lockMailboxSync(client, randomUUID())).rejects.toBeInstanceOf(TenantScopeMissingError);
        await expect(
          runAsSystem("test:mailbox-sync-guard", () => lockMailboxSync(client, randomUUID())),
        ).rejects.toBeInstanceOf(TenantScopeMissingError);
      } finally {
        client.release();
      }
    });
  });

  describe("the sync state deletes", () => {
    it("report what they deleted and leave another mailbox's rows alone", async () => {
      const { mailbox, other } = await inTenant(async (client) => ({
        mailbox: await createConnectedMailbox(client, "Work"),
        other: await createConnectedMailbox(client, "Private"),
      }));
      const otherBefore = await snapshot(other);

      const deleted = await inTenant(async (client) => {
        const input = {
          foldersDatabaseId: (await resolveMailModuleIds(client)).foldersDatabaseId,
          mailboxItemId: mailbox.id,
        };
        return {
          account: await deleteMailAccountSyncState(client, mailbox.id),
          accountAgain: await deleteMailAccountSyncState(client, mailbox.id),
          folders: await deleteMailFolderSyncStatesOfMailbox(client, input),
          foldersAgain: await deleteMailFolderSyncStatesOfMailbox(client, input),
        };
      });

      expect(deleted).toEqual({ account: true, accountAgain: false, folders: 2, foldersAgain: 0 });
      const after = await snapshot(mailbox);
      expect(after.accountState).toEqual([]);
      expect(after.folderStates).toEqual([]);
      expect(await snapshot(other)).toEqual(otherBefore);
      expect(otherBefore.folderStates).toHaveLength(2);
    });
  });

  describe("DELETE /api/mail/mailboxes/:id handler", () => {
    function call(id: string, userId: string, tenantId = tenant) {
      // The empty custom-route container: these tests are about the removal, not its cleanup (issue gh-2030).
      const handler = createMailboxRemovalRouteHandler(runtime, {});
      return runInTenant(tenantId, () => handler({ params: { id }, identity: { user: { id: userId } } }));
    }

    it("answers 200 with the mailbox id, removes it and addresses the item invalidations to the caller", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const userId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      let answer: unknown;
      try {
        answer = await call(mailbox.id, userId);
      } finally {
        setInvalidationHook(() => {});
      }

      expect(answer).toEqual({ status: 200, body: { id: mailbox.id } });
      const after = await snapshot(mailbox);
      expect(after).toMatchObject(REMOVED);
      expectTrashedAsNeedsReauthorization(after);
      const ofMailbox = events.filter((event) => event.scope === "item" && event.itemId === mailbox.id);
      expect(ofMailbox.map((event) => ({ op: "op" in event ? event.op : null, userId: event.userId }))).toEqual([
        { op: "update", userId },
        { op: "delete", userId },
      ]);
    });

    it("answers the same not-found error for an unknown id, a malformed id, another tenant's mailbox and a removed mailbox", async () => {
      const mailbox = await inTenant((client) => createConnectedMailbox(client, "Work"));
      const before = await snapshot(mailbox);
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const removed = await inTenant((client) => createConnectedMailbox(client, "Removed"));
      expect(await remove(removed.id)).toBe(true);
      const userId = randomUUID();

      const refusals: unknown[] = [];
      for (const attempt of [
        () => call(randomUUID(), userId),
        () => call("not-a-uuid", userId),
        () => call(mailbox.id, userId, other),
        () => call(removed.id, userId),
      ]) {
        const error: unknown = await attempt().then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(NotFoundError);
        if (!(error instanceof NotFoundError)) continue;
        refusals.push({ code: error.code, message: error.message, details: error.details ?? null });
      }

      expect(refusals).toEqual(
        Array.from({ length: 4 }, () => ({ code: "not_found", message: "Mailbox not found", details: null })),
      );
      expect(await snapshot(mailbox)).toEqual(before);
    });
  });
});
