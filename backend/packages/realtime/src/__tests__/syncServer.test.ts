import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import {
  createPool,
  claimSempMessage,
  withTransaction,
  createAgentRun,
  createUser,
  finishSempMessageTurn,
  hashPassword,
  insertAndNotifyAgentRunEvent,
  insertAgentRunEvent,
  sendSempMessage,
  startSempMessageTurn,
  publishSempThreadInvalidation,
  createPendingApprovalRequestAndPublish,
  createSempChatThread,
  writeNotification,
  createChokePoint,
  createDocStore,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  AGENT_STREAM_CHANNEL,
  parseAgentStreamEnvelope,
  publishAgentRunDelta,
  publishRealtimeMessage,
} from "../pgNotifyPublisher.js";
import { createSyncServer, type SyncIdentity, type SyncServer, type SyncServerOptions } from "../syncServer.js";
import type { VoiceRunFrame, VoiceRunWatchInput } from "../agentRunWatch.js";
import { buildBinaryFrame, decodeDocId, parseBinaryFrame } from "../protocolV1.js";
import { wireRealtimeHooks } from "../wireHooks.js";

const { realtimeWarn } = vi.hoisted(() => ({ realtimeWarn: vi.fn() }));

// Only the realtime logger is replaced so its warnings can be asserted; every other logger stays real.
vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === "realtime" ? ({ warn: realtimeWarn, error: vi.fn() } as never) : actual.createLogger(name),
  };
});

let pool: Pool;
beforeAll(() => {
  pool = getTestPool();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Publishes a hand-built envelope, as a foreign or misbehaving publisher could. */
async function notifyEvent(tenantId: string, message: unknown, channel = "semprec_events"): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify({ tenantId, message })]);
}

/** Rejects on `error`, so a rejected upgrade reaches the other branch. */
function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

/** Never resolves on a dropped or errored connection. */
function waitForClose(client: WebSocket): Promise<number> {
  return new Promise((resolve) => client.once("close", (code) => resolve(code)));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await sleep(10);
  }
}

/** `ws` delivers `Buffer | ArrayBuffer | Buffer[]`; the array case is a fragmented frame. */
function messageBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects JSON frames in arrival order; a non-object frame fails the test. Optionally skips `agentRuns` frames. */
function record(client: WebSocket, skipAgentRuns = false): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  client.on("message", (data) => {
    const frame: unknown = JSON.parse(messageBuffer(data).toString("utf8"));
    if (!isRecord(frame)) throw new Error("expected a JSON object frame");
    if (skipAgentRuns && frame.type === "invalidate" && frame.scope === "agentRuns") return;
    frames.push(frame);
  });
  return frames;
}

function nextFrame(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) =>
    client.once("message", (data) => {
      const frame: unknown = JSON.parse(messageBuffer(data).toString("utf8"));
      if (isRecord(frame)) resolve(frame);
      else reject(new Error("expected a JSON object frame"));
    }),
  );
}

function watch(client: WebSocket, runId: string, afterEventId = "0"): void {
  client.send(JSON.stringify({ type: "agent:watch", runId, afterEventId }));
}

interface Harness {
  server: SyncServer;
  identities: Map<string, SyncIdentity>;
  url(token?: string): string;
  connect(token: string, options?: ClientOptions): Promise<WebSocket>;
  /** Registers an identity under `token` with session `session-<token>` and connects with it. */
  connectAs(token: string, tenantId?: string, userId?: string, options?: ClientOptions): Promise<WebSocket>;
  /** Idempotent, so a test may shut the server down itself. */
  closeServer(): Promise<void>;
  close(): Promise<void>;
}

function tokenAuth(identities: Map<string, SyncIdentity>): SyncServerOptions["authenticate"] {
  return async (req: IncomingMessage) => {
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    return token ? (identities.get(token) ?? null) : null;
  };
}

async function listen(server: SyncServer, identities = new Map<string, SyncIdentity>()): Promise<Harness> {
  const http = createServer();
  http.on("upgrade", (req, socket, head) => server.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  const url = (token?: string) => `ws://127.0.0.1:${address.port}/api/sync${token ? `?token=${token}` : ""}`;
  let serverClosed: Promise<void> | undefined;
  const harness: Harness = {
    server,
    identities,
    url,
    async connect(token, options) {
      const client = new WebSocket(url(token), options);
      await waitForOpen(client);
      return client;
    },
    connectAs(token, tenantId = getTenantZeroId(), userId = randomUUID(), options) {
      identities.set(token, { tenantId, userId, sessionId: `session-${token}` });
      return harness.connect(token, options);
    },
    closeServer: () => (serverClosed ??= server.close()),
    async close() {
      try {
        await harness.closeServer();
      } finally {
        await new Promise<void>((resolve) => http.close(() => resolve()));
      }
    },
  };
  return harness;
}

async function startHarness(
  serverPool: Pool,
  options: Partial<SyncServerOptions> | ((identities: Map<string, SyncIdentity>) => Partial<SyncServerOptions>) = {},
): Promise<Harness> {
  const identities = new Map<string, SyncIdentity>();
  const server = await createSyncServer(serverPool, {
    authenticate: tokenAuth(identities),
    revalidateSession: async () => true,
    heartbeatIntervalMs: 30_000,
    ...(typeof options === "function" ? options(identities) : options),
  });
  return listen(server, identities);
}

let passwordHash: Promise<string> | undefined;

/**
 * Only the first account is bound to tenant zero (`users.tenant_id` is unique), and only it may be named by a
 * tenant-zero notification. Later accounts get their own tenant.
 */
async function createTestUser(): Promise<string> {
  const user = await createUser(pool, {
    email: `sync-${randomUUID()}@example.test`,
    passwordHash: await (passwordHash ??= hashPassword("s3cret-password")),
    locale: "en",
    tenantId: await tenantForNextTestUser(pool),
  });
  return user.id;
}

async function createTestDoc(target: Pool = pool): Promise<string> {
  const chokePoint = createChokePoint(target);
  const store = createDocStore(target);
  const db = await chokePoint.createDatabase({ name: "Pages" });
  const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
  await store.putBlock(item.id, { id: "root", flavour: "page" }, "user");
  const doc = await store.getDoc(item.id);
  if (!doc) throw new Error("expected the page document");
  return doc.id;
}

function createTestNotification(
  userId: string,
  extra: Partial<Parameters<typeof writeNotification>[1]> = {},
): Promise<string> {
  const sourceId = randomUUID();
  return withTransaction(pool, (client) =>
    writeNotification(client, {
      userId,
      kind: "heartbeat_error",
      titleParams: { name: "Daily digest" },
      linkHref: null,
      sourceTable: "project_heartbeats",
      sourceId,
      transitionInstance: sourceId,
      ...extra,
    }),
  );
}

/**
 * Wraps `target.query` so the first call whose SQL `matches` waits on `release()`, either before it runs or after its
 * result arrives. `reached` resolves when that call is held.
 */
function holdQuery(target: Pool, matches: (sql: string, params: unknown) => boolean, when: "before" | "after") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const original = target.query.bind(target) as (...args: unknown[]) => Promise<unknown>;
  let held = false;
  const observer = async (...args: unknown[]): Promise<unknown> => {
    const hold = !held && typeof args[0] === "string" && matches(args[0], args[1]);
    if (hold) held = true;
    if (hold && when === "before") {
      reach();
      await gate;
    }
    const result = await original(...args);
    if (hold && when === "after") {
      reach();
      await gate;
    }
    return result;
  };
  // pg's overloaded `query` type includes a callback form returning void; every caller here awaits it.
  const implementation = observer as unknown as () => void;
  const spy = vi.spyOn(target, "query").mockImplementation(implementation);
  return {
    reached,
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

/** Resolves on `barrier`; fails if `operation` settles first or nothing happens within 3s. */
async function waitForBarrier(barrier: Promise<void>, operation?: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      ...(operation
        ? [
            operation.then(() => {
              throw new Error("operation completed before barrier");
            }),
          ]
        : []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("barrier timed out")), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `body`, then every cleanup in order; a cleanup failure never replaces the body's failure. */
async function withCleanup(body: () => Promise<void>, ...cleanups: Array<() => unknown>): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      if (error !== failure?.error) errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Test cleanup failed", {
      cause: failure ? failure.error : errors[0],
    });
  if (failure) throw failure.error;
}

/** A minimal Yjs client running the real y-protocols/sync handshake against the binary channel of `WS /api/sync`. */
class TestDocClient {
  readonly ydoc = new Y.Doc();
  readonly received: Buffer[] = [];

  constructor(
    readonly ws: WebSocket,
    private readonly docId: string,
  ) {
    this.ydoc.gc = false;
    ws.on("message", (data: RawData) => this.handleMessage(messageBuffer(data)));
  }

  text(): string {
    return this.ydoc.getText("body").toJSON();
  }

  open(): void {
    this.ws.send(JSON.stringify({ type: "doc:open", docId: this.docId }));
  }

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
      // Mirrors y-websocket's bidirectional handshake: send what the server lacks, then request its content.
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
      Y.applyUpdate(this.ydoc, decoding.readVarUint8Array(decoder));
    }
  }
}

/** Connects one socket per token, opens `docId` on each and waits until every handshake has started. */
async function openDocClients(h: Harness, docId: string, tokens: string[], tenantId?: string) {
  const clients: TestDocClient[] = [];
  for (const token of tokens) clients.push(new TestDocClient(await h.connectAs(token, tenantId), docId));
  for (const client of clients) client.open();
  await waitUntil(() => clients.every((client) => client.received.length > 0));
  return clients;
}

/**
 * Captures the first `pool.connect()` call, which in this file is always the sync server's LISTEN connection, so a test
 * can fault it (`.emit("error", ...)`) without a test-only hook in production code.
 */
