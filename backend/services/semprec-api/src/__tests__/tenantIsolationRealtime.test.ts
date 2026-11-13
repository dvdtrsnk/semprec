import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import * as Y from "yjs";
import {
  createAgentRun,
  finishAgentRun,
  raiseProblem,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  createPendingApprovalRequest,
  createPendingApprovalRequestAndPublish,
  createSempChatThread,
  createTasksDayRolloverAction,
  decideAndEnqueueApprovalRequest,
  getNotificationById,
  createChokePoint,
  createCoreTaskList,
  createLibraryMetadataFetcher,
  createSemprecTickAction,
  createDocStore,
  deleteRelationWithClient,
  ensureItemAutomation,
  createUser,
  hashPassword,
  insertAndNotifyAgentRunEvent,
  insertValueLink,
  loadYDoc,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  patchNotificationPreferences,
  publishAccountInvalidation,
  provisionTenant,
  publishSempThreadInvalidation,
  resolveMailModuleIds,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInboxCardsInvalidationHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  setSempThreadInvalidationHook,
  visitNotification,
  withTransaction,
  writeNotification,
  type ChokePoint,
  type DocStore,
  type PasswordResetMailer,
} from "@semprec/data";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  buildBinaryFrame,
  decodeDocId,
  parseBinaryFrame,
  publishAgentRunDelta,
  appendClientUpdateId,
  publishRealtimeMessage,
  wireRealtimeHooks,
  type AgentStreamMessage,
  type InboundFrame,
  type OutboundFrame,
  type RealtimeMessage,
  type SyncServer,
} from "@semprec/realtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { createDispatcher } from "../app.js";
import * as adapterRouteModule from "../adapter/adapterRoute.js";
import * as itemRoutesModule from "../itemsHandler.js";
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
  "doc:ack",
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

const ownedSockets = new Set<TestSocket>();

/** A WebSocket that queues every frame it receives so a test consumes them in arrival order. */
class TestSocket {
  private readonly queue: Frame[] = [];
  private wake: (() => void) | null = null;
  private readonly errors: Error[] = [];
  private readonly onError = (error: Error) => {
    this.errors.push(error);
  };
  closeCode: number | undefined;
  readonly closed: Promise<number>;

  private constructor(private readonly ws: WebSocket) {
    ws.on("error", this.onError);
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

  static async connect(
    url: string,
    headers: Record<string, string>,
    owner = ownedSockets,
    afterTerminate?: (socket: WebSocket) => void,
  ): Promise<TestSocket> {
    const ws = new WebSocket(url, { headers });
    const socket = new TestSocket(ws);
    owner.add(socket);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handshakeFailure: Error | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          clearTimeout(timer);
          ws.removeListener("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          handshakeFailure = error;
          clearTimeout(timer);
          ws.removeListener("open", onOpen);
          reject(error);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        timer = setTimeout(() => ws.terminate(), FRAME_TIMEOUT_MS);
      });
      return socket;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      // The exact handshake event is carried as the rejected connect outcome.
      if (handshakeFailure && handshakeFailure === error) {
        const index = socket.errors.indexOf(handshakeFailure);
        if (index < 0) cleanupFailures.push(new Error("Missing observed handshake failure", { cause: error }));
        else socket.errors.splice(index, 1);
      }
      try {
        await socket.dispose(afterTerminate);
      } catch (cleanup) {
        cleanupFailures.push(cleanup);
      } finally {
        owner.delete(socket);
      }
      if (cleanupFailures.length) {
        throw new AggregateError([error, ...cleanupFailures], "Socket open and cleanup failed", { cause: error });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispose(afterTerminate?: (socket: WebSocket) => void): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    let callbackFailure: { error: unknown } | undefined;
    try {
      afterTerminate?.(this.ws);
    } catch (error) {
      callbackFailure = { error };
    }
    await this.closed;
    this.ws.removeListener("error", this.onError);
    const errors: unknown[] = [...this.errors];
    if (callbackFailure) errors.push(callbackFailure.error);
    if (errors.length) throw new AggregateError(errors, "Owned socket failed", { cause: errors[0] });
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

/** Owns this test's one LISTEN checkout, including a checkout delivered after closing starts. */
function ownRealtimeListener(configure?: (owned: Pool, onCancel: (cancel: () => void) => void) => void) {
  const owned = new Pool({
    ...adminPool.options,
    max: 1,
    connectionTimeoutMillis: 2500,
    statement_timeout: 5000,
    query_timeout: 7000,
  });
  let closing = false;
  let cancelPending = () => {};
  let client: PoolClient | undefined;
  let opening: Promise<PoolClient> | undefined;
  const clientErrors: Error[] = [];
  const onError = (error: Error) => clientErrors.push(error);
  configure?.(owned, (cancel) => {
    cancelPending = cancel;
  });
  const open = (): Promise<PoolClient> => {
    if (opening || closing) throw new Error("Listener admission closed");
    opening = (async () => {
      const acquired = await owned.connect();
      client = acquired;
      acquired.on("error", onError);
      if (closing) throw new Error("Listener closed during acquisition");
      await acquired.query("LISTEN semprec_events");
      if (closing) throw new Error("Listener closed during setup");
      return acquired;
    })();
    return opening;
  };
  const close = async (): Promise<void> => {
    closing = true;
    const errors: unknown[] = [];
    try {
      cancelPending();
    } catch (error) {
      errors.push(error);
    }
    if (opening) {
      const outcome = await opening.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ("error" in outcome) errors.push(outcome.error);
    }
    if (client) {
      try {
        client.release(true);
      } catch (error) {
        errors.push(error);
      }
      client.removeListener("error", onError);
      client = undefined;
    }
    try {
      await owned.end();
    } catch (error) {
      errors.push(error);
    }
    errors.push(...clientErrors);
    if (errors.length) throw new AggregateError(errors, "Listener cleanup failed", { cause: errors[0] });
  };
  return { open, close, owned, hasOwnedClient: () => client !== undefined };
}

/** Each request owns its abort timer and consumes the response before returning. */
async function ownedPut(
  url: string,
  headers: Record<string, string>,
  timeoutMs = FRAME_TIMEOUT_MS,
  controller = new AbortController(),
): Promise<number> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "PUT", headers, signal: controller.signal });
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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

async function disposeSockets(owner = ownedSockets): Promise<void> {
  const sockets = [...owner];
  const results = await Promise.allSettled(sockets.map((socket) => socket.dispose()));
  for (const socket of sockets) owner.delete(socket);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Socket cleanup failed");
}

async function joinSessionAttempts(
  starts: readonly [
    () => Promise<{ cookie: string; sessionId: string }>,
    () => Promise<{ cookie: string; sessionId: string }>,
    () => Promise<{ cookie: string; sessionId: string }>,
  ],
): Promise<
  [{ cookie: string; sessionId: string }, { cookie: string; sessionId: string }, { cookie: string; sessionId: string }]
> {
  const attempts = starts.map((start) => Promise.resolve().then(start));
  let first: { index: number; error: unknown } | undefined;
  attempts.forEach((attempt, index) => {
    void attempt.catch((error: unknown) => {
      first ??= { index, error };
    });
  });
  try {
    const sessions = await Promise.all(attempts);
    if (sessions.length !== 3) throw new Error("Expected three owned sessions");
    const [a, b, c] = sessions;
    if (!a || !b || !c) throw new Error("Missing owned session");
    return [a, b, c];
  } catch (error) {
    const outcomes = await Promise.allSettled(attempts);
    if (!first || first.error !== error) throw new Error("Missing first session failure", { cause: error });
    const later = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" && index !== first?.index ? [outcome.reason] : [],
    );
    if (later.length) throw new AggregateError([error, ...later], "Session setup failed", { cause: error });
    throw error;
  }
}

/** Closes the current sockets and opens A's two sessions and B's one anew, each with a fresh queue. */
async function reconnectAll(): Promise<void> {
  await disposeSockets();
  const [sessionA1, sessionA2, sessionB1] = await joinSessionAttempts([
    () => openSession(tenantA),
    () => openSession(tenantA),
    () => openSession(tenantB),
  ]);
  a1Cookie = sessionA1.cookie;
  a2SessionId = sessionA2.sessionId;
  const attempts = [connect(sessionA1.cookie), connect(sessionA2.cookie), connect(sessionB1.cookie)] as const;
  [a1, a2, b1] = await joinSocketAttempts(attempts, ownedSockets);
}

async function joinSocketAttempts<T extends readonly Promise<TestSocket>[]>(
  attempts: T,
  owner: Set<TestSocket>,
): Promise<{ -readonly [K in keyof T]: TestSocket }> {
  let first: { index: number; error: unknown } | undefined;
  attempts.forEach((attempt, index) => {
    void attempt.catch((error: unknown) => {
      first ??= { index, error };
    });
  });
  try {
    return await Promise.all(attempts);
  } catch (error) {
    const failures: unknown[] = [];
    try {
      await disposeSockets(owner);
    } catch (cleanup) {
      failures.push(cleanup);
    }
    const results = await Promise.allSettled(attempts);
    if (!first || first.error !== error) throw new Error("Missing first socket failure", { cause: error });
    results.forEach((result, index) => {
      if (result.status === "rejected" && index !== first?.index) failures.push(result.reason);
    });
    if (failures.length)
      throw new AggregateError([error, ...failures], "Socket setup and cleanup failed", { cause: error });
    throw error;
  }
}

async function restPost(cookie: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(body),
  });
}

async function restGet(cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie, Origin: baseUrl } });
}

/** The `total` of `GET /api/inbox/cards`, which the count of the Inbox stack is read from. */
async function inboxCardsTotal(cookie: string): Promise<number> {
  const response = await restGet(cookie, "/api/inbox/cards");
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.total !== "number") throw new Error("Expected an inbox card list with a total");
  return body.total;
}

function isInboxCardFrame(op: string, cardId?: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "invalidate" &&
    frame.body.scope === "inboxCards" &&
    frame.body.op === op &&
    (cardId === undefined || frame.body.cardId === cardId);
}

/**
 * A `proposed` Processing proposals card in `tenantId`, made by the tick over the runtime pool (issue #1811): a
 * typed Inbox item and a tick with a stubbed computation. Returns the Inbox item id.
 */
async function createProposedCard(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const databases = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["inbox", "inboxItemTypes", "processingProposals"]],
    );
    const idOf = (moduleId: string): string => {
      const row = databases.rows.find((candidate) => candidate.owner_module_id === moduleId);
      if (!row) throw new Error(`Database '${moduleId}' was not seeded`);
      return row.id;
    };
    const type = await chokePoint.createItem({
      databaseId: idOf("inboxItemTypes"),
      properties: { name: "Task", emoji: "T", processingMethod: "database", targetDatabase: "tasks" },
    });
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: idOf("inbox"),
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await createSemprecTickAction(pool, async () => ({ properties: { name: "Buy milk" } }))(
      {
        inboxDatabaseId: idOf("inbox"),
        inboxItemTypesDatabaseId: idOf("inboxItemTypes"),
        processingProposalsDatabaseId: idOf("processingProposals"),
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    return item.id;
  });
}

/**
 * Ingests one new message into a folder of a new mailbox of `tenantId` over the runtime pool (issue #1816); returns
 * the id of the mail thread the message joined.
 */
