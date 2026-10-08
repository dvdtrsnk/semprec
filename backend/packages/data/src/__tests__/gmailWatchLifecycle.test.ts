import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsSystem } from "@semprec/shared";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { enqueueMailAccountSync } from "../mail/mailSyncJob.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  recordGmailActivity,
} from "../mail/mailAccountSyncStateStore.js";
import {
  createGmailPubSubDispatcher,
  createGmailWatchLifecycleFactory,
  pullErrorBackoffDelayMs,
  type GmailPubSubNotification,
  type GmailWatchRegistration,
  type GmailWatchTransport,
} from "../mail/gmailWatchLifecycle.js";

vi.mock("../mail/mailSyncJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/mailSyncJob.js")>();
  return { ...actual, enqueueMailAccountSync: vi.fn(actual.enqueueMailAccountSync) };
});

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** A real Mailbox item — `mail_account_sync_state.item_id` is a foreign key, so a plain string id is rejected. */
async function createMailboxItem(name: string): Promise<string> {
  const mailboxesId = await databaseIdFor("mailboxes");
  const item = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mailboxesId, properties: { name, provider: "gmail" } }),
  );
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
  registerWatch?: (
    mailboxItemId: string,
    credential: string,
  ) => GmailWatchRegistration | Promise<GmailWatchRegistration>;
  /** Returns the notifications for the *next* pull call, or throws to simulate a transient pull failure. Defaults to an empty poll. */
  pullQueue?: Array<GmailPubSubNotification[] | "reject">;
}

