import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { drainGmailMoves, drainGraphMoves, drainImapMoves } from "../mail/mailMessageMoveSync.js";
import { logger } from "../mail/logger.js";
import { reconcileImapAccount, type ImapMailClient } from "../mail/imapReconcile.js";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { GmailRestClient } from "../mail/gmailRestClient.js";
import { GraphRestClient } from "../mail/graphRestClient.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { getMailMessageMetaByItemId, upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import {
  executeImapMoveStep,
  prepareGmailMove,
  prepareGraphMove,
  selectImapMoveProtocol,
} from "../mail/mailMoveProviderAdapters.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { listPendingImapFlagWrites } from "../mail/mailMessageFlagSyncStore.js";
import { createImapMailFlagWritebackAdapter } from "../mail/mailFlagWriteback.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ensureMailFolderSyncState, recordReconcile } from "../mail/mailFolderSyncStateStore.js";
import { EMAILS_RELATION_CONTEXT } from "../mail/emailsRelationContext.js";
import {
  claimMailMoveStep,
  completeGraphMove,
  checkpointMailMoveStep,
  hasPreservedMailMoveSource,
  listPendingMoves,
  markMailMoveUncertain,
  markMoveAttemptFailed,
  markMoveConfirmed,
  recordDesiredMailMessageMove,
} from "../mail/mailMessageMoveSyncStore.js";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { UNGUARDED_IMAP_PASS } from "../testSupport/imapSyncPass.js";

let admin: Pool;
let pool: Pool;
let a: string;
let b: string;

type RecordInput = Parameters<typeof recordDesiredMailMessageMove>[1];
type ClaimInput = Parameters<typeof claimMailMoveStep>[1];

const inTenant = <T>(fn: (client: PoolClient) => Promise<T>, tenantId = a) =>
  runInTenant(tenantId, () => withTransaction(pool, fn));
const record = (input: RecordInput, tenantId = a) =>
  inTenant((client) => recordDesiredMailMessageMove(client, input), tenantId);
const claim = (input: ClaimInput) => inTenant((client) => claimMailMoveStep(client, input));
const confirm = (messageItemId: string, revision: string) =>
  inTenant((client) => markMoveConfirmed(client, messageItemId, revision));
const pendingMoves = (mailboxItemId: string, tenantId = a) =>
  inTenant((client) => listPendingMoves(client, mailboxItemId), tenantId);
const providerMessageIdOf = async (messageItemId: string) =>
  (await inTenant((client) => getMailMessageMetaByItemId(client, messageItemId)))?.providerMessageId;
const moveState = async (messageItemId: string) =>
  (
    await inTenant((client) =>
      client.query<{ status: string; attempts: number; failure_reason: string }>(
        "SELECT status, attempts, failure_reason FROM mail_message_move_sync_state WHERE message_item_id = $1",
        [messageItemId],
      ),
    )
  ).rows[0];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const gmailClient = (request: typeof fetch) => new GmailRestClient(async () => "fake-token", request);
const graphClient = (request: typeof fetch) => new GraphRestClient(async () => "fake-token", request);
const gmailEvidence = (messageId: string, labels: { inTrash?: boolean; inInbox?: boolean } = {}) => ({
  provider: "gmail" as const,
  messageId,
  inTrash: false,
  inInbox: true,
  inSent: false,
  ...labels,
});

/** The provider adapters must run outside any database transaction held by the move worker. */
async function assertNoMoveTransaction(): Promise<void> {
  const activity = await admin.query<{ pid: number; xact_start: Date | null }>(
    "SELECT pid, xact_start FROM pg_stat_activity WHERE datname = current_database() AND usename = 'semprec_data'",
  );
  expect(activity.rows.length).toBeGreaterThan(0);
  expect(activity.rows.every((row) => row.xact_start === null)).toBe(true);
}

