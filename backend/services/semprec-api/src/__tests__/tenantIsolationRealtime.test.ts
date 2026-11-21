import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WebSocket, type RawData } from "ws";
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
import * as itemRoutesModule from "../itemsHandler.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";

/**
 * Two-tenant proof of the realtime surface (`WS /api/sync`) over the composition `serve.ts` builds, on
 * runtime-role pools with strict tenant-scope enforcement.
 *
 * Absence is proven without sleeping: a sentinel event is published in the checked socket's own tenant, and
 * NOTIFYs arrive over the single LISTEN connection in commit order, so anything a NOTIFY caused arrives first.
 * The doc invalidation is the exception (sent after the server re-reads the doc, up to a second late), so
 * consumers set aside such a frame of the socket's own tenant (`nextSettingAsideOwnDocEcho`).
 *
 * Frames a socket sends are not ordered against that connection: the foreign frame is sent before an own
 * request whose reply is awaited, so a leaked reply is produced first. `docSync.handleBinaryFrame` checks
 * the subscription before its first `await`, so a binary frame is decided synchronously at dispatch.
 */

const PASSWORD = "s3cret-password";
const FRAME_TIMEOUT_MS = 5_000;
const YJS_UPDATE_MESSAGE = 2;
const ROLLBACK = "rolled back by the test";

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

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

class TestSocket {
  private readonly queue: Frame[] = [];
  private wake: (() => void) | null = null;
  private readonly errors: Error[] = [];
  private readonly onError = (error: Error) => {
    this.errors.push(error);
  };
  readonly closed: Promise<number>;
  ownTenantId: string | undefined;

  private constructor(private readonly ws: WebSocket) {
    ws.on("error", this.onError);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      this.queue.push(parseFrame(data, isBinary));
      this.wake?.();
    });
    this.closed = new Promise<number>((resolve) => {
      ws.once("close", (code: number) => {
        resolve(code);
        this.wake?.();
      });
    });
  }

  /** The socket is owned by `ownedSockets` once open; a refused handshake is closed here and rethrown. */
  static async connect(url: string, headers: Record<string, string>): Promise<TestSocket> {
    const ws = new WebSocket(url, { headers });
    const socket = new TestSocket(ws);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        timer = setTimeout(() => ws.terminate(), FRAME_TIMEOUT_MS);
      });
    } catch (error) {
      ws.terminate();
      await socket.closed;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    ownedSockets.add(socket);
    return socket;
  }

  async dispose(): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    await this.closed;
    this.ws.removeListener("error", this.onError);
    if (this.errors.length) throw new AggregateError(this.errors, "Owned socket failed", { cause: this.errors[0] });
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

  async nextMatching(predicate: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const frame = await this.next();
      if (predicate(frame)) return frame;
    }
  }

  /**
   * The writer announces a doc update after commit without being awaited, so an earlier case's echo is not
   * ordered against a sentinel or reply. It is dropped only after the admin pool confirms the item belongs to
   * the socket's tenant; another tenant's doc invalidation is returned like every other frame.
   */
  async nextSettingAsideOwnDocEcho(): Promise<Frame> {
    for (;;) {
      const frame = await this.next();
      if (
        this.ownTenantId !== undefined &&
        isDocInvalidation(frame) &&
        (await isItemOfTenant(frame, this.ownTenantId))
      ) {
        continue;
      }
      return frame;
    }
  }

  /** Returns the frames before the first match; own-tenant doc echoes are set aside. */
  async drainUntil(predicate: (frame: Frame) => boolean): Promise<Frame[]> {
    const before: Frame[] = [];
    for (;;) {
      const frame = await this.nextSettingAsideOwnDocEcho();
      if (predicate(frame)) return before;
      before.push(frame);
    }
  }
}

function matches(body: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => body[key] === value);
}

function isInvalidate(match: Record<string, unknown>): (frame: Frame) => boolean {
  return (frame) => frame.kind === "text" && frame.type === "invalidate" && matches(frame.body, match);
}

function isSentinel(databaseId: string): (frame: Frame) => boolean {
  return isInvalidate({ scope: "schema", databaseId });
}

function isDocFrame(docId: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === "binary" && frame.docId === docId;
}

function isDocInvalidation(frame: Frame): boolean {
  return isInvalidate({ scope: "doc" })(frame);
}

function isNotification(notificationId?: string): (frame: Frame) => boolean {
  return (frame) =>
    frame.kind === "text" &&
    frame.type === "notification" &&
    (notificationId === undefined ||
      (isRecord(frame.body.notification) && frame.body.notification.id === notificationId));
}

/** Read by the admin pool, which no tenant scope narrows. */
async function isItemOfTenant(frame: Frame, tenantId: string): Promise<boolean> {
  const itemId = frame.kind === "text" ? frame.body.itemId : undefined;
  if (typeof itemId !== "string") return false;
  const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM items WHERE id = $1", [itemId]);
  return rows[0]?.tenant_id === tenantId;
}

function isAgentEvent(runId: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === "text" && frame.type === "agent:event" && frame.body.agentRunId === runId;
}

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
  notificationId: string;
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

function dispatcherOptions() {
  return {
    passwordResetMailer: noopMailer,
    appBaseUrl: "http://localhost",
    setupToken: "unused-setup-token",
    moduleRegistry,
    blobStorage: new LocalFsBlobStorageWriter(blobDir ?? tmpdir()),
    maxFileSizeBytes: 10 * 1024 * 1024,
  };
}

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `127.0.0.1:${address.port}`;
}

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