async function ingestMessageIn(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows: mailboxDatabases } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'mailboxes'",
    );
    const mailboxesDatabaseId = mailboxDatabases[0]?.id;
    if (!mailboxesDatabaseId) throw new Error("Mailboxes database was not seeded");
    const mailbox = await chokePoint.createItem({
      databaseId: mailboxesDatabaseId,
      properties: { name: `Mailbox ${randomUUID()}`, provider: "generic" },
    });
    const messageItemId = await withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const propertyId = async (databaseId: string, key: string): Promise<string> => {
        const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`expected the ${key} property to be seeded`);
        return property.id;
      };
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
        providerId: "INBOX",
        name: "Inbox",
        behavior: "folder",
        specialPurpose: "inbox",
      });
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
        attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
        folderItemId,
        mailboxItemId: mailbox.id,
        messageId: `<${randomUUID()}@example.test>`,
        envelope: { from: { address: "sender@example.test" } },
        attachments: [],
        storage: new LocalFsBlobStorageWriter(blobDir ?? tmpdir()),
        storageKeyPrefix: mailbox.id,
      });
      expect(ingested.created).toBe(true);
      return ingested.itemId;
    });
    const { rows } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
      [messageItemId],
    );
    if (!rows[0]) throw new Error("Expected the ingested message to have a thread");
    return rows[0].thread_id;
  });
}

function isMailThreadFrame(threadId?: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "invalidate" &&
    frame.body.scope === "mailThread" &&
    (threadId === undefined || frame.body.threadId === threadId);
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

/** One run of `fixture`'s user in its tenant, on a fresh Semp chat thread. */
async function createRunOnThread(
  fixture: TenantFixture,
  sockets: readonly TestSocket[],
): Promise<{ runId: string; threadId: string }> {
  const created = await runInTenant(fixture.tenantId, async () => {
    const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
    const run = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "approval announcement",
      userId: fixture.userId,
      threadId,
    });
    return { runId: run.id, threadId };
  });
  // The creation of the run is itself announced to its actor (issue #1863); consuming it keeps the frames a
  // test looks at afterwards to the ones it caused.
  await Promise.all(sockets.map((socket) => socket.nextMatching(isAgentRunsFrame(created.runId))));
  return created;
}

function isProjectAgentFrame(projectItemId?: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "invalidate" &&
    frame.body.scope === "projectAgent" &&
    (projectItemId === undefined || frame.body.projectItemId === projectItemId);
}

/** Toggles a tool grant of `projectItemId` in `tenantId` through the runtime role, rolling the transaction back on request. */
async function grantToolIn(tenantId: string, projectItemId: string, rollBack = false): Promise<void> {
  await runInTenant(tenantId, async () => {
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: randomUUID(),
      toolName: "search_web",
      toolSchema: {},
    });
    await withTransaction(pool, async (client) => {
      await setProjectMcpGrantForAgentPage(client, {
        projectItemId,
        mcpToolRegistrationId: registration.id,
        granted: true,
      });
      if (rollBack) throw new Error("rollback projectAgent announcement");
    });
  });
}

function isSempStatusFrame(): (frame: Frame) => boolean {
  return (frame) => frame.kind === "text" && frame.type === "invalidate" && frame.body.scope === "sempStatus";
}

/** Raises a Semp problem for `fixture`'s user in its tenant through the runtime role, rolling back on request. */
async function raiseProblemIn(fixture: TenantFixture, rollBack = false): Promise<void> {
  await runInTenant(fixture.tenantId, () =>
    withTransaction(pool, async (client) => {
      await raiseProblem(client, {
        userId: fixture.userId,
        category: "mail",
        kind: "mailSyncFailed",
        severity: "warning",
        sourceTable: "mail_account_sync_state",
        sourceId: randomUUID(),
        dedupeKey: `mail:sync:${randomUUID()}`,
      });
      if (rollBack) throw new Error("rollback sempStatus announcement");
    }),
  );
}

function isAgentRunsFrame(agentRunId?: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "invalidate" &&
    frame.body.scope === "agentRuns" &&
    (agentRunId === undefined || frame.body.agentRunId === agentRunId);
}

function pendingApprovalInput(agentRunId: string) {
  return {
    agentRunId,
    toolName: "search",
    riskClass: "write",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  } as const;
}

function isUserScopedFrame(scope: "notificationPreferences" | "badgeCounts" | "account"): (frame: Frame) => boolean {
  return (frame) => frame.kind === "text" && frame.type === "invalidate" && frame.body.scope === scope;
}

/** Changes the notification preferences of `fixture`'s user in its tenant through the runtime role, rolling back on request. */
async function patchPreferencesIn(fixture: TenantFixture, rollBack = false): Promise<void> {
  await runInTenant(fixture.tenantId, () =>
    withTransaction(pool, async (client) => {
      await patchNotificationPreferences(client, fixture.userId, { reminders: false });
      if (rollBack) throw new Error("rollback notificationPreferences announcement");
    }),
  );
}

function isMcpServersFrame(frame: Frame): boolean {
  return frame.kind === "text" && frame.type === "invalidate" && frame.body.scope === "mcpServers";
}

/**
 * Creates an MCP server item in `tenantId` and switches it off through the choke point of the runtime role, the write
 * that announces the tenant's `mcpServers` scope. Its creation announces nothing of that scope.
 */
async function switchMcpServerOffIn(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    const database = (await chokePoint.listDatabases()).find((entry) => entry.ownerModuleId === "mcpServers");
    if (!database) throw new Error("The mcpServers database was not provisioned");
    const server = await chokePoint.createItem({
      databaseId: database.id,
      properties: {
        name: "Isolation server",
        connectionConfig: { transport: "http", url: "https://mcp.example.test/mcp" },
      },
    });
    await chokePoint.updateItem({ databaseId: database.id, itemId: server.id, propertiesPatch: { active: false } });
  });
}

function isOverviewFrame(frame: Frame): boolean {
  return frame.kind === "text" && frame.type === "invalidate" && frame.body.scope === "overview";
}

/**
 * Runs the nightly rollover of `fixture`'s tenant through the runtime role, over the tenant's fixture database (which
 * holds no task) so that nothing moves. The action's own transactions commit before it announces the day.
 */
async function runRolloverIn(fixture: TenantFixture): Promise<void> {
  await runInTenant(fixture.tenantId, () =>
    createTasksDayRolloverAction(pool)(
      { tasksDatabaseId: fixture.databaseId },
      { heartbeatId: randomUUID(), projectItemId: randomUUID() },
    ),
  );
}

/** Publishes the account invalidation of `fixture`'s user in its tenant through the runtime role, rolling back on request. */
async function publishAccountIn(fixture: TenantFixture, rollBack = false): Promise<void> {
  await runInTenant(fixture.tenantId, () =>
    withTransaction(pool, async (client) => {
      publishAccountInvalidation(client, fixture.userId);
      if (rollBack) throw new Error("rollback account announcement");
    }),
  );
}

/**
 * Every socket in `sockets` receives the approval request invalidation, the agent run invalidation, the badge
 * count invalidation of the run's owner and the Semp thread invalidation paired with it. They are published over
 * separate connections, so they may arrive in any order. The run was created before (`createRunOnThread` consumed
 * that announcement), its project is null and its actor is the fixture's user.
 */
async function expectRequestAndThreadInvalidations(
  sockets: readonly TestSocket[],
  approvalRequestId: string,
  threadId: string,
  agentRunId: string,
): Promise<void> {
  await Promise.all(
    sockets.map(async (socket) => {
      const pending = new Set(["approvalRequest", "sempThread", "agentRuns", "badgeCounts"]);
      while (pending.size > 0) {
        const frame = await socket.next();
        if (frame.kind !== "text" || frame.type !== "invalidate") continue;
        if (matches(frame.body, { scope: "approvalRequest", approvalRequestId })) pending.delete("approvalRequest");
        if (matches(frame.body, { scope: "sempThread", threadId })) pending.delete("sempThread");
        if (matches(frame.body, { scope: "agentRuns", agentRunId, projectItemId: null })) pending.delete("agentRuns");
        if (matches(frame.body, { scope: "badgeCounts" })) pending.delete("badgeCounts");
      }
    }),
  );
}

