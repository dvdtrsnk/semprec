import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { WebSocket, type RawData } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import {
  createPool,
  withTransaction,
  createAgentRun,
  createUser,
  hashPassword,
  insertAgentRunEvent,
  writeNotification,
  createChokePoint,
  createDocStore,
  type ChokePoint,
  type DocStore,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import {
  AGENT_STREAM_CHANNEL,
  parseAgentStreamEnvelope,
  publishAgentRunDelta,
  publishRealtimeMessage,
} from "../pgNotifyPublisher.js";
import { createSyncServer, type SyncIdentity, type SyncServer } from "../syncServer.js";
import { buildBinaryFrame, decodeDocId, parseBinaryFrame } from "../protocolV1.js";
import { wireRealtimeHooks } from "../wireHooks.js";

const { realtimeWarn } = vi.hoisted(() => ({ realtimeWarn: vi.fn() }));

// Only the realtime package's own logger is replaced so its warnings can be asserted; every other
// logger (tenant-scope, ...) stays real.
vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === "realtime" ? ({ warn: realtimeWarn, error: vi.fn() } as never) : actual.createLogger(name),
  };
});

let pool: Pool;

/** Publishes a hand-built envelope, as a foreign or misbehaving publisher could. */
async function notifyEnvelope(pool: Pool, channel: string, tenantId: string, message: unknown): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify({ tenantId, message })]);
}

afterAll(async () => {
  await pool?.end();
});

/** Resolves once `client` opens, rejecting on `error` — a rejected upgrade must reach the other branch instead. */
function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

/**
 * `ws` hands a message over as `Buffer | ArrayBuffer | Buffer[]`, and the array case is a
 * fragmented frame — its default `toString()` joins the fragments with commas instead of
 * concatenating them, which would corrupt the JSON these tests parse.
 */
function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function messageBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/**
 * A minimal browser-side Yjs client wired to one document over `WS /api/sync`'s binary
 * channel — exercises the same y-protocols/sync handshake a real editor client would run,
 * against the real server wiring in `syncServer.ts` (docId decode/dispatch, `docSync`).
 */
class TestDocClient {
  readonly ydoc = new Y.Doc();
  readonly received: Buffer[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly docId: string,
  ) {
    this.ydoc.gc = false;
    ws.on("message", (data: RawData) => this.handleMessage(messageBuffer(data)));
  }

  open(): void {
    this.ws.send(JSON.stringify({ type: "doc:open", docId: this.docId }));
  }

  close(): void {
    this.ws.send(JSON.stringify({ type: "doc:close", docId: this.docId }));
  }

  /** Applies a local mutation and sends the resulting Yjs update over the binary channel. */
  mutate(fn: (doc: Y.Doc) => void): void {
    let update: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array) => (update = u);
    this.ydoc.on("update", onUpdate);
    try {
      this.ydoc.transact(() => fn(this.ydoc));
    } finally {
      this.ydoc.off("update", onUpdate);
    }
    if (!update) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(buildBinaryFrame(this.docId, encoding.toUint8Array(encoder)));
  }

  private handleMessage(data: Buffer): void {
    const frame = parseBinaryFrame(data);
    if (!frame || decodeDocId(frame.docId) !== this.docId) return;
    this.received.push(frame.payload);

    const decoder = decoding.createDecoder(frame.payload);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === syncProtocol.messageYjsSyncStep1) {
      // Mirrors a real y-websocket client's bidirectional handshake: reply with whatever
      // this client has that the server (per its state vector) is missing, and separately
      // ask for the server's own content via this client's own SyncStep1.
      const remoteStateVector = decoding.readVarUint8Array(decoder);
      const step2Encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep2(step2Encoder, this.ydoc, remoteStateVector);
      this.ws.send(buildBinaryFrame(this.docId, encoding.toUint8Array(step2Encoder)));

      const step1Encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(step1Encoder, this.ydoc);
      this.ws.send(buildBinaryFrame(this.docId, encoding.toUint8Array(step1Encoder)));
      return;
    }
    if (messageType === syncProtocol.messageYjsSyncStep2 || messageType === syncProtocol.messageYjsUpdate) {
      const update = decoding.readVarUint8Array(decoder);
      Y.applyUpdate(this.ydoc, update);
    }
  }
}

/**
 * Intercepts the very first `pool.connect()` call `create()` triggers — in every test in this
 * file that is `createSyncServer`'s own dedicated LISTEN connection, acquired synchronously
 * before anything else runs. Returns the real `PoolClient` so a test can force a fault on it
 * (`.emit("error", ...)`) without any test-only hook in production code.
 */
async function captureListenClient(
  pool: Pool,
  create: () => Promise<SyncServer>,
): Promise<{ syncServer: SyncServer; listenClient: PoolClient }> {
  const originalConnect = pool.connect.bind(pool);
  let resolveClient: (client: PoolClient) => void;
  const clientPromise = new Promise<PoolClient>((resolve) => {
    resolveClient = resolve;
  });
  // `Pool["connect"]` is overloaded (a promise-returning form and a callback-returning-`void`
  // form); TS's `ReturnType`/`Parameters` machinery collapses that to the last overload for typing
  // a mock implementation, which is the `void` one — spying through this narrowed, non-overloaded
  // view of the same `pool` object keeps the mock's own type honest as promise-returning.
  const poolConnect = pool as unknown as { connect: () => Promise<PoolClient> };
  const spy = vi.spyOn(poolConnect, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    resolveClient(client);
    return client;
  });
  let syncServer: SyncServer;
  try {
    syncServer = await create();
  } finally {
    spy.mockRestore();
  }
  return { syncServer, listenClient: await clientPromise };
}

/** Resolves once `client` closes, capturing the close code — never resolves on a dropped/errored connection. */
function waitForClose(client: WebSocket): Promise<number> {
  return new Promise((resolve) => client.once("close", (code) => resolve(code)));
}