/** A PUT with a deadline; the request is aborted once it settles or `controller` aborts. */
async function put(url: string, headers: Record<string, string>, controller = new AbortController()): Promise<number> {
  const timer = setTimeout(() => controller.abort(), FRAME_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "PUT", headers, signal: controller.signal });
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function openSession(fixture: TenantFixture): Promise<{ cookie: string; sessionId: string }> {
  // Sessions belong to the global identity tables, so they are issued as system work.
  const result = await runAsSystem("test:issue-session", () =>
    login(adminPool, { email: fixture.email, password: PASSWORD, platform: "web", ip: "127.0.0.1" }),
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${result.token}`, sessionId: result.session.id };
}

async function connect(cookie: string, fixture: TenantFixture): Promise<TestSocket> {
  const socket = await TestSocket.connect(wsUrl, { Cookie: cookie, Origin: baseUrl });
  socket.ownTenantId = fixture.tenantId;
  return socket;
}

async function disposeSockets(): Promise<void> {
  const sockets = [...ownedSockets];
  ownedSockets.clear();
  const results = await Promise.allSettled(sockets.map((socket) => socket.dispose()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Socket cleanup failed");
}

/** Settles every attempt before returning, so a failure leaves nothing in flight. */
async function settleAll<T>(attempts: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(attempts);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/** Runs `cleanup` after `body`; a cleanup failure never replaces the body's own failure. */
async function withCleanup(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  const cleanupFailure = await cleanup().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (failure && cleanupFailure) {
    throw new AggregateError([failure.error, cleanupFailure.error], "Test body and cleanup failed", {
      cause: failure.error,
    });
  }
  const only = failure ?? cleanupFailure;
  if (only) throw only.error;
}

/** Drains A's sockets up to a sentinel, consuming the frames a fixture write caused. */
async function drainA(): Promise<void> {
  const sentinel = await publishSentinel(tenantA.tenantId);
  await Promise.all([a1, a2].map((socket) => socket.drainUntil(isSentinel(sentinel))));
}

async function reconnectAll(): Promise<void> {
  await disposeSockets();
  const [sessionA1, sessionA2, sessionB1] = await settleAll([
    openSession(tenantA),
    openSession(tenantA),
    openSession(tenantB),
  ]);
  if (!sessionA1 || !sessionA2 || !sessionB1) throw new Error("Missing session");
  a1Cookie = sessionA1.cookie;
  a2SessionId = sessionA2.sessionId;
  const sockets = await settleAll([
    connect(sessionA1.cookie, tenantA),
    connect(sessionA2.cookie, tenantA),
    connect(sessionB1.cookie, tenantB),
  ]);
  const [first, second, third] = sockets;
  if (!first || !second || !third) throw new Error("Missing socket");
  [a1, a2, b1] = [first, second, third];
}

async function restPost(cookie: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(body),
  });
}

async function inboxCardsTotal(cookie: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/inbox/cards`, { headers: { Cookie: cookie, Origin: baseUrl } });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.total !== "number") throw new Error("Expected an inbox card list with a total");
  return body.total;
}

async function seededDatabaseIds(): Promise<(moduleId: string) => string> {
  const { rows } = await pool.query<{ id: string; owner_module_id: string }>(
    "SELECT id, owner_module_id FROM databases WHERE owner_module_id IS NOT NULL",
  );
  return (moduleId) => {
    const row = rows.find((candidate) => candidate.owner_module_id === moduleId);
    if (!row) throw new Error(`Database '${moduleId}' was not seeded`);
    return row.id;
  };
}

/** A `proposed` Processing proposals card made by the tick with a stubbed computation. */
async function createProposedCard(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    const idOf = await seededDatabaseIds();
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
  });
}