async function captureListenClient(
  create: () => Promise<SyncServer>,
): Promise<{ server: SyncServer; listenClient: PoolClient }> {
  const originalConnect = pool.connect.bind(pool);
  let resolveClient!: (client: PoolClient) => void;
  const clientPromise = new Promise<PoolClient>((resolve) => (resolveClient = resolve));
  // `Pool["connect"]` is overloaded; spy through a non-overloaded, promise-returning view of the same pool.
  const poolConnect = pool as unknown as { connect: () => Promise<PoolClient> };
  const spy = vi.spyOn(poolConnect, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    resolveClient(client);
    return client;
  });
  let server: SyncServer;
  try {
    server = await create();
  } finally {
    spy.mockRestore();
  }
  return { server, listenClient: await clientPromise };
}

describe("createSyncServer connections and realtime fan-out", () => {
  let serverPool: Pool;
  let h: Harness;

  beforeEach(async () => {
    await resetDatabase(pool);
    // Tests here run tenant-scoped work on the shared pool; a server pool of its own keeps the LISTEN connection from
    // being a pooled client that carries a tenant scope.
    serverPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    h = await startHarness(serverPool);
  });

  afterEach(async () => {
    try {
      await h.close();
    } finally {
      await serverPool.end();
    }
  });

  it("opens a socket for a valid credential and rejects an invalid one with HTTP 401", async () => {
    const valid = await h.connectAs("t1");
    expect(valid.readyState).toBe(valid.OPEN);

    const invalid = new WebSocket(h.url("garbage"));
    const statusCode = await new Promise<number>((resolve) => {
      invalid.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    });
    expect(statusCode).toBe(401);
    expect(invalid.readyState).not.toBe(invalid.OPEN);
  });

  it("drops a malformed text frame and a too-short binary frame without affecting another connected client", async () => {
    const troublemaker = await h.connectAs("t1");
    const bystander = await h.connectAs("t2");

    troublemaker.send("not json");
    troublemaker.send(JSON.stringify({ type: "doc:vaporize", docId: "not-a-uuid" }));
    troublemaker.send(Buffer.from([1, 2, 3]));
    await sleep(50);

    expect(troublemaker.readyState).toBe(troublemaker.OPEN);
    expect(bystander.readyState).toBe(bystander.OPEN);
  });

  it("closes exactly the revoked session's socket with 4401, only when the envelope names the socket's tenant", async () => {
    const otherTenant = await createTestTenant(pool);
    const revoked = await h.connectAs("a");
    const surviving = await h.connectAs("b");
    const closed = waitForClose(revoked);

    await notifyEvent(otherTenant, { type: "session_revoked", sessionId: "session-a" });
    await notifyEvent(getTenantZeroId(), { type: "session_revoked", sessionId: "some-other-session" });
    await sleep(50);
    expect(revoked.readyState).toBe(revoked.OPEN);

    await notifyEvent(getTenantZeroId(), { type: "session_revoked", sessionId: "session-a" });
    expect(await closed).toBe(4401);
    await sleep(50);
    expect(surviving.readyState).toBe(surviving.OPEN);
  });

  /** Sockets of two users in tenant zero and a socket of another tenant carrying the first user's id. */
  async function tenantSockets() {
    const otherTenant = await createTestTenant(pool);
    const target = await createTestUser();
    const peer = await createTestUser();
    return {
      target,
      targetFrames: record(await h.connectAs("target", getTenantZeroId(), target)),
      peerFrames: record(await h.connectAs("peer", getTenantZeroId(), peer)),
      // A socket of another tenant that carries the target's user id still belongs to another tenant.
      foreignFrames: record(await h.connectAs("foreign", otherTenant, target)),
    };
  }

  const cardId = randomUUID();
  const threadId = randomUUID();
  const approvalRequestId = randomUUID();

  it.each([
    {
      name: "a schema invalidation",
      message: { type: "invalidation", scope: "schema", databaseId: "db-1" },
      expected: { type: "invalidate", scope: "schema", databaseId: "db-1" },
    },
    {
      // Mail content riding on the message is never forwarded.
      name: "a mailThread invalidation",
      message: { type: "invalidation", scope: "mailThread", threadId, subject: "private subject" },
      expected: { type: "invalidate", scope: "mailThread", threadId },
    },
    {
      // Card content riding on the message is never forwarded.
      name: "an inboxCards invalidation",
      message: {
        type: "invalidation",
        scope: "inboxCards",
        op: "closed",
        cardId,
        proposal: { entityKind: "database" },
        status: "confirmed",
      },
      expected: { type: "invalidate", scope: "inboxCards", op: "closed", cardId },
    },
  ])("delivers $name with no user to every socket of the envelope's tenant only", async ({ message, expected }) => {
    const { targetFrames, peerFrames, foreignFrames } = await tenantSockets();
    await notifyEvent(getTenantZeroId(), message);
    await waitUntil(() => targetFrames.length > 0 && peerFrames.length > 0);
    await sleep(100);
    expect(targetFrames).toEqual([expected]);
    expect(peerFrames).toEqual([expected]);
    expect(foreignFrames).toEqual([]);
  });

  it.each([
    {
      name: "an item invalidation from the publisher",
      publish: (userId: string) =>
        publishRealtimeMessage(pool, {
          type: "invalidation",
          scope: "item",
          databaseId: "db-1",
          itemId: "item-1",
          op: "update",
          updatedAt: "2026-01-01T00:00:00.000Z",
          userId,
        }),
      expected: {
        type: "invalidate",
        scope: "item",
        databaseId: "db-1",
        itemId: "item-1",
        op: "update",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      name: "a schema invalidation",
      publish: (userId: string) =>
        notifyEvent(getTenantZeroId(), { type: "invalidation", scope: "schema", databaseId: "db-1", userId }),
      expected: { type: "invalidate", scope: "schema", databaseId: "db-1" },
    },
    {
      name: "an approvalRequest invalidation",
      publish: (userId: string) =>
        notifyEvent(getTenantZeroId(), { type: "invalidation", scope: "approvalRequest", approvalRequestId, userId }),
      expected: { type: "invalidate", scope: "approvalRequest", approvalRequestId },
    },
    {
      name: "a mailThread invalidation",
      publish: (userId: string) =>
        notifyEvent(getTenantZeroId(), { type: "invalidation", scope: "mailThread", threadId, userId }),
      expected: { type: "invalidate", scope: "mailThread", threadId },
    },
    ...(["created", "updated", "closed"] as const).map((op) => ({
      name: `an inboxCards ${op} invalidation`,
      publish: (userId: string) =>
        notifyEvent(getTenantZeroId(), { type: "invalidation", scope: "inboxCards", op, cardId, userId }),
      expected: { type: "invalidate", scope: "inboxCards", op, cardId },
    })),
  ])(
    "narrows $name naming a user to that user's sockets inside the envelope's tenant",
    async ({ publish, expected }) => {
      const { target, targetFrames, peerFrames, foreignFrames } = await tenantSockets();
      await publish(target);
      await waitUntil(() => targetFrames.length > 0);
      await sleep(100);
      expect(targetFrames).toEqual([expected]);
      expect(peerFrames).toEqual([]);
      expect(foreignFrames).toEqual([]);
    },
  );

  it.each([
    {
      scope: "sempThread",
      valid: () => ({ type: "invalidation", scope: "sempThread", threadId }),
      malformed: [{ threadId: "not-a-uuid" }, { threadId: undefined }],
      expected: { type: "invalidate", scope: "sempThread", threadId },
    },
    {
      scope: "approvalRequest",
      valid: (userId: string) => ({ type: "invalidation", scope: "approvalRequest", approvalRequestId, userId }),
      malformed: [{ approvalRequestId: "not-a-uuid" }, { approvalRequestId: undefined }],
      expected: { type: "invalidate", scope: "approvalRequest", approvalRequestId },
    },
    {
      scope: "mailThread",
      valid: () => ({ type: "invalidation", scope: "mailThread", threadId }),
      malformed: [{ threadId: "not-a-uuid" }, { threadId: undefined }, { threadId: 7 }, { userId: "not-a-uuid" }],
      expected: { type: "invalidate", scope: "mailThread", threadId },
    },
    {
      scope: "inboxCards",
      valid: () => ({ type: "invalidation", scope: "inboxCards", op: "updated", cardId }),
      malformed: [
        { op: "deleted" },
        { op: undefined },
        { cardId: "not-a-uuid" },
        { cardId: undefined },
        { userId: "not-a-uuid" },
      ],
      expected: { type: "invalidate", scope: "inboxCards", op: "updated", cardId },
    },
  ])("drops a malformed $scope invalidation without reaching any socket", async ({ valid, malformed, expected }) => {
    const user = await createTestUser();
    const frames = record(await h.connectAs("a", getTenantZeroId(), user));
    for (const fields of malformed) await notifyEvent(getTenantZeroId(), { ...valid(user), ...fields });
    // A valid message behind the malformed ones proves they were handled first and sent nothing.
    await notifyEvent(getTenantZeroId(), valid(user));
    await waitUntil(() => frames.length > 0);
    await sleep(100);
    expect(frames).toEqual([expected]);
  });

  it("drops an approvalRequest invalidation that names no owner instead of widening it to the tenant", async () => {
    const frames = record(await h.connectAs("a", getTenantZeroId(), await createTestUser()));
    realtimeWarn.mockClear();
    await notifyEvent(getTenantZeroId(), { type: "invalidation", scope: "approvalRequest", approvalRequestId });
    await vi.waitFor(() =>
      expect(realtimeWarn).toHaveBeenCalledWith(
        { type: "invalidation", scope: "approvalRequest" },
        "realtime_approval_request_without_owner",
      ),
    );
    await sleep(50);
    expect(frames).toEqual([]);
  });

  it("routes a PostgreSQL-enveloped relation invalidation to the acting user's tenant sockets", async () => {
    const { target, targetFrames, peerFrames, foreignFrames } = await tenantSockets();
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const databaseId = randomUUID();
    const itemId = randomUUID();
    try {
      const role = await runAsSystem("test:verify-runtime-role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await runInTenant(getTenantZeroId(), () =>
        publishRealtimeMessage(runtime, {
          type: "invalidation",
          scope: "relation",
          databaseId,
          itemId,
          propertyKey: 'ě\\"'.repeat(4000),
          op: "put",
          userId: target,
        }),
      );
      await vi.waitFor(() => expect(targetFrames).toHaveLength(1));
      // A property key too large for the NOTIFY payload is dropped rather than truncated.
      expect(targetFrames).toEqual([
        { type: "invalidate", scope: "relation", databaseId, itemId, propertyKey: null, op: "put" },
      ]);
      await sleep(50);
      expect([...peerFrames, ...foreignFrames]).toEqual([]);
    } finally {
      await runtime.end();
    }
  });

  it("delivers a committed sempThread invalidation through the hook only to its own tenant, and nothing for a rolled-back one", async () => {
    const otherTenant = await createTestTenant(pool);
    const own = record(await h.connectAs("a", getTenantZeroId(), await createTestUser()));
    const foreign = record(await h.connectAs("b", otherTenant, await createTestUser()));
    // The hook is wired over a pool that is not the writer's tenant scope, as in the agents process.
    wireRealtimeHooks(pool);
    await expect(
      withTransaction(pool, async (client) => {
        publishSempThreadInvalidation(client, getTenantZeroId(), randomUUID());
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    const committedThreadId = randomUUID();
    await withTransaction(pool, async (client) => {
      publishSempThreadInvalidation(client, getTenantZeroId(), committedThreadId);
    });

    await waitUntil(() => own.length > 0);
    await sleep(50);
    expect(own).toEqual([{ type: "invalidate", scope: "sempThread", threadId: committedThreadId }]);
    expect(foreign).toEqual([]);
  });

  it("delivers the committed creation of a request once to its owner, with the thread of its run, and nothing for a rolled-back one", async () => {
    const owner = await createTestUser();
    const frames = record(await h.connectAs("owner", getTenantZeroId(), owner));
    wireRealtimeHooks(pool);

    const sempThreadId = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => createSempChatThread(client)),
    );
    const run = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "announce",
      userId: owner,
      threadId: sempThreadId,
    });
    const input = {
      agentRunId: run.id,
      toolName: "search",
      riskClass: "write",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    } as const;
    await expect(
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          await createPendingApprovalRequestAndPublish(client, input);
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");
    const request = await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) => createPendingApprovalRequestAndPublish(client, input)),
    );

    await waitUntil(() => frames.length >= 5);
    await sleep(100);
    expect(frames).toHaveLength(5);
    expect(frames).toContainEqual({ type: "invalidate", scope: "approvalRequest", approvalRequestId: request.id });
    // The owner's pending-decision count changed once, with the committed request.
    expect(frames.filter((frame) => frame.scope === "badgeCounts")).toEqual([
      { type: "invalidate", scope: "badgeCounts" },
    ]);
    expect(frames).toContainEqual({ type: "invalidate", scope: "sempThread", threadId: sempThreadId });
    // The run is announced when created and again with the committed request.
    expect(
      frames.filter(
        (frame) => frame.scope === "agentRuns" && frame.agentRunId === run.id && frame.projectItemId === null,
      ),
    ).toHaveLength(2);
  });

  it("delivers a notification_created only when the envelope names the notification's own tenant", async () => {
    const owner = await createTestUser();
    const notificationId = await createTestNotification(owner);
    const otherTenant = await createTestTenant(pool);
    // Row-level security applies only to a runtime role, so the server under test reads through one.
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const tenantHarness = await startHarness(runtimePool);
    try {
      const received = [
        record(await tenantHarness.connectAs("owner", getTenantZeroId(), owner)),
        record(await tenantHarness.connectAs("foreign", otherTenant, owner)),
      ];
      const message = { type: "notification_created", userId: owner, notificationId };

      await notifyEvent(otherTenant, message);
      await sleep(100);
      expect(received.flat()).toEqual([]);

      await notifyEvent(getTenantZeroId(), message);
      await waitUntil(() => received.flat().length > 0);
      expect(received[0]).toMatchObject([
        { type: "notification", notification: { id: notificationId, userId: owner } },
      ]);
      expect(received[1]).toEqual([]);
    } finally {
      await tenantHarness.close();
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
      await runInTenant(tenantId, () => publishAgentRunDelta(scopedPool, randomUUID(), { text: "x".repeat(40_000) }));
      await waitUntil(() => payloads.length >= 5);
      for (const payload of payloads) {
        expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8000);
        expect(parseAgentStreamEnvelope(JSON.parse(payload))?.tenantId).toBe(tenantId);
      }
    } finally {
      listener.release(true);
      await scopedPool.end();
    }
  });

  it("drops an envelope without a usable tenant on either channel and logs exactly one warning per payload without content", async () => {
    const frames = record(await h.connectAs("t", getTenantZeroId(), await createTestUser()));
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
    for (const [channel, payload] of bad)
      await pool.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify(payload)]);
    await pool.query("SELECT pg_notify('semprec_events', 'not json')");
    await waitUntil(() => realtimeWarn.mock.calls.length >= bad.length + 1);
    await sleep(50);

    expect(frames).toEqual([]);
    const warning = (channel: string, type: string | undefined) => [
      { channel, type },
      "realtime_message_without_tenant",
    ];
    expect(realtimeWarn.mock.calls).toEqual([
      ...Array.from({ length: 4 }, () => warning("semprec_events", "invalidation")),
      warning("semprec_agent_stream", "agent_run_delta"),
      warning("semprec_events", undefined),
      warning("semprec_events", undefined),
    ]);
  });

  it("never replays an invalidation published while a socket was disconnected", async () => {
    const userA = await createTestUser();
    const dropped = await h.connectAs("a", getTenantZeroId(), userA);
    dropped.close();
    await waitForClose(dropped);

    await publishRealtimeMessage(pool, {
      type: "invalidation",
      scope: "item",
      databaseId: "db-1",
      itemId: "item-1",
      op: "update",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userId: userA,
    });
    // NOTIFYs reach LISTEN in commit order, so a sentinel socket receiving this later tenant-wide broadcast proves the
    // userA invalidation was already dispatched before the reconnect.
    const sentinel = record(await h.connectAs("sentinel", getTenantZeroId(), await createTestUser()));
    await publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: "sentinel-db" });
    await waitUntil(() => sentinel.length > 0);
    expect(sentinel).toEqual([{ type: "invalidate", scope: "schema", databaseId: "sentinel-db" }]);

    // A new socket gets no replayed backlog; clients converge only through their own REST refetch.
    const reconnected = record(await h.connectAs("a", getTenantZeroId(), userA));
    await sleep(50);
    expect(reconnected).toEqual([]);
  });

  it("delivers the complete notification row only to its own user's socket, never on a userId that does not own it", async () => {
    const owner = await createTestUser();
    const impostor = await createTestUser();
    const ownerFrames = record(await h.connectAs("owner", getTenantZeroId(), owner));
    const impostorFrames = record(await h.connectAs("impostor", getTenantZeroId(), impostor));
    const notificationId = await createTestNotification(owner, { bodyKey: "notification.body.canUndo" });

    // A tampered payload naming a real notificationId with a mismatched userId never reaches that user's socket.
    await publishRealtimeMessage(pool, { type: "notification_created", userId: impostor, notificationId });
    await publishRealtimeMessage(pool, { type: "notification_created", userId: owner, notificationId });

    await waitUntil(() => ownerFrames.length > 0);
    await sleep(50);
    expect(ownerFrames[0]).toMatchObject({
      type: "notification",
      notification: { id: notificationId, userId: owner, body: "This can be undone later." },
    });
    expect(impostorFrames).toEqual([]);
  });

  it("never replays a notification published while a socket was disconnected", async () => {
    const owner = await createTestUser();
    const dropped = await h.connectAs("owner", getTenantZeroId(), owner);
    dropped.close();
    await waitForClose(dropped);

    const notificationId = await createTestNotification(owner);
    await publishRealtimeMessage(pool, { type: "notification_created", userId: owner, notificationId });
    // Let the NOTIFY and its row fetch finish while no socket is open; racing it against the reconnect could deliver
    // to the new socket by coincidence, which is not the replay this test targets.
    await sleep(300);

    // A new socket gets no replayed backlog; the client converges through GET /api/notifications/unread.
    const reconnected = record(await h.connectAs("owner", getTenantZeroId(), owner));
    await sleep(50);
    expect(reconnected).toEqual([]);
    const unread = await pool.query<{ id: string }>("SELECT id FROM notifications WHERE id = $1 AND read_at IS NULL", [
      notificationId,
    ]);
    expect(unread.rows).toHaveLength(1);
  });

  it("re-fetches and delivers the current row to the owning user on a notification_read_state NOTIFY", async () => {
    const owner = await createTestUser();
    const client = await h.connectAs("owner", getTenantZeroId(), owner);
    const notificationId = await createTestNotification(owner);
    await pool.query("UPDATE notifications SET read_at = now() WHERE id = $1", [notificationId]);

    const received = nextFrame(client);
    await publishRealtimeMessage(pool, {
      type: "notification_read_state",
      userId: owner,
      notificationIds: [notificationId],
    });
    expect(await received).toMatchObject({
      type: "notification",
      notification: { id: notificationId, readAt: expect.any(String) },
    });
  });
});