async function withFakeTimers(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

async function fixture(
  tenantId: string,
): Promise<{ mailboxItemId: string; messageItemId: string; source: { provider: "gmail"; providerMessageId: string } }> {
  return runInTenant(tenantId, async () => {
    const mailboxItemId = await createTestModuleItem(pool, "mailboxes");
    const messageItemId = await createTestModuleItem(pool, "emails");
    const providerMessageId = `fake-${randomUUID()}`;
    await withTransaction(pool, (client) =>
      upsertMailMessageMeta(client, {
        itemId: messageItemId,
        mailboxItemId,
        messageId: `<${randomUUID()}@example.test>`,
        providerMessageId,
        envelope: {},
      }),
    );
    return { mailboxItemId, messageItemId, source: { provider: "gmail", providerMessageId } };
  });
}

/** A Graph move for a fresh message, claimed with an in-flight `move` step. */
async function claimedGraphMove() {
  const own = await fixture(a);
  const source = { provider: "graph" as const, providerMessageId: own.source.providerMessageId };
  const move = await record({ ...own, source, desiredPurpose: "archive" });
  const token = randomUUID();
  await claim({
    messageItemId: own.messageItemId,
    revision: move.desired_revision,
    token,
    step: "move",
    evidence: { provider: "graph", sourceId: source.providerMessageId, targetFolderId: "archive" },
  });
  return { own, source, token };
}

/** A local write that gives the message a newer provider identity than the claimed operation captured. */
async function replaceProviderMessageId(messageItemId: string, mailboxItemId: string, providerMessageId: string) {
  await inTenant(async (client) => {
    const existing = await getMailMessageMetaByItemId(client, messageItemId);
    if (!existing) throw new Error("missing fixture metadata");
    await upsertMailMessageMeta(client, {
      itemId: existing.itemId,
      mailboxItemId,
      messageId: existing.messageId,
      providerMessageId,
      envelope: {},
    });
  });
}

type ImapFixture = Awaited<ReturnType<typeof imapFixture>>;

/**
 * A seeded mailbox with one message and the given IMAP folders; the message is linked to the first folder with
 * UID 7.
 */
async function imapFixture(folders: { path: string; purpose: string; uidValidity: string; uidNext: string }[]) {
  await runInTenant(a, () => seedSystem(pool));
  return inTenant(async (client) => {
    const mailboxDb = await getDatabaseByModuleId(client, "mailboxes");
    const emailDb = await getDatabaseByModuleId(client, "emails");
    const folderDb = await getDatabaseByModuleId(client, "folders");
    if (!mailboxDb || !emailDb || !folderDb) throw new Error("Missing mail databases");
    const emailFolder = await getPropertyByKey(client, emailDb.id, "folder");
    const folderMailbox = await getPropertyByKey(client, folderDb.id, "mailbox");
    if (!emailFolder || !folderMailbox) throw new Error("Missing mail relation properties");
    const mailbox = await createItemWithClient(client, { databaseId: mailboxDb.id, properties: { name: "Mailbox" } });
    const message = await createItemWithClient(
      client,
      { databaseId: emailDb.id, properties: { name: "Message" } },
      { allowedSystemKeys: ["name"] },
    );
    const messageId = `<${randomUUID()}@example.test>`;
    await upsertMailMessageMeta(client, { itemId: message.id, mailboxItemId: mailbox.id, messageId, envelope: {} });
    const folderIds: string[] = [];
    for (const folder of folders) {
      const id = await ensureFolderItem(client, {
        foldersDatabaseId: folderDb.id,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: folderMailbox.id,
        providerId: folder.path,
        name: folder.path,
        behavior: "folder",
        specialPurpose: folder.purpose,
      });
      await ensureMailFolderSyncState(client, id);
      await recordReconcile(client, {
        itemId: id,
        uidvalidity: folder.uidValidity,
        uidnext: folder.uidNext,
        highestmodseq: null,
      });
      folderIds.push(id);
    }
    const fx = {
      mailboxItemId: mailbox.id,
      messageItemId: message.id,
      messageId,
      folderIds,
      emailsDatabaseId: emailDb.id,
      foldersDatabaseId: folderDb.id,
      folderPropertyId: emailFolder.id,
      mailboxPropertyId: folderMailbox.id,
    };
    await linkFolder(client, fx, folderIds[0]!, 7);
    return fx;
  });
}

const linkFolder = (
  client: PoolClient,
  fx: Pick<ImapFixture, "folderPropertyId" | "messageItemId">,
  folderId: string,
  uid?: number,
) =>
  createRelationWithClient(
    client,
    {
      relationPropertyId: fx.folderPropertyId,
      callerItemId: fx.messageItemId,
      targetItemId: folderId,
      ...(uid === undefined ? {} : { metadata: { uid } }),
    },
    EMAILS_RELATION_CONTEXT,
  );
const unlinkFolder = (client: PoolClient, fx: ImapFixture, folderId: string) =>
  deleteRelationWithClient(
    client,
    { relationPropertyId: fx.folderPropertyId, callerItemId: fx.messageItemId, targetItemId: folderId },
    EMAILS_RELATION_CONTEXT,
  );

/** Records the desired IMAP move from `from` and relinks the message locally from `from` to `to`. */
const moveImapLocally = (
  fx: ImapFixture,
  desiredPurpose: RecordInput["desiredPurpose"],
  from: { folderId: string; path: string; uid: number; uidValidity: string },
  to: string,
) =>
  inTenant(async (client) => {
    await recordDesiredMailMessageMove(client, {
      messageItemId: fx.messageItemId,
      mailboxItemId: fx.mailboxItemId,
      desiredPurpose,
      source: {
        provider: "imap",
        folderItemId: from.folderId,
        path: from.path,
        uid: from.uid,
        uidValidity: from.uidValidity,
      },
    });
    await unlinkFolder(client, fx, from.folderId);
    await linkFolder(client, fx, to);
  });

const drainImap = (fx: ImapFixture, create: () => Promise<ImapMailClient>) =>
  runInTenant(a, () =>
    drainImapMoves(pool, fx.mailboxItemId, create, fx.foldersDatabaseId, fx.mailboxPropertyId, fx.folderPropertyId),
  );
const fakeImapClient = (
  prepare: { uidValidity: string; capabilities: string[] },
  executeMoveStep: unknown,
  close = async () => {},
) =>
  ({
    prepareMove: async () => ({ ...prepare, capabilities: new Set(prepare.capabilities), found: true }),
    executeMoveStep,
    close,
  }) as unknown as ImapMailClient;
const imapFlow = (raw: Record<string, unknown>) => raw as unknown as ImapFlow;
const imapFlowOn = (path: string, uidValidity: bigint, raw: Record<string, unknown>) =>
  imapFlow({
    mailbox: { path, uidValidity },
    mailboxOpen: async () => ({ path, uidValidity }),
    logout: async () => {},
    close: () => {},
    ...raw,
  });

describe("mail move intent store", () => {
  it("prepares one-use Gmail and Graph commands without a second token lookup", async () => {
    const tokens = vi.fn(async () => "fake-token");
    const gmailFetch = vi.fn(async () => Response.json({ id: "g", labelIds: ["TRASH"] }));
    const graphFetch = vi.fn(async () => Response.json({ id: "new-graph-id" }));
    const gmailCommand = await prepareGmailMove(new GmailRestClient(tokens, gmailFetch), "g", "trash");
    const graphCommand = await prepareGraphMove(new GraphRestClient(tokens, graphFetch), "graph-id", "archive");
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(gmailFetch).not.toHaveBeenCalled();
    expect(graphFetch).not.toHaveBeenCalled();
    expect(await gmailCommand()).toMatchObject({ kind: "acknowledged" });
    expect(await graphCommand()).toEqual({ kind: "moved", id: "new-graph-id" });
    expect(() => gmailCommand()).toThrow("already used");
    expect(() => graphCommand()).toThrow("already used");
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(gmailFetch).toHaveBeenCalledTimes(1);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it("closes a timed-out IMAP preparation, joins its late result, and never starts SEARCH", () =>
    withFakeTimers(async () => {
      let release!: (value: { uidValidity: bigint }) => void;
      const open = vi.fn(() => new Promise<{ uidValidity: bigint }>((resolve) => (release = resolve)));
      const search = vi.fn();
      const close = vi.fn();
      const client = new ImapFlowMailClient(imapFlow({ mailboxOpen: open, search, close, capabilities: new Map() }));
      let settled = false;
      const pending = client.prepareMove("INBOX", 10).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      release({ uidValidity: 2n });
      await expect(pending).resolves.toBeNull();
      expect(search).not.toHaveBeenCalled();
      await client.close();
      expect(close).toHaveBeenCalledTimes(1);
    }));

  it("keeps a late IMAP MOVE acknowledgement uncertain and forbids a second step", () =>
    withFakeTimers(async () => {
      let release!: (value: unknown) => void;
      const move = vi.fn(() => new Promise<unknown>((resolve) => (release = resolve)));
      const close = vi.fn();
      const client = new ImapFlowMailClient(
        imapFlow({
          mailbox: { path: "INBOX", uidValidity: 2n },
          capabilities: new Map([["MOVE", true]]),
          messageMove: move,
          close,
        }),
      );
      let settled = false;
      const pending = client.executeMoveStep("move", "INBOX", 10, "2", "Archive").then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      release({ path: "INBOX", destination: "Archive", uidMap: new Map([[10, 20]]), uidValidity: 3n });
      await expect(pending).resolves.toEqual({ kind: "uncertain" });
      await expect(client.executeMoveStep("move", "INBOX", 10, "2", "Archive")).resolves.toEqual({ kind: "uncertain" });
      expect(move).toHaveBeenCalledTimes(1);
      await client.close();
    }));

  it("keeps a timed-out IMAP operation and close failure private through actual settlement", () =>
    withFakeTimers(async () => {
      const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        let rejectOperation!: (error: unknown) => void;
        const client = new ImapFlowMailClient(
          imapFlow({
            mailboxOpen: () => new Promise((_resolve, reject) => (rejectOperation = reject)),
            close: () => {
              throw new Error("private close failure");
            },
            capabilities: new Map(),
          }),
        );
        const pending = client.prepareMove("private-folder", 10);
        await vi.advanceTimersByTimeAsync(30_000);
        rejectOperation(undefined);
        await expect(pending).resolves.toBeNull();
        await expect(client.close()).rejects.toThrow("IMAP move provider cleanup failed unexpectedly");
        expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
      } finally {
        warning.mockRestore();
      }
    }));

  it.each([
    [["MOVE", "UIDPLUS"], "move"],
    [["MOVE"], "move"],
    [["UIDPLUS"], "copy"],
    [[], "unsupportedCapability"],
  ] as const)("selects the safe IMAP protocol for %j", (capabilities, expected) => {
    expect(selectImapMoveProtocol(new Set(capabilities))).toBe(expected);
  });

  it("refuses unsupported IMAP commands before mutation and leaves unrelated deleted messages alone", async () => {
    const unrelatedDeleted = new Set([99]);
    const mutation = () =>
      vi.fn(async () => {
        unrelatedDeleted.clear();
        return true;
      });
    const commands = {
      messageCopy: mutation(),
      messageFlagsAdd: mutation(),
      messageDelete: mutation(),
      messageMove: mutation(),
    };
    const client = imapFlow({ capabilities: new Map(), mailbox: { path: "INBOX", uidValidity: 42n }, ...commands });
    for (const step of ["move", "copy", "mark_deleted", "expunge"] as const) {
      expect(await executeImapMoveStep(client, step, "INBOX", 7, "42", "Archive")).toEqual({
        kind: "unsupportedCapability",
      });
    }
    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
    expect([...unrelatedDeleted]).toEqual([99]);
  });

  it("treats a false native MOVE response as uncertain and validates returned UID evidence", async () => {
    const move = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ path: "INBOX", destination: "Archive", uidValidity: 43n, uidMap: new Map([[7, 23]]) });
    const client = imapFlow({
      capabilities: new Map([["MOVE", true]]),
      mailbox: { path: "INBOX", uidValidity: 42n },
      messageMove: move,
    });
    expect(await executeImapMoveStep(client, "move", "INBOX", 7, "42", "Archive")).toEqual({
      kind: "uncertain",
      observed: false,
    });
    expect(await executeImapMoveStep(client, "move", "INBOX", 7, "42", "Archive")).toEqual({
      kind: "acknowledged",
      targetUid: 23,
      targetUidValidity: "43",
    });
    expect(move).toHaveBeenCalledWith("7", "Archive", { uid: true });
  });

  it("uses bounded Graph observation and move calls without exposing provider text", async () => {
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "old-id", parentFolderId: "folder-1" }))
      .mockResolvedValueOnce(json({ id: "new-id" }, 201))
      .mockResolvedValueOnce(new Response("secret body", { status: 404 }))
      .mockRejectedValueOnce(new Error("secret token and address"));
    const client = graphClient(fetchProvider);
    expect(await client.observeMoveMessage("old-id")).toEqual({
      kind: "found",
      id: "old-id",
      parentFolderId: "folder-1",
    });
    expect(await client.moveMessage("old-id", "archive")).toEqual({ kind: "moved", id: "new-id" });
    expect(await client.observeMoveMessage("missing-id")).toEqual({ kind: "missing" });
    expect(await client.moveMessage("old-id", "inbox")).toEqual({ kind: "uncertain" });
    expect(fetchProvider).toHaveBeenCalledTimes(4);
  });

  it("observes Gmail labels and keeps an ambiguous mutation unconfirmed", async () => {
    const gmail = gmailClient(
      vi
        .fn()
        .mockResolvedValueOnce(json({ id: "mail-id", labelIds: ["TRASH", "SENT"] }))
        .mockResolvedValueOnce(json({ id: "mail-id", labelIds: ["SENT"] }))
        .mockRejectedValueOnce(new Error("private provider failure")),
    );
    expect(await gmail.observeMoveMessage("mail-id")).toEqual({
      kind: "found",
      inTrash: true,
      inInbox: false,
      inSent: true,
    });
    expect(await gmail.applyMoveStep("mail-id", "untrash")).toEqual({
      kind: "acknowledged",
      inTrash: false,
      inInbox: false,
      inSent: true,
    });
    expect(await gmail.applyMoveStep("mail-id", "add_inbox")).toEqual({ kind: "uncertain" });
  });

  it("settles a Graph response read and failing cleanup before private diagnostics", async () => {
    const read = vi.fn(async () => {
      throw new Error("provider-secret-in-read");
    });
    const cancel = vi.fn(async () => {
      // Provider cleanup may reject without a value; the owner must retain its presence.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    });
    const releaseLock = vi.fn();
    const response = {
      ok: true,
      status: 200,
      body: { locked: false, getReader: () => ({ read, cancel, releaseLock }), cancel: vi.fn(async () => {}) },
    } as unknown as Response;
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {
      expect(cancel).toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalled();
      throw new Error("diagnostic-secret");
    });
    try {
      const graph = new GraphRestClient(
        async () => "token-secret",
        async () => response,
      );
      expect(await graph.moveMessage("message-id", "archive")).toEqual({ kind: "uncertain" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/provider-secret|token-secret|diagnostic-secret/);
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps token-acquisition failures outside the Graph provider boundary", async () => {
    const original = new Error("token-source-failure");
    const request = vi.fn();
    const graph = new GraphRestClient(async () => {
      throw original;
    }, request);
    await expect(graph.moveMessage("message-id", "archive")).rejects.toBe(original);
    expect(request).not.toHaveBeenCalled();
  });

  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    a = await createTestTenant(admin);
    b = await createTestTenant(admin);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("tracks revisions, refuses foreign identities and confirms only the current revision", async () => {
    const own = await fixture(a);
    const other = await fixture(b);
    const first = await record({ ...own, desiredPurpose: "archive" });
    const second = await record({ ...own, desiredPurpose: "inbox" });
    expect(first.desired_revision).toBe("1");
    expect(second.desired_revision).toBe("2");
    await expect(record({ ...own, desiredPurpose: "trash" }, b)).rejects.toThrow(
      "Mail message is not available in this mailbox",
    );
    expect(await pendingMoves(other.mailboxItemId, b)).toEqual([]);
    expect(await confirm(own.messageItemId, first.desired_revision)).toBe(false);
    expect(await confirm(own.messageItemId, second.desired_revision)).toBe(true);
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
  });

  it.each(["none", "pending", "operation outstanding", "done", "failed"] as const)(
    "decides in one place whether a new desire keeps the earlier source: %s",
    async (state) => {
      const own = await fixture(a);
      if (state !== "none") {
        const first = await record({ ...own, desiredPurpose: "archive" });
        const revision = first.desired_revision;
        if (state === "operation outstanding")
          expect(
            await claim({
              messageItemId: own.messageItemId,
              revision,
              token: randomUUID(),
              step: "modify_labels",
              evidence: gmailEvidence(own.source.providerMessageId),
            }),
          ).toBe(true);
        if (state === "done") expect(await confirm(own.messageItemId, revision)).toBe(true);
        if (state === "failed")
          expect(
            await inTenant((client) =>
              markMoveAttemptFailed(client, own.messageItemId, revision, "providerRejected", 1),
            ),
          ).toBe(true);
      }
      const keeps = state === "pending" || state === "operation outstanding";

      expect(await inTenant((client) => hasPreservedMailMoveSource(client, own.messageItemId))).toBe(keeps);
      // The store keeps the earlier source exactly when the helper says so: a desire without a source of its own is
      // recorded then and refused otherwise.
      const recorded = record({
        messageItemId: own.messageItemId,
        mailboxItemId: own.mailboxItemId,
        desiredPurpose: "trash",
      });
      if (keeps) expect(await recorded).toMatchObject({ desired_purpose: "trash", source_evidence: own.source });
      else await expect(recorded).rejects.toThrow();
    },
  );

  it.each([
    ["acknowledged outcome", false, 0],
    ["uncertain evidence", true, null],
  ] as const)("rolls back %s when its state write reports no row", async (_name, conflict, reportedCount) => {
    const { own, source, token } = await claimedGraphMove();
    if (conflict) await replaceProviderMessageId(own.messageItemId, own.mailboxItemId, "newer-local-id");
    let intercepted = false;
    await expect(
      inTenant(async (client) => {
        const realQuery = client.query.bind(client);
        const spy = vi.spyOn(client, "query");
        // The exercised store calls use pg's promise overload.
        const forward = async (sql: string, values?: unknown[]) => {
          const result = await realQuery(sql, values);
          if (
            sql.includes("UPDATE mail_message_move_sync_state SET") &&
            (conflict ? sql.includes("operation_phase = 'uncertain'") : sql.includes("source_evidence = $3::jsonb"))
          ) {
            intercepted = true;
            return { ...result, rowCount: reportedCount };
          }
          return result;
        };
        // pg's final overload returns void; the store uses the promise overload.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        spy.mockImplementation(forward as typeof client.query);
        try {
          return await completeGraphMove(client, {
            messageItemId: own.messageItemId,
            token,
            resultId: "remote-result",
          });
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toThrow(`Expected mail move outcome to affect at least one row, got ${reportedCount}`);
    expect(intercepted).toBe(true);
    expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
      operation_token: token,
      operation_phase: "in_flight",
      operation_evidence: { provider: "graph", sourceId: source.providerMessageId },
      status: "pending",
    });
    expect(await providerMessageIdOf(own.messageItemId)).toBe(conflict ? "newer-local-id" : source.providerMessageId);
  });

  it("keeps an acknowledged Graph identity without confirming an A-B-A desire", async () => {
    const { own, source, token } = await claimedGraphMove();
    for (const desiredPurpose of ["inbox", "archive"] as const) await record({ ...own, source, desiredPurpose });
    expect(
      await inTenant((client) =>
        completeGraphMove(client, { messageItemId: own.messageItemId, token, resultId: "new-graph-id" }),
      ),
    ).toBe("pending");
    expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
      desired_revision: "3",
      current_purpose: "archive",
      status: "pending",
      source_evidence: { provider: "graph", providerMessageId: "new-graph-id" },
      operation_token: null,
    });
    expect(await providerMessageIdOf(own.messageItemId)).toBe("new-graph-id");
  });

  it("retains Graph result evidence instead of overwriting a newer stored identity", async () => {
    const { own, token } = await claimedGraphMove();
    await replaceProviderMessageId(own.messageItemId, own.mailboxItemId, "newer-local-id");
    expect(
      await inTenant((client) =>
        completeGraphMove(client, { messageItemId: own.messageItemId, token, resultId: "old-operation-result" }),
      ),
    ).toBe("conflict");
    expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
      operation_phase: "uncertain",
      operation_evidence: { resultId: "old-operation-result" },
    });
    expect(await providerMessageIdOf(own.messageItemId)).toBe("newer-local-id");
  });

  it.each([
    ["archive", ["INBOX"], [], "modify"],
    ["trash", ["INBOX"], ["TRASH"], "trash"],
    ["sent", ["TRASH", "SENT"], ["SENT"], "untrash"],
  ] as const)("moves Gmail to %s and confirms the returned labels", async (purpose, before, after, command) => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: purpose });
    const id = own.source.providerMessageId;
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ id, labelIds: before }))
      .mockResolvedValueOnce(json({ id, labelIds: after }));
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmailClient(request)));
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain(`/${command}`);
  });

  it.each([
    ["archive", []],
    ["trash", ["TRASH"]],
    ["inbox", ["INBOX"]],
    ["sent", ["SENT"]],
  ] as const)("confirms an observed matching Gmail %s without mutation", async (purpose, labels) => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: purpose });
    const request = vi.fn().mockResolvedValueOnce(json({ id: own.source.providerMessageId, labelIds: labels }));
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmailClient(request)));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
  });

  it("stops Gmail retries after five verified 404 observations", async () => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: "trash" });
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    const gmail = gmailClient(request);
    for (let count = 0; count < 6; count++) await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    expect(await moveState(own.messageItemId)).toEqual({
      status: "failed",
      attempts: 5,
      failure_reason: "messageMissing",
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("does not replay an unacknowledged Gmail untrash", async () => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: "inbox" });
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ id: own.source.providerMessageId, labelIds: ["TRASH"] }))
      .mockRejectedValueOnce(new Error("private provider failure"));
    const gmail = gmailClient(request);
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
      operation_phase: "uncertain",
      operation_step: "untrash",
      status: "pending",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("checkpoints Gmail untrash before a later inbox-label command", async () => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: "inbox" });
    const id = own.source.providerMessageId;
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id, labelIds: ["TRASH"] }))
      .mockResolvedValueOnce(json({ id, labelIds: [] }))
      .mockImplementationOnce(async () => {
        const row = (await withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)))[0];
        expect(row).toMatchObject({
          operation_phase: "in_flight",
          operation_step: "modify_labels",
          operation_evidence: { inTrash: false, inInbox: false },
        });
        return json({ id, labelIds: ["INBOX"] });
      });
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmailClient(fetchProvider)));
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
    expect(fetchProvider).toHaveBeenCalledTimes(3);
  });

  it("resumes an acknowledged Gmail checkpoint without repeating untrash", async () => {
    const own = await fixture(a);
    const row = await record({ ...own, desiredPurpose: "inbox" });
    const token = randomUUID();
    const evidence = gmailEvidence(own.source.providerMessageId, { inTrash: true, inInbox: false });
    await claim({ messageItemId: own.messageItemId, revision: row.desired_revision, token, step: "untrash", evidence });
    await inTenant((client) =>
      checkpointMailMoveStep(client, {
        messageItemId: own.messageItemId,
        token,
        nextStep: "modify_labels",
        evidence: { ...evidence, inTrash: false },
      }),
    );
    const request = vi.fn().mockResolvedValueOnce(json({ id: evidence.messageId, labelIds: ["INBOX"] }));
    const tokenFailure = new Error("private token acquisition failure");
    const before = await pendingMoves(own.mailboxItemId);
    await expect(
      runInTenant(a, () =>
        drainGmailMoves(
          pool,
          own.mailboxItemId,
          new GmailRestClient(async () => {
            throw tokenFailure;
          }, request),
        ),
      ),
    ).rejects.toBe(tokenFailure);
    expect(request).not.toHaveBeenCalled();
    expect(await pendingMoves(own.mailboxItemId)).toEqual(before);
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmailClient(request)));
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain("/modify");
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
  });

  it.each([
    ["archive", "archive"],
    ["trash", "deleteditems"],
    ["inbox", "inbox"],
    ["sent", "sentitems"],
  ] as const)("persists a Graph move to %s after a claimed provider request", async (purpose, destination) => {
    await runInTenant(a, () => seedSystem(pool));
    const own = await fixture(a);
    const target = await inTenant(async (client) => {
      const folders = await getDatabaseByModuleId(client, "folders");
      if (!folders) throw new Error("Missing folders database");
      const mailbox = await getPropertyByKey(client, folders.id, "mailbox");
      if (!mailbox) throw new Error("Missing mailbox relation");
      await ensureFolderItem(client, {
        foldersDatabaseId: folders.id,
        mailboxItemId: own.mailboxItemId,
        mailboxRelationPropertyId: mailbox.id,
        providerId: `${purpose}-id`,
        name: "Archive",
        behavior: "folder",
        specialPurpose: purpose,
      });
      return { databaseId: folders.id, propertyId: mailbox.id };
    });
    const drain = (graph: GraphRestClient) =>
      runInTenant(a, () => drainGraphMoves(pool, own.mailboxItemId, graph, target.databaseId, target.propertyId));
    const recordFrom = (providerMessageId: string) =>
      record({ ...own, source: { provider: "graph", providerMessageId }, desiredPurpose: purpose });
    const sourceId = own.source.providerMessageId;
    await recordFrom(sourceId);
    if (purpose === "archive") {
      const tokenFailure = new Error("private Graph token failure");
      let tokenCalls = 0;
      const observation = vi.fn(async () => Response.json({ id: sourceId, parentFolderId: "old-folder-id" }));
      const graph = new GraphRestClient(async () => {
        if (++tokenCalls === 2) throw tokenFailure;
        return "fake-token";
      }, observation);
      const before = await pendingMoves(own.mailboxItemId);
      await expect(drain(graph)).rejects.toBe(tokenFailure);
      expect(observation).toHaveBeenCalledTimes(1);
      expect(await pendingMoves(own.mailboxItemId)).toEqual(before);
    }
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await assertNoMoveTransaction();
        return json({ id: sourceId, parentFolderId: "old-folder-id" });
      })
      .mockImplementationOnce(async () => {
        await assertNoMoveTransaction();
        return json({ id: "new-id" }, 201);
      });
    await drain(graphClient(fetchProvider));
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
    expect(await providerMessageIdOf(own.messageItemId)).toBe("new-id");
    expect(fetchProvider).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchProvider).mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ destinationId: destination }));

    await recordFrom("new-id");
    const observeOnly = vi.fn().mockResolvedValueOnce(json({ id: "new-id", parentFolderId: `${purpose}-id` }));
    await drain(graphClient(observeOnly));
    expect(observeOnly).toHaveBeenCalledTimes(1);
    expect(observeOnly.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
    if (purpose !== "archive") return;

    await recordFrom("new-id");
    const stale = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "new-id", parentFolderId: "external-folder" }))
      .mockResolvedValueOnce(json({ id: "after-external-move" }, 201));
    await drain(graphClient(stale));
    expect(stale).toHaveBeenCalledTimes(2);

    await recordFrom("after-external-move");
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    const missingGraph = graphClient(missing);
    for (let count = 0; count < 6; count++) await drain(missingGraph);
    expect(await moveState(own.messageItemId)).toEqual({
      status: "failed",
      attempts: 5,
      failure_reason: "messageMissing",
    });
    expect(missing).toHaveBeenCalledTimes(5);

    await recordFrom("after-external-move");
    const afterRemote = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "after-external-move", parentFolderId: "other-folder" }))
      .mockResolvedValueOnce(json({ id: "rejected-local-result" }, 201));
    const rollbackGraph = graphClient(afterRemote);
    let created = false;
    let primary: { value: unknown } | undefined;
    try {
      // A trigger is the only way to make the local result write fail after the provider acknowledged the move.
      await admin.query(`CREATE FUNCTION batch18_reject_graph_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.provider_message_id = 'rejected-local-result' THEN RAISE EXCEPTION 'synthetic result rollback'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER batch18_reject_graph_result BEFORE UPDATE ON mail_message_meta
        FOR EACH ROW EXECUTE FUNCTION batch18_reject_graph_result()`);
      created = true;
      await expect(drain(rollbackGraph)).rejects.toThrow("synthetic result rollback");
      expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
        operation_phase: "in_flight",
        status: "pending",
      });
      await drain(rollbackGraph);
      expect(afterRemote).toHaveBeenCalledTimes(2);
    } catch (error) {
      primary = { value: error };
    }
    const cleanupErrors: unknown[] = [];
    try {
      if (created) await admin.query("DROP TRIGGER batch18_reject_graph_result ON mail_message_meta");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await admin.query("DROP FUNCTION IF EXISTS batch18_reject_graph_result()");
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primary && cleanupErrors.length)
      throw new AggregateError([primary.value, ...cleanupErrors], "Graph rollback test and cleanup failed");
    if (primary) throw primary.value;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Graph rollback cleanup failed");
  });

  it("stops retrying a definite missing message at its attempt limit", async () => {
    const own = await fixture(a);
    const move = await record({ ...own, desiredPurpose: "trash" });
    const fail = () =>
      inTenant((client) => markMoveAttemptFailed(client, own.messageItemId, move.desired_revision, "messageMissing"));
    for (let attempt = 0; attempt < 5; attempt++) expect(await fail()).toBe(true);
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
    expect(await fail()).toBe(false);
  });

  it("does not dispatch a second Gmail job while the first owns its step", async () => {
    const own = await fixture(a);
    await record({ ...own, desiredPurpose: "archive" });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return json({ id: own.source.providerMessageId, labelIds: ["INBOX"] });
      entered();
      await gate;
      return json({ id: own.source.providerMessageId, labelIds: [] });
    });
    const gmail = gmailClient(request);
    const first = runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail)).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let primary: { value: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        first.then(() => {
          throw new Error("first move settled before dispatch");
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("move dispatch timed out")), 5000);
        }),
      ]);
      await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
      expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    } catch (error) {
      primary = { value: error };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
    const settledFirst = await first;
    if (primary && !settledFirst.ok)
      throw new AggregateError([primary.value, settledFirst.error], "move overlap and cleanup failed");
    if (primary) throw primary.value;
    if (!settledFirst.ok) throw settledFirst.error;
    expect(await pendingMoves(own.mailboxItemId)).toEqual([]);
  });

  it("serializes competing move claims under the actual tenant guard", async () => {
    const own = await fixture(a);
    const move = await record({ ...own, desiredPurpose: "archive" });
    const claimInput = () => ({
      messageItemId: own.messageItemId,
      revision: move.desired_revision,
      token: randomUUID(),
      step: "modify_labels" as const,
      evidence: gmailEvidence(own.source.providerMessageId),
    });
    let release!: () => void;
    let firstReady!: (pid: number) => void;
    let secondReady!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const firstPidPromise = new Promise<number>((resolve) => (firstReady = resolve));
    const secondPidPromise = new Promise<number>((resolve) => (secondReady = resolve));
    const settled = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const backendPid = async (client: PoolClient) => {
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("missing claim PID");
      return pid;
    };
    const first = settled(
      inTenant(async (client) => {
        const pid = await backendPid(client);
        const claimed = await claimMailMoveStep(client, claimInput());
        firstReady(pid);
        await gate;
        return claimed;
      }),
    );
    let second: ReturnType<typeof settled<boolean>> | undefined;
    const waitPid = async (ready: Promise<number>, owner: Promise<unknown>): Promise<number> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ready,
          owner.then(() => {
            throw new Error("claim operation settled before reporting its PID");
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("claim PID timed out")), 5000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      const firstPid = await waitPid(firstPidPromise, first);
      second = settled(
        inTenant(async (client) => {
          secondReady(await backendPid(client));
          return claimMailMoveStep(client, claimInput());
        }),
      );
      const secondPid = await waitPid(secondPidPromise, second);
      await vi.waitFor(
        async () => {
          const blocked = await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [
            secondPid,
          ]);
          expect(blocked.rows[0]?.blockers).toContain(firstPid);
        },
        { timeout: 5000, interval: 25 },
      );
      release();
      expect(await first).toEqual({ ok: true, value: true });
      expect(await second).toEqual({ ok: true, value: false });
    } finally {
      release();
      await first;
      if (second) await second;
    }
  });

  it("allows one claim and preserves an uncertain operation across A-B-A desires", async () => {
    const own = await fixture(a);
    const first = await record({ ...own, desiredPurpose: "archive" });
    const evidence = gmailEvidence("fake-provider-id");
    const tokens = [randomUUID(), randomUUID()];
    const claims = await Promise.all(
      tokens.map((token) =>
        claim({
          messageItemId: own.messageItemId,
          revision: first.desired_revision,
          token,
          step: "modify_labels",
          evidence,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = tokens[claims.findIndex(Boolean)]!;
    await record({ ...own, desiredPurpose: "trash" });
    const latest = await record({ ...own, desiredPurpose: "archive" });
    expect(latest.desired_revision).toBe("3");
    expect(await inTenant((client) => markMailMoveUncertain(client, own.messageItemId, winner))).toBe(true);
    expect(await confirm(own.messageItemId, latest.desired_revision)).toBe(false);
    expect(
      await claim({
        messageItemId: own.messageItemId,
        revision: latest.desired_revision,
        token: randomUUID(),
        step: "modify_labels",
        evidence,
      }),
    ).toBe(false);
    expect((await pendingMoves(own.mailboxItemId))[0]).toMatchObject({
      desired_revision: "3",
      captured_revision: "1",
      operation_token: winner,
      operation_phase: "uncertain",
    });
  });

  it("resumes only the acknowledged checkpoint with its captured evidence", async () => {
    const own = await fixture(a);
    const move = await record({ ...own, desiredPurpose: "inbox" });
    const token = randomUUID();
    const before = gmailEvidence("fake-provider-id", { inTrash: true, inInbox: false });
    const after = { ...before, inTrash: false };
    const claimWith = (step: ClaimInput["step"], evidence: ClaimInput["evidence"]) =>
      claim({ messageItemId: own.messageItemId, revision: move.desired_revision, token, step, evidence });
    expect(await claimWith("untrash", before)).toBe(true);
    expect(
      await inTenant((client) =>
        checkpointMailMoveStep(client, {
          messageItemId: own.messageItemId,
          token,
          nextStep: "modify_labels",
          evidence: after,
        }),
      ),
    ).toBe(true);
    expect(await claimWith("modify_labels", before)).toBe(false);
    expect(await claimWith("modify_labels", after)).toBe(true);
    expect(await claimWith("modify_labels", after)).toBe(false);
  });

  it.each(["archive", "trash", "inbox", "sent"] as const)("moves IMAP to the mailbox's %s folder", async (purpose) => {
    const fx = await imapFixture([
      { path: "Source", purpose: purpose === "inbox" ? "junk" : "inbox", uidValidity: "11", uidNext: "50" },
      { path: "Destination", purpose, uidValidity: "12", uidNext: "50" },
    ]);
    const [sourceId, targetId] = fx.folderIds as [string, string];
    await moveImapLocally(fx, purpose, { folderId: sourceId, path: "Source", uid: 7, uidValidity: "11" }, targetId);
    const move = vi.fn(async () => ({ kind: "acknowledged" as const, targetUid: 27, targetUidValidity: "12" }));
    const fake = fakeImapClient({ uidValidity: "11", capabilities: ["MOVE"] }, move);
    await drainImap(fx, async () => fake);
    expect(move).toHaveBeenCalledWith("move", "Source", 7, "11", "Destination");
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);
    if (purpose !== "archive" && purpose !== "trash") return;

    await moveImapLocally(
      fx,
      "inbox",
      { folderId: targetId, path: "Destination", uid: 27, uidValidity: "12" },
      sourceId,
    );
    const copy = vi.fn(async () =>
      purpose === "archive"
        ? { path: "Destination", destination: "Source" }
        : { path: "Destination", destination: "Source", uidValidity: 99n, uidMap: new Map([[27, 44]]) },
    );
    const flags = vi.fn(async () => true);
    const expunge = vi.fn(async () => true);
    const flow = imapFlowOn("Destination", 12n, {
      capabilities: new Map([["UIDPLUS", true]]),
      search: async () => [27],
      messageCopy: copy,
      messageFlagsAdd: flags,
      messageDelete: expunge,
    });
    for (let attempt = 0; attempt < 2; attempt++) await drainImap(fx, async () => new ImapFlowMailClient(flow));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(flags).not.toHaveBeenCalled();
    expect(expunge).not.toHaveBeenCalled();
    expect((await pendingMoves(fx.mailboxItemId))[0]).toMatchObject(
      purpose === "archive"
        ? { status: "pending", operation_phase: "uncertain", operation_step: "copy" }
        : { status: "pending", operation_phase: "between_steps", operation_step: "mark_deleted" },
    );
  });

  it("checkpoints IMAP COPY and deletion before UID expunge and persists the new UID", async () => {
    const fx = await imapFixture([
      { path: "INBOX", purpose: "inbox", uidValidity: "42", uidNext: "30" },
      { path: "Archive", purpose: "archive", uidValidity: "43", uidNext: "30" },
    ]);
    const [sourceId, targetId] = fx.folderIds as [string, string];
    const inboxSource = { folderId: sourceId, path: "INBOX", uid: 7, uidValidity: "42" };
    await moveImapLocally(fx, "archive", inboxSource, targetId);

    // A source UID the server no longer reports is left pending without mutation.
    for (const answer of [[], false] as const) {
      const move = vi.fn(async () => false as const);
      const flow = imapFlowOn("INBOX", 42n, {
        capabilities: new Map([["MOVE", true]]),
        search: async () => answer,
        messageMove: move,
      });
      await drainImap(fx, async () => new ImapFlowMailClient(flow));
      expect(move).not.toHaveBeenCalled();
      expect((await pendingMoves(fx.mailboxItemId))[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        operation_token: null,
      });
    }

    // A server without MOVE or UIDPLUS fails the move after its attempt limit without any mutation.
    const unrelatedDeleted = new Set([99]);
    const forbidden = vi.fn(async () => {
      unrelatedDeleted.clear();
      return { kind: "acknowledged" as const };
    });
    const unsupported = fakeImapClient({ uidValidity: "42", capabilities: [] }, forbidden);
    for (let attempt = 0; attempt < 5; attempt++) await drainImap(fx, async () => unsupported);
    expect(forbidden).not.toHaveBeenCalled();
    expect([...unrelatedDeleted]).toEqual([99]);
    expect(await moveState(fx.messageItemId)).toEqual({
      status: "failed",
      failure_reason: "unsupportedCapability",
      attempts: 5,
    });

    // UIDPLUS copy, delete and expunge run step by step outside any transaction.
    await inTenant(async (client) => {
      await linkFolder(client, fx, sourceId, 7);
      await recordDesiredMailMessageMove(client, {
        messageItemId: fx.messageItemId,
        mailboxItemId: fx.mailboxItemId,
        desiredPurpose: "archive",
        source: { provider: "imap", folderItemId: sourceId, path: "INBOX", uid: 7, uidValidity: "42" },
      });
      await unlinkFolder(client, fx, sourceId);
    });
    const steps: string[] = [];
    const close = vi.fn(assertNoMoveTransaction);
    const fake = {
      prepareMove: async () => {
        await assertNoMoveTransaction();
        return { uidValidity: "42", capabilities: new Set(["UIDPLUS"]), found: true };
      },
      executeMoveStep: async (step: string) => {
        await assertNoMoveTransaction();
        const state = (await withTransaction(pool, (client) => listPendingMoves(client, fx.mailboxItemId)))[0];
        expect(state).toMatchObject({ operation_phase: "in_flight", operation_step: step });
        steps.push(step);
        return step === "copy"
          ? { kind: "acknowledged", targetUid: 23, targetUidValidity: "43" }
          : { kind: "acknowledged" };
      },
      close,
    } as unknown as ImapMailClient;
    await drainImap(fx, async () => {
      await assertNoMoveTransaction();
      return fake;
    });
    expect(steps).toEqual(["copy", "mark_deleted", "expunge"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);
    const edge = await inTenant((client) =>
      client.query<{ uid: string }>(
        `SELECT metadata ->> 'uid' AS uid FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = $2 OR item_b = $2)`,
        [fx.messageItemId, targetId],
      ),
    );
    expect(edge.rows[0]?.uid).toBe("23");

    // A desire that matches the new location is confirmed without a provider step.
    const archiveSource = { folderId: targetId, path: "Archive", uid: 23, uidValidity: "43" };
    await record({
      messageItemId: fx.messageItemId,
      mailboxItemId: fx.mailboxItemId,
      desiredPurpose: "archive",
      source: { provider: "imap", folderItemId: targetId, path: "Archive", uid: 23, uidValidity: "43" },
    });
    const noMutation = vi.fn(async () => ({ kind: "uncertain" as const }));
    await drainImap(fx, async () => fakeImapClient({ uidValidity: "43", capabilities: ["MOVE"] }, noMutation));
    expect(noMutation).not.toHaveBeenCalled();
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);

    // Flag writeback and reconcile address the message by its new UID.
    const flagWrites = await inTenant(async (client) => {
      await updateItemWithClient(client, {
        databaseId: fx.emailsDatabaseId,
        itemId: fx.messageItemId,
        propertiesPatch: { read: true },
      });
      const folderRelation = await getRelationDefinitionByPropertyId(client, fx.folderPropertyId);
      const mailboxRelation = await getRelationDefinitionByPropertyId(client, fx.mailboxPropertyId);
      if (!folderRelation || !mailboxRelation) throw new Error("missing relation definition");
      return listPendingImapFlagWrites(client, {
        folderRelationDefinitionId: folderRelation.id,
        mailboxFolderRelationDefinitionId: mailboxRelation.id,
        mailboxItemId: fx.mailboxItemId,
      });
    });
    const setFlag = vi.fn(async () => {});
    await createImapMailFlagWritebackAdapter({ setMessageFlag: setFlag } as unknown as ImapMailClient).write(
      flagWrites[0]!,
    );
    expect(setFlag).toHaveBeenCalledWith("Archive", 23, "\\Seen", true);
    const reconciledFlag = vi.fn(async () => {});
    const reconcileClient = {
      getCapabilities: async () => new Set<string>(),
      listFolders: async () => [{ path: "Archive", specialUse: "\\Archive" }],
      selectFolder: async () => ({ uidvalidity: 43, uidnext: 30, highestModSeq: null }),
      fetchMessagesSince: async () => [],
      fetchVanishedSince: async () => null,
      fetchAllUids: async () => [23],
      fetchFlagsChangedSince: async () => [],
      setMessageFlag: reconciledFlag,
      appendMessage: async () => {},
      close: async () => {},
    } satisfies ImapMailClient;
    const { files, attachments } = await inTenant(async (client) => {
      const files = await getDatabaseByModuleId(client, "files");
      const attachments = await getPropertyByKey(client, fx.emailsDatabaseId, "attachments");
      if (!files || !attachments) throw new Error("missing attachment schema");
      return { files, attachments };
    });
    await runInTenant(a, () =>
      reconcileImapAccount(pool, reconcileClient, {
        mailboxItemId: fx.mailboxItemId,
        emailsDatabaseId: fx.emailsDatabaseId,
        filesDatabaseId: files.id,
        foldersDatabaseId: fx.foldersDatabaseId,
        folderRelationPropertyId: fx.folderPropertyId,
        mailboxFolderRelationPropertyId: fx.mailboxPropertyId,
        attachmentsRelationPropertyId: attachments.id,
        storage: new LocalFsBlobStorageWriter("/private/tmp/unused-move-test"),
        storageKeyPrefix: fx.mailboxItemId,
        pass: UNGUARDED_IMAP_PASS,
      }),
    );
    expect(reconciledFlag).toHaveBeenCalledWith("Archive", 23, "\\Seen", true);

    // A native MOVE that answers false stays uncertain and is not replayed.
    await moveImapLocally(fx, "inbox", archiveSource, sourceId);
    const nativeMove = vi.fn(async () => false as const);
    const native = imapFlowOn("Archive", 43n, {
      capabilities: new Map([["MOVE", true]]),
      search: async () => [23],
      messageMove: nativeMove,
    });
    const create = vi.fn(async () => new ImapFlowMailClient(native));
    await drainImap(fx, create);
    await drainImap(fx, create);
    expect(nativeMove).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await pendingMoves(fx.mailboxItemId))[0]).toMatchObject({
      operation_phase: "uncertain",
      status: "pending",
    });
  });

  it("requires a verified IMAP source before the local edge changes and preserves it on later desires", async () => {
    const fx = await imapFixture([{ path: "INBOX", purpose: "inbox", uidValidity: "42", uidNext: "8" }]);
    const folderId = fx.folderIds[0]!;
    const ids = { messageItemId: fx.messageItemId, mailboxItemId: fx.mailboxItemId };
    const source = { provider: "imap" as const, folderItemId: folderId, path: "INBOX", uid: 7, uidValidity: "42" };
    await expect(record({ ...ids, desiredPurpose: "archive" })).rejects.toThrow();
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);
    await expect(record({ ...ids, desiredPurpose: "archive", source: { ...source, uid: 8 } })).rejects.toThrow(
      "Mail move source is not verified",
    );
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);
    await expect(
      inTenant(async (client) => {
        await recordDesiredMailMessageMove(client, { ...ids, desiredPurpose: "archive", source });
        throw new Error("abort source capture");
      }),
    ).rejects.toThrow("abort source capture");
    expect(await pendingMoves(fx.mailboxItemId)).toEqual([]);
    const first = await inTenant(async (client) => {
      const result = await recordDesiredMailMessageMove(client, { ...ids, desiredPurpose: "archive", source });
      await unlinkFolder(client, fx, folderId);
      return result;
    });
    const closeMissingAdapter = vi.fn(async () => {});
    await expect(
      drainImap(fx, async () => ({ close: closeMissingAdapter }) as unknown as ImapMailClient),
    ).rejects.toThrow("IMAP move adapter is unavailable");
    expect(closeMissingAdapter).toHaveBeenCalledTimes(1);
    const next = await record({ ...ids, desiredPurpose: "inbox", source: { ...source, uid: 999 } });
    const observe = () =>
      inTenant((client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: fx.emailsDatabaseId,
          filesDatabaseId: randomUUID(),
          folderRelationPropertyId: fx.folderPropertyId,
          attachmentsRelationPropertyId: randomUUID(),
          folderItemId: folderId,
          mailboxItemId: fx.mailboxItemId,
          folderUid: 7,
          messageId: fx.messageId,
          envelope: {},
          attachments: [],
          storage: new LocalFsBlobStorageWriter("/private/tmp/unused-move-test"),
          storageKeyPrefix: fx.mailboxItemId,
        }),
      );
    const countEdges = async () =>
      (
        await inTenant((client) =>
          client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = $2 OR item_b = $2)",
            [fx.messageItemId, folderId],
          ),
        )
      ).rows[0]?.count;
    await observe();
    expect(await countEdges()).toBe("0");
    expect(await confirm(fx.messageItemId, next.desired_revision)).toBe(true);
    await observe();
    expect(await countEdges()).toBe("1");
    expect(first.source_evidence).toEqual(source);
    expect(next.source_evidence).toEqual(source);
    expect(next.desired_revision).toBe("2");
  });
});