/** Waits until `predicate()` becomes true or `timeoutMs` elapses, polling every 10ms. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    pool ??= getTestPool();
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

  it("opens a socket for a valid credential", async () => {
    registerIdentity("t1", { tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-1" });
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
    registerIdentity("t1", { tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-1" });
    registerIdentity("t2", { tenantId: getTenantZeroId(), userId: "user-2", sessionId: "session-2" });

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
    registerIdentity("t1", { tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-a" });
    registerIdentity("t2", { tenantId: getTenantZeroId(), userId: "user-2", sessionId: "session-b" });

    const revoked = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    const surviving = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t2`);
    await Promise.all([waitForOpen(revoked), waitForOpen(surviving)]);

    const revokedClosed = new Promise<number>((resolve) => revoked.once("close", (code) => resolve(code)));

    await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
      type: "session_revoked",
      sessionId: "session-a",
    });

    expect(await revokedClosed).toBe(4401);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(surviving.readyState).toBe(surviving.OPEN);
    surviving.close();
  });

  it("leaves sockets open on a session_revoked NOTIFY for an unrelated session", async () => {
    registerIdentity("t1", { tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-a" });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=t1`);
    await waitForOpen(client);

    await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
      type: "session_revoked",
      sessionId: "some-other-session",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });
});

describe("createSyncServer heartbeat fallback (issue #160)", () => {
  let httpServer: Server | undefined;
  let syncServer: SyncServer | undefined;
  let heartbeatPool: Pool;

  afterEach(async () => {
    // Either may be unassigned when the test body threw before reaching it; an unguarded
    // cleanup would raise a TypeError that masks that original failure.
    const server = httpServer;
    const sync = syncServer;
    httpServer = undefined;
    syncServer = undefined;
    try {
      await sync?.close();
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await heartbeatPool?.end();
  });

  it("closes a socket with 4401 once its session revalidates as inactive", async () => {
    heartbeatPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    syncServer = await createSyncServer(heartbeatPool, {
      authenticate: async () => ({ tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-stale" }),
      revalidateSession: async () => false,
      heartbeatIntervalMs: 20,
    });
    const sync = syncServer;
    const server = createServer();
    httpServer = server;
    server.on("upgrade", (req, socket, head) => sync.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync`);
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    await waitForOpen(client);

    expect(await closed).toBe(4401);
  });
});

describe("createSyncServer realtime fan-out (issue #161)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;

  /**
   * Only the first account is bound to tenant zero (`users.tenant_id` is unique): it is the tenant's
   * user, and the only one a tenant-zero notification may name (`notifications_user_id_tenant_fkey`).
   */
  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const { rowCount } = await pool.query("SELECT 1 FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
    const user = await createUser(pool, {
      email: `sync-${Math.random()}@example.test`,
      passwordHash,
      locale: "en",
      tenantId: rowCount === 0 ? getTenantZeroId() : undefined,
    });
    return user.id;
  }

  async function connect(token: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    identityByToken = new Map();

    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        if (!token) return null;
        return identityByToken.get(token) ?? null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });

    httpServer = createServer();
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

  it("delivers a user-scoped item invalidation only to the acting user's own socket, never a bystander's (issue #161)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });
    const clientA = await connect("a");
    const clientB = await connect("b");

    let bystanderMessage: string | undefined;
    clientB.once("message", (d) => {
      bystanderMessage = messageText(d);
    });
    const receivedA = new Promise<string>((resolve) => clientA.once("message", (d) => resolve(messageText(d))));

    await publishRealtimeMessage(pool, {
      type: "invalidation",
      scope: "item",
      databaseId: "db-1",
      itemId: "item-1",
      op: "update",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userId: userA,
    });

    const expected = {
      type: "invalidate",
      scope: "item",
      databaseId: "db-1",
      itemId: "item-1",
      op: "update",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(JSON.parse(await receivedA)).toEqual(expected);

    // Give clientB's socket a beat to (not) receive anything before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystanderMessage).toBeUndefined();

    clientA.close();
    clientB.close();
  });

  it("delivers an item/schema invalidation with no acting user to every socket of its own tenant only", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const otherTenant = await createTestTenant(pool);
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });
    identityByToken.set("u", { tenantId: otherTenant, userId: await createTestUser(), sessionId: "session-u" });
    const clientA = await connect("a");
    const clientB = await connect("b");
    const clientU = await connect("u");

    const receivedA = new Promise<string>((resolve) => clientA.once("message", (d) => resolve(messageText(d))));
    const receivedB = new Promise<string>((resolve) => clientB.once("message", (d) => resolve(messageText(d))));
    const receivedU: string[] = [];
    clientU.on("message", (d) => receivedU.push(messageText(d)));

    await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
      type: "invalidation",
      scope: "schema",
      databaseId: "db-1",
    });

    const expected = { type: "invalidate", scope: "schema", databaseId: "db-1" };
    expect(JSON.parse(await receivedA)).toEqual(expected);
    expect(JSON.parse(await receivedB)).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedU).toEqual([]);

    clientA.close();
    clientB.close();
    clientU.close();
  });

  it("narrows a tenant's invalidation to one user's sockets when userId is given and never reaches another tenant", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const otherTenant = await createTestTenant(pool);
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });
    // Same user id as A but authenticated in another tenant: userId alone must never select it.
    identityByToken.set("u", { tenantId: otherTenant, userId: userA, sessionId: "session-u" });
    const clientA = await connect("a");
    const clientB = await connect("b");
    const clientU = await connect("u");

    const receivedA = new Promise<string>((resolve) => clientA.once("message", (d) => resolve(messageText(d))));
    const others: string[] = [];
    clientB.on("message", (d) => others.push(messageText(d)));
    clientU.on("message", (d) => others.push(messageText(d)));

    await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
      type: "invalidation",
      scope: "schema",
      databaseId: "db-1",
      userId: userA,
    });

    expect(JSON.parse(await receivedA)).toEqual({ type: "invalidate", scope: "schema", databaseId: "db-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(others).toEqual([]);

    clientA.close();
    clientB.close();
    clientU.close();
  });

  it("closes a session_revoked socket only when the envelope's tenant matches the socket's tenant", async () => {
    const otherTenant = await createTestTenant(pool);
    identityByToken.set("t", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-t" });
    const client = await connect("t");
    const closed = waitForClose(client);

    await notifyEnvelope(pool, "semprec_events", otherTenant, { type: "session_revoked", sessionId: "session-t" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.readyState).toBe(client.OPEN);

    await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
      type: "session_revoked",
      sessionId: "session-t",
    });
    expect(await closed).toBe(4401);
  });

  it("delivers a notification_created only when the envelope names the notification's own tenant", async () => {
    const owner = await createTestUser();
    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: owner,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-tenant",
        transitionInstance: "job-tenant",
      }),
    );
    const otherTenant = await createTestTenant(pool);
    // Row-level security applies only to a runtime role, so the server under test reads through one.
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const tenantServer = await createSyncServer(runtimePool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    const tenantHttp = createServer();
    tenantHttp.on("upgrade", (req, socket, head) => tenantServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => tenantHttp.listen(0, resolve));
    const address = tenantHttp.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    try {
      identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "session-owner" });
      identityByToken.set("foreign", { tenantId: otherTenant, userId: owner, sessionId: "session-foreign" });
      const ownerClient = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync?token=owner`);
      const foreignClient = new WebSocket(`ws://127.0.0.1:${address.port}/api/sync?token=foreign`);
      await Promise.all([waitForOpen(ownerClient), waitForOpen(foreignClient)]);
      const received: string[] = [];
      ownerClient.on("message", (d) => received.push(messageText(d)));
      foreignClient.on("message", (d) => received.push(messageText(d)));

      await notifyEnvelope(pool, "semprec_events", otherTenant, {
        type: "notification_created",
        userId: owner,
        notificationId,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([]);

      await notifyEnvelope(pool, "semprec_events", getTenantZeroId(), {
        type: "notification_created",
        userId: owner,
        notificationId,
      });
      await waitUntil(() => received.length > 0);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0] ?? "{}")).toMatchObject({
        type: "notification",
        notification: { id: notificationId, userId: owner },
      });
      ownerClient.close();
      foreignClient.close();
    } finally {
      await tenantServer.close();
      await new Promise<void>((resolve) => tenantHttp.close(() => resolve()));
      await runtimePool.end();
    }
  });

  it("stamps publishAgentRunDelta envelopes with the publisher's tenant and keeps every chunk under the NOTIFY cap", async () => {
    const tenantId = await createTestTenant(pool);
    const scopedPool = createPool(process.env.TEST_DATABASE_URL ?? "");
    const listener = await pool.connect();
    try {
      await listener.query("LISTEN semprec_agent_stream");
      const payloads: string[] = [];
      listener.on("notification", (m) => {
        if (m.payload) payloads.push(m.payload);
      });
      const runId = randomUUID();
      await runInTenant(tenantId, () => publishAgentRunDelta(scopedPool, runId, { text: "x".repeat(40_000) }));
      await waitUntil(() => payloads.length >= 5);
      for (const payload of payloads) {
        expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8000);
        const envelope = parseAgentStreamEnvelope(JSON.parse(payload));
        expect(envelope?.tenantId).toBe(tenantId);
      }
    } finally {
      listener.release(true);
      await scopedPool.end();
    }
  });

  it("drops an envelope without a usable tenant on either channel and logs exactly one warning per payload without content", async () => {
    identityByToken.set("t", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-t" });
    const client = await connect("t");
    const received: string[] = [];
    client.on("message", (d) => received.push(messageText(d)));
    realtimeWarn.mockClear();

    const inner = { type: "invalidation", scope: "schema", databaseId: "secret-db" };
    const bad: [string, unknown][] = [
      ["semprec_events", { message: inner }],
      ["semprec_events", { tenantId: null, message: inner }],
      ["semprec_events", { tenantId: "not-a-uuid", message: inner }],
      ["semprec_events", inner],
      ["semprec_agent_stream", { message: { type: "agent_run_delta", agentRunId: randomUUID(), delta: "x" } }],
      // A `type` outside the catalog is not echoed into the log line.
      ["semprec_events", { tenantId: getTenantZeroId(), message: { type: "secret-content" } }],
    ];
    for (const [channel, payload] of bad) {
      await pool.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify(payload)]);
    }
    await pool.query("SELECT pg_notify('semprec_events', 'not json')");
    await waitUntil(() => realtimeWarn.mock.calls.length >= bad.length + 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
    expect(realtimeWarn.mock.calls).toEqual([
      [{ channel: "semprec_events", type: "invalidation" }, "realtime_message_without_tenant"],
      [{ channel: "semprec_events", type: "invalidation" }, "realtime_message_without_tenant"],
      [{ channel: "semprec_events", type: "invalidation" }, "realtime_message_without_tenant"],
      [{ channel: "semprec_events", type: "invalidation" }, "realtime_message_without_tenant"],
      [{ channel: "semprec_agent_stream", type: "agent_run_delta" }, "realtime_message_without_tenant"],
      [{ channel: "semprec_events", type: undefined }, "realtime_message_without_tenant"],
      [{ channel: "semprec_events", type: undefined }, "realtime_message_without_tenant"],
    ]);
    client.close();
  });

  it("never replays an invalidation published while a socket was disconnected — reconnecting relies on the client's own bounded active-state refetch to heal, not a server-side replay (issue #161)", async () => {
    const userA = await createTestUser();
    const sentinelUser = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("sentinel", {
      tenantId: getTenantZeroId(),
      userId: sentinelUser,
      sessionId: "session-sentinel",
    });

    // A socket that was open, then dropped, before the invalidation below is published.
    const droppedClient = await connect("a");
    droppedClient.close();
    await new Promise<void>((resolve) => droppedClient.once("close", () => resolve()));

    await publishRealtimeMessage(pool, {
      type: "invalidation",
      scope: "item",
      databaseId: "db-1",
      itemId: "item-1",
      op: "update",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userId: userA,
    });

    // `publishRealtimeMessage` resolves once Postgres has queued the NOTIFY, not once this
    // process's own LISTEN connection has received and dispatched it — without synchronizing on
    // that, the reconnect below races the dispatch above and can win, landing the userA
    // invalidation on a socket that did not exist when it was dispatched. A schema-scope
    // broadcast (no userId) reaches every open socket and NOTIFYs are delivered to a LISTEN
    // connection in the order their transactions committed, so a sentinel socket receiving this
    // one proves the userA invalidation was already dispatched — to zero matching sockets, since
    // `reconnected` below doesn't exist yet.
    const sentinel = await connect("sentinel");
    const sentinelReceived = new Promise<string>((resolve) => sentinel.once("message", (d) => resolve(messageText(d))));
    await publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: "sentinel-db" });
    expect(JSON.parse(await sentinelReceived)).toEqual({
      type: "invalidate",
      scope: "schema",
      databaseId: "sentinel-db",
    });
    sentinel.close();

    // Reconnecting afterwards opens a brand-new socket with no queued/replayed backlog — the
    // invalidation published above must never surface on it. A live socket converges only
    // through its own REST refetch on connect, never by the server buffering missed frames.
    const reconnected = await connect("a");
    let reconnectedMessage: string | undefined;
    reconnected.once("message", (d) => {
      reconnectedMessage = messageText(d);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconnectedMessage).toBeUndefined();

    reconnected.close();
  });

  it("delivers the complete notification row only to its own user's socket (issue #161)", async () => {
    const owner = await createTestUser();
    const bystanderUser = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "session-owner" });
    identityByToken.set("bystander", {
      tenantId: getTenantZeroId(),
      userId: bystanderUser,
      sessionId: "session-bystander",
    });
    const ownerClient = await connect("owner");
    const bystanderClient = await connect("bystander");

    let bystanderMessage: string | undefined;
    bystanderClient.once("message", (d) => {
      bystanderMessage = messageText(d);
    });
    const receivedByOwner = new Promise<string>((resolve) =>
      ownerClient.once("message", (d) => resolve(messageText(d))),
    );

    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: owner,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-1",
        transitionInstance: "job-1",
      }),
    );
    await publishRealtimeMessage(pool, { type: "notification_created", userId: owner, notificationId });

    const message = JSON.parse(await receivedByOwner) as { type: string; notification: { id: string; userId: string } };
    expect(message).toMatchObject({ type: "notification", notification: { id: notificationId, userId: owner } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystanderMessage).toBeUndefined();

    ownerClient.close();
    bystanderClient.close();
  });

  it("drops a notification_created NOTIFY whose userId does not match the fetched row's own owner, rather than delivering cross-user (medium finding on PR #392)", async () => {
    const owner = await createTestUser();
    const impostor = await createTestUser();
    identityByToken.set("impostor", { tenantId: getTenantZeroId(), userId: impostor, sessionId: "session-impostor" });
    const impostorClient = await connect("impostor");

    let impostorMessage: string | undefined;
    impostorClient.once("message", (d) => {
      impostorMessage = messageText(d);
    });

    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: owner,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-3",
        transitionInstance: "job-3",
      }),
    );
    // A malformed/tampered NOTIFY payload naming a real notificationId but a mismatched userId —
    // must never reach the impostor's socket even though the payload claims it's theirs.
    await publishRealtimeMessage(pool, { type: "notification_created", userId: impostor, notificationId });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(impostorMessage).toBeUndefined();

    impostorClient.close();
  });

  it("never replays a notification published while a socket was disconnected — reconnecting relies on the client's own GET /api/notifications/unread fetch to heal, not a server-side replay (issue #161, AC referencing #36)", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "session-owner" });

    const droppedClient = await connect("owner");
    droppedClient.close();
    await new Promise<void>((resolve) => droppedClient.once("close", () => resolve()));

    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: owner,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-4",
        transitionInstance: "job-4",
      }),
    );
    await publishRealtimeMessage(pool, { type: "notification_created", userId: owner, notificationId });

    // `publishRealtimeMessage` resolving only means the NOTIFY was sent — the LISTEN client still
    // has to receive it and `forwardNotification` still has to run its own async row fetch before
    // delivery is attempted. Waiting here lets that pipeline finish while no socket is open at all
    // (a real drop, matching production), instead of racing it against the reconnect below: under
    // load, that race could let this same live-delivery machinery reach the *new* socket by
    // coincidence, which is a timing artifact rather than the replay this test targets.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reconnecting afterwards opens a brand-new socket with no queued/replayed backlog — the
    // notification published above must never surface on it. A reconnecting client converges by
    // calling GET /api/notifications/unread itself, which still returns this row since it's
    // unread, never by the server buffering and replaying the missed WS frame.
    const reconnected = await connect("owner");
    let reconnectedMessage: string | undefined;
    reconnected.once("message", (d) => {
      reconnectedMessage = messageText(d);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconnectedMessage).toBeUndefined();

    const unread = await pool.query("SELECT id FROM notifications WHERE id = $1 AND read_at IS NULL", [notificationId]);
    expect(unread.rows).toHaveLength(1);

    reconnected.close();
  });

  it("re-fetches and delivers the current row to the owning user on a notification_read_state NOTIFY", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "session-owner" });
    const ownerClient = await connect("owner");

    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: owner,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-2",
        transitionInstance: "job-2",
      }),
    );
    await pool.query("UPDATE notifications SET read_at = now() WHERE id = $1", [notificationId]);

    const received = new Promise<string>((resolve) => ownerClient.once("message", (d) => resolve(messageText(d))));
    await publishRealtimeMessage(pool, {
      type: "notification_read_state",
      userId: owner,
      notificationIds: [notificationId],
    });

    const message = JSON.parse(await received) as { type: string; notification: { id: string; readAt: string | null } };
    expect(message.type).toBe("notification");
    expect(message.notification.id).toBe(notificationId);
    expect(message.notification.readAt).not.toBeNull();

    ownerClient.close();
  });
});

