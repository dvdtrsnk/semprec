import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import {
  createAgentRun,
  createChokePoint,
  createDocStore,
  createUser,
  hashPassword,
  insertAndNotifyAgentRunEvent,
  loadYDoc,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  provisionTenant,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  visitNotification,
  withTransaction,
  writeNotification,
  type ChokePoint,
  type DocStore,
  type PasswordResetMailer,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  buildBinaryFrame,
  decodeDocId,
  parseBinaryFrame,
  publishAgentRunDelta,
  publishRealtimeMessage,
  wireRealtimeHooks,
  type AgentStreamMessage,
  type InboundFrame,
  type OutboundFrame,
  type RealtimeMessage,
  type SyncServer,
} from "@semprec/realtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";

/**
 * Two-tenant proof of the realtime surface (`WS /api/sync`): every NOTIFY message type, every
 * inbound and outbound frame type and binary doc frames, over the same composition `serve.ts`
 * builds, on runtime-role pools with strict tenant-scope enforcement.
 *
 * Absence is proven without sleeping: after the event under test reached the socket that should
 * receive it, a sentinel event is published in the checked socket's own tenant. NOTIFYs are
 * delivered over the server's single LISTEN connection in commit order, so everything a NOTIFY
 * made the checked socket receive arrives before the sentinel.
 *
 * Frames a socket sends are not ordered against that connection. For those, the foreign frame is
 * sent before a request of B1's own whose reply is awaited, and the handlers do the same work in
 * the same order, so a leaked reply has been produced before the own reply is. A binary frame is
 * additionally decided synchronously at dispatch: `docSync.handleBinaryFrame` checks the socket's
 * subscription before its first `await`, and a frame it admits writes a row that fans out to A1.
 */

const PASSWORD = "s3cret-password";
const FRAME_TIMEOUT_MS = 5_000;
const YJS_UPDATE_MESSAGE = 2;

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

/** What a case saw arrive at the socket that should receive its event. */
type Observed = OutboundFrame["type"] | "binary";
type Scenario = () => Promise<readonly Observed[]>;
interface Case {
  scenarios: Record<string, Scenario>;
}

type Frame =
  | { kind: "text"; type: OutboundFrame["type"]; body: Record<string, unknown> }
  | { kind: "binary"; docId: string; payload: Buffer }
  | { kind: "invalid"; raw: string };

const OUTBOUND_TYPES = [
  "invalidate",
  "notification",
  "agent:event",
  "agent:delta",
] as const satisfies readonly OutboundFrame["type"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function parseFrame(data: RawData, isBinary: boolean): Frame {
  const buffer = rawToBuffer(data);
  if (isBinary) {
    const parsed = parseBinaryFrame(buffer);
    const docId = parsed ? decodeDocId(parsed.docId) : null;
    if (!parsed || docId === null) return { kind: "invalid", raw: buffer.toString("hex") };
    return { kind: "binary", docId, payload: parsed.payload };
  }
  const text = buffer.toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", raw: text };
  }
  if (!isRecord(json)) return { kind: "invalid", raw: text };
  const type = OUTBOUND_TYPES.find((candidate) => candidate === json.type);
  return type === undefined ? { kind: "invalid", raw: text } : { kind: "text", type, body: json };
}