/** Returns the new message's thread id. */
async function ingestMessageIn(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const idOf = await seededDatabaseIds();
    const mailbox = await chokePoint.createItem({
      databaseId: idOf("mailboxes"),
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
        arrival: "live",
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

/** A schema invalidation that reaches all of the tenant's sockets. */
async function publishSentinel(tenantId: string): Promise<string> {
  const databaseId = randomUUID();
  await runInTenant(tenantId, () =>
    publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId }),
  );
  return databaseId;
}

/** One sentinel of `fixture`'s tenant reaches each socket; none of them got a matching frame before it. */
async function expectSilence(
  sockets: readonly TestSocket[],
  fixture: TenantFixture,
  predicate: (frame: Frame) => boolean = () => true,
): Promise<void> {
  const sentinel = await publishSentinel(fixture.tenantId);
  for (const socket of sockets) expect((await socket.drainUntil(isSentinel(sentinel))).filter(predicate)).toEqual([]);
}

async function expectNothingReceived(socket: TestSocket, fixture: TenantFixture): Promise<void> {
  await expectSilence([socket], fixture);
}

/** Runs `write` in one transaction of `fixture`'s tenant, rolled back afterwards when `rollBack` is set. */
async function inTenantTransaction<T>(
  fixture: TenantFixture,
  rollBack: boolean,
  write: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runInTenant(fixture.tenantId, () =>
    withTransaction(pool, async (client) => {
      const result = await write(client);
      if (rollBack) throw new Error(ROLLBACK);
      return result;
    }),
  );
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

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The very next frame must be the server's SyncStep1 for `docId`; own-tenant doc echoes are set aside. */
async function openDoc(socket: TestSocket, docId: string): Promise<void> {
  socket.sendJson({ type: "doc:open", docId });
  expect(await socket.nextSettingAsideOwnDocEcho()).toMatchObject({ kind: "binary", docId });
}

/**
 * The next frames must be exactly the replayed events; once they arrived the live subscription is registered,
 * so no later event can be missed.
 */
async function watchRun(socket: TestSocket, fixture: TenantFixture): Promise<void> {
  socket.sendJson({ type: "agent:watch", runId: fixture.runId, afterEventId: "0" });
  for (let replayed = 0; replayed < fixture.runEventCount; replayed++) {
    expect(await socket.nextSettingAsideOwnDocEcho()).toMatchObject({
      kind: "text",
      type: "agent:event",
      body: { agentRunId: fixture.runId },
    });
  }
}

function observedTypes(frames: readonly Frame[]): Observed[] {
  return frames.map((frame) => (frame.kind === "text" ? frame.type : "binary"));
}

async function nextOnA(predicate: (frame: Frame) => boolean): Promise<Frame[]> {
  return Promise.all([a1, a2].map((socket) => socket.nextMatching(predicate)));
}

/** Both of A's sockets receive a matching invalidation and B1 receives nothing. */
async function expectInvalidationInA(match: Record<string, unknown>): Promise<readonly Observed[]> {
  const frames = await nextOnA(isInvalidate(match));
  await expectNothingReceived(b1, tenantB);
  return observedTypes(frames);
}

/** Both of A's sockets receive exactly one invalidation with exactly `match`'s fields; B1 receives nothing. */
async function expectOnceToAOnly(match: Record<string, unknown>): Promise<readonly Observed[]> {
  const frames = await nextOnA(isInvalidate(match));
  for (const frame of frames) {
    expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["type", ...Object.keys(match)].sort());
  }
  await expectSilence([a1, a2], tenantA, isInvalidate({ scope: match.scope }));
  await expectNothingReceived(b1, tenantB);
  return observedTypes(frames);
}

async function expectOnlyToB(match: Record<string, unknown>): Promise<readonly Observed[]> {
  const frame = await b1.nextMatching(isInvalidate(match));
  await expectSilence([a1, a2], tenantA);
  return observedTypes([frame]);
}

/** After an inbound frame, the first frame must be B1's own doc's SyncStep1 and nothing else may precede the sentinel. */
async function observeB1AfterOpeningOwnDoc(): Promise<string[]> {
  await openDoc(b1, tenantB.docId);
  const sentinel = await publishSentinel(tenantB.tenantId);
  const rest = await b1.drainUntil(isSentinel(sentinel));
  return ["binary:own-doc", ...rest.map((frame) => frame.kind)];
}

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
  // The run's creation is announced to its actor; consuming it keeps later frames to the ones the test caused.
  await Promise.all(
    sockets.map((socket) => socket.nextMatching(isInvalidate({ scope: "agentRuns", agentRunId: created.runId }))),
  );
  return created;
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

/** These invalidations are published over separate connections, so they may arrive in any order. */
async function expectRequestAndThreadInvalidations(
  sockets: readonly TestSocket[],
  approvalRequestId: string,
  threadId: string,
  agentRunId: string,
): Promise<void> {
  const expected = [
    { scope: "approvalRequest", approvalRequestId },
    { scope: "sempThread", threadId },
    { scope: "agentRuns", agentRunId, projectItemId: null },
    { scope: "badgeCounts" },
  ];
  await Promise.all(
    sockets.map(async (socket) => {
      const pending = new Set(expected);
      while (pending.size > 0) {
        const frame = await socket.next();
        for (const match of pending) if (isInvalidate(match)(frame)) pending.delete(match);
      }
    }),
  );
}

/**
 * Records the `semprec_events` publications made through the runtime pool. The realtime hooks publish from the
 * after-commit callback without awaiting, so `settle` awaits them before a sentinel is ordered after them.
 */
function recordPublications() {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = pool.query;
  const recorded: Array<{ message: Record<string, unknown>; done: unknown }> = [];
  pool.query = new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const result: unknown = Reflect.apply(target, receiver, args);
      const [sql, values] = args;
      if (typeof sql === "string" && sql.includes("pg_notify") && Array.isArray(values)) {
        const [channel, payload]: unknown[] = values;
        if (channel === "semprec_events" && typeof payload === "string") {
          const message: unknown = JSON.parse(payload);
          if (!isRecord(message)) throw new Error("Invalid realtime publication");
          recorded.push({ message, done: result });
        }
      }
      return result;
    },
  });
  return {
    of: (match: Record<string, unknown>) =>
      recorded.map((entry) => entry.message).filter((message) => matches(message, match)),
    settle: async () => {
      await Promise.all(recorded.map((entry) => entry.done));
    },
    clear: () => {
      recorded.length = 0;
    },
    restore: () => {
      pool.query = original;
    },
  };
}

/**
 * A write that announces one invalidation scope to the writer's tenant. `write` performs it in `fixture`'s
 * tenant and returns the frame's fields besides `type` and `scope`; with `rollBack`, the write is rolled back.
 */
interface ScopeWrite {
  scope: string;
  from: string;
  rollBack: boolean;
  write: (fixture: TenantFixture, rollBack: boolean) => Promise<Record<string, unknown>>;
}