describe("createSyncServer doc sync (issue #162)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let chokePoint: ChokePoint;
  let docStore: DocStore;

  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `docsync-${Math.random()}@example.test`, passwordHash, locale: "en" });
    return user.id;
  }

  async function connect(token: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  async function createTestDoc(): Promise<string> {
    const db = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
    const doc = await docStore.getDoc(item.id);
    return doc!.id;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    identityByToken = new Map();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    // A real accepted update's fan-out rides the same doc_update NOTIFY the write path fires
    // in production — wire it here too, rather than simulating the NOTIFY directly, so these
    // tests exercise the actual write-then-notify path docSync depends on.
    wireRealtimeHooks(pool);

    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        if (!token) return null;
        return identityByToken.get(token) ?? null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    httpServer = createServer();
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

  it("delivers an accepted update to another subscribed socket but never to one that never opened the doc", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });
    identityByToken.set("c", { tenantId: getTenantZeroId(), userId: userC, sessionId: "session-c" });

    const docId = await createTestDoc();
    const wsA = await connect("a");
    const wsB = await connect("b");
    const wsC = await connect("c"); // never opens the doc

    const clientA = new TestDocClient(wsA, docId);
    const clientB = new TestDocClient(wsB, docId);
    clientA.open();
    clientB.open();
    await waitUntil(() => clientA.received.length > 0 && clientB.received.length > 0);

    clientA.mutate((doc) => doc.getText("body").insert(0, "hello from A"));

    await waitUntil(() => clientB.ydoc.getText("body").toJSON() === "hello from A");
    expect(clientB.ydoc.getText("body").toJSON()).toBe("hello from A");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wsC.readyState).toBe(wsC.OPEN);
    // wsC never sent doc:open, so it never registered a listener for this doc's frames at all —
    // asserting on its raw message count directly confirms the server never targeted it.
    let sawAnyMessage = false;
    wsC.once("message", () => (sawAnyMessage = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sawAnyMessage).toBe(false);

    wsA.close();
    wsB.close();
    wsC.close();
  });

  it("converges two subscribed clients after concurrent updates from both, including a duplicate resend", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });

    const docId = await createTestDoc();
    const wsA = await connect("a");
    const wsB = await connect("b");
    const clientA = new TestDocClient(wsA, docId);
    const clientB = new TestDocClient(wsB, docId);
    clientA.open();
    clientB.open();
    await waitUntil(() => clientA.received.length > 0 && clientB.received.length > 0);

    clientA.mutate((doc) => doc.getText("body").insert(0, "AAA"));
    clientB.mutate((doc) => doc.getText("body").insert(doc.getText("body").length, "BBB"));
    // A duplicate resend of an already-applied update must not corrupt convergence.
    clientA.mutate((doc) => doc.getText("body").insert(0, ""));

    await waitUntil(
      () =>
        clientA.ydoc.getText("body").toJSON().includes("AAA") && clientA.ydoc.getText("body").toJSON().includes("BBB"),
    );
    await waitUntil(
      () =>
        clientB.ydoc.getText("body").toJSON().includes("AAA") && clientB.ydoc.getText("body").toJSON().includes("BBB"),
    );
    expect(clientA.ydoc.getText("body").toJSON()).toBe(clientB.ydoc.getText("body").toJSON());

    wsA.close();
    wsB.close();
  });

  it("reconnecting after offline edits exchanges only the missed Yjs diff and both sides converge", async () => {
    const userA = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    const docId = await createTestDoc();

    // First connection makes an edit while "online", then disconnects (goes offline).
    const wsFirst = await connect("a");
    const clientFirst = new TestDocClient(wsFirst, docId);
    clientFirst.open();
    await waitUntil(() => clientFirst.received.length > 0);
    clientFirst.mutate((doc) => doc.getText("body").insert(0, "edit while connected"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    wsFirst.close();
    await new Promise<void>((resolve) => wsFirst.once("close", () => resolve()));

    // A second, fresh client (simulating the same user's reconnect after time offline) opens
    // the same doc with no prior state at all — it must recover everything from the server.
    const wsReconnected = await connect("a");
    const reconnectedClient = new TestDocClient(wsReconnected, docId);
    reconnectedClient.open();

    await waitUntil(() => reconnectedClient.ydoc.getText("body").toJSON() === "edit while connected");
    expect(reconnectedClient.ydoc.getText("body").toJSON()).toBe("edit while connected");

    wsReconnected.close();
  });

  it("persists an accepted update durably, attributed to the authenticated user, before a peer observes it", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: userB, sessionId: "session-b" });
    const docId = await createTestDoc();

    const wsA = await connect("a");
    const wsB = await connect("b");
    const clientA = new TestDocClient(wsA, docId);
    const clientB = new TestDocClient(wsB, docId);
    clientA.open();
    clientB.open();
    await waitUntil(() => clientA.received.length > 0 && clientB.received.length > 0);

    clientA.mutate((doc) => doc.getText("body").insert(0, "durable content"));

    await waitUntil(() => clientB.ydoc.getText("body").toJSON() === "durable content");

    const { rows } = await pool.query<{ created_by: string }>(
      `SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docId],
    );
    expect(rows[0]!.created_by).toBe("user");

    wsA.close();
    wsB.close();
  });
});

describe("createSyncServer doc sync tenancy (issue #1026)", () => {
  let runtimePool: Pool;
  let tenantServer: SyncServer;
  let tenantHttp: Server;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    identityByToken = new Map();
    // Row-level security applies only to a runtime role, so the server under test reads and writes
    // through one. The pool is also fresh, so the server's LISTEN connection is a new one opened inside
    // `connectListenClient`'s system scope rather than a pooled connection an earlier test opened inside
    // a tenant scope: `connectListenClient` takes any idle pooled connection, and one carrying a tenant
    // scope throws `TenantScopeConflictError` on a foreign-tenant envelope.
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    tenantServer = await createSyncServer(runtimePool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    tenantHttp = createServer();
    tenantHttp.on("upgrade", (req, socket, head) => tenantServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => tenantHttp.listen(0, resolve));
    const address = tenantHttp.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    await tenantServer.close();
    await new Promise<void>((resolve) => tenantHttp.close(() => resolve()));
    await runtimePool.end();
  });

  async function createDocIn(tenantId: string): Promise<string> {
    return runInTenant(tenantId, async () => {
      const db = await createChokePoint(runtimePool).createDatabase({ name: "Pages" });
      const item = await createChokePoint(runtimePool).createItem({ databaseId: db.id, properties: {} });
      const store = createDocStore(runtimePool);
      await store.putBlock(item.id, { id: "root", flavour: "page" }, "user");
      const doc = await store.getDoc(item.id);
      return doc!.id;
    });
  }

  async function connectAs(token: string, tenantId: string): Promise<WebSocket> {
    // Doc sync never reads the user, only the socket's tenant, so the identity needs no users row.
    identityByToken.set(token, { tenantId, userId: randomUUID(), sessionId: `session-${token}` });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  async function updateRowsOf(docId: string): Promise<{ tenant_id: string }[]> {
    // The superuser pool sees every tenant's rows, so a write in either tenant is counted.
    const { rows } = await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM doc_updates WHERE doc_id = $1`, [
      docId,
    ]);
    return rows;
  }

  it("answers a doc:open for another tenant's doc with nothing and persists no update frame sent right behind it", async () => {
    const docA = await createDocIn(tenantA);
    const rowsBefore = await updateRowsOf(docA);
    const wsB = await connectAs("b", tenantB);
    try {
      const clientB = new TestDocClient(wsB, docA);
      // Sent back to back, so the update frame arrives while the server's tenant-scoped lookup is pending.
      clientB.open();
      clientB.mutate((doc) => doc.getText("body").insert(0, "intrusion"));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(clientB.received).toHaveLength(0);
      expect(await updateRowsOf(docA)).toEqual(rowsBefore);
    } finally {
      wsB.close();
    }
  });

  it("opens and persists an update for a socket's own-tenant doc under that tenant", async () => {
    const docA = await createDocIn(tenantA);
    const rowsBefore = await updateRowsOf(docA);
    const wsA = await connectAs("a", tenantA);
    try {
      const clientA = new TestDocClient(wsA, docA);
      clientA.open();
      await waitUntil(() => clientA.received.length > 0);
      clientA.mutate((doc) => doc.getText("body").insert(0, "own tenant"));
      let rows = await updateRowsOf(docA);
      const deadline = Date.now() + 2000;
      while (rows.length === rowsBefore.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rows = await updateRowsOf(docA);
      }

      expect(rows).toHaveLength(rowsBefore.length + 1);
      expect(rows.every((row) => row.tenant_id === tenantA)).toBe(true);
    } finally {
      wsA.close();
    }
  });

  it("delivers a doc_update envelope only to sockets of the envelope's tenant, whatever doc it names", async () => {
    const docA = await createDocIn(tenantA);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docA],
    );
    const updateId = rows[0]!.id;
    const wsA = await connectAs("a", tenantA);
    try {
      const clientA = new TestDocClient(wsA, docA);
      clientA.open();
      await waitUntil(() => clientA.received.length > 0);
      // Let the open handshake (the client's SyncStep1/2 replies) settle so only fan-out frames remain.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const receivedBefore = clientA.received.length;

      await notifyEnvelope(pool, "semprec_events", tenantB, {
        type: "doc_update",
        docId: docA,
        updateId,
        createdBy: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(clientA.received).toHaveLength(receivedBefore);

      await notifyEnvelope(pool, "semprec_events", tenantA, {
        type: "doc_update",
        docId: docA,
        updateId,
        createdBy: "user",
      });
      await waitUntil(() => clientA.received.length > receivedBefore);
    } finally {
      wsA.close();
    }
  });
});