describe("createSyncServer doc sync", () => {
  let h: Harness;

  beforeEach(async () => {
    await resetDatabase(pool);
    // Fan-out rides the real doc_update NOTIFY of the write path rather than a simulated one.
    wireRealtimeHooks(pool);
    h = await startHarness(pool);
  });

  afterEach(() => h.close());

  it("persists an accepted update attributed to the user and delivers it to subscribed sockets only", async () => {
    const docId = await createTestDoc();
    const [clientA, clientB] = await openDocClients(h, docId, ["a", "b"]);
    const unsubscribed = await h.connectAs("c");
    let unsubscribedSawMessage = false;
    unsubscribed.on("message", () => (unsubscribedSawMessage = true));

    clientA!.mutate((doc) => doc.getText("body").insert(0, "hello from A"));
    await waitUntil(() => clientB!.text() === "hello from A");

    const { rows } = await pool.query<{ created_by: string }>(
      "SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1",
      [docId],
    );
    expect(rows).toEqual([{ created_by: "user" }]);
    await sleep(150);
    expect(unsubscribed.readyState).toBe(unsubscribed.OPEN);
    expect(unsubscribedSawMessage).toBe(false);
  });

  it("opens the page document of a subpage created by page.createSubpage and syncs its content", async () => {
    const project = await createTestProjectItem(pool);
    const created = await createDocStore(pool).createSubpage({ parent: { itemId: project } }, "user");
    const page = created.pages[0];
    if (!page) throw new Error("Missing created page");
    // `semprec://page/<pageItemId>` resolves to the document the socket opens: the page summary names that docId.
    expect((await createDocStore(pool).getPageSummary(page.pageItemId, "en")).docId).toBe(page.docId);

    const [clientA, clientB] = await openDocClients(h, page.docId, ["a", "b"]);
    clientA!.mutate((doc) => doc.getText("body").insert(0, "typed into the new page"));
    await waitUntil(() => clientB!.text() === "typed into the new page");
  });

  it("converges two subscribed clients after concurrent updates from both, including a duplicate resend", async () => {
    const [clientA, clientB] = await openDocClients(h, await createTestDoc(), ["a", "b"]);
    clientA!.mutate((doc) => doc.getText("body").insert(0, "AAA"));
    clientB!.mutate((doc) => doc.getText("body").insert(doc.getText("body").length, "BBB"));
    // A duplicate resend of an already-applied update must not corrupt convergence.
    clientA!.mutate((doc) => doc.getText("body").insert(0, ""));

    const converged = (client: TestDocClient) => client.text().includes("AAA") && client.text().includes("BBB");
    await waitUntil(() => converged(clientA!) && converged(clientB!));
    expect(clientA!.text()).toBe(clientB!.text());
  });

  it("recovers offline edits on reconnect, from the server alone", async () => {
    const docId = await createTestDoc();
    const [first] = await openDocClients(h, docId, ["a"]);
    first!.mutate((doc) => doc.getText("body").insert(0, "edit while connected"));
    await sleep(50);
    first!.ws.close();
    await waitForClose(first!.ws);

    // A fresh client of the same user, with no prior state, must recover everything from the server.
    const reconnected = new TestDocClient(await h.connect("a"), docId);
    reconnected.open();
    await waitUntil(() => reconnected.text() === "edit while connected");
  });
});

