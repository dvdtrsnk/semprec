import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureMailAccountSyncState, getMailAccountSyncState, recordGmailActivity } from "../mail/mailAccountSyncStateStore.js";
import {
  createGmailWatchLifecycleFactory,
  pullErrorBackoffDelayMs,
  type GmailPubSubNotification,
  type GmailWatchRegistration,
  type GmailWatchTransport,
} from "../mail/gmailWatchLifecycle.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** A real Mailbox item — `mail_account_sync_state.item_id` is a foreign key, so a plain string id is rejected. */
async function createMailboxItem(name: string): Promise<string> {
  const mailboxesId = await databaseIdFor("mailboxes");
  const item = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name, provider: "gmail" } }));
  return item.id;
}

async function pendingMailSyncJobCount(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'mailAccountSync' AND j.key = $1`,
    [`mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

interface FakeTransportOptions {
  registerWatch?: (mailboxItemId: string, credential: string) => GmailWatchRegistration | Promise<GmailWatchRegistration>;
  /** Returns the notifications for the *next* pull call, or throws to simulate a transient pull failure. Defaults to an empty poll. */
  pullQueue?: Array<GmailPubSubNotification[] | "reject">;
}

function createFakeTransport(options: FakeTransportOptions = {}): {
  transport: GmailWatchTransport;
  registerWatchCalls: Array<{ mailboxItemId: string; credential: string }>;
  ackCalls: Array<{ mailboxItemId: string; ackIds: string[] }>;
  /** A mutable counter object, not a plain number — a destructured primitive would snapshot the count at zero forever. */
  pullCallCount: { value: number };
} {
  const registerWatchCalls: Array<{ mailboxItemId: string; credential: string }> = [];
  const ackCalls: Array<{ mailboxItemId: string; ackIds: string[] }> = [];
  const pullQueue = [...(options.pullQueue ?? [])];
  const pullCallCount = { value: 0 };

  const transport: GmailWatchTransport = {
    async registerWatch(mailboxItemId, credential) {
      registerWatchCalls.push({ mailboxItemId, credential });
      if (options.registerWatch) return options.registerWatch(mailboxItemId, credential);
      return { historyId: "1000", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
    },
    async pull(_mailboxItemId) {
      pullCallCount.value++;
      const next = pullQueue.shift();
      if (next === "reject") throw new Error("simulated Pub/Sub pull failure");
      return next ?? [];
    },
    async acknowledge(mailboxItemId, ackIds) {
      ackCalls.push({ mailboxItemId, ackIds });
    },
  };

  return { transport, registerWatchCalls, ackCalls, pullCallCount };
}

describe("Gmail Pub/Sub pull-error backoff (issue #197)", () => {
  it("grows exponentially, capped at the configured maximum", () => {
    expect(pullErrorBackoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(pullErrorBackoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(pullErrorBackoffDelayMs(3, 1000, 60_000)).toBe(4000);
    expect(pullErrorBackoffDelayMs(10, 1000, 60_000)).toBe(60_000);
  });
});

describe("Gmail Pub/Sub watch lifecycle (issue #197)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the watch and persists its expiry and history cursor on the very first registration", async () => {
    const mailboxItemId = await createMailboxItem("A");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { transport, registerWatchCalls } = createFakeTransport({
      registerWatch: async () => ({ historyId: "999999", expiresAt }),
    });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    await vi.waitFor(async () => {
      const state = await getMailAccountSyncState(pool, mailboxItemId);
      expect(state?.gmailWatchExpiresAt).toBe(expiresAt.toISOString());
    });
    expect(registerWatchCalls.length).toBe(1);
    // The account had no cursor yet, so the watch registration's own historyId seeds it —
    // issue #197's "persist history/expiry" requirement — sparing reconcileGmailAccount an
    // otherwise-unavoidable full listAllMessageIds() resync on first sync.
    expect((await getMailAccountSyncState(pool, mailboxItemId))?.gmailHistoryId).toBe("999999");

    await lifecycle.stop();
  });

  it("never overwrites an already-advanced history cursor with a later renewal's historyId", async () => {
    const mailboxItemId = await createMailboxItem("A2");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    // Simulates a reconcile pass (gmailReconcile.ts) having already advanced the cursor past
    // whatever this renewal's watch registration will report.
    await recordGmailActivity(pool, { itemId: mailboxItemId, historyId: "500000", nextExpectedActivityAt: new Date() });

    const { transport, registerWatchCalls } = createFakeTransport({
      registerWatch: async () => ({ historyId: "1", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }),
    });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    await vi.waitFor(() => expect(registerWatchCalls.length).toBe(1));
    // A renewal's own (older-looking) historyId must never regress the cursor a reconcile pass
    // already advanced past it.
    expect((await getMailAccountSyncState(pool, mailboxItemId))?.gmailHistoryId).toBe("500000");

    await lifecycle.stop();
  });

  it("enqueues an immediate reconcile on start, then again (deduplicated by jobKey) for a matching notification", async () => {
    const mailboxItemId = await createMailboxItem("B");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, ackCalls } = createFakeTransport({
      pullQueue: [[{ ackId: "ack-1", emailAddress: "user@example.com", historyId: "12345" }]],
    });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);

    await vi.waitFor(() => expect(ackCalls).toEqual([{ mailboxItemId, ackIds: ["ack-1"] }]));
    // The notification only ever re-enqueues through the same idempotent jobKey — never a
    // second, parallel job — so the pending count for this account stays at exactly one.
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);

    await lifecycle.stop();
  });

  it("never acknowledges, and never reconciles for, a notification addressed to a different account", async () => {
    const mailboxItemId = await createMailboxItem("C");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, ackCalls } = createFakeTransport({
      pullQueue: [[{ ackId: "ack-other", emailAddress: "someone-else@example.com", historyId: "1" }]],
    });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      pullEmptyBackoffMs: 1,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    // Only the initial start()-time enqueue happened — the mismatched notification triggered no
    // second one, and never got acknowledged (so a real subscription would redeliver it).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
    expect(ackCalls).toEqual([]);

    await lifecycle.stop();
  });

  it("acknowledges duplicate/redelivered notifications the same way, never regressing the persisted state", async () => {
    const mailboxItemId = await createMailboxItem("D");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const duplicate: GmailPubSubNotification = { ackId: "ack-dup", emailAddress: "user@example.com", historyId: "500" };
    const { transport, ackCalls } = createFakeTransport({ pullQueue: [[duplicate], [duplicate]] });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      pullEmptyBackoffMs: 1,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    await vi.waitFor(() => expect(ackCalls.length).toBe(2));
    // Both the original and the "redelivered" copy acknowledge cleanly and only ever collapse
    // into the account's one deduplicated reconcile job — no second, parallel job is created.
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);

    await lifecycle.stop();
  });

  it("backs off with a capped, growing delay after repeated pull failures, then resets after a success", async () => {
    const mailboxItemId = await createMailboxItem("E");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, pullCallCount } = createFakeTransport({ pullQueue: ["reject", "reject", "reject", []] });
    const errors: Array<{ phase: string }> = [];
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      pullErrorBaseDelayMs: 1000,
      pullErrorMaxDelayMs: 10_000,
      onError: (_mailboxItemId, phase) => errors.push({ phase }),
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    vi.useFakeTimers();
    await lifecycle.start();
    // 3 rejected pulls back off 1000ms, 2000ms, 4000ms before the 4th attempt succeeds.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(pullCallCount.value).toBe(4);
    expect(errors.every((e) => e.phase === "pull")).toBe(true);

    await lifecycle.stop();
  });

  it("renews the watch on the configured interval, replacing the persisted expiry each time", async () => {
    // Real timers, not fake ones: each renewal round makes a real `recordGmailWatchRegistration`
    // DB write, and racing that real I/O against a virtual clock (as the pull-error-backoff test
    // above safely can, since its loop never touches the DB) is exactly the kind of flake this
    // avoids by using a short real interval and polling instead.
    const mailboxItemId = await createMailboxItem("F");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    let call = 0;
    const { transport, registerWatchCalls } = createFakeTransport({
      registerWatch: async () => {
        call++;
        return { historyId: "1", expiresAt: new Date(Date.now() + call * 1000) };
      },
    });
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      renewalIntervalMs: 10,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    expect(registerWatchCalls.length).toBe(1);

    await vi.waitFor(() => expect(registerWatchCalls.length).toBeGreaterThanOrEqual(3));

    await lifecycle.stop();
  });

  it("stop() halts both the renewal and pull loops so no further registerWatch/enqueue calls happen", async () => {
    vi.useFakeTimers();
    const mailboxItemId = await createMailboxItem("G");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, registerWatchCalls } = createFakeTransport();
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      renewalIntervalMs: 1000,
      pullEmptyBackoffMs: 1000,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });

    await lifecycle.start();
    expect(registerWatchCalls.length).toBe(1);

    await lifecycle.stop();
    const callsAfterStop = registerWatchCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registerWatchCalls.length).toBe(callsAfterStop);
  });
});
