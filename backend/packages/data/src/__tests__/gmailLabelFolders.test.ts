import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import * as relationOps from "../chokePoint/relationOps.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  GMAIL_ARCHIVE_PROVIDER_ID,
  reconcileGmailAccount,
  type GmailLabelRef,
  type GmailMailClient,
} from "../mail/gmailReconcile.js";
import { handleMailGmailPseudoFolderCleanupTask } from "../mail/gmailPseudoFolderCleanupJob.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

let admin: Pool;
let pool: Pool;
let tenantId: string;

async function bounded<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Gmail overlap timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OwnedBackend {
  client: PoolClient;
  pid: number;
  errors: Error[];
  onError: (error: unknown) => void;
}

function capturePoolPids(
  pool: Pool,
  backends: OwnedBackend[],
): { detach: () => void; onAcquire: (client: PoolClient) => void } {
  const onAcquire = (client: PoolClient): void => {
    if (backends.some((backend) => backend.client === client)) return;
    const pid: unknown = Reflect.get(client, "processID");
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing owned backend PID");
    const errors: Error[] = [];
    const onError = (error: unknown): void => {
      errors.push(error instanceof Error ? error : new Error("Unknown owned client error", { cause: error }));
    };
    client.on("error", onError);
    backends.push({
      client,
      errors,
      onError,
      pid,
    });
  };
  pool.on("acquire", onAcquire);
  return {
    onAcquire,
    detach: () => {
      pool.off("acquire", onAcquire);
    },
  };
}

async function settleOwnedPools(
  control: PoolClient,
  pools: Pool[],
  operations: Array<Promise<unknown>>,
  capturedBackends: OwnedBackend[][],
  timeoutMs = 5000,
): Promise<void> {
  const settled = Promise.allSettled(operations);
  let timedOut: unknown;
  try {
    await bounded(settled, timeoutMs);
  } catch (error) {
    timedOut = error;
  }
  const closing = Promise.allSettled(pools.map((ownedPool) => ownedPool.end()));
  if (timedOut !== undefined) {
    const terminated = new Set<number>();
    let finished = false;
    void settled.then(() => {
      finished = true;
    });
    const terminateUntilSettled = async (): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!finished) {
        if (Date.now() >= deadline) throw new Error("Owned Gmail operations did not settle");
        for (const { pid } of capturedBackends.flat()) {
          if (terminated.has(pid)) continue;
          terminated.add(pid);
          await bounded(control.query("SELECT pg_terminate_backend($1)", [pid]));
        }
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await terminateUntilSettled();
  }
  const closed = await bounded(closing);
  for (const backend of capturedBackends.flat()) backend.client.off("error", backend.onError);
  if (closed.some((result) => result.status === "rejected"))
    throw new Error("Failed to close an owned Gmail test pool");
  if (timedOut !== undefined) {
    throw timedOut instanceof Error ? timedOut : new Error("Gmail cleanup failed", { cause: timedOut });
  }
}

async function rollbackAndSettleOwned(
  rollback: () => Promise<void>,
  releaseFailedHolder: () => void,
  settle: () => Promise<void>,
): Promise<void> {
  const [rollbackResult] = await Promise.allSettled([rollback()]);
  const [releaseResult] = await Promise.allSettled([
    Promise.resolve().then(() => {
      if (rollbackResult?.status === "rejected") releaseFailedHolder();
    }),
  ]);
  const [settleResult] = await Promise.allSettled([settle()]);
  if (rollbackResult?.status === "rejected") {
    const errors: unknown[] = [rollbackResult.reason];
    if (releaseResult?.status === "rejected") errors.push(releaseResult.reason);
    if (settleResult?.status === "rejected") errors.push(settleResult.reason);
    if (errors.length > 1)
      throw new AggregateError(errors, "Gmail fixture cleanup failed", {
        cause: rollbackResult.reason,
      });
    throw new Error("Gmail fixture rollback failed", { cause: rollbackResult.reason });
  }
  if (settleResult?.status === "rejected")
    throw new Error("Gmail fixture settlement failed", { cause: settleResult.reason });
}

async function withOwnedFixture(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  const [bodyResult] = await Promise.allSettled([body()]);
  const [cleanupResult] = await Promise.allSettled([cleanup()]);
  if (bodyResult?.status === "rejected") {
    const bodyFailure: unknown = bodyResult.reason;
    if (cleanupResult?.status === "rejected")
      throw new AggregateError([bodyFailure, cleanupResult.reason], "Gmail fixture body and cleanup failed", {
        cause: bodyFailure,
      });
    if (bodyFailure instanceof Error) throw bodyFailure;
    throw new Error("Gmail fixture body failed", { cause: bodyFailure });
  }
  if (cleanupResult?.status === "rejected") {
    const cleanupFailure: unknown = cleanupResult.reason;
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    throw new Error("Gmail fixture cleanup failed", { cause: cleanupFailure });
  }
}

const storage: BlobStorageWriter = {
  async writeStream() {
    return { byteSize: 0, contentHash: "0" };
  },
  async delete() {},
  readStream: () => {
    throw new Error("not used");
  },
};

const LABELS: GmailLabelRef[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "CHAT", name: "CHAT", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "Label_1", name: "Work", type: "user" },
];