const scopeWrites: ScopeWrite[] = [
  {
    scope: "mailThread",
    from: "the ingest of a new message",
    rollBack: false,
    write: async (fixture) => ({ threadId: await ingestMessageIn(fixture.tenantId) }),
  },
  {
    scope: "projectAgent",
    from: "a tool grant of the tenant's project",
    rollBack: true,
    write: async (fixture, rollBack) => {
      const projectItemId = randomUUID();
      const registration = await runInTenant(fixture.tenantId, () =>
        upsertMcpToolRegistration(pool, { mcpServerItemId: randomUUID(), toolName: "search_web", toolSchema: {} }),
      );
      await inTenantTransaction(fixture, rollBack, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        }),
      );
      return { projectItemId };
    },
  },
  {
    scope: "sempStatus",
    from: "a problem raised",
    rollBack: true,
    write: async (fixture, rollBack) => {
      await inTenantTransaction(fixture, rollBack, (client) =>
        raiseProblem(client, {
          userId: fixture.userId,
          category: "mail",
          kind: "mailSyncFailed",
          severity: "warning",
          sourceTable: "mail_account_sync_state",
          sourceId: randomUUID(),
          dedupeKey: `mail:sync:${randomUUID()}`,
        }),
      );
      return {};
    },
  },
  {
    scope: "notificationPreferences",
    from: "a preference change of the tenant's user",
    rollBack: true,
    write: async (fixture, rollBack) => {
      await inTenantTransaction(fixture, rollBack, (client) =>
        patchNotificationPreferences(client, fixture.userId, { reminders: false }),
      );
      return {};
    },
  },
  {
    scope: "account",
    from: "a profile change of the tenant's user",
    rollBack: true,
    write: async (fixture, rollBack) => {
      await inTenantTransaction(fixture, rollBack, async (client) => {
        publishAccountInvalidation(client, fixture.userId);
      });
      return {};
    },
  },
  {
    scope: "sempThread",
    from: "a committed thread invalidation",
    rollBack: true,
    write: async (fixture, rollBack) => {
      const threadId = randomUUID();
      await inTenantTransaction(fixture, rollBack, async (client) => {
        publishSempThreadInvalidation(client, fixture.tenantId, threadId);
      });
      return { threadId };
    },
  },
  {
    // Only the switch-off announces the tenant's `mcpServers` scope; creation does not.
    scope: "mcpServers",
    from: "switching an MCP server off",
    rollBack: false,
    write: async (fixture) => {
      await runInTenant(fixture.tenantId, async () => {
        const database = (await chokePoint.listDatabases()).find((entry) => entry.ownerModuleId === "mcpServers");
        if (!database) throw new Error("The mcpServers database was not provisioned");
        const mcpServer = await chokePoint.createItem({
          databaseId: database.id,
          properties: {
            name: "Isolation server",
            connectionConfig: { transport: "http", url: "https://mcp.example.test/mcp" },
          },
        });
        await chokePoint.updateItem({
          databaseId: database.id,
          itemId: mcpServer.id,
          propertiesPatch: { active: false },
        });
      });
      return {};
    },
  },
  {
    // Over the fixture database, which holds no task, so nothing moves.
    scope: "overview",
    from: "the end of a rollover",
    rollBack: false,
    write: async (fixture) => {
      await runInTenant(fixture.tenantId, () =>
        createTasksDayRolloverAction(pool)(
          { tasksDatabaseId: fixture.databaseId },
          { heartbeatId: randomUUID(), projectItemId: randomUUID() },
        ),
      );
      return {};
    },
  },
];

const scopeScenarios: Record<string, Scenario> = Object.fromEntries(
  scopeWrites.flatMap(({ scope, from, rollBack, write }): Array<[string, Scenario]> => [
    [
      `${scope} scope, from ${from} in A, once to both of A's sockets and not to B1${rollBack ? ", with nothing for a rolled-back one" : ""}`,
      async () => {
        if (rollBack) {
          await expect(write(tenantA, true)).rejects.toThrow(ROLLBACK);
          await expectSilence([a1, a2], tenantA, isInvalidate({ scope }));
          await expectNothingReceived(b1, tenantB);
        }
        return expectOnceToAOnly({ scope, ...(await write(tenantA, false)) });
      },
    ],
    [
      `${scope} scope, from ${from} in B, which reaches B1 only`,
      async () => expectOnlyToB({ scope, ...(await write(tenantB, false)) }),
    ],
  ]),
);