describe("createSyncServer doc sync tenancy", () => {
  let runtimePool: Pool;
  let h: Harness;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    // RLS applies only to a runtime role. The fresh pool also makes the LISTEN connection a new one opened in a system
    // scope: a reused connection carrying a tenant scope would throw `TenantScopeConflictError` on a foreign envelope.
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    h = await startHarness(runtimePool);
  });

  afterEach(async () => {
    await h.close();
    await runtimePool.end();
  });

  const createDocIn = (tenantId: string) => runInTenant(tenantId, () => createTestDoc(runtimePool));

  async function updateRowsOf(docId: string): Promise<{ id: string; tenant_id: string }[]> {
    // The superuser pool sees every tenant's rows, so a write in either tenant is counted.
    const { rows } = await pool.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM doc_updates WHERE doc_id = $1 ORDER BY id",
      [docId],
    );
    return rows;
  }

  it("answers a doc:open for another tenant's doc with nothing and persists no update frame sent right behind it", async () => {
    const docA = await createDocIn(tenantA);
    const rowsBefore = await updateRowsOf(docA);
    const clientB = new TestDocClient(await h.connectAs("b", tenantB), docA);
    // Sent back to back, so the update frame arrives while the server's tenant-scoped lookup is pending.
    clientB.open();
    clientB.mutate((doc) => doc.getText("body").insert(0, "intrusion"));
    await sleep(200);

    expect(clientB.received).toHaveLength(0);
    expect(await updateRowsOf(docA)).toEqual(rowsBefore);
  });

  it("opens and persists an update for a socket's own-tenant doc under that tenant", async () => {
    const docA = await createDocIn(tenantA);
    const rowsBefore = await updateRowsOf(docA);
    const editMetadata = () =>
      runInTenant(tenantA, async () => {
        const { rows } = await runtimePool.query<{ edited_at: Date; edited_by: string; update_at: Date }>(
          `SELECT d.last_edited_at AS edited_at, d.last_edited_by AS edited_by, u.created_at AS update_at
             FROM docs d JOIN LATERAL (
               SELECT created_at FROM doc_updates WHERE doc_id = d.id ORDER BY id DESC LIMIT 1
             ) u ON true WHERE d.id = $1`,
          [docA],
        );
        if (!rows[0]) throw new Error("Document edit metadata is missing");
        return rows[0];
      });
    const before = await editMetadata();
    const [clientA] = await openDocClients(h, docA, ["a"], tenantA);
    clientA!.mutate((doc) => doc.getText("body").insert(0, "own tenant"));
    let rows = rowsBefore;
    await vi.waitFor(async () => {
      rows = await updateRowsOf(docA);
      expect(rows).toHaveLength(rowsBefore.length + 1);
    });

    expect(rows.every((row) => row.tenant_id === tenantA)).toBe(true);
    const after = await editMetadata();
    expect(after.edited_at.getTime()).toBeGreaterThan(before.edited_at.getTime());
    expect(after.edited_at).toEqual(after.update_at);
    expect(after.edited_by).toBe("user");
  });

  it("delivers a doc_update envelope only to sockets of the envelope's tenant, whatever doc it names", async () => {
    const docA = await createDocIn(tenantA);
    const updateId = (await updateRowsOf(docA)).at(-1)?.id;
    const [clientA] = await openDocClients(h, docA, ["a"], tenantA);
    // Let the open handshake (the client's SyncStep1/2 replies) settle so only fan-out frames remain.
    await sleep(200);
    const receivedBefore = clientA!.received.length;
    const message = { type: "doc_update", docId: docA, updateId, createdBy: "user" };

    await notifyEvent(tenantB, message);
    await sleep(150);
    expect(clientA!.received).toHaveLength(receivedBefore);

    await notifyEvent(tenantA, message);
    await waitUntil(() => clientA!.received.length > receivedBefore);
  });
});

describe("createSyncServer closeTenant", () => {
  let runtimePool: Pool;
  let h: Harness;
  let tenantA: string;
  let tenantB: string;
  /** When set, every upgrade's authentication waits on it before resolving its identity. */
  let authGate: Promise<void> | null;
  let authStarted: number;

  beforeEach(async () => {
    await resetDatabase(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    authGate = null;
    authStarted = 0;
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    h = await startHarness(runtimePool, (identities) => ({
      authenticate: async (req) => {
        authStarted++;
        await authGate;
        return tokenAuth(identities)(req);
      },
    }));
  });

  afterEach(async () => {
    await h.close();
    await runtimePool.end();
  });

  function closeEvent(client: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      client.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
    });
  }

  it("closes every socket of the tenant with 4401 'account deactivated', leaves the other tenant's open, and does nothing on a second call", async () => {
    const tenantASockets = [await h.connectAs("a1", tenantA), await h.connectAs("a2", tenantA)];
    const closedB = [await h.connectAs("b1", tenantB), await h.connectAs("b2", tenantB)].map(closeEvent);
    let aClosed = false;
    for (const socket of tenantASockets) socket.once("close", () => (aClosed = true));

    h.server.closeTenant(tenantB);
    expect(await Promise.all(closedB)).toEqual([
      { code: 4401, reason: "account deactivated" },
      { code: 4401, reason: "account deactivated" },
    ]);
    h.server.closeTenant(tenantB);

    await sleep(100);
    expect(aClosed).toBe(false);
    expect(tenantASockets.map((socket) => socket.readyState)).toEqual([WebSocket.OPEN, WebSocket.OPEN]);
  });

  it("closes an upgrade of the tenant that was authenticating when it ran, and not the other tenant's", async () => {
    let releaseAuth!: () => void;
    authGate = new Promise<void>((resolve) => (releaseAuth = resolve));
    h.identities.set("b-late", { tenantId: tenantB, userId: randomUUID(), sessionId: randomUUID() });
    h.identities.set("a-late", { tenantId: tenantA, userId: randomUUID(), sessionId: randomUUID() });
    const lateB = new WebSocket(h.url("b-late"));
    const lateA = new WebSocket(h.url("a-late"));
    const closedB = closeEvent(lateB);
    const openedA = waitForOpen(lateA);
    await vi.waitFor(() => expect(authStarted).toBe(2));

    h.server.closeTenant(tenantB);
    releaseAuth();

    expect(await closedB).toEqual({ code: 4401, reason: "account deactivated" });
    await openedA;
    await sleep(100);
    expect(lateA.readyState).toBe(WebSocket.OPEN);
  });
});