function gmailClient(messages: Record<string, string[]>): GmailMailClient {
  return {
    getCurrentHistoryId: async () => "100",
    listHistorySince: async () => ({
      invalidated: false,
      newHistoryId: "101",
      changedMessageIds: Object.keys(messages),
      removedMessageIds: [],
    }),
    listAllMessageIds: async () => Object.keys(messages),
    fetchMessage: async (id) => ({
      id,
      threadId: `t-${id}`,
      labelIds: messages[id] ?? [],
      message: { messageId: `<${id}@x>`, envelope: { from: { address: "a@x.com" } }, subject: id, attachments: [] },
    }),
    listLabels: async () => LABELS,
    modifyMessageLabels: async () => {},
  };
}

interface Setup {
  mailboxItemId: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
}

async function setup(scopeTenant = tenantId): Promise<Setup> {
  return runInTenant(scopeTenant, () =>
    withTransaction(pool, async (client) => {
      const [emails, files, folders, mailboxes] = await Promise.all(
        ["emails", "files", "folders", "mailboxes"].map((m) => getDatabaseByModuleId(client, m)),
      );
      if (!emails || !files || !folders || !mailboxes) throw new Error("mail databases were not seeded");
      const folderProperty = await getPropertyByKey(client, emails.id, "folder");
      const attachmentsProperty = await getPropertyByKey(client, emails.id, "attachments");
      const mailboxProperty = await getPropertyByKey(client, folders.id, "mailbox");
      if (!folderProperty || !attachmentsProperty || !mailboxProperty) throw new Error("schema missing");
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: "M", provider: "gmail" },
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
      return {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emails.id,
        filesDatabaseId: files.id,
        foldersDatabaseId: folders.id,
        folderRelationPropertyId: folderProperty.id,
        mailboxFolderRelationPropertyId: mailboxProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        storage,
        storageKeyPrefix: "test",
      };
    }),
  );
}

async function sync(params: Setup, messages: Record<string, string[]>): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, (client) => reconcileGmailAccount(client, gmailClient(messages), params)),
  );
}

async function folderProviderIds(params: Setup): Promise<string[]> {
  const { rows } = await admin.query<{ pid: string }>(
    `SELECT properties ->> 'providerId' AS pid FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY 1`,
    [params.foldersDatabaseId],
  );
  return rows.map((r) => r.pid);
}

/** Provider ids of the live folders a message (by Message-ID) is linked to. */
async function foldersOf(params: Setup, providerMessageId: string): Promise<string[]> {
  const { rows } = await admin.query<{ pid: string }>(
    `SELECT f.properties ->> 'providerId' AS pid
       FROM mail_message_meta m
       JOIN item_relations r ON r.item_a = m.item_id OR r.item_b = m.item_id
       JOIN items f ON f.id = CASE WHEN r.item_a = m.item_id THEN r.item_b ELSE r.item_a END
      WHERE m.provider_message_id = $1 AND f.database_id = $2 AND f.deleted_at IS NULL
      ORDER BY 1`,
    [providerMessageId, params.foldersDatabaseId],
  );
  return rows.map((r) => r.pid);
}

async function seedOverlap(params: Setup): Promise<{ folderItemId: string; messageItemId: string }> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: params.foldersDatabaseId,
        mailboxItemId: params.mailboxItemId,
        mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
        providerId: "UNREAD",
        name: "Unread",
        behavior: "label",
        specialPurpose: "none",
      });
      for (const [providerId, purpose] of [
        ["INBOX", "inbox"],
        [GMAIL_ARCHIVE_PROVIDER_ID, "archive"],
      ] as const) {
        await ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId,
          name: purpose,
          behavior: "label",
          specialPurpose: purpose,
        });
      }
      const message = await ingestEmailMessage(client, {
        emailsDatabaseId: params.emailsDatabaseId,
        filesDatabaseId: params.filesDatabaseId,
        folderRelationPropertyId: params.folderRelationPropertyId,
        attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
        folderItemId,
        mailboxItemId: params.mailboxItemId,
        providerMessageId: "overlap",
        messageId: "<overlap@x>",
        envelope: { from: { address: "sender@example.test" } },
        subject: "Overlap",
        attachments: [],
        storage,
        storageKeyPrefix: "overlap",
      });
      return { folderItemId, messageItemId: message.itemId };
    }),
  );
}

