import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ImapFlow } from "imapflow";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createBoundedImapIdleLifecycleFactory,
  reconnectBackoffDelayMs,
  type ImapIdleConnection,
  type ImapIdleFolderTarget,
  type ImapIdleTransport,
} from "../mail/imapIdleLifecycle.js";
import { createImapFlowIdleTransport } from "../mail/imapIdleClient.js";

let pool: Pool;

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

function ownedIdleClient() {
  const client = new ImapFlow({
    host: "imap.example.test",
    port: 993,
    secure: true,
    auth: { user: "fake", pass: "fake" },
    logger: false,
  });
  vi.spyOn(client, "list").mockResolvedValue([
    {
      path: "INBOX",
      pathAsListed: "INBOX",
      name: "INBOX",
      delimiter: "/",
      parent: [],
      parentPath: "",
      flags: new Set(),
      specialUse: "\\Inbox",
      listed: true,
      subscribed: true,
    },
  ]);
  vi.spyOn(client, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
  });
  const logout = vi.spyOn(client, "logout").mockImplementation(async () => {
    client.emit("close");
  });
  const close = vi.spyOn(client, "close").mockImplementation(() => {
    client.emit("close");
  });
  return { client, logout, close };
}

interface FakeTransportOptions {
  folders?: ImapIdleFolderTarget[];
  /** Returns either a fresh connection or throws to simulate a failed connect attempt — called once per connect() invocation. */
  onConnect?: (folderPath: string, attemptNumber: number) => FakeConnection | "reject";
}