/** A WebSocket that queues every frame it receives so a test consumes them in arrival order. */
class TestSocket {
  private readonly queue: Frame[] = [];
  private wake: (() => void) | null = null;
  closeCode: number | undefined;
  readonly closed: Promise<number>;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      this.queue.push(parseFrame(data, isBinary));
      this.wake?.();
    });
    this.closed = new Promise<number>((resolve) => {
      ws.once("close", (code: number) => {
        this.closeCode = code;
        resolve(code);
        this.wake?.();
      });
    });
  }

  static async connect(url: string, headers: Record<string, string>): Promise<TestSocket> {
    const ws = new WebSocket(url, { headers });
    const socket = new TestSocket(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return socket;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  sendJson(frame: InboundFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  async next(): Promise<Frame> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const frame = this.queue.shift();
      if (frame) return frame;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** Consumes frames until one matches, discarding the ones before it; returns the match. */
  async nextMatching(predicate: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const frame = await this.next();
      if (predicate(frame)) return frame;
    }
  }

  /** Consumes frames up to and including the first match; returns the frames that arrived before it. */
  async drainUntil(predicate: (frame: Frame) => boolean): Promise<Frame[]> {
    const before: Frame[] = [];
    for (;;) {
      const frame = await this.next();
      if (predicate(frame)) return before;
      before.push(frame);
    }
  }
}

function invalidation(databaseId: string): RealtimeMessage {
  return { type: "invalidation", scope: "schema", databaseId };
}

function isSentinel(databaseId: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "invalidate" &&
    frame.body.scope === "schema" &&
    frame.body.databaseId === databaseId;
}

function isDocFrame(docId: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === "binary" && frame.docId === docId;
}

function isAgentEvent(runId: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === "text" && frame.type === "agent:event" && frame.body.agentRunId === runId;
}

/** A minimal Yjs update message (`messageYjsUpdate` + length-prefixed update) for a binary doc frame. */
function yjsUpdateMessage(text: string): Buffer {
  const ydoc = new Y.Doc();
  let update: Uint8Array | null = null;
  ydoc.on("update", (u: Uint8Array) => {
    update = u;
  });
  ydoc.getText("body").insert(0, text);
  if (!update) throw new Error("expected the Yjs document to emit an update");
  const bytes: Uint8Array = update;
  const length: number[] = [];
  for (let n = bytes.length; ; n >>>= 7) {
    length.push(n > 127 ? (n & 127) | 128 : n);
    if (n <= 127) break;
  }
  return Buffer.concat([Buffer.from([YJS_UPDATE_MESSAGE, ...length]), Buffer.from(bytes)]);
}

interface TenantFixture {
  tenantId: string;
  userId: string;
  email: string;
  databaseId: string;
  itemId: string;
  docId: string;
  runId: string;
  /** An unread notification for the tenant's user, written when the fixture is built. */
  notificationId: string;
  /** Events already on the run when the fixture is built. */
  runEventCount: number;
}

let adminPool: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;
let server: Server;
let syncServer: SyncServer;
let baseUrl: string;
let wsUrl: string;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let previousScope: string | undefined;
let blobDir: string | undefined;

let a1: TestSocket;
let a2: TestSocket;
let b1: TestSocket;
let a1Cookie: string;
let a2SessionId: string;

const moduleRegistry = await loadFullModuleRegistry();

async function buildTenantFixture(tenantId: string): Promise<TenantFixture> {
  await provisionTenant(pool, tenantId);
  const email = `${randomUUID()}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);
  const user = await runAsSystem("test:create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  return runInTenant(tenantId, async () => {
    const database = await chokePoint.createDatabase({ name: "Isolation fixtures" });
    await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
    const doc = await docStore.getDoc(item.id);
    if (!doc) throw new Error("expected the item to have a doc");
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "fixture", userId: user.id });
    await insertAndNotifyAgentRunEvent(pool, run.id, "message", { text: "first" });
    const notificationId = await writeNotificationFor(user.id);
    return {
      tenantId,
      userId: user.id,
      email,
      databaseId: database.id,
      itemId: item.id,
      docId: doc.id,
      runId: run.id,
      notificationId,
      runEventCount: 1,
    };
  });
}

/** A fresh web session for `fixture`'s user, presented as the cookie the browser would send. */
async function openSession(fixture: TenantFixture): Promise<{ cookie: string; sessionId: string }> {
  // Sessions belong to the global identity tables, so they are issued as system work.
  const result = await runAsSystem("test:issue-session", () =>
    login(adminPool, { email: fixture.email, password: PASSWORD, platform: "web", ip: "127.0.0.1" }),
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${result.token}`, sessionId: result.session.id };
}

async function connect(cookie: string): Promise<TestSocket> {
  return TestSocket.connect(wsUrl, { Cookie: cookie, Origin: baseUrl });
}