describe("createSyncServer agent run watch tenancy", () => {
  let runtimePool: Pool;
  let h: Harness;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeEach(async () => {
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(pool);
    // The first account is bound to tenant zero, so it is the tenant's user: heartbeat runs fall back to it.
    userA = await createTestUser();
    // Row-level security applies only to a runtime role, so the server reads through one, on a fresh pool so its
    // LISTEN connection is opened outside any tenant scope.
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    h = await startHarness(runtimePool);
  });

  afterEach(async () => {
    await h.close();
    await runtimePool.end();
  });

  /** The event id an `agent:event` frame carries; any other shape fails the test. */
  function eventIdOf(frame: Record<string, unknown> | undefined): string {
    const event = frame?.event;
    if (!isRecord(event) || typeof event.id !== "string") throw new Error("expected an agent:event frame");
    return event.id;
  }

  const inA = <T>(fn: () => Promise<T>) => runInTenant(tenantA, fn);
  const createRun = () =>
    inA(() => createAgentRun(runtimePool, { triggeredBy: "user", task: "tenancy run", userId: userA }));
  /** Appends a durable event without a NOTIFY, so a test controls exactly what is announced. */
  const silentEvent = (runId: string) =>
    inA(() => insertAgentRunEvent(runtimePool, runId, "turn_start", { kind: "turn_start" }));
  const announce = (runId: string, eventId: string) =>
    inA(() => publishRealtimeMessage(runtimePool, { type: "agent_run_event", agentRunId: runId, eventId }));
  const announcedEvent = (runId: string) =>
    inA(async () => {
      const event = await insertAgentRunEvent(runtimePool, runId, "message", { kind: "message", text: "live" });
      await announce(runId, event.id);
      return event;
    });
  const publishDelta = (runId: string, delta: unknown, sempMessageId?: string, afterEventId?: string, seq?: number) =>
    inA(() => publishAgentRunDelta(runtimePool, runId, delta, sempMessageId, afterEventId, seq));
  /** Raw NOTIFY payloads stamped with the tenant inside PostgreSQL, crossing the real LISTEN boundary. */
  const notifyStamped = (messages: unknown[], raw: string[] = []) =>
    inA(() =>
      withTransaction(runtimePool, async (client) => {
        for (const payload of raw)
          await client.query<{ pg_notify: string }>("SELECT pg_notify($1, $2)", ["semprec_agent_stream", payload]);
        for (const message of messages)
          await client.query<{ pg_notify: string }>(
            "SELECT pg_notify($1, json_build_object('tenantId', app_tenant_default(), 'message', $2::json)::text)",
            ["semprec_agent_stream", JSON.stringify(message)],
          );
      }),
    );

  /** Starts the assistant turn of a new message on `runId`, through the production message and lifecycle writers. */
  function startTurn(runId: string, firstEventId: string, threadId?: string) {
    return inA(() =>
      withTransaction(runtimePool, async (client) => {
        const turn = await sendSempMessage(client, { threadId, text: "voice target", context: [], hasContext: false });
        expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
        await startSempMessageTurn(client, turn.assistantMessageId, runId, firstEventId);
        return { threadId: turn.threadId, sempMessageId: turn.assistantMessageId };
      }),
    );
  }

  interface VoiceFixture {
    run: { id: string };
    first: { id: string };
    target: { threadId: string; sempMessageId: string };
  }

  async function voiceFixture(): Promise<VoiceFixture> {
    const run = await createRun();
    const first = await silentEvent(run.id);
    return { run, first, target: await startTurn(run.id, first.id) };
  }

  function voiceInput(fx: VoiceFixture, overrides: Partial<VoiceRunWatchInput> = {}): VoiceRunWatchInput {
    return {
      tenantId: tenantA,
      userId: userA,
      runId: fx.run.id,
      ...fx.target,
      afterEventId: fx.first.id,
      onFrame: () => true,
      onFailure(error) {
        throw error;
      },
      ...overrides,
    };
  }

  /** Subscribes with a sink that records frames, and failures when `recordFailures` (otherwise a failure throws). */
  function voiceSink(fx: VoiceFixture, overrides: Partial<VoiceRunWatchInput> = {}, recordFailures = false) {
    const frames: VoiceRunFrame[] = [];
    const failures: Array<{ error: unknown; cause: string | undefined }> = [];
    const registration = h.server.subscribeVoice(
      voiceInput(fx, {
        onFrame(frame) {
          frames.push(frame);
          return true;
        },
        ...(recordFailures
          ? { onFailure: (error: unknown, cause?: string) => void failures.push({ error, cause }) }
          : {}),
        ...overrides,
      }),
    );
    // A rejected registration is asserted or awaited by the test body itself.
    void registration.catch(() => {});
    return { frames, failures, registration };
  }

  /** Disposes a registration once it settles; a rejection is the test body's to assert. */
  const disposeRegistration = (registration: Promise<() => Promise<void>>) =>
    registration.then(
      (dispose) => dispose(),
      () => undefined,
    );

  const eventIds = (frames: VoiceRunFrame[]) =>
    frames.flatMap((frame) => (frame.type === "event" ? [frame.event.id] : []));
  const deltas = (frames: VoiceRunFrame[]) => frames.filter((frame) => frame.type === "delta");

  /**
   * A socket watching a run of its own. NOTIFYs arrive in commit order, so once an event announced for the sentinel run
   * reaches it, every earlier NOTIFY has been dispatched.
   */
  async function sentinel() {
    const run = await createRun();
    const socket = await h.connectAs(`sentinel-${randomUUID()}`, tenantA, userA);
    const frames = record(socket, true);
    watch(socket, run.id);
    await sleep(150);
    return {
      frames,
      async flush() {
        const expected = frames.length + 1;
        await announcedEvent(run.id);
        await waitUntil(() => frames.length === expected);
      },
    };
  }

  /** A socket of the run's user watching the run from `afterEventId`. */
  async function wireWatcher(runId: string, afterEventId: string) {
    const socket = await h.connectAs(`wire-${randomUUID()}`, tenantA, userA);
    const frames = record(socket, true);
    watch(socket, runId, afterEventId);
    await sleep(150);
    return frames;
  }

  const replayRead = (sql: string) => sql.includes("FROM agent_run_events") && sql.includes("LIMIT $5");

  it("bounds voice replay before delivery and scopes callbacks to the authenticated run actor", async () => {
    const role = await runAsSystem("test:role", () =>
      runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const fx = await voiceFixture();
    const inserted = [fx.first.id];
    for (let i = 1; i < 256; i++) inserted.push((await silentEvent(fx.run.id)).id);
    const errors: unknown[] = [];
    const sink = voiceSink(fx, { afterEventId: "0", onFailure: (error) => void errors.push(error) });
    const dispose = await sink.registration;
    expect(eventIds(sink.frames)).toEqual(inserted);
    const live = await announcedEvent(fx.run.id);
    await vi.waitFor(() => expect(eventIds(sink.frames).at(-1)).toBe(live.id));
    await dispose();
    await dispose();
    await announcedEvent(fx.run.id);
    await sleep(150);
    expect(sink.frames).toHaveLength(257);
    expect(errors).toEqual([]);

    const refused = voiceSink(fx, { afterEventId: fx.first.id }, true);
    await expect(refused.registration).rejects.toThrow("replay exceeds");
    expect(refused.frames).toEqual([]);
    expect(refused.failures.map((failure) => failure.cause)).toEqual(["overloaded"]);
    for (const other of [
      { tenantId: tenantB },
      { userId: randomUUID() },
      { runId: randomUUID() },
      { threadId: randomUUID() },
      { sempMessageId: randomUUID() },
      { sempMessageId: "invalid" },
    ])
      await expect(h.server.subscribeVoice(voiceInput(fx, { afterEventId: "0", ...other }))).rejects.toThrow(
        "unavailable",
      );
  });

  it("hands off voice replay to live notifications and delivers nothing after disposal", async () => {
    const fx = await voiceFixture();
    const watcher = await sentinel();
    const hold = holdQuery(runtimePool, replayRead, "after");
    const sink = voiceSink(fx, { afterEventId: "0" });
    await withCleanup(
      async () => {
        await waitForBarrier(hold.reached, sink.registration);
        const live = await announcedEvent(fx.run.id);
        await watcher.flush();
        hold.release();
        const dispose = await sink.registration;
        expect(eventIds(sink.frames)).toEqual([fx.first.id, live.id]);
        await dispose();
        await announcedEvent(fx.run.id);
        await watcher.flush();
        expect(eventIds(sink.frames)).toEqual([fx.first.id, live.id]);
      },
      hold.restore,
      () => disposeRegistration(sink.registration),
    );
  });

  it("aborts an in-flight voice replay without delivering anything", async () => {
    const fx = await voiceFixture();
    const hold = holdQuery(runtimePool, replayRead, "after");
    const controller = new AbortController();
    const sink = voiceSink(fx, { afterEventId: "0", signal: controller.signal, onFailure() {} });
    await withCleanup(
      async () => {
        await waitForBarrier(hold.reached, sink.registration);
        controller.abort();
        hold.release();
        await expect(sink.registration).rejects.toThrow();
        expect(sink.frames).toEqual([]);
      },
      () => controller.abort(),
      hold.restore,
      () => disposeRegistration(sink.registration),
    );
  });

  it("drops malformed stream envelopes while historical unanchored deltas remain socket-only", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx, {}, true);
    const dispose = await sink.registration;
    const wire = await wireWatcher(fx.run.id, fx.first.id);
    const base = {
      type: "agent_run_delta",
      agentRunId: fx.run.id,
      sempMessageId: fx.target.sempMessageId,
      delta: { text: "historical" },
    };
    let scopedReads = 0;
    const counter = holdQuery(
      runtimePool,
      (sql) => {
        if (sql.includes("JOIN semp_messages")) scopedReads++;
        return false;
      },
      "before",
    );
    await withCleanup(
      async () => {
        await notifyStamped(
          [
            { ...base, agentRunId: "invalid" },
            { ...base, sempMessageId: "invalid" },
            { ...base, afterEventId: "0", deltaSequence: 1 },
            { ...base, afterEventId: fx.first.id, deltaSequence: 0 },
            {
              ...base,
              afterEventId: fx.first.id,
              deltaSequence: 1,
              delta: "abc",
              chunk: { id: "x", index: -1, total: 1, encoding: "base64json" },
            },
            base,
          ],
          [
            "not-json",
            JSON.stringify({ tenantId: "invalid", message: base }),
            JSON.stringify({ tenantId: tenantA, message: null }),
          ],
        );
        await vi.waitFor(() => expect(wire.filter((frame) => frame.type === "agent:delta")).toHaveLength(1));
        expect(wire[0]).toMatchObject({ type: "agent:delta", delta: { text: "historical" } });
        expect(sink.frames).toEqual([]);
        expect(sink.failures).toEqual([]);
        expect(scopedReads).toBe(0);
      },
      dispose,
      counter.restore,
    );
  });

  it("reports overloaded when an admitted chunk exceeds the retained fragment bound", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx, {}, true);
    const dispose = await sink.registration;
    await withCleanup(async () => {
      // A synthetic bounded transport fault crosses the real tenant-stamped LISTEN path.
      await notifyStamped([
        {
          type: "agent_run_delta",
          agentRunId: fx.run.id,
          sempMessageId: fx.target.sempMessageId,
          afterEventId: fx.first.id,
          deltaSequence: 1,
          delta: "A".repeat(7001),
          chunk: { id: randomUUID(), index: 0, total: 2, encoding: "base64json" },
        },
      ]);
      await vi.waitFor(() => expect(sink.failures).toHaveLength(1));
      expect(sink.failures[0]?.cause).toBe("overloaded");
      expect(sink.frames).toEqual([]);
    }, dispose);
  });

  it("reports unavailable for an admitted malformed chunk and preserves a callback failure", async () => {
    const fx = await voiceFixture();
    const failures: Array<{ error: unknown; cause: string | undefined }> = [];
    const callbackError = new Error("synthetic callback failure");
    const sink = voiceSink(fx, {
      onFailure(error, cause) {
        failures.push({ error, cause });
        throw callbackError;
      },
    });
    const dispose = await sink.registration;
    let disposed = false;
    await withCleanup(
      async () => {
        // This syntactically valid inner shape reaches the voice buffer, where the chunk id is refused.
        await notifyStamped([
          {
            type: "agent_run_delta",
            agentRunId: fx.run.id,
            sempMessageId: fx.target.sempMessageId,
            afterEventId: fx.first.id,
            deltaSequence: 1,
            delta: "e30=",
            chunk: { id: "not-a-uuid", index: 0, total: 1, encoding: "base64json" },
          },
        ]);
        await vi.waitFor(() => expect(failures).toHaveLength(1));
        expect(failures[0]?.cause).toBe("unavailable");
        expect(sink.frames).toEqual([]);
        disposed = true;
        const result: unknown = await dispose().catch((error: unknown) => error);
        if (!(result instanceof AggregateError)) throw new Error("Missing combined voice failure");
        expect(result.errors).toEqual([failures[0]?.error, callbackError]);
        expect(result.cause).toBe(failures[0]?.error);
      },
      () => (disposed ? undefined : dispose()),
    );
  });

  it("ignores a valid stale anchor and refuses an out-of-interval stale anchor", async () => {
    const alien = await silentEvent((await createRun()).id);
    const fx = await voiceFixture();
    const sink = voiceSink(fx, {}, true);
    const dispose = await sink.registration;
    await withCleanup(async () => {
      const event = await announcedEvent(fx.run.id);
      await vi.waitFor(() => expect(eventIds(sink.frames)).toContain(event.id));
      await publishDelta(fx.run.id, { text: "stale" }, fx.target.sempMessageId, fx.first.id, 1);
      await publishDelta(fx.run.id, { text: "alien" }, fx.target.sempMessageId, alien.id, 1);
      await vi.waitFor(() => expect(sink.failures).toHaveLength(1));
      expect(sink.failures[0]?.cause).toBe("unavailable");
      expect(deltas(sink.frames)).toEqual([]);
    }, dispose);
  });

  const durableRead = (sql: string) => sql.includes("AND e.id <= $5::bigint");

  it("orders a next-cycle delta behind a held real durable event read", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx);
    const dispose = await sink.registration;
    const hold = holdQuery(runtimePool, durableRead, "before");
    await withCleanup(
      async () => {
        const event = await announcedEvent(fx.run.id);
        await waitForBarrier(hold.reached);
        await publishDelta(fx.run.id, { text: "next cycle" }, fx.target.sempMessageId, event.id, 1);
        expect(sink.frames).toEqual([]);
        hold.release();
        await vi.waitFor(() => expect(sink.frames).toHaveLength(2));
        expect(sink.frames[0]).toMatchObject({ type: "event", event: { id: event.id } });
        expect(sink.frames[1]).toMatchObject({
          type: "delta",
          message: { afterEventId: event.id, delta: { text: "next cycle" } },
        });
      },
      hold.release,
      dispose,
      hold.restore,
    );
  });

  it("waits for a held durable read on disposal and emits nothing afterward", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx);
    const dispose = await sink.registration;
    const hold = holdQuery(runtimePool, durableRead, "before");
    let disposing: Promise<void> | undefined;
    await withCleanup(
      async () => {
        await announcedEvent(fx.run.id);
        await waitForBarrier(hold.reached);
        let settled = false;
        disposing = dispose().then(() => {
          settled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        hold.release();
        await disposing;
        expect(sink.frames).toEqual([]);
      },
      hold.release,
      () => disposing,
      dispose,
      hold.restore,
    );
  });

  it.each([
    { name: "expires an incomplete live delta and recovers only through the durable event", expire: true },
    { name: "lets a durable message supersede an incomplete live chunk before later chunks arrive", expire: false },
  ])(
    "$name",
    async ({ expire }) => {
      const fx = await voiceFixture();
      const sink = voiceSink(fx);
      const dispose = await sink.registration;
      const wire = await wireWatcher(fx.run.id, fx.first.id);
      let chunks = 0;
      // Holds the second chunk's NOTIFY, so the voice buffer holds an incomplete delta.
      const hold = holdQuery(
        runtimePool,
        (sql, params) =>
          sql.includes("pg_notify") && Array.isArray(params) && params[0] === "semprec_agent_stream" && ++chunks === 2,
        "before",
      );
      const publication = publishDelta(fx.run.id, { text: "x".repeat(12000) }, fx.target.sempMessageId, fx.first.id, 1);
      const wireDeltas = () => wire.filter((frame) => frame.type === "agent:delta");
      const durableEvent = async () => {
        const event = await announcedEvent(fx.run.id);
        await vi.waitFor(() => expect(eventIds(sink.frames)).toContain(event.id));
      };
      const finishPublication = async () => {
        hold.release();
        await publication;
        await vi.waitFor(() => expect(wireDeltas().length).toBeGreaterThan(1));
      };
      await withCleanup(
        async () => {
          await waitForBarrier(hold.reached, publication);
          await vi.waitFor(() =>
            expect(wireDeltas().some((frame) => isRecord(frame.chunk) && frame.chunk.index === 0)).toBe(true),
          );
          if (expire) {
            await sleep(5100);
            await finishPublication();
            expect(deltas(sink.frames)).toEqual([]);
            await durableEvent();
          } else {
            await durableEvent();
            await finishPublication();
          }
          expect(deltas(sink.frames)).toEqual([]);
        },
        hold.release,
        () => publication,
        dispose,
        hold.restore,
      );
    },
    15_000,
  );

  it("suppresses live deltas after an ordinal gap and delivers the durable recovery event", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx);
    const dispose = await sink.registration;
    const wire = await wireWatcher(fx.run.id, fx.first.id);
    await withCleanup(async () => {
      for (const sequence of [1, 3, 4])
        await publishDelta(
          fx.run.id,
          { kind: "message_update", type: "text_delta", delta: sequence === 1 ? "Hello. " : "untrusted later text" },
          fx.target.sempMessageId,
          fx.first.id,
          sequence,
        );
      await vi.waitFor(() => expect(wire.filter((frame) => frame.type === "agent:delta")).toHaveLength(3));
      await vi.waitFor(() => expect(deltas(sink.frames)).toHaveLength(1));
      // Synthetic state-only lifecycle event: it does not claim that a model generated this message.
      const event = await inA(() =>
        insertAgentRunEvent(runtimePool, fx.run.id, "message", { kind: "message", text: "Hello. world." }),
      );
      await announce(fx.run.id, event.id);
      await vi.waitFor(() => expect(eventIds(sink.frames)).toContain(event.id));
      expect(deltas(sink.frames)).toHaveLength(1);
      expect(sink.frames[0]).toMatchObject({
        type: "delta",
        message: { delta: { kind: "message_update", type: "text_delta", delta: "Hello. " } },
      });
      expect(sink.frames.at(-1)).toMatchObject({
        type: "event",
        event: { payload: { kind: "message", text: "Hello. world." } },
      });
    }, dispose);
  });

  it("filters tagged voice deltas by message while keeping socket frames unchanged", async () => {
    const fx = await voiceFixture();
    const sink = voiceSink(fx);
    const dispose = await sink.registration;
    await withCleanup(async () => {
      const wire = await wireWatcher(fx.run.id, fx.first.id);
      await publishDelta(fx.run.id, { text: "untagged" });
      await publishDelta(fx.run.id, { text: "other" }, randomUUID(), fx.first.id, 1);
      await publishDelta(fx.run.id, { text: "owned" }, fx.target.sempMessageId, fx.first.id, 1);
      await vi.waitFor(() => expect(deltas(sink.frames)).toHaveLength(1));
      expect(sink.frames[0]).toMatchObject({
        type: "delta",
        message: { sempMessageId: fx.target.sempMessageId, delta: { text: "owned" } },
      });
      const before = sink.frames.length;
      await publishDelta(fx.run.id, { text: "x".repeat(12000) }, fx.target.sempMessageId, fx.first.id, 2);
      // The chunks are reassembled into one voice frame of the owning message.
      await vi.waitFor(() => expect(sink.frames.length).toBe(before + 1));
      expect(sink.frames[before]).toMatchObject({ type: "delta", message: { sempMessageId: fx.target.sempMessageId } });
      expect(sink.frames[before]?.type === "delta" && "chunk" in sink.frames[before].message).toBe(false);
      await vi.waitFor(() => expect(wire.length).toBeGreaterThanOrEqual(4));
      expect(wire.every((frame) => frame.type === "agent:delta" && !("sempMessageId" in frame))).toBe(true);
      await expect(publishDelta(fx.run.id, { text: "invalid" }, "not-a-uuid")).rejects.toThrow();
      expect(
        parseAgentStreamEnvelope({
          tenantId: tenantA,
          message: { type: "agent_run_delta", agentRunId: fx.run.id, sempMessageId: "invalid", delta: {} },
        }),
      ).toBeNull();
    }, dispose);
  });

  it("keeps a delayed replay and later live deltas within their assistant turn", async () => {
    const fx = await voiceFixture();
    const last = await silentEvent(fx.run.id);
    const watcher = await sentinel();
    const hold = holdQuery(
      runtimePool,
      (sql) => sql.includes("JOIN semp_messages") && sql.includes("LIMIT $5"),
      "before",
    );
    const sink = voiceSink(fx, { afterEventId: "0" });
    await withCleanup(
      async () => {
        await waitForBarrier(hold.reached, sink.registration);
        await inA(() =>
          withTransaction(runtimePool, (client) =>
            finishSempMessageTurn(client, fx.target.sempMessageId, {
              status: "done",
              text: "first answer",
              lastEventId: last.id,
            }),
          ),
        );
        const secondFirst = await silentEvent(fx.run.id);
        const second = await startTurn(fx.run.id, secondFirst.id, fx.target.threadId);
        await publishDelta(fx.run.id, { text: "next while replay held" }, second.sempMessageId, secondFirst.id, 1);
        await watcher.flush();
        hold.release();
        const dispose = await sink.registration;
        expect(eventIds(sink.frames)).toEqual([fx.first.id, last.id]);
        expect(deltas(sink.frames)).toEqual([]);
        await announce(fx.run.id, secondFirst.id);
        await publishDelta(fx.run.id, { text: "next after replay" }, second.sempMessageId, secondFirst.id, 2);
        await announce(fx.run.id, last.id);
        await publishDelta(fx.run.id, { text: "first delayed" }, fx.target.sempMessageId, last.id, 1);
        await vi.waitFor(() => expect(deltas(sink.frames)).toHaveLength(1));
        await publishDelta(fx.run.id, { text: "first before next" }, fx.target.sempMessageId, last.id, 2);
        await publishDelta(fx.run.id, { text: "next after first" }, second.sempMessageId, secondFirst.id, 3);
        await watcher.flush();
        await vi.waitFor(() => expect(deltas(sink.frames)).toHaveLength(2));
        expect(eventIds(sink.frames)).toEqual([fx.first.id, last.id]);
        expect(sink.frames.at(-1)).toMatchObject({
          type: "delta",
          message: { sempMessageId: fx.target.sempMessageId },
        });
        await dispose();
      },
      hold.restore,
      () => disposeRegistration(sink.registration),
    );
  });

  it("delivers nothing to another tenant's socket watching a run, as for an unknown run, and replay then live frames in order to the run's user", async () => {
    const run = await createRun();
    const first = await silentEvent(run.id);

    // The other tenant's socket claims the very same user id: only the tenant boundary can refuse it.
    const foreign = await h.connectAs("foreign", tenantB, userA);
    const foreignFrames = record(foreign, true);
    watch(foreign, run.id);
    const unknown = await h.connectAs("unknown", tenantB, userA);
    const unknownFrames = record(unknown, true);
    watch(unknown, randomUUID());
    await sleep(150);
    expect(foreignFrames).toEqual([]);
    expect(unknownFrames).toEqual([]);

    // The run's own user's socket is the positive control: once it has its replay, live event and delta, the same
    // fan-out has passed over the foreign socket.
    const own = await h.connectAs("own", tenantA, userA);
    const ownFrames = record(own, true);
    watch(own, run.id);
    await waitUntil(() => ownFrames.length === 1);
    const live = await announcedEvent(run.id);
    await waitUntil(() => ownFrames.length === 2);
    await publishDelta(run.id, { kind: "message_update", text: "x" });
    await waitUntil(() => ownFrames.length === 3);
    expect(ownFrames.map((frame) => frame.type)).toEqual(["agent:event", "agent:event", "agent:delta"]);
    expect([eventIdOf(ownFrames[0]), eventIdOf(ownFrames[1])]).toEqual([first.id, live.id]);
    expect(foreignFrames).toEqual([]);
  });

  it("replays and then delivers live user messages to the authenticated run owner", async () => {
    const user = await h.connectAs("own", tenantA, userA);
    const run = await createRun();
    const firstPayload = { kind: "user_message", text: "first", context: [] };
    const secondPayload = { kind: "user_message", text: "second", context: [] };
    const first = await inA(() => insertAgentRunEvent(runtimePool, run.id, "user_message", firstPayload));
    const frames = record(user, true);
    watch(user, run.id);
    await waitUntil(() => frames.length === 1);
    const live = await inA(() => insertAndNotifyAgentRunEvent(runtimePool, run.id, "user_message", secondPayload));
    await waitUntil(() => frames.length === 2);
    expect(frames).toEqual([
      expect.objectContaining({
        type: "agent:event",
        event: expect.objectContaining({ id: first.id, kind: "user_message", payload: firstPayload }),
      }),
      expect.objectContaining({
        type: "agent:event",
        event: expect.objectContaining({ id: live.id, kind: "user_message", payload: secondPayload }),
      }),
    ]);
  });

  it.each([
    {
      name: "a durable reference",
      forge: async (runId: string) => {
        // A real row of the watched run, announced under the wrong tenant (a forged NOTIFY).
        const event = await silentEvent(runId);
        return {
          channel: "semprec_events",
          message: { type: "agent_run_event", agentRunId: runId, eventId: event.id },
          check: (frame: Record<string, unknown> | undefined) => expect(eventIdOf(frame)).toBe(event.id),
        };
      },
    },
    {
      name: "a delta",
      forge: async (runId: string) => ({
        channel: AGENT_STREAM_CHANNEL,
        message: { type: "agent_run_delta", agentRunId: runId, delta: "genuine" },
        check: (frame: Record<string, unknown> | undefined) => expect(frame?.delta).toBe("genuine"),
      }),
    },
  ])(
    "drops $name stamped with another tenant for a live watcher, while the run's own tenant's is delivered",
    async ({ forge }) => {
      const user = await h.connectAs("own", tenantA, userA);
      const run = await createRun();
      const frames = record(user, true);
      watch(user, run.id);
      await sleep(150);
      const { channel, message, check } = await forge(run.id);

      await notifyEvent(tenantB, message, channel);
      await sleep(150);
      expect(frames).toHaveLength(0);

      await notifyEvent(tenantA, message, channel);
      await waitUntil(() => frames.length === 1);
      check(frames[0]);
    },
  );

  it("never queues a durable reference stamped with another tenant while the watcher is still replaying", async () => {
    const user = await h.connectAs("own", tenantA, userA);
    const run = await createRun();
    const replayed = await silentEvent(run.id);
    const watcher = await sentinel();
    // Hold the replay query's result so a NOTIFY arriving meanwhile can only be queued for the drain.
    const hold = holdQuery(
      runtimePool,
      (sql) => sql.includes("FROM agent_run_events") && sql.includes("id > $2"),
      "after",
    );
    await withCleanup(async () => {
      const frames = record(user, true);
      watch(user, run.id);
      await hold.reached;

      // A real row of the watched run, committed after the replay snapshot and announced only under the wrong
      // tenant. If it were queued, the drain would fetch it under the watcher's own tenant and send it.
      const forged = await silentEvent(run.id);
      await notifyEvent(tenantB, { type: "agent_run_event", agentRunId: run.id, eventId: forged.id });
      await watcher.flush();
      hold.release();

      // With nothing queued, the watcher is promoted right after delivering its replay; a delta it then receives
      // shows the replay window closed without sending anything else.
      await waitUntil(() => frames.length > 0);
      await publishDelta(run.id, { kind: "message_update", text: "d" });
      await waitUntil(() => frames.some((frame) => frame.type === "agent:delta"));
      expect(frames.map((frame) => frame.type)).toEqual(["agent:event", "agent:delta"]);
      expect(eventIdOf(frames[0])).toBe(replayed.id);
    }, hold.restore);
  });
});