describe("createSyncServer closeTenant (issue #1042)", () => {
  let runtimePool: Pool;
  let tenantServer: SyncServer;
  let tenantHttp: Server;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let tenantA: string;
  let tenantB: string;
  /** When set, every upgrade's authentication waits on it before resolving its identity. */
  let authGate: Promise<void> | null;
  let authStarted: number;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    identityByToken = new Map();
    authGate = null;
    authStarted = 0;
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    tenantServer = await createSyncServer(runtimePool, {
      authenticate: async (req: IncomingMessage) => {
        authStarted++;
        await authGate;
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    tenantHttp = createServer();
    tenantHttp.on("upgrade", (req, socket, head) => tenantServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => tenantHttp.listen(0, resolve));
    const address = tenantHttp.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    await tenantServer.close();
    await new Promise<void>((resolve) => tenantHttp.close(() => resolve()));
    await runtimePool.end();
  });

  async function connectAs(token: string, tenantId: string): Promise<WebSocket> {
    identityByToken.set(token, { tenantId, userId: randomUUID(), sessionId: randomUUID() });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  function closeEvent(client: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      client.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
    });
  }

  it("closes every socket of the tenant with 4401 'account deactivated' and leaves the other tenant's open", async () => {
    const wsA1 = await connectAs("a1", tenantA);
    const wsA2 = await connectAs("a2", tenantA);
    const wsB1 = await connectAs("b1", tenantB);
    const wsB2 = await connectAs("b2", tenantB);
    try {
      const closedB1 = closeEvent(wsB1);
      const closedB2 = closeEvent(wsB2);
      let aClosed = false;
      wsA1.once("close", () => (aClosed = true));
      wsA2.once("close", () => (aClosed = true));

      tenantServer.closeTenant(tenantB);

      expect(await closedB1).toEqual({ code: 4401, reason: "account deactivated" });
      expect(await closedB2).toEqual({ code: 4401, reason: "account deactivated" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(aClosed).toBe(false);
      expect(wsA1.readyState).toBe(WebSocket.OPEN);
      expect(wsA2.readyState).toBe(WebSocket.OPEN);
    } finally {
      wsA1.close();
      wsA2.close();
    }
  });

  it("closes an upgrade of the tenant that was authenticating when it ran, and not the other tenant's", async () => {
    let releaseAuth: () => void = () => {};
    authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    identityByToken.set("b-late", { tenantId: tenantB, userId: randomUUID(), sessionId: randomUUID() });
    identityByToken.set("a-late", { tenantId: tenantA, userId: randomUUID(), sessionId: randomUUID() });
    const lateB = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=b-late`);
    const lateA = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=a-late`);
    try {
      const closedB = closeEvent(lateB);
      const openedA = waitForOpen(lateA);
      await vi.waitFor(() => expect(authStarted).toBe(2));

      tenantServer.closeTenant(tenantB);
      releaseAuth();

      expect(await closedB).toEqual({ code: 4401, reason: "account deactivated" });
      await openedA;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lateA.readyState).toBe(WebSocket.OPEN);
    } finally {
      lateA.close();
    }
  });

  it("does nothing on a second call for the same tenant", async () => {
    const wsA = await connectAs("a", tenantA);
    const wsB = await connectAs("b", tenantB);
    try {
      const closedB = closeEvent(wsB);
      tenantServer.closeTenant(tenantB);
      expect((await closedB).code).toBe(4401);

      tenantServer.closeTenant(tenantB);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(wsA.readyState).toBe(WebSocket.OPEN);
    } finally {
      wsA.close();
    }
  });
});

