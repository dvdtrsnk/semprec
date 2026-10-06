import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createUser, hashPassword, login } from "@semprec/data";
import type { SyncServer } from "@semprec/realtime";
import type { Logger } from "@semprec/shared";
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

/** Builds the same HTTP + `WS /api/sync` wiring `serve.ts` does, over `pool`, bound to an ephemeral port. */
async function startServer(pool: Pool): Promise<{ server: Server; syncServer: SyncServer; wsBaseUrl: string }> {
  const syncServer = await createSyncUpgradeHandler(pool);
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
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, syncServer, wsBaseUrl: `ws://127.0.0.1:${address.port}` };
}

async function openAuthenticatedClient(pool: Pool, wsBaseUrl: string): Promise<WebSocket> {
  const user = await createUser(pool, { email: "person@example.com", passwordHash: await hashPassword(PASSWORD) });
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
    const { server, syncServer, wsBaseUrl } = await startServer(dedicatedPool);
    const client = await openAuthenticatedClient(dedicatedPool, wsBaseUrl);
    const closeCode = new Promise<number>((resolve) => {
      client.once("close", (code: number) => resolve(code));
    });
    const stop = vi.fn(async () => {});
    const { logger, lines } = createCapturingLogger();

    const started = performance.now();
    await createGracefulShutdown({
      server,
      syncServer,
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

  it("still drains, stops the queue runtime and ends the pool when syncServer.close() rejects", async () => {
    const { server, syncServer: realSyncServer } = await startServer(dedicatedPool);
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
      syncServer,
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
    const { server, syncServer } = await startServer(dedicatedPool);
    const stop = vi.fn(async () => {});
    const { logger, lines } = createCapturingLogger();

    await createGracefulShutdown({
      server,
      syncServer,
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