/** Closes the current sockets and opens A's two sessions and B's one anew, each with a fresh queue. */
async function reconnectAll(): Promise<void> {
  for (const socket of [a1, a2, b1]) socket?.close();
  const [sessionA1, sessionA2, sessionB1] = await Promise.all([
    openSession(tenantA),
    openSession(tenantA),
    openSession(tenantB),
  ]);
  a1Cookie = sessionA1.cookie;
  a2SessionId = sessionA2.sessionId;
  [a1, a2, b1] = await Promise.all([connect(sessionA1.cookie), connect(sessionA2.cookie), connect(sessionB1.cookie)]);
}

async function restPost(cookie: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(body),
  });
}

/** Publishes a schema invalidation in `tenantId` that reaches all of its sockets; returns its marker. */
async function publishSentinel(tenantId: string): Promise<string> {
  const databaseId = randomUUID();
  await runInTenant(tenantId, () =>
    publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId }),
  );
  return databaseId;
}

/** Proves `socket` (authenticated in `tenantId`) received nothing since the last time its queue was drained. */
async function expectNothingReceived(socket: TestSocket, tenantId: string): Promise<void> {
  const sentinel = await publishSentinel(tenantId);
  expect(await socket.drainUntil(isSentinel(sentinel))).toEqual([]);
}

async function writeNotificationFor(userId: string): Promise<string> {
  return withTransaction(pool, (client) =>
    writeNotification(client, {
      userId,
      kind: "heartbeat_error",
      titleParams: { name: "Daily digest" },
      linkHref: null,
      sourceTable: "project_heartbeats",
      sourceId: randomUUID(),
      transitionInstance: randomUUID(),
    }),
  );
}

async function writeNotificationInA(): Promise<string> {
  return runInTenant(tenantA.tenantId, () => writeNotificationFor(tenantA.userId));
}

/** Writes one more block to `fixture`'s doc, which publishes a `doc_update`. */
async function touchDoc(fixture: TenantFixture): Promise<void> {
  await runInTenant(fixture.tenantId, () =>
    docStore.putBlock(fixture.itemId, { id: randomUUID(), flavour: "page" }, "user"),
  );
}

async function appendRunEvent(fixture: TenantFixture): Promise<string> {
  const event = await runInTenant(fixture.tenantId, () =>
    insertAndNotifyAgentRunEvent(pool, fixture.runId, "message", { text: randomUUID() }),
  );
  fixture.runEventCount += 1;
  return event.id;
}

async function countDocUpdates(fixture: TenantFixture, docId: string): Promise<number> {
  return runInTenant(fixture.tenantId, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1",
      [docId],
    );
    return rows[0]?.count ?? -1;
  });
}