describe("createSyncServer agent run watch tenancy (issue #1027)", () => {
  let tenantServer: SyncServer;
  let tenantHttp: Server;
  let runtimePool: Pool;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    // Bound to tenant zero, so this user is the tenant's user: heartbeat runs fall back to it.
    userA = (
      await createUser(pool, {
        email: `agent-tenancy-${Math.random()}@example.test`,
        passwordHash: await hashPassword("s3cret-password"),
        locale: "en",
        tenantId: tenantA,
      })
    ).id;
    identityByToken = new Map();
    // Row-level security applies only to a runtime role, so the server reads through one, on a fresh
    // pool so its LISTEN connection is opened outside any tenant scope.
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    tenantServer = await createSyncServer(runtimePool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    tenantHttp = createServer();
    tenantHttp.on("upgrade", (req, socket, head) => tenantServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => tenantHttp.listen(0, resolve));
    const address = tenantHttp.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    await tenantServer.close();
    await new Promise<void>((resolve) => tenantHttp.close(() => resolve()));
    await runtimePool.end();
  });

  async function connectAs(token: string, tenantId: string, userId: string): Promise<WebSocket> {
    identityByToken.set(token, { tenantId, userId, sessionId: `session-${token}` });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** Collects every frame the client receives, in arrival order; a frame that is not a JSON object fails the test. */
  function collectFrames(client: WebSocket): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    client.on("message", (data) => {
      const frame: unknown = JSON.parse(messageText(data));
      if (!isRecord(frame)) throw new Error("expected a JSON object frame");
      frames.push(frame);
    });
    return frames;
  }

  /** The event id an `agent:event` frame carries; any other shape fails the test. */
  function eventIdOf(frame: Record<string, unknown> | undefined): string {
    const event = frame?.event;
    if (!isRecord(event) || typeof event.id !== "string")
      throw new Error("expected an agent:event frame with an event id");
    return event.id;
  }

  function settle(ms = 150): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Creates a run in `tenantId`, through the runtime role, as a user-triggered run by `actorUserId`. */
  function createRunIn(tenantId: string, actorUserId: string): Promise<{ id: string }> {
    return runInTenant(tenantId, () =>
      createAgentRun(runtimePool, { triggeredBy: "user", task: "tenancy run", userId: actorUserId }),
    );
  }

  /** Appends a durable event in `tenantId` without a NOTIFY, so a test controls exactly what is announced. */
  function silentEventIn(tenantId: string, runId: string): Promise<{ id: string }> {
    return runInTenant(tenantId, () => insertAgentRunEvent(runtimePool, runId, "turn_start", { kind: "turn_start" }));
  }

  /** Appends a durable event in `tenantId` and announces it through the real publisher. */
  async function announcedEventIn(tenantId: string, runId: string): Promise<{ id: string }> {
    return runInTenant(tenantId, async () => {
      const event = await insertAgentRunEvent(runtimePool, runId, "message", { kind: "message", text: "live" });
      await publishRealtimeMessage(runtimePool, { type: "agent_run_event", agentRunId: runId, eventId: event.id });
      return event;
    });
  }

  it("delivers nothing to a socket of another tenant watching a run, as for an unknown run id", async () => {
    const run = await createRunIn(tenantA, userA);
    await silentEventIn(tenantA, run.id);

    // The other tenant's socket claims the very same user id: only the tenant boundary can refuse it.
    const foreign = await connectAs("foreign", tenantB, userA);
    const foreignFrames = collectFrames(foreign);
    foreign.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    const unknown = await connectAs("unknown", tenantB, userA);
    const unknownFrames = collectFrames(unknown);
    unknown.send(JSON.stringify({ type: "agent:watch", runId: randomUUID(), afterEventId: "0" }));
    await settle();
    expect(foreignFrames).toEqual(unknownFrames);
    expect(foreignFrames).toHaveLength(0);

    // A live durable event and a live delta in tenant A are not delivered to the foreign socket. The run's
    // own user's socket is the positive control: once it has its replay, the live event and the delta,
    // the same fan-out has already passed over the foreign socket.
    const own = await connectAs("own", tenantA, userA);
    const ownFrames = collectFrames(own);
    own.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await waitUntil(() => ownFrames.length === 1);
    await announcedEventIn(tenantA, run.id);
    await waitUntil(() => ownFrames.length === 2);
    await runInTenant(tenantA, () => publishAgentRunDelta(runtimePool, run.id, { kind: "message_update", text: "x" }));
    await waitUntil(() => ownFrames.length === 3);
    expect(ownFrames.map((frame) => frame.type)).toEqual(["agent:event", "agent:event", "agent:delta"]);
    expect(foreignFrames).toHaveLength(0);
    foreign.close();
    unknown.close();
    own.close();
  });

  it("delivers replay, then live events and deltas in order to the tenant's own user's socket", async () => {
    const user = await connectAs("own", tenantA, userA);
    const run = await createRunIn(tenantA, userA);
    const first = await silentEventIn(tenantA, run.id);

    const frames = collectFrames(user);
    user.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await waitUntil(() => frames.length === 1);

    const live = await announcedEventIn(tenantA, run.id);
    await waitUntil(() => frames.length === 2);
    await runInTenant(tenantA, () => publishAgentRunDelta(runtimePool, run.id, { kind: "message_update", text: "d" }));
    await waitUntil(() => frames.length === 3);

    expect(frames.map((frame) => frame.type)).toEqual(["agent:event", "agent:event", "agent:delta"]);
    expect(eventIdOf(frames[0])).toBe(first.id);
    expect(eventIdOf(frames[1])).toBe(live.id);
    user.close();
  });

  it("delivers a heartbeat-triggered run to the tenant's user", async () => {
    const user = await connectAs("own", tenantA, userA);
    const run = await runInTenant(tenantA, () => createAgentRun(runtimePool, { triggeredBy: "heartbeat", task: "hb" }));
    await silentEventIn(tenantA, run.id);

    const frames = collectFrames(user);
    user.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await waitUntil(() => frames.length === 1);
    expect(frames[0]!.type).toBe("agent:event");
    user.close();
  });

  it("drops a durable reference stamped with another tenant for a live watcher even when its event id is real for the watched run", async () => {
    const user = await connectAs("own", tenantA, userA);
    const run = await createRunIn(tenantA, userA);
    const frames = collectFrames(user);
    user.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await settle();

    // A real row of the watched run, announced under the wrong tenant (a forged NOTIFY).
    const forged = await silentEventIn(tenantA, run.id);
    await notifyEnvelope(pool, "semprec_events", tenantB, {
      type: "agent_run_event",
      agentRunId: run.id,
      eventId: forged.id,
    });
    await settle();
    expect(frames).toHaveLength(0);

    // The same reference stamped with the run's own tenant is delivered, proving the watch is live.
    await notifyEnvelope(pool, "semprec_events", tenantA, {
      type: "agent_run_event",
      agentRunId: run.id,
      eventId: forged.id,
    });
    await waitUntil(() => frames.length === 1);
    expect(eventIdOf(frames[0])).toBe(forged.id);
    user.close();
  });

  it("never queues a durable reference stamped with another tenant while the watcher is still replaying", async () => {
    const user = await connectAs("own", tenantA, userA);
    const run = await createRunIn(tenantA, userA);
    const replayed = await silentEventIn(tenantA, run.id);
    const sentinelRun = await createRunIn(tenantA, userA);
    const sentinel = await connectAs("sentinel", tenantA, userA);
    const sentinelFrames = collectFrames(sentinel);
    sentinel.send(JSON.stringify({ type: "agent:watch", runId: sentinelRun.id, afterEventId: "0" }));
    await settle();

    // Hold the watcher in its replay window: the replay query runs, then its result is held until
    // released, so a NOTIFY arriving meanwhile can only be queued for the drain.
    let replayQueried: (() => void) | undefined;
    const replayQueriedSignal = new Promise<void>((resolve) => {
      replayQueried = resolve;
    });
    let releaseReplay: (() => void) | undefined;
    const replayReleased = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const originalQuery = runtimePool.query.bind(runtimePool) as (...args: unknown[]) => Promise<unknown>;
    let held = false;
    const heldReplayQuery = async (...args: unknown[]): Promise<unknown> => {
      const sql = args[0];
      const result = await originalQuery(...args);
      if (!held && typeof sql === "string" && sql.includes("FROM agent_run_events") && sql.includes("id > $2")) {
        held = true;
        replayQueried?.();
        await replayReleased;
      }
      return result;
    };
    // pg's overloaded `query` type includes a callback form returning void; every caller here awaits it.
    const heldQueryImplementation = heldReplayQuery as unknown as () => void;
    const query = vi.spyOn(runtimePool, "query").mockImplementation(heldQueryImplementation);
    try {
      const frames = collectFrames(user);
      user.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await replayQueriedSignal;

      // A real row of the watched run, committed after the replay snapshot and announced only under the
      // wrong tenant. If it were queued, the drain would fetch it under the watcher's own tenant and send it.
      const forged = await silentEventIn(tenantA, run.id);
      await notifyEnvelope(pool, "semprec_events", tenantB, {
        type: "agent_run_event",
        agentRunId: run.id,
        eventId: forged.id,
      });
      // NOTIFYs arrive in commit order, so once a later reference for another run is delivered, the
      // forged one has already been offered to the replaying watcher.
      await announcedEventIn(tenantA, sentinelRun.id);
      await waitUntil(() => sentinelFrames.length === 1);
      releaseReplay?.();

      // With nothing queued, the watcher is promoted right after delivering its replay; a delta it then
      // receives shows the replay window closed without sending anything else.
      await waitUntil(() => frames.length > 0);
      await runInTenant(tenantA, () =>
        publishAgentRunDelta(runtimePool, run.id, { kind: "message_update", text: "d" }),
      );
      await waitUntil(() => frames.some((frame) => frame.type === "agent:delta"));
      expect(frames.map((frame) => frame.type)).toEqual(["agent:event", "agent:delta"]);
      expect(eventIdOf(frames[0])).toBe(replayed.id);
    } finally {
      releaseReplay?.();
      query.mockRestore();
      user.close();
      sentinel.close();
    }
  });

  it("drops a delta stamped with another tenant, while the run's own tenant's delta is delivered", async () => {
    const user = await connectAs("own", tenantA, userA);
    const run = await createRunIn(tenantA, userA);
    const frames = collectFrames(user);
    user.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await settle();

    await notifyEnvelope(pool, AGENT_STREAM_CHANNEL, tenantB, {
      type: "agent_run_delta",
      agentRunId: run.id,
      delta: "forged",
    });
    await settle();
    expect(frames).toHaveLength(0);

    await notifyEnvelope(pool, AGENT_STREAM_CHANNEL, tenantA, {
      type: "agent_run_delta",
      agentRunId: run.id,
      delta: "genuine",
    });
    await waitUntil(() => frames.length === 1);
    expect(frames[0]!.delta).toBe("genuine");
    user.close();
  });
});

