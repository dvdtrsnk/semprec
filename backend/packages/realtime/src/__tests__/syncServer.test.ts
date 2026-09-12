import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
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
