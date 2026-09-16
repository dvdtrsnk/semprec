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
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { publishAgentRunDelta, publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { createSyncServer, type SyncIdentity, type SyncServer } from "../syncServer.js";
import { buildBinaryFrame, decodeDocId, parseBinaryFrame } from "../protocolV1.js";
import { wireRealtimeHooks } from "../wireHooks.js";

let pool: Pool;

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

describe("createSyncServer realtime fan-out (issue #161)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;

  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `sync-${Math.random()}@example.test`, passwordHash, locale: "en" });
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
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { userId: userB, sessionId: "session-b" });
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

  it("falls back to broadcasting an item/schema invalidation to every connected socket when it carries no acting user (a system/background-triggered write)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { userId: userB, sessionId: "session-b" });
    const clientA = await connect("a");
    const clientB = await connect("b");

    const receivedA = new Promise<string>((resolve) => clientA.once("message", (d) => resolve(messageText(d))));
    const receivedB = new Promise<string>((resolve) => clientB.once("message", (d) => resolve(messageText(d))));

    await publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: "db-1" });

    const expected = { type: "invalidate", scope: "schema", databaseId: "db-1" };
    expect(JSON.parse(await receivedA)).toEqual(expected);
    expect(JSON.parse(await receivedB)).toEqual(expected);

    clientA.close();
    clientB.close();
  });

  it("never replays an invalidation published while a socket was disconnected — reconnecting relies on the client's own bounded active-state refetch to heal, not a server-side replay (issue #161)", async () => {
    const userA = await createTestUser();
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });

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
    identityByToken.set("owner", { userId: owner, sessionId: "session-owner" });
    identityByToken.set("bystander", { userId: bystanderUser, sessionId: "session-bystander" });
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
    identityByToken.set("impostor", { userId: impostor, sessionId: "session-impostor" });
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
    identityByToken.set("owner", { userId: owner, sessionId: "session-owner" });

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
    identityByToken.set("owner", { userId: owner, sessionId: "session-owner" });
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
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { userId: userB, sessionId: "session-b" });
    identityByToken.set("c", { userId: userC, sessionId: "session-c" });

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
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { userId: userB, sessionId: "session-b" });

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
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
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
    identityByToken.set("a", { userId: userA, sessionId: "session-a" });
    identityByToken.set("b", { userId: userB, sessionId: "session-b" });
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

describe("createSyncServer watched agent runs (issue #163)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;

  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, {
      email: `agent-watch-${Math.random()}@example.test`,
      passwordHash,
      locale: "en",
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
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
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
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
    identityByToken.set("other", { userId: otherUser, sessionId: "other-session" });
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
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "cancel pending watch" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    const received: Record<string, unknown>[] = [];
    client.on("message", (data) => received.push(JSON.parse(messageText(data)) as Record<string, unknown>));

    await withTransaction(pool, async (locker) => {
      // `watch()` authorizes through `users`; keep that SELECT waiting while the second frame
      // arrives, then commit to let the older watch prove it cannot overtake the unwatch.
      await locker.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");
      client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      client.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    client.close();
  });

  it("keeps the existing watcher live when a replacement watch cannot be authorized", async () => {
    const owner = await createTestUser();
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
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
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "retain watch after replay failure" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await connect("owner");
    client.send(JSON.stringify({ type: "agent:watch", runId: run.id, afterEventId: "0" }));
    expect((await nextFrame(client)).type).toBe("agent:event");

    const originalQuery = pool.query.bind(pool);
    // The first two calls are the replacement's authorization reads. The test only needs to
    // reject the subsequent replay query, while preserving those real query results at runtime.
    const passThroughQuery = originalQuery as unknown as () => void;
    const query = vi
      .spyOn(pool, "query")
      .mockImplementationOnce(passThroughQuery)
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
    identityByToken.set("owner", { userId: owner, sessionId: "owner-session" });
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

    identityByToken.set("a", { userId: await createTestUser(), sessionId: "session-a" });
    identityByToken.set("b", { userId: await createTestUser(), sessionId: "session-b" });
    const clientA = await connect("a");
    const clientB = await connect("b");
    const closedA = waitForClose(clientA);
    const closedB = waitForClose(clientB);

    // Simulates the LISTEN connection being lost (network blip, Postgres restart) without any
    // test-only hook in production code — `onError` is the real handler `syncServer.ts` wires.
    listenClient.emit("error", new Error("simulated LISTEN connection loss"));

    expect(await closedA).toBe(1012);
    expect(await closedB).toBe(1012);

    // The reconnect loop (capped exponential backoff) restores a usable LISTEN connection: a
    // client connecting after the outage is served exactly like one that connected before it.
    const clientC = await connect("a");
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

    identityByToken.set("a", { userId: await createTestUser(), sessionId: "session-a" });
    const client = await connect("a");
    const closed = waitForClose(client);

    await syncServer.close();

    expect(await closed).toBe(1012);
  });

  it("terminates a connection that stops answering pings within a few missed heartbeats", async () => {
    syncServer = await createSyncServer(pool, {
      authenticate: async () => ({ userId: "user-1", sessionId: "session-1" }),
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
      authenticate: async () => ({ userId: "user-1", sessionId: "session-1" }),
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
    identityByToken.set("a", { userId: await createTestUser(), sessionId: "session-a" });
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

    identityByToken.set("producer", { userId: await createTestUser(), sessionId: "session-producer" });
    identityByToken.set("subscriber", { userId: await createTestUser(), sessionId: "session-subscriber" });
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