describe("createSyncServer watched agent runs (issue #163)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;

  /** Only the first account is bound to tenant zero (`users.tenant_id` is unique): it is the tenant's user. */
  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const { rowCount } = await pool.query<{ bound: number }>("SELECT 1 AS bound FROM users WHERE tenant_id = $1", [
      getTenantZeroId(),
    ]);
    const user = await createUser(pool, {
      email: `agent-watch-${Math.random()}@example.test`,
      passwordHash,
      locale: "en",
      tenantId: rowCount === 0 ? getTenantZeroId() : undefined,
    });
    return user.id;
  }

  async function connect(token: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    await waitForOpen(client);
    return client;
  }

  function nextFrame(client: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) =>
      client.once("message", (data) => resolve(JSON.parse(messageText(data)) as Record<string, unknown>)),
    );
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    identityByToken = new Map();
    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    httpServer = createServer();
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

  it("replays cursor events in id order, then delivers a later thin-reference event without a handoff gap", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "watch me" });
    const first = await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const second = await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "replayed" });

    const client = await connect("owner");
    const replayed: Record<string, unknown>[] = [];
    let resolveReplay: (() => void) | undefined;
    const replayComplete = new Promise<void>((resolve) => {
      resolveReplay = resolve;
    });
    const collectReplay = (data: RawData) => {
      replayed.push(JSON.parse(messageText(data)) as Record<string, unknown>);
      if (replayed.length === 2) resolveReplay?.();
    };
    client.on("message", collectReplay);
    client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await replayComplete;
    client.off("message", collectReplay);
    expect(replayed.map((frame) => (frame.event as { id: string }).id)).toEqual([first.id, second.id]);

    const live = await insertAgentRunEvent(pool, run.id, "turn_end", { kind: "turn_end" });
    const receivedLive = nextFrame(client);
    await publishRealtimeMessage(pool, { type: "agent_run_event", agentRunId: run.id, eventId: live.id });
    const frame = await receivedLive;
    expect(frame.type).toBe("agent:event");
    expect((frame.event as { id: string; kind: string }).id).toBe(live.id);
    expect((frame.event as { id: string; kind: string }).kind).toBe("turn_end");
    client.close();
  });

  it("never sends durable events or ephemeral deltas to an unwatched or unauthorized socket", async () => {
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    identityByToken.set("other", { tenantId: getTenantZeroId(), userId: otherUser, sessionId: "other-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "private run" });
    const ownerClient = await connect("owner");
    const otherClient = await connect("other");
    ownerClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    otherClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));

    let otherReceived = false;
    otherClient.once("message", () => (otherReceived = true));
    const event = await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "complete" });
    const ownerEvent = nextFrame(ownerClient);
    await publishRealtimeMessage(pool, { type: "agent_run_event", agentRunId: run.id, eventId: event.id });
    expect((await ownerEvent).type).toBe("agent:event");

    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "typing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherReceived).toBe(false);

    ownerClient.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    let ownerReceivedAfterUnwatch = false;
    ownerClient.once("message", () => (ownerReceivedAfterUnwatch = true));
    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "not delivered" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ownerReceivedAfterUnwatch).toBe(false);
    ownerClient.close();
    otherClient.close();
  });

  it("cancels a watch when agent:unwatch arrives while its authorization query is pending", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "cancel pending watch", userId: owner });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    const received: Record<string, unknown>[] = [];
    client.on("message", (data) => received.push(JSON.parse(messageText(data)) as Record<string, unknown>));

    await withTransaction(pool, async (locker) => {
      // `watch()` now authorizes with a plain (non-locking) SELECT against `agent_runs`, which a
      // row-level `FOR UPDATE` from this transaction would not block. An `ACCESS EXCLUSIVE` table
      // lock does conflict with it, so it holds that SELECT pending while the second frame
      // arrives, then commits to let the older watch prove it cannot overtake the unwatch.
      await locker.query("LOCK TABLE agent_runs IN ACCESS EXCLUSIVE MODE");
      client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      client.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    client.close();
  });

  // Issue #1066: agent_runs_actor_user_id_tenant_fkey confines actor_user_id to the run's own tenant,
  // whose only user is the tenant's user, so an actor distinct from the tenant's user cannot exist.
  it("authorizes agent:watch against the run's explicit actor_user_id and refuses another account", async () => {
    const actorUser = await createTestUser();
    const otherUser = await createTestUser();
    identityByToken.set("other", { tenantId: getTenantZeroId(), userId: otherUser, sessionId: "other-session" });
    identityByToken.set("actor", { tenantId: getTenantZeroId(), userId: actorUser, sessionId: "actor-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "actor-owned run", userId: actorUser });
    expect(run.actorUserId).toBe(actorUser);
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });

    const actorClient = await connect("actor");
    actorClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(actorClient)).type).toBe("agent:event");
    actorClient.close();

    const otherClient = await connect("other");
    let otherReceived = false;
    otherClient.once("message", () => (otherReceived = true));
    otherClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherReceived).toBe(false);
    otherClient.close();
  });

  it("authorizes agent:watch on a heartbeat-triggered run against the tenant's user it falls back to", async () => {
    const tenantUser = await createTestUser();
    const otherUser = await createTestUser();
    identityByToken.set("tenant-user", {
      tenantId: getTenantZeroId(),
      userId: tenantUser,
      sessionId: "tenant-user-session",
    });
    identityByToken.set("other", { tenantId: getTenantZeroId(), userId: otherUser, sessionId: "other-session" });
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "heartbeat run" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });

    const otherClient = await connect("other");
    let otherReceived = false;
    otherClient.once("message", () => (otherReceived = true));
    otherClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherReceived).toBe(false);
    otherClient.close();

    const tenantUserClient = await connect("tenant-user");
    tenantUserClient.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(tenantUserClient)).type).toBe("agent:event");
    tenantUserClient.close();
  });

  it("keeps the existing watcher live when a replacement watch cannot be authorized", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "retain watch after transient failure" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(client)).type).toBe("agent:event");

    const query = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("transient authorization failure"));
    try {
      client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const delta = nextFrame(client);
      await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "still watching" });
      expect((await delta).type).toBe("agent:delta");
    } finally {
      query.mockRestore();
      client.close();
    }
  });

  it("keeps the existing watcher live when a replacement replay fails", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "retain watch after replay failure" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(client)).type).toBe("agent:event");

    const originalQuery = pool.query.bind(pool);
    // The first call is the replacement's authorization read. The test only needs to reject the
    // subsequent replay query, while preserving that real query result at runtime.
    const passThroughQuery = originalQuery as unknown as () => void;
    const query = vi
      .spyOn(pool, "query")
      .mockImplementationOnce(passThroughQuery)
      .mockRejectedValueOnce(new Error("transient replay failure"));
    try {
      client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const delta = nextFrame(client);
      await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "still watching" });
      expect((await delta).type).toBe("agent:delta");
    } finally {
      query.mockRestore();
      client.close();
    }
  });

  it("chunks an oversized ephemeral delta below Postgres's NOTIFY payload limit", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { tenantId: getTenantZeroId(), userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "large delta" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(client)).type).toBe("agent:event");

    const frames: Record<string, unknown>[] = [];
    client.on("message", (data) => frames.push(JSON.parse(messageText(data)) as Record<string, unknown>));
    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "x".repeat(12_000) });
    const deadline = Date.now() + 5_000;
    while (frames.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.type === "agent:delta")).toBe(true);
    expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") < 7_500)).toBe(true);
    expect(frames.every((frame) => typeof frame.chunk === "object")).toBe(true);
    client.close();
  });
});