const notifyCases = {
  invalidation: {
    scenarios: {
      ...scopeScenarios,
      "inboxCards scope, from the tick creating A's card and the confirm of it on A1": async () => {
        const total = await inboxCardsTotal(a1Cookie);
        await createProposedCard(tenantA.tenantId);
        const created = await nextOnA(isInvalidate({ scope: "inboxCards", op: "created" }));
        const cardId = created[0]?.kind === "text" ? created[0].body.cardId : undefined;
        if (typeof cardId !== "string") throw new Error("Expected the created frame to name the card");
        for (const frame of created) {
          expect(frame).toMatchObject({ kind: "text", body: { cardId } });
          expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual([
            "cardId",
            "op",
            "scope",
            "type",
          ]);
        }
        await expectNothingReceived(b1, tenantB);
        expect(await inboxCardsTotal(a1Cookie)).toBe(total + 1);

        expect((await restPost(a1Cookie, `/api/proposals/${cardId}/confirm`, {})).status).toBe(200);
        await expectInvalidationInA({ scope: "inboxCards", op: "closed", cardId });
        expect(await inboxCardsTotal(a1Cookie)).toBe(total);
        return ["invalidate"];
      },
      "inboxCards scope, from the tick creating B's card, which reaches B1 only": async () => {
        await createProposedCard(tenantB.tenantId);
        return expectOnlyToB({ scope: "inboxCards", op: "created" });
      },
      "agentRuns scope, from the creation and the close of A's run, once each to both of A's sockets and not to B1":
        async () => {
          const run = await runInTenant(tenantA.tenantId, () =>
            createAgentRun(pool, { triggeredBy: "user", task: "private task", userId: tenantA.userId }),
          );
          const match = { scope: "agentRuns", projectItemId: null, agentRunId: run.id };
          await expectOnceToAOnly(match);
          await runInTenant(tenantA.tenantId, () => finishAgentRun(pool, run.id, "done", "private result"));
          return expectOnceToAOnly(match);
        },
      "agentRuns scope, from the creation of B's run, which reaches B1 only": async () => {
        const run = await runInTenant(tenantB.tenantId, () =>
          createAgentRun(pool, { triggeredBy: "user", task: "private task", userId: tenantB.userId }),
        );
        return expectOnlyToB({ scope: "agentRuns", agentRunId: run.id });
      },
      "badgeCounts scope, from a decision request of B's run, which reaches B1 only": async () => {
        const { runId } = await createRunOnThread(tenantB, [b1]);
        await inTenantTransaction(tenantB, false, (client) =>
          createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runId)),
        );
        const frame = await b1.nextMatching(isInvalidate({ scope: "badgeCounts" }));
        expect(frame.kind === "text" ? Object.keys(frame.body).sort() : []).toEqual(["scope", "type"]);
        await expectSilence([a1, a2], tenantA);
        return ["invalidate"];
      },
      "approvalRequest scope, from the creation of a request on A's run with a thread": async () => {
        const { runId, threadId } = await createRunOnThread(tenantA, [a1, a2]);
        const request = await inTenantTransaction(tenantA, false, (client) =>
          createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runId)),
        );
        await expectRequestAndThreadInvalidations([a1, a2], request.id, threadId, runId);
        await expectNothingReceived(b1, tenantB);
        return ["invalidate"];
      },
      "approvalRequest scope, from the decision of A's user on a request": async () => {
        const { runId, threadId } = await createRunOnThread(tenantA, [a1, a2]);
        const request = await runInTenant(tenantA.tenantId, () =>
          createPendingApprovalRequest(pool, pendingApprovalInput(runId)),
        );
        const decided = await inTenantTransaction(tenantA, false, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: request.id,
            decision: "rejected",
            decidedByUserId: tenantA.userId,
          }),
        );
        expect(decided?.outcome).toBe("decided");
        await expectRequestAndThreadInvalidations([a1, a2], request.id, threadId, runId);
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(b1, tenantB);
        return observedTypes([frame]);
      },
    },
  },
  notification_created: {
    scenarios: {
      "A's notification": async () => {
        const notificationId = await runInTenant(tenantA.tenantId, () => writeNotificationFor(tenantA.userId));
        const frames = await nextOnA(isNotification());
        for (const frame of frames) {
          expect(frame).toMatchObject({ body: { notification: { id: notificationId, userId: tenantA.userId } } });
        }
        await expectNothingReceived(b1, tenantB);
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
        const frames = await nextOnA(isNotification());
        for (const frame of frames) {
          expect(frame).toMatchObject({ body: { notification: { id: notificationId, readAt: expect.any(String) } } });
        }
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(a1, tenantA);
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(b1, tenantB);
        return observedTypes([frame]);
      },
    },
  },
} satisfies Record<AgentStreamMessage["type"], Case>;

/** Naming A's id must summarize like a random id. */
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

        await openDoc(a1, tenantA.docId);
        await touchDoc(tenantA);
        const update = await a1.nextMatching(isDocFrame(tenantA.docId));
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(b1, tenantB);
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

        await watchRun(a1, tenantA);
        await appendRunEvent(tenantA);
        const event = await a1.nextMatching(isAgentEvent(tenantA.runId));
        await expectNothingReceived(b1, tenantB);
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
        await expectNothingReceived(b1, tenantB);
        return observedTypes([event]);
      },
    },
  },
} satisfies Record<InboundFrame["type"], Case>;

async function docBodyText(fixture: TenantFixture, docId: string): Promise<string> {
  const ydoc = await runInTenant(fixture.tenantId, () => loadYDoc(pool, docId));
  return ydoc.getText("body").toJSON();
}

/** A1's update for A's doc is stored as exactly one more doc update. */
async function sendOwnUpdate(message: Parameters<typeof buildBinaryFrame>[1]): Promise<void> {
  await openDoc(a1, tenantA.docId);
  const before = await countDocUpdates(tenantA, tenantA.docId);
  a1.sendBinary(buildBinaryFrame(tenantA.docId, message));
  await waitUntil(async () => (await countDocUpdates(tenantA, tenantA.docId)) >= before + 1, "A1's update is stored");
}

/**
 * The foreign frame is decided at dispatch, before any await in `handleBinaryFrame`, and was sent before A1's
 * control update, so an admitted frame would be written first. Once the control is stored, A's doc must hold
 * nothing from the foreign frame.
 */