async function waitForDocUpdateCount(fixture: TenantFixture, docId: string, expected: number): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while ((await countDocUpdates(fixture, docId)) < expected) {
    if (Date.now() > deadline) throw new Error(`doc ${docId} never reached ${expected} updates`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Opens `docId` on `socket`; the very next frame must be the server's SyncStep1 for that doc. */
async function openDoc(socket: TestSocket, docId: string): Promise<void> {
  socket.sendJson({ type: "doc:open", docId });
  expect(await socket.next()).toMatchObject({ kind: "binary", docId });
}

/**
 * Watches `fixture`'s run from the start; the next frames must be exactly its replayed events. Once
 * they arrived the live subscription is registered, so no later event can be missed.
 */
async function watchRun(socket: TestSocket, fixture: TenantFixture): Promise<void> {
  socket.sendJson({ type: "agent:watch", runId: fixture.runId, afterEventId: "0" });
  for (let replayed = 0; replayed < fixture.runEventCount; replayed++) {
    expect(await socket.next()).toMatchObject({
      kind: "text",
      type: "agent:event",
      body: { agentRunId: fixture.runId },
    });
  }
}

function observedTypes(frames: readonly Frame[]): Observed[] {
  return frames.map((frame) => (frame.kind === "text" ? frame.type : "binary"));
}

/** Both of A's sockets receive the invalidation, B1 receives nothing. */
async function expectInvalidationInA(match: Record<string, unknown>): Promise<readonly Observed[]> {
  const frames = await Promise.all(
    [a1, a2].map((socket) =>
      socket.nextMatching(
        (frame) => frame.kind === "text" && frame.type === "invalidate" && matches(frame.body, match),
      ),
    ),
  );
  await expectNothingReceived(b1, tenantB.tenantId);
  return observedTypes(frames);
}

function matches(body: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => body[key] === value);
}

/**
 * What B1 observes after an inbound frame it just sent, followed by opening its own doc: the first
 * frame must be its own doc's SyncStep1, and nothing else may precede the sentinel.
 */
async function observeB1AfterOpeningOwnDoc(): Promise<string[]> {
  await openDoc(b1, tenantB.docId);
  const sentinel = await publishSentinel(tenantB.tenantId);
  const rest = await b1.drainUntil(isSentinel(sentinel));
  return ["binary:own-doc", ...rest.map((frame) => frame.kind)];
}

const notifyCases = {
  invalidation: {
    scenarios: {
      "item scope, from a REST write by A's user": async () => {
        const response = await restPost(a1Cookie, `/api/databases/${tenantA.databaseId}/items`, {
          properties: { title: "Arrival" },
        });
        expect(response.status).toBe(201);
        return expectInvalidationInA({ scope: "item", databaseId: tenantA.databaseId, op: "create" });
      },
      "schema scope, from a REST write by A's user": async () => {
        const response = await restPost(a1Cookie, `/api/databases/${tenantA.databaseId}/properties`, {
          key: `rest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          name: "Added over REST",
          type: "text",
        });
        expect(response.status).toBe(201);
        return expectInvalidationInA({ scope: "schema", databaseId: tenantA.databaseId });
      },
      "item scope, from a background write inside runInTenant(A) with no acting user": async () => {
        await runInTenant(tenantA.tenantId, () =>
          chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} }),
        );
        return expectInvalidationInA({ scope: "item", databaseId: tenantA.databaseId, op: "create" });
      },
      "schema scope, from a background write inside runInTenant(A) with no acting user": async () => {
        await runInTenant(tenantA.tenantId, () =>
          chokePoint.createProperty({
            databaseId: tenantA.databaseId,
            key: `background${randomUUID().replace(/-/g, "").slice(0, 8)}`,
            name: "Added in the background",
            type: "text",
          }),
        );
        return expectInvalidationInA({ scope: "schema", databaseId: tenantA.databaseId });
      },
    },
  },
  doc_update: {
    scenarios: {
      "A's doc opened by A1": async () => {
        await openDoc(a1, tenantA.docId);
        await touchDoc(tenantA);
        const update = await a1.nextMatching(isDocFrame(tenantA.docId));
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([update]);
      },
    },
  },
  agent_run_event: {
    scenarios: {
      "A's run watched by A1": async () => {
        await watchRun(a1, tenantA);
        const eventId = await appendRunEvent(tenantA);
        const frame = await a1.nextMatching(isAgentEvent(tenantA.runId));
        expect(frame).toMatchObject({ kind: "text", body: { event: { id: eventId } } });
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([frame]);
      },
    },
  },
  notification_created: {
    scenarios: {
      "A's notification": async () => {
        const notificationId = await writeNotificationInA();
        const frames = await Promise.all(
          [a1, a2].map((socket) =>
            socket.nextMatching((frame) => frame.kind === "text" && frame.type === "notification"),
          ),
        );
        for (const frame of frames) {
          expect(frame).toMatchObject({
            body: { notification: { id: notificationId, userId: tenantA.userId } },
          });
        }
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes(frames);
      },
    },
  },
  notification_read_state: {
    scenarios: {
      "A's fixture notification being read": async () => {
        const notificationId = tenantA.notificationId;
        await runInTenant(tenantA.tenantId, () =>
          withTransaction(pool, (client) => visitNotification(client, tenantA.userId, notificationId)),
        );
        const frames = await Promise.all(
          [a1, a2].map((socket) =>
            socket.nextMatching((frame) => frame.kind === "text" && frame.type === "notification"),
          ),
        );
        for (const frame of frames) {
          expect(frame).toMatchObject({ body: { notification: { id: notificationId } } });
          const notification = frame.kind === "text" ? frame.body.notification : null;
          expect(isRecord(notification) && notification.readAt !== null).toBe(true);
        }
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes(frames);
      },
    },
  },
  session_revoked: {
    scenarios: {
      "A's second session closes A2 only": async () => {
        const response = await restPost(a1Cookie, `/api/auth/sessions/${a2SessionId}/revoke`, {});
        expect(response.status).toBe(200);
        expect(await a2.closed).toBe(4401);
        await expectNothingReceived(a1, tenantA.tenantId);
        await expectNothingReceived(b1, tenantB.tenantId);
        expect(a1.isOpen).toBe(true);
        expect(b1.isOpen).toBe(true);
        return [];
      },
    },
  },
} satisfies Record<RealtimeMessage["type"], Case>;

const streamCases = {
  agent_run_delta: {
    scenarios: {
      "A's run watched by A1": async () => {
        await watchRun(a1, tenantA);
        await runInTenant(tenantA.tenantId, () => publishAgentRunDelta(pool, tenantA.runId, { text: "typing" }));
        const frame = await a1.nextMatching(
          (candidate) => candidate.kind === "text" && candidate.type === "agent:delta",
        );
        expect(frame).toMatchObject({ body: { agentRunId: tenantA.runId, delta: { text: "typing" } } });
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([frame]);
      },
    },
  },
} satisfies Record<AgentStreamMessage["type"], Case>;

/** Sends `frame` as B1, then opens B1's own doc, and summarizes what B1 received; naming A's id must summarize like a random id. */
async function b1AfterForeignDocFrame(frame: InboundFrame): Promise<string[]> {
  b1.sendJson(frame);
  return observeB1AfterOpeningOwnDoc();
}

const inboundCases = {
  "doc:open": {
    scenarios: {
      "B1 opens A's doc exactly like a random UUID, and can still open its own": async () => {
        const foreign = await b1AfterForeignDocFrame({ type: "doc:open", docId: tenantA.docId });
        const random = await b1AfterForeignDocFrame({ type: "doc:open", docId: randomUUID() });
        expect(foreign).toEqual(random);

        // B1 never became a subscriber of A's doc: A's next update reaches A1 and not B1.
        await openDoc(a1, tenantA.docId);
        await touchDoc(tenantA);
        const update = await a1.nextMatching(isDocFrame(tenantA.docId));
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([update]);
      },
    },
  },
  "doc:close": {
    scenarios: {
      "B1 closes A's doc and A1 keeps receiving A's updates": async () => {
        await openDoc(a1, tenantA.docId);
        b1.sendJson({ type: "doc:close", docId: tenantA.docId });
        await openDoc(b1, tenantB.docId);
        await touchDoc(tenantA);
        const update = await a1.nextMatching(isDocFrame(tenantA.docId));
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([update]);
      },
    },
  },
  "agent:watch": {
    scenarios: {
      "B1 watches A's run exactly like a random run id": async () => {
        const summarize = async (runId: string): Promise<string[]> => {
          b1.sendJson({ type: "agent:watch", runId, afterEventId: "0" });
          await watchRun(b1, tenantB);
          const sentinel = await publishSentinel(tenantB.tenantId);
          const after = await b1.drainUntil(isSentinel(sentinel));
          return after.map((frame) => frame.kind);
        };
        const foreign = await summarize(tenantA.runId);
        const random = await summarize(randomUUID());
        expect(foreign).toEqual(random);
        expect(foreign).toEqual([]);

        // B1 is not a watcher of A's run: A's next event reaches A1 only.
        await watchRun(a1, tenantA);
        await appendRunEvent(tenantA);
        const event = await a1.nextMatching(isAgentEvent(tenantA.runId));
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([event]);
      },
    },
  },
  "agent:unwatch": {
    scenarios: {
      "B1 unwatches A's run and A1 keeps receiving its events": async () => {
        await watchRun(a1, tenantA);
        b1.sendJson({ type: "agent:unwatch", runId: tenantA.runId });
        b1.sendJson({ type: "agent:unwatch", runId: randomUUID() });
        await watchRun(b1, tenantB);
        const eventId = await appendRunEvent(tenantA);
        const event = await a1.nextMatching(isAgentEvent(tenantA.runId));
        expect(event).toMatchObject({ body: { event: { id: eventId } } });
        await expectNothingReceived(b1, tenantB.tenantId);
        return observedTypes([event]);
      },
    },
  },
} satisfies Record<InboundFrame["type"], Case>;

/** The text `docId` currently holds in its `body` Yjs text, read inside `fixture`'s tenant. */
async function docBodyText(fixture: TenantFixture, docId: string): Promise<string> {
  const ydoc = await runInTenant(fixture.tenantId, () => loadYDoc(pool, docId));
  return ydoc.getText("body").toJSON();
}

/**
 * With A1 subscribed to A's doc, B1 sends a Yjs update prefixed with A's doc id and A1 then sends
 * a control update for the same doc. The foreign frame is refused or admitted when it is
 * dispatched, before any await in `handleBinaryFrame`, and was sent before the control through the
 * same handler, so an admitted frame is queued ahead of the control's write on the same doc. Once
 * the control's text is stored, A's doc must hold the control's row and none from the foreign frame.
 */
async function foreignBinaryFrameWritesNothing(): Promise<void> {
  await openDoc(a1, tenantA.docId);
  const before = await countDocUpdates(tenantA, tenantA.docId);

  // The document survives between scenarios; wait for this control, not an earlier one.
  const control = `control-${randomUUID()}`;
  b1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("foreign")));
  a1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage(control)));
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (!(await docBodyText(tenantA, tenantA.docId)).includes(control)) {
    if (Date.now() > deadline) throw new Error("the control update was never stored");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(await docBodyText(tenantA, tenantA.docId)).not.toContain("foreign");
  expect(await countDocUpdates(tenantA, tenantA.docId)).toBe(before + 1);
  const sentinelB = await publishSentinel(tenantB.tenantId);
  const receivedByB1 = await b1.drainUntil(isSentinel(sentinelB));
  expect(receivedByB1.filter(isDocFrame(tenantA.docId))).toEqual([]);
}

const binaryCase = {
  scenarios: {
    "A1's own frame for A's doc is stored (control for the foreign cases)": async () => {
      await openDoc(a1, tenantA.docId);
      const before = await countDocUpdates(tenantA, tenantA.docId);
      a1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("control")));
      await waitForDocUpdateCount(tenantA, tenantA.docId, before + 1);
      return [];
    },
    "B1's frame prefixed with A's doc id, sent without doc:open": async () => {
      await foreignBinaryFrameWritesNothing();
      return [];
    },
    "B1's frame prefixed with A's doc id, sent after a refused doc:open": async () => {
      b1.sendJson({ type: "doc:open", docId: tenantA.docId });
      // B's own open is answered only after the refused one was handled, so the binary frame below
      // meets a socket whose open of A's doc is finished, not one still pending its lookup.
      await openDoc(b1, tenantB.docId);
      await foreignBinaryFrameWritesNothing();
      return [];
    },
  },
} satisfies Case;

/** A case whose single scenario runs every scenario of `producing` and requires a `type` frame among what they delivered. */
function producedBy(type: OutboundFrame["type"], producing: Case): Case {
  return {
    scenarios: {
      "produced by its mapped case": async () => {
        const observed: Observed[] = [];
        for (const run of Object.values(producing.scenarios)) {
          await reconnectAll();
          observed.push(...(await run()));
        }
        expect(observed).toContain(type);
        return observed;
      },
    },
  };
}

/** Each outbound frame type, mapped to the case whose scenarios produce it. */
const outboundCases = {
  invalidate: producedBy("invalidate", notifyCases.invalidation),
  notification: producedBy("notification", notifyCases.notification_created),
  "agent:event": producedBy("agent:event", notifyCases.agent_run_event),
  "agent:delta": producedBy("agent:delta", streamCases.agent_run_delta),
} satisfies Record<OutboundFrame["type"], Case>;

function scenariosOf(table: Record<string, Case>): Array<[string, string, Scenario]> {
  return Object.entries(table).flatMap(([caseName, c]) =>
    Object.entries(c.scenarios).map(([scenarioName, run]): [string, string, Scenario] => [caseName, scenarioName, run]),
  );
}

const notifyTable: Record<string, Case> = notifyCases;
const streamTable: Record<string, Case> = streamCases;
const inboundTable: Record<string, Case> = inboundCases;
const binaryTable: Record<string, Case> = { "binary doc frame": binaryCase };
const outboundTable: Record<string, Case> = outboundCases;

describe("realtime isolation across two tenants (issue #1054)", () => {
  beforeAll(async () => {
    previousScope = process.env.SEMPREC_TENANT_SCOPE;
    process.env.SEMPREC_TENANT_SCOPE = "strict";

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    wireRealtimeHooks(pool);
    blobDir = await mkdtemp(join(tmpdir(), "semprec-test-blobs-"));

    tenantA = await buildTenantFixture(await createTestTenant(adminPool));
    tenantB = await buildTenantFixture(await createTestTenant(adminPool));

    // Composed as serve.ts composes them: the dispatcher and the sync upgrade handler over one pool.
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(blobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    syncServer = await createSyncUpgradeHandler(pool);
    server = createServer(dispatch);
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
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/api/sync`;
  });

  afterAll(async () => {
    await syncServer?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await pool?.end();
    await adminPool?.end();
    // The hooks are module-global; leave none bound to the pool that was just ended.
    setInvalidationHook(() => {});
    setDocUpdateHook(() => {});
    setAgentRunEventHook(() => {});
    setNotificationCreatedHook(() => {});
    setNotificationReadStateHook(() => {});
    setSessionRevokedHook(() => {});
    if (blobDir !== undefined) await rm(blobDir, { recursive: true, force: true });
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
  });

  // Fresh sessions and sockets per test: the revocation case ends A's second session for good.
  beforeEach(async () => {
    await reconnectAll();
  });

  afterEach(() => {
    for (const socket of [a1, a2, b1]) socket?.close();
  });

  describe("NOTIFY messages on semprec_events", () => {
    it.each(scenariosOf(notifyTable))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });

    it.each([
      ["an envelope without a tenantId", (databaseId: string) => ({ message: invalidation(databaseId) })],
      [
        "an envelope with a null tenantId",
        (databaseId: string) => ({ tenantId: null, message: invalidation(databaseId) }),
      ],
      ["a bare message without an envelope", (databaseId: string) => invalidation(databaseId)],
    ])("a raw pg_notify with %s reaches no socket", async (_name, build) => {
      await adminPool.query("SELECT pg_notify('semprec_events', $1)", [JSON.stringify(build(randomUUID()))]);

      // One sentinel per tenant: it reaches every socket of that tenant, so both of A's sockets share it.
      const sentinelA = await publishSentinel(tenantA.tenantId);
      const sentinelB = await publishSentinel(tenantB.tenantId);
      expect(await a1.drainUntil(isSentinel(sentinelA))).toEqual([]);
      expect(await a2.drainUntil(isSentinel(sentinelA))).toEqual([]);
      expect(await b1.drainUntil(isSentinel(sentinelB))).toEqual([]);
    });
  });

  describe("NOTIFY messages on semprec_agent_stream", () => {
    it.each(scenariosOf(streamTable))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });

    it.each([
      ["an envelope without a tenantId", (delta: AgentStreamMessage) => ({ message: delta })],
      ["an envelope with a null tenantId", (delta: AgentStreamMessage) => ({ tenantId: null, message: delta })],
      ["a bare message without an envelope", (delta: AgentStreamMessage) => delta],
    ])("a raw pg_notify with %s reaches no watcher of A's run", async (_name, build) => {
      await watchRun(a1, tenantA);
      const delta: AgentStreamMessage = {
        type: "agent_run_delta",
        agentRunId: tenantA.runId,
        delta: { text: "tenantless" },
      };
      await adminPool.query("SELECT pg_notify('semprec_agent_stream', $1)", [JSON.stringify(build(delta))]);

      const sentinelA = await publishSentinel(tenantA.tenantId);
      const sentinelB = await publishSentinel(tenantB.tenantId);
      expect(await a1.drainUntil(isSentinel(sentinelA))).toEqual([]);
      expect(await b1.drainUntil(isSentinel(sentinelB))).toEqual([]);
    });
  });

  describe("inbound frames from B1 naming A's ids", () => {
    it.each(scenariosOf(inboundTable))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });

  describe("binary doc frames", () => {
    it.each(scenariosOf(binaryTable))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });

  describe("outbound frames", () => {
    it.each(scenariosOf(outboundTable))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });
});
