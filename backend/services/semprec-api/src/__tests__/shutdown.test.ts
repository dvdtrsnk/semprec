import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createGmailPubSubDispatcher,
  createUser,
  hashPassword,
  login,
  startTenantDeactivationListener,
  type GmailWatchTransport,
  type TenantDeactivationListener,
} from "@semprec/data";
import type { SyncServer } from "@semprec/realtime";
import type { Logger } from "@semprec/shared";
import { createVoiceChannel, type VoiceChannel } from "../voiceChannel.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";
import { createGracefulShutdown } from "../shutdown.js";

const PASSWORD = "s3cret-password";
const SERVICE_RESTART_CLOSE_CODE = 1012;

interface CapturedLine {
  level: "info" | "error";
  obj: unknown;
  msg: string;
}

function createCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger = {
    info: (obj: unknown, msg: string) => {
      lines.push({ level: "info", obj, msg });
    },
    error: (obj: unknown, msg: string) => {
      lines.push({ level: "error", obj, msg });
    },
  } as unknown as Logger;
  return { logger, lines };
}

/**
 * Builds the same HTTP + `WS /api/sync` wiring `serve.ts` does, over `pool`, bound to an ephemeral
 * port, with the tenant deactivation listener started after the sync server.
 */
async function startServer(pool: Pool): Promise<{
  server: Server;
  syncServer: SyncServer;
  voiceServer: VoiceChannel;
  tenantDeactivationListener: TenantDeactivationListener;
  wsBaseUrl: string;
}> {
  const syncServer = await createSyncUpgradeHandler(pool);
  const voiceServer = createVoiceChannel(pool, {
    handler: { onStart() {}, onAudio() {}, onControl() {}, onClose() {} },
  });
  const tenantDeactivationListener = await startTenantDeactivationListener(pool, async (tenantId) => {
    syncServer.closeTenant(tenantId);
    voiceServer.closeTenant(tenantId);
  });
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/sync") {
      syncServer.handleUpgrade(req, socket, head);
      return;
    }
    if (pathname === "/api/voice") {
      voiceServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, syncServer, voiceServer, tenantDeactivationListener, wsBaseUrl: `ws://127.0.0.1:${address.port}` };
}

async function openAuthenticatedClient(pool: Pool, wsBaseUrl: string): Promise<WebSocket> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: "person@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  const client = new WebSocket(`${wsBaseUrl}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return client;
}

