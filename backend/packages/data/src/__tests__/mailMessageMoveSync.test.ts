import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { drainGmailMoves, drainGraphMoves, drainImapMoves } from "../mail/mailMessageMoveSync.js";
import { logger } from "../mail/logger.js";
import { reconcileImapAccount } from "../mail/imapReconcile.js";
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
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { listPendingImapFlagWrites } from "../mail/mailMessageFlagSyncStore.js";
import { createImapMailFlagWritebackAdapter } from "../mail/mailFlagWriteback.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
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

let admin: Pool;
let pool: Pool;
let a: string;
let b: string;

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

describe("mail move intent store", () => {
  it("prepares one-use Gmail and Graph commands without a second token lookup", async () => {
    const tokens = vi.fn(async () => "fake-token");
    const gmailFetch = vi.fn(async () => Response.json({ id: "g", labelIds: ["TRASH"] }));
    const graphFetch = vi.fn(async () => Response.json({ id: "new-graph-id" }));
    const gmail = new GmailRestClient(tokens, gmailFetch);
    const graph = new GraphRestClient(tokens, graphFetch);
    const gmailCommand = await prepareGmailMove(gmail, "g", "trash");
    const graphCommand = await prepareGraphMove(graph, "graph-id", "archive");
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
  it("closes a timed-out IMAP preparation, joins its late result, and never starts SEARCH", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: { uidValidity: bigint }) => void;
      const open = vi.fn(
        () =>
          new Promise<{ uidValidity: bigint }>((resolve) => {
            release = resolve;
          }),
      );
      const search = vi.fn();
      const close = vi.fn();
      const raw = { mailboxOpen: open, search, close, capabilities: new Map() };
      const client = new ImapFlowMailClient(raw as unknown as import("imapflow").ImapFlow);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a late IMAP MOVE acknowledgement uncertain and forbids a second step", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const move = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      );
      const close = vi.fn();
      const raw = {
        mailbox: { path: "INBOX", uidValidity: 2n },
        capabilities: new Map([["MOVE", true]]),
        messageMove: move,
        close,
      };
      const client = new ImapFlowMailClient(raw as unknown as import("imapflow").ImapFlow);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out IMAP operation and close failure private through actual settlement", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let rejectOperation!: (error: unknown) => void;
      const raw = {
        mailboxOpen: () =>
          new Promise((_resolve, reject) => {
            rejectOperation = reject;
          }),
        close: () => {
          throw new Error("private close failure");
        },
        capabilities: new Map(),
      };
      const client = new ImapFlowMailClient(raw as unknown as import("imapflow").ImapFlow);
      const pending = client.prepareMove("private-folder", 10);
      await vi.advanceTimersByTimeAsync(30_000);
      rejectOperation(undefined);
      await expect(pending).resolves.toBeNull();
      await expect(client.close()).rejects.toThrow("IMAP move provider cleanup failed unexpectedly");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
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
    const copy = vi.fn(async () => {
      unrelatedDeleted.clear();
      return false as const;
    });
    const flag = vi.fn(async () => {
      unrelatedDeleted.clear();
      return true;
    });
    const expunge = vi.fn(async () => {
      unrelatedDeleted.clear();
      return true;
    });
    const move = vi.fn(async () => {
      unrelatedDeleted.clear();
      return false as const;
    });
    const client = {
      capabilities: new Map<string, boolean>(),
      mailbox: { path: "INBOX", uidValidity: 42n },
      messageCopy: copy,
      messageFlagsAdd: flag,
      messageDelete: expunge,
      messageMove: move,
    } as unknown as import("imapflow").ImapFlow;
    for (const step of ["move", "copy", "mark_deleted", "expunge"] as const) {
      expect(await executeImapMoveStep(client, step, "INBOX", 7, "42", "Archive")).toEqual({
        kind: "unsupportedCapability",
      });
    }
    expect(copy).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
    expect(expunge).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect([...unrelatedDeleted]).toEqual([99]);
  });

  it("treats a false native MOVE response as uncertain and validates returned UID evidence", async () => {
    const move = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({
        path: "INBOX",
        destination: "Archive",
        uidValidity: 43n,
        uidMap: new Map([[7, 23]]),
      });
    const client = {
      capabilities: new Map([["MOVE", true]]),
      mailbox: { path: "INBOX", uidValidity: 42n },
      messageMove: move,
    } as unknown as import("imapflow").ImapFlow;
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "old-id", parentFolderId: "folder-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-id" }), { status: 201 }))
      .mockResolvedValueOnce(new Response("secret body", { status: 404 }))
      .mockRejectedValueOnce(new Error("secret token and address"));
    const client = new GraphRestClient(async () => "fake-token", fetchProvider);
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
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "mail-id", labelIds: ["TRASH", "SENT"] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mail-id", labelIds: ["SENT"] }), { status: 200 }))
      .mockRejectedValueOnce(new Error("private provider failure"));
    const gmail = new GmailRestClient(async () => "fake-token", fetchProvider);
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
    const original = new Error("provider-secret-in-read");
    const read = vi.fn(async () => {
      throw original;
    });
    const cancel = vi.fn(async () => {
      // Provider cleanup may reject without a value; the owner must retain its presence.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    });
    const releaseLock = vi.fn();
    const bodyCancel = vi.fn(async () => {});
    const response = {
      ok: true,
      status: 200,
      body: { locked: false, getReader: () => ({ read, cancel, releaseLock }), cancel: bodyCancel },
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
    const first = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    const second = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    expect(first.desired_revision).toBe("1");
    expect(second.desired_revision).toBe("2");
    await expect(
      runInTenant(b, () =>
        withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
      ),
    ).rejects.toThrow("Mail message is not available in this mailbox");
    expect(
      await runInTenant(b, () => withTransaction(pool, (client) => listPendingMoves(client, other.mailboxItemId))),
    ).toEqual([]);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, first.desired_revision)),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, second.desired_revision)),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
  });

  it.each(["none", "pending", "operation outstanding", "done", "failed"] as const)(
    "decides in one place whether a new desire keeps the earlier source: %s",
    async (state) => {
      const own = await fixture(a);
      const inTenant = <T>(fn: (client: PoolClient) => Promise<T>) => runInTenant(a, () => withTransaction(pool, fn));
      if (state !== "none") {
        const first = await inTenant((client) =>
          recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" }),
        );
        if (state === "operation outstanding")
          expect(
            await inTenant((client) =>
              claimMailMoveStep(client, {
                messageItemId: own.messageItemId,
                revision: first.desired_revision,
                token: randomUUID(),
                step: "modify_labels",
                evidence: {
                  provider: "gmail",
                  messageId: own.source.providerMessageId,
                  inTrash: false,
                  inInbox: true,
                  inSent: false,
                },
              }),
            ),
          ).toBe(true);
        if (state === "done")
          expect(await inTenant((client) => markMoveConfirmed(client, own.messageItemId, first.desired_revision))).toBe(
            true,
          );
        if (state === "failed")
          expect(
            await inTenant((client) =>
              markMoveAttemptFailed(client, own.messageItemId, first.desired_revision, "providerRejected", 1),
            ),
          ).toBe(true);
      }
      const keeps = state === "pending" || state === "operation outstanding";

      expect(await inTenant((client) => hasPreservedMailMoveSource(client, own.messageItemId))).toBe(keeps);
      // The store keeps the earlier source exactly when the helper says so: a desire without a source of its own is
      // recorded then and refused otherwise.
      const record = inTenant((client) =>
        recordDesiredMailMessageMove(client, {
          messageItemId: own.messageItemId,
          mailboxItemId: own.mailboxItemId,
          desiredPurpose: "trash",
        }),
      );
      if (keeps) expect(await record).toMatchObject({ desired_purpose: "trash", source_evidence: own.source });
      else await expect(record).rejects.toThrow();
    },
  );
  it.each([
    ["acknowledged outcome", false, 0],
    ["uncertain evidence", true, null],
  ] as const)("rolls back %s when its state write reports no row", async (_name, conflict, reportedCount) => {
    const original = await fixture(a);
    const source = { provider: "graph" as const, providerMessageId: original.source.providerMessageId };
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, { ...original, source, desiredPurpose: "archive" }),
      ),
    );
    const token = randomUUID();
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        claimMailMoveStep(client, {
          messageItemId: original.messageItemId,
          revision: move.desired_revision,
          token,
          step: "move",
          evidence: { provider: "graph", sourceId: source.providerMessageId, targetFolderId: "archive" },
        }),
      ),
    );
    if (conflict) {
      await runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          const existing = await getMailMessageMetaByItemId(client, original.messageItemId);
          if (!existing) throw new Error("missing fixture metadata");
          await upsertMailMessageMeta(client, {
            itemId: existing.itemId,
            mailboxItemId: original.mailboxItemId,
            messageId: existing.messageId,
            providerMessageId: "newer-local-id",
            envelope: {},
          });
        }),
      );
    }
    let intercepted = false;
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, async (client) => {
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
              messageItemId: original.messageItemId,
              token,
              resultId: "remote-result",
            });
          } finally {
            spy.mockRestore();
          }
        }),
      ),
    ).rejects.toThrow(`Expected mail move outcome to affect at least one row, got ${reportedCount}`);
    expect(intercepted).toBe(true);
    const row = (
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, original.mailboxItemId)))
    )[0];
    expect(row).toMatchObject({
      operation_token: token,
      operation_phase: "in_flight",
      operation_evidence: { provider: "graph", sourceId: source.providerMessageId },
      status: "pending",
    });
    const metadata = await runInTenant(a, () =>
      withTransaction(pool, (client) => getMailMessageMetaByItemId(client, original.messageItemId)),
    );
    expect(metadata?.providerMessageId).toBe(conflict ? "newer-local-id" : source.providerMessageId);
  });

  it("keeps an acknowledged Graph identity without confirming an A-B-A desire", async () => {
    const original = await fixture(a);
    const input = {
      ...original,
      source: { provider: "graph" as const, providerMessageId: original.source.providerMessageId },
    };
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...input, desiredPurpose: "archive" })),
    );
    const token = randomUUID();
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        claimMailMoveStep(client, {
          messageItemId: input.messageItemId,
          revision: move.desired_revision,
          token,
          step: "move",
          evidence: { provider: "graph", sourceId: original.source.providerMessageId, targetFolderId: "archive" },
        }),
      ),
    );
    for (const desiredPurpose of ["inbox", "archive"] as const) {
      await runInTenant(a, () =>
        withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...input, desiredPurpose })),
      );
    }
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          completeGraphMove(client, {
            messageItemId: input.messageItemId,
            token,
            resultId: "new-graph-id",
          }),
        ),
      ),
    ).toBe("pending");
    const rows = await runInTenant(a, () =>
      withTransaction(pool, (client) => listPendingMoves(client, input.mailboxItemId)),
    );
    expect(rows[0]).toMatchObject({
      desired_revision: "3",
      current_purpose: "archive",
      status: "pending",
      source_evidence: { provider: "graph", providerMessageId: "new-graph-id" },
      operation_token: null,
    });
    const meta = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        client.query<{ provider_message_id: string }>(
          "SELECT provider_message_id FROM mail_message_meta WHERE item_id = $1",
          [input.messageItemId],
        ),
      ),
    );
    expect(meta.rows[0]?.provider_message_id).toBe("new-graph-id");
  });

  it("retains Graph result evidence instead of overwriting a newer stored identity", async () => {
    const original = await fixture(a);
    const source = { provider: "graph" as const, providerMessageId: original.source.providerMessageId };
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, { ...original, source, desiredPurpose: "archive" }),
      ),
    );
    const token = randomUUID();
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        claimMailMoveStep(client, {
          messageItemId: original.messageItemId,
          revision: move.desired_revision,
          token,
          step: "move",
          evidence: { provider: "graph", sourceId: source.providerMessageId, targetFolderId: "archive" },
        }),
      ),
    );
    await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const existing = await getMailMessageMetaByItemId(client, original.messageItemId);
        if (!existing) throw new Error("missing fixture metadata");
        await upsertMailMessageMeta(client, {
          itemId: existing.itemId,
          mailboxItemId: original.mailboxItemId,
          messageId: existing.messageId,
          providerMessageId: "newer-local-id",
          envelope: {},
        });
      }),
    );
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          completeGraphMove(client, {
            messageItemId: original.messageItemId,
            token,
            resultId: "old-operation-result",
          }),
        ),
      ),
    ).toBe("conflict");
    const row = (
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, original.mailboxItemId)))
    )[0];
    expect(row).toMatchObject({
      operation_phase: "uncertain",
      operation_evidence: { resultId: "old-operation-result" },
    });
    const metadata = await runInTenant(a, () =>
      withTransaction(pool, (client) => getMailMessageMetaByItemId(client, original.messageItemId)),
    );
    expect(metadata?.providerMessageId).toBe("newer-local-id");
  });

  it.each([
    ["archive", ["INBOX"], [], "modify"],
    ["trash", ["INBOX"], ["TRASH"], "trash"],
    ["sent", ["TRASH", "SENT"], ["SENT"], "untrash"],
  ] as const)("moves Gmail to %s and confirms the returned labels", async (purpose, before, after, command) => {
    const own = await fixture(a);
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: purpose })),
    );
    const id = own.source.providerMessageId;
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, labelIds: before }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, labelIds: after }), { status: 200 }));
    await runInTenant(a, () =>
      drainGmailMoves(pool, own.mailboxItemId, new GmailRestClient(async () => "fake-token", request)),
    );
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
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
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: purpose })),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: own.source.providerMessageId, labelIds: labels }), { status: 200 }),
      );
    await runInTenant(a, () =>
      drainGmailMoves(pool, own.mailboxItemId, new GmailRestClient(async () => "fake-token", request)),
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
  });

  it("stops Gmail retries after five verified 404 observations", async () => {
    const own = await fixture(a);
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
    );
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    const gmail = new GmailRestClient(async () => "fake-token", request);
    for (let count = 0; count < 6; count++) await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    const result = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        client.query<{ status: string; attempts: number; failure_reason: string }>(
          "SELECT status, attempts, failure_reason FROM mail_message_move_sync_state WHERE message_item_id = $1",
          [own.messageItemId],
        ),
      ),
    );
    expect(result.rows[0]).toEqual({ status: "failed", attempts: 5, failure_reason: "messageMissing" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("does not replay an unacknowledged Gmail untrash", async () => {
    const own = await fixture(a);
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    const id = own.source.providerMessageId;
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, labelIds: ["TRASH"] }), { status: 200 }))
      .mockRejectedValueOnce(new Error("private provider failure"));
    const gmail = new GmailRestClient(async () => "fake-token", request);
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    const row = (
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)))
    )[0];
    expect(row).toMatchObject({ operation_phase: "uncertain", operation_step: "untrash", status: "pending" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("checkpoints Gmail untrash before a later inbox-label command", async () => {
    const own = await fixture(a);
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    const id = own.source.providerMessageId;
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, labelIds: ["TRASH"] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id, labelIds: [] }), { status: 200 }))
      .mockImplementationOnce(async () => {
        const row = (await withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)))[0];
        expect(row).toMatchObject({
          operation_phase: "in_flight",
          operation_step: "modify_labels",
          operation_evidence: { inTrash: false, inInbox: false },
        });
        return new Response(JSON.stringify({ id, labelIds: ["INBOX"] }), { status: 200 });
      });
    const gmail = new GmailRestClient(async () => "fake-token", fetchProvider);
    await runInTenant(a, () => drainGmailMoves(pool, own.mailboxItemId, gmail));
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
    expect(fetchProvider).toHaveBeenCalledTimes(3);
  });

  it("resumes an acknowledged Gmail checkpoint without repeating untrash", async () => {
    const own = await fixture(a);
    const row = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    const token = randomUUID();
    const evidence = {
      provider: "gmail" as const,
      messageId: own.source.providerMessageId,
      inTrash: true,
      inInbox: false,
      inSent: false,
    };
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        claimMailMoveStep(client, {
          messageItemId: own.messageItemId,
          revision: row.desired_revision,
          token,
          step: "untrash",
          evidence,
        }),
      ),
    );
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        checkpointMailMoveStep(client, {
          messageItemId: own.messageItemId,
          token,
          nextStep: "modify_labels",
          evidence: { ...evidence, inTrash: false },
        }),
      ),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: evidence.messageId, labelIds: ["INBOX"] }), { status: 200 }),
      );
    const tokenFailure = new Error("private token acquisition failure");
    const before = await runInTenant(a, () =>
      withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)),
    );
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
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual(before);
    await runInTenant(a, () =>
      drainGmailMoves(pool, own.mailboxItemId, new GmailRestClient(async () => "fake-token", request)),
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain("/modify");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
  });

  it.each([
    ["archive", "archive"],
    ["trash", "deleteditems"],
    ["inbox", "inbox"],
    ["sent", "sentitems"],
  ] as const)("persists a Graph move to %s after a claimed provider request", async (purpose, destination) => {
    await runInTenant(a, () => seedSystem(pool));
    const own = await fixture(a);
    const target = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
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
      }),
    );
    const source = { provider: "graph" as const, providerMessageId: own.source.providerMessageId };
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, { ...own, source, desiredPurpose: purpose }),
      ),
    );
    if (purpose === "archive") {
      const tokenFailure = new Error("private Graph token failure");
      let tokenCalls = 0;
      const observation = vi.fn(async () =>
        Response.json({ id: source.providerMessageId, parentFolderId: "old-folder-id" }),
      );
      const graph = new GraphRestClient(async () => {
        if (++tokenCalls === 2) throw tokenFailure;
        return "fake-token";
      }, observation);
      const before = await runInTenant(a, () =>
        withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)),
      );
      await expect(
        runInTenant(a, () => drainGraphMoves(pool, own.mailboxItemId, graph, target.databaseId, target.propertyId)),
      ).rejects.toBe(tokenFailure);
      expect(observation).toHaveBeenCalledTimes(1);
      expect(
        await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
      ).toEqual(before);
    }
    const assertNoMoveTransaction = async () => {
      const activity = await admin.query<{ pid: number; xact_start: Date | null }>(
        "SELECT pid, xact_start FROM pg_stat_activity WHERE datname = current_database() AND usename = 'semprec_data'",
      );
      expect(activity.rows.length).toBeGreaterThan(0);
      expect(activity.rows.every((row) => row.xact_start === null)).toBe(true);
    };
    const fetchProvider: typeof fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await assertNoMoveTransaction();
        return new Response(JSON.stringify({ id: source.providerMessageId, parentFolderId: "old-folder-id" }), {
          status: 200,
        });
      })
      .mockImplementationOnce(async () => {
        await assertNoMoveTransaction();
        return new Response(JSON.stringify({ id: "new-id" }), { status: 201 });
      });
    const graph = new GraphRestClient(async () => "fake-token", fetchProvider);
    await runInTenant(a, () => drainGraphMoves(pool, own.mailboxItemId, graph, target.databaseId, target.propertyId));
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
    const metadata = await runInTenant(a, () =>
      withTransaction(pool, (client) => getMailMessageMetaByItemId(client, own.messageItemId)),
    );
    expect(metadata?.providerMessageId).toBe("new-id");
    expect(fetchProvider).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchProvider).mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ destinationId: destination }));
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, {
          ...own,
          source: { provider: "graph", providerMessageId: "new-id" },
          desiredPurpose: purpose,
        }),
      ),
    );
    const observeOnly = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "new-id", parentFolderId: `${purpose}-id` }), { status: 200 }),
      );
    await runInTenant(a, () =>
      drainGraphMoves(
        pool,
        own.mailboxItemId,
        new GraphRestClient(async () => "fake-token", observeOnly),
        target.databaseId,
        target.propertyId,
      ),
    );
    expect(observeOnly).toHaveBeenCalledTimes(1);
    expect(observeOnly.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
    if (purpose === "archive") {
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, {
            ...own,
            source: { provider: "graph", providerMessageId: "new-id" },
            desiredPurpose: purpose,
          }),
        ),
      );
      const stale = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "new-id", parentFolderId: "external-folder" }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "after-external-move" }), { status: 201 }));
      await runInTenant(a, () =>
        drainGraphMoves(
          pool,
          own.mailboxItemId,
          new GraphRestClient(async () => "fake-token", stale),
          target.databaseId,
          target.propertyId,
        ),
      );
      expect(stale).toHaveBeenCalledTimes(2);
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, {
            ...own,
            source: { provider: "graph", providerMessageId: "after-external-move" },
            desiredPurpose: purpose,
          }),
        ),
      );
      const missing = vi.fn(async () => new Response(null, { status: 404 }));
      const missingGraph = new GraphRestClient(async () => "fake-token", missing);
      for (let count = 0; count < 6; count++)
        await runInTenant(a, () =>
          drainGraphMoves(pool, own.mailboxItemId, missingGraph, target.databaseId, target.propertyId),
        );
      const failed = await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          client.query<{ status: string; attempts: number; failure_reason: string }>(
            "SELECT status, attempts, failure_reason FROM mail_message_move_sync_state WHERE message_item_id = $1",
            [own.messageItemId],
          ),
        ),
      );
      expect(failed.rows[0]).toEqual({ status: "failed", attempts: 5, failure_reason: "messageMissing" });
      expect(missing).toHaveBeenCalledTimes(5);
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, {
            ...own,
            source: { provider: "graph", providerMessageId: "after-external-move" },
            desiredPurpose: purpose,
          }),
        ),
      );
      const afterRemote = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "after-external-move", parentFolderId: "other-folder" }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "rejected-local-result" }), { status: 201 }));
      const rollbackGraph = new GraphRestClient(async () => "fake-token", afterRemote);
      let created = false;
      let primary: { value: unknown } | undefined;
      try {
        await admin.query(`CREATE FUNCTION batch18_reject_graph_result() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.provider_message_id = 'rejected-local-result' THEN RAISE EXCEPTION 'synthetic result rollback'; END IF; RETURN NEW; END $$`);
        await admin.query(`CREATE TRIGGER batch18_reject_graph_result BEFORE UPDATE ON mail_message_meta
          FOR EACH ROW EXECUTE FUNCTION batch18_reject_graph_result()`);
        created = true;
        await expect(
          runInTenant(a, () =>
            drainGraphMoves(pool, own.mailboxItemId, rollbackGraph, target.databaseId, target.propertyId),
          ),
        ).rejects.toThrow("synthetic result rollback");
        const blocked = (
          await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)))
        )[0];
        expect(blocked).toMatchObject({ operation_phase: "in_flight", status: "pending" });
        await runInTenant(a, () =>
          drainGraphMoves(pool, own.mailboxItemId, rollbackGraph, target.databaseId, target.propertyId),
        );
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
    }
  });

  it("stops retrying a definite missing message at its attempt limit", async () => {
    const own = await fixture(a);
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await runInTenant(a, () =>
          withTransaction(pool, (client) =>
            markMoveAttemptFailed(client, own.messageItemId, move.desired_revision, "messageMissing"),
          ),
        ),
      ).toBe(true);
    }
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          markMoveAttemptFailed(client, own.messageItemId, move.desired_revision, "messageMissing"),
        ),
      ),
    ).toBe(false);
  });

  it("does not dispatch a second Gmail job while the first owns its step", async () => {
    const own = await fixture(a);
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET")
        return new Response(JSON.stringify({ id: own.source.providerMessageId, labelIds: ["INBOX"] }), { status: 200 });
      entered();
      await gate;
      return new Response(JSON.stringify({ id: own.source.providerMessageId, labelIds: [] }), { status: 200 });
    });
    const gmail = new GmailRestClient(async () => "fake-token", request);
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
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId))),
    ).toEqual([]);
  });

  it("serializes competing move claims under the actual tenant guard", async () => {
    const own = await fixture(a);
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    const evidence = {
      provider: "gmail" as const,
      messageId: own.source.providerMessageId,
      inTrash: false,
      inInbox: true,
      inSent: false,
    };
    let release!: () => void;
    let firstReady!: (pid: number) => void;
    let secondReady!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstPidPromise = new Promise<number>((resolve) => {
      firstReady = resolve;
    });
    const secondPidPromise = new Promise<number>((resolve) => {
      secondReady = resolve;
    });
    const settled = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const first = settled(
      runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("missing first claim PID");
          const claimed = await claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token: randomUUID(),
            step: "modify_labels",
            evidence,
          });
          firstReady(pid);
          await gate;
          return claimed;
        }),
      ),
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
        runInTenant(a, () =>
          withTransaction(pool, async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (pid === undefined) throw new Error("missing second claim PID");
            secondReady(pid);
            return claimMailMoveStep(client, {
              messageItemId: own.messageItemId,
              revision: move.desired_revision,
              token: randomUUID(),
              step: "modify_labels",
              evidence,
            });
          }),
        ),
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
      process.stdout.write(`batch18 move claim blocker=${firstPid} blocked=${secondPid}\n`);
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
    const first = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    const tokens = [randomUUID(), randomUUID()];
    const evidence = {
      provider: "gmail" as const,
      messageId: "fake-provider-id",
      inTrash: false,
      inInbox: true,
      inSent: false,
    };
    const claims = await Promise.all(
      tokens.map((token) =>
        runInTenant(a, () =>
          withTransaction(pool, (client) =>
            claimMailMoveStep(client, {
              messageItemId: own.messageItemId,
              revision: first.desired_revision,
              token,
              step: "modify_labels",
              evidence,
            }),
          ),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = tokens[claims.findIndex(Boolean)]!;
    await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "trash" })),
    );
    const latest = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "archive" })),
    );
    expect(latest.desired_revision).toBe("3");
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMailMoveUncertain(client, own.messageItemId, winner)),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, own.messageItemId, latest.desired_revision)),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: latest.desired_revision,
            token: randomUUID(),
            step: "modify_labels",
            evidence,
          }),
        ),
      ),
    ).toBe(false);
    const [pending] = await runInTenant(a, () =>
      withTransaction(pool, (client) => listPendingMoves(client, own.mailboxItemId)),
    );
    expect(pending).toMatchObject({
      desired_revision: "3",
      captured_revision: "1",
      operation_token: winner,
      operation_phase: "uncertain",
    });
  });

  it("resumes only the acknowledged checkpoint with its captured evidence", async () => {
    const own = await fixture(a);
    const move = await runInTenant(a, () =>
      withTransaction(pool, (client) => recordDesiredMailMessageMove(client, { ...own, desiredPurpose: "inbox" })),
    );
    const token = randomUUID();
    const before = {
      provider: "gmail" as const,
      messageId: "fake-provider-id",
      inTrash: true,
      inInbox: false,
      inSent: false,
    };
    const after = { ...before, inTrash: false };
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "untrash",
            evidence: before,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          checkpointMailMoveStep(client, {
            messageItemId: own.messageItemId,
            token,
            nextStep: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: before,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) =>
          claimMailMoveStep(client, {
            messageItemId: own.messageItemId,
            revision: move.desired_revision,
            token,
            step: "modify_labels",
            evidence: after,
          }),
        ),
      ),
    ).toBe(false);
  });

  it.each(["archive", "trash", "inbox", "sent"] as const)("moves IMAP to the mailbox's %s folder", async (purpose) => {
    await runInTenant(a, () => seedSystem(pool));
    const fixture = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const mailboxDb = await getDatabaseByModuleId(client, "mailboxes");
        const emailDb = await getDatabaseByModuleId(client, "emails");
        const folderDb = await getDatabaseByModuleId(client, "folders");
        if (!mailboxDb || !emailDb || !folderDb) throw new Error("Missing mail databases");
        const emailFolder = await getPropertyByKey(client, emailDb.id, "folder");
        const folderMailbox = await getPropertyByKey(client, folderDb.id, "mailbox");
        if (!emailFolder || !folderMailbox) throw new Error("Missing relations");
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxDb.id,
          properties: { name: "Mailbox" },
        });
        const message = await createItemWithClient(
          client,
          { databaseId: emailDb.id, properties: { name: "Message" } },
          { allowedSystemKeys: ["name"] },
        );
        await upsertMailMessageMeta(client, {
          itemId: message.id,
          mailboxItemId: mailbox.id,
          messageId: `<${randomUUID()}@example.test>`,
          envelope: {},
        });
        const folder = async (path: string, specialPurpose: string, validity: string) => {
          const id = await ensureFolderItem(client, {
            foldersDatabaseId: folderDb.id,
            mailboxItemId: mailbox.id,
            mailboxRelationPropertyId: folderMailbox.id,
            providerId: path,
            name: path,
            behavior: "folder",
            specialPurpose,
          });
          await ensureMailFolderSyncState(client, id);
          await recordReconcile(client, { itemId: id, uidvalidity: validity, uidnext: "50", highestmodseq: null });
          return id;
        };
        const source = await folder("Source", purpose === "inbox" ? "junk" : "inbox", "11");
        const target = await folder("Destination", purpose, "12");
        await createRelationWithClient(
          client,
          { relationPropertyId: emailFolder.id, callerItemId: message.id, targetItemId: source, metadata: { uid: 7 } },
          EMAILS_RELATION_CONTEXT,
        );
        await recordDesiredMailMessageMove(client, {
          messageItemId: message.id,
          mailboxItemId: mailbox.id,
          desiredPurpose: purpose,
          source: { provider: "imap", folderItemId: source, path: "Source", uid: 7, uidValidity: "11" },
        });
        await deleteRelationWithClient(
          client,
          { relationPropertyId: emailFolder.id, callerItemId: message.id, targetItemId: source },
          EMAILS_RELATION_CONTEXT,
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: emailFolder.id, callerItemId: message.id, targetItemId: target },
          EMAILS_RELATION_CONTEXT,
        );
        return {
          mailbox: mailbox.id,
          message: message.id,
          source,
          target,
          folderDb: folderDb.id,
          folderProperty: emailFolder.id,
          mailboxProperty: folderMailbox.id,
        };
      }),
    );
    const move = vi.fn(async () => ({ kind: "acknowledged" as const, targetUid: 27, targetUidValidity: "12" }));
    const fake = {
      prepareMove: async () => ({ uidValidity: "11", capabilities: new Set(["MOVE"]), found: true }),
      executeMoveStep: move,
      close: async () => {},
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient;
    await runInTenant(a, () =>
      drainImapMoves(
        pool,
        fixture.mailbox,
        async () => fake,
        fixture.folderDb,
        fixture.mailboxProperty,
        fixture.folderProperty,
      ),
    );
    expect(move).toHaveBeenCalledWith("move", "Source", 7, "11", "Destination");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailbox))),
    ).toEqual([]);
    if (purpose === "archive" || purpose === "trash") {
      await runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          await recordDesiredMailMessageMove(client, {
            messageItemId: fixture.message,
            mailboxItemId: fixture.mailbox,
            desiredPurpose: "inbox",
            source: { provider: "imap", folderItemId: fixture.target, path: "Destination", uid: 27, uidValidity: "12" },
          });
          await deleteRelationWithClient(
            client,
            { relationPropertyId: fixture.folderProperty, callerItemId: fixture.message, targetItemId: fixture.target },
            EMAILS_RELATION_CONTEXT,
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: fixture.folderProperty, callerItemId: fixture.message, targetItemId: fixture.source },
            EMAILS_RELATION_CONTEXT,
          );
        }),
      );
      const copy = vi.fn(async () =>
        purpose === "archive"
          ? { path: "Destination", destination: "Source" }
          : { path: "Destination", destination: "Source", uidValidity: 99n, uidMap: new Map([[27, 44]]) },
      );
      const flags = vi.fn(async () => true);
      const expunge = vi.fn(async () => true);
      const flow = {
        capabilities: new Map([["UIDPLUS", true]]),
        mailbox: { path: "Destination", uidValidity: 12n },
        mailboxOpen: async () => ({ path: "Destination", uidValidity: 12n }),
        search: async () => [27],
        messageCopy: copy,
        messageFlagsAdd: flags,
        messageDelete: expunge,
        logout: async () => {},
        close: () => {},
      } as unknown as import("imapflow").ImapFlow;
      const create = vi.fn(async () => new ImapFlowMailClient(flow));
      for (let attempt = 0; attempt < 2; attempt++)
        await runInTenant(a, () =>
          drainImapMoves(
            pool,
            fixture.mailbox,
            create,
            fixture.folderDb,
            fixture.mailboxProperty,
            fixture.folderProperty,
          ),
        );
      expect(copy).toHaveBeenCalledTimes(1);
      expect(flags).not.toHaveBeenCalled();
      expect(expunge).not.toHaveBeenCalled();
      const blocked = (
        await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailbox)))
      )[0];
      expect(blocked).toMatchObject(
        purpose === "archive"
          ? { status: "pending", operation_phase: "uncertain", operation_step: "copy" }
          : { status: "pending", operation_phase: "between_steps", operation_step: "mark_deleted" },
      );
    }
  });

  it("checkpoints IMAP COPY and deletion before UID expunge and persists the new UID", async () => {
    await runInTenant(a, () => seedSystem(pool));
    const fixture = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const mailboxDb = await getDatabaseByModuleId(client, "mailboxes");
        const emailDb = await getDatabaseByModuleId(client, "emails");
        const folderDb = await getDatabaseByModuleId(client, "folders");
        if (!mailboxDb || !emailDb || !folderDb) throw new Error("Missing mail databases");
        const emailFolder = await getPropertyByKey(client, emailDb.id, "folder");
        const folderMailbox = await getPropertyByKey(client, folderDb.id, "mailbox");
        if (!emailFolder || !folderMailbox) throw new Error("Missing relation properties");
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxDb.id,
          properties: { name: "Mailbox" },
        });
        const message = await createItemWithClient(
          client,
          { databaseId: emailDb.id, properties: { name: "Message" } },
          { allowedSystemKeys: ["name"] },
        );
        await upsertMailMessageMeta(client, {
          itemId: message.id,
          mailboxItemId: mailbox.id,
          messageId: `<${randomUUID()}@example.test>`,
          envelope: {},
        });
        const makeFolder = async (path: string, purpose: string) => {
          const id = await ensureFolderItem(client, {
            foldersDatabaseId: folderDb.id,
            mailboxItemId: mailbox.id,
            mailboxRelationPropertyId: folderMailbox.id,
            providerId: path,
            name: path,
            behavior: "folder",
            specialPurpose: purpose,
          });
          await ensureMailFolderSyncState(client, id);
          await recordReconcile(client, {
            itemId: id,
            uidvalidity: path === "INBOX" ? "42" : "43",
            uidnext: "30",
            highestmodseq: null,
          });
          return id;
        };
        const sourceId = await makeFolder("INBOX", "inbox");
        const targetId = await makeFolder("Archive", "archive");
        await createRelationWithClient(
          client,
          {
            relationPropertyId: emailFolder.id,
            callerItemId: message.id,
            targetItemId: sourceId,
            metadata: { uid: 7 },
          },
          EMAILS_RELATION_CONTEXT,
        );
        await recordDesiredMailMessageMove(client, {
          messageItemId: message.id,
          mailboxItemId: mailbox.id,
          desiredPurpose: "archive",
          source: { provider: "imap", folderItemId: sourceId, path: "INBOX", uid: 7, uidValidity: "42" },
        });
        await deleteRelationWithClient(
          client,
          { relationPropertyId: emailFolder.id, callerItemId: message.id, targetItemId: sourceId },
          EMAILS_RELATION_CONTEXT,
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: emailFolder.id, callerItemId: message.id, targetItemId: targetId },
          EMAILS_RELATION_CONTEXT,
        );
        return {
          mailboxId: mailbox.id,
          messageId: message.id,
          sourceId,
          targetId,
          folderDb: folderDb.id,
          emailDb: emailDb.id,
          folderProperty: emailFolder.id,
          mailboxProperty: folderMailbox.id,
        };
      }),
    );
    for (const answer of [[], false] as const) {
      const move = vi.fn(async () => false as const);
      const flow = {
        capabilities: new Map([["MOVE", true]]),
        mailbox: { path: "INBOX", uidValidity: 42n },
        mailboxOpen: async () => ({ path: "INBOX", uidValidity: 42n }),
        search: async () => answer,
        messageMove: move,
        logout: async () => {},
        close: () => {},
      } as unknown as import("imapflow").ImapFlow;
      await runInTenant(a, () =>
        drainImapMoves(
          pool,
          fixture.mailboxId,
          async () => new ImapFlowMailClient(flow),
          fixture.folderDb,
          fixture.mailboxProperty,
          fixture.folderProperty,
        ),
      );
      expect(move).not.toHaveBeenCalled();
      const pending = (
        await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxId)))
      )[0];
      expect(pending).toMatchObject({ status: "pending", attempts: 0, operation_token: null });
    }
    const unrelatedDeleted = new Set([99]);
    const forbidden = vi.fn(async () => {
      unrelatedDeleted.clear();
      return { kind: "acknowledged" as const };
    });
    const unsupported = {
      prepareMove: async () => ({ uidValidity: "42", capabilities: new Set<string>(), found: true }),
      executeMoveStep: forbidden,
      close: async () => {},
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient;
    for (let attempt = 0; attempt < 5; attempt++) {
      await runInTenant(a, () =>
        drainImapMoves(
          pool,
          fixture.mailboxId,
          async () => unsupported,
          fixture.folderDb,
          fixture.mailboxProperty,
          fixture.folderProperty,
        ),
      );
    }
    expect(forbidden).not.toHaveBeenCalled();
    expect([...unrelatedDeleted]).toEqual([99]);
    const refused = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        client.query<{ status: string; failure_reason: string; attempts: number }>(
          "SELECT status, failure_reason, attempts FROM mail_message_move_sync_state WHERE message_item_id = $1",
          [fixture.messageId],
        ),
      ),
    );
    expect(refused.rows[0]).toEqual({ status: "failed", failure_reason: "unsupportedCapability", attempts: 5 });
    await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        await createRelationWithClient(
          client,
          {
            relationPropertyId: fixture.folderProperty,
            callerItemId: fixture.messageId,
            targetItemId: fixture.sourceId,
            metadata: { uid: 7 },
          },
          EMAILS_RELATION_CONTEXT,
        );
        await recordDesiredMailMessageMove(client, {
          messageItemId: fixture.messageId,
          mailboxItemId: fixture.mailboxId,
          desiredPurpose: "archive",
          source: { provider: "imap", folderItemId: fixture.sourceId, path: "INBOX", uid: 7, uidValidity: "42" },
        });
        await deleteRelationWithClient(
          client,
          {
            relationPropertyId: fixture.folderProperty,
            callerItemId: fixture.messageId,
            targetItemId: fixture.sourceId,
          },
          EMAILS_RELATION_CONTEXT,
        );
      }),
    );
    const steps: string[] = [];
    const assertNoMoveTransaction = async () => {
      const activity = await admin.query<{ pid: number; xact_start: Date | null }>(
        "SELECT pid, xact_start FROM pg_stat_activity WHERE datname = current_database() AND usename = 'semprec_data'",
      );
      expect(activity.rows.length).toBeGreaterThan(0);
      expect(activity.rows.every((row) => row.xact_start === null)).toBe(true);
    };
    const close = vi.fn(async () => {
      await assertNoMoveTransaction();
    });
    const fake = {
      prepareMove: async () => {
        await assertNoMoveTransaction();
        return { uidValidity: "42", capabilities: new Set(["UIDPLUS"]), found: true };
      },
      executeMoveStep: async (step: string) => {
        await assertNoMoveTransaction();
        const state = (await withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxId)))[0];
        expect(state).toMatchObject({ operation_phase: "in_flight", operation_step: step });
        steps.push(step);
        return step === "copy"
          ? { kind: "acknowledged", targetUid: 23, targetUidValidity: "43" }
          : { kind: "acknowledged" };
      },
      close,
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient;
    await runInTenant(a, () =>
      drainImapMoves(
        pool,
        fixture.mailboxId,
        async () => {
          await assertNoMoveTransaction();
          return fake;
        },
        fixture.folderDb,
        fixture.mailboxProperty,
        fixture.folderProperty,
      ),
    );
    expect(steps).toEqual(["copy", "mark_deleted", "expunge"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxId))),
    ).toEqual([]);
    const edge = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        client.query<{ uid: string }>(
          `SELECT metadata ->> 'uid' AS uid FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = $2 OR item_b = $2)`,
          [fixture.messageId, fixture.targetId],
        ),
      ),
    );
    expect(edge.rows[0]?.uid).toBe("23");
    await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, {
          messageItemId: fixture.messageId,
          mailboxItemId: fixture.mailboxId,
          desiredPurpose: "archive",
          source: { provider: "imap", folderItemId: fixture.targetId, path: "Archive", uid: 23, uidValidity: "43" },
        }),
      ),
    );
    const noMutation = vi.fn(async () => ({ kind: "uncertain" as const }));
    const matching = {
      prepareMove: async () => ({ uidValidity: "43", capabilities: new Set(["MOVE"]), found: true }),
      executeMoveStep: noMutation,
      close: async () => {},
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient;
    await runInTenant(a, () =>
      drainImapMoves(
        pool,
        fixture.mailboxId,
        async () => matching,
        fixture.folderDb,
        fixture.mailboxProperty,
        fixture.folderProperty,
      ),
    );
    expect(noMutation).not.toHaveBeenCalled();
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxId))),
    ).toEqual([]);
    const flagWrites = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        await updateItemWithClient(client, {
          databaseId: fixture.emailDb,
          itemId: fixture.messageId,
          propertiesPatch: { read: true },
        });
        const folderRelation = await getRelationDefinitionByPropertyId(client, fixture.folderProperty);
        const mailboxRelation = await getRelationDefinitionByPropertyId(client, fixture.mailboxProperty);
        if (!folderRelation || !mailboxRelation) throw new Error("missing relation definition");
        return listPendingImapFlagWrites(client, {
          folderRelationDefinitionId: folderRelation.id,
          mailboxFolderRelationDefinitionId: mailboxRelation.id,
          mailboxItemId: fixture.mailboxId,
        });
      }),
    );
    const setFlag = vi.fn(async () => {});
    await createImapMailFlagWritebackAdapter({
      setMessageFlag: setFlag,
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient).write(flagWrites[0]!);
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
    } satisfies import("../mail/imapReconcile.js").ImapMailClient;
    await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const files = await getDatabaseByModuleId(client, "files");
        const attachments = await getPropertyByKey(client, fixture.emailDb, "attachments");
        if (!files || !attachments) throw new Error("missing attachment schema");
        await reconcileImapAccount(client, reconcileClient, {
          mailboxItemId: fixture.mailboxId,
          emailsDatabaseId: fixture.emailDb,
          filesDatabaseId: files.id,
          foldersDatabaseId: fixture.folderDb,
          folderRelationPropertyId: fixture.folderProperty,
          mailboxFolderRelationPropertyId: fixture.mailboxProperty,
          attachmentsRelationPropertyId: attachments.id,
          storage: new LocalFsBlobStorageWriter("/private/tmp/unused-move-test"),
          storageKeyPrefix: fixture.mailboxId,
        });
      }),
    );
    expect(reconciledFlag).toHaveBeenCalledWith("Archive", 23, "\\Seen", true);

    await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        await recordDesiredMailMessageMove(client, {
          messageItemId: fixture.messageId,
          mailboxItemId: fixture.mailboxId,
          desiredPurpose: "inbox",
          source: { provider: "imap", folderItemId: fixture.targetId, path: "Archive", uid: 23, uidValidity: "43" },
        });
        await deleteRelationWithClient(
          client,
          {
            relationPropertyId: fixture.folderProperty,
            callerItemId: fixture.messageId,
            targetItemId: fixture.targetId,
          },
          EMAILS_RELATION_CONTEXT,
        );
        await createRelationWithClient(
          client,
          {
            relationPropertyId: fixture.folderProperty,
            callerItemId: fixture.messageId,
            targetItemId: fixture.sourceId,
          },
          EMAILS_RELATION_CONTEXT,
        );
      }),
    );
    const nativeMove = vi.fn(async () => false as const);
    const native = {
      capabilities: new Map([["MOVE", true]]),
      mailbox: { path: "Archive", uidValidity: 43n },
      mailboxOpen: async () => ({ path: "Archive", uidValidity: 43n }),
      search: async () => [23],
      messageMove: nativeMove,
      logout: async () => {},
      close: () => {},
    } as unknown as import("imapflow").ImapFlow;
    const create = vi.fn(async () => new ImapFlowMailClient(native));
    await runInTenant(a, () =>
      drainImapMoves(
        pool,
        fixture.mailboxId,
        create,
        fixture.folderDb,
        fixture.mailboxProperty,
        fixture.folderProperty,
      ),
    );
    await runInTenant(a, () =>
      drainImapMoves(
        pool,
        fixture.mailboxId,
        create,
        fixture.folderDb,
        fixture.mailboxProperty,
        fixture.folderProperty,
      ),
    );
    expect(nativeMove).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const uncertain = (
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxId)))
    )[0];
    expect(uncertain).toMatchObject({ operation_phase: "uncertain", status: "pending" });
  });

  it("requires a verified IMAP source before the local edge changes and preserves it on later desires", async () => {
    await runInTenant(a, () => seedSystem(pool));
    const fixture = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const mailboxDb = await getDatabaseByModuleId(client, "mailboxes");
        const emailDb = await getDatabaseByModuleId(client, "emails");
        const folderDb = await getDatabaseByModuleId(client, "folders");
        if (!mailboxDb || !emailDb || !folderDb) throw new Error("Missing mail databases");
        const emailFolder = await getPropertyByKey(client, emailDb.id, "folder");
        const folderMailbox = await getPropertyByKey(client, folderDb.id, "mailbox");
        if (!emailFolder || !folderMailbox) throw new Error("Missing mail relation properties");
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxDb.id,
          properties: { name: "Mailbox" },
        });
        const message = await createItemWithClient(
          client,
          { databaseId: emailDb.id, properties: { name: "Message" } },
          { allowedSystemKeys: ["name"] },
        );
        const messageId = `<${randomUUID()}@example.test>`;
        await upsertMailMessageMeta(client, {
          itemId: message.id,
          mailboxItemId: mailbox.id,
          messageId,
          envelope: {},
        });
        const folderId = await ensureFolderItem(client, {
          foldersDatabaseId: folderDb.id,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: folderMailbox.id,
          providerId: "INBOX",
          name: "Inbox",
          behavior: "folder",
          specialPurpose: "inbox",
        });
        await ensureMailFolderSyncState(client, folderId);
        await recordReconcile(client, { itemId: folderId, uidvalidity: "42", uidnext: "8", highestmodseq: null });
        await createRelationWithClient(
          client,
          {
            relationPropertyId: emailFolder.id,
            callerItemId: message.id,
            targetItemId: folderId,
            metadata: { uid: 7 },
          },
          EMAILS_RELATION_CONTEXT,
        );
        return {
          mailboxItemId: mailbox.id,
          messageItemId: message.id,
          messageId,
          emailsDatabaseId: emailDb.id,
          foldersDatabaseId: folderDb.id,
          mailboxPropertyId: folderMailbox.id,
          folderId,
          propertyId: emailFolder.id,
        };
      }),
    );
    const source = {
      provider: "imap" as const,
      folderItemId: fixture.folderId,
      path: "INBOX",
      uid: 7,
      uidValidity: "42",
    };
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive" }),
        ),
      ),
    ).rejects.toThrow();
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, (client) =>
          recordDesiredMailMessageMove(client, {
            ...fixture,
            desiredPurpose: "archive",
            source: { ...source, uid: 8 },
          }),
        ),
      ),
    ).rejects.toThrow("Mail move source is not verified");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    await expect(
      runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          await recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive", source });
          throw new Error("abort source capture");
        }),
      ),
    ).rejects.toThrow("abort source capture");
    expect(
      await runInTenant(a, () => withTransaction(pool, (client) => listPendingMoves(client, fixture.mailboxItemId))),
    ).toEqual([]);
    const first = await runInTenant(a, () =>
      withTransaction(pool, async (client) => {
        const result = await recordDesiredMailMessageMove(client, { ...fixture, desiredPurpose: "archive", source });
        await deleteRelationWithClient(
          client,
          {
            relationPropertyId: fixture.propertyId,
            callerItemId: fixture.messageItemId,
            targetItemId: fixture.folderId,
          },
          EMAILS_RELATION_CONTEXT,
        );
        return result;
      }),
    );
    const closeMissingAdapter = vi.fn(async () => {});
    const missingAdapter = {
      close: closeMissingAdapter,
    } as unknown as import("../mail/imapReconcile.js").ImapMailClient;
    await expect(
      runInTenant(a, () =>
        drainImapMoves(
          pool,
          fixture.mailboxItemId,
          async () => missingAdapter,
          fixture.foldersDatabaseId,
          fixture.mailboxPropertyId,
          fixture.propertyId,
        ),
      ),
    ).rejects.toThrow("IMAP move adapter is unavailable");
    expect(closeMissingAdapter).toHaveBeenCalledTimes(1);
    const next = await runInTenant(a, () =>
      withTransaction(pool, (client) =>
        recordDesiredMailMessageMove(client, {
          ...fixture,
          desiredPurpose: "inbox",
          source: { ...source, uid: 999 },
        }),
      ),
    );
    const observe = () =>
      runInTenant(a, () =>
        withTransaction(pool, (client) =>
          ingestEmailMessage(client, {
            emailsDatabaseId: fixture.emailsDatabaseId,
            filesDatabaseId: randomUUID(),
            folderRelationPropertyId: fixture.propertyId,
            attachmentsRelationPropertyId: randomUUID(),
            folderItemId: fixture.folderId,
            mailboxItemId: fixture.mailboxItemId,
            folderUid: 7,
            messageId: fixture.messageId,
            envelope: {},
            attachments: [],
            storage: new LocalFsBlobStorageWriter("/private/tmp/unused-move-test"),
            storageKeyPrefix: fixture.mailboxItemId,
          }),
        ),
      );
    const countEdges = () =>
      runInTenant(a, () =>
        withTransaction(pool, async (client) => {
          const result = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND (item_a = $2 OR item_b = $2)",
            [fixture.messageItemId, fixture.folderId],
          );
          return result.rows[0]?.count;
        }),
      );
    await observe();
    expect(await countEdges()).toBe("0");
    expect(
      await runInTenant(a, () =>
        withTransaction(pool, (client) => markMoveConfirmed(client, fixture.messageItemId, next.desired_revision)),
      ),
    ).toBe(true);
    await observe();
    expect(await countEdges()).toBe("1");
    expect(first.source_evidence).toEqual(source);
    expect(next.source_evidence).toEqual(source);
    expect(next.desired_revision).toBe("2");
  });
});
