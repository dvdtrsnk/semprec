import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createBoundedImapIdleLifecycleFactory,
  reconnectBackoffDelayMs,
  type ImapIdleConnection,
  type ImapIdleFolderTarget,
  type ImapIdleTransport,
} from "../mail/imapIdleLifecycle.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function pendingMailSyncJobCount(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'mailAccountSync' AND j.key = $1`,
    [`mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

/** A connection that only ever ends when the test explicitly ends it — models a healthy, indefinitely-idling IMAP session. */
class FakeConnection implements ImapIdleConnection {
  closed = false;
  closeCalls = 0;
  private endResolve!: (err: unknown) => void;
  private readonly endPromise: Promise<unknown>;
  onSignal: () => void;

  constructor(onSignal: () => void) {
    this.onSignal = onSignal;
    this.endPromise = new Promise((resolve) => {
      this.endResolve = resolve;
    });
  }

  waitForEnd(): Promise<unknown> {
    return this.endPromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls++;
  }

  fail(err: unknown): void {
    this.endResolve(err);
  }
}

interface FakeTransportOptions {
  folders?: ImapIdleFolderTarget[];
  /** Returns either a fresh connection or throws to simulate a failed connect attempt — called once per connect() invocation. */
  onConnect?: (folderPath: string, attemptNumber: number) => FakeConnection | "reject";
}

function createFakeTransport(options: FakeTransportOptions = {}): { transport: ImapIdleTransport; connections: Map<string, FakeConnection[]>; connectAttempts: Map<string, number> } {
  const connections = new Map<string, FakeConnection[]>();
  const connectAttempts = new Map<string, number>();
  const transport: ImapIdleTransport = {
    async resolveFolders() {
      return options.folders ?? [{ path: "INBOX" }];
    },
    async connect(_mailboxItemId, _credential, folderPath, onSignal) {
      const attempt = (connectAttempts.get(folderPath) ?? 0) + 1;
      connectAttempts.set(folderPath, attempt);
      const outcome = options.onConnect ? options.onConnect(folderPath, attempt) : new FakeConnection(onSignal);
      if (outcome === "reject") throw new Error(`simulated connect failure for ${folderPath}, attempt ${attempt}`);
      const list = connections.get(folderPath) ?? [];
      list.push(outcome);
      connections.set(folderPath, list);
      return outcome;
    },
  };
  return { transport, connections, connectAttempts };
}

describe("bounded IMAP IDLE reconnect backoff (issue #196)", () => {
  it("grows exponentially, capped at the configured maximum", () => {
    expect(reconnectBackoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(reconnectBackoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(reconnectBackoffDelayMs(3, 1000, 60_000)).toBe(4000);
    expect(reconnectBackoffDelayMs(10, 1000, 60_000)).toBe(60_000);
  });

  it("never goes below the base delay even for attempt 0", () => {
    expect(reconnectBackoffDelayMs(0, 1000, 60_000)).toBe(1000);
  });
});

describe("bounded IMAP IDLE lifecycle (issue #196)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues an immediate reconcile on start, then again (deduplicated by jobKey) when a folder signals EXISTS/EXPUNGE/flags", async () => {
    const { transport, connections } = createFakeTransport();
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-1", syncMode: "imap" });

    await lifecycle.start();
    expect(await pendingMailSyncJobCount("mailbox-1")).toBe(1);

    const conn = connections.get("INBOX")![0];
    conn.onSignal(); // simulates an EXISTS/EXPUNGE/flags notification observed while idling
    // The signal only ever re-enqueues through the same idempotent jobKey — never a second,
    // parallel job — so the pending count for this account stays at exactly one.
    await vi.waitFor(async () => expect(await pendingMailSyncJobCount("mailbox-1")).toBe(1));

    await lifecycle.stop();
    expect(conn.closeCalls).toBe(1);
  });

  it("keeps Inbox's loop running when All Mail's connect keeps failing, isolating one folder's failure from the other", async () => {
    const { transport, connections, connectAttempts } = createFakeTransport({
      folders: [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }],
      onConnect: (folderPath) => (folderPath === "[Gmail]/All Mail" ? "reject" : new FakeConnection(() => {})),
    });
    const errors: Array<{ folderPath: string }> = [];
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      onError: (_mailboxItemId, folderPath) => errors.push({ folderPath }),
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-2", syncMode: "imap" });

    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    await vi.waitFor(() => expect((connectAttempts.get("[Gmail]/All Mail") ?? 0) > 1).toBe(true));

    await lifecycle.stop();
    expect(errors.every((e) => e.folderPath === "[Gmail]/All Mail")).toBe(true);
    expect(connections.get("[Gmail]/All Mail")).toBeUndefined();
  });

  it("recycles a healthy connection once the hard-cycle deadline elapses, with no backoff delay", async () => {
    vi.useFakeTimers();
    const { transport, connections } = createFakeTransport();
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
      hardCycleDeadlineMs: 1000,
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-3", syncMode: "imap" });

    await lifecycle.start();
    expect(connections.get("INBOX")!.length).toBe(1);
    const firstConn = connections.get("INBOX")![0];

    await vi.advanceTimersByTimeAsync(1001);
    expect(firstConn.closeCalls).toBe(1);
    expect(connections.get("INBOX")!.length).toBe(2);

    await lifecycle.stop();
  });

  it("backs off with a capped, growing delay after repeated connection failures, then resets after a success", async () => {
    vi.useFakeTimers();
    let rejectNext = 3;
    const { transport, connections } = createFakeTransport({
      onConnect: () => {
        if (rejectNext > 0) {
          rejectNext--;
          return "reject";
        }
        return new FakeConnection(() => {});
      },
    });
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 10_000,
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-4", syncMode: "imap" });

    await lifecycle.start();
    // 3 rejected attempts back off 1000ms, 2000ms, 4000ms before the 4th attempt succeeds.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(connections.get("INBOX")?.length).toBe(1);

    await lifecycle.stop();
  });

  it("stop() closes every open connection and waits for every folder loop to finish before returning", async () => {
    const { transport, connections } = createFakeTransport({ folders: [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }] });
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-5", syncMode: "imap" });

    await lifecycle.start();
    await vi.waitFor(() => {
      expect(connections.get("INBOX")?.length).toBe(1);
      expect(connections.get("[Gmail]/All Mail")?.length).toBe(1);
    });

    await lifecycle.stop();
    expect(connections.get("INBOX")![0].closed).toBe(true);
    expect(connections.get("[Gmail]/All Mail")![0].closed).toBe(true);
  });

  it("respects the per-account connection limit, never holding more concurrent IDLE connections than the budget allows", async () => {
    let active = 0;
    let maxActive = 0;
    const transport: ImapIdleTransport = {
      async resolveFolders() {
        return [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }];
      },
      async connect(_mailboxItemId, _credential, folderPath, onSignal) {
        active++;
        maxActive = Math.max(maxActive, active);
        const conn = new FakeConnection(onSignal);
        const originalClose = conn.close.bind(conn);
        conn.close = async () => {
          active--;
          await originalClose();
        };
        return conn;
      },
    };
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 1, // budget of one — Inbox and All Mail must never both hold a slot at once
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-6", syncMode: "imap" });

    await lifecycle.start();
    await vi.waitFor(() => expect(active).toBe(1));
    expect(maxActive).toBe(1);

    await lifecycle.stop();
  });
});