describe("createSyncServer watched agent runs", () => {
  let h: Harness;

  beforeEach(async () => {
    await resetDatabase(pool);
    h = await startHarness(pool);
  });

  afterEach(() => h.close());

  async function connectOwner(): Promise<WebSocket> {
    return h.connectAs("owner", getTenantZeroId(), await createTestUser());
  }

  /** A run with one durable event, watched by its owner's socket once the replay has arrived. */
  async function watchedRun(task: string) {
    const client = await connectOwner();
    const run = await createAgentRun(pool, { triggeredBy: "user", task });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    watch(client, run.id);
    expect((await nextFrame(client)).type).toBe("agent:event");
    return { client, run };
  }

  it("replays cursor events in id order, then delivers a later thin-reference event without a handoff gap", async () => {
    const client = await connectOwner();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "watch me" });
    const first = await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const second = await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "replayed" });
    const received = record(client);
    watch(client, run.id);
    await waitUntil(() => received.length === 2);

    const live = await insertAgentRunEvent(pool, run.id, "turn_end", { kind: "turn_end" });
    await publishRealtimeMessage(pool, { type: "agent_run_event", agentRunId: run.id, eventId: live.id });
    await waitUntil(() => received.length === 3);
    expect(received.map((frame) => frame.type)).toEqual(["agent:event", "agent:event", "agent:event"]);
    expect(received.map((frame) => (isRecord(frame.event) ? [frame.event.id, frame.event.kind] : null))).toEqual([
      [first.id, "turn_start"],
      [second.id, "message"],
      [live.id, "turn_end"],
    ]);
  });

  it("never sends durable events or ephemeral deltas to an unwatched or unauthorized socket", async () => {
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "private run" });
    const ownerClient = await h.connectAs("owner", getTenantZeroId(), owner);
    const otherClient = await h.connectAs("other", getTenantZeroId(), otherUser);
    const otherFrames = record(otherClient);
    watch(ownerClient, run.id);
    watch(otherClient, run.id);
    const event = await insertAgentRunEvent(pool, run.id, "message", { kind: "message", text: "complete" });
    const ownerEvent = nextFrame(ownerClient);
    await publishRealtimeMessage(pool, { type: "agent_run_event", agentRunId: run.id, eventId: event.id });
    expect((await ownerEvent).type).toBe("agent:event");

    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "typing" });
    await sleep(50);
    expect(otherFrames).toEqual([]);

    ownerClient.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
    await sleep(10);
    const afterUnwatch = record(ownerClient);
    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "not delivered" });
    await sleep(50);
    expect(afterUnwatch).toEqual([]);
  });

  it("cancels a watch when agent:unwatch arrives while its authorization query is pending", async () => {
    const owner = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "cancel pending watch", userId: owner });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    const client = await h.connectAs("owner", getTenantZeroId(), owner);
    const received = record(client);

    await withTransaction(pool, async (locker) => {
      // `watch()` authorizes with a plain SELECT, which a row-level `FOR UPDATE` would not block; an `ACCESS EXCLUSIVE`
      // table lock holds it pending while the second frame arrives.
      await locker.query("LOCK TABLE agent_runs IN ACCESS EXCLUSIVE MODE");
      watch(client, run.id);
      await sleep(25);
      client.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
      await sleep(25);
    });

    await sleep(100);
    expect(received).toEqual([]);
  });

  // agent_runs_actor_user_id_tenant_fkey confines actor_user_id to the run's tenant, whose only user is the tenant's
  // user, so a distinct actor cannot exist.
  it.each([
    { name: "the run's explicit actor_user_id", heartbeat: false },
    { name: "the tenant's user a heartbeat-triggered run falls back to", heartbeat: true },
  ])("authorizes agent:watch against $name and refuses another account", async ({ heartbeat }) => {
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    const run = await createAgentRun(
      pool,
      heartbeat
        ? { triggeredBy: "heartbeat", task: "heartbeat run" }
        : { triggeredBy: "user", task: "actor-owned run", userId: owner },
    );
    if (!heartbeat) expect(run.actorUserId).toBe(owner);
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });

    const otherClient = await h.connectAs("other", getTenantZeroId(), otherUser);
    const otherFrames = record(otherClient);
    watch(otherClient, run.id);
    await sleep(50);
    expect(otherFrames).toEqual([]);

    const ownerClient = await h.connectAs("owner", getTenantZeroId(), owner);
    watch(ownerClient, run.id);
    expect((await nextFrame(ownerClient)).type).toBe("agent:event");
  });

  it.each([
    {
      name: "cannot be authorized",
      fail: () => vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("transient authorization failure")),
    },
    {
      // The first call is the replacement's authorization read, which runs for real.
      name: "fails its replay",
      fail: () => {
        const passThrough = pool.query.bind(pool) as unknown as () => void;
        return vi
          .spyOn(pool, "query")
          .mockImplementationOnce(passThrough)
          .mockRejectedValueOnce(new Error("transient replay failure"));
      },
    },
  ])("keeps the existing watcher live when a replacement watch $name", async ({ fail }) => {
    const { client, run } = await watchedRun("retain watch");
    const query = fail();
    try {
      watch(client, run.id);
      await sleep(50);
      const delta = nextFrame(client);
      await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "still watching" });
      expect((await delta).type).toBe("agent:delta");
    } finally {
      query.mockRestore();
    }
  });

  it("chunks an oversized ephemeral delta below Postgres's NOTIFY payload limit", async () => {
    const { client, run } = await watchedRun("large delta");
    const frames = record(client);
    await publishAgentRunDelta(pool, run.id, { kind: "message_update", text: "x".repeat(12_000) });
    await waitUntil(() => frames.length >= 2, 5_000);

    expect(frames.every((frame) => frame.type === "agent:delta")).toBe(true);
    expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") < 7_500)).toBe(true);
    expect(frames.every((frame) => typeof frame.chunk === "object")).toBe(true);
  });
});