function createFakeTransport(options: FakeTransportOptions = {}): {
  transport: GmailWatchTransport;
  registerWatchCalls: Array<{ mailboxItemId: string; credential: string }>;
  ackCalls: string[][];
  /** A mutable counter object, not a plain number — a destructured primitive would snapshot the count at zero forever. */
  pullCallCount: { value: number };
} {
  const registerWatchCalls: Array<{ mailboxItemId: string; credential: string }> = [];
  const ackCalls: string[][] = [];
  const pullQueue = [...(options.pullQueue ?? [])];
  const pullCallCount = { value: 0 };

  const transport: GmailWatchTransport = {
    async registerWatch(mailboxItemId, credential) {
      registerWatchCalls.push({ mailboxItemId, credential });
      if (options.registerWatch) return options.registerWatch(mailboxItemId, credential);
      return { historyId: "1000", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
    },
    async pull() {
      pullCallCount.value++;
      const next = pullQueue.shift();
      if (next === "reject") throw new Error("simulated Pub/Sub pull failure");
      return next ?? [];
    },
    async acknowledge(ackIds) {
      ackCalls.push(ackIds);
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

  it("persists the normalized watched address, and reports a renewal on a mailbox without a sync-state row", async () => {
    const mailboxItemId = await createMailboxItem("B");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport } = createFakeTransport();
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => " User@Example.com ",
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "gmail_api" });
    await lifecycle.start();
    await vi.waitFor(async () => {
      const { rows } = await pool.query<{ a: string | null }>(
        "SELECT gmail_watch_email_address AS a FROM mail_account_sync_state WHERE item_id = $1",
        [mailboxItemId],
      );
      expect(rows[0]?.a).toBe("user@example.com");
    });
    await lifecycle.stop();

    const orphanId = await createMailboxItem("B-orphan");
    const errors: Array<{ id: string; phase: string }> = [];
    const orphan = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      onError: (id, phase) => errors.push({ id, phase }),
    })({ mailboxItemId: orphanId, syncMode: "gmail_api" });
    await orphan.start();
    await vi.waitFor(() => expect(errors).toEqual([{ id: orphanId, phase: "watch" }]));
    await orphan.stop();
  });

  it("never pulls or acknowledges from the per-mailbox lifecycle", async () => {
    const mailboxItemId = await createMailboxItem("C");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, ackCalls, pullCallCount } = createFakeTransport({
      pullQueue: [[{ ackId: "a", emailAddress: "user@example.com", historyId: "1" }]],
    });
    const lifecycle = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
    })({ mailboxItemId, syncMode: "gmail_api" });
    await lifecycle.start();
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await lifecycle.stop();
    expect(pullCallCount.value).toBe(0);
    expect(ackCalls).toEqual([]);
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

  it("stop() halts the renewal loop so no further registerWatch calls happen", async () => {
    vi.useFakeTimers();
    const mailboxItemId = await createMailboxItem("G");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
    const { transport, registerWatchCalls } = createFakeTransport();
    const factory = createGmailWatchLifecycleFactory(pool, transport, {
      getCredential: async () => "refresh-token",
      getAccountEmailAddress: async () => "user@example.com",
      renewalIntervalMs: 1000,
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

async function watchedMailbox(name: string, address: string): Promise<string> {
  const mailboxItemId = await createMailboxItem(name);
  await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "gmail_api" });
  await pool.query("UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1", [
    mailboxItemId,
    address,
  ]);
  return mailboxItemId;
}

async function jobEnvelopeTenants(mailboxItemId: string): Promise<Array<string | null>> {
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    "SELECT j.payload->>'tenantId' AS tenant_id FROM graphile_worker._private_jobs j WHERE j.key = $1",
    [`mail-account-sync:${mailboxItemId}`],
  );
  return rows.map((row) => row.tenant_id);
}

describe("Gmail Pub/Sub dispatcher (issue #998)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    vi.mocked(enqueueMailAccountSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(enqueueMailAccountSync).mockClear();
  });

  const notification = (ackId: string, emailAddress = "user@example.com"): GmailPubSubNotification => ({
    ackId,
    emailAddress,
    historyId: "1",
  });

  it("enqueues one job per matching mailbox in tenant zero and acknowledges the message once", async () => {
    const first = await watchedMailbox("D1", "user@example.com");
    const second = await watchedMailbox("D2", "user@example.com");
    const other = await watchedMailbox("D3", "other@example.com");
    const { transport, ackCalls } = createFakeTransport({ pullQueue: [[notification("ack-1", " User@Example.com ")]] });
    const dispatcher = createGmailPubSubDispatcher(pool, transport, { pullEmptyBackoffMs: 1 });

    await dispatcher.start();
    await vi.waitFor(() => expect(ackCalls).toEqual([["ack-1"]]));
    await dispatcher.stop();

    expect(await pendingMailSyncJobCount(first)).toBe(1);
    expect(await pendingMailSyncJobCount(second)).toBe(1);
    expect(await pendingMailSyncJobCount(other)).toBe(0);
    const tenantZero = getTenantZeroId();
    expect(await jobEnvelopeTenants(first)).toEqual([tenantZero]);
    expect(await jobEnvelopeTenants(second)).toEqual([tenantZero]);
  });

  it("sends every ack id of one pull in a single acknowledge call", async () => {
    await watchedMailbox("D4", "user@example.com");
    const { transport, ackCalls } = createFakeTransport({
      pullQueue: [[notification("a1"), notification("a2")]],
    });
    const dispatcher = createGmailPubSubDispatcher(pool, transport, { pullEmptyBackoffMs: 1 });
    await dispatcher.start();
    await vi.waitFor(() => expect(ackCalls).toEqual([["a1", "a2"]]));
    await dispatcher.stop();
  });

  it("leaves a message unacknowledged when one target's enqueue rejects, while the other target still runs", async () => {
    const failing = await watchedMailbox("P1", "user@example.com");
    const healthy = await watchedMailbox("P2", "user@example.com");
    const actual = await vi.importActual<typeof import("../mail/mailSyncJob.js")>("../mail/mailSyncJob.js");
    vi.mocked(enqueueMailAccountSync).mockImplementation(async (client, id) => {
      if (id === failing) throw new Error("simulated enqueue failure");
      await actual.enqueueMailAccountSync(client, id);
    });
    const errors: Array<{ target: unknown; phase: string }> = [];
    const { transport, ackCalls, pullCallCount } = createFakeTransport({ pullQueue: [[notification("ack-p")]] });
    const dispatcher = createGmailPubSubDispatcher(pool, transport, {
      pullEmptyBackoffMs: 1,
      onError: (target, phase) => errors.push({ target, phase }),
    });
    await dispatcher.start();
    await vi.waitFor(() => expect(pullCallCount.value).toBeGreaterThan(1));
    await dispatcher.stop();

    expect(await pendingMailSyncJobCount(healthy)).toBe(1);
    expect(await pendingMailSyncJobCount(failing)).toBe(0);
    expect(ackCalls).toEqual([]);
    expect(errors).toEqual([{ target: { tenantId: getTenantZeroId(), mailboxItemId: failing }, phase: "enqueue" }]);
    vi.mocked(enqueueMailAccountSync).mockImplementation(actual.enqueueMailAccountSync);
  });

  it("acknowledges a notification no mailbox watches, creating no job", async () => {
    const mailbox = await watchedMailbox("U1", "user@example.com");
    const { transport, ackCalls } = createFakeTransport({ pullQueue: [[notification("ack-u", "nobody@example.com")]] });
    const dispatcher = createGmailPubSubDispatcher(pool, transport, { pullEmptyBackoffMs: 1 });
    await dispatcher.start();
    await vi.waitFor(() => expect(ackCalls).toEqual([["ack-u"]]));
    await dispatcher.stop();
    expect(await pendingMailSyncJobCount(mailbox)).toBe(0);
  });

  it("reports a failed acknowledge and a failed route without acknowledging", async () => {
    await watchedMailbox("R1", "user@example.com");
    const errors: string[] = [];
    const { transport } = createFakeTransport({ pullQueue: [[notification("ack-r")]] });
    transport.acknowledge = async () => {
      throw new Error("simulated acknowledge failure");
    };
    const dispatcher = createGmailPubSubDispatcher(pool, transport, {
      pullEmptyBackoffMs: 1,
      onError: (target, phase) => {
        expect(target).toBeNull();
        errors.push(phase);
      },
    });
    await dispatcher.start();
    await vi.waitFor(() => expect(errors).toEqual(["acknowledge"]));
    await dispatcher.stop();
  });

  it("backs off with a capped, growing delay after repeated pull failures, then resets after a success", async () => {
    const { transport, pullCallCount } = createFakeTransport({ pullQueue: ["reject", "reject", "reject", []] });
    const errors: string[] = [];
    const dispatcher = createGmailPubSubDispatcher(pool, transport, {
      pullErrorBaseDelayMs: 1000,
      pullErrorMaxDelayMs: 10_000,
      pullEmptyBackoffMs: 500,
      onError: (_target, phase) => errors.push(phase),
    });

    vi.useFakeTimers();
    await dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pullCallCount.value).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(pullCallCount.value).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pullCallCount.value).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pullCallCount.value).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(pullCallCount.value).toBe(4);
    // The empty poll that succeeded reset the failure count: the next wait is the empty backoff.
    await vi.advanceTimersByTimeAsync(500);
    expect(pullCallCount.value).toBe(5);
    expect(errors).toEqual(["pull", "pull", "pull"]);

    await dispatcher.stop();
  });

  it("stop() halts the loop with no further pull or enqueue", async () => {
    vi.useFakeTimers();
    const { transport, pullCallCount } = createFakeTransport();
    const dispatcher = createGmailPubSubDispatcher(pool, transport, { pullEmptyBackoffMs: 1000 });
    await dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();
    const pullsAfterStop = pullCallCount.value;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pullCallCount.value).toBe(pullsAfterStop);
    expect(enqueueMailAccountSync).not.toHaveBeenCalled();
  });

  it("starts and stops from a system scope", async () => {
    const { transport } = createFakeTransport();
    const dispatcher = createGmailPubSubDispatcher(pool, transport, { pullEmptyBackoffMs: 1 });
    await runAsSystem("test", async () => {
      await dispatcher.start();
    });
    await dispatcher.stop();
  });
});
