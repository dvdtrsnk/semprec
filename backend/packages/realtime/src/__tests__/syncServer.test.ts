import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { createSyncServer, type SyncIdentity, type SyncServer } from "../syncServer.js";

let pool: Pool;

/** Resolves once `client` opens, rejecting on `error` — a rejected upgrade must reach the other branch instead. */
function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

describe("createSyncServer (issue #160)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let activeSessionIds: Set<string>;

  function registerIdentity(token: string, identity: SyncIdentity): void {
    identityByToken.set(token, identity);
    activeSessionIds.add(identity.sessionId);
  }

  beforeEach(async () => {
    pool ??= new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    identityByToken = new Map();
    activeSessionIds = new Set();

    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        if (!token) return null;
        return identityByToken.get(token) ?? null;
      },
      revalidateSession: async (sessionId: string) => activeSessionIds.has(sessionId),
      heartbeatIntervalMs: 30_000,
    });

    httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    httpServer.on("upgrade", (req, socket, head) => syncServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    await syncServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("opens a socket for a valid credential", async () => {
    registerIdentity("t1", { userId: "user-1", sessionId: "session-1" });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    await waitForOpen(client);
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });

  it("rejects an invalid credential with HTTP 401 and never opens a socket", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=garbage`);
    const statusCode = await new Promise<number>((resolve) => {
      client.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    });
    expect(statusCode).toBe(401);
    expect(client.readyState).not.toBe(client.OPEN);
  });

  it("drops a malformed text frame and a too-short binary frame without affecting another connected client", async () => {
    registerIdentity("t1", { userId: "user-1", sessionId: "session-1" });
    registerIdentity("t2", { userId: "user-2", sessionId: "session-2" });

    const troublemaker = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    const bystander = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t2`);
    await Promise.all([waitForOpen(troublemaker), waitForOpen(bystander)]);

    troublemaker.send("not json");
    troublemaker.send(JSON.stringify({ type: "doc:vaporize", docId: "not-a-uuid" }));
    troublemaker.send(Buffer.from([1, 2, 3]));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(troublemaker.readyState).toBe(troublemaker.OPEN);
    expect(bystander.readyState).toBe(bystander.OPEN);

    troublemaker.close();
    bystander.close();
  });

  it("closes exactly the revoked session's socket with 4401 on a session_revoked NOTIFY", async () => {
    registerIdentity("t1", { userId: "user-1", sessionId: "session-a" });
    registerIdentity("t2", { userId: "user-2", sessionId: "session-b" });

    const revoked = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    const surviving = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t2`);
    await Promise.all([waitForOpen(revoked), waitForOpen(surviving)]);

    const revokedClosed = new Promise<number>((resolve) => revoked.once("close", (code) => resolve(code)));

    await publishRealtimeMessage(pool, { type: "session_revoked", sessionId: "session-a" });

    expect(await revokedClosed).toBe(4401);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(surviving.readyState).toBe(surviving.OPEN);
    surviving.close();
  });

  it("leaves sockets open on a session_revoked NOTIFY for an unrelated session", async () => {
    registerIdentity("t1", { userId: "user-1", sessionId: "session-a" });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    await waitForOpen(client);

    await publishRealtimeMessage(pool, { type: "session_revoked", sessionId: "some-other-session" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });
});

describe("createSyncServer heartbeat fallback (issue #160)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let heartbeatPool: Pool;

  afterEach(async () => {
    await syncServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  afterAll(async () => {
    await heartbeatPool?.end();
  });

  it("closes a socket with 4401 once its session revalidates as inactive", async () => {
    heartbeatPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    syncServer = await createSyncServer(heartbeatPool, {
      authenticate: async () => ({ userId: "user-1", sessionId: "session-stale" }),
      revalidateSession: async () => false,
      heartbeatIntervalMs: 20,
    });
    httpServer = createServer();
    httpServer.on("upgrade", (req, socket, head) => syncServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync`);
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    await waitForOpen(client);

    expect(await closed).toBe(4401);
  });
});