describe("createSyncServer heartbeat, limits, LISTEN outage and backpressure", () => {
  let h: Harness | undefined;

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterEach(async () => {
    // Unguarded cleanup after an early throw would raise a TypeError masking the original failure.
    const harness = h;
    h = undefined;
    await harness?.close();
  });

  const fixedIdentity = async () => ({ tenantId: getTenantZeroId(), userId: "user-1", sessionId: "session-1" });

  it("closes a socket with 4401 once its session revalidates as inactive", async () => {
    h = await startHarness(pool, {
      authenticate: fixedIdentity,
      revalidateSession: async () => false,
      heartbeatIntervalMs: 20,
    });
    const client = new WebSocket(h.url());
    const closed = waitForClose(client);
    await waitForOpen(client);
    expect(await closed).toBe(4401);
  });

  it("terminates a connection that stops answering pings within a few missed heartbeats", async () => {
    h = await startHarness(pool, { authenticate: fixedIdentity, heartbeatIntervalMs: 20 });
    // `autoPong: false` simulates a peer that stops answering pings; the heartbeat cadence above is scaled down.
    const client = new WebSocket(h.url(), { autoPong: false });
    const closed = waitForClose(client);
    await waitForOpen(client);
    await closed;
    expect(client.readyState).not.toBe(client.OPEN);
  });

  it("closes every connected socket with 1012 when the dedicated LISTEN connection errors, and serves a fresh connection again once it reconnects", async () => {
    const identities = new Map<string, SyncIdentity>();
    const { server, listenClient } = await captureListenClient(() =>
      createSyncServer(pool, { authenticate: tokenAuth(identities), revalidateSession: async () => true }),
    );
    const harness = await listen(server, identities);
    h = harness;
    const closed = [await harness.connectAs("a"), await harness.connectAs("b")].map(waitForClose);

    // `onError` starts the reconnect loop, whose first step is `pool.connect()`. Holding that call keeps the server in
    // the outage gap; otherwise whether the next socket connects before or after the reconnect is a race.
    const originalConnect = pool.connect.bind(pool);
    let releaseReconnect!: () => void;
    const reconnectReleased = new Promise<void>((resolve) => (releaseReconnect = resolve));
    const poolConnect = pool as unknown as { connect: () => Promise<PoolClient> };
    const reconnectSpy = vi.spyOn(poolConnect, "connect").mockImplementationOnce(async () => {
      await reconnectReleased;
      return originalConnect();
    });
    // `onError` is the real handler `syncServer.ts` wires; no test-only hook is needed.
    try {
      listenClient.emit("error", new Error("simulated LISTEN connection loss"));
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }
    expect(await Promise.all(closed)).toEqual([1012, 1012]);

    // A socket connecting during the gap may have missed a NOTIFY, so the reconnect closes it with 1012 in the same
    // step that installs the new LISTEN connection: that close signals the reconnect completed.
    const closedGap = waitForClose(await harness.connect("a"));
    releaseReconnect();
    expect(await closedGap).toBe(1012);

    // Served like a pre-outage client: it stays open and receives fan-out through the restored connection.
    const restored = await harness.connect("a");
    const received = nextFrame(restored);
    await publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: "db-1" });
    expect(await received).toEqual({ type: "invalidate", scope: "schema", databaseId: "db-1" });
    expect(restored.readyState).toBe(restored.OPEN);
  });

  it("closes every connected socket with 1012 on a controlled shutdown", async () => {
    h = await startHarness(pool);
    const closed = waitForClose(await h.connectAs("a"));
    await h.closeServer();
    expect(await closed).toBe(1012);
  });

  it("rejects a frame over the 2MB inbound cap by closing the connection, rather than buffering it", async () => {
    h = await startHarness(pool, { authenticate: fixedIdentity });
    const client = await h.connect("ignored");
    const closed = waitForClose(client);
    client.send(Buffer.alloc(2_000_001));
    expect(await closed).toBe(1009);
  });

  it("rejects a doc:open beyond the 32-open-documents-per-connection cap, leaving the first 32 subscribed", async () => {
    h = await startHarness(pool);
    const client = await h.connectAs("a");
    const docIds: string[] = [];
    for (let i = 0; i < 33; i += 1) docIds.push(await createTestDoc());

    const openedDocIds = new Set<string>();
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = parseBinaryFrame(messageBuffer(data));
      const docId = frame ? decodeDocId(frame.docId) : null;
      if (docId) openedDocIds.add(docId);
    });
    for (const docId of docIds) client.send(JSON.stringify({ type: "doc:open", docId }));
    await waitUntil(() => openedDocIds.size >= 32, 5_000);
    // Give the (rejected) 33rd doc:open a beat to arrive if the cap were not enforced.
    await sleep(100);

    expect(openedDocIds.size).toBe(32);
    expect(openedDocIds.has(docIds[32]!)).toBe(false);
    expect(client.readyState).toBe(client.OPEN);
  });

  it("closes a slow consumer with 1013 once its outgoing buffer stays over the backpressure threshold, without silently dropping any of the frames it never acknowledged", async () => {
    // Fan-out rides the real doc_update NOTIFY of the write path.
    wireRealtimeHooks(pool);
    const docId = await createTestDoc();
    h = await startHarness(pool);
    const producer = new TestDocClient(await h.connectAs("producer", undefined, undefined, { maxPayload: 0 }), docId);
    const subscriber = new TestDocClient(
      await h.connectAs("subscriber", undefined, undefined, { maxPayload: 0 }),
      docId,
    );
    producer.open();
    subscriber.open();
    await waitUntil(() => producer.received.length > 0 && subscriber.received.length > 0);

    // Pausing the subscriber's socket piles fanned-out updates in the server's outgoing buffer; the server's close
    // frame queues behind that backlog, so the client's `'close'` cannot fire yet.
    const subscriberSocket = (subscriber.ws as unknown as { _socket: Socket })._socket;
    subscriberSocket.pause();

    // NOTIFY latency and how much a paused socket absorbs (kernel window auto-tuning) are outside the test's control;
    // 30 x ~1MB over 3s keeps both margins generous.
    for (let i = 0; i < 30; i += 1) {
      producer.mutate((ydoc) => ydoc.getText("body").insert(0, "x".repeat(1_000_000)));
      await sleep(100);
    }
    // Lets the server notice `bufferedAmount` over the threshold and queue its 1013 close behind the backlog.
    await sleep(500);

    const closed = waitForClose(subscriber.ws);
    // Draining the backlog, including the trailing close frame, proves every update was delivered before the close.
    subscriberSocket.resume();
    expect(await closed).toBe(1013);
  }, 20_000);
});