describe("Gmail label folders (issue #1496)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantId = getTenantZeroId();
    await runInTenant(tenantId, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates folders only for user labels, the five system labels and Archive", async () => {
    const params = await setup();
    await sync(params, { m1: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    expect(await folderProviderIds(params)).toEqual(
      ["DRAFT", "INBOX", "Label_1", "SENT", GMAIL_ARCHIVE_PROVIDER_ID].sort(),
    );
    expect(await foldersOf(params, "m1")).toEqual(["INBOX"]);
  });

  it("puts archived mail in Archive, a sent mail and a draft not", async () => {
    const params = await setup();
    await sync(params, {
      archived: ["IMPORTANT", "UNREAD"],
      withUserLabel: ["Label_1"],
      sent: ["SENT"],
      draft: ["DRAFT", "UNREAD"],
    });
    expect(await foldersOf(params, "archived")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    expect(await foldersOf(params, "withUserLabel")).toEqual(["Label_1", GMAIL_ARCHIVE_PROVIDER_ID].sort());
    expect(await foldersOf(params, "sent")).toEqual(["SENT"]);
    expect(await foldersOf(params, "draft")).toEqual(["DRAFT"]);
  });

  it("ingests a message with no labels into Archive", async () => {
    const params = await setup();
    await sync(params, { bare: [] });
    expect(await foldersOf(params, "bare")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
  });

  it("removes the Archive edge when the message moves back to the inbox, and the INBOX edge when archived", async () => {
    const params = await setup();
    await sync(params, { m1: ["UNREAD"] });
    expect(await foldersOf(params, "m1")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    await sync(params, { m1: ["INBOX"] });
    expect(await foldersOf(params, "m1")).toEqual(["INBOX"]);
    await sync(params, { m1: [] });
    expect(await foldersOf(params, "m1")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
  });

  it("fails before deleting a mailbox folder when its label inventory is unavailable or ambiguous", async () => {
    const params = await setup();
    await runInTenant(tenantId, () =>
      withTransaction(pool, (client) =>
        ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId: "UNREAD",
          name: "Unread",
          behavior: "label",
          specialPurpose: "none",
        }),
      ),
    );
    const before = await folderProviderIds(params);
    await expect(handleMailGmailPseudoFolderCleanupTask(pool, undefined)).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
    await expect(
      handleMailGmailPseudoFolderCleanupTask(pool, async () => {
        throw new Error("provider offline");
      }),
    ).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
    await expect(
      handleMailGmailPseudoFolderCleanupTask(pool, async () => [
        { id: "UNREAD", name: "Unread", type: "system" },
        { id: "UNREAD", name: "Unread", type: "user" },
      ]),
    ).rejects.toThrow();
    expect(await folderProviderIds(params)).toEqual(before);
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => LABELS);
    expect(await folderProviderIds(params)).not.toContain("UNREAD");
  });

  it("walks more than one cleanup page and leaves every affected message in Archive", async () => {
    const params = await setup();
    await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const folderItemId = await ensureFolderItem(client, {
          foldersDatabaseId: params.foldersDatabaseId,
          mailboxItemId: params.mailboxItemId,
          mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
          providerId: "UNREAD",
          name: "Unread",
          behavior: "label",
          specialPurpose: "none",
        });
        for (let index = 0; index < 201; index += 1) {
          await ingestEmailMessage(client, {
            emailsDatabaseId: params.emailsDatabaseId,
            filesDatabaseId: params.filesDatabaseId,
            folderRelationPropertyId: params.folderRelationPropertyId,
            attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
            folderItemId,
            mailboxItemId: params.mailboxItemId,
            providerMessageId: `page-${index}`,
            messageId: `<page-${index}@example.test>`,
            envelope: { from: { address: "sender@example.test" } },
            subject: "Page",
            attachments: [],
            storage,
            storageKeyPrefix: "page-test",
          });
        }
      }),
    );
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => LABELS);
    for (const index of [0, 100, 200]) {
      expect(await foldersOf(params, `page-${index}`)).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    }
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_meta m
        JOIN item_relations r ON r.item_a = m.item_id OR r.item_b = m.item_id
        JOIN items f ON f.id = CASE WHEN r.item_a = m.item_id THEN r.item_b ELSE r.item_a END
        WHERE m.mailbox_item_id = $1 AND f.properties ->> 'providerId' = $2`,
      [params.mailboxItemId, GMAIL_ARCHIVE_PROVIDER_ID],
    );
    expect(rows[0]?.count).toBe("201");
    expect(await folderProviderIds(params)).not.toContain("UNREAD");
  }, 120_000);

  it("rejects missing and system tenant scope before Gmail reconciliation queries", async () => {
    const params = await setup();
    const client = await admin.connect();
    const query = vi.spyOn(client, "query");
    try {
      await expect(reconcileGmailAccount(client, gmailClient({}), params)).rejects.toThrow(/tenant scope/i);
      await expect(
        runAsSystem("gmail-scope-test", () => reconcileGmailAccount(client, gmailClient({}), params)),
      ).rejects.toThrow(/tenant scope/i);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      client.release();
    }
  });

  it("keeps Inbox without Archive when cleanup overlaps a Gmail move to Inbox", async () => {
    const params = await setup();
    const seeded = await seedOverlap(params);
    const cleanupPool = await createRuntimeRolePool(admin, "semprec_data");
    const syncPool = await createRuntimeRolePool(admin, "semprec_data");
    let release: () => void = () => undefined;
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportPid: (pid: number) => void = () => undefined;
    const paused = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const original = relationOps.deleteRelationWithClient;
    const spy = vi
      .spyOn(relationOps, "deleteRelationWithClient")
      .mockImplementation(async (client, input, context, writer) => {
        const result = await original(client, input, context, writer);
        if (input.callerItemId === seeded.messageItemId && input.targetItemId === seeded.folderItemId && result) {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing cleanup backend pid");
          reportPid(pid);
          await mayContinue;
        }
        return result;
      });
    const cleanup = handleMailGmailPseudoFolderCleanupTask(cleanupPool, async () => LABELS);
    const cleanupSettled = Promise.allSettled([cleanup]);
    let syncSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let outcomes: PromiseSettledResult<void>[][];
    let blocked = false;
    let blockedQuery = "";
    try {
      const pid = await Promise.race([
        paused,
        cleanup.then(() => {
          throw new Error("Cleanup ended before barrier");
        }),
      ]);
      const syncing = runInTenant(tenantId, () =>
        withTransaction(syncPool, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          await reconcileGmailAccount(client, gmailClient({ overlap: ["INBOX"] }), params);
        }),
      );
      syncSettled = Promise.allSettled([syncing]);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await admin.query<{ query: string }>(
          "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (rows[0]) {
          blocked = true;
          blockedQuery = rows[0].query;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      outcomes = await Promise.all([cleanupSettled, syncSettled ?? Promise.resolve([])]);
      spy.mockRestore();
      await cleanupPool.end();
      await syncPool.end();
    }
    expect(outcomes.flat().map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(blocked).toBe(true);
    expect(blockedQuery).toMatch(/pg_advisory_xact_lock/i);
    expect(await foldersOf(params, "overlap")).toEqual(["INBOX"]);
  }, 15_000);

  it("rolls back a failed cleanup page and releases the waiting Gmail sync", async () => {
    const params = await setup();
    const seeded = await seedOverlap(params);
    const cleanupPool = await createRuntimeRolePool(admin, "semprec_data");
    const syncPool = await createRuntimeRolePool(admin, "semprec_data");
    let failCleanup: () => void = () => undefined;
    let releaseSync: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      failCleanup = resolve;
    });
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let reportCleanup: (pid: number) => void = () => undefined;
    const cleanupPaused = new Promise<number>((resolve) => {
      reportCleanup = resolve;
    });
    let reportSync: () => void = () => undefined;
    const syncPaused = new Promise<void>((resolve) => {
      reportSync = resolve;
    });
    const original = relationOps.deleteRelationWithClient;
    const spy = vi
      .spyOn(relationOps, "deleteRelationWithClient")
      .mockImplementation(async (client, input, context, writer) => {
        const result = await original(client, input, context, writer);
        if (input.callerItemId === seeded.messageItemId && input.targetItemId === seeded.folderItemId && result) {
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing cleanup backend pid");
          reportCleanup(pid);
          await cleanupGate;
          throw new Error("Injected failure after guarded edge deletion");
        }
        return result;
      });
    const cleanup = handleMailGmailPseudoFolderCleanupTask(cleanupPool, async () => LABELS);
    const cleanupSettled = Promise.allSettled([cleanup]);
    let syncSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let outcomes: PromiseSettledResult<void>[][];
    let blockedQuery = "";
    let restored: string[];
    let folderRestored: boolean;
    try {
      const pid = await Promise.race([
        cleanupPaused,
        cleanup.then(() => {
          throw new Error("Cleanup ended before barrier");
        }),
      ]);
      const syncing = runInTenant(tenantId, () =>
        withTransaction(syncPool, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          const gmail = gmailClient({ overlap: ["INBOX"] });
          gmail.listLabels = async () => {
            reportSync();
            await syncGate;
            return LABELS;
          };
          await reconcileGmailAccount(client, gmail, params);
        }),
      );
      syncSettled = Promise.allSettled([syncing]);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await admin.query<{ query: string }>(
          "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (rows[0]) {
          blockedQuery = rows[0].query;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      failCleanup();
      await Promise.race([
        syncPaused,
        syncing.then(() => {
          throw new Error("Sync ended before barrier");
        }),
      ]);
      await cleanupSettled;
      spy.mockRestore();
      restored = await foldersOf(params, "overlap");
      folderRestored = (await folderProviderIds(params)).includes("UNREAD");
    } finally {
      failCleanup();
      releaseSync();
      outcomes = await Promise.all([cleanupSettled, syncSettled ?? Promise.resolve([])]);
      spy.mockRestore();
      await cleanupPool.end();
      await syncPool.end();
    }
    expect(blockedQuery).toMatch(/pg_advisory_xact_lock/i);
    const cleanupResult = outcomes[0]?.[0];
    expect(cleanupResult?.status).toBe("rejected");
    if (cleanupResult?.status !== "rejected" || !(cleanupResult.reason instanceof AggregateError)) {
      throw new Error("Expected cleanup to propagate the injected failure");
    }
    expect(
      cleanupResult.reason.errors.some(
        (error: unknown) => error instanceof Error && error.message === "Injected failure after guarded edge deletion",
      ),
    ).toBe(true);
    expect(outcomes[1]?.[0]?.status).toBe("fulfilled");
    expect(restored).toEqual(["UNREAD"]);
    expect(folderRestored).toBe(true);
    expect(await foldersOf(params, "overlap")).toEqual(["INBOX"]);
  }, 15_000);

  it("waits for an in-flight Gmail move before cleaning the same mailbox", async () => {
    const params = await setup();
    await seedOverlap(params);
    const otherMailbox = await setup();
    const otherTenant = await createTestTenant(admin);
    await runInTenant(otherTenant, () => seedSystem(pool));
    const otherTenantMailbox = await setup(otherTenant);
    const cleanupPool = await createRuntimeRolePool(admin, "semprec_data");
    const syncPool = await createRuntimeRolePool(admin, "semprec_data");
    const sameTenantPool = await createRuntimeRolePool(admin, "semprec_data");
    const otherTenantPool = await createRuntimeRolePool(admin, "semprec_data");
    const cleanupBackends: OwnedBackend[] = [];
    const syncBackends: OwnedBackend[] = [];
    const sameTenantBackends: OwnedBackend[] = [];
    const otherTenantBackends: OwnedBackend[] = [];
    const captures = [
      { pool: cleanupPool, ...capturePoolPids(cleanupPool, cleanupBackends) },
      { pool: syncPool, ...capturePoolPids(syncPool, syncBackends) },
      { pool: sameTenantPool, ...capturePoolPids(sameTenantPool, sameTenantBackends) },
      { pool: otherTenantPool, ...capturePoolPids(otherTenantPool, otherTenantBackends) },
    ];
    const control = await admin.connect();
    await control.query("SET statement_timeout = '3s'");
    await control.query("SET lock_timeout = '2s'");
    let release: () => void = () => undefined;
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportPid: (pid: number) => void = () => undefined;
    const paused = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const syncing = runInTenant(tenantId, () =>
      withTransaction(syncPool, async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing sync backend pid");
        const gmail = gmailClient({ overlap: ["INBOX"] });
        gmail.listLabels = async () => {
          reportPid(pid);
          await mayContinue;
          return LABELS;
        };
        await reconcileGmailAccount(client, gmail, params);
      }),
    );
    const syncSettled = syncing.then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    let sameTenant: Promise<void> | undefined;
    let otherTenantWork: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;
    let samePid: number | undefined;
    let otherPid: number | undefined;
    let cleanupPid: number | undefined;
    let reportSamePid: (pid: number) => void = () => undefined;
    const sameStarted = new Promise<number>((resolve) => {
      reportSamePid = resolve;
    });
    await withOwnedFixture(
      async () => {
        const holderPid = await bounded(
          Promise.race([
            paused,
            syncing.then(() => {
              throw new Error("Sync ended before barrier");
            }),
          ]),
        );
        sameTenant = runInTenant(tenantId, () =>
          withTransaction(sameTenantPool, async (client) => {
            await client.query("SET LOCAL statement_timeout = '5s'");
            const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!rows[0]) throw new Error("Missing same-tenant backend PID");
            reportSamePid(rows[0].pid);
            await reconcileGmailAccount(client, gmailClient({ "other-mailbox": ["INBOX"] }), otherMailbox);
          }),
        );
        const sameSettled = sameTenant.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        samePid = await bounded(sameStarted);
        otherTenantWork = runInTenant(otherTenant, () =>
          withTransaction(otherTenantPool, async (client) => {
            await client.query("SET LOCAL statement_timeout = '5s'");
            const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!rows[0]) throw new Error("Missing other-tenant backend PID");
            otherPid = rows[0].pid;
            await reconcileGmailAccount(client, gmailClient({ "other-tenant": ["INBOX"] }), otherTenantMailbox);
          }),
        );
        await bounded(otherTenantWork);
        expect(await foldersOf(otherTenantMailbox, "other-tenant")).toEqual(["INBOX"]);
        const sameDeadline = Date.now() + 3000;
        let sameBlocked = false;
        while (Date.now() < sameDeadline) {
          const result = await bounded(
            control.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
              holderPid,
              samePid,
            ]),
          );
          if (result.rows[0]?.blocked) {
            sameBlocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sameBlocked).toBe(true);
        cleanup = handleMailGmailPseudoFolderCleanupTask(cleanupPool, async () => LABELS);
        const cleanupSettled = cleanup.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const owned = cleanupBackends.map((backend) => backend.pid);
          const { rows } = await control.query<{ pid: number; blocked: boolean }>(
            "SELECT pid, $1::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = ANY($2::int[])",
            [holderPid, owned],
          );
          cleanupPid = rows.find((row) => row.blocked)?.pid;
          if (cleanupPid !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(cleanupPid).toBeDefined();
        expect(otherPid).toBeDefined();
        expect(new Set([holderPid, samePid, otherPid, cleanupPid]).size).toBe(4);
        expect(syncBackends.map((backend) => backend.pid)).toContain(holderPid);
        expect(sameTenantBackends.map((backend) => backend.pid)).toContain(samePid);
        expect(otherTenantBackends.map((backend) => backend.pid)).toContain(otherPid);
        console.info("GMAIL_GUARD_OVERLAP", { holderPid, samePid, otherPid, cleanupPid });
        release();
        expect(await bounded(syncSettled)).toEqual({ ok: true });
        expect(await bounded(sameSettled)).toEqual({ ok: true });
        expect(await bounded(cleanupSettled)).toEqual({ ok: true });
        expect(await foldersOf(otherMailbox, "other-mailbox")).toEqual(["INBOX"]);
        expect(await foldersOf(params, "overlap")).toEqual(["INBOX"]);
      },
      async () => {
        release();
        const operations = [
          syncing,
          ...(sameTenant ? [sameTenant] : []),
          ...(otherTenantWork ? [otherTenantWork] : []),
          ...(cleanup ? [cleanup] : []),
        ];
        try {
          await settleOwnedPools(control, [syncPool, sameTenantPool, otherTenantPool, cleanupPool], operations, [
            syncBackends,
            sameTenantBackends,
            otherTenantBackends,
            cleanupBackends,
          ]);
          for (const backend of [...syncBackends, ...sameTenantBackends, ...otherTenantBackends, ...cleanupBackends]) {
            expect(backend.errors).toEqual([]);
            expect(backend.client.listeners("error")).not.toContain(backend.onError);
          }
        } finally {
          for (const capture of captures) {
            capture.detach();
          }
          control.release(true);
          for (const capture of captures) expect(capture.pool.listeners("acquire")).not.toContain(capture.onAcquire);
        }
      },
    );
  }, 120_000);

  it("settles and closes an owned reconcile that times out before the provider barrier", async () => {
    const params = await setup();
    const operationPool = await createRuntimeRolePool(admin, "semprec_data");
    const capturedBackends: OwnedBackend[] = [];
    const capture = capturePoolPids(operationPool, capturedBackends);
    const holder = await admin.connect();
    const control = await admin.connect();
    let guardHeld = false;
    let holderReleased = false;
    let cleanupStarted = false;
    let barrierReached = false;
    let operation: Promise<void> | undefined;
    await withOwnedFixture(
      async () => {
        await bounded(control.query("SET statement_timeout = '3s'"));
        await bounded(holder.query("SET statement_timeout = '3s'"));
        await bounded(holder.query("BEGIN"));
        guardHeld = true;
        const holderRows = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = holderRows.rows[0]?.pid;
        if (holderPid === undefined) throw new Error("Missing holder PID");
        await bounded(
          holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
            `mail-thread-mutation:v1:${tenantId.toLowerCase()}`,
          ]),
        );
        const gmail = gmailClient({});
        gmail.listLabels = async () => {
          barrierReached = true;
          return LABELS;
        };
        operation = runInTenant(tenantId, () =>
          withTransaction(operationPool, (client) => reconcileGmailAccount(client, gmail, params)),
        );
        const operationSettled = Promise.allSettled([operation]);
        let participantPid: number | undefined;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const pids = capturedBackends.map((backend) => backend.pid);
          if (pids[0] !== undefined) {
            participantPid = pids[0];
            const result = await bounded(
              control.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                holderPid,
                participantPid,
              ]),
            );
            if (result.rows[0]?.blocked) break;
            participantPid = undefined;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (participantPid === undefined) throw new Error("Owned reconcile did not block before its provider barrier");
        expect(barrierReached).toBe(false);
        cleanupStarted = true;
        await expect(settleOwnedPools(control, [operationPool], [operation], [capturedBackends], 100)).rejects.toThrow(
          "Gmail overlap timed out",
        );
        const result = await bounded(operationSettled);
        expect(result[0]?.status).toBe("rejected");
        if (result[0]?.status !== "rejected" || !(result[0].reason instanceof Error))
          throw new Error("Expected the owned reconcile to fail on termination");
        expect(result[0].reason.message).toMatch(
          /terminating connection due to administrator command|Connection terminated unexpectedly/,
        );
        const remaining = await control.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present",
          [participantPid],
        );
        expect(remaining.rows[0]?.present).toBe(false);
        expect(barrierReached).toBe(false);
        const participant = capturedBackends.find((backend) => backend.pid === participantPid);
        if (!participant) throw new Error("Missing captured reconcile backend");
        expect(participant.errors.length).toBeGreaterThan(0);
        expect(participant.errors.every((error) => error.message === "Connection terminated unexpectedly")).toBe(true);
        expect(participant.client.listeners("error")).not.toContain(participant.onError);
        expect(
          capturedBackends.filter((backend) => backend.pid !== participantPid).flatMap((backend) => backend.errors),
        ).toEqual([]);
        console.info("GMAIL_PRE_BARRIER_CLEANUP", { holderPid, participantPid });
      },
      async () => {
        await withOwnedFixture(
          async () =>
            rollbackAndSettleOwned(
              async () => {
                if (guardHeld) await bounded(holder.query("ROLLBACK"));
              },
              () => {
                holderReleased = true;
                holder.release(true);
              },
              async () => {
                if (!cleanupStarted)
                  await settleOwnedPools(control, [operationPool], operation ? [operation] : [], [capturedBackends]);
              },
            ),
          async () => {
            capture.detach();
            await withOwnedFixture(
              async () => {
                if (!holderReleased) holder.release(true);
              },
              async () => {
                control.release(true);
              },
            );
            expect(operationPool.listeners("acquire")).not.toContain(capture.onAcquire);
          },
        );
      },
    );
  }, 120_000);

  it("settles an owned pool when fixture rollback fails", async () => {
    const operationPool = await createRuntimeRolePool(admin, "semprec_data");
    const backends: OwnedBackend[] = [];
    const capture = capturePoolPids(operationPool, backends);
    const holder = await admin.connect();
    const control = await admin.connect();
    let released = false;
    let cleanupStarted = false;
    await withOwnedFixture(
      async () => {
        await bounded(holder.query("BEGIN"));
        const operation = operationPool.query("SELECT 1");
        await bounded(operation);
        const backend = backends[0];
        if (!backend) throw new Error("Missing owned backend");
        const rollbackFailure = new Error("Injected rollback failure");
        cleanupStarted = true;
        await expect(
          rollbackAndSettleOwned(
            async () => {
              throw rollbackFailure;
            },
            () => {
              released = true;
              holder.release(true);
            },
            () => settleOwnedPools(control, [operationPool], [operation], [backends]),
          ),
        ).rejects.toMatchObject({ message: "Gmail fixture rollback failed", cause: rollbackFailure });
        expect(released).toBe(true);
        expect(backend.errors).toEqual([]);
        expect(backend.client.listeners("error")).not.toContain(backend.onError);
        const remaining = await bounded(
          control.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present",
            [backend.pid],
          ),
        );
        expect(remaining.rows[0]?.present).toBe(false);
      },
      async () => {
        await withOwnedFixture(
          async () => {
            if (!released) holder.release(true);
          },
          async () => {
            try {
              if (!cleanupStarted) await settleOwnedPools(control, [operationPool], [], [backends]);
            } finally {
              capture.detach();
              control.release(true);
            }
          },
        );
      },
    );
  }, 120_000);

  it("preserves a body failure when rollback also fails and the owned pool settles", async () => {
    const operationPool = await createRuntimeRolePool(admin, "semprec_data");
    const backends: OwnedBackend[] = [];
    const capture = capturePoolPids(operationPool, backends);
    const holder = await admin.connect();
    const control = await admin.connect();
    const bodyFailure = new Error("Injected body failure");
    const rollbackFailure = new Error("Injected rollback failure");
    const releaseFailure = new Error("Injected release failure");
    let released = false;
    let cleanupStarted = false;
    await withOwnedFixture(
      async () => {
        await bounded(holder.query("BEGIN"));
        const [outcome] = await Promise.allSettled([
          withOwnedFixture(
            async () => {
              await bounded(operationPool.query("SELECT 1"));
              throw bodyFailure;
            },
            async () => {
              cleanupStarted = true;
              await rollbackAndSettleOwned(
                async () => {
                  throw rollbackFailure;
                },
                () => {
                  released = true;
                  holder.release(true);
                  throw releaseFailure;
                },
                () => settleOwnedPools(control, [operationPool], [], [backends]),
              );
            },
          ),
        ]);
        if (outcome?.status !== "rejected" || !(outcome.reason instanceof AggregateError))
          throw new Error("Expected both fixture failures");
        expect(outcome.reason.cause).toBe(bodyFailure);
        expect(outcome.reason.errors[0]).toBe(bodyFailure);
        expect(outcome.reason.errors[1]).toMatchObject({ cause: rollbackFailure });
        const cleanupFailure: unknown = outcome.reason.errors[1];
        expect(cleanupFailure).toBeInstanceOf(AggregateError);
        if (!(cleanupFailure instanceof AggregateError)) throw new Error("Expected rollback and release failures");
        expect(cleanupFailure.errors).toHaveLength(2);
        expect(cleanupFailure.errors[0]).toBe(rollbackFailure);
        expect(cleanupFailure.errors[1]).toBe(releaseFailure);
        await expect(
          withOwnedFixture(
            async () => {
              throw bodyFailure;
            },
            async () => undefined,
          ),
        ).rejects.toBe(bodyFailure);
        await expect(
          withOwnedFixture(
            async () => undefined,
            async () => undefined,
          ),
        ).resolves.toBeUndefined();
        expect(released).toBe(true);
        const backend = backends[0];
        if (!backend) throw new Error("Missing owned backend");
        expect(backend.errors).toEqual([]);
        expect(backend.client.listeners("error")).not.toContain(backend.onError);
        const remaining = await bounded(
          control.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present",
            [backend.pid],
          ),
        );
        expect(remaining.rows[0]?.present).toBe(false);
      },
      async () => {
        await withOwnedFixture(
          async () => {
            if (!released) holder.release(true);
          },
          async () => {
            try {
              if (!cleanupStarted) await settleOwnedPools(control, [operationPool], [], [backends]);
            } finally {
              capture.detach();
              control.release(true);
            }
          },
        );
      },
    );
  }, 120_000);

  it("settles a connection acquired after owned pool cleanup starts", async () => {
    const params = await setup();
    const operationPool = await createRuntimeRolePool(admin, "semprec_data");
    const capturedBackends: OwnedBackend[] = [];
    const capture = capturePoolPids(operationPool, capturedBackends);
    const control = await admin.connect();
    let holder: PoolClient | undefined;
    let guardHeld = false;
    let holderReleased = false;
    let releaseConnection: () => void = () => undefined;
    let signalConnecting: () => void = () => undefined;
    const connecting = new Promise<void>((resolve) => {
      signalConnecting = resolve;
    });
    const allowConnection = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    let operation: Promise<void> | undefined;
    let observedCleanup: Promise<unknown> | undefined;
    await withOwnedFixture(
      async () => {
        const options: unknown = Reflect.get(operationPool, "options");
        if (typeof options !== "object" || options === null) throw new Error("Missing owned pool options");
        Reflect.set(options, "onConnect", async () => {
          signalConnecting();
          await allowConnection;
        });
        holder = await admin.connect();
        await bounded(control.query("SET statement_timeout = '3s'"));
        await bounded(holder.query("SET statement_timeout = '3s'"));
        await bounded(holder.query("SET lock_timeout = '2s'"));
        await bounded(holder.query("BEGIN"));
        guardHeld = true;
        const guard = `mail-thread-mutation:v1:${tenantId.toLowerCase()}`;
        const locked = await bounded(
          holder.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked",
            [guard],
          ),
        );
        expect(locked.rows[0]?.locked).toBe(true);
        const refused = await bounded(
          control.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked",
            [guard],
          ),
        );
        expect(refused.rows[0]?.locked).toBe(false);
        operation = runInTenant(tenantId, () =>
          withTransaction(operationPool, (client) => reconcileGmailAccount(client, gmailClient({}), params)),
        );
        const result = Promise.allSettled([operation]);
        await bounded(connecting);
        expect(capturedBackends).toEqual([]);
        const cleanup = settleOwnedPools(control, [operationPool], [operation], [capturedBackends], 100);
        observedCleanup = cleanup.then(
          () => undefined,
          (error: unknown) => error,
        );
        const deadline = Date.now() + 3000;
        while (Reflect.get(operationPool, "ending") !== true && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(Reflect.get(operationPool, "ending")).toBe(true);
        expect(capturedBackends).toEqual([]);
        releaseConnection();
        expect(await bounded(observedCleanup, 20_000)).toEqual(new Error("Gmail overlap timed out"));
        const operationResult = (await bounded(result))[0];
        expect(operationResult?.status).toBe("rejected");
        if (operationResult?.status !== "rejected" || !(operationResult.reason instanceof Error))
          throw new Error("Expected the late reconcile to fail on termination");
        expect(operationResult.reason.message).toMatch(
          /terminating connection due to administrator command|Connection terminated unexpectedly/,
        );
        expect(capturedBackends).toHaveLength(1);
        const backend = capturedBackends[0];
        if (!backend) throw new Error("Missing late acquired backend");
        expect(backend.errors.length).toBeGreaterThan(0);
        expect(backend.errors.every((error) => error.message === "Connection terminated unexpectedly")).toBe(true);
        expect(backend.client.listeners("error")).not.toContain(backend.onError);
        const remaining = await control.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present",
          [backend.pid],
        );
        expect(remaining.rows[0]?.present).toBe(false);
      },
      async () => {
        releaseConnection();
        await withOwnedFixture(
          async () =>
            withOwnedFixture(
              async () => {
                if (observedCleanup) await bounded(observedCleanup, 20_000);
              },
              async () => {
                await rollbackAndSettleOwned(
                  async () => {
                    if (guardHeld && holder) await bounded(holder.query("ROLLBACK"));
                  },
                  () => {
                    holderReleased = true;
                    holder?.release(true);
                  },
                  async () => {
                    if (!observedCleanup)
                      await settleOwnedPools(control, [operationPool], operation ? [operation] : [], [
                        capturedBackends,
                      ]);
                  },
                );
              },
            ),
          async () => {
            capture.detach();
            await withOwnedFixture(
              async () => {
                if (!holderReleased) holder?.release(true);
              },
              async () => {
                control.release(true);
              },
            );
          },
        );
      },
    );
  }, 120_000);

  it("cleanup removes pseudo-folders, keeps archived mail visible through Archive, and a second run changes nothing", async () => {
    const params = await setup();
    const inventory: GmailLabelRef[] = [
      ...LABELS,
      { id: "opaque-user", name: "Private", type: "user" },
      { id: "opaque-system", name: "System", type: "system" },
    ];
    const storedLabels: GmailLabelRef[] = [...inventory, { id: "absent-id", name: "Unknown", type: "user" }];
    // The state an older sync left behind: a folder for every label, mail linked to each.
    const messageIdsByLabels: Record<string, string[]> = {
      inboxUnread: ["INBOX", "UNREAD"],
      archivedUnread: ["UNREAD", "CATEGORY_PROMOTIONS"],
      archivedWork: ["STARRED", "Label_1"],
      sentStarred: ["SENT", "STARRED"],
      opaque: ["opaque-system", "opaque-user", "absent-id"],
    };
    await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const folderIds = new Map<string, string>();
        for (const label of storedLabels) {
          folderIds.set(
            label.id,
            await ensureFolderItem(client, {
              foldersDatabaseId: params.foldersDatabaseId,
              mailboxItemId: params.mailboxItemId,
              mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
              providerId: label.id,
              name: label.name,
              behavior: "label",
              specialPurpose: "none",
            }),
          );
        }
        for (const [messageId, labelIds] of Object.entries(messageIdsByLabels)) {
          for (const labelId of labelIds) {
            await ingestEmailMessage(client, {
              emailsDatabaseId: params.emailsDatabaseId,
              filesDatabaseId: params.filesDatabaseId,
              folderRelationPropertyId: params.folderRelationPropertyId,
              attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
              folderItemId: folderIds.get(labelId)!,
              mailboxItemId: params.mailboxItemId,
              providerMessageId: messageId,
              providerThreadId: `t-${messageId}`,
              storage,
              storageKeyPrefix: "test",
              messageId: `<${messageId}@x>`,
              envelope: { from: { address: "a@x.com" } },
              subject: messageId,
              attachments: [],
            });
          }
        }
      }),
    );

    await handleMailGmailPseudoFolderCleanupTask(pool, async () => inventory);

    expect(await folderProviderIds(params)).toEqual(
      ["DRAFT", "INBOX", "Label_1", "SENT", "opaque-user", "absent-id", GMAIL_ARCHIVE_PROVIDER_ID].sort(),
    );
    expect(await foldersOf(params, "inboxUnread")).toEqual(["INBOX"]);
    expect(await foldersOf(params, "archivedUnread")).toEqual([GMAIL_ARCHIVE_PROVIDER_ID]);
    expect(await foldersOf(params, "archivedWork")).toEqual(["Label_1", GMAIL_ARCHIVE_PROVIDER_ID].sort());
    expect(await foldersOf(params, "sentStarred")).toEqual(["SENT"]);
    expect(await foldersOf(params, "opaque")).toEqual(["opaque-user", "absent-id", GMAIL_ARCHIVE_PROVIDER_ID].sort());

    const snapshot = async () =>
      (await admin.query("SELECT * FROM item_relations ORDER BY id")).rows.map((r) => JSON.stringify(r));
    const edgesAfterFirst = await snapshot();
    const { rows: itemsAfterFirst } = await admin.query("SELECT id, deleted_at FROM items ORDER BY id");
    await handleMailGmailPseudoFolderCleanupTask(pool, async () => inventory);
    expect(await snapshot()).toEqual(edgesAfterFirst);
    expect((await admin.query("SELECT id, deleted_at FROM items ORDER BY id")).rows).toEqual(itemsAfterFirst);
  });
});