async function foreignBinaryFrameWritesNothing(): Promise<void> {
  await openDoc(a1, tenantA.docId);
  const before = await countDocUpdates(tenantA, tenantA.docId);

  b1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("foreign")));
  a1.sendBinary(buildBinaryFrame(tenantA.docId, yjsUpdateMessage("control")));
  await waitUntil(
    async () => (await docBodyText(tenantA, tenantA.docId)).includes("control"),
    "the control update is stored",
  );

  expect(await docBodyText(tenantA, tenantA.docId)).not.toContain("foreign");
  expect(await countDocUpdates(tenantA, tenantA.docId)).toBe(before + 1);
  await expectSilence([b1], tenantB, isDocFrame(tenantA.docId));
}

const binaryCase = {
  scenarios: {
    "A1's own frame for A's doc is stored (control for the foreign cases)": async () => {
      await sendOwnUpdate(yjsUpdateMessage("control"));
      return [];
    },
    "B1's frame prefixed with A's doc id, sent without doc:open": async () => {
      await foreignBinaryFrameWritesNothing();
      return [];
    },
    "B1's frame prefixed with A's doc id, sent after a refused doc:open": async () => {
      b1.sendJson({ type: "doc:open", docId: tenantA.docId });
      // B's own open is answered only after the refused one was handled, so the binary frame below meets a
      // finished open, not one still pending its lookup.
      await openDoc(b1, tenantB.docId);
      await foreignBinaryFrameWritesNothing();
      return [];
    },
  },
} satisfies Case;

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

