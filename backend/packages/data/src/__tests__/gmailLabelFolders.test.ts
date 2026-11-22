import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  GMAIL_ARCHIVE_PROVIDER_ID,
  reconcileGmailAccount,
  type GmailLabelRef,
  type GmailMailClient,
} from "../mail/gmailReconcile.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { gmailHistory, recentGmailListing } from "../testSupport/gmailListing.js";
import { UNGUARDED_MAIL_SYNC_PASS } from "../testSupport/mailSyncPass.js";

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
    listHistorySince: async () => gmailHistory("101", Object.keys(messages)),
    listMessageIds: recentGmailListing(Object.keys(messages)),
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
    reconcileGmailAccount(pool, gmailClient(messages), { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }),
  );
}

async function folderProviderIds(params: Setup): Promise<string[]> {
  const { rows } = await admin.query<{ pid: string }>(
    `SELECT properties ->> 'providerId' AS pid FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY 1`,
    [params.foldersDatabaseId],
  );
  return rows.map((r) => r.pid);
}

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

  it("trashes a message Gmail reports deleted and drops its meta row, leaving the others", async () => {
    const params = await setup();
    await sync(params, { m1: ["INBOX"], m2: ["INBOX"] });
    const deletedGmail: GmailMailClient = {
      ...gmailClient({ m2: ["INBOX"] }),
      listHistorySince: async () => gmailHistory("102", [], ["m1"]),
      fetchMessage: async () => null,
    };
    await runInTenant(tenantId, () =>
      reconcileGmailAccount(pool, deletedGmail, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }),
    );
    const { rows } = await admin.query<{ subject: string; trashed: boolean; meta: boolean }>(
      `SELECT i.properties ->> 'name' AS subject, i.deleted_at IS NOT NULL AS trashed,
              EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.item_id = i.id) AS meta
         FROM items i WHERE i.database_id = $1 ORDER BY 1`,
      [params.emailsDatabaseId],
    );
    expect(rows).toEqual([
      { subject: "m1", trashed: true, meta: false },
      { subject: "m2", trashed: false, meta: true },
    ]);
    expect(await foldersOf(params, "m2")).toEqual(["INBOX"]);
  });

  it("renames the Folder of a renamed label and retires the Folder of a deleted label once it is empty", async () => {
    const params = await setup();
    const withLabels = (labels: GmailLabelRef[], messages: Record<string, string[]>): GmailMailClient => ({
      ...gmailClient(messages),
      listLabels: async () => labels,
    });
    const work = (name: string): GmailLabelRef => ({ id: "Label_1", name, type: "user" });
    const systemLabels = LABELS.filter((label) => label.type === "system");
    const pass = (gmail: GmailMailClient) =>
      runInTenant(tenantId, () => reconcileGmailAccount(pool, gmail, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }));
    const folderNames = async (): Promise<Array<{ pid: string; name: string }>> => {
      const { rows } = await admin.query<{ pid: string; name: string }>(
        `SELECT properties ->> 'providerId' AS pid, properties ->> 'name' AS name FROM items
          WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'providerId' = 'Label_1'`,
        [params.foldersDatabaseId],
      );
      return rows;
    };

    await pass(withLabels([...systemLabels, work("Work")], { m1: ["INBOX", "Label_1"] }));
    await pass(withLabels([...systemLabels, work("Práce")], { m1: ["INBOX", "Label_1"] }));
    expect(await folderNames()).toEqual([{ pid: "Label_1", name: "Práce" }]);

    // Gone from the label list while a message is still linked to it: kept until the message leaves it.
    const stillLinked = withLabels(systemLabels, {});
    stillLinked.listHistorySince = async () => gmailHistory("103");
    await pass(stillLinked);
    expect(await folderNames()).toEqual([{ pid: "Label_1", name: "Práce" }]);

    const relabelled = withLabels(systemLabels, { m1: ["INBOX"] });
    relabelled.listHistorySince = async () => gmailHistory("104", ["m1"]);
    await pass(relabelled);
    expect(await foldersOf(params, "m1")).toEqual(["INBOX"]);
    await pass(stillLinked);
    expect(await folderNames()).toEqual([]);
    expect(await folderProviderIds(params)).toEqual(["DRAFT", "INBOX", "SENT", GMAIL_ARCHIVE_PROVIDER_ID].sort());
  });

  it("rejects missing and system tenant scope before Gmail reconciliation queries or provider calls", async () => {
    const params = await setup();
    const connect = vi.spyOn(pool, "connect");
    const gmail = gmailClient({});
    const listLabels = vi.spyOn(gmail, "listLabels");
    try {
      const passParams = { ...params, pass: UNGUARDED_MAIL_SYNC_PASS };
      await expect(reconcileGmailAccount(pool, gmail, passParams)).rejects.toThrow(/tenant scope/i);
      await expect(
        runAsSystem("gmail-scope-test", () => reconcileGmailAccount(pool, gmail, passParams)),
      ).rejects.toThrow(/tenant scope/i);
      expect(connect).not.toHaveBeenCalled();
      expect(listLabels).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it("settles and closes an owned reconcile that times out before the provider call after its first transaction", async () => {
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
        // A first pass captures the history id after its prepare transaction, which waits for the guard.
        const gmail = gmailClient({});
        gmail.getCurrentHistoryId = async () => {
          barrierReached = true;
          return "100";
        };
        operation = runInTenant(tenantId, () =>
          reconcileGmailAccount(operationPool, gmail, { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }),
        ).then(() => undefined);
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
          reconcileGmailAccount(operationPool, gmailClient({}), { ...params, pass: UNGUARDED_MAIL_SYNC_PASS }),
        ).then(() => undefined);
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
});