const notifyCases = {
  invalidation: {
    scenarios: {
      "inboxCards scope, from the tick creating A's card and the confirm of it on A1": async () => {
        const total = await inboxCardsTotal(a1Cookie);
        await createProposedCard(tenantA.tenantId);
        const created = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isInboxCardFrame("created"))));
        const cardId = created[0]?.kind === "text" ? created[0].body.cardId : undefined;
        if (typeof cardId !== "string") throw new Error("Expected the created frame to name the card");
        expect(created.map((frame) => (frame.kind === "text" ? frame.body.cardId : undefined))).toEqual([
          cardId,
          cardId,
        ]);
        expect(created.map((frame) => (frame.kind === "text" ? Object.keys(frame.body).sort() : []))).toEqual([
          ["cardId", "op", "scope", "type"],
          ["cardId", "op", "scope", "type"],
        ]);
        await expectNothingReceived(b1, tenantB.tenantId);
        expect(await inboxCardsTotal(a1Cookie)).toBe(total + 1);

        const confirmed = await restPost(a1Cookie, `/api/proposals/${cardId}/confirm`, {});
        expect(confirmed.status).toBe(200);

        // Device A1 confirmed and device A2 is the other device of the same tenant: both are told it closed.
        await Promise.all([a1, a2].map((socket) => socket.nextMatching(isInboxCardFrame("closed", cardId))));
        await expectNothingReceived(b1, tenantB.tenantId);
        expect(await inboxCardsTotal(a1Cookie)).toBe(total);
        return ["invalidate"];
      },
      "mailThread scope, from the ingest of a new message in A, once to both of A's sockets and not to B1":
        async () => {
          const threadId = await ingestMessageIn(tenantA.tenantId);

          const frames = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isMailThreadFrame(threadId))));
          for (const frame of frames) {
            expect(frame).toMatchObject({ kind: "text", body: { type: "invalidate", scope: "mailThread", threadId } });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "threadId", "type"]);
          }
          // One sentinel reaches both of A's sockets; nothing about the thread arrived before it a second time.
          const sentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(sentinel))).filter(isMailThreadFrame())).toEqual([]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "mailThread scope, from the ingest of a new message in B, which reaches B1 only": async () => {
        const threadId = await ingestMessageIn(tenantB.tenantId);

        await b1.nextMatching(isMailThreadFrame(threadId));
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "inboxCards scope, from the tick creating B's card, which reaches B1 only": async () => {
        await createProposedCard(tenantB.tenantId);

        await b1.nextMatching(isInboxCardFrame("created"));
        // One sentinel reaches both of A's sockets, so each is drained up to it.
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "agentRuns scope, from the creation and the close of A's run, once each to both of A's sockets and not to B1":
        async () => {
          const run = await runInTenant(tenantA.tenantId, () =>
            createAgentRun(pool, { triggeredBy: "user", task: "private task", userId: tenantA.userId }),
          );
          const expected = { type: "invalidate", scope: "agentRuns", projectItemId: null, agentRunId: run.id };
          const created = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isAgentRunsFrame(run.id))));
          for (const frame of created) {
            expect(frame).toMatchObject({ kind: "text", body: expected });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual([
              "agentRunId",
              "projectItemId",
              "scope",
              "type",
            ]);
          }
          await runInTenant(tenantA.tenantId, () => finishAgentRun(pool, run.id, "done", "private result"));
          const closed = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isAgentRunsFrame(run.id))));
          for (const frame of closed) expect(frame).toMatchObject({ kind: "text", body: expected });
          // One sentinel reaches both of A's sockets; nothing about the run arrived before it a third time.
          const sentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(sentinel))).filter(isAgentRunsFrame())).toEqual([]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "projectAgent scope, from a tool grant of A's project, once to both of A's sockets and not to B1, with nothing for a rolled-back one":
        async () => {
          const projectItemId = randomUUID();
          await expect(grantToolIn(tenantA.tenantId, projectItemId, true)).rejects.toThrow(
            "rollback projectAgent announcement",
          );
          const rollbackSentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(rollbackSentinel))).filter(isProjectAgentFrame())).toEqual([]);
          }

          await grantToolIn(tenantA.tenantId, projectItemId);
          const frames = await Promise.all(
            [a1, a2].map((socket) => socket.nextMatching(isProjectAgentFrame(projectItemId))),
          );
          for (const frame of frames) {
            expect(frame).toMatchObject({
              kind: "text",
              body: { type: "invalidate", scope: "projectAgent", projectItemId },
            });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual([
              "projectItemId",
              "scope",
              "type",
            ]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "projectAgent scope, from a tool grant of B's project, which reaches B1 only": async () => {
        const projectItemId = randomUUID();
        await grantToolIn(tenantB.tenantId, projectItemId);

        await b1.nextMatching(isProjectAgentFrame(projectItemId));
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "sempStatus scope, from a problem raised in A, once to both of A's sockets and not to B1, with nothing for a rolled-back one":
        async () => {
          await expect(raiseProblemIn(tenantA, true)).rejects.toThrow("rollback sempStatus announcement");
          const rollbackSentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(rollbackSentinel))).filter(isSempStatusFrame())).toEqual([]);
          }

          await raiseProblemIn(tenantA);
          const frames = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isSempStatusFrame())));
          for (const frame of frames) {
            expect(frame).toMatchObject({ kind: "text", body: { type: "invalidate", scope: "sempStatus" } });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
          }
          const sentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(sentinel))).filter(isSempStatusFrame())).toEqual([]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "sempStatus scope, from a problem raised in B, which reaches B1 only": async () => {
        await raiseProblemIn(tenantB);

        await b1.nextMatching(isSempStatusFrame());
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "notificationPreferences scope, from a preference change of A's user, once to both of A's sockets and not to B1, with nothing for a rolled-back one":
        async () => {
          await expect(patchPreferencesIn(tenantA, true)).rejects.toThrow(
            "rollback notificationPreferences announcement",
          );
          const rollbackSentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect(
              (await socket.drainUntil(isSentinel(rollbackSentinel))).filter(
                isUserScopedFrame("notificationPreferences"),
              ),
            ).toEqual([]);
          }

          await patchPreferencesIn(tenantA);
          const frames = await Promise.all(
            [a1, a2].map((socket) => socket.nextMatching(isUserScopedFrame("notificationPreferences"))),
          );
          for (const frame of frames) {
            expect(frame).toMatchObject({
              kind: "text",
              body: { type: "invalidate", scope: "notificationPreferences" },
            });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
          }
          const sentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect(
              (await socket.drainUntil(isSentinel(sentinel))).filter(isUserScopedFrame("notificationPreferences")),
            ).toEqual([]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "notificationPreferences scope, from a preference change of B's user, which reaches B1 only": async () => {
        await patchPreferencesIn(tenantB);

        await b1.nextMatching(isUserScopedFrame("notificationPreferences"));
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "mcpServers scope, from switching A's MCP server off, once to both of A's sockets and not to B1": async () => {
        await switchMcpServerOffIn(tenantA.tenantId);

        const frames = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isMcpServersFrame)));
        for (const frame of frames) {
          expect(frame).toMatchObject({ kind: "text", body: { type: "invalidate", scope: "mcpServers" } });
          expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
        }
        const sentinel = await publishSentinel(tenantA.tenantId);
        for (const socket of [a1, a2]) {
          expect((await socket.drainUntil(isSentinel(sentinel))).filter(isMcpServersFrame)).toEqual([]);
        }
        await expectNothingReceived(b1, tenantB.tenantId);
        return ["invalidate"];
      },
      "mcpServers scope, from switching B's MCP server off, which reaches B1 only": async () => {
        await switchMcpServerOffIn(tenantB.tenantId);

        await b1.nextMatching(isMcpServersFrame);
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "overview scope, from the end of A's rollover, once to both of A's sockets and not to B1": async () => {
        await runRolloverIn(tenantA);

        const frames = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isOverviewFrame)));
        for (const frame of frames) {
          expect(frame).toMatchObject({ kind: "text", body: { type: "invalidate", scope: "overview" } });
          expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
        }
        const sentinel = await publishSentinel(tenantA.tenantId);
        for (const socket of [a1, a2]) {
          expect((await socket.drainUntil(isSentinel(sentinel))).filter(isOverviewFrame)).toEqual([]);
        }
        await expectNothingReceived(b1, tenantB.tenantId);
        return ["invalidate"];
      },
      "overview scope, from the end of B's rollover, which reaches B1 only": async () => {
        await runRolloverIn(tenantB);

        await b1.nextMatching(isOverviewFrame);
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "account scope, from a profile change of A's user, once to both of A's sockets and not to B1, with nothing for a rolled-back one":
        async () => {
          await expect(publishAccountIn(tenantA, true)).rejects.toThrow("rollback account announcement");
          const rollbackSentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect(
              (await socket.drainUntil(isSentinel(rollbackSentinel))).filter(isUserScopedFrame("account")),
            ).toEqual([]);
          }

          await publishAccountIn(tenantA);
          const frames = await Promise.all([a1, a2].map((socket) => socket.nextMatching(isUserScopedFrame("account"))));
          for (const frame of frames) {
            expect(frame).toMatchObject({ kind: "text", body: { type: "invalidate", scope: "account" } });
            expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
          }
          const sentinel = await publishSentinel(tenantA.tenantId);
          for (const socket of [a1, a2]) {
            expect((await socket.drainUntil(isSentinel(sentinel))).filter(isUserScopedFrame("account"))).toEqual([]);
          }
          await expectNothingReceived(b1, tenantB.tenantId);
          return ["invalidate"];
        },
      "account scope, from a profile change of B's user, which reaches B1 only": async () => {
        await publishAccountIn(tenantB);

        await b1.nextMatching(isUserScopedFrame("account"));
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "badgeCounts scope, from a decision request of B's run, which reaches B1 only": async () => {
        const { runId } = await createRunOnThread(tenantB, [b1]);
        await runInTenant(tenantB.tenantId, () =>
          withTransaction(pool, (client) =>
            createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runId)),
          ),
        );

        const frame = await b1.nextMatching(isUserScopedFrame("badgeCounts"));
        expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "agentRuns scope, from the creation of B's run, which reaches B1 only": async () => {
        const run = await runInTenant(tenantB.tenantId, () =>
          createAgentRun(pool, { triggeredBy: "user", task: "private task", userId: tenantB.userId }),
        );

        await b1.nextMatching(isAgentRunsFrame(run.id));
        const sentinel = await publishSentinel(tenantA.tenantId);
        expect(await a1.drainUntil(isSentinel(sentinel))).toEqual([]);
        expect(await a2.drainUntil(isSentinel(sentinel))).toEqual([]);
        return ["invalidate"];
      },
      "approvalRequest scope, from the creation of a request on A's run with a thread": async () => {
        const { runId, threadId } = await createRunOnThread(tenantA, [a1, a2]);
        const request = await runInTenant(tenantA.tenantId, () =>
          withTransaction(pool, (client) =>
            createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runId)),
          ),
        );
        await expectRequestAndThreadInvalidations([a1, a2], request.id, threadId, runId);
        await expectNothingReceived(b1, tenantB.tenantId);
        return ["invalidate"];
      },
      "approvalRequest scope, from the decision of A's user on a request": async () => {
        const { runId, threadId } = await createRunOnThread(tenantA, [a1, a2]);
        const request = await runInTenant(tenantA.tenantId, () =>
          createPendingApprovalRequest(pool, pendingApprovalInput(runId)),
        );
        const decided = await runInTenant(tenantA.tenantId, () =>
          withTransaction(pool, (client) =>
            decideAndEnqueueApprovalRequest(client, {
              approvalRequestId: request.id,
              decision: "rejected",
              decidedByUserId: tenantA.userId,
            }),
          ),
        );
        expect(decided?.outcome).toBe("decided");
        await expectRequestAndThreadInvalidations([a1, a2], request.id, threadId, runId);
        await expectNothingReceived(b1, tenantB.tenantId);
        return ["invalidate"];
      },
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

  b1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("foreign")));
  a1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("control")));
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (!(await docBodyText(tenantA, tenantA.docId)).includes("control")) {
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
  "doc:ack": {
    scenarios: {
      "A1's stored update is acknowledged to A1 only, never to B1": async () => {
        await openDoc(a1, tenantA.docId);
        const before = await countDocUpdates(tenantA, tenantA.docId);
        a1.sendBinary(buildBinaryFrame(tenantA.docId, appendClientUpdateId(yjsUpdateMessage("acked"), "ack-1")));
        await waitForDocUpdateCount(tenantA, tenantA.docId, before + 1);
        const ackSeen = (frame: Frame): boolean =>
          frame.kind === "text" && frame.type === "doc:ack" && frame.body.clientUpdateId === "ack-1";
        await a1.drainUntil(ackSeen);
        const sentinelB = await publishSentinel(tenantB.tenantId);
        const receivedByB1 = await b1.drainUntil(isSentinel(sentinelB));
        expect(receivedByB1.filter((frame) => frame.kind === "text" && frame.type === "doc:ack")).toEqual([]);
        return ["doc:ack"];
      },
    },
  },
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
    setSempThreadInvalidationHook(() => {});
    setInboxCardsInvalidationHook(() => {});
    if (blobDir !== undefined) await rm(blobDir, { recursive: true, force: true });
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
  });

  // Fresh sessions and sockets per test: the revocation case ends A's second session for good.
  beforeEach(async () => {
    await reconnectAll();
  });

  afterEach(async () => {
    try {
      await disposeSockets();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("opens an ensured Journal page over the authenticated sync route only in its own tenant", async () => {
    const response = await fetch(`${baseUrl}/api/journal/periods/day/2026-10-16/doc`, {
      method: "PUT",
      headers: { Cookie: a1Cookie, Origin: baseUrl, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.docId !== "string") throw new Error("Missing ensured document id");
    const docId = body.docId;
    const before = await countDocUpdates(tenantA, docId);
    // The PUT may have emitted its item invalidation before the doc-open response.
    const sentinel = await publishSentinel(tenantA.tenantId);
    await a1.drainUntil(isSentinel(sentinel));
    await openDoc(a1, docId);
    const foreign = await b1AfterForeignDocFrame({ type: "doc:open", docId });
    const random = await b1AfterForeignDocFrame({ type: "doc:open", docId: randomUUID() });
    expect(foreign).toEqual(random);
    b1.sendBinary(buildBinaryFrame(docId, yjsUpdateMessage("foreign")));
    await expectNothingReceived(b1, tenantB.tenantId);
    expect(await countDocUpdates(tenantA, docId)).toBe(before);
  });

  it("publishes committed thread invalidations only to the writer's tenant and suppresses rolled-back ones", async () => {
    const rolledBack = randomUUID();
    await expect(
      runInTenant(tenantA.tenantId, () =>
        withTransaction(pool, async (client) => {
          publishSempThreadInvalidation(client, tenantA.tenantId, rolledBack);
          throw new Error("rollback thread invalidation");
        }),
      ),
    ).rejects.toThrow("rollback thread invalidation");
    const rollbackSentinel = await publishSentinel(tenantA.tenantId);
    expect(await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(rollbackSentinel))))).toEqual([
      [],
      [],
    ]);
    await expectNothingReceived(b1, tenantB.tenantId);

    const threadId = randomUUID();
    await runInTenant(tenantA.tenantId, () =>
      withTransaction(pool, async (client) => {
        publishSempThreadInvalidation(client, tenantA.tenantId, threadId);
      }),
    );
    await expectInvalidationInA({ scope: "sempThread", threadId });

    const threadB = randomUUID();
    await runInTenant(tenantB.tenantId, () =>
      withTransaction(pool, async (client) => {
        publishSempThreadInvalidation(client, tenantB.tenantId, threadB);
      }),
    );
    await b1.nextMatching(
      (frame) =>
        frame.kind === "text" &&
        frame.type === "invalidate" &&
        matches(frame.body, { scope: "sempThread", threadId: threadB }),
    );
    const foreignSentinel = await publishSentinel(tenantA.tenantId);
    expect(await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(foreignSentinel))))).toEqual([
      [],
      [],
    ]);
  });

  it("publishes committed approval request invalidations only to the owner's tenant and suppresses rolled-back ones", async () => {
    const runA = await createRunOnThread(tenantA, [a1, a2]);
    await expect(
      runInTenant(tenantA.tenantId, () =>
        withTransaction(pool, async (client) => {
          await createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runA.runId));
          throw new Error("rollback approval request announcement");
        }),
      ),
    ).rejects.toThrow("rollback approval request announcement");
    const rollbackSentinel = await publishSentinel(tenantA.tenantId);
    expect(await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(rollbackSentinel))))).toEqual([
      [],
      [],
    ]);
    await expectNothingReceived(b1, tenantB.tenantId);

    const runB = await createRunOnThread(tenantB, [b1]);
    const requestB = await runInTenant(tenantB.tenantId, () =>
      withTransaction(pool, (client) =>
        createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runB.runId)),
      ),
    );
    await expectRequestAndThreadInvalidations([b1], requestB.id, runB.threadId, runB.runId);
    const foreignSentinel = await publishSentinel(tenantA.tenantId);
    expect(await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(foreignSentinel))))).toEqual([
      [],
      [],
    ]);
  });

  it("delivers status-only library outcomes to the owning sockets and suppresses rolled-back outcomes", async () => {
    const workerPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const originals = new Map<PoolClient, PropertyDescriptor | undefined>();
    let rejectCommits = false;
    let rejectedCommits = 0;
    const onAcquire = (client: PoolClient) => {
      if (originals.has(client)) return;
      const descriptor = Object.getOwnPropertyDescriptor(client, "query");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const query = client.query;
      originals.set(client, descriptor);
      Object.defineProperty(client, "query", {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          if (rejectCommits && args[0] === "COMMIT") {
            rejectedCommits++;
            return Promise.reject(new Error("fixture commit refusal"));
          }
          return Reflect.apply(query, client, args);
        },
      });
    };
    const failures: unknown[] = [];
    try {
      const items = await runInTenant(tenantA.tenantId, async () => {
        await chokePoint.createProperty({ databaseId: tenantA.databaseId, key: "name", name: "Name", type: "text" });
        const result = [];
        for (const name of ["Found", "Missing", "Rollback"]) {
          const item = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: { name } });
          await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
          result.push(item);
        }
        return result;
      });
      const initial = await publishSentinel(tenantA.tenantId);
      await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(initial))));
      await expectNothingReceived(b1, tenantB.tenantId);

      const taskName = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;
      let providerCalls = 0;
      let found = true;
      const task = createCoreTaskList(
        workerPool,
        new Map(),
        createLibraryMetadataFetcher({
          fetch: async (url) => {
            providerCalls++;
            return new Response(
              JSON.stringify(
                url.includes("openlibrary.org")
                  ? { docs: found ? [{ title: "Found" }] : [] }
                  : { kind: "books#volumes", totalItems: 0 },
              ),
            );
          },
        }),
      )[taskName];
      if (!task) throw new Error("Library task missing");
      const enqueue = (itemId: string) =>
        runInTenant(tenantA.tenantId, () =>
          withTransaction(pool, (client) =>
            enqueueJob(
              client,
              taskName,
              { itemId, databaseId: tenantA.databaseId, config: { source: "openLibrary", coverKey: "cover" } },
              { jobKey: `library-metadata:${itemId}`, maxAttempts: 3 },
            ),
          ),
        );
      for (const [index, status] of ["found", "notFound"].entries()) {
        const item = items[index];
        if (!item) throw new Error("Library fixture missing");
        found = status === "found";
        await enqueue(item.id);
        await runOnce({ pgPool: pool, taskList: { [taskName]: task } });
        await expectInvalidationInA({ scope: "item", itemId: item.id, databaseId: tenantA.databaseId, op: "update" });
        const after = await runInTenant(tenantA.tenantId, () => chokePoint.getItem(tenantA.databaseId, item.id));
        expect(after?.properties).toEqual(item.properties);
        const automation = await runInTenant(tenantA.tenantId, () => chokePoint.readAutomationForItems([item.id]));
        expect(automation.get(item.id)?.status).toBe(status);
      }
      expect(providerCalls).toBe(3);

      const rollback = items[2];
      if (!rollback) throw new Error("Rollback fixture missing");
      found = true;
      await enqueue(rollback.id);
      workerPool.on("acquire", onAcquire);
      rejectCommits = true;
      await runOnce({ pgPool: pool, taskList: { [taskName]: task } });
      rejectCommits = false;
      expect(rejectedCommits).toBe(2);
      const after = await runInTenant(tenantA.tenantId, () => chokePoint.readAutomationForItems([rollback.id]));
      expect(after.get(rollback.id)?.status).toBe("pending");
      const sentinel = await publishSentinel(tenantA.tenantId);
      expect(await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(sentinel))))).toEqual([[], []]);
      await expectNothingReceived(b1, tenantB.tenantId);
    } catch (error) {
      failures.push(error);
    } finally {
      rejectCommits = false;
      workerPool.off("acquire", onAcquire);
      for (const [client, descriptor] of originals) {
        if (descriptor) Object.defineProperty(client, "query", descriptor);
        else Reflect.deleteProperty(client, "query");
      }
      try {
        await workerPool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Library realtime test and cleanup failed");
  });

  it("joins actual concurrent logins after an early failure and retains a later failure", async () => {
    const lateError = new Error("late held login failure");
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // Forward the real database query and delay its completion within the actual login call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = adminPool.query;
    let intercepted = false;
    adminPool.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (
          !intercepted &&
          typeof args[0] === "string" &&
          args[0].includes("FROM login_attempts") &&
          Array.isArray(args[1]) &&
          args[1][0] === tenantA.email
        ) {
          intercepted = true;
          if (!(result instanceof Promise)) throw new Error("Expected real login query promise");
          return result.then(async () => {
            reached();
            await gate;
            throw lateError;
          });
        }
        return result;
      },
    });
    const invalid = () =>
      runAsSystem("test:invalid-login", async () => {
        await login(adminPool, {
          email: `missing-${randomUUID()}@example.com`,
          password: PASSWORD,
          platform: "web",
          ip: "127.0.0.1",
        });
        throw new Error("Unexpected successful login");
      });
    let recordFirst = (_result: { error: unknown }) => {};
    const firstResult = new Promise<{ error: unknown }>((resolve) => {
      recordFirst = resolve;
    });
    const joining = joinSessionAttempts([
      () => {
        const operation = invalid();
        void operation.catch((error: unknown) => {
          recordFirst({ error });
        });
        return operation;
      },
      () => openSession(tenantA),
      () => openSession(tenantB),
    ]);
    const joined = joining.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let failure: { error: unknown } | undefined;
    let result: Awaited<typeof joined> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        held,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Held login did not reach its query")), FRAME_TIMEOUT_MS);
        }),
      ]);
      const initial = await firstResult;
      expect(initial.error).toMatchObject({ status: 401 });
      let finished = false;
      void joined.then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
    } catch (error) {
      failure = { error };
    } finally {
      if (timer) clearTimeout(timer);
      release();
      result = await joined;
      adminPool.query = original;
      if (failure && "error" in result)
        failure = {
          error: new AggregateError([failure.error, result.error], "Login control and cleanup failed", {
            cause: failure.error,
          }),
        };
    }
    if (failure) throw failure.error;
    const initial = await firstResult;
    if (!result || !("error" in result) || !(result.error instanceof AggregateError))
      throw new Error("Expected session failures");
    expect(result.error.cause).toBe(initial.error);
    expect(result.error.errors).toHaveLength(2);
    expect(result.error.errors[0]).toBe(initial.error);
    expect(result.error.errors[1]).toBe(lateError);
    expect(intercepted).toBe(true);
  });

  it("settles partial socket success, refused and held upgrades before disposal", async () => {
    const sockets = new Set<TestSocket>();
    const local = createServer();
    const upgrades = new WebSocketServer({ noServer: true });
    let heldSocket: import("node:stream").Duplex | undefined;
    let lateRejected = false;
    let releaseUpgrade = () => {};
    let heldReady = () => {};
    const heldAccepted = new Promise<void>((resolve) => {
      heldReady = resolve;
    });
    let heldClosed = () => {};
    const heldEnded = new Promise<void>((resolve) => {
      heldClosed = resolve;
    });
    local.on("upgrade", (req, socket, head) => {
      if (req.url === "/open") upgrades.handleUpgrade(req, socket, head, () => {});
      else if (req.url === "/hold") {
        heldSocket = socket;
        releaseUpgrade = () => {
          if (socket.destroyed) {
            lateRejected = true;
            return;
          }
          upgrades.handleUpgrade(req, socket, head, () => {});
        };
        socket.once("close", heldClosed);
        socket.resume();
        heldReady();
      } else socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    if (!address || typeof address === "string") throw new Error("Missing upgrade server address");
    const url = `ws://127.0.0.1:${address.port}`;
    const opened = TestSocket.connect(`${url}/open`, {}, sockets);
    const held = TestSocket.connect(`${url}/hold`, {}, sockets);
    const outcomes = [opened, held];
    const consumed = new Set<Promise<TestSocket>>();
    let joining: Promise<TestSocket[]> | undefined;
    let joiningConsumed = false;
    void Promise.allSettled(outcomes);
    let failure: { error: unknown } | undefined;
    try {
      await opened;
      await Promise.race([
        heldAccepted,
        held.then(() => {
          throw new Error("Held upgrade opened unexpectedly");
        }),
      ]);
      const refused = TestSocket.connect(`${url}/refuse`, {}, sockets);
      outcomes.push(refused);
      joining = joinSocketAttempts([opened, held, refused], sockets);
      const joined = joining.then(
        () => ({ success: true as const }),
        (error: unknown) => ({ success: false as const, error }),
      );
      const refusal = await refused.then(
        () => {
          throw new Error("Expected refused handshake");
        },
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ message: "Unexpected server response: 403" });
      const heldFailure = await held.then(
        () => {
          throw new Error("Expected held handshake cancellation");
        },
        (error: unknown) => error,
      );
      expect(heldFailure).toMatchObject({ message: "WebSocket was closed before the connection was established" });
      const outcome = await joined;
      expect(outcome.success).toBe(false);
      if (outcome.success || !(outcome.error instanceof AggregateError))
        throw new Error("Expected socket setup aggregate");
      expect(outcome.error.cause).toBe(refusal);
      expect(outcome.error.errors).toHaveLength(2);
      expect(outcome.error.errors[0]).toBe(refusal);
      expect(outcome.error.errors[1]).toBe(heldFailure);
      consumed.add(refused);
      consumed.add(held);
      joiningConsumed = true;
      heldSocket?.destroy();
      await heldEnded;
      releaseUpgrade();
      expect(lateRejected).toBe(true);
      expect(sockets.size).toBe(0);
    } catch (error) {
      failure = { error };
    } finally {
      const errors: unknown[] = [];
      heldSocket?.destroy();
      try {
        await disposeSockets(sockets);
      } catch (error) {
        errors.push(error);
      }
      const settled = await Promise.allSettled(outcomes);
      settled.forEach((result, index) => {
        const operation = outcomes[index];
        if (result.status === "rejected" && operation && !consumed.has(operation)) errors.push(result.reason);
      });
      if (joining) {
        const joined = await joining.then(
          () => ({ success: true as const }),
          (error: unknown) => ({ success: false as const, error }),
        );
        if (!joined.success && !joiningConsumed) errors.push(joined.error);
      }
      local.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => upgrades.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        errors.push(error);
      }
      try {
        await new Promise<void>((resolve, reject) => local.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const all = failure ? [failure.error, ...errors] : errors;
        failure = { error: new AggregateError(all, "Socket control and cleanup failed", { cause: all[0] }) };
      }
    }
    if (failure) throw failure.error;
  });

  it("retains a distinct socket error emitted after termination and settles its close", async () => {
    const sockets = new Set<TestSocket>();
    const bodyError = new Error("socket body failed");
    const lateError = new Error("late owned socket diagnostic");
    const socket = await TestSocket.connect(wsUrl, { Cookie: a1Cookie, Origin: baseUrl }, sockets);
    let failure: { error: unknown } | undefined;
    try {
      throw bodyError;
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await socket.dispose((owned) => {
          owned.emit("error", lateError);
        });
      } catch (error) {
        failure = failure
          ? {
              error: new AggregateError([failure.error, error], "Socket body and disposal failed", {
                cause: failure.error,
              }),
            }
          : { error };
      } finally {
        sockets.delete(socket);
        await disposeSockets(sockets);
      }
    }
    expect(failure?.error).toBeInstanceOf(AggregateError);
    if (!(failure?.error instanceof AggregateError)) throw new Error("Expected socket combined failure");
    expect(failure.error.cause).toBe(bodyError);
    expect(failure.error.errors).toHaveLength(2);
    expect(failure.error.errors[0]).toBe(bodyError);
    const cleanup: unknown = failure.error.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected socket cleanup failure");
    expect(cleanup.cause).toBe(lateError);
    expect(cleanup.errors).toHaveLength(1);
    expect(cleanup.errors[0]).toBe(lateError);
    expect(socket.closeCode).toBeDefined();
    expect(sockets.size).toBe(0);
  });

  it("retains an independent socket error during a refused handshake cleanup", async () => {
    const sockets = new Set<TestSocket>();
    const local = createServer();
    local.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    if (!address || typeof address === "string") throw new Error("Missing upgrade server address");
    const lateError = new Error("late handshake cleanup diagnostic");
    let failure: { error: unknown } | undefined;
    try {
      await TestSocket.connect(`ws://127.0.0.1:${address.port}/`, {}, sockets, (owned) => {
        owned.emit("error", lateError);
      });
      throw new Error("Expected refused handshake");
    } catch (error) {
      failure = { error };
    } finally {
      const errors: unknown[] = [];
      try {
        await disposeSockets(sockets);
      } catch (error) {
        errors.push(error);
      }
      local.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => local.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const all = failure ? [failure.error, ...errors] : errors;
        failure = { error: new AggregateError(all, "Handshake control cleanup failed", { cause: all[0] }) };
      }
    }
    expect(failure?.error).toBeInstanceOf(AggregateError);
    if (!(failure?.error instanceof AggregateError)) throw new Error("Expected handshake and cleanup failure");
    expect(failure.error.errors).toHaveLength(2);
    const handshake: unknown = failure.error.errors[0];
    expect(handshake).toMatchObject({ message: "Unexpected server response: 403" });
    expect(failure.error.cause).toBe(handshake);
    const cleanup: unknown = failure.error.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected handshake cleanup failure");
    expect(cleanup.cause).toBe(lateError);
    expect(cleanup.errors).toHaveLength(1);
    expect(cleanup.errors[0]).toBe(lateError);
    expect(sockets.size).toBe(0);
  });

  it("settles a listener delivered after cleanup starts", async () => {
    let started = () => {};
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    let delivered = false;
    const owner = ownRealtimeListener((owned, onCancel) => {
      owned.options.verify = (_client, done) => {
        onCancel(() =>
          queueMicrotask(() => {
            delivered = true;
            done();
          }),
        );
        started();
      };
    });
    const opening = owner.open();
    const settled = opening.then(
      () => {},
      () => {},
    );
    let failure: { error: unknown } | undefined;
    let cleanup: { error: unknown } | undefined;
    try {
      await Promise.race([
        verifying,
        opening.then(() => {
          throw new Error("Listener acquired before verify gate");
        }),
      ]);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owner.close();
      } catch (error) {
        cleanup = { error };
      }
      await settled;
    }
    if (failure) {
      if (cleanup)
        throw new AggregateError([failure.error, cleanup.error], "Listener control and cleanup failed", {
          cause: failure.error,
        });
      throw failure.error;
    }
    const openingResult = await opening.then(
      () => {
        throw new Error("Expected listener rejection");
      },
      (error: unknown) => error,
    );
    expect(openingResult).toBeInstanceOf(Error);
    expect(openingResult).toHaveProperty("message", "Listener closed during acquisition");
    expect(cleanup?.error).toBeInstanceOf(AggregateError);
    if (!(cleanup?.error instanceof AggregateError)) throw new Error("Expected listener cleanup failure");
    expect(cleanup.error.errors).toHaveLength(1);
    expect(cleanup.error.errors[0]).toBe(openingResult);
    expect(delivered).toBe(true);
    expect(owner.owned.totalCount).toBe(0);
    expect(owner.hasOwnedClient()).toBe(false);
  });

  it("retains a late verification failure after the listener body fails", async () => {
    const bodyError = new Error("listener observation failed");
    const verificationError = new Error("listener verification failed");
    let started = () => {};
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const owner = ownRealtimeListener((owned, onCancel) => {
      owned.options.verify = (_client, done) => {
        onCancel(() => queueMicrotask(() => done(verificationError)));
        started();
      };
    });
    const opening = owner.open();
    const result = opening.then(
      () => ({ value: true }),
      (error: unknown) => ({ error }),
    );
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        verifying,
        result.then(() => {
          throw new Error("Opening settled before gate");
        }),
      ]);
      throw bodyError;
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owner.close();
      } catch (error) {
        failure = failure
          ? {
              error: new AggregateError([failure.error, error], "Listener body and cleanup failed", {
                cause: failure.error,
              }),
            }
          : { error };
      }
    }
    const actual = await result;
    expect(actual).toHaveProperty("error", verificationError);
    expect(failure?.error).toBeInstanceOf(AggregateError);
    if (!(failure?.error instanceof AggregateError)) throw new Error("Expected combined listener failure");
    expect(failure.error.errors).toHaveLength(2);
    expect(failure.error.errors[0]).toBe(bodyError);
    expect(failure.error.cause).toBe(bodyError);
    const cleanup = failure.error.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected listener cleanup failure");
    expect(cleanup.errors).toHaveLength(1);
    expect(cleanup.errors[0]).toBe(verificationError);
    expect(cleanup.cause).toBe(verificationError);
    expect(owner.owned.totalCount).toBe(0);
    expect(owner.owned.waitingCount).toBe(0);
    expect(owner.hasOwnedClient()).toBe(false);
  });

  it("settles an owned listener and preserves simultaneous body and cleanup errors", async () => {
    const bodyFailure = new Error("body failed");
    const cleanupFailure = new Error("cancel failed");
    const owner = ownRealtimeListener((_owned, onCancel) =>
      onCancel(() => {
        throw cleanupFailure;
      }),
    );
    let failure: { error: unknown } | undefined;
    try {
      const listener = await owner.open();
      const pid = await listener.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(pid.rows[0]?.pid).toBeGreaterThan(0);
      throw bodyFailure;
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owner.close();
      } catch (error) {
        failure = failure
          ? { error: new AggregateError([failure.error, error], "Body and cleanup failed", { cause: failure.error }) }
          : { error };
      }
    }
    expect(failure?.error).toBeInstanceOf(AggregateError);
    if (!(failure?.error instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(failure.error.errors).toHaveLength(2);
    expect(failure.error.cause).toBe(bodyFailure);
    expect(failure.error.errors[0]).toBe(bodyFailure);
    expect(failure.error.errors[1]).toBeInstanceOf(AggregateError);
    const cleanup: unknown = failure.error.errors[1];
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(cleanup.errors).toHaveLength(1);
    expect(cleanup.errors[0]).toBe(cleanupFailure);
    expect(cleanup.cause).toBe(cleanupFailure);
    expect(owner.hasOwnedClient()).toBe(false);
    expect(owner.owned.totalCount).toBe(0);
  });

  it.each([false, true])(
    "aborts and settles its owned HTTP request when the response stalls (cleanup failure %s)",
    async (injectCleanup) => {
      const bodyError = new Error("HTTP control body failed");
      const cleanupError = new Error("HTTP control cleanup failed");
      let observedClose = () => {};
      const closed = new Promise<void>((resolve) => {
        observedClose = resolve;
      });
      const local = createServer((_req, res) => {
        res.on("close", observedClose);
      });
      await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
      let failure: { error: unknown } | undefined;
      try {
        const address = local.address();
        if (!address || typeof address === "string") throw new Error("Missing control server address");
        await expect(ownedPut(`http://127.0.0.1:${address.port}/`, {}, 100)).rejects.toMatchObject({
          name: "AbortError",
        });
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(() => reject(new Error("Control connection did not close")), FRAME_TIMEOUT_MS);
            void closed.finally(() => clearTimeout(timeout));
          }),
        ]);
        if (injectCleanup) throw bodyError;
      } catch (error) {
        failure = { error };
      } finally {
        observedClose();
        local.closeAllConnections();
        try {
          await new Promise<void>((resolve, reject) => local.close((error) => (error ? reject(error) : resolve())));
          if (injectCleanup) await Promise.reject(cleanupError);
        } catch (error) {
          failure = failure
            ? {
                error: new AggregateError([failure.error, error], "HTTP control and cleanup failed", {
                  cause: failure.error,
                }),
              }
            : { error };
        }
      }
      if (injectCleanup) {
        expect(failure?.error).toBeInstanceOf(AggregateError);
        if (!(failure?.error instanceof AggregateError)) throw new Error("Expected HTTP cleanup failure");
        expect(failure.error.cause).toBe(bodyError);
        expect(failure.error.errors).toHaveLength(2);
        expect(failure.error.errors[0]).toBe(bodyError);
        expect(failure.error.errors[1]).toBe(cleanupError);
      } else if (failure) {
        // Preserve both the original failure and any owned-server cleanup failure.
        throw failure.error;
      }
    },
  );

  it.each([
    "normal",
    "held-disposal",
    "failed-disposal",
    "observation-failure",
    "client-failure",
    "observation-primary",
    "client-primary",
  ] as const)(
    "publishes a linked REST relation invalidation with the authenticated actor and tenant (%s)",
    async (control) => {
      const { source, target, property } = await runInTenant(tenantA.tenantId, async () => {
        const source = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
        const target = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: tenantA.databaseId,
          targetDatabaseId: tenantA.databaseId,
          key: `linked${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          name: "Linked",
          cardinality: "many_to_many",
        });
        await withTransaction(pool, (client) =>
          insertValueLink(client, { itemId: source.id, propertyKey: property.key, ruleKey: "test", sources: [] }),
        );
        return { source, target, property };
      });
      const setupSentinel = await publishSentinel(tenantA.tenantId);
      await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(setupSentinel))));
      const listenerOwner = ownRealtimeListener();
      let listener: PoolClient | undefined;
      let failure: { error: unknown } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onNotification: ((message: { channel: string; payload?: string }) => void) | undefined;
      let cancelObservation: (() => void) | undefined;
      const observationCancelled = new Error("Observation cancelled");
      const observationBodyFailure = new Error("Observation body failed");
      const clientBodyFailure = new Error("HTTP observation body failed");
      let lateClientResult: { ok: true; value: number } | { ok: false; error: unknown } | undefined;
      let observationResult: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
      let observationConsumed = false;
      let requestServer: Server | undefined;
      const marker = randomUUID();
      const requests: Array<{ task?: Promise<void> }> = [];
      let gateEntered = () => {};
      let releaseGate = () => {};
      const admitted = new Promise<void>((resolve) => {
        gateEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let releasePublication = () => {};
      const publicationGate = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      let holdFirstPublication = true;
      const failedIds = [randomUUID(), randomUUID()];
      const injectedFailures = [new Error("first publication"), new Error("second publication")];
      const releaseFailures: Array<() => void> = [];
      const failureGates = failedIds.map(() => new Promise<void>((resolve) => releaseFailures.push(resolve)));
      const enteredFailures: Array<() => void> = [];
      const entered = failedIds.map(() => new Promise<void>((resolve) => enteredFailures.push(resolve)));
      let settlePublications = async () => {};
      let publicationProbe: Promise<void> | undefined;
      let disposalReachedPublications = () => {};
      const disposalAtPublications = new Promise<void>((resolve) => {
        disposalReachedPublications = resolve;
      });
      const boundedSignal = async (signal: Promise<unknown>): Promise<void> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            signal,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Publication control timed out")), FRAME_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      };
      let disposal: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        if (disposal) return disposal;
        disposal = (async () => {
          releaseGate();
          const cleanupErrors: unknown[] = [];
          try {
            if (requestServer) {
              requestServer.closeIdleConnections();
              await new Promise<void>((resolve, reject) =>
                requestServer?.close((error) => (error ? reject(error) : resolve())),
              );
            }
          } catch (error) {
            cleanupErrors.push(error);
          }
          for (const request of requests) {
            try {
              if (!request.task) {
                cleanupErrors.push(new Error("Owned request was not started"));
                continue;
              }
              await request.task;
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          try {
            await publicationProbe;
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            disposalReachedPublications();
            await settlePublications();
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (timer) clearTimeout(timer);
          if (onNotification) listener?.removeListener("notification", onNotification);
          cancelObservation?.();
          if (observationResult) {
            const outcome = await observationResult;
            if (
              !outcome.ok &&
              !observationConsumed &&
              outcome.error !== observationCancelled &&
              !(failure !== undefined && failure.error === outcome.error)
            )
              cleanupErrors.push(outcome.error);
          }
          try {
            await listenerOwner.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (cleanupErrors.length) {
            const errors = failure ? [failure.error, ...cleanupErrors] : cleanupErrors;
            failure = {
              error: new AggregateError(errors, "Realtime observation and cleanup failed", { cause: errors[0] }),
            };
          }
        })();
        return disposal;
      };
      try {
        const actualAdapter = adapterRouteModule.createAdapterRequestListener;
        vi.spyOn(adapterRouteModule, "createAdapterRequestListener").mockImplementation((...args) => {
          const actual = actualAdapter(...args);
          return (req, res) => {
            if (req.headers["x-test-owner"] !== marker) return actual(req, res);
            const entry: { task?: Promise<void> } = {};
            requests.push(entry);
            const task = actual(req, res);
            entry.task = task;
            void task.catch(() => {});
            return task;
          };
        });
        const actualItems = itemRoutesModule.createItemRoutes;
        vi.spyOn(itemRoutesModule, "createItemRoutes").mockImplementation((...args) =>
          actualItems(...args).map((route) => {
            if (route.method !== "PUT" || route.path !== "/api/items/:id/relations/:propertyKey/:targetItemId")
              return route;
            const actual = route.handler;
            return {
              ...route,
              handler: async (context) => {
                if (context.req.headers["x-test-gate"] === marker) {
                  gateEntered();
                  await gate;
                }
                return actual(context);
              },
            };
          }),
        );
        const dispatcher = await createDispatcher(pool, {
          passwordResetMailer: noopMailer,
          appBaseUrl: "http://localhost",
          setupToken: "unused-setup-token",
          moduleRegistry,
          blobStorage: new LocalFsBlobStorageWriter(blobDir ?? ""),
          maxFileSizeBytes: 10 * 1024 * 1024,
        });
        requestServer = createServer(dispatcher);
        await new Promise<void>((resolve) => requestServer?.listen(0, "127.0.0.1", resolve));
        const requestAddress = requestServer.address();
        if (!requestAddress || typeof requestAddress === "string") throw new Error("Missing owned request server");
        const requestBase = `http://127.0.0.1:${requestAddress.port}`;
        listener = await listenerOwner.open();
        const activeListener = listener;
        const observed = new Promise<unknown>((resolve, reject) => {
          cancelObservation = () => reject(observationCancelled);
          timer = setTimeout(() => reject(new Error("Timed out waiting for linked relation event")), FRAME_TIMEOUT_MS);
          onNotification = (notification) => {
            if (notification.channel !== "semprec_events" || !notification.payload) return;
            try {
              const payload: unknown = JSON.parse(notification.payload);
              if (
                !isRecord(payload) ||
                !isRecord(payload.message) ||
                payload.message.scope !== "item" ||
                payload.message.itemId !== source.id
              )
                return;
              resolve(payload);
            } catch (error) {
              reject(error instanceof Error ? error : new Error("Invalid notification"));
            }
          };
          activeListener.on("notification", onNotification);
        });
        observationResult = observed.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const querySpy = vi.spyOn(pool, "query");
        const publications: Array<Promise<{ ok: true } | { ok: false; error: unknown }>> = [];
        let settledPublicationCount = 0;
        // The proxy forwards the original receiver to preserve the pool method's binding.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        pool.query = new Proxy(pool.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (typeof args[0] === "string" && args[0].includes("pg_notify")) {
              if (!(result instanceof Promise)) throw new Error("Expected asynchronous publication");
              const values: unknown = args[1];
              const payload = Array.isArray(values) && typeof values[1] === "string" ? values[1] : "";
              const failingIndex =
                control === "failed-disposal" ? failedIds.findIndex((id) => payload.includes(id)) : -1;
              const forwarded =
                failingIndex >= 0
                  ? result.then(async () => {
                      enteredFailures[failingIndex]?.();
                      await failureGates[failingIndex];
                      const injected = injectedFailures[failingIndex];
                      if (!injected) throw new Error("Missing injected publication failure");
                      throw injected;
                    })
                  : holdFirstPublication
                    ? result.then(async (value: unknown) => {
                        await publicationGate;
                        return value;
                      })
                    : result;
              holdFirstPublication = false;
              publications.push(
                forwarded.then(
                  () => ({ ok: true as const }),
                  (error: unknown) => ({ ok: false as const, error }),
                ),
              );
              return forwarded;
            }
            return result;
          },
        });
        const publicationsFor = (scope: "item" | "relation", itemId: string): Record<string, unknown>[] => {
          const messages: Record<string, unknown>[] = [];
          for (const call of querySpy.mock.calls) {
            const args: readonly unknown[] = call;
            if (typeof args[0] !== "string" || !args[0].includes("pg_notify") || !Array.isArray(args[1])) continue;
            const values: unknown[] = args[1];
            if (values[0] !== "semprec_events" || typeof values[1] !== "string") continue;
            const value: unknown = JSON.parse(values[1]);
            if (isRecord(value) && value.type === "invalidation" && value.scope === scope && value.itemId === itemId)
              messages.push(value);
          }
          return messages;
        };
        const itemPublications = (itemId: string) => publicationsFor("item", itemId);
        settlePublications = async () => {
          const errors: unknown[] = [];
          while (settledPublicationCount < publications.length) {
            const end = publications.length;
            const outcomes = await Promise.all(publications.slice(settledPublicationCount, end));
            settledPublicationCount = end;
            for (const outcome of outcomes) if (!outcome.ok) errors.push(outcome.error);
          }
          if (errors.length) throw new AggregateError(errors, "Publication failed", { cause: errors[0] });
        };
        const causalBarrier = async (itemId: string): Promise<void> => {
          await settlePublications();
          const marker = randomUUID();
          let sentinelTimer: ReturnType<typeof setTimeout> | undefined;
          const forbiddenEnvelopes: unknown[] = [];
          let removeSentinel: (() => void) | undefined;
          let cancelSentinel: (() => void) | undefined;
          const sentinelCancelled = new Error("Sentinel observation cancelled");
          let sentinelFailure: { error: unknown } | undefined;
          const seen = new Promise<void>((resolve, reject) => {
            cancelSentinel = () => reject(sentinelCancelled);
            sentinelTimer = setTimeout(() => reject(new Error("Sentinel observation timed out")), FRAME_TIMEOUT_MS);
            const handler = (message: { channel: string; payload?: string }) => {
              if (message.channel !== "semprec_events" || !message.payload) return;
              try {
                const envelope: unknown = JSON.parse(message.payload);
                if (!isRecord(envelope) || !isRecord(envelope.message)) throw new Error("Invalid realtime envelope");
                if (envelope.message.itemId === itemId && envelope.message.op === "update")
                  forbiddenEnvelopes.push(envelope);
                if (envelope.message.databaseId === marker) resolve();
              } catch (error) {
                reject(error instanceof Error ? error : new Error("Invalid sentinel"));
              }
            };
            activeListener.on("notification", handler);
            removeSentinel = () => activeListener.removeListener("notification", handler);
          });
          const settled = seen.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          try {
            await runInTenant(tenantA.tenantId, () =>
              publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId: marker }),
            );
            await seen;
            expect(forbiddenEnvelopes).toEqual([]);
            const frames = await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(marker))));
            for (const stream of frames) {
              expect(
                stream.filter(
                  (frame) =>
                    frame.kind === "text" &&
                    frame.type === "invalidate" &&
                    frame.body.itemId === itemId &&
                    frame.body.op === "update",
                ),
              ).toEqual([]);
            }
            await expectNothingReceived(b1, tenantB.tenantId);
          } catch (error) {
            sentinelFailure = { error };
          } finally {
            if (sentinelTimer) clearTimeout(sentinelTimer);
            removeSentinel?.();
            cancelSentinel?.();
            const outcome = await settled;
            if (!outcome.ok && outcome.error !== sentinelCancelled && outcome.error !== sentinelFailure?.error) {
              sentinelFailure = sentinelFailure
                ? {
                    error: new AggregateError(
                      [sentinelFailure.error, outcome.error],
                      "Sentinel body and observation failed",
                      { cause: sentinelFailure.error },
                    ),
                  }
                : { error: outcome.error };
            }
          }
          if (sentinelFailure) throw sentinelFailure.error;
        };
        const url = `${requestBase}/api/items/${source.id}/relations/${property.key}/${target.id}`;
        const headers = { Cookie: a1Cookie, Origin: requestBase, "x-test-owner": marker };
        if (control === "observation-failure" || control === "observation-primary") {
          releasePublication();
          await runInTenant(tenantA.tenantId, () =>
            pool.query<{ pg_notify: string }>("SELECT pg_notify($1, $2)", ["semprec_events", "{"]),
          );
          const outcome = await observationResult;
          expect(outcome.ok).toBe(false);
          if (outcome.ok) throw new Error("Expected real observation failure");
          expect(outcome.error).toBeInstanceOf(SyntaxError);
          if (control === "observation-primary") await observed;
          throw observationBodyFailure;
        }
        expect(await ownedPut(url, headers)).toBe(200);
        expect(requests).toHaveLength(1);
        await requests[0]?.task;
        expect(await observed).toMatchObject({
          tenantId: tenantA.tenantId,
          message: { type: "invalidation", scope: "item", itemId: source.id, userId: tenantA.userId },
        });
        observationConsumed = true;
        expect(itemPublications(source.id)).toEqual([expect.objectContaining({ userId: tenantA.userId })]);
        expect(publicationsFor("relation", source.id)).toEqual([
          {
            type: "invalidation",
            scope: "relation",
            databaseId: tenantA.databaseId,
            itemId: source.id,
            propertyKey: property.key,
            op: "put",
            userId: tenantA.userId,
          },
        ]);
        expect(publicationsFor("relation", target.id)).toEqual([
          {
            type: "invalidation",
            scope: "relation",
            databaseId: tenantA.databaseId,
            itemId: target.id,
            propertyKey: null,
            op: "put",
            userId: tenantA.userId,
          },
        ]);
        querySpy.mockClear();
        if (control === "held-disposal") {
          let finished = false;
          const disposing = dispose().then(() => {
            finished = true;
          });
          void disposing.catch(() => {});
          try {
            await boundedSignal(disposalAtPublications);
            expect(finished).toBe(false);
            expect(activeListener.listenerCount("notification")).toBeGreaterThan(0);
          } finally {
            releasePublication();
            await disposing;
          }
          expect(finished).toBe(true);
          if (failure) throw failure.error;
          return;
        }
        if (control === "failed-disposal") {
          releasePublication();
          const publishFailure = (databaseId: string) =>
            runInTenant(tenantA.tenantId, () =>
              publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId }),
            ).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          const [firstId, secondId] = failedIds;
          const [firstEntered, secondEntered] = entered;
          if (!firstId || !secondId || !firstEntered || !secondEntered) throw new Error("Missing publication control");
          const attempts = [publishFailure(firstId)];
          let disposing: Promise<void> | undefined;
          try {
            await boundedSignal(firstEntered);
            attempts.push(publishFailure(secondId));
            await boundedSignal(secondEntered);
            disposing = dispose();
            void disposing.catch(() => {});
            await boundedSignal(disposalAtPublications);
            releaseFailures[0]?.();
            const first = await attempts[0];
            expect(first?.ok).toBe(false);
            if (first && !first.ok) expect(first.error).toBe(injectedFailures[0]);
            let finished = false;
            void disposing.then(() => {
              finished = true;
            });
            await Promise.resolve();
            expect(finished).toBe(false);
            expect(activeListener.listenerCount("notification")).toBeGreaterThan(0);
          } finally {
            for (const release of releaseFailures) release();
            await Promise.all(attempts);
            await disposing;
          }
          const error = failure?.error;
          expect(error).toBeInstanceOf(AggregateError);
          if (!(error instanceof AggregateError)) throw new Error("Expected cleanup failure");
          const publicationsError: unknown = error.errors[0];
          expect(publicationsError).toBeInstanceOf(AggregateError);
          if (!(publicationsError instanceof AggregateError)) throw new Error("Expected publication failures");
          expect(error.cause).toBe(publicationsError);
          expect(publicationsError.errors).toHaveLength(2);
          expect(publicationsError.errors[0]).toBe(injectedFailures[0]);
          expect(publicationsError.errors[1]).toBe(injectedFailures[1]);
          expect(publicationsError.cause).toBe(injectedFailures[0]);
          const second = await attempts[1];
          expect(second?.ok).toBe(false);
          if (second && !second.ok) expect(second.error).toBe(injectedFailures[1]);
          expect(activeListener.listenerCount("notification")).toBe(0);
          failure = undefined;
          return;
        }
        let publicationSettled = false;
        const waitingPublication = settlePublications().then(() => {
          publicationSettled = true;
        });
        publicationProbe = waitingPublication;
        void waitingPublication.catch(() => {});
        await Promise.resolve();
        expect(publicationSettled).toBe(false);
        expect(activeListener.listenerCount("notification")).toBeGreaterThan(0);
        releasePublication();
        try {
          await waitingPublication;
        } finally {
          publicationProbe = undefined;
        }
        await expectInvalidationInA({ scope: "item", itemId: source.id, op: "update" });
        expect(await ownedPut(url, headers)).toBe(200);
        expect(requests).toHaveLength(2);
        await requests[1]?.task;
        await causalBarrier(source.id);
        expect(itemPublications(source.id)).toEqual([]);

        const heldSource = await runInTenant(tenantA.tenantId, async () => {
          const item = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
          await withTransaction(pool, (client) =>
            insertValueLink(client, {
              itemId: item.id,
              propertyKey: property.key,
              ruleKey: "test",
              sources: [],
            }),
          );
          return item;
        });
        await causalBarrier(heldSource.id);
        querySpy.mockClear();
        const controller = new AbortController();
        if (control === "client-primary") controller.abort();
        const heldRequest = ownedPut(
          `${requestBase}/api/items/${heldSource.id}/relations/${property.key}/${target.id}`,
          { ...headers, "x-test-gate": marker },
          FRAME_TIMEOUT_MS,
          controller,
        );
        const heldSettled = heldRequest.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let heldFailure: { error: unknown } | undefined;
        let heldConsumed = false;
        try {
          await Promise.race([
            admitted,
            heldRequest.then(() => {
              throw new Error("Request finished before admission");
            }),
          ]);
          expect(requests).toHaveLength(3);
          const serverTask = requests[2]?.task;
          if (!serverTask) throw new Error("Missing owned server completion");
          if (control === "client-failure") throw clientBodyFailure;
          controller.abort();
          const expected = await heldSettled;
          expect(expected.ok).toBe(false);
          if (expected.ok) throw new Error("Expected aborted client request");
          expect(expected.error).toMatchObject({ name: "AbortError" });
          heldConsumed = true;
          let completed = false;
          void serverTask.then(
            () => {
              completed = true;
            },
            () => {
              completed = true;
            },
          );
          await Promise.resolve();
          expect(completed).toBe(false);
          releaseGate();
          await serverTask;
          await settlePublications();
          expect(completed).toBe(true);
          expect(
            (await runInTenant(tenantA.tenantId, () => chokePoint.getValueLinksForItems([heldSource.id]))).get(
              heldSource.id,
            )?.[property.key],
          ).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
          expect(itemPublications(heldSource.id)).toEqual([expect.objectContaining({ userId: tenantA.userId })]);
          await expectInvalidationInA({ scope: "item", itemId: heldSource.id, op: "update" });
        } catch (error) {
          heldFailure = { error };
        } finally {
          controller.abort();
          releaseGate();
          lateClientResult = await heldSettled;
          if (
            !lateClientResult.ok &&
            !heldConsumed &&
            !(heldFailure !== undefined && heldFailure.error === lateClientResult.error)
          ) {
            heldFailure = heldFailure
              ? {
                  error: new AggregateError(
                    [heldFailure.error, lateClientResult.error],
                    "HTTP body and client failed",
                    { cause: heldFailure.error },
                  ),
                }
              : { error: lateClientResult.error };
          }
        }
        if (heldFailure) throw heldFailure.error;
        const unauthorized = await ownedPut(`${requestBase}/api/items/${randomUUID()}/relations/x/${randomUUID()}`, {
          Origin: requestBase,
          "x-test-owner": marker,
        });
        expect(unauthorized).toBe(401);
        expect(requests).toHaveLength(4);
        await requests[3]?.task;

        const rollbackSource = await runInTenant(tenantA.tenantId, async () => {
          const item = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
          await chokePoint.createRelation({
            relationPropertyId: property.id,
            callerItemId: item.id,
            targetItemId: target.id,
          });
          await withTransaction(pool, (client) =>
            insertValueLink(client, {
              itemId: item.id,
              propertyKey: property.key,
              ruleKey: "test",
              sources: [],
            }),
          );
          return item;
        });
        await causalBarrier(rollbackSource.id);
        querySpy.mockClear();
        const rollbackFailure = new Error("rollback relation invalidation");
        await expect(
          runInTenant(tenantA.tenantId, () =>
            withTransaction(pool, async (client) => {
              await deleteRelationWithClient(
                client,
                {
                  relationPropertyId: property.id,
                  callerItemId: rollbackSource.id,
                  targetItemId: target.id,
                },
                undefined,
                { writerKind: "user" },
                tenantA.userId,
              );
              throw rollbackFailure;
            }),
          ),
        ).rejects.toBe(rollbackFailure);
        await causalBarrier(rollbackSource.id);
        expect(itemPublications(rollbackSource.id)).toEqual([]);
        expect(
          (await runInTenant(tenantA.tenantId, () => chokePoint.getValueLinksForItems([rollbackSource.id]))).get(
            rollbackSource.id,
          )?.[property.key],
        ).toMatchObject({ valueKind: "inherited", brokenBy: null });
        const background = await runInTenant(tenantA.tenantId, async () => {
          const item = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
          await withTransaction(pool, (client) =>
            insertValueLink(client, {
              itemId: item.id,
              propertyKey: property.key,
              ruleKey: "test",
              sources: [],
            }),
          );
          return item;
        });
        await causalBarrier(background.id);
        querySpy.mockClear();
        let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
        let backgroundHandler: ((message: { channel: string; payload?: string }) => void) | undefined;
        let cancelBackground: (() => void) | undefined;
        const backgroundCancelled = new Error("Background observation cancelled");
        let backgroundFailure: { error: unknown } | undefined;
        const backgroundEvent = new Promise<unknown>((resolve, reject) => {
          cancelBackground = () => reject(backgroundCancelled);
          backgroundTimer = setTimeout(() => reject(new Error("Background observation timed out")), FRAME_TIMEOUT_MS);
          backgroundHandler = (notification) => {
            if (notification.channel !== "semprec_events" || !notification.payload) return;
            try {
              const envelope: unknown = JSON.parse(notification.payload);
              if (
                isRecord(envelope) &&
                isRecord(envelope.message) &&
                envelope.message.scope === "item" &&
                envelope.message.itemId === background.id &&
                envelope.message.op === "update"
              )
                resolve(envelope);
            } catch (error) {
              reject(error instanceof Error ? error : new Error("Invalid background envelope"));
            }
          };
          activeListener.on("notification", backgroundHandler);
        });
        const backgroundSettled = backgroundEvent.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await runInTenant(tenantA.tenantId, () =>
            chokePoint.createRelation(
              {
                relationPropertyId: property.id,
                callerItemId: background.id,
                targetItemId: target.id,
              },
              { writerKind: "user" },
            ),
          );
          expect(itemPublications(background.id)).toEqual([
            expect.objectContaining({ scope: "item", itemId: background.id, op: "update" }),
          ]);
          expect(itemPublications(background.id)[0]).not.toHaveProperty("userId");
          const envelope = await backgroundEvent;
          expect(envelope).toMatchObject({
            tenantId: tenantA.tenantId,
            message: { itemId: background.id, op: "update" },
          });
          if (!isRecord(envelope) || !isRecord(envelope.message)) throw new Error("Invalid background envelope");
          expect(envelope.message).not.toHaveProperty("userId");
          expect(
            (await runInTenant(tenantA.tenantId, () => chokePoint.getValueLinksForItems([background.id]))).get(
              background.id,
            )?.[property.key],
          ).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
          await expectInvalidationInA({ scope: "item", itemId: background.id, op: "update" });
        } catch (error) {
          backgroundFailure = { error };
        } finally {
          if (backgroundTimer) clearTimeout(backgroundTimer);
          if (backgroundHandler) activeListener.removeListener("notification", backgroundHandler);
          cancelBackground?.();
          const outcome = await backgroundSettled;
          if (!outcome.ok && outcome.error !== backgroundCancelled && outcome.error !== backgroundFailure?.error) {
            backgroundFailure = backgroundFailure
              ? {
                  error: new AggregateError(
                    [backgroundFailure.error, outcome.error],
                    "Background body and observation failed",
                    { cause: backgroundFailure.error },
                  ),
                }
              : { error: outcome.error };
          }
        }
        if (backgroundFailure) throw backgroundFailure.error;
      } catch (error) {
        failure =
          failure && failure.error !== error
            ? {
                error: new AggregateError([error, failure.error], "Realtime observation and cleanup failed", {
                  cause: error,
                }),
              }
            : { error };
      } finally {
        releasePublication();
        for (const release of releaseFailures) release();
        await dispose();
      }
      if (control === "client-primary") {
        if (!lateClientResult || lateClientResult.ok) throw new Error("Expected primary client failure");
        expect(lateClientResult.error).toMatchObject({ name: "AbortError" });
        expect(failure).toBeDefined();
        expect(failure?.error).toBe(lateClientResult.error);
        expect(listener?.listenerCount("notification")).toBe(0);
        expect(listenerOwner.hasOwnedClient()).toBe(false);
        return;
      }
      if (control === "observation-primary") {
        if (!observationResult) throw new Error("Missing observation result");
        const outcome = await observationResult;
        if (outcome.ok) throw new Error("Expected primary observation failure");
        expect(outcome.error).toBeInstanceOf(SyntaxError);
        expect(failure).toBeDefined();
        expect(failure?.error).toBe(outcome.error);
        expect(listener?.listenerCount("notification")).toBe(0);
        expect(listenerOwner.hasOwnedClient()).toBe(false);
        return;
      }
      if (control === "client-failure") {
        if (!lateClientResult || lateClientResult.ok) throw new Error("Expected late client failure");
        expect(lateClientResult.error).toMatchObject({ name: "AbortError" });
        expect(failure?.error).toBeInstanceOf(AggregateError);
        if (!(failure?.error instanceof AggregateError)) throw new Error("Expected client cleanup failure");
        expect(failure.error.cause).toBe(clientBodyFailure);
        expect(failure.error.errors).toHaveLength(2);
        expect(failure.error.errors[0]).toBe(clientBodyFailure);
        expect(failure.error.errors[1]).toBe(lateClientResult.error);
        expect(listener?.listenerCount("notification")).toBe(0);
        expect(listenerOwner.hasOwnedClient()).toBe(false);
        return;
      }
      if (control === "observation-failure") {
        if (!observationResult) throw new Error("Missing observation result");
        const outcome = await observationResult;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("Expected real observation failure");
        expect(outcome.error).toBeInstanceOf(SyntaxError);
        expect(failure?.error).toBeInstanceOf(AggregateError);
        if (!(failure?.error instanceof AggregateError)) throw new Error("Expected observation cleanup failure");
        expect(failure.error.cause).toBe(observationBodyFailure);
        expect(failure.error.errors).toHaveLength(2);
        expect(failure.error.errors[0]).toBe(observationBodyFailure);
        expect(failure.error.errors[1]).toBe(outcome.error);
        expect(listener?.listenerCount("notification")).toBe(0);
        expect(listenerOwner.hasOwnedClient()).toBe(false);
        return;
      }
      if (failure) {
        // Preserve the original failure rather than replacing it with a timeout wrapper.
        throw failure.error;
      }
    },
  );

  it("delivers committed approval resolution to its user's sockets, with no replay or rollback event", async () => {
    async function createApprovalNotification(): Promise<{ requestId: string; notificationId: string }> {
      const request = await runInTenant(tenantA.tenantId, () =>
        createPendingApprovalRequest(pool, {
          agentRunId: tenantA.runId,
          toolName: "search",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        }),
      );
      const notificationId = await runInTenant(tenantA.tenantId, () =>
        withTransaction(pool, (client) =>
          writeNotification(client, {
            userId: tenantA.userId,
            kind: "approval_pending",
            linkHref: null,
            sourceTable: "approval_requests",
            sourceId: request.id,
            transitionInstance: "pending",
          }),
        ),
      );
      const matches = (frame: Frame) =>
        frame.kind === "text" &&
        frame.type === "notification" &&
        isRecord(frame.body.notification) &&
        frame.body.notification.id === notificationId;
      await Promise.all([a1.nextMatching(matches), a2.nextMatching(matches)]);
      await expectNothingReceived(b1, tenantB.tenantId);
      return { requestId: request.id, notificationId };
    }
    async function decideOverHttp(id: string): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { Cookie: a1Cookie, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
    }
    const foreignId = await runInTenant(tenantB.tenantId, () =>
      withTransaction(pool, (client) =>
        writeNotification(client, {
          userId: tenantB.userId,
          kind: "approval_pending",
          linkHref: null,
          sourceTable: "approval_requests",
          sourceId: randomUUID(),
          transitionInstance: "pending",
        }),
      ),
    );
    await b1.nextMatching(
      (frame) =>
        frame.kind === "text" &&
        frame.type === "notification" &&
        isRecord(frame.body.notification) &&
        frame.body.notification.id === foreignId,
    );
    const first = await createApprovalNotification();
    // The real hook invokes this same wired pool synchronously from the after-commit callback.
    const querySpy = vi.spyOn(pool, "query");
    function readStatePublications(): Record<string, unknown>[] {
      const messages: Record<string, unknown>[] = [];
      for (const call of querySpy.mock.calls) {
        const args: readonly unknown[] = call;
        if (typeof args[0] !== "string" || !args[0].includes("pg_notify") || !Array.isArray(args[1])) continue;
        const values: unknown[] = args[1];
        if (values[0] !== "semprec_events" || typeof values[1] !== "string") continue;
        const value: unknown = JSON.parse(values[1]);
        if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid realtime publication");
        if (value.type === "notification_read_state") {
          if (
            typeof value.userId !== "string" ||
            !Array.isArray(value.notificationIds) ||
            !value.notificationIds.every((id: unknown) => typeof id === "string")
          ) {
            throw new Error("Invalid read-state publication");
          }
          messages.push(value);
        }
      }
      return messages;
    }
    expect((await decideOverHttp(first.requestId)).status).toBe(200);
    expect(readStatePublications()).toEqual([
      expect.objectContaining({
        type: "notification_read_state",
        userId: tenantA.userId,
        notificationIds: [first.notificationId],
      }),
    ]);
    const matchesResolved = (frame: Frame) =>
      frame.kind === "text" &&
      frame.type === "notification" &&
      isRecord(frame.body.notification) &&
      frame.body.notification.id === first.notificationId;
    const frames = await Promise.all([a1.nextMatching(matchesResolved), a2.nextMatching(matchesResolved)]);
    for (const frame of frames) {
      expect(frame).toMatchObject({
        body: {
          notification: { id: first.notificationId, readAt: expect.any(String), resolvedAt: expect.any(String) },
        },
      });
    }
    await expectNothingReceived(b1, tenantB.tenantId);
    expect(await runInTenant(tenantB.tenantId, () => getNotificationById(pool, foreignId))).toMatchObject({
      id: foreignId,
      readAt: null,
      resolvedAt: null,
    });
    querySpy.mockClear();
    expect((await decideOverHttp(first.requestId)).status).toBe(200);
    expect(readStatePublications()).toEqual([]);

    const rollback = await createApprovalNotification();
    querySpy.mockClear();
    await expect(
      runInTenant(tenantA.tenantId, () =>
        withTransaction(pool, async (client) => {
          const result = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: rollback.requestId,
            decidedByUserId: tenantA.userId,
            decision: "rejected",
          });
          expect(result?.outcome).toBe("decided");
          throw new Error("intentional rollback");
        }),
      ),
    ).rejects.toThrow("intentional rollback");
    const unchanged = await runInTenant(tenantA.tenantId, () => getNotificationById(pool, rollback.notificationId));
    expect(unchanged).toMatchObject({ readAt: null, resolvedAt: null });
    expect(readStatePublications()).toEqual([]);
    expect(await runInTenant(tenantB.tenantId, () => getNotificationById(pool, foreignId))).toMatchObject({
      id: foreignId,
      readAt: null,
      resolvedAt: null,
    });
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