const outboundCases = {
  invalidate: producedBy("invalidate", notifyCases.invalidation),
  notification: producedBy("notification", notifyCases.notification_created),
  "agent:event": producedBy("agent:event", notifyCases.agent_run_event),
  "agent:delta": producedBy("agent:delta", streamCases.agent_run_delta),
  "doc:ack": {
    scenarios: {
      "A1's stored update is acknowledged to A1 only, never to B1": async () => {
        await sendOwnUpdate(appendClientUpdateId(yjsUpdateMessage("acked"), "ack-1"));
        await a1.drainUntil(
          (frame) => frame.kind === "text" && frame.type === "doc:ack" && frame.body.clientUpdateId === "ack-1",
        );
        await expectSilence([b1], tenantB, (frame) => frame.kind === "text" && frame.type === "doc:ack");
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

describe("realtime isolation across two tenants", () => {
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

    // Composed as serve.ts composes them.
    const dispatch = await createDispatcher(pool, dispatcherOptions());
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
    const host = await listen(server);
    baseUrl = `http://${host}`;
    wsUrl = `ws://${host}/api/sync`;
  });

  afterAll(async () => {
    await syncServer?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await pool?.end();
    await adminPool?.end();
    // The hooks are module-global; leave none bound to the ended pool.
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

  // Fresh sessions per test: the revocation case ends A's second session for good.
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
    await drainA();
    await openDoc(a1, docId);
    const foreign = await b1AfterForeignDocFrame({ type: "doc:open", docId });
    const random = await b1AfterForeignDocFrame({ type: "doc:open", docId: randomUUID() });
    expect(foreign).toEqual(random);
    b1.sendBinary(buildBinaryFrame(docId, yjsUpdateMessage("foreign")));
    await expectNothingReceived(b1, tenantB);
    expect(await countDocUpdates(tenantA, docId)).toBe(before);
  });

  it("publishes committed approval request invalidations only to the owner's tenant and suppresses rolled-back ones", async () => {
    const runA = await createRunOnThread(tenantA, [a1, a2]);
    await expect(
      inTenantTransaction(tenantA, true, (client) =>
        createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runA.runId)),
      ),
    ).rejects.toThrow(ROLLBACK);
    await expectSilence([a1, a2], tenantA);
    await expectNothingReceived(b1, tenantB);

    const runB = await createRunOnThread(tenantB, [b1]);
    const requestB = await inTenantTransaction(tenantB, false, (client) =>
      createPendingApprovalRequestAndPublish(client, pendingApprovalInput(runB.runId)),
    );
    await expectRequestAndThreadInvalidations([b1], requestB.id, runB.threadId, runB.runId);
    await expectSilence([a1, a2], tenantA);
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
    await withCleanup(
      async () => {
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
        await drainA();
        await expectNothingReceived(b1, tenantB);

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
          inTenantTransaction(tenantA, false, (client) =>
            enqueueJob(
              client,
              taskName,
              { itemId, databaseId: tenantA.databaseId, config: { source: "openLibrary", coverKey: "cover" } },
              { jobKey: `library-metadata:${itemId}`, maxAttempts: 3 },
            ),
          );
        const statusOf = async (itemId: string) =>
          (await runInTenant(tenantA.tenantId, () => chokePoint.readAutomationForItems([itemId]))).get(itemId)?.status;
        for (const [index, status] of ["found", "notFound"].entries()) {
          const item = items[index];
          if (!item) throw new Error("Library fixture missing");
          found = status === "found";
          await enqueue(item.id);
          await runOnce({ pgPool: pool, taskList: { [taskName]: task } });
          await expectInvalidationInA({ scope: "item", itemId: item.id, databaseId: tenantA.databaseId, op: "update" });
          const after = await runInTenant(tenantA.tenantId, () => chokePoint.getItem(tenantA.databaseId, item.id));
          expect(after?.properties).toEqual(item.properties);
          expect(await statusOf(item.id)).toBe(status);
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
        expect(await statusOf(rollback.id)).toBe("pending");
        await expectSilence([a1, a2], tenantA);
        await expectNothingReceived(b1, tenantB);
      },
      async () => {
        rejectCommits = false;
        workerPool.off("acquire", onAcquire);
        for (const [client, descriptor] of originals) {
          if (descriptor) Object.defineProperty(client, "query", descriptor);
          else Reflect.deleteProperty(client, "query");
        }
        await workerPool.end();
      },
    );
  });

  it("publishes REST relation invalidations with the authenticated actor in its tenant, none for a repeat or rollback, and none with an actor for a background write", async () => {
    const { target, property } = await runInTenant(tenantA.tenantId, async () => {
      const target = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tenantA.databaseId,
        targetDatabaseId: tenantA.databaseId,
        key: `linked${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        name: "Linked",
        cardinality: "many_to_many",
      });
      return { target, property };
    });
    /** An item whose relation value is inherited, optionally already linked to `target`. */
    const linkedItem = (related = false) =>
      runInTenant(tenantA.tenantId, async () => {
        const item = await chokePoint.createItem({ databaseId: tenantA.databaseId, properties: {} });
        if (related) {
          await chokePoint.createRelation({
            relationPropertyId: property.id,
            callerItemId: item.id,
            targetItemId: target.id,
          });
        }
        await withTransaction(pool, (client) =>
          insertValueLink(client, { itemId: item.id, propertyKey: property.key, ruleKey: "test", sources: [] }),
        );
        return item;
      });
    const valueLinkOf = async (itemId: string) =>
      (await runInTenant(tenantA.tenantId, () => chokePoint.getValueLinksForItems([itemId]))).get(itemId)?.[
        property.key
      ];

    // A gate inside the relation route holds a marked request until its client has gone away.
    const marker = randomUUID();
    let admit = () => {};
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let releaseGate = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const actualItemRoutes = itemRoutesModule.createItemRoutes;
    vi.spyOn(itemRoutesModule, "createItemRoutes").mockImplementation((...args) =>
      actualItemRoutes(...args).map((route) =>
        route.method === "PUT" && route.path === "/api/items/:id/relations/:propertyKey/:targetItemId"
          ? {
              ...route,
              handler: async (context) => {
                if (context.req.headers["x-test-gate"] === marker) {
                  admit();
                  await gate;
                }
                return route.handler(context);
              },
            }
          : route,
      ),
    );
    const requestServer = createServer(await createDispatcher(pool, dispatcherOptions()));
    const requestBase = `http://${await listen(requestServer)}`;
    const putRelation = (itemId: string, headers: Record<string, string> = {}, controller?: AbortController) =>
      put(
        `${requestBase}/api/items/${itemId}/relations/${property.key}/${target.id}`,
        { Cookie: a1Cookie, Origin: requestBase, ...headers },
        controller,
      );

    const publications = recordPublications();
    /** Every publication so far is ordered before the sentinel; none announced an update of `itemId`. */
    const expectNoUpdateOf = async (itemId: string) => {
      await publications.settle();
      expect(publications.of({ scope: "item", itemId })).toEqual([]);
      await expectSilence([a1, a2], tenantA, isInvalidate({ itemId, op: "update" }));
      await expectNothingReceived(b1, tenantB);
    };
    const settleSetup = async () => {
      await drainA();
      await publications.settle();
      publications.clear();
    };
    await withCleanup(
      async () => {
        const source = await linkedItem();
        await settleSetup();
        expect(await putRelation(source.id)).toBe(200);
        await publications.settle();
        expect(publications.of({ scope: "item", itemId: source.id })).toEqual([
          expect.objectContaining({ userId: tenantA.userId }),
        ]);
        expect(publications.of({ scope: "relation", itemId: source.id })).toEqual([
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
        expect(publications.of({ scope: "relation", itemId: target.id })).toEqual([
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
        await expectInvalidationInA({ scope: "item", itemId: source.id, op: "update" });

        publications.clear();
        expect(await putRelation(source.id)).toBe(200);
        await expectNoUpdateOf(source.id);

        // The client gives up while the request is held; the server still completes and announces the write.
        const held = await linkedItem();
        await settleSetup();
        const controller = new AbortController();
        const heldRequest = putRelation(held.id, { "x-test-gate": marker }, controller);
        await Promise.race([admitted, heldRequest.then(() => Promise.reject(new Error("Finished before admission")))]);
        controller.abort();
        await expect(heldRequest).rejects.toMatchObject({ name: "AbortError" });
        releaseGate();
        await expectInvalidationInA({ scope: "item", itemId: held.id, op: "update" });
        await publications.settle();
        expect(publications.of({ scope: "item", itemId: held.id })).toEqual([
          expect.objectContaining({ userId: tenantA.userId }),
        ]);
        expect(await valueLinkOf(held.id)).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });

        expect(
          await put(`${requestBase}/api/items/${randomUUID()}/relations/x/${randomUUID()}`, { Origin: requestBase }),
        ).toBe(401);

        const rolledBack = await linkedItem(true);
        await settleSetup();
        await expect(
          inTenantTransaction(tenantA, true, (client) =>
            deleteRelationWithClient(
              client,
              { relationPropertyId: property.id, callerItemId: rolledBack.id, targetItemId: target.id },
              undefined,
              { writerKind: "user" },
              tenantA.userId,
            ),
          ),
        ).rejects.toThrow(ROLLBACK);
        await expectNoUpdateOf(rolledBack.id);
        expect(await valueLinkOf(rolledBack.id)).toMatchObject({ valueKind: "inherited", brokenBy: null });

        const background = await linkedItem();
        await settleSetup();
        await runInTenant(tenantA.tenantId, () =>
          chokePoint.createRelation(
            { relationPropertyId: property.id, callerItemId: background.id, targetItemId: target.id },
            { writerKind: "user" },
          ),
        );
        const backgroundPublications = publications.of({ scope: "item", itemId: background.id });
        expect(backgroundPublications).toEqual([expect.objectContaining({ op: "update" })]);
        expect(backgroundPublications[0]).not.toHaveProperty("userId");
        expect(await valueLinkOf(background.id)).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
        await expectInvalidationInA({ scope: "item", itemId: background.id, op: "update" });
      },
      async () => {
        releaseGate();
        publications.restore();
        requestServer.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          requestServer.close((error) => (error ? reject(error) : resolve())),
        );
      },
    );
  });

  it("delivers committed approval resolution to its user's sockets, with no replay or rollback event", async () => {
    const approvalNotification = (fixture: TenantFixture, sourceId: string) =>
      inTenantTransaction(fixture, false, (client) =>
        writeNotification(client, {
          userId: fixture.userId,
          kind: "approval_pending",
          linkHref: null,
          sourceTable: "approval_requests",
          sourceId,
          transitionInstance: "pending",
        }),
      );
    async function createApprovalNotification(): Promise<{ requestId: string; notificationId: string }> {
      const request = await runInTenant(tenantA.tenantId, () =>
        createPendingApprovalRequest(pool, pendingApprovalInput(tenantA.runId)),
      );
      const notificationId = await approvalNotification(tenantA, request.id);
      await nextOnA(isNotification(notificationId));
      await expectNothingReceived(b1, tenantB);
      return { requestId: request.id, notificationId };
    }
    const decideOverHttp = (id: string) =>
      fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { Cookie: a1Cookie, Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
    const foreignId = await approvalNotification(tenantB, randomUUID());
    const expectForeignUntouched = async () =>
      expect(await runInTenant(tenantB.tenantId, () => getNotificationById(pool, foreignId))).toMatchObject({
        id: foreignId,
        readAt: null,
        resolvedAt: null,
      });

    await b1.nextMatching(isNotification(foreignId));
    const first = await createApprovalNotification();
    // The real hook invokes this pool synchronously from the after-commit callback.
    const publications = recordPublications();
    try {
      const readStates = () => publications.of({ type: "notification_read_state" });
      expect((await decideOverHttp(first.requestId)).status).toBe(200);
      expect(readStates()).toEqual([
        expect.objectContaining({ userId: tenantA.userId, notificationIds: [first.notificationId] }),
      ]);
      for (const frame of await nextOnA(isNotification(first.notificationId))) {
        expect(frame).toMatchObject({
          body: {
            notification: { id: first.notificationId, readAt: expect.any(String), resolvedAt: expect.any(String) },
          },
        });
      }
      await expectNothingReceived(b1, tenantB);
      await expectForeignUntouched();
      publications.clear();
      expect((await decideOverHttp(first.requestId)).status).toBe(200);
      expect(readStates()).toEqual([]);

      const rollback = await createApprovalNotification();
      publications.clear();
      await expect(
        inTenantTransaction(tenantA, true, async (client) => {
          const result = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: rollback.requestId,
            decidedByUserId: tenantA.userId,
            decision: "rejected",
          });
          expect(result?.outcome).toBe("decided");
        }),
      ).rejects.toThrow(ROLLBACK);
      const unchanged = await runInTenant(tenantA.tenantId, () => getNotificationById(pool, rollback.notificationId));
      expect(unchanged).toMatchObject({ readAt: null, resolvedAt: null });
      expect(readStates()).toEqual([]);
      await expectForeignUntouched();
    } finally {
      publications.restore();
    }
  });

  describe("NOTIFY messages on semprec_events", () => {
    it.each(scenariosOf(notifyCases))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });

    it.each([
      ["an envelope without a tenantId", (databaseId: string) => JSON.stringify({ message: invalidation(databaseId) })],
      [
        "an envelope with a null tenantId",
        (databaseId: string) => JSON.stringify({ tenantId: null, message: invalidation(databaseId) }),
      ],
      ["a bare message without an envelope", (databaseId: string) => JSON.stringify(invalidation(databaseId))],
      ["a payload that is not JSON", () => "{"],
    ])("a raw pg_notify with %s reaches no socket", async (_name, build) => {
      await adminPool.query("SELECT pg_notify('semprec_events', $1)", [build(randomUUID())]);

      await expectSilence([a1, a2], tenantA);
      await expectNothingReceived(b1, tenantB);
    });
  });

  describe("NOTIFY messages on semprec_agent_stream", () => {
    it.each(scenariosOf(streamCases))("%s: %s", async (_caseName, _scenarioName, run) => {
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

      await expectNothingReceived(a1, tenantA);
      await expectNothingReceived(b1, tenantB);
    });
  });

  describe("inbound frames from B1 naming A's ids", () => {
    it.each(scenariosOf(inboundCases))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });

  describe("binary doc frames", () => {
    it.each(scenariosOf({ "binary doc frame": binaryCase }))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });

  describe("outbound frames", () => {
    it.each(scenariosOf(outboundCases))("%s: %s", async (_caseName, _scenarioName, run) => {
      await run();
    });
  });
});

function invalidation(databaseId: string): RealtimeMessage {
  return { type: "invalidation", scope: "schema", databaseId };
}