function createFakeTransport(options: FakeTransportOptions = {}): {
  transport: ImapIdleTransport;
  connections: Map<string, FakeConnection[]>;
  connectAttempts: Map<string, number>;
} {
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
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enqueues an immediate reconcile on start, then again (deduplicated by jobKey) when a folder signals EXISTS/EXPUNGE/flags", async () => {
    const { transport, connections } = createFakeTransport();
    const factory = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
    });
    const lifecycle = factory({ mailboxItemId: "mailbox-1", syncMode: "imap" });

    await lifecycle.start();
    await vi.waitFor(async () => expect(await pendingMailSyncJobCount("mailbox-1")).toBe(1));

    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    const conn = connections.get("INBOX")![0]!;
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
    const { transport, connections } = createFakeTransport();
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
      hardCycleDeadlineMs: 30,
    })({ mailboxItemId: "mailbox-3", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length ?? 0).toBeGreaterThanOrEqual(2));
    expect(connections.get("INBOX")![0]!.closeCalls).toBe(1);
    await lifecycle.stop();
  });

  it("backs off after repeated connection failures and reconnects", async () => {
    let rejectNext = 3;
    const { transport, connections, connectAttempts } = createFakeTransport({
      onConnect: () => (--rejectNext >= 0 ? "reject" : new FakeConnection(() => {})),
    });
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "app-password",
      getConnectionLimit: () => 5,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
    })({ mailboxItemId: "mailbox-4", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    expect(connectAttempts.get("INBOX")).toBe(4);
    await lifecycle.stop();
  });

  it("stop() closes every open connection and waits for every folder loop to finish before returning", async () => {
    const { transport, connections } = createFakeTransport({
      folders: [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }],
    });
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
    expect(connections.get("INBOX")![0]!.closed).toBe(true);
    expect(connections.get("[Gmail]/All Mail")![0]!.closed).toBe(true);
  });

  it("respects the per-account connection limit, never holding more concurrent IDLE connections than the budget allows", async () => {
    let active = 0;
    let maxActive = 0;
    const transport: ImapIdleTransport = {
      async resolveFolders() {
        return [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }];
      },
      async connect(_mailboxItemId, _credential, _folderPath, onSignal) {
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
  it("retries refused discovery and eventually connects", async () => {
    let attempts = 0;
    const refusal = new Error("private credential and host");
    const errors: unknown[] = [];
    const { transport, connections } = createFakeTransport();
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => {
        if (++attempts === 1) throw refusal;
        return "password";
      },
      getConnectionLimit: () => 1,
      reconnectBaseDelayMs: 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "discovery-retry", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    expect(errors).toEqual([refusal]);
    await lifecycle.stop();
    expect(connections.get("INBOX")?.[0]?.closed).toBe(true);
  });

  it("retries a failed connection-limit lookup", async () => {
    let attempts = 0;
    const { transport, connections } = createFakeTransport();
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => {
        if (++attempts === 1) throw new Error("private limit");
        return 1;
      },
      reconnectBaseDelayMs: 1,
      onError: () => {},
    })({ mailboxItemId: "limit-retry", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    await lifecycle.stop();
    expect(connections.get("INBOX")?.[0]?.closed).toBe(true);
  });

  it("joins discovery on stop and does not open a connection afterwards", async () => {
    let release!: (targets: ImapIdleFolderTarget[]) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { transport, connectAttempts } = createFakeTransport();
    transport.resolveFolders = async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
    })({ mailboxItemId: "discovery-stop", syncMode: "imap" });
    const starting = lifecycle.start();
    await ready;
    let stopped = false;
    const stopping = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release([{ path: "INBOX" }]);
    await Promise.all([starting, stopping]);
    expect(connectAttempts.size).toBe(0);
  });

  it.each(["credential", "folders", "limit", "connect"] as const)(
    "retains an owned %s rejection that settles after stop begins",
    async (stage) => {
      let entered!: () => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<never>((_resolve, rejectPending) => {
        reject = rejectPending;
      });
      const failAtStage = () => {
        entered();
        return pending;
      };
      const errors: unknown[] = [];
      const { transport } = createFakeTransport();
      if (stage === "folders") transport.resolveFolders = failAtStage;
      if (stage === "connect") transport.connect = failAtStage;
      const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
        getCredential: () => (stage === "credential" ? failAtStage() : Promise.resolve("password")),
        getConnectionLimit: () => (stage === "limit" ? failAtStage() : 1),
        onError: (_id, _folder, error) => errors.push(error),
      })({ mailboxItemId: `stop-${stage}`, syncMode: "imap" });
      await lifecycle.start();
      await ready;
      const stopping = lifecycle.stop();
      reject(undefined);
      await expect(stopping).rejects.toThrow("IMAP IDLE lifecycle failed unexpectedly");
      expect(errors).toEqual([undefined]);
    },
  );

  it("retains the ended connection error before a later cleanup failure", async () => {
    const original = new Error("private connection failure");
    const cleanup = new Error("private cleanup failure");
    const errors: unknown[] = [];
    const { transport, connections } = createFakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async (...args) => {
      const connection = await connect(...args);
      connection.close = async () => {
        throw cleanup;
      };
      return connection;
    };
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "connection-and-cleanup", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    connections.get("INBOX")?.[0]?.fail(original);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBeInstanceOf(AggregateError);
    if (!(errors[0] instanceof AggregateError)) throw new Error("expected combined failure");
    expect(errors[0].errors).toEqual([original, cleanup]);
    await expect(lifecycle.stop()).rejects.toThrow("IMAP IDLE lifecycle failed unexpectedly");
  });

  it("retains a connection failure when stop begins during its successful cleanup", async () => {
    const original = new Error("private connection failure");
    const errors: unknown[] = [];
    let closeEntered!: () => void;
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeEntered = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { transport, connections } = createFakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async (...args) => {
      const connection = await connect(...args);
      const close = connection.close.bind(connection);
      connection.close = async () => {
        closeEntered();
        await closeGate;
        await close();
      };
      return connection;
    };
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "stop-during-cleanup", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    connections.get("INBOX")?.[0]?.fail(original);
    await closing;
    const stopping = lifecycle.stop();
    releaseClose();
    await expect(stopping).rejects.toThrow("IMAP IDLE lifecycle failed unexpectedly");
    expect(errors).toEqual([original]);
  });

  it("retains a connection failure observed after stop wins the round but before cleanup finishes", async () => {
    const original = new Error("private late connection failure");
    const errors: unknown[] = [];
    let closeEntered!: () => void;
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeEntered = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { transport, connections } = createFakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async (...args) => {
      const connection = await connect(...args);
      const close = connection.close.bind(connection);
      connection.close = async () => {
        closeEntered();
        await closeGate;
        await close();
      };
      return connection;
    };
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "end-during-stop-cleanup", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    const stopping = lifecycle.stop();
    await closing;
    connections.get("INBOX")?.[0]?.fail(original);
    releaseClose();
    await expect(stopping).rejects.toThrow("IMAP IDLE lifecycle failed unexpectedly");
    expect(errors).toEqual([original]);
  });

  it("retains a late end rejection carrying undefined while stop owns cleanup", async () => {
    const errors: unknown[] = [];
    let rejectEnd!: (error: unknown) => void;
    let closeEntered!: () => void;
    let releaseClose!: () => void;
    const end = new Promise<unknown>((_resolve, reject) => {
      rejectEnd = reject;
    });
    const closing = new Promise<void>((resolve) => {
      closeEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { transport, connections } = createFakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async (...args) => {
      const connection = await connect(...args);
      connection.waitForEnd = () => end;
      connection.close = async () => {
        closeEntered();
        await gate;
      };
      return connection;
    };
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "late-undefined", syncMode: "imap" });
    await lifecycle.start();
    await vi.waitFor(() => expect(connections.get("INBOX")?.length).toBe(1));
    const stopping = lifecycle.stop();
    await closing;
    rejectEnd(undefined);
    releaseClose();
    await expect(stopping).rejects.toThrow("IMAP IDLE lifecycle failed unexpectedly");
    expect(errors).toEqual([undefined]);
  });

  it("retries a composed IDLE transport after one already-closed connection error", async () => {
    const discovery = ownedIdleClient();
    const first = ownedIdleClient();
    const second = ownedIdleClient();
    // ImapFlow's declaration says void, but its public implementation returns false here.
    // @ts-expect-error public ImapFlow logout can resolve false
    first.logout.mockResolvedValue(false);
    const clients = [discovery, first, second];
    const errors: unknown[] = [];
    let next = 0;
    const transport = createImapFlowIdleTransport(async () => {
      const client = clients[next++];
      if (!client) throw new Error("Unexpected IDLE connection");
      return client.client;
    });
    const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
      getCredential: async () => "password",
      getConnectionLimit: () => 1,
      reconnectBaseDelayMs: 1,
      onError: (_id, _folder, error) => errors.push(error),
    })({ mailboxItemId: "retry-composed", syncMode: "imap" });
    const original = new Error("private original failure");
    let primary: { value: unknown } | undefined;
    let cleanup: { value: unknown } | undefined;
    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(first.client.listenerCount("error")).toBe(1));
      first.client.emit("error", original);
      first.client.emit("close");
      await vi.waitFor(() => expect(second.client.listenerCount("error")).toBe(1));
      expect(errors).toEqual([original]);
    } catch (error) {
      primary = { value: error };
    } finally {
      first.client.emit("close");
      second.client.emit("close");
      try {
        await lifecycle.stop();
      } catch (error) {
        cleanup = { value: error };
      }
    }
    if (primary && cleanup)
      throw new AggregateError([primary.value, cleanup.value], "IDLE test and cleanup failed", {
        cause: primary.value,
      });
    if (primary) throw primary.value;
    if (cleanup) throw cleanup.value;
  });

  it.each(["none", "error", "undefined"] as const)(
    "keeps a composed IDLE owner until public close, close throws=%s",
    async (closeMode) => {
      const discovery = ownedIdleClient();
      const active = ownedIdleClient();
      // ImapFlow's declaration says void, but its public implementation returns false here.
      // @ts-expect-error public ImapFlow logout can resolve false
      active.logout.mockResolvedValue(false);
      const closeFailure = new Error("private close failure");
      active.close.mockImplementation(() => {
        if (closeMode === "error") throw closeFailure;
        if (closeMode === "undefined") {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw undefined;
        }
      });
      const clients = [discovery, active];
      const errors: unknown[] = [];
      let next = 0;
      let heldSlots = 0;
      const transport = createImapFlowIdleTransport(async () => {
        const client = clients[next++];
        if (!client) throw new Error("Unexpected IDLE connection");
        return client.client;
      });
      const lifecycle = createBoundedImapIdleLifecycleFactory(pool, transport, {
        getCredential: async () => "password",
        getConnectionLimit: () => 1,
        connectionLimiter: {
          async run(_id, _limit, work) {
            heldSlots++;
            try {
              return await work();
            } finally {
              heldSlots--;
            }
          },
        },
        onError: (_id, _folder, error) => errors.push(error),
      })({ mailboxItemId: `held-close-${closeMode}`, syncMode: "imap" });
      const original = new Error("private original failure");
      let stopping: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      let observedStop = false;
      let primary: { value: unknown } | undefined;
      let cleanup: { value: unknown } | undefined;
      try {
        await lifecycle.start();
        await vi.waitFor(() => expect(active.client.listenerCount("error")).toBe(1));
        active.client.emit("error", original);
        await vi.waitFor(() => expect(active.close).toHaveBeenCalledTimes(1));
        let settled = false;
        stopping = lifecycle
          .stop()
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          .then((result) => {
            settled = true;
            return result;
          });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(heldSlots).toBe(1);
        active.client.emit("close");
        const result = await stopping;
        observedStop = true;
        expect(heldSlots).toBe(0);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected IDLE stop failure");
        expect(result.error).toBeInstanceOf(Error);
        if (closeMode !== "none") {
          expect(errors[0]).toBeInstanceOf(AggregateError);
          if (!(errors[0] instanceof AggregateError)) throw new Error("Expected operation and cleanup failures");
          expect(errors[0].errors).toEqual([original, closeMode === "error" ? closeFailure : undefined]);
        } else expect(errors).toEqual([original]);
        expect(JSON.stringify(result.error)).not.toContain("private");
      } catch (error) {
        primary = { value: error };
      } finally {
        active.client.emit("close");
        if (stopping) {
          const result = await stopping;
          if (!observedStop && !result.ok) cleanup = { value: result.error };
        } else {
          try {
            await lifecycle.stop();
          } catch (error) {
            cleanup = { value: error };
          }
        }
      }
      if (cleanup && primary)
        throw new AggregateError([primary.value, cleanup.value], "IDLE test and cleanup failed", {
          cause: primary.value,
        });
      if (primary) throw primary.value;
      if (cleanup) throw cleanup.value;
    },
  );
});