describe("createSyncServer server-side limits, LISTEN outage and backpressure (issue #242)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;

  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `limits-${Math.random()}@example.test`, passwordHash, locale: "en" });
    return user.id;
  }

  async function connect(token: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`, { maxPayload: 0 });
    await waitForOpen(client);
    return client;
  }

  async function bindHttpServer(): Promise<void> {
    httpServer = createServer();
    httpServer.on("upgrade", (req, socket, head) => syncServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    identityByToken = new Map();
  });

  afterEach(async () => {
    // A test that already exercised a controlled shutdown has closed this itself; closing again
    // must not fail the test (`wss.close()` rejects the second time since it's already closed).
    await syncServer?.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
  });

  it("closes every connected socket with 1012 when the dedicated LISTEN connection errors, and serves a fresh connection again once it reconnects", async () => {
    const { syncServer: server, listenClient } = await captureListenClient(pool, () =>
      createSyncServer(pool, {
        authenticate: async (req: IncomingMessage) => {
          const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
          return token ? (identityByToken.get(token) ?? null) : null;
        },
        revalidateSession: async () => true,
        heartbeatIntervalMs: 30_000,
      }),
    );
    syncServer = server;
    await bindHttpServer();

    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-a" });
    identityByToken.set("b", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-b" });
    const clientA = await connect("a");
    const clientB = await connect("b");
    const closedA = waitForClose(clientA);
    const closedB = waitForClose(clientB);

    // `onError` starts the reconnect loop synchronously, and the loop's first step is
    // `pool.connect()`. Holding that one call until `releaseReconnect()` keeps the server in the
    // outage gap for exactly as long as this test needs: without it, whether the next socket
    // connects before or after the reconnect completes is a race, and a socket that wins it is
    // (correctly) closed with 1012 by the reconnect.
    const originalConnect = pool.connect.bind(pool);
    let releaseReconnect!: () => void;
    const reconnectReleased = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const poolConnect = pool as unknown as { connect: () => Promise<PoolClient> };
    const reconnectSpy = vi.spyOn(poolConnect, "connect").mockImplementationOnce(async () => {
      await reconnectReleased;
      return originalConnect();
    });

    // Simulates the LISTEN connection being lost (network blip, Postgres restart) without any
    // test-only hook in production code — `onError` is the real handler `syncServer.ts` wires.
    try {
      listenClient.emit("error", new Error("simulated LISTEN connection loss"));
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }

    expect(await closedA).toBe(1012);
    expect(await closedB).toBe(1012);

    // A socket that connects during the gap may already have missed a NOTIFY, so the reconnect
    // closes it with 1012 as well. That close happens in the same step that installs the new
    // LISTEN connection, which makes it this test's signal that the reconnect has completed.
    const gapClient = await connect("a");
    const closedGap = waitForClose(gapClient);
    releaseReconnect();
    expect(await closedGap).toBe(1012);

    // A client connecting after the reconnect is served exactly like one that connected before
    // the outage: it stays open and receives fan-out through the restored LISTEN connection.
    const clientC = await connect("a");
    const receivedC = new Promise<string>((resolve) => clientC.once("message", (d) => resolve(messageText(d))));
    await publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: "db-1" });
    expect(JSON.parse(await receivedC)).toEqual({ type: "invalidate", scope: "schema", databaseId: "db-1" });
    expect(clientC.readyState).toBe(clientC.OPEN);
    clientC.close();
  });

  it("closes every connected socket with 1012 on a controlled shutdown", async () => {
    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    await bindHttpServer();

    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-a" });
    const client = await connect("a");
    const closed = waitForClose(client);

    await syncServer.close();

    expect(await closed).toBe(1012);
  });

  it("terminates a connection that stops answering pings within a few missed heartbeats", async () => {
    syncServer = await createSyncServer(pool, {
      authenticate: async () => ({ tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-1" }),
      revalidateSession: async () => true,
      heartbeatIntervalMs: 20,
    });
    await bindHttpServer();

    // `autoPong: false` simulates a peer that stops answering the server's RFC 6455 pings — a
    // stalled tab, a dropped network the TCP stack hasn't noticed yet — without needing to wait
    // out the real ~90s window: the heartbeat cadence above is scaled down proportionally.
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync`, { autoPong: false });
    const closed = waitForClose(client);
    await waitForOpen(client);

    await closed;
    expect(client.readyState).not.toBe(client.OPEN);
  });

  it("rejects a frame over the 2MB inbound cap by closing the connection, rather than buffering it", async () => {
    syncServer = await createSyncServer(pool, {
      authenticate: async () => ({ tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-1" }),
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    await bindHttpServer();

    const client = await connect("ignored");
    const closed = waitForClose(client);

    client.send(Buffer.alloc(2_000_001));

    expect(await closed).toBe(1009);
  });

  it("rejects a doc:open beyond the 32-open-documents-per-connection cap, leaving the first 32 subscribed", async () => {
    const chokePoint = createChokePoint(pool);
    const docStore = createDocStore(pool);
    async function createTestDoc(): Promise<string> {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
      const doc = await docStore.getDoc(item.id);
      return doc!.id;
    }

    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    await bindHttpServer();
    identityByToken.set("a", { tenantId: getTenantZeroId(), userId: await createTestUser(), sessionId: "session-a" });
    const client = await connect("a");

    const docIds: string[] = [];
    for (let i = 0; i < 33; i += 1) docIds.push(await createTestDoc());

    const openedDocIds = new Set<string>();
    client.on("message", (data: RawData) => {
      const frame = parseBinaryFrame(messageBuffer(data));
      const docId = frame ? decodeDocId(frame.docId) : null;
      if (docId) openedDocIds.add(docId);
    });

    for (const docId of docIds) client.send(JSON.stringify({ type: "doc:open", docId }));
    await waitUntil(() => openedDocIds.size >= 32, 5_000);
    // Give the (rejected) 33rd doc:open a beat to arrive if the cap were not enforced.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(openedDocIds.size).toBe(32);
    expect(openedDocIds.has(docIds[32]!)).toBe(false);
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });

  it("closes a slow consumer with 1013 once its outgoing buffer stays over the backpressure threshold, without silently dropping any of the frames it never acknowledged", async () => {
    const chokePoint = createChokePoint(pool);
    const docStore = createDocStore(pool);
    // A real accepted update's fan-out rides the same doc_update NOTIFY the write path fires in
    // production — wire it here too, exactly like the doc-sync describe block above, so this
    // exercises the real write-then-notify path rather than a simulated one.
    wireRealtimeHooks(pool);
    const db = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
    const doc = await docStore.getDoc(item.id);
    const docId = doc!.id;

    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    await bindHttpServer();

    identityByToken.set("producer", {
      tenantId: getTenantZeroId(),
      userId: await createTestUser(),
      sessionId: "session-producer",
    });
    identityByToken.set("subscriber", {
      tenantId: getTenantZeroId(),
      userId: await createTestUser(),
      sessionId: "session-subscriber",
    });
    const producerWs = await connect("producer");
    const subscriberWs = await connect("subscriber");
    const producer = new TestDocClient(producerWs, docId);
    const subscriber = new TestDocClient(subscriberWs, docId);
    producer.open();
    subscriber.open();
    await waitUntil(() => producer.received.length > 0 && subscriber.received.length > 0);

    // Stops the subscriber's socket from being read, so every fanned-out update piles up in the
    // *server's* outgoing buffer for that connection instead of draining over the wire — the
    // server's own close frame (once it decides to send one) queues behind that same backlog,
    // which is why the client's own `'close'` event can't fire yet either.
    const subscriberSocket = (subscriberWs as unknown as { _socket: Socket })._socket;
    subscriberSocket.pause();

    // Each update's fan-out rides a real Postgres NOTIFY round-trip, whose latency varies with
    // system load (e.g. a preceding test's writes still settling) — and separately, how much data
    // a paused socket can absorb before the OS-level window fills depends on how far the kernel
    // had already auto-tuned that window, which is not under this test's control either. 30 x
    // ~1MB updates over 3s (comfortably inside the 20s test timeout) makes both margins generous
    // instead of tuned to a guessed minimum.
    for (let i = 0; i < 30; i += 1) {
      producer.mutate((ydoc) => ydoc.getText("body").insert(0, "x".repeat(1_000_000)));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Gives the server a beat to notice `bufferedAmount` over the threshold and queue its 1013
    // close frame behind the backlog above.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const closed = waitForClose(subscriberWs);
    // Resuming now lets the client drain the whole backlog, including the trailing close frame —
    // proving every one of the updates above was actually delivered (never silently dropped) before
    // the connection was closed for falling behind.
    subscriberSocket.resume();

    expect(await closed).toBe(1013);
  }, 20_000);
});