describe("semprec-api graceful shutdown closes the sync server first (issue #698)", () => {
  let sharedPool: Pool;
  let dedicatedPool: Pool;

  beforeEach(async () => {
    sharedPool ??= getTestPool();
    await resetDatabase(sharedPool);
    // The shutdown under test ends the pool it is given; a separate pool keeps the shared test pool alive.
    dedicatedPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterEach(async () => {
    if (!dedicatedPool.ended) await dedicatedPool.end();
  });

  afterAll(async () => {
    await sharedPool?.end();
  });

  it("settles well under the drain bound and delivers close code 1012 to a connected client", async () => {
    const { server, syncServer, voiceServer, tenantDeactivationListener, wsBaseUrl } = await startServer(dedicatedPool);
    const client = await openAuthenticatedClient(dedicatedPool, wsBaseUrl);
    const closeCode = new Promise<number>((resolve) => {
      client.once("close", (code: number) => resolve(code));
    });
    const stop = vi.fn(async () => {});
    const { logger, lines } = createCapturingLogger();

    const started = performance.now();
    await createGracefulShutdown({
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      queueRuntime: { stop },
      mailLiveSync: { stop: async () => {} },
      pool: dedicatedPool,
      logger,
    })("SIGTERM");
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(await closeCode).toBe(SERVICE_RESTART_CLOSE_CODE);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dedicatedPool.ended).toBe(true);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });

  it("closes a live voice socket before draining the HTTP server", async () => {
    const { server, syncServer, voiceServer, tenantDeactivationListener, wsBaseUrl } = await startServer(dedicatedPool);
    const user = await createUser(dedicatedPool, {
      tenantId: await tenantForNextTestUser(dedicatedPool),
      email: "voice@example.com",
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(dedicatedPool, {
      email: user.email,
      password: PASSWORD,
      platform: "ios",
      ip: "127.0.0.1",
    });
    const client = new WebSocket(`${wsBaseUrl}/api/voice`, { headers: { Authorization: `Bearer ${token}` } });
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const code = new Promise<number>((resolve) => client.once("close", resolve));
    const { logger } = createCapturingLogger();
    await createGracefulShutdown({
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      queueRuntime: { stop: async () => {} },
      mailLiveSync: { stop: async () => {} },
      pool: dedicatedPool,
      logger,
    })("SIGTERM");
    expect(await code).toBe(1012);
    expect(server.listening).toBe(false);
    expect(dedicatedPool.ended).toBe(true);
  });

  it("still drains, stops the queue runtime and ends the pool when syncServer.close() rejects", async () => {
    const {
      server,
      syncServer: realSyncServer,
      voiceServer,
      tenantDeactivationListener,
    } = await startServer(dedicatedPool);
    const closeError = new Error("sync close failed");
    // Releases the real server's LISTEN client first so the pool can still end within its bound, then rejects.
    const syncServer = {
      close: vi.fn(async () => {
        await realSyncServer.close();
        throw closeError;
      }),
    };
    const stop = vi.fn(async () => {});
    const { logger, lines } = createCapturingLogger();

    await createGracefulShutdown({
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      queueRuntime: { stop },
      mailLiveSync: { stop: async () => {} },
      pool: dedicatedPool,
      logger,
    })("SIGTERM");

    expect(syncServer.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(dedicatedPool.ended).toBe(true);
    expect(lines.filter((line) => line.msg.startsWith("pool.end()"))).toEqual([]);
    const failures = lines.filter((line) => line.msg === "syncServer.close() failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: "error", obj: { err: closeError, signal: "SIGTERM" } });
    expect(lines.at(-1)).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });

  it("with no sync client connected, drains, stops the queue runtime and ends the pool as before", async () => {
    const { server, syncServer, voiceServer, tenantDeactivationListener } = await startServer(dedicatedPool);
    const stop = vi.fn(async () => {});
    const { logger, lines } = createCapturingLogger();

    await createGracefulShutdown({
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      queueRuntime: { stop },
      mailLiveSync: { stop: async () => {} },
      pool: dedicatedPool,
      logger,
    })("SIGTERM");

    expect(server.listening).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dedicatedPool.ended).toBe(true);
    expect(lines).toEqual([
      { level: "info", obj: { signal: "SIGTERM" }, msg: "semprec-api shutting down" },
      { level: "info", obj: { signal: "SIGTERM", timedOut: false }, msg: "semprec-api shutdown complete" },
    ]);
  });
});

describe("semprec-api graceful shutdown closes the tenant deactivation listener first (issue #1042)", () => {
  let sharedPool: Pool;
  let dedicatedPool: Pool;

  beforeEach(async () => {
    sharedPool ??= getTestPool();
    await resetDatabase(sharedPool);
    dedicatedPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterEach(async () => {
    if (!dedicatedPool.ended) await dedicatedPool.end();
  });

  afterAll(async () => {
    await sharedPool?.end();
  });

  it("closes the listener and releases its client before the sync server stops", async () => {
    const {
      server,
      syncServer: realSyncServer,
      voiceServer,
      tenantDeactivationListener: realListener,
    } = await startServer(dedicatedPool);
    const order: string[] = [];
    let clientsWhenSyncCloses = -1;
    const tenantDeactivationListener = {
      close: async () => {
        order.push("listener.close");
        await realListener.close();
      },
    };
    const syncServer = {
      close: async () => {
        order.push("syncServer.close");
        // The sync server still holds its own LISTEN client; the listener's is already gone.
        clientsWhenSyncCloses = dedicatedPool.totalCount;
        await realSyncServer.close();
      },
    };
    const { logger, lines } = createCapturingLogger();

    await createGracefulShutdown({
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      queueRuntime: { stop: async () => {} },
      mailLiveSync: { stop: async () => {} },
      pool: dedicatedPool,
      logger,
    })("SIGTERM");

    expect(order).toEqual(["listener.close", "syncServer.close"]);
    expect(clientsWhenSyncCloses).toBe(1);
    expect(dedicatedPool.ended).toBe(true);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
  });
});

describe("semprec-api graceful shutdown stops the Gmail Pub/Sub dispatcher before the mail root (issue #1739)", () => {
  let sharedPool: Pool;
  let dedicatedPool: Pool;

  beforeEach(async () => {
    sharedPool ??= getTestPool();
    await resetDatabase(sharedPool);
    dedicatedPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterEach(async () => {
    if (!dedicatedPool.ended) await dedicatedPool.end();
  });

  afterAll(async () => {
    await sharedPool?.end();
  });

  /**
   * A Pub/Sub transport that keeps every notification until it is acknowledged, as Pub/Sub redelivers an
   * unacknowledged one. While `hold` is set, the next pull stays in flight until the test releases it.
   */
  function fakePubSub() {
    const unacknowledged = new Map([
      ["ack-held", { ackId: "ack-held", emailAddress: "nobody@example.com", historyId: "1" }],
    ]);
    const acknowledged: string[][] = [];
    let pulls = 0;
    let hold: { started: () => void; release: Promise<void> } | null = null;
    const transport: GmailWatchTransport = {
      async registerWatch() {
        throw new Error("no watch is registered in this test");
      },
      async pull() {
        pulls += 1;
        const held = hold;
        if (held) {
          hold = null;
          held.started();
          await held.release;
        }
        return [...unacknowledged.values()];
      },
      async acknowledge(ackIds) {
        acknowledged.push(ackIds);
        for (const ackId of ackIds) unacknowledged.delete(ackId);
      },
    };
    return {
      transport,
      acknowledged,
      unacknowledged,
      pulls: () => pulls,
      holdNextPull(started: () => void, release: Promise<void>) {
        hold = { started, release };
      },
    };
  }

  it("awaits the dispatcher's stop after the drain and before the mail root and the pool, leaving a pulled notification unacknowledged", async () => {
    const { server, syncServer, voiceServer, tenantDeactivationListener } = await startServer(dedicatedPool);
    const pubSub = fakePubSub();
    let pullStarted: () => void = () => {};
    const pulling = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    let releasePull: () => void = () => {};
    pubSub.holdNextPull(
      pullStarted,
      new Promise<void>((resolve) => {
        releasePull = resolve;
      }),
    );
    const dispatcher = createGmailPubSubDispatcher(dedicatedPool, pubSub.transport);
    const order: string[] = [];
    let listeningAtDispatcherStop: boolean | undefined;
    let poolEndedAtRootStop: boolean | undefined;
    let shutdownStarted = false;
    let primary: { error: unknown } | undefined;
    try {
      await dispatcher.start();
      await within(pulling, 10_000, "The held pull");
      const { logger, lines } = createCapturingLogger();
      shutdownStarted = true;
      await createGracefulShutdown({
        server,
        tenantDeactivationListener,
        syncServer,
        voiceServer,
        queueRuntime: {
          stop: async () => {
            order.push("queueRuntime.stop");
          },
        },
        gmailPubSubDispatcher: {
          stop: async () => {
            order.push("gmailPubSubDispatcher.stop");
            listeningAtDispatcherStop = server.listening;
            const stopping = dispatcher.stop();
            // The pull in flight returns after the stop was requested, as one would at its request timeout.
            releasePull();
            await stopping;
            order.push("gmailPubSubDispatcher.stopped");
          },
        },
        mailLiveSync: {
          stop: async () => {
            order.push("mailLiveSync.stop");
            poolEndedAtRootStop = dedicatedPool.ended;
          },
        },
        pool: dedicatedPool,
        logger,
      })("SIGTERM");
      expect(order).toEqual([
        "gmailPubSubDispatcher.stop",
        "gmailPubSubDispatcher.stopped",
        "mailLiveSync.stop",
        "queueRuntime.stop",
      ]);
      expect(listeningAtDispatcherStop).toBe(false);
      expect(poolEndedAtRootStop).toBe(false);
      expect(dedicatedPool.ended).toBe(true);
      expect(lines.filter((line) => line.level === "error")).toEqual([]);
    } catch (error) {
      primary = { error };
    }
    await settleAll(primary, [
      () => releasePull(),
      () => dispatcher.stop(),
      // A case that failed before the shutdown ran closes what the shutdown would have closed.
      async () => {
        if (shutdownStarted) return;
        await syncServer.close();
        await voiceServer.close();
        await tenantDeactivationListener.close();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
      },
    ]);
    // Pulled, never dispatched, never acknowledged: Pub/Sub still holds it.
    expect(pubSub.pulls()).toBe(1);
    expect(pubSub.acknowledged).toEqual([]);
    expect([...pubSub.unacknowledged.keys()]).toEqual(["ack-held"]);

    // The next process's dispatcher receives it again and, once handed off (no mailbox watches the
    // address), acknowledges it.
    const next = createGmailPubSubDispatcher(sharedPool, pubSub.transport, { pullEmptyBackoffMs: 10 });
    let nextPrimary: { error: unknown } | undefined;
    try {
      await next.start();
      await vi.waitFor(() => expect(pubSub.acknowledged).toEqual([["ack-held"]]));
    } catch (error) {
      nextPrimary = { error };
    }
    await settleAll(nextPrimary, [() => next.stop()]);
    expect(pubSub.unacknowledged.size).toBe(0);
  });
});

/** Rejects naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every cleanup even when one fails. The case's own failure, `primary`, stays first: it is rethrown, or,
 * when a cleanup failed too, rethrown inside an `AggregateError` with the cleanup failures after it. A thrown
 * falsy value counts as a failure because `primary` wraps it.
 */
async function settleAll(primary: { error: unknown } | undefined, cleanups: (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary && failures.length > 0) {
    throw new AggregateError([primary.error, ...failures], "The case and its cleanup failed", { cause: primary.error });
  }
  if (primary) throw primary.error;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "The case's cleanup failed");
}
