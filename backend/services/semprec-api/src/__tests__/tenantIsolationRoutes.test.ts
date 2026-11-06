import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { Pool, type PoolClient } from "pg";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  runAsSystem,
  runInTenant,
  type GenericOperationName,
} from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestProjectItem,
  createTestTenant,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  reconcileGmailAccount,
  resetDatabase,
  storeCredential,
  type GmailMailClient,
} from "@semprec/data/testSupport";
import {
  createActionRegistry,
  coreAgentRunAction,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createHeartbeat,
  createInvite,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  getDatabaseByModuleId,
  getOrCreateJournalItem,
  hashPassword,
  handleObservabilityCheckSystemTask,
  handleAgentRunEventsRetentionTask,
  insertAgentRunEvent,
  insertValueLink,
  listPushSubscriptionsForUser,
  loadFullModuleRegistry,
  listAgentRunsByHeartbeat,
  LocalFsBlobStorageWriter,
  provisionTenant,
  raiseProblem,
  recordTokenGatewayCall,
  reserveGatewayCall,
  resolveMailModuleIds,
  resolveNotificationsBySource,
  settleAudioGatewayCall,
  storeMessageSpeech,
  setSempThreadInvalidationHook,
  revokeInvite,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  writeNotification,
  type PasswordResetMailer,
} from "@semprec/data";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob, runOnce, runWorker, type TaskList } from "@semprec/queue";
import { createDispatcher } from "../app.js";
import { createVoiceChannel, type VoiceIdentity } from "../voiceChannel.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { ROUTE_MATRIX, ROUTE_TENANCIES, type RouteMatrixEntry } from "../routeMatrix.js";

/**
 * Issue #1053: every `surface: "api"` entry of `ROUTE_MATRIX` and every MCP generic operation is
 * driven as tenant B against tenant A's real rows, on a runtime-role pool with
 * `SEMPREC_TENANT_SCOPE=strict`. A foreign id must be answered exactly like a random one (same
 * status, body and headers once each requested id is masked; `IGNORED_HEADERS` lists the
 * per-connection exceptions), a mutation must leave A's rows as A reads them, and a list, query or
 * count must succeed, contain B's own rows and contain none of A's ids.
 */

const SETUP_TOKEN = "tenant-isolation-setup-token";
const EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-isolation-${randomUUID()}`);
const filesStorage = new LocalFsBlobStorageWriter(join(tmpBlobDir, "files"));
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

interface Caller {
  headers: Record<string, string>;
}

interface Answer {
  status: number;
  text: string;
  /** Every response header except the per-connection ones in `IGNORED_HEADERS`. */
  headers: Record<string, string>;
}

/**
 * Headers that differ per request or connection whatever the row, so they carry nothing about it.
 * `content-length` is left out because it is a function of the body, which is compared itself;
 * masking a requested value of a different length would otherwise change it.
 */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(["date", "connection", "keep-alive", "content-length"]);

interface Request {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Member extends Caller {
  userId: string;
  email: string;
  password: string;
  token: string;
  sessionId: string;
}

interface TenantFixture {
  tenantId: string;
  member: Member;
  /** A second bearer session of the member, the target of a foreign revoke. */
  secondSession: Member;
  webSession: Member;
  databaseId: string;
  targetDatabaseId: string;
  archivedDatabaseId: string;
  propertyId: string;
  propertyKey: string;
  relationPropertyId: string;
  relationPropertyKey: string;
  viewId: string;
  curatedViewId: string;
  itemId: string;
  targetItemId: string;
  itemVersion: string;
  trashedItemId: string;
  fileItemId: string;
  /** The uploaded file's bytes, unique to this tenant. */
  fileContent: string;
  recordingContent: string;
  blobId: string;
  /** The blob's content hash, the value its ETag is derived from. */
  blobContentHash: string;
  projectItemId: string;
  heartbeatId: string;
  notificationId: string;
  agentRunId: string;
  sempThreadId: string;
  /** A bigint, so it is not in `ids`: as a substring it would match any digit. */
  agentRunEventId: string;
  approvalRequestId: string;
  mcpServerItemId: string;
  mcpToolRegistrationId: string;
  transcriptItemId: string;
  proposalItemId: string;
  /** A Mailboxes item of the tenant, the target of the removal-impact route (issue gh-1501). */
  mailboxItemId: string;
  pushSubscriptionId: string;
  pushDeviceToken: string;
  exportId: string;
  graphSubscriptionId: string;
  /**
   * Every recorded id except `agentRunEventId`, plus every database the tenant can list (its seeded
   * system databases included).
   */
  ids: string[];
  /** The tenant's own id and the ids of its rows in tenant tables: `ids` without users, sessions, push subscriptions and the Graph subscription. */
  tenantRowIds: string[];
}

let a: TenantFixture;
let b: TenantFixture;
let admin: Member;
/** A member of a third tenant, the target of the admin account-lifecycle routes. */
let adminTarget: Member;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the string at `path` of a JSON response body, failing loudly when the shape differs. */
function readString(text: string, ...path: string[]): string {
  let value: unknown = JSON.parse(text);
  for (const key of path) {
    if (!isRecord(value)) throw new Error(`expected an object at '${key}' in ${text}`);
    value = value[key];
  }
  if (typeof value !== "string") throw new Error(`expected a string at '${path.join(".")}' in ${text}`);
  return value;
}

function readIdArray(text: string, field: string): string[] {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body)) throw new Error(`expected a JSON object in ${text}`);
  const rows = body[field];
  if (!Array.isArray(rows)) throw new Error(`expected '${field}' to be an array in ${text}`);
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.id !== "string") throw new Error(`expected an id on every '${field}' row`);
    return row.id;
  });
}

/** Test SQL inside `tenantId`'s scope on the runtime-role pool, which strict enforcement requires. */
function inTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

/** The raw token of an invitation created and revoked through the production functions; invitations are global, so no tenant scope applies. */
function revokedInvitationToken(invitedBy: string): Promise<string> {
  return runAsSystem("isolation test invitation", () =>
    withTransaction(pool, async (client) => {
      const created = await createInvite(client, {
        email: `${randomUUID()}@example.test`,
        invitedBy,
        appBaseUrl: "https://app.example.test",
        mailer: null,
      });
      await revokeInvite(client, created.invite.id);
      return new URL(created.inviteUrl).hash.replace("#token=", "");
    }),
  );
}

/** The number of tenant rows, read as the superuser so the count sees every tenant. */
async function tenantCount(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants");
  return rows[0]?.n ?? -1;
}

async function send(caller: Caller | null, request: Request): Promise<Answer> {
  const headers: Record<string, string> = { ...(caller?.headers ?? {}), ...(request.headers ?? {}) };
  let body: string | undefined;
  if (request.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }
  const res = await fetch(`${baseUrl}${request.path}`, { method: request.method, headers, body });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (!IGNORED_HEADERS.has(name)) responseHeaders[name] = value;
  });
  return { status: res.status, text: await res.text(), headers: responseHeaders };
}

/** Expects a 2xx and returns the body text — for fixture writes made through the real routes. */
async function sendOk(caller: Caller, request: Request): Promise<string> {
  const answer = await send(caller, request);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${request.method} ${request.path} answered ${answer.status}: ${answer.text}`);
  }
  return answer.text;
}

/** The comparison rule: every occurrence of a requested value, in the body and the headers, is replaced with `<id>`. */
function masked(answer: Answer, values: readonly string[]): Answer {
  const mask = (text: string): string => values.reduce((acc, value) => acc.split(value).join("<id>"), text);
  return {
    status: answer.status,
    text: mask(answer.text),
    headers: Object.fromEntries(Object.entries(answer.headers).map(([name, value]) => [name, mask(value)])),
  };
}

/**
 * Sends `build(foreign)` and `build(random)` — `random` holds one fresh UUID per foreign value —
 * and expects both answers to be equal under the comparison rule. Returns the foreign answer.
 */
async function expectForeignLikeRandom(
  caller: Caller | null,
  foreign: readonly string[],
  build: (values: readonly string[]) => Request,
): Promise<Answer> {
  const random = foreign.map(() => randomUUID());
  const foreignAnswer = await send(caller, build(foreign));
  const randomAnswer = await send(caller, build(random));
  // Soft, so a case with several variants reports every one that leaks.
  expect.soft(masked(foreignAnswer, foreign)).toEqual(masked(randomAnswer, random));
  return foreignAnswer;
}

function expectNoneOf(text: string, ids: readonly string[], what: string): void {
  const leaked = ids.filter((id) => text.includes(id));
  expect(leaked, `${what} contains ids it must not`).toEqual([]);
}

/**
 * Expects a successful answer that contains none of A's ids and, so that an empty answer cannot
 * pass for the wrong reason, every one of `ownIds` (B's own rows the request must return).
 */
async function expectExcludesA(caller: Caller, request: Request, ownIds: readonly string[] = []): Promise<Answer> {
  const answer = await send(caller, request);
  const what = `${request.method} ${request.path}`;
  expect(answer.status, `${what}: ${answer.text}`).toBeLessThan(300);
  expectNoneOf(answer.text, a.ids, what);
  expect(
    ownIds.filter((id) => !answer.text.includes(id)),
    `${what} is missing B's own rows`,
  ).toEqual([]);
  return answer;
}

/** The reads A uses to observe its own rows; compared before and after every mutating case. */
function aStateReads(): Request[] {
  return [
    { method: "GET", path: "/api/databases?limit=200" },
    { method: "GET", path: `/api/databases/${a.databaseId}` },
    { method: "GET", path: `/api/databases/${a.targetDatabaseId}` },
    { method: "GET", path: `/api/databases/${a.archivedDatabaseId}` },
    { method: "GET", path: `/api/databases/${a.databaseId}/properties` },
    { method: "GET", path: `/api/databases/${a.targetDatabaseId}/properties` },
    { method: "GET", path: `/api/views?limit=200` },
    { method: "GET", path: `/api/views/${a.viewId}` },
    { method: "GET", path: `/api/views/${a.curatedViewId}` },
    { method: "POST", path: `/api/views/${a.curatedViewId}/query`, body: {} },
    { method: "POST", path: `/api/databases/${a.databaseId}/query`, body: {} },
    { method: "POST", path: `/api/databases/${a.databaseId}/query`, body: { inTrash: true } },
    { method: "POST", path: `/api/databases/${a.targetDatabaseId}/query`, body: {} },
    { method: "GET", path: `/api/items/${a.itemId}` },
    { method: "GET", path: `/api/items/${a.targetItemId}` },
    { method: "GET", path: `/api/items/${a.fileItemId}` },
    { method: "GET", path: `/api/items/${a.mcpServerItemId}` },
    { method: "GET", path: `/api/items/${a.transcriptItemId}` },
    { method: "GET", path: `/api/items/${a.proposalItemId}` },
    { method: "GET", path: `/api/items/${a.projectItemId}` },
    { method: "GET", path: `/api/blobs/${a.blobId}` },
    { method: "GET", path: "/api/notifications/unread" },
    { method: "GET", path: "/api/approval-requests" },
    { method: "GET", path: `/api/agent-runs/${a.agentRunId}` },
    { method: "GET", path: `/api/projects/${a.projectItemId}/mcp-grants` },
    { method: "GET", path: `/api/mail/mailboxes` },
    { method: "GET", path: `/api/mail/mailboxes/${a.mailboxItemId}` },
    { method: "GET", path: `/api/transcripts/${a.transcriptItemId}/speakers` },
    { method: "GET", path: `/api/transcripts/${a.transcriptItemId}` },
    { method: "GET", path: "/api/account/exports" },
  ];
}

/** A's own view of its rows, plus the heartbeats, run events, relation edges (with metadata) and push subscriptions no route lists. */
async function readAState(): Promise<string[]> {
  const lines: string[] = [];
  for (const request of aStateReads()) {
    const answer = await send(a.member, request);
    lines.push(
      `${request.method} ${request.path} ${JSON.stringify(request.body ?? null)} -> ${answer.status} ${answer.text}`,
    );
  }
  const rows = await inTenantTransaction(a.tenantId, async (client) => {
    const heartbeats = await client.query<{ id: string; name: string; enabled: boolean }>(
      "SELECT id, name, enabled FROM project_heartbeats ORDER BY id",
    );
    const events = await client.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM agent_run_events ORDER BY id",
    );
    const relations = await client.query<{ item_a: string; item_b: string; metadata: unknown }>(
      "SELECT item_a, item_b, metadata FROM item_relations ORDER BY item_a, item_b",
    );
    return { heartbeats: heartbeats.rows, events: events.rows, relations: relations.rows };
  });
  lines.push(`heartbeats ${JSON.stringify(rows.heartbeats)}`);
  lines.push(`agent run events ${JSON.stringify(rows.events)}`);
  lines.push(`relations ${JSON.stringify(rows.relations)}`);
  lines.push(...(await readAAccountState()));
  return lines;
}

/** Whether each of A's sessions still authenticates, and A's push subscriptions as stored. */
async function readAAccountState(): Promise<string[]> {
  const lines: string[] = [];
  for (const session of [a.member, a.secondSession, a.webSession]) {
    const answer = await send(session, { method: "GET", path: "/api/auth/session" });
    lines.push(`session ${session.sessionId} -> ${answer.status}`);
  }
  const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
  lines.push(
    `push ${JSON.stringify(subscriptions.map((s) => ({ id: s.id, revokedAt: s.revokedAt, deviceToken: s.deviceToken })))}`,
  );
  return lines;
}

async function expectAAccountActive(): Promise<void> {
  const lines = await readAAccountState();
  for (const session of [a.member, a.secondSession, a.webSession]) {
    expect(lines).toContain(`session ${session.sessionId} -> 200`);
  }
  const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
  const current = subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId);
  expect(current && { revokedAt: current.revokedAt, userId: current.userId }).toEqual({
    revokedAt: null,
    userId: a.member.userId,
  });
}

/** Runs `body` and then expects every read of A's state to answer exactly as before it. */
async function leavesAUnchanged(body: () => Promise<void>): Promise<void> {
  const before = await readAState();
  await body();
  expect(await readAState()).toEqual(before);
}

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

/** Signs in through `POST /api/auth/login`; a web session's token comes back only in its cookie. */
async function signIn(email: string, password: string, platform: "ios" | "web"): Promise<Member> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, platform }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`login answered ${res.status}: ${text}`);
  let token: string;
  if (platform === "web") {
    const cookie = res.headers.get("set-cookie") ?? "";
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(cookie);
    if (!match) throw new Error(`expected a session cookie, got '${cookie}'`);
    token = decodeURIComponent(match[1]!);
  } else {
    token = readString(text, "token");
  }
  const headers: Record<string, string> =
    platform === "web"
      ? { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` }
      : { Authorization: `Bearer ${token}` };
  const sessionText = await sendOk({ headers }, { method: "GET", path: "/api/auth/session" });
  return {
    userId: readString(text, "user", "id"),
    email,
    password,
    token,
    sessionId: readString(sessionText, "session", "id"),
    headers,
  };
}

async function signUp(tenantId: string, role: "admin" | "member"): Promise<Member> {
  const email = `${randomUUID()}@example.test`;
  // Every user gets its own password, so B presenting A's password is a wrong password for B.
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId, role }));
  return signIn(email, password, "ios");
}

async function databaseIdFor(tenantId: string, moduleId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`no '${moduleId}' database in tenant ${tenantId}`);
    return database.id;
  });
}

/** One row of every kind a route addresses, created in `tenantId` through production writes. */
async function seedTenant(): Promise<TenantFixture> {
  const tenantId = await createTestTenant(adminPool);
  await provisionTenant(pool, tenantId);
  const member = await signUp(tenantId, "member");
  const secondSession = await signIn(member.email, member.password, "ios");
  const webSession = await signIn(member.email, member.password, "web");

  const createDatabase = async (name: string): Promise<string> =>
    readString(await sendOk(member, { method: "POST", path: "/api/databases", body: { name } }), "id");
  const databaseId = await createDatabase("Isolation probe");
  const targetDatabaseId = await createDatabase("Isolation targets");
  const archivedDatabaseId = await createDatabase("Isolation archived");
  await sendOk(member, { method: "DELETE", path: `/api/databases/${archivedDatabaseId}` });

  const propertyKey = "note";
  const propertyId = readString(
    await sendOk(member, {
      method: "POST",
      path: `/api/databases/${databaseId}/properties`,
      body: { key: propertyKey, name: "Note", type: "text" },
    }),
    "id",
  );
  const relationPropertyKey = "link";
  const relationPropertyId = readString(
    await sendOk(member, {
      method: "POST",
      path: `/api/databases/${databaseId}/properties`,
      body: {
        key: relationPropertyKey,
        name: "Link",
        type: "relation",
        targetDatabaseId,
        cardinality: "many_to_many",
        locked: false,
      },
    }),
    "id",
  );
  const viewId = readString(
    await sendOk(member, {
      method: "POST",
      path: `/api/databases/${databaseId}/views`,
      body: { type: "table", name: "All rows" },
    }),
    "id",
  );
  const curatedView = await runInTenant(tenantId, () =>
    createChokePoint(pool).createView({ type: "list", name: "Collection", config: { membership: "manual" } }),
  );

  const createItem = async (inDatabaseId: string): Promise<{ id: string; updatedAt: string }> => {
    const text = await sendOk(member, {
      method: "POST",
      path: `/api/databases/${inDatabaseId}/items`,
      body: { properties: {} },
    });
    return { id: readString(text, "id"), updatedAt: readString(text, "updatedAt") };
  };
  const item = await createItem(databaseId);
  const targetItem = await createItem(targetDatabaseId);
  const trashedItem = await createItem(databaseId);
  await sendOk(member, { method: "DELETE", path: `/api/items/${trashedItem.id}` });
  await sendOk(member, {
    method: "PUT",
    path: `/api/items/${item.id}/relations/${relationPropertyKey}/${targetItem.id}`,
    body: {},
  });
  await sendOk(member, { method: "PUT", path: `/api/views/${curatedView.id}/items/${item.id}`, body: {} });
  // A second member, so a foreign reorder of the first one to position 1 would change the order.
  await sendOk(member, { method: "PUT", path: `/api/views/${curatedView.id}/items/${targetItem.id}`, body: {} });
  // Re-read after the relation write, which may have bumped the item's version.
  const itemVersion = readString(await sendOk(member, { method: "GET", path: `/api/items/${item.id}` }), "updatedAt");

  // Starts with an ID3 tag so content detection treats the upload as audio.
  const fileContent = `ID3 audio of ${randomUUID()}`;
  const fileItemId = readString(
    await sendOk(member, {
      method: "POST",
      path: "/api/files",
      body: fileContent,
      headers: { "Content-Type": "audio/mpeg", "X-Filename": "probe.mp3" },
    }),
    "id",
  );
  const blob = await inTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; content_hash: string | null }>(
      "SELECT id, content_hash FROM blobs",
    );
    const row = rows[0];
    if (rows.length !== 1 || !row?.content_hash) {
      throw new Error(`expected exactly one hashed blob in tenant ${tenantId}`);
    }
    return { id: row.id, contentHash: row.content_hash };
  });
  const blobId = blob.id;
  const recordingContent = `ID3 recording of ${randomUUID()}`;
  await sendOk(member, {
    method: "POST",
    path: "/api/files",
    body: recordingContent,
    headers: { "Content-Type": "audio/mpeg", "X-Filename": "recording-probe.mp3" },
  });
  await sendOk(member, { method: "POST", path: "/api/transcriptions", body: { fileItemId } });
  const transcriptItemId = await runInTenant(tenantId, () => createTestModuleItem(pool, "transcripts"));
  const proposalItemId = await runInTenant(tenantId, () => createTestModuleItem(pool, "processingProposals"));

  const projectItemId = await runInTenant(tenantId, () => createTestProjectItem(pool));
  const mcpServersDatabaseId = await databaseIdFor(tenantId, "mcpServers");
  const scoped = await runInTenant(tenantId, async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Isolation heartbeat",
        rule: { kind: "interval", minutes: 5 },
        actionId: "noop",
      }),
    );
    const notificationId = await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId: member.userId,
        kind: "heartbeat_error",
        titleParams: { name: "Isolation heartbeat" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: heartbeat.id,
        transitionInstance: randomUUID(),
      }),
    );
    const mcpServer = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: mcpServersDatabaseId,
        properties: { name: "Isolation server", active: true },
      }),
    );
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: mcpServer.id,
      toolName: "probe",
      toolSchema: {},
    });
    await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, {
        projectItemId,
        mcpToolRegistrationId: registration.id,
        granted: true,
      }),
    );
    const run = await createAgentRun(pool, {
      projectItemId,
      triggeredBy: "user",
      task: "isolation probe",
      userId: member.userId,
    });
    const event = await insertAgentRunEvent(pool, run.id, "run_status", { status: run.status });
    const approval = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: mcpServer.id, args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return {
      heartbeatId: heartbeat.id,
      notificationId,
      mcpServerItemId: mcpServer.id,
      mcpToolRegistrationId: registration.id,
      agentRunId: run.id,
      agentRunEventId: event.id,
      approvalRequestId: approval.id,
    };
  });

  const sempThreadId = await inTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const row = rows[0];
    if (!row) throw new Error("Thread insert returned no row");
    await client.query("INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'isolation')", [row.id]);
    return row.id;
  });

  const pushDeviceToken = randomBytes(32).toString("hex");
  const pushSubscriptionId = readString(
    await sendOk(member, {
      method: "POST",
      path: "/api/push-subscriptions",
      body: { channel: "apns", platform: "ios", deviceToken: pushDeviceToken, apnsEnvironment: "sandbox" },
    }),
    "subscription",
    "id",
  );
  const exportId = readString(
    await sendOk(member, { method: "POST", path: "/api/account/exports", body: {} }),
    "export",
    "id",
  );

  const graphSubscriptionId = `graph-${randomUUID()}`;
  const mailboxItemId = await runInTenant(tenantId, () => createTestModuleItem(pool, "mailboxes"));
  // Raw SQL: registering a Graph subscription is the mail lifecycle's own concern and has no route.
  await inTenantTransaction(tenantId, (client) =>
    client.query(
      `INSERT INTO mail_account_sync_state (item_id, sync_mode, graph_subscription_id, graph_subscription_expires_at, graph_client_state)
       VALUES ($1, 'graph_api', $2, now() + interval '1 day', $3)`,
      [mailboxItemId, graphSubscriptionId, `state-${randomUUID()}`],
    ),
  );

  const listedDatabaseIds = readIdArray(
    await sendOk(member, { method: "GET", path: "/api/databases?limit=200" }),
    "databases",
  );

  const tenantRowIds = [
    tenantId,
    databaseId,
    targetDatabaseId,
    archivedDatabaseId,
    propertyId,
    relationPropertyId,
    viewId,
    curatedView.id,
    item.id,
    targetItem.id,
    trashedItem.id,
    fileItemId,
    blobId,
    projectItemId,
    transcriptItemId,
    proposalItemId,
    mailboxItemId,
    exportId,
    scoped.heartbeatId,
    scoped.notificationId,
    scoped.mcpServerItemId,
    scoped.mcpToolRegistrationId,
    scoped.agentRunId,
    sempThreadId,
    scoped.approvalRequestId,
    ...listedDatabaseIds,
  ];
  return {
    tenantId,
    member,
    secondSession,
    webSession,
    databaseId,
    targetDatabaseId,
    archivedDatabaseId,
    propertyId,
    propertyKey,
    relationPropertyId,
    relationPropertyKey,
    viewId,
    curatedViewId: curatedView.id,
    itemId: item.id,
    targetItemId: targetItem.id,
    itemVersion,
    trashedItemId: trashedItem.id,
    fileItemId,
    fileContent,
    recordingContent,
    blobId,
    blobContentHash: blob.contentHash,
    projectItemId,
    ...scoped,
    sempThreadId,
    transcriptItemId,
    proposalItemId,
    mailboxItemId,
    pushSubscriptionId,
    pushDeviceToken,
    exportId,
    graphSubscriptionId,
    ids: [
      ...new Set([
        ...tenantRowIds,
        member.userId,
        member.sessionId,
        secondSession.sessionId,
        webSession.sessionId,
        pushSubscriptionId,
        graphSubscriptionId,
      ]),
    ],
    tenantRowIds: [...new Set(tenantRowIds)],
  };
}

/** Runs every queued `tenantExport` job through the production task list, so both exports are `ready`. */
async function runExportJobs(): Promise<void> {
  const coreTasks = createCoreTaskList(
    pool,
    createActionRegistry(),
    undefined,
    undefined,
    new LocalFsBlobStorageWriter(join(tmpBlobDir, "mail")),
    undefined,
    undefined,
    undefined,
    undefined,
    filesStorage,
  );
  const exportTask = coreTasks[CORE_TASK_NAMES.TENANT_EXPORT];
  if (!exportTask) throw new Error("createCoreTaskList has no tenantExport task");
  const taskList: TaskList = { [CORE_TASK_NAMES.TENANT_EXPORT]: exportTask };
  await runOnce({ pgPool: pool, taskList });
}

// ---------------------------------------------------------------------------------------------
// REST cases, one per `surface: "api"` entry, keyed by `RouteMatrixEntry.name`
// ---------------------------------------------------------------------------------------------

type RouteCase = () => Promise<void>;

/** The entry's path with every example id replaced by `id`. */
function entryPath(name: string, id: string): string {
  const entry = ROUTE_MATRIX.find((route) => route.name === name);
  if (!entry) throw new Error(`no route matrix entry named '${name}'`);
  return entry.path.split(EXAMPLE_ID).join(id);
}

/** The `admin` class: a member is refused alike for A's id and a random one; the admin sees no tenant row id. */
function adminCase(name: string, method: string, request: () => Promise<Request>): RouteCase {
  return async () => {
    const refused = await expectForeignLikeRandom(b.member, [a.member.userId], ([id]) => ({
      method,
      path: entryPath(name, id!),
      body: method === "GET" ? undefined : {},
    }));
    expect({ status: refused.status, text: refused.text }).toEqual({
      status: 403,
      text: JSON.stringify({ error: { code: "admin_required" } }),
    });

    const answer = await send(admin, await request());
    expect(answer.status, answer.text).toBeLessThan(300);
    expectNoneOf(answer.text, [...a.tenantRowIds, ...b.tenantRowIds], `admin ${name}`);
  };
}

async function createInviteAsAdmin(): Promise<string> {
  const text = await sendOk(admin, {
    method: "POST",
    path: "/api/admin/invites",
    body: { email: `${randomUUID()}@example.test` },
  });
  return readString(text, "invite", "id");
}

const ROUTE_CASES: Record<string, RouteCase> = {
  "project guidance read": async () => {
    const own = await sendOk(b.member, { method: "GET", path: `/api/projects/${b.projectItemId}/agent-guidance` });
    expect(own).toContain('"sections"');
    const result = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => ({
      method: "GET",
      path: `/api/projects/${id}/agent-guidance`,
    }));
    expect(result.status).toBe(404);
  },
  "project guidance save": () =>
    leavesAUnchanged(async () => {
      const body = {
        sections: { purpose: "Isolation", allowed: "", notAllowed: "", generalInstructions: "" },
        expectedUpdatedAt: null,
      };
      const own = await sendOk(b.member, {
        method: "PUT",
        path: `/api/projects/${b.projectItemId}/agent-guidance`,
        body,
      });
      expect(own).toContain("Isolation");
      const result = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => ({
        method: "PUT",
        path: `/api/projects/${id}/agent-guidance`,
        body,
      }));
      expect(result.status).toBe(404);
    }),
  "server identity": async () => {
    const answer = await send(null, { method: "GET", path: "/api/server-info" });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"product":"semprec"}');
    expectNoneOf(answer.text, a.ids, "server identity");
    const refused = await send(null, { method: "POST", path: "/api/server-info" });
    expect(refused.status).toBe(404);
  },
  // --- anonymous ---------------------------------------------------------------------------
  "shallow health check": async () => {
    // No `api` heartbeat runs here, so the probe answers 503; either way it names nothing of A.
    const answer = await send(null, { method: "GET", path: "/healthz" });
    expectNoneOf(answer.text, a.ids, "healthz");
  },
  login: async () => {
    const unknownEmail = `${randomUUID()}@example.test`;
    const known = await send(null, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: a.member.email, password: "wrong-password", platform: "ios" },
    });
    const unknown = await send(null, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: unknownEmail, password: "wrong-password", platform: "ios" },
    });
    expect(masked(known, [a.member.email])).toEqual(masked(unknown, [unknownEmail]));
  },
  "password-reset request": async () => {
    const unknownEmail = `${randomUUID()}@example.test`;
    const known = await send(null, {
      method: "POST",
      path: "/api/auth/password-reset/request",
      body: { email: a.member.email },
    });
    const unknown = await send(null, {
      method: "POST",
      path: "/api/auth/password-reset/request",
      body: { email: unknownEmail },
    });
    expect(masked(known, [a.member.email])).toEqual(masked(unknown, [unknownEmail]));
  },
  "password-reset consume": async () => {
    await leavesAUnchanged(async () => {
      await expectForeignLikeRandom(null, [a.member.token], ([token]) => ({
        method: "POST",
        path: "/api/auth/password-reset/consume",
        body: { token, newPassword: `pw-${randomUUID()}` },
      }));
    });
  },
  "first-account setup (API)": async () => {
    const unknownEmail = `${randomUUID()}@example.test`;
    const known = await send(null, {
      method: "POST",
      path: "/api/setup",
      body: { email: a.member.email, password: "setup-password" },
      headers: { Authorization: `Bearer ${SETUP_TOKEN}` },
    });
    const unknown = await send(null, {
      method: "POST",
      path: "/api/setup",
      body: { email: unknownEmail, password: "setup-password" },
      headers: { Authorization: `Bearer ${SETUP_TOKEN}` },
    });
    expect(masked(known, [a.member.email])).toEqual(masked(unknown, [unknownEmail]));
  },
  "accept invitation": async () => {
    // A revoked invitation's token stands in for a foreign one: it must answer exactly like a random token,
    // and no tenant may be created by either request.
    const revokedToken = await revokedInvitationToken(a.member.userId);
    const tenantsBefore = await tenantCount();
    await expectForeignLikeRandom(null, [revokedToken], ([token]) => ({
      method: "POST",
      path: "/api/invitations/accept",
      body: { token, password: "accepted-password" },
    }));
    expect(await tenantCount()).toBe(tenantsBefore);
  },
  "Microsoft Graph mail webhook": async () => {
    await expectForeignLikeRandom(null, [a.graphSubscriptionId], ([subscriptionId]) => ({
      method: "POST",
      path: "/api/mail/graph/webhook",
      body: { value: [{ subscriptionId, clientState: "not-the-client-state", changeType: "updated" }] },
    }));
  },

  // --- account -----------------------------------------------------------------------------
  logout: async () => {
    const throwaway = await signIn(b.member.email, b.member.password, "ios");
    const answer = await send(throwaway, { method: "POST", path: "/api/auth/logout", body: {} });
    expect(answer.status).toBe(200);
    expectNoneOf(answer.text, a.ids, "logout");
    await expectAAccountActive();
  },
  "list sessions": async () => {
    const own = await send(b.member, { method: "GET", path: "/api/auth/sessions" });
    expect(own.status).toBe(200);
    expect(own.text).toContain(b.member.sessionId);
    expectNoneOf(own.text, [a.member.sessionId, a.secondSession.sessionId], "list sessions");
    await expectAAccountActive();
  },
  "revoke session": async () => {
    await expectForeignLikeRandom(b.member, [a.secondSession.sessionId], ([id]) => ({
      method: "POST",
      path: entryPath("revoke session", id!),
      body: {},
    }));
    await expectAAccountActive();
  },
  "set self person": async () => {
    const person = async (fixture: TenantFixture) =>
      inTenantTransaction(fixture.tenantId, async (client) => {
        const people = await getDatabaseByModuleId(client, "people");
        if (!people) throw new Error("People not seeded");
        return createItemWithClient(client, { databaseId: people.id, properties: { name: "Self" } });
      });
    const ownA = await person(a);
    const ownB = await person(b);
    const set = (personId: string | null): Request => ({
      method: "PUT",
      path: "/api/auth/self-person",
      body: { personId },
    });
    expect((await send(a.member, set(ownA.id))).status).toBe(200);
    const foreign = await send(b.member, set(ownA.id));
    const missing = await send(b.member, set(randomUUID()));
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(missing);
    expect((await send(b.member, set(ownB.id))).status).toBe(200);
    const sessionB = await send(b.member, { method: "GET", path: "/api/auth/session" });
    expect(readString(sessionB.text, "user", "personId")).toBe(ownB.id);
    const sessionA = await send(a.member, { method: "GET", path: "/api/auth/session" });
    expect(readString(sessionA.text, "user", "personId")).toBe(ownA.id);
  },
  "current session": async () => {
    for (const session of [b.member, b.webSession]) {
      const answer = await expectExcludesA(session, { method: "GET", path: "/api/auth/session" });
      expect(answer.status).toBe(200);
    }
    await expectAAccountActive();
  },
  "register push subscription": async () => {
    const register = (deviceToken: string): Request => ({
      method: "POST",
      path: "/api/push-subscriptions",
      body: { channel: "apns", platform: "ios", deviceToken, apnsEnvironment: "sandbox" },
    });
    try {
      const foreign = await expectExcludesA(b.member, register(a.pushDeviceToken));
      const random = await send(b.member, register(randomBytes(32).toString("hex")));
      expect(foreign.status).toBe(random.status);
      expect(foreign.status).toBe(200);
      // Push device tokens are deliberately global identity-plane keys (the 2026-10-03
      // tenancy ADR). Registering the same physical device moves it to the caller, as
      // upsertApnsSubscription specifies; this is distinct from revoking a foreign row id.
      const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
      expect(subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId)?.revokedAt).toEqual(
        expect.any(String),
      );
    } finally {
      // Re-register A's device as A when the case displaced it, so later cases start from an
      // active subscription instead of failing on this case's leftover.
      const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
      if (subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId)?.revokedAt !== null) {
        a.pushSubscriptionId = readString(await sendOk(a.member, register(a.pushDeviceToken)), "subscription", "id");
        a.ids.push(a.pushSubscriptionId);
      }
    }
    await expectAAccountActive();
  },
  "revoke push subscription": async () => {
    await expectForeignLikeRandom(b.member, [a.pushSubscriptionId], ([id]) => ({
      method: "POST",
      path: entryPath("revoke push subscription", id!),
      body: {},
    }));
    await expectAAccountActive();
  },

  // --- tenant: notifications, reports, inbox, transcription --------------------------------
  "unread notifications": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/notifications/unread" }, [b.notificationId]);
  },
  "resolved notifications": async () => {
    const ids: string[] = [];
    for (const fixture of [a, b]) {
      const id = await runInTenant(fixture.tenantId, () =>
        withTransaction(pool, async (client) => {
          const heartbeat = await createHeartbeat(client, {
            projectItemId: fixture.projectItemId,
            name: "Resolved",
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
          });
          const sourceId = heartbeat.id;
          const notification = await writeNotification(client, {
            userId: fixture.member.userId,
            kind: "heartbeat_error",
            titleParams: { name: "Resolved" },
            linkHref: null,
            sourceTable: "project_heartbeats",
            sourceId,
            transitionInstance: randomUUID(),
          });
          await resolveNotificationsBySource(client, { sourceTable: "project_heartbeats", sourceId });
          return notification;
        }),
      );
      ids.push(id);
    }
    const answer = await expectExcludesA(
      b.member,
      { method: "GET", path: "/api/notifications/resolved?since=2020-01-01T00%3A00%3A00Z" },
      [ids[1]!],
    );
    expect(answer.text).not.toContain(ids[0]);
  },
  "visit notification": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.notificationId], ([id]) => ({
        method: "POST",
        path: `/api/notifications/${id}/visit`,
        body: {},
      }));
    }),
  "mark all notifications read": () =>
    leavesAUnchanged(async () => {
      await expectExcludesA(b.member, { method: "POST", path: "/api/notifications/mark-all-read", body: {} }, [
        b.notificationId,
      ]);
    }),
  // Preferences hold no ids, so these cases compare values: A stores values away from the defaults,
  // and B must read its own defaults and change only its own row (issue #1441).
  "get notification preferences": async () => {
    await sendOk(a.member, { method: "PATCH", path: "/api/notification-preferences", body: { badgeInbox: true } });
    try {
      const own: unknown = JSON.parse(await sendOk(a.member, { method: "GET", path: "/api/notification-preferences" }));
      expect(own).toMatchObject({ badgeInbox: true });
      const foreign = await expectExcludesA(b.member, { method: "GET", path: "/api/notification-preferences" });
      const foreignBody: unknown = JSON.parse(foreign.text);
      expect(foreignBody).toMatchObject({ approvals: true, badgeInbox: false });
    } finally {
      await sendOk(a.member, { method: "PATCH", path: "/api/notification-preferences", body: { badgeInbox: false } });
    }
  },
  "patch notification preferences": async () => {
    const aBefore = await sendOk(a.member, { method: "GET", path: "/api/notification-preferences" });
    try {
      const own: unknown = JSON.parse(
        await sendOk(b.member, {
          method: "PATCH",
          path: "/api/notification-preferences",
          body: { approvals: false, badgeApprovals: false },
        }),
      );
      expect(own).toMatchObject({ approvals: false, badgeApprovals: false });
      expect(await sendOk(a.member, { method: "GET", path: "/api/notification-preferences" })).toEqual(aBefore);
    } finally {
      await sendOk(b.member, {
        method: "PATCH",
        path: "/api/notification-preferences",
        body: { approvals: true, badgeApprovals: true },
      });
    }
  },
  // A's heartbeat answers B exactly as a random id does (issue #1453): the lookup is tenant-scoped,
  // and a refused trigger writes nothing, so A's state is compared before and after.
  "trigger heartbeat": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.heartbeatId], ([id]) => ({
        method: "POST",
        path: entryPath("trigger heartbeat", id!),
        body: {},
      }));
    }),
  "set heartbeat enabled": () =>
    leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [a.heartbeatId], ([id]) => ({
        method: "PATCH",
        path: entryPath("set heartbeat enabled", id!),
        body: { enabled: false },
      }));
      expect(answer.status).toBe(404);
    }),
  "schema projection": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/schema" });
  },
  "semp status": async () => {
    const ids: string[] = [];
    for (const fixture of [a, b]) {
      const result = await runInTenant(fixture.tenantId, () =>
        withTransaction(pool, (client) =>
          raiseProblem(client, {
            userId: fixture.member.userId,
            category: "agents",
            kind: "agentHeartbeat",
            severity: "warning",
            sourceTable: "project_heartbeats",
            sourceId: fixture.heartbeatId,
            dedupeKey: `agents:heartbeat:${fixture.heartbeatId}`,
          }),
        ),
      );
      ids.push(result.problemId);
    }
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/semp-status" }, [ids[1]!]);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.text).not.toContain(ids[0]);
  },
  "ai usage report": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/ai-usage?from=2026-01-01&to=2026-12-31" });
  },
  // A's spend goes through the gateway's own accounting writer, so B's summary must show none of it:
  // B has no spend of its own in this fixture, and its figures stay at zero.
  "ai usage summary": async () => {
    await runInTenant(a.tenantId, () =>
      recordTokenGatewayCall(pool, {
        provider: "anthropic",
        model: "isolation-test",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 7,
      }),
    );
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/ai-usage/summary" });
    expect(JSON.parse(answer.text)).toMatchObject({ spentTodayUsd: 0, spentMonthUsd: 0 });
  },
  "system health report": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/system-health" });
  },
  // A's mailbox answers B exactly as a random id does, and both answers are the 404 of an unknown mailbox (issue gh-1501).
  "mail contacts": async () => {
    async function person(tenantId: string, email: string) {
      return inTenantTransaction(tenantId, async (client) => {
        const db = await getDatabaseByModuleId(client, "people");
        if (!db) throw new Error("People not seeded");
        return createItemWithClient(client, { databaseId: db.id, properties: { name: "Contact", emails: email } });
      });
    }
    const foreign = await person(a.tenantId, "foreign-contact@example.com");
    const own = await person(b.tenantId, "own-contact@example.com");
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/contacts?q=contact" }, [own.id]);
    expect(answer.text).not.toContain(foreign.id);
    expect(answer.text).not.toContain("foreign-contact@example.com");
  },
  "mail threads": async () => {
    const seed = (fixture: TenantFixture) =>
      runInTenant(fixture.tenantId, () =>
        withTransaction(pool, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const cp = createChokePoint(pool);
          const emailProperties = await cp.listProperties(ids.emailsDatabaseId);
          const folderProperties = await cp.listProperties(ids.foldersDatabaseId);
          const find = (properties: typeof emailProperties, key: string) => {
            const property = properties.find((entry) => entry.key === key);
            if (!property) throw new Error(`Missing ${key}`);
            return property.id;
          };
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mailbox", provider: "gmail" },
          });
          await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
          const gmail: GmailMailClient = {
            getCurrentHistoryId: async () => "1",
            listHistorySince: async () => ({
              invalidated: false,
              newHistoryId: "2",
              changedMessageIds: [],
              removedMessageIds: [],
            }),
            listAllMessageIds: async () => ["message"],
            listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
            fetchMessage: async () => ({
              id: "message",
              threadId: "thread",
              labelIds: ["INBOX"],
              message: {
                messageId: `<${fixture.tenantId}@example.test>`,
                subject: "Isolation",
                envelope: { from: { address: "sender@example.test" } },
                attachments: [],
              },
            }),
            modifyMessageLabels: async () => undefined,
          };
          await reconcileGmailAccount(client, gmail, {
            mailboxItemId: mailbox.id,
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            foldersDatabaseId: ids.foldersDatabaseId,
            folderRelationPropertyId: find(emailProperties, "folder"),
            attachmentsRelationPropertyId: find(emailProperties, "attachments"),
            mailboxFolderRelationPropertyId: find(folderProperties, "mailbox"),
            storage: filesStorage,
            storageKeyPrefix: "thread-isolation",
          });
          const result = await client.query<{ thread_id: string }>(
            "SELECT thread_id FROM mail_message_meta WHERE mailbox_item_id = $1",
            [mailbox.id],
          );
          if (result.rows.length !== 1 || !result.rows[0]?.thread_id) throw new Error("Missing ingested thread");
          return result.rows[0].thread_id;
        }),
      );
    const first = await seed(a);
    const second = await seed(b);
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/threads" }, [second]);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.text).not.toContain(first);
  },
  "mailbox list": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/mail/mailboxes" }, [b.mailboxItemId]);
  },
  "mailbox detail": async () => {
    const own = await send(b.member, { method: "GET", path: `/api/mail/mailboxes/${b.mailboxItemId}` });
    expect(own.status).toBe(200);
    const answer = await expectForeignLikeRandom(b.member, [a.mailboxItemId], ([id]) => ({
      method: "GET",
      path: `/api/mail/mailboxes/${id}`,
    }));
    expect(answer.status).toBe(404);
  },
  "mailbox removal impact": async () => {
    const own = await send(b.member, {
      method: "GET",
      path: entryPath("mailbox removal impact", b.mailboxItemId),
    });
    expect(own.status).toBe(200);
    const ownBody: unknown = JSON.parse(own.text);
    expect(ownBody).toEqual({ messages: 0, drafts: 0, threads: 0, attachmentsKept: 0 });
    const answer = await expectForeignLikeRandom(b.member, [a.mailboxItemId], ([id]) => ({
      method: "GET",
      path: entryPath("mailbox removal impact", id!),
    }));
    expect(answer.status).toBe(404);
  },
  "confirm proposal": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.proposalItemId], ([id]) => ({
        method: "POST",
        path: `/api/proposals/${id}/confirm`,
        body: {},
      }));
    }),
  "journal period ensure": async () => {
    const request = { method: "PUT", path: "/api/journal/periods/day/2032-08-15/doc", body: {} };
    const owner = await sendOk(a.member, request);
    const [other, repeat] = await Promise.all([sendOk(b.member, request), sendOk(b.member, request)]);
    expect(readString(other, "itemId")).toBe(readString(repeat, "itemId"));
    expect(readString(other, "docId")).toBe(readString(repeat, "docId"));
    expect(readString(other, "itemId")).not.toBe(readString(owner, "itemId"));
    expect(readString(other, "docId")).not.toBe(readString(owner, "docId"));
    const counts = await inTenantTransaction(b.tenantId, async (client) => {
      const journal = await getDatabaseByModuleId(client, "journal");
      if (!journal) throw new Error("Journal not seeded");
      return client.query<{ items: number; docs: number }>(
        `SELECT (SELECT count(*)::int FROM items WHERE database_id = $1 AND properties ->> 'type' = 'day' AND properties ->> 'period' = $2 AND deleted_at IS NULL) AS items,
                (SELECT count(*)::int FROM docs WHERE item_id = $3) AS docs`,
        [journal.id, "2032-08-15", readString(other, "itemId")],
      );
    });
    expect(counts.rows).toEqual([{ items: 1, docs: 1 }]);
    const invalid = await send(b.member, { method: "PUT", path: "/api/journal/periods/week/2027-W53/doc", body: {} });
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "journal period read": async () => {
    const createPeriod = async (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const journal = await getDatabaseByModuleId(client, "journal");
        if (!journal) throw new Error("Journal not seeded");
        return getOrCreateJournalItem(client, journal.id, "day", new Date("2026-10-16T12:00:00Z"), "Europe/Prague");
      });
    const ownA = await createPeriod(a);
    const ownB = await createPeriod(b);
    const response = await sendOk(b.member, { method: "GET", path: "/api/journal/periods/day/2026-10-16" });
    expect(readString(response, "item", "id")).toBe(ownB.id);
    expect(response).not.toContain(ownA.id);
    const invalid = await send(b.member, { method: "GET", path: "/api/journal/periods/week/2027-W53" });
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "create transcription": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.fileItemId], ([fileItemId]) => ({
        method: "POST",
        path: "/api/transcriptions",
        body: { fileItemId },
      }));
    }),
  "transcription rerun": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => ({
        method: "POST",
        path: `/api/transcriptions/${id}/rerun`,
        body: {},
      }));
    }),
  "transcript detail": async () => {
    await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => ({
      method: "GET",
      path: `/api/transcripts/${id}`,
    }));
  },
  "transcript speakers": async () => {
    await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => ({
      method: "GET",
      path: `/api/transcripts/${id}/speakers`,
    }));
  },
  "inbox types": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/inbox-types" });
  },

  // --- tenant: approvals, agent runs, MCP ----------------------------------------------------
  "approval queue": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/approval-requests" }, [b.approvalRequestId]);
  },
  "approval decision": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.approvalRequestId], ([id]) => ({
        method: "PATCH",
        path: `/api/approval-requests/${id}`,
        body: { decision: "approved" },
      }));
    }),
  "mcp json-rpc endpoint": () =>
    leavesAUnchanged(async () => {
      // Every operation is covered by the MCP describe below; this is the endpoint's own entry.
      await expectExcludesA(b.member, {
        method: "POST",
        path: "/mcp",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      await expectForeignLikeRandom(b.member, [a.itemId], ([itemId]) => ({
        method: "POST",
        path: "/mcp",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "semprec.item.get", arguments: { itemId } },
        },
      }));
    }),
  "semp thread detail": async () => {
    const answer = await expectForeignLikeRandom(b.member, [a.sempThreadId], ([id]) => ({
      method: "GET",
      path: `/api/semp/threads/${id}`,
    }));
    expect(answer.status).toBe(404);
    expect(readString(answer.text, "error", "code")).toBe("not_found");
    await sendOk(b.member, { method: "GET", path: `/api/semp/threads/${b.sempThreadId}` });
  },
  "semp thread create message": () =>
    leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "POST",
        path: "/api/semp/threads",
        body: { text: "Question", subject: { inboxItemId: id } },
      }));
      expect(answer.status).toBe(400);
      const own = await send(b.member, { method: "POST", path: "/api/semp/threads", body: { text: "Question" } });
      expect(own.status).toBe(202);
    }),
  "semp thread send message": () =>
    leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [a.sempThreadId], ([id]) => ({
        method: "POST",
        path: `/api/semp/threads/${id}/messages`,
        body: { text: "Question" },
      }));
      expect(answer.status).toBe(404);
      const own = await send(b.member, {
        method: "POST",
        path: `/api/semp/threads/${b.sempThreadId}/messages`,
        body: { text: "Question" },
      });
      expect(own.status).toBe(202);
    }),
  "semp thread messages": async () => {
    const answer = await expectForeignLikeRandom(b.member, [a.sempThreadId], ([id]) => ({
      method: "GET",
      path: `/api/semp/threads/${id}/messages`,
    }));
    expect(answer.status).toBe(404);
    expect(readString(answer.text, "error", "code")).toBe("not_found");
    await sendOk(b.member, { method: "GET", path: `/api/semp/threads/${b.sempThreadId}/messages` });
  },
  "semp message speech": () =>
    leavesAUnchanged(async () => {
      const created = await sendOk(b.member, {
        method: "POST",
        path: `/api/semp/threads/${b.sempThreadId}/messages`,
        body: { text: "Speech isolation" },
      });
      const ownMessageId = readString(created, "messageId");
      const foreignMessage = await inTenantTransaction(a.tenantId, async (client) => {
        const result = await client.query<{ id: string }>("SELECT id FROM semp_messages WHERE thread_id = $1 LIMIT 1", [
          a.sempThreadId,
        ]);
        if (!result.rows[0]) throw new Error("Missing foreign message");
        return result.rows[0].id;
      });
      const key = `${b.tenantId}/blobs/${randomUUID()}`;
      await filesStorage.writeStream(key, Readable.from([Buffer.from("AB")]), { maxBytes: 2 });
      await inTenantTransaction(b.tenantId, (client) =>
        storeMessageSpeech(client, {
          threadId: b.sempThreadId,
          messageId: ownMessageId,
          voice: "alloy",
          text: "Speech isolation",
          storageKey: key,
          byteSize: 2,
        }),
      );
      const response = await expectForeignLikeRandom(
        b.member,
        [a.sempThreadId, foreignMessage],
        ([thread, message]) => ({
          method: "POST",
          path: `/api/semp/threads/${thread}/messages/${message}/speech`,
        }),
      );
      expect(response.status).toBe(404);
      const wrongThread = await send(b.member, {
        method: "POST",
        path: `/api/semp/threads/${b.sempThreadId}/messages/${foreignMessage}/speech`,
      });
      expect(wrongThread.status).toBe(404);
      const own = await send(b.member, {
        method: "POST",
        path: `/api/semp/threads/${b.sempThreadId}/messages/${ownMessageId}/speech`,
      });
      expect(own.status).toBe(200);
      expect(own.text).toBe("AB");
    }),
  "agent run detail": async () => {
    await expectForeignLikeRandom(b.member, [a.agentRunId], ([id]) => ({
      method: "GET",
      path: `/api/agent-runs/${id}`,
    }));
  },
  "mint mcp run credential": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.projectItemId], ([projectItemId]) => ({
        method: "POST",
        path: "/api/agent-runs/mcp-credentials",
        body: { projectItemId, capabilities: ["core.item.read"] },
      }));
    }),
  "project mcp grants": async () => {
    const answer = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => ({
      method: "GET",
      path: `/api/projects/${id}/mcp-grants`,
    }));
    expectNoneOf(answer.text, a.ids, "project mcp grants");
  },
  "project mcp grant toggle": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.projectItemId, a.mcpToolRegistrationId], ([project, tool]) => ({
        method: "PATCH",
        path: `/api/projects/${project}/mcp-grants/${tool}`,
        body: { granted: false },
      }));
      // A's tool registration on a random project, against a random registration.
      await expectForeignLikeRandom(b.member, [a.mcpToolRegistrationId], ([tool]) => ({
        method: "PATCH",
        path: `/api/projects/${randomUUID()}/mcp-grants/${tool}`,
        body: { granted: true },
      }));
      // B's own tool registration granted on A's project, against a random project. The route
      // writes a grant for any project id, so both succeed and differ only by their timestamps.
      const grant = (project: string): Request => ({
        method: "PATCH",
        path: `/api/projects/${project}/mcp-grants/${b.mcpToolRegistrationId}`,
        body: { granted: true },
      });
      const randomProject = randomUUID();
      const withoutTimestamps = (answer: Answer, project: string): Answer => {
        const projectMasked = masked(answer, [project]);
        return {
          ...projectMasked,
          text: projectMasked.text.replace(/"(createdAt|updatedAt)":"[^"]*"/g, '"$1":"<at>"'),
        };
      };
      expect(withoutTimestamps(await send(b.member, grant(a.projectItemId)), a.projectItemId)).toEqual(
        withoutTimestamps(await send(b.member, grant(randomProject)), randomProject),
      );
    }),
  "mcp tool registration reclassify": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.mcpToolRegistrationId], ([id]) => ({
        method: "PATCH",
        path: `/api/mcp-tool-registrations/${id}`,
        body: { requiresApproval: false, riskClass: "read" },
      }));
    }),

  // --- tenant: databases ---------------------------------------------------------------------
  "list databases": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/databases?limit=200" }, [
      b.databaseId,
      b.targetDatabaseId,
    ]);
  },
  "create database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([parentItemId]) => ({
        method: "POST",
        path: "/api/databases",
        body: { name: "Child of a foreign item", parentItemId },
      }));
      const footprint = () =>
        runInTenant(b.tenantId, () =>
          pool.query<{ databases: number; properties: number; partitions: number }>(
            "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties, (SELECT count(*)::int FROM pg_class WHERE relname LIKE 'items\\_p\\_%') AS partitions",
          ),
        );
      const before = (await footprint()).rows;
      const foreignAnswer = await expectForeignLikeRandom(b.member, [a.targetDatabaseId], ([targetDatabaseId]) => ({
        method: "POST",
        path: "/api/databases",
        body: {
          name: "Foreign target",
          properties: [
            { key: "target", name: "Target", type: "relation", targetDatabaseId, cardinality: "many_to_many" },
          ],
        },
      }));
      expect(foreignAnswer.status).toBeGreaterThanOrEqual(400);
      expect(foreignAnswer.status).toBeLessThan(500);
      expect((await footprint()).rows).toEqual(before);
    }),
  "database detail": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
      method: "GET",
      path: `/api/databases/${id}`,
    }));
  },
  "rename database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "PATCH",
        path: `/api/databases/${id}`,
        body: { name: "Renamed by B" },
      }));
    }),
  "archive database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "DELETE",
        path: `/api/databases/${id}`,
      }));
    }),
  "restore database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.archivedDatabaseId], ([id]) => ({
        method: "POST",
        path: `/api/databases/${id}/restore`,
        body: {},
      }));
    }),
  "property catalog": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
      method: "GET",
      path: `/api/databases/${id}/properties`,
    }));
  },
  "create property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "POST",
        path: `/api/databases/${id}/properties`,
        body: { key: "probe", name: "Probe", type: "text" },
      }));
      // A relation from B's own database targeting A's database.
      await expectForeignLikeRandom(b.member, [a.targetDatabaseId], ([targetDatabaseId]) => ({
        method: "POST",
        path: `/api/databases/${b.databaseId}/properties`,
        body: {
          key: "probeRelation",
          name: "Probe relation",
          type: "relation",
          targetDatabaseId,
          cardinality: "many_to_many",
          locked: false,
        },
      }));
    }),
  "property list": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
      method: "GET",
      path: `/api/properties?databaseId=${id}`,
    }));
  },
  "property detail": async () => {
    await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) => ({
      method: "GET",
      path: `/api/properties/${id}`,
    }));
  },
  "update property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) => ({
        method: "PATCH",
        path: `/api/properties/${id}`,
        body: { name: "Renamed by B" },
      }));
    }),
  "delete property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) => ({
        method: "DELETE",
        path: `/api/properties/${id}`,
      }));
    }),

  // --- tenant: views -------------------------------------------------------------------------
  "list views": async () => {
    // The view list holds curated views only; database-linked ones are listed per database.
    await expectExcludesA(b.member, { method: "GET", path: "/api/views?limit=200" }, [b.curatedViewId]);
  },
  "view detail": async () => {
    await expectForeignLikeRandom(b.member, [a.viewId], ([id]) => ({ method: "GET", path: `/api/views/${id}` }));
  },
  "create view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "POST",
        path: `/api/databases/${id}/views`,
        body: { type: "table", name: "Probe" },
      }));
    }),
  "patch view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.viewId], ([id]) => ({
        method: "PATCH",
        path: `/api/views/${id}`,
        body: { name: "Renamed by B" },
      }));
    }),
  "delete view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.viewId], ([id]) => ({ method: "DELETE", path: `/api/views/${id}` }));
    }),
  // Position 1 moves A's first curated item behind its second, so a foreign write that landed
  // would change the order A's curated view query returns.
  "add/reposition curated view item": () =>
    leavesAUnchanged(async () => {
      await curatedItemCases("PUT", { position: 1 });
    }),
  "reorder curated view item": () =>
    leavesAUnchanged(async () => {
      await curatedItemCases("PATCH", { position: 1 });
    }),
  "remove curated view item": () =>
    leavesAUnchanged(async () => {
      await curatedItemCases("DELETE", undefined);
    }),

  // --- tenant: items, queries, relations -----------------------------------------------------
  "create item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "POST",
        path: `/api/databases/${id}/items`,
        body: { properties: {} },
      }));
    }),
  "item detail": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({ method: "GET", path: `/api/items/${id}` }));
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}?include=path`,
    }));
  },
  "patch item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "PATCH",
        path: `/api/items/${id}`,
        body: { properties: { [a.propertyKey]: "written by B" }, ifVersion: a.itemVersion },
      }));
    }),
  "delete item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({ method: "DELETE", path: `/api/items/${id}` }));
    }),
  "restore item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.trashedItemId], ([id]) => ({
        method: "POST",
        path: `/api/items/${id}/restore`,
        body: {},
      }));
    }),
  "query database": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
      method: "POST",
      path: `/api/databases/${id}/query`,
      body: {},
    }));
    const ownQueries: Array<{ databaseId: string; inTrash: boolean; ownIds: string[] }> = [
      { databaseId: b.databaseId, inTrash: false, ownIds: [b.itemId] },
      { databaseId: b.databaseId, inTrash: true, ownIds: [b.trashedItemId] },
      { databaseId: b.targetDatabaseId, inTrash: false, ownIds: [b.targetItemId] },
      { databaseId: b.targetDatabaseId, inTrash: true, ownIds: [] },
    ];
    for (const { databaseId, inTrash, ownIds } of ownQueries) {
      await expectExcludesA(
        b.member,
        { method: "POST", path: `/api/databases/${databaseId}/query`, body: { inTrash } },
        ownIds,
      );
    }
  },
  "query view": async () => {
    for (const viewId of [a.viewId, a.curatedViewId]) {
      await expectForeignLikeRandom(b.member, [viewId], ([id]) => ({
        method: "POST",
        path: `/api/views/${id}/query`,
        body: {},
      }));
    }
    for (const viewId of [b.viewId, b.curatedViewId]) {
      await expectExcludesA(b.member, { method: "POST", path: `/api/views/${viewId}/query`, body: {} }, [b.itemId]);
    }
  },
  "create/replace relation": () =>
    leavesAUnchanged(async () => {
      // Metadata A's existing edge does not carry, so a foreign replace that landed changes it.
      await relationCases("PUT", { metadata: { writtenBy: "B" } });
    }),
  "set relation": () =>
    leavesAUnchanged(async () => {
      const key = `single${randomUUID().replaceAll("-", "")}`;
      await sendOk(b.member, {
        method: "POST",
        path: `/api/databases/${b.databaseId}/properties`,
        body: {
          key,
          name: "Single link",
          type: "relation",
          targetDatabaseId: b.targetDatabaseId,
          cardinality: "one_to_one",
          locked: false,
        },
      });
      await sendOk(b.member, {
        method: "PUT",
        path: `/api/items/${b.itemId}/relations/${key}`,
        body: { targetItemId: b.targetItemId },
      });
      const before = await sendOk(b.member, {
        method: "GET",
        path: `/api/items/${b.itemId}/relations?propertyKey=${key}`,
      });
      await expectForeignLikeRandom(b.member, [a.targetItemId], ([targetItemId]) => ({
        method: "PUT",
        path: `/api/items/${b.itemId}/relations/${key}`,
        body: { targetItemId },
      }));
      expect(
        await sendOk(b.member, { method: "GET", path: `/api/items/${b.itemId}/relations?propertyKey=${key}` }),
      ).toBe(before);
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "PUT",
        path: `/api/items/${id}/relations/${key}`,
        body: { targetItemId: b.targetItemId },
      }));
    }),
  "unlink value": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "POST",
      path: `/api/items/${id}/links/exampleKey/unlink`,
    }));
  },
  "relink value": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "POST",
      path: `/api/items/${id}/links/exampleKey/relink`,
    }));
  },
  "delete relation": () =>
    leavesAUnchanged(async () => {
      await relationCases("DELETE", undefined);
    }),
  "list relations": async () => {
    // A foreign item answers exactly as a random one does, with or without the `propertyKey` filter.
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}/relations`,
    }));
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}/relations?propertyKey=${a.relationPropertyKey}`,
    }));
  },

  // --- tenant: files, exports, account deletion ----------------------------------------------
  "ensure page": async () => {
    const before = await send(a.member, { method: "GET", path: `/api/items/${a.itemId}/page` });
    expect(before.status).toBe(200);
    const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "PUT",
      path: `/api/items/${id}/page`,
    }));
    expect(refused.status).toBe(404);
    expect(await send(a.member, { method: "GET", path: `/api/items/${a.itemId}/page` })).toEqual(before);
    const own = await send(b.member, { method: "PUT", path: `/api/items/${b.itemId}/page` });
    expect(own.status).toBe(200);
  },
  "get page": async () => {
    const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}/page`,
    }));
    expect(refused.status).toBe(404);
    expect((await send(b.member, { method: "GET", path: `/api/items/${b.itemId}/page` })).status).toBe(200);
  },
  "restore page version": () =>
    leavesAUnchanged(async () => {
      // A foreign item answers exactly as a random one does, and nothing of A's page is written.
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "POST",
        path: `/api/items/${id}/page/restore`,
        body: { at: new Date(Date.now() - 60 * 1000).toISOString() },
      }));
    }),
  "recording upload": () =>
    leavesAUnchanged(async () => {
      const upload = (content: string): Request => ({
        method: "POST",
        path: "/api/recordings",
        body: content,
        headers: { "Content-Type": "audio/mpeg", "X-Filename": "recording.mp3" },
      });
      const foreign = await send(b.member, upload(a.recordingContent));
      expectNoneOf(foreign.text, a.ids, "recording upload of A's bytes");
      const random = await expectExcludesA(b.member, upload(`ID3 recording ${randomUUID()}`));
      expect(foreign.status).toBe(random.status);
      expect(random.status).toBe(201);
    }),
  "upload file": () =>
    leavesAUnchanged(async () => {
      // The bodies differ by the created ids, so the statuses are compared: B uploading bytes A
      // already stored must not be told so.
      const upload = (content: string): Request => ({
        method: "POST",
        path: "/api/files",
        body: content,
        headers: { "Content-Type": "audio/mpeg", "X-Filename": "b.mp3" },
      });
      const foreign = await send(b.member, upload(a.fileContent));
      expectNoneOf(foreign.text, a.ids, "upload of A's bytes");
      const random = await expectExcludesA(b.member, upload(`ID3 audio of ${randomUUID()}`));
      expect(random.status).toBe(201);
      expect(foreign.status, foreign.text).toBe(random.status);
    }),
  "upload blob": () =>
    leavesAUnchanged(async () => {
      // B uploading bytes A already stored must never be handed A's blob. The status is not
      // compared: an earlier case may already have stored the same bytes in B.
      const upload = (content: string): Request => ({
        method: "POST",
        path: "/api/blobs",
        body: content,
        headers: { "Content-Type": "image/png" },
      });
      const foreign = await send(b.member, upload(a.fileContent));
      expectNoneOf(foreign.text, a.ids, "blob upload of A's bytes");
      const random = await expectExcludesA(b.member, upload(`image bytes of ${randomUUID()}`));
      expect(random.status).toBe(201);
      expect(foreign.text).not.toContain(a.blobId);
    }),
  "download blob": async () => {
    await expectForeignLikeRandom(b.member, [a.blobId], ([id]) => ({ method: "GET", path: `/api/blobs/${id}` }));
    // The conditional branches answer 304 with A's ETag and 416 with A's size to A itself, so
    // B naming A's content hash or an unsatisfiable range must still get the plain not-found.
    await expectForeignLikeRandom(b.member, [a.blobId], ([id]) => ({
      method: "GET",
      path: `/api/blobs/${id}`,
      headers: { "If-None-Match": `"${a.blobContentHash}"` },
    }));
    await expectForeignLikeRandom(b.member, [a.blobId], ([id]) => ({
      method: "GET",
      path: `/api/blobs/${id}`,
      headers: { Range: "bytes=999999999-" },
    }));
  },
  "request account export": () =>
    leavesAUnchanged(async () => {
      await expectExcludesA(b.member, { method: "POST", path: "/api/account/exports", body: {} });
    }),
  "list account exports": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/account/exports" }, [b.exportId]);
  },
  "download account export": async () => {
    await expectForeignLikeRandom(b.member, [a.exportId], ([id]) => ({
      method: "GET",
      path: `/api/account/exports/${id}/download`,
    }));
  },
  "delete own account": () =>
    leavesAUnchanged(async () => {
      // A's real password is a wrong password for B: B must be refused exactly as for any other.
      await expectForeignLikeRandom(b.member, [a.member.password], ([password]) => ({
        method: "POST",
        path: "/api/account/delete",
        body: { password },
      }));
    }),

  // --- admin ---------------------------------------------------------------------------------
  "admin account list": adminCase("admin account list", "GET", async () => ({
    method: "GET",
    path: "/api/admin/accounts",
  })),
  "admin operations health": adminCase("admin operations health", "GET", async () => ({
    method: "GET",
    path: "/api/admin/health",
  })),
  "admin ai budgets": adminCase("admin ai budgets", "GET", async () => ({
    method: "GET",
    path: "/api/admin/ai-budgets",
  })),
  "admin set ai budget": adminCase("admin set ai budget", "PUT", async () => ({
    method: "PUT",
    path: `/api/admin/accounts/${adminTarget.userId}/ai-budget`,
    body: { dailyCapUsd: 5, monthlyCapUsd: 50 },
  })),
  "admin suspend account": adminCase("admin suspend account", "POST", async () => ({
    method: "POST",
    path: `/api/admin/accounts/${adminTarget.userId}/suspend`,
    body: {},
  })),
  "admin reactivate account": adminCase("admin reactivate account", "POST", async () => ({
    method: "POST",
    path: `/api/admin/accounts/${adminTarget.userId}/reactivate`,
    body: {},
  })),
  "admin change account role": adminCase("admin change account role", "PUT", async () => ({
    method: "PUT",
    path: `/api/admin/accounts/${adminTarget.userId}/role`,
    body: { role: "member" },
  })),
  "admin create invite": adminCase("admin create invite", "POST", async () => ({
    method: "POST",
    path: "/api/admin/invites",
    body: { email: `${randomUUID()}@example.test` },
  })),
  "admin list invites": adminCase("admin list invites", "GET", async () => ({
    method: "GET",
    path: "/api/admin/invites",
  })),
  "admin revoke invite": adminCase("admin revoke invite", "POST", async () => ({
    method: "POST",
    path: `/api/admin/invites/${await createInviteAsAdmin()}/revoke`,
    body: {},
  })),
  // The target is a member of a third tenant, so deleting it touches neither A nor B.
  "admin delete account": adminCase("admin delete account", "POST", async () => ({
    method: "POST",
    path: `/api/admin/accounts/${adminTarget.userId}/delete`,
    body: {},
  })),
};

/** B adds/moves/removes A's item in A's curated view, and A's item in B's own curated view. */
async function curatedItemCases(method: string, body: unknown): Promise<void> {
  await expectForeignLikeRandom(b.member, [a.curatedViewId, a.itemId], ([viewId, itemId]) => ({
    method,
    path: `/api/views/${viewId}/items/${itemId}`,
    body,
  }));
  await expectForeignLikeRandom(b.member, [a.itemId], ([itemId]) => ({
    method,
    path: `/api/views/${b.curatedViewId}/items/${itemId}`,
    body,
  }));
}

/** B links/unlinks A's items through A's relation, and its own item to A's target item. */
async function relationCases(method: string, body: unknown): Promise<void> {
  await expectForeignLikeRandom(b.member, [a.itemId, a.targetItemId], ([itemId, targetItemId]) => ({
    method,
    path: `/api/items/${itemId}/relations/${a.relationPropertyKey}/${targetItemId}`,
    body,
  }));
  await expectForeignLikeRandom(b.member, [a.targetItemId], ([targetItemId]) => ({
    method,
    path: `/api/items/${b.itemId}/relations/${b.relationPropertyKey}/${targetItemId}`,
    body,
  }));
}

interface OwnerProbe {
  label: string;
  ids: string[];
  build: (values: readonly string[]) => Request;
  /** The status A's own request must get, where the route has a single success answer. */
  status?: number;
  /** Values A's own answer must contain. */
  contains?: string[];
  /** Puts A's row back after a probe that changed it. */
  undo?: () => Promise<void>;
}

/** One probe per id the `tenant` cases name, sent as A. */
function ownerProbes(): OwnerProbe[] {
  const get = (path: (values: readonly string[]) => string) => (values: readonly string[]) => ({
    method: "GET",
    path: path(values),
  });
  const call = (method: string, path: (values: readonly string[]) => string, body: unknown = {}) => {
    return (values: readonly string[]): Request => ({ method, path: path(values), body });
  };
  return [
    { label: "mailbox detail", ids: [a.mailboxItemId], build: get(([id]) => `/api/mail/mailboxes/${id}`), status: 200 },
    {
      label: "mailbox removal impact",
      ids: [a.mailboxItemId],
      build: get(([id]) => `/api/mail/mailboxes/${id}/removal-impact`),
      status: 200,
    },
    { label: "database detail", ids: [a.databaseId], build: get(([id]) => `/api/databases/${id}`), status: 200 },
    {
      label: "archived database detail",
      ids: [a.archivedDatabaseId],
      build: get(([id]) => `/api/databases/${id}`),
      status: 200,
    },
    {
      label: "property catalog",
      ids: [a.databaseId],
      build: get(([id]) => `/api/databases/${id}/properties`),
      status: 200,
      contains: [a.propertyId, a.relationPropertyId],
    },
    {
      label: "property list",
      ids: [a.databaseId],
      build: get(([id]) => `/api/properties?databaseId=${id}`),
      status: 200,
      contains: [a.propertyId],
    },
    { label: "property detail", ids: [a.propertyId], build: get(([id]) => `/api/properties/${id}`), status: 200 },
    { label: "view detail", ids: [a.viewId], build: get(([id]) => `/api/views/${id}`), status: 200 },
    { label: "curated view detail", ids: [a.curatedViewId], build: get(([id]) => `/api/views/${id}`), status: 200 },
    { label: "item detail", ids: [a.itemId], build: get(([id]) => `/api/items/${id}?include=path`), status: 200 },
    {
      label: "list relations",
      ids: [a.itemId],
      build: get(([id]) => `/api/items/${id}/relations`),
      status: 200,
      contains: [a.targetItemId],
    },
    {
      label: "query database",
      ids: [a.databaseId],
      build: call("POST", ([id]) => `/api/databases/${id}/query`),
      status: 200,
      contains: [a.itemId],
    },
    {
      label: "query database trash",
      ids: [a.databaseId],
      build: call("POST", ([id]) => `/api/databases/${id}/query`, { inTrash: true }),
      status: 200,
      contains: [a.trashedItemId],
    },
    {
      label: "query view",
      ids: [a.viewId],
      build: call("POST", ([id]) => `/api/views/${id}/query`),
      status: 200,
      contains: [a.itemId],
    },
    {
      label: "query curated view",
      ids: [a.curatedViewId],
      build: call("POST", ([id]) => `/api/views/${id}/query`),
      status: 200,
      contains: [a.itemId],
    },
    { label: "download blob", ids: [a.blobId], build: get(([id]) => `/api/blobs/${id}`), status: 200 },
    {
      label: "download blob, matching If-None-Match",
      ids: [a.blobId],
      build: ([id]) => ({
        method: "GET",
        path: `/api/blobs/${id}`,
        headers: { "If-None-Match": `"${a.blobContentHash}"` },
      }),
      status: 304,
    },
    {
      label: "download blob, unsatisfiable range",
      ids: [a.blobId],
      build: ([id]) => ({ method: "GET", path: `/api/blobs/${id}`, headers: { Range: "bytes=999999999-" } }),
      status: 416,
    },
    {
      label: "download account export",
      ids: [a.exportId],
      build: get(([id]) => `/api/account/exports/${id}/download`),
      status: 200,
    },
    { label: "agent run detail", ids: [a.agentRunId], build: get(([id]) => `/api/agent-runs/${id}`), status: 200 },
    {
      label: "project mcp grants",
      ids: [a.projectItemId],
      build: get(([id]) => `/api/projects/${id}/mcp-grants`),
      status: 200,
      contains: [a.mcpToolRegistrationId, '"granted":true'],
    },
    {
      label: "transcript detail",
      ids: [a.transcriptItemId],
      build: get(([id]) => `/api/transcripts/${id}`),
    },
    {
      label: "transcript speakers",
      ids: [a.transcriptItemId],
      build: get(([id]) => `/api/transcripts/${id}/speakers`),
    },
    {
      label: "create transcription",
      ids: [a.fileItemId],
      build: ([fileItemId]) => ({ method: "POST", path: "/api/transcriptions", body: { fileItemId } }),
    },
    {
      label: "transcription rerun",
      ids: [a.transcriptItemId],
      build: call("POST", ([id]) => `/api/transcriptions/${id}/rerun`),
    },
    {
      label: "confirm proposal",
      ids: [a.proposalItemId],
      build: call("POST", ([id]) => `/api/proposals/${id}/confirm`),
      // The fixture proposal has no status, so A's own confirm is refused and writes nothing.
      status: 400,
    },
    {
      label: "mint mcp run credential",
      ids: [a.projectItemId],
      build: ([projectItemId]) => ({
        method: "POST",
        path: "/api/agent-runs/mcp-credentials",
        body: { projectItemId, capabilities: ["core.item.read"] },
      }),
      status: 201,
    },
    {
      label: "project mcp grant toggle",
      ids: [a.projectItemId, a.mcpToolRegistrationId],
      build: call("PATCH", ([project, tool]) => `/api/projects/${project}/mcp-grants/${tool}`, { granted: true }),
      status: 200,
    },
    {
      label: "mcp tool registration reclassify",
      ids: [a.mcpToolRegistrationId],
      // The seeded value, so A's registration keeps a classification other than the one B's
      // foreign reclassify sends, and a cross-tenant write would still change what A reads.
      build: call("PATCH", ([id]) => `/api/mcp-tool-registrations/${id}`, { requiresApproval: true }),
      status: 200,
      contains: ['"requiresApproval":true'],
    },
    {
      label: "rename database",
      ids: [a.databaseId],
      build: call("PATCH", ([id]) => `/api/databases/${id}`, { name: "Isolation probe" }),
      status: 200,
    },
    {
      label: "archive database",
      ids: [a.archivedDatabaseId],
      build: call("DELETE", ([id]) => `/api/databases/${id}`),
    },
    {
      label: "restore database",
      ids: [a.archivedDatabaseId],
      build: call("POST", ([id]) => `/api/databases/${id}/restore`),
      status: 200,
      undo: async () => {
        await sendOk(a.member, { method: "DELETE", path: `/api/databases/${a.archivedDatabaseId}` });
      },
    },
    {
      label: "update property",
      ids: [a.propertyId],
      build: call("PATCH", ([id]) => `/api/properties/${id}`, { name: "Note" }),
      status: 200,
    },
    {
      label: "patch view",
      ids: [a.viewId],
      build: call("PATCH", ([id]) => `/api/views/${id}`, { name: "All rows" }),
      status: 200,
    },
    {
      label: "add curated view item",
      ids: [a.curatedViewId, a.itemId],
      build: call("PUT", ([view, item]) => `/api/views/${view}/items/${item}`, { position: 0 }),
      status: 200,
    },
    {
      label: "reorder curated view item",
      ids: [a.curatedViewId, a.itemId],
      build: call("PATCH", ([view, item]) => `/api/views/${view}/items/${item}`, { position: 0 }),
      status: 200,
    },
    {
      label: "patch item",
      ids: [a.itemId],
      build: call("PATCH", ([id]) => `/api/items/${id}`, { properties: {}, ifVersion: a.itemVersion }),
      status: 200,
    },
    {
      label: "restore item",
      ids: [a.trashedItemId],
      build: call("POST", ([id]) => `/api/items/${id}/restore`),
      status: 200,
      undo: async () => {
        await sendOk(a.member, { method: "DELETE", path: `/api/items/${a.trashedItemId}` });
      },
    },
    {
      label: "create/replace relation",
      ids: [a.itemId, a.targetItemId],
      build: call("PUT", ([item, target]) => `/api/items/${item}/relations/${a.relationPropertyKey}/${target}`),
      status: 200,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// MCP cases, one per generic operation
// ---------------------------------------------------------------------------------------------

interface McpProbe {
  /** `tools/call` with A's ids answers exactly as with random ids. */
  foreignLikeRandom(
    foreign: readonly string[],
    args: (values: readonly string[]) => Record<string, unknown>,
  ): Promise<void>;
  /** `tools/call` succeeds, returns none of A's ids and returns every one of `ownIds`. */
  excludesA(args: Record<string, unknown>, ownIds: readonly string[]): Promise<void>;
}

type McpCase = (probe: McpProbe) => Promise<void>;

const MCP_CASES = {
  "database.list": (p) => p.excludesA({ limit: 200 }, [b.databaseId, b.targetDatabaseId]),
  "database.get": (p) => p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId })),
  "database.create": (p) =>
    p.foreignLikeRandom([a.itemId], ([parentItemId]) => ({ name: "Child of a foreign item", parentItemId })),
  "database.patch": (p) =>
    p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, patch: { name: "Renamed by B" } })),
  "database.archive": (p) => p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId })),
  "database.restore": (p) => p.foreignLikeRandom([a.archivedDatabaseId], ([databaseId]) => ({ databaseId })),
  "property.list": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId }));
    await p.excludesA({ databaseId: b.databaseId }, [b.propertyId, b.relationPropertyId]);
  },
  "property.get": (p) => p.foreignLikeRandom([a.propertyId], ([propertyId]) => ({ propertyId })),
  "property.getByKey": (p) =>
    p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, key: a.propertyKey })),
  "property.create": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({
      databaseId,
      key: "probe",
      name: "Probe",
      type: "text",
    }));
    await p.foreignLikeRandom([a.targetDatabaseId], ([targetDatabaseId]) => ({
      databaseId: b.databaseId,
      key: "probeRelation",
      name: "Probe relation",
      type: "relation",
      targetDatabaseId,
      cardinality: "many_to_many",
      locked: false,
    }));
  },
  "property.patch": (p) =>
    p.foreignLikeRandom([a.propertyId], ([propertyId]) => ({ propertyId, patch: { name: "Renamed by B" } })),
  "property.delete": (p) => p.foreignLikeRandom([a.propertyId], ([propertyId]) => ({ propertyId })),
  // Curated views only, as for `GET /api/views`.
  "view.list": (p) => p.excludesA({ limit: 200 }, [b.curatedViewId]),
  "view.get": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId })),
  "view.create": (p) =>
    p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, type: "table", name: "Probe" })),
  "view.patch": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId, patch: { name: "Renamed by B" } })),
  "view.delete": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId })),
  "view.query": async (p) => {
    await p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId }));
    await p.foreignLikeRandom([a.curatedViewId], ([viewId]) => ({ viewId }));
    await p.excludesA({ viewId: b.viewId }, [b.itemId]);
    await p.excludesA({ viewId: b.curatedViewId }, [b.itemId]);
  },
  "viewItem.add": async (p) => {
    await p.foreignLikeRandom([a.curatedViewId, a.itemId], ([viewId, itemId]) => ({ viewId, itemId }));
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ viewId: b.curatedViewId, itemId }));
  },
  "viewItem.remove": async (p) => {
    await p.foreignLikeRandom([a.curatedViewId, a.itemId], ([viewId, itemId]) => ({ viewId, itemId }));
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ viewId: b.curatedViewId, itemId }));
  },
  "viewItem.reorder": async (p) => {
    await p.foreignLikeRandom([a.curatedViewId, a.itemId], ([viewId, itemId]) => ({ viewId, itemId, position: 0 }));
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ viewId: b.curatedViewId, itemId, position: 0 }));
  },
  "item.get": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId })),
  "item.create": (p) => p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, properties: {} })),
  "item.patch": (p) =>
    p.foreignLikeRandom([a.itemId], ([itemId]) => ({
      itemId,
      properties: { [a.propertyKey]: "written by B" },
      ifVersion: a.itemVersion,
    })),
  "item.delete": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId })),
  "item.restore": (p) => p.foreignLikeRandom([a.trashedItemId], ([itemId]) => ({ itemId })),
  "database.query": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId }));
    await p.excludesA({ databaseId: b.databaseId }, [b.itemId]);
    await p.excludesA({ databaseId: b.databaseId, inTrash: true }, [b.trashedItemId]);
  },
  "relation.put": async (p) => {
    await p.foreignLikeRandom(
      [a.relationPropertyId, a.itemId, a.targetItemId],
      ([relationPropertyId, callerItemId, targetItemId]) => ({ relationPropertyId, callerItemId, targetItemId }),
    );
    await p.foreignLikeRandom([a.targetItemId], ([targetItemId]) => ({
      relationPropertyId: b.relationPropertyId,
      callerItemId: b.itemId,
      targetItemId,
    }));
  },
  "relation.set": async (p) => {
    const key = `single${randomUUID().replaceAll("-", "")}`;
    const propertyId = readString(
      await sendOk(b.member, {
        method: "POST",
        path: `/api/databases/${b.databaseId}/properties`,
        body: {
          key,
          name: "Single link",
          type: "relation",
          targetDatabaseId: b.targetDatabaseId,
          cardinality: "one_to_one",
          locked: false,
        },
      }),
      "id",
    );
    await p.excludesA({ relationPropertyId: propertyId, callerItemId: b.itemId, targetItemId: b.targetItemId }, [
      b.itemId,
      b.targetItemId,
    ]);
    const before = await sendOk(b.member, {
      method: "GET",
      path: `/api/items/${b.itemId}/relations?propertyKey=${key}`,
    });
    await p.foreignLikeRandom([a.targetItemId], ([targetItemId]) => ({
      relationPropertyId: propertyId,
      callerItemId: b.itemId,
      targetItemId,
    }));
    expect(await sendOk(b.member, { method: "GET", path: `/api/items/${b.itemId}/relations?propertyKey=${key}` })).toBe(
      before,
    );
    await p.foreignLikeRandom([a.relationPropertyId, a.itemId], ([relationPropertyId, callerItemId]) => ({
      relationPropertyId,
      callerItemId,
      targetItemId: b.targetItemId,
    }));
  },
  "relation.delete": async (p) => {
    await p.foreignLikeRandom(
      [a.relationPropertyId, a.itemId, a.targetItemId],
      ([relationPropertyId, callerItemId, targetItemId]) => ({ relationPropertyId, callerItemId, targetItemId }),
    );
    await p.foreignLikeRandom([a.targetItemId], ([targetItemId]) => ({
      relationPropertyId: b.relationPropertyId,
      callerItemId: b.itemId,
      targetItemId,
    }));
  },
  "relation.list": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId }));
  },
  "link.unlink": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, propertyKey: a.propertyKey })),
  "link.relink": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, propertyKey: a.propertyKey })),
  "page.ensure": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId }));
    await p.excludesA({ itemId: b.itemId }, []);
  },
  "page.get": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, format: "summary" }));
    await p.excludesA({ itemId: b.itemId, format: "summary" }, []);
  },
  "page.restoreVersion": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({
      itemId,
      at: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
  },
} satisfies Record<GenericOperationName, McpCase>;

function mcpCall(name: GenericOperationName, args: Record<string, unknown>): Request {
  return {
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `semprec.${name}`, arguments: args } },
  };
}

function mcpProbe(caller: Caller, operation: GenericOperationName): McpProbe {
  return {
    async foreignLikeRandom(foreign, args) {
      const answer = await expectForeignLikeRandom(caller, foreign, (values) => mcpCall(operation, args(values)));
      expect(answer.status).toBe(200);
    },
    async excludesA(args, ownIds) {
      const answer = await expectExcludesA(caller, mcpCall(operation, args), ownIds);
      expect(answer.status).toBe(200);
      // A list or query that errors would contain no ids trivially.
      expect(answer.text).not.toContain('"error"');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

const API_ENTRIES: RouteMatrixEntry[] = ROUTE_MATRIX.filter((route) => route.surface === "api");

describe("two-tenant isolation over every REST route and MCP operation (issue #1053)", () => {
  let mcpRunCredential: Caller;

  beforeAll(async () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: SETUP_TOKEN,
      moduleRegistry,
      blobStorage: filesStorage,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    a = await seedTenant();
    b = await seedTenant();
    await runExportJobs();
    admin = await signUp(getTenantZeroId(), "admin");
    adminTarget = await signUp(await createTestTenant(adminPool), "member");

    const minted = await sendOk(b.member, {
      method: "POST",
      path: "/api/agent-runs/mcp-credentials",
      body: { projectItemId: b.projectItemId, capabilities: [...CAPABILITY_IDS] },
    });
    mcpRunCredential = { headers: { Authorization: `Bearer ${readString(minted, "token")}` } };
  }, 300_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await adminPool?.end();
    if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
  });

  it("serves durable thread headers and complete cursor pages", async () => {
    const fixture = await inTenantTransaction(a.tenantId, async (client) => {
      const threads = await client.query<{ id: string; kind: string }>(
        `INSERT INTO semp_threads (kind, subject_inbox_item_id, heartbeat_id, title)
         VALUES ('chat', NULL, NULL, 'A chat'), ('item', $1, NULL, NULL), ('tick', NULL, $2, NULL)
         RETURNING id, kind`,
        [a.itemId, a.heartbeatId],
      );
      const chat = threads.rows.find((row) => row.kind === "chat");
      if (!chat) throw new Error("Missing chat fixture");
      const messages = await client.query<{ id: string }>(
        `INSERT INTO semp_messages (thread_id, role, text, created_at)
         SELECT $1, 'user', 'history', '2020-01-01T00:00:00.123456Z'::timestamptz
         FROM generate_series(1, 5) RETURNING id`,
        [chat.id],
      );
      return { threads: threads.rows, ids: messages.rows.map((row) => row.id), chatId: chat.id };
    });
    await runAsSystem("test:retention", () => handleAgentRunEventsRetentionTask(pool));
    for (const thread of fixture.threads) {
      const answer = await send(a.member, { method: "GET", path: `/api/semp/threads/${thread.id}` });
      expect(answer.status).toBe(200);
      const body: unknown = JSON.parse(answer.text);
      expect(body).toMatchObject({
        id: thread.id,
        kind: thread.kind,
        subject: thread.kind === "item" ? { inboxItemId: a.itemId, proposalId: null } : null,
      });
      expect(body).toHaveProperty("createdAt");
      expect(body).toHaveProperty("lastActivityAt");
      expect(body).not.toHaveProperty("heartbeat");
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix = cursor === null ? "" : `&before=${encodeURIComponent(cursor)}`;
      const answer = await send(a.member, {
        method: "GET",
        path: `/api/semp/threads/${fixture.chatId}/messages?limit=2${suffix}`,
      });
      expect(answer.status).toBe(200);
      const body: unknown = JSON.parse(answer.text);
      if (
        !isRecord(body) ||
        !Array.isArray(body.rows) ||
        !(body.nextCursor === null || typeof body.nextCursor === "string")
      )
        throw new Error("Invalid message response");
      for (const row of body.rows) {
        if (!isRecord(row) || typeof row.id !== "string") throw new Error("Invalid message row");
        expect(row).toMatchObject({
          role: "user",
          text: "history",
          system: null,
          context: [],
          replyToMessageId: null,
          agentRunId: null,
          eventFromId: null,
          status: null,
        });
        seen.push(row.id);
      }
      cursor = body.nextCursor;
    } while (cursor !== null && seen.length <= 5);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(fixture.ids));
    for (const query of ["before=garbage", "limit=0", "limit=101", "limit=1.5"]) {
      expect(
        (await send(a.member, { method: "GET", path: `/api/semp/threads/${fixture.chatId}/messages?${query}` })).status,
      ).toBe(400);
    }
  });

  it("isolates voice identities and deactivation across tenants", async () => {
    const identities: VoiceIdentity[] = [];
    const voice = createVoiceChannel(pool, {
      handler: {
        onStart(identity, _frame, sender) {
          identities.push(identity);
          sender.sendControl({ type: "ready" });
        },
        onAudio() {},
        onControl() {},
        onClose() {},
      },
    });
    const voiceHttp = createServer((_req, res) => res.writeHead(404).end());
    voiceHttp.on("upgrade", (req, socket, head) => voice.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => voiceHttp.listen(0, "127.0.0.1", resolve));
    const address = voiceHttp.address();
    if (!address || typeof address === "string") throw new Error("Missing voice address");
    const open = async (member: Member) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice`, { headers: member.headers });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const ready = new Promise<void>((resolve) => ws.once("message", () => resolve()));
      ws.send(JSON.stringify({ type: "start", language: "en" }));
      await ready;
      return ws;
    };
    try {
      const first = await open(a.member),
        second = await open(b.member);
      expect(identities).toMatchObject([
        { tenantId: a.tenantId, userId: a.member.userId },
        { tenantId: b.tenantId, userId: b.member.userId },
      ]);
      const firstClosed = new Promise<number>((resolve) => first.once("close", resolve));
      voice.closeTenant(a.tenantId);
      expect(await firstClosed).toBe(4401);
      expect(second.readyState).toBe(WebSocket.OPEN);
      const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
      second.close();
      await secondClosed;
    } finally {
      await voice.close();
      await new Promise<void>((resolve) => voiceHttp.close(() => resolve()));
    }
  });

  it("has exactly one case per surface: api entry", () => {
    const entryNames = new Set(API_ENTRIES.map((route) => route.name));
    const missing = [...entryNames].filter((name) => !(name in ROUTE_CASES));
    const unknown = Object.keys(ROUTE_CASES).filter((name) => !entryNames.has(name));
    expect(missing, "api entries without an isolation case").toEqual([]);
    expect(unknown, "isolation cases naming no api entry").toEqual([]);
  });

  it("classifies every entry consistently with its public and admin flags", () => {
    const tenancies: readonly string[] = ROUTE_TENANCIES;
    const unknownTenancy = ROUTE_MATRIX.filter((route) => !tenancies.includes(route.tenancy)).map((r) => r.name);
    const anonymousMismatch = ROUTE_MATRIX.filter((route) => (route.tenancy === "anonymous") !== route.public).map(
      (r) => r.name,
    );
    const adminMismatch = ROUTE_MATRIX.filter((route) => (route.tenancy === "admin") !== (route.admin === true)).map(
      (r) => r.name,
    );
    expect(unknownTenancy).toEqual([]);
    expect(anonymousMismatch).toEqual([]);
    expect(adminMismatch).toEqual([]);
  });

  it("refuses user PATCHes of every proposal card-state key while allowing the owner's user property", async () => {
    const path = `/api/items/${a.proposalItemId}`;
    const before = await sendOk(a.member, { method: "GET", path });
    const version = readString(before, "updatedAt");
    const values: Record<string, unknown> = {
      aiProposal: {},
      userOverrides: {},
      userEditedKeys: [],
      aiVersion: 1,
      reason: "reason",
      recognizedTypeId: "type",
      typeCandidates: [],
      candidates: [],
      invalidReason: {},
      referencedItemIds: [],
      results: [],
      context: {},
    };
    for (const [key, value] of Object.entries(values)) {
      const response = await send(a.member, {
        method: "PATCH",
        path,
        body: { properties: { [key]: value }, ifVersion: version },
      });
      expect(response.status, key).toBe(403);
      expect(await sendOk(a.member, { method: "GET", path }), key).toBe(before);
    }
    const foreign = await send(b.member, {
      method: "PATCH",
      path,
      body: { properties: { reason: "foreign" }, ifVersion: version },
    });
    expect(foreign.status).toBe(404);
    expect(await sendOk(a.member, { method: "GET", path })).toBe(before);

    const created = await sendOk(a.member, {
      method: "POST",
      path: `/api/databases/${a.databaseId}/items`,
      body: { properties: {} },
    });
    const ownPath = `/api/items/${readString(created, "id")}`;
    const changed = await sendOk(a.member, {
      method: "PATCH",
      path: ownPath,
      body: {
        properties: { [a.propertyKey]: "allowed" },
        ifVersion: readString(created, "updatedAt"),
      },
    });
    const parsed: unknown = JSON.parse(changed);
    expect(parsed).toMatchObject({ properties: { [a.propertyKey]: "allowed" } });
  });

  it("returns flat confirmed results and an unchanged replay through authenticated HTTP", async () => {
    const proposalId = await runInTenant(a.tenantId, () =>
      withTransaction(pool, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        const tasks = await getDatabaseByModuleId(client, "tasks");
        if (!proposals || !tasks) throw new Error("Missing proposal or task database");
        const item = await createItemWithClient(
          client,
          {
            databaseId: proposals.id,
            properties: {
              status: "proposed",
              kind: "inbox",
              proposal: { entityKind: "database", target: tasks.id, properties: { name: "Confirmed task" } },
            },
          },
          { allowedSystemKeys: ["status", "kind", "proposal"] },
        );
        return item.id;
      }),
    );
    const path = `/api/proposals/${proposalId}/confirm`;
    const foreign = await expectForeignLikeRandom(b.member, [proposalId], ([id]) => ({
      method: "POST",
      path: `/api/proposals/${id}/confirm`,
      body: {},
    }));
    expect(foreign.status).toBe(404);
    const first = await send(a.member, { method: "POST", path, body: {} });
    expect(first.status).toBe(200);
    const firstBody: unknown = JSON.parse(first.text);
    expect(firstBody).toMatchObject({
      id: proposalId,
      properties: { status: "confirmed" },
      results: [{ ref: "primary", databaseKey: "tasks", role: "primary", followUp: null, blockIds: [] }],
    });
    expect(firstBody).not.toHaveProperty("item");
    const replay = await send(a.member, { method: "POST", path, body: {} });
    expect(replay.status).toBe(200);
    const replayBody: unknown = JSON.parse(replay.text);
    expect(replayBody).toEqual(firstBody);
  });

  it("lists A's own approval request and unread notification for A", async () => {
    expect(readIdArray(await sendOk(a.member, { method: "GET", path: "/api/approval-requests" }), "rows")).toEqual([
      a.approvalRequestId,
    ]);
    const notifications = await sendOk(a.member, { method: "GET", path: "/api/notifications/unread" });
    expect(readIdArray(notifications, "notifications")).toEqual([a.notificationId]);
  });

  it("projects a safe mailbox stall notification through authenticated tenant-scoped HTTP", async () => {
    const fixtures = [];
    for (let i = 0; i < 2; i++) {
      const tenantId = await createTestTenant(adminPool);
      await provisionTenant(pool, tenantId);
      const member = await signUp(tenantId, "member");
      const mailboxItemId = await runInTenant(tenantId, () => createTestModuleItem(pool, "mailboxes"));
      await inTenantTransaction(tenantId, async (client) => {
        await ensureMailAccountSyncState(client, { itemId: mailboxItemId, syncMode: "imap" });
        await storeCredential(client, {
          itemId: mailboxItemId,
          credentialType: "app_password",
          plaintext: "fake-password",
        });
        await enqueueJob(client, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId }, { maxAttempts: 1 });
      });
      fixtures.push({ tenantId, member, mailboxItemId });
    }
    const [owner, foreign] = fixtures;
    if (!owner || !foreign) throw new Error("Expected two mailbox fixtures");
    const marker = `synthetic-provider-error-${randomUUID()}`;
    for (const fixture of fixtures) {
      await inTenantTransaction(fixture.tenantId, (client) =>
        writeNotification(client, {
          userId: fixture.member.userId,
          kind: "mail_sync_stalled",
          linkHref: null,
          sourceTable: "tenant_observability_checks",
          sourceId: randomUUID(),
          transitionInstance: "legacy",
          payload: { mailboxItemId: fixture.mailboxItemId, lastError: marker },
        }),
      );
    }
    const tasks = createCoreTaskList(pool, createActionRegistry(), undefined, {
      createImapClient: async () => {
        throw new Error(marker);
      },
    });
    const sync = tasks[CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC];
    if (!sync) throw new Error("Missing mail sync task");
    await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: sync } });
    for (const fixture of fixtures) {
      const state = await inTenantTransaction(fixture.tenantId, (client) =>
        client.query<{ last_error: string | null }>(
          "SELECT last_error FROM mail_account_sync_state WHERE item_id = $1",
          [fixture.mailboxItemId],
        ),
      );
      expect(state.rows).toEqual([{ last_error: marker }]);
    }
    await runAsSystem("mail-stall-http-test", () =>
      handleObservabilityCheckSystemTask(pool, { job: { id: randomUUID() } }),
    );
    for (const [fixture, other] of [
      [owner, foreign],
      [foreign, owner],
    ] as const) {
      const response = await sendOk(fixture.member, { method: "GET", path: "/api/notifications/unread" });
      expect(response).not.toContain(marker);
      expect(response).not.toContain(other.mailboxItemId);
      const body: unknown = JSON.parse(response);
      expect(body).toMatchObject({
        notifications: expect.arrayContaining([
          expect.objectContaining({
            kind: "mail_sync_stalled",
            payload: { mailboxItemId: fixture.mailboxItemId, reason: "other" },
          }),
        ]),
      });
      const storedLegacy = await inTenantTransaction(fixture.tenantId, (client) =>
        client.query<{ payload: unknown }>(
          "SELECT payload FROM notifications WHERE kind = 'mail_sync_stalled' AND transition_instance = 'legacy'",
        ),
      );
      expect(storedLegacy.rows).toEqual([{ payload: { mailboxItemId: fixture.mailboxItemId, lastError: marker } }]);
    }
  }, 120_000);

  it("returns localized active Inbox type fields over authenticated HTTP", async () => {
    for (const [locale, targetLabel] of [
      ["cs", "Úkoly"],
      ["en", "Tasks"],
    ] as const) {
      const tenantId = await createTestTenant(adminPool);
      await provisionTenant(pool, tenantId);
      const typesId = await databaseIdFor(tenantId, "inboxItemTypes");
      const fixture = await inTenantTransaction(tenantId, async (client) => {
        const create = (properties: Record<string, unknown>) =>
          createItemWithClient(client, { databaseId: typesId, properties });
        const task = await create({
          name: "Task",
          emoji: "☑️",
          status: "active",
          processingMethod: "database",
          targetDatabase: "tasks",
        });
        const note = await create({ name: "Note", emoji: "📝", status: "active", processingMethod: "pageContent" });
        const unknown = await create({
          name: "Old",
          emoji: "❔",
          status: "active",
          processingMethod: "database",
          targetDatabase: "tasks",
        });
        const archived = await create({
          name: "Archived",
          emoji: "🗑️",
          status: "archived",
          processingMethod: "pageContent",
        });
        // Older generic writes accepted arbitrary select values; this reproduces a legacy target.
        const changed = await client.query<{ id: string }>(
          "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text)) WHERE database_id = $1 AND id = $2 RETURNING id",
          [typesId, unknown.id, "legacyUnknown"],
        );
        expect(changed.rows).toHaveLength(1);
        return { task, note, unknown, archived };
      });
      const email = `${randomUUID()}@example.test`;
      const password = `pw-${randomUUID()}`;
      const passwordHash = await hashPassword(password);
      await runAsSystem("inbox-type-http-fixture", () =>
        createUser(adminPool, { tenantId, email, passwordHash, locale }),
      );
      const caller = await signIn(email, password, "ios");
      const body: unknown = JSON.parse(await sendOk(caller, { method: "GET", path: "/api/inbox-types" }));
      expect(body).toMatchObject({
        types: expect.arrayContaining([
          {
            id: fixture.task.id,
            emoji: "☑️",
            label: "Task",
            processingMethod: "database",
            targetDatabaseKey: "tasks",
            targetLabel,
          },
          {
            id: fixture.note.id,
            emoji: "📝",
            label: "Note",
            processingMethod: "pageContent",
            targetDatabaseKey: null,
            targetLabel: null,
          },
          {
            id: fixture.unknown.id,
            emoji: "❔",
            label: "Old",
            processingMethod: "database",
            targetDatabaseKey: "legacyUnknown",
            targetLabel: "legacyUnknown",
          },
        ]),
      });
      expect(readIdArray(JSON.stringify(body), "types")).not.toContain(fixture.archived.id);
    }
  });

  it("returns localized model and operation breakdowns over authenticated HTTP", async () => {
    for (const [locale, expectedModel, expectedOperation] of [
      ["cs", "Diarizace", "Rozpoznání mluvčích"],
      ["en", "Diarization", "Speaker recognition"],
    ] as const) {
      const tenantId = await createTestTenant(adminPool);
      const email = `${randomUUID()}@example.test`;
      const password = `pw-${randomUUID()}`;
      const passwordHash = await hashPassword(password);
      await runAsSystem("usage-http-fixture", () => createUser(adminPool, { tenantId, email, passwordHash, locale }));
      const caller = await signIn(email, password, "ios");
      await runInTenant(tenantId, async () => {
        const invocation = await createAgentRun(pool, { triggeredBy: "user", task: "usage", unit: "invocation" });
        const session = await createAgentRun(pool, { triggeredBy: "user", task: "usage", unit: "session" });
        for (const run of [invocation, session]) {
          await recordTokenGatewayCall(pool, {
            provider: "anthropic",
            model: "claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 1,
            agentRunId: run.id,
            operation: "agent_turn",
          });
        }
        const audio = await reserveGatewayCall(pool, {
          provider: "pyannoteai",
          model: "pyannote-3",
          estimatedCostUsd: 1,
          operation: "transcription_diarize",
        });
        await settleAudioGatewayCall(pool, audio.id, { audioSeconds: 60, costUsd: 1 });
      });
      const clock = await adminPool.query<{ now: Date }>("SELECT now() AS now");
      const instant = clock.rows[0]?.now.getTime();
      if (instant === undefined) throw new Error("Missing database time");
      const range = new URLSearchParams({
        from: new Date(instant - 86_400_000).toISOString(),
        to: new Date(instant + 86_400_000).toISOString(),
      });
      const answer = await send(caller, { method: "GET", path: `/api/ai-usage?${range.toString()}` });
      expect(answer.status).toBe(200);
      const body: unknown = JSON.parse(answer.text);
      if (
        !isRecord(body) ||
        !Array.isArray(body.byModel) ||
        !Array.isArray(body.byOperation) ||
        !Array.isArray(body.rows)
      )
        throw new Error("Invalid usage response");
      expect(body).toMatchObject({ totalCostUsd: 3, estimated: false });
      expect(body.byModel).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "anthropic",
            model: "claude-sonnet-5",
            displayName: "Claude Sonnet",
            callCount: 2,
            inputTokens: 20,
            outputTokens: 10,
            audioSeconds: null,
            costUsd: 2,
            operations: ["agent_turn"],
          }),
          expect.objectContaining({
            provider: "pyannoteai",
            model: "pyannote-3",
            displayName: expectedModel,
            callCount: 1,
            inputTokens: null,
            outputTokens: null,
            audioSeconds: 60,
            costUsd: 1,
            operations: ["transcription_diarize"],
          }),
        ]),
      );
      expect(body.byModel).toHaveLength(2);
      expect(body.byModel.every((entry: unknown) => isRecord(entry) && !("runUnit" in entry))).toBe(true);
      expect(body.byOperation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "transcription_diarize",
            label: expectedOperation,
            costUsd: 1,
            callCount: 1,
          }),
        ]),
      );
      expect(body.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: "claude-sonnet-5", runUnit: "invocation", callCount: 1 }),
          expect.objectContaining({ model: "claude-sonnet-5", runUnit: "session", callCount: 1 }),
          expect.objectContaining({ model: "pyannote-3", nativeUnit: "audio_seconds", audioSeconds: 60 }),
        ]),
      );
    }
  });

  it("triggers an automation over authenticated HTTP and rejects a second request while its worker runs", async () => {
    const heartbeat = await runInTenant(b.tenantId, () =>
      withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: b.projectItemId,
          name: "Manual worker evidence",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "manual evidence" },
        }),
      ),
    );
    const path = `/api/heartbeats/${heartbeat.id}/trigger`;
    const first = await send(b.member, { method: "POST", path, body: {} });
    expect(first.status).toBe(202);
    const firstBody: unknown = JSON.parse(first.text);
    if (!isRecord(firstBody) || typeof firstBody.jobKey !== "string") throw new Error("Missing job key");
    expect(firstBody.activeRun).toBeNull();
    let releaseRun: () => void = () => {};
    let signalStarted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const workerPool = await createRuntimeRolePool(adminPool, "semprec_data");
    workerPool.options.max = 5;
    workerPool.options.connectionTimeoutMillis = 2000;
    workerPool.options.statement_timeout = 3000;
    workerPool.options.query_timeout = 4000;
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(workerPool, async () => {
        signalStarted();
        await gate;
        return { result: "done" };
      }),
    );
    const task = createCoreTaskList(workerPool, registry)[AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT];
    if (!task) {
      const failure = new Error("Missing heartbeat worker task");
      let cleanupFailure: { error: unknown } | undefined;
      try {
        await workerPool.end();
      } catch (cleanup) {
        cleanupFailure = { error: cleanup };
      }
      if (cleanupFailure)
        throw new AggregateError([failure, cleanupFailure.error], "Worker setup cleanup failed", { cause: failure });
      throw failure;
    }
    const observer = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 3000,
      query_timeout: 4000,
    });
    const invalidations: Array<{ tenantId: string; threadId: string }> = [];
    setSempThreadInvalidationHook((event) => invalidations.push(event));
    let runner: Awaited<ReturnType<typeof runWorker>> | undefined;
    let running: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    let runningFailureObserved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      runner = await runWorker({
        pgPool: workerPool,
        taskList: { [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: task },
        concurrency: 1,
        pollInterval: 50,
        noHandleSignals: true,
      });
      running = runner.promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const startOutcome = await Promise.race([
        started.then(() => ({ kind: "started" as const })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker did not start")), 5000);
        }),
        running.then((result) => ({ kind: "settled" as const, result })),
      ]);
      if (startOutcome.kind === "settled") {
        if (!startOutcome.result.ok) {
          runningFailureObserved = true;
          throw startOutcome.result.error;
        }
        throw new Error("Worker stopped before start");
      }
      const runs = await runInTenant(b.tenantId, () => listAgentRunsByHeartbeat(pool, heartbeat.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "running", actorUserId: b.member.userId, parentRunId: null });
      expect(invalidations).toEqual([{ tenantId: b.tenantId, threadId: runs[0]?.threadId }]);
      const second = await send(b.member, { method: "POST", path, body: {} });
      expect(second.status).toBe(409);
      const body: unknown = JSON.parse(second.text);
      expect(body).toMatchObject({
        error: {
          code: "heartbeat_running",
          details: {
            activeRun: {
              id: runs[0]?.id,
              status: "running",
              triggeredBy: "heartbeat",
              threadId: runs[0]?.threadId,
            },
          },
        },
      });
    } catch (error) {
      failure = { error };
    }
    if (timer) clearTimeout(timer);
    releaseRun();
    const cleanupErrors: unknown[] = [];
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const job = await observer.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1",
          [firstBody.jobKey],
        );
        if (job.rows[0]?.count === 0) break;
        if (Date.now() >= deadline) throw new Error("Worker did not finish publishing its job outcome");
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (runner) {
      try {
        await runner.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (running) {
        const result = await running;
        if (!result.ok && !runningFailureObserved) cleanupErrors.push(result.error);
      }
    }
    try {
      await workerPool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await observer.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    setSempThreadInvalidationHook(() => {});
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "HTTP worker cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
    const runs = await runInTenant(b.tenantId, () => listAgentRunsByHeartbeat(pool, heartbeat.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "done",
      parentRunId: null,
      actorUserId: b.member.userId,
      heartbeatOccurrenceId: null,
      retryOfRunId: null,
      attempt: 1,
    });
  });

  it("drains an owned worker when heartbeat setup fails before the action", async () => {
    const heartbeat = await runInTenant(b.tenantId, () =>
      withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: b.projectItemId,
          name: "Pre-action failure",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "not invoked" },
        }),
      ),
    );
    const answer = await send(b.member, { method: "POST", path: `/api/heartbeats/${heartbeat.id}/trigger`, body: {} });
    expect(answer.status).toBe(202);
    const body: unknown = JSON.parse(answer.text);
    if (!isRecord(body) || typeof body.jobKey !== "string") throw new Error("Missing job key");
    const owned = await createRuntimeRolePool(adminPool, "semprec_data");
    owned.options.max = 5;
    owned.options.connectionTimeoutMillis = 2000;
    owned.options.statement_timeout = 3000;
    owned.options.query_timeout = 4000;
    const observer = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 3000,
      query_timeout: 4000,
    });
    let signalFailure: () => void = () => {};
    const observed = new Promise<void>((resolve) => {
      signalFailure = resolve;
    });
    const injected = new Error("pre-action connection failure");
    let injectedOnce = false;
    const actionPool = new Proxy(owned, {
      get(target, property, receiver) {
        if (property === "connect" && !injectedOnce)
          return () => {
            injectedOnce = true;
            signalFailure();
            return Promise.reject(injected);
          };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let invoked = false;
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(actionPool, async () => {
        invoked = true;
        return { result: "unexpected" };
      }),
    );
    const task = createCoreTaskList(actionPool, registry)[AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT];
    let runner: Awaited<ReturnType<typeof runWorker>> | undefined;
    let running: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!task) throw new Error("Missing heartbeat worker task");
      runner = await runWorker({
        pgPool: owned,
        taskList: { [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: task },
        concurrency: 1,
        pollInterval: 50,
        noHandleSignals: true,
      });
      running = runner.promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([
        observed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Pre-action failure did not occur")), 5000);
        }),
      ]);
      const deadline = Date.now() + 5000;
      for (;;) {
        const row = await observer.query<{ last_error: string | null }>(
          "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
          [body.jobKey],
        );
        if (row.rows[0]?.last_error?.includes(injected.message)) break;
        if (Date.now() >= deadline) throw new Error("Worker did not publish its setup failure");
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) {
      failure = { error };
    }
    if (timer) clearTimeout(timer);
    const errors: unknown[] = [];
    if (runner) {
      try {
        await runner.stop();
      } catch (error) {
        errors.push(error);
      }
      if (running) {
        const result = await running;
        if (!result.ok) errors.push(result.error);
      }
    }
    try {
      await owned.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await observer.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Pre-action worker cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    expect(invoked).toBe(false);
    expect(await runInTenant(b.tenantId, () => listAgentRunsByHeartbeat(pool, heartbeat.id))).toEqual([]);
    const row = await adminPool.query<{ last_error: string | null }>(
      "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
      [body.jobKey],
    );
    expect(row.rows[0]?.last_error).toContain(injected.message);
  });

  it("bounds the owned job observer when its database read is blocked", async () => {
    const observer = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 1000,
      statement_timeout: 400,
      query_timeout: 1500,
    });
    let release: () => void = () => {};
    let announce: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const holder = runInTenant(b.tenantId, () =>
      withTransaction(observer, async (client) => {
        await client.query("LOCK TABLE graphile_worker._private_jobs IN ACCESS EXCLUSIVE MODE");
        announce();
        await gate;
      }),
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let failure: { error: unknown } | undefined;
    let holderFailureObserved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        locked.then(() => ({ kind: "locked" as const })),
        holder.then((outcome) => ({ kind: "settled" as const, outcome })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Observer lock did not start")), 2000);
        }),
      ]);
      if (result.kind === "settled") {
        if (!result.outcome.ok) {
          holderFailureObserved = true;
          throw result.outcome.error;
        }
        throw new Error("Observer lock ended too early");
      }
      let refusal: unknown;
      try {
        await observer.query("SELECT count(*) FROM graphile_worker.jobs");
        throw new Error("Blocked observer unexpectedly completed");
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: "57014" });
    } catch (error) {
      failure = { error };
    }
    if (timer) clearTimeout(timer);
    release();
    const held = await holder;
    const errors: unknown[] = [];
    if (!held.ok && !holderFailureObserved) errors.push(held.error);
    try {
      const result = await observer.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs");
      expect(result.rows[0]?.count).toEqual(expect.any(Number));
    } catch (error) {
      errors.push(error);
    }
    try {
      await observer.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Observer cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
  });

  it("refuses disabled and item-event automations over authenticated HTTP", async () => {
    const heartbeats = await runInTenant(b.tenantId, () =>
      withTransaction(pool, async (client) => {
        const disabled = await createHeartbeat(client, {
          projectItemId: b.projectItemId,
          name: "Disabled manual evidence",
          rule: { kind: "interval", minutes: 5 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          enabled: false,
        });
        const event = await createHeartbeat(client, {
          projectItemId: b.projectItemId,
          name: "Event manual evidence",
          rule: { kind: "onItemEvent", databaseId: b.databaseId, event: "create" },
          actionId: CORE_AGENT_RUN_ACTION_ID,
        });
        return { disabled, event };
      }),
    );
    for (const [heartbeat, code] of [
      [heartbeats.disabled, "heartbeat_disabled"],
      [heartbeats.event, "heartbeat_event_triggered"],
    ] as const) {
      const answer = await send(b.member, {
        method: "POST",
        path: `/api/heartbeats/${heartbeat.id}/trigger`,
        body: {},
      });
      expect(answer.status).toBe(409);
      const body: unknown = JSON.parse(answer.text);
      expect(body).toMatchObject({ error: { code } });
      expect(await runInTenant(b.tenantId, () => listAgentRunsByHeartbeat(pool, heartbeat.id))).toEqual([]);
      const jobs = await runInTenant(b.tenantId, () =>
        pool.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1", [
          `heartbeat-fire:manual:${heartbeat.id}`,
        ]),
      );
      expect(jobs.rows[0]?.count).toBe(0);
    }
  });

  it("validates notification preferences over HTTP without changing stored values", async () => {
    const path = "/api/notification-preferences";
    const beforeText = await sendOk(a.member, { method: "GET", path });
    const before: unknown = JSON.parse(beforeText);
    if (!isRecord(before) || typeof before.approvals !== "boolean") throw new Error("Invalid preferences response");
    try {
      const changed: unknown = JSON.parse(
        await sendOk(a.member, { method: "PATCH", path, body: { approvals: false } }),
      );
      expect(changed).toMatchObject({ approvals: false });
      const persisted = await sendOk(a.member, { method: "GET", path });
      expect(JSON.parse(persisted)).toEqual(changed);
      for (const [body, field] of [
        [{ problemsLevel: "invalid" }, "problemsLevel"],
        [{ approvals: true, "private-key-sentinel": "private-value-sentinel" }, "body"],
      ] as const) {
        const errorLog = vi.spyOn(logger, "error");
        const warnLog = vi.spyOn(logger, "warn");
        let answer: Awaited<ReturnType<typeof send>>;
        try {
          answer = await send(a.member, { method: "PATCH", path, body });
          expect(errorLog).not.toHaveBeenCalled();
          expect(warnLog).not.toHaveBeenCalled();
        } finally {
          errorLog.mockRestore();
          warnLog.mockRestore();
        }
        expect(answer.status).toBe(400);
        const response: unknown = JSON.parse(answer.text);
        expect(response).toMatchObject({ error: { code: "validation_failed", details: { field } } });
        expect(answer.text).not.toContain("private-key-sentinel");
        expect(answer.text).not.toContain("private-value-sentinel");
        expect(await sendOk(a.member, { method: "GET", path })).toBe(persisted);
      }
    } finally {
      await sendOk(a.member, { method: "PATCH", path, body: { approvals: before.approvals } });
    }
  });

  it("omits a historical foreign blob from an authenticated item envelope", async () => {
    const path = `/api/items/${a.fileItemId}`;
    const ownText = await sendOk(a.member, { method: "GET", path });
    const own: unknown = JSON.parse(ownText);
    if (!isRecord(own) || !isRecord(own.properties)) throw new Error("expected item properties");
    expect(own).toHaveProperty("blobs.file.blobId", a.blobId);
    const original = own.properties;
    const historical = { ...original, file: { blobId: b.blobId } };
    // Historical invalid JSONB predates the blob-reference guard; the fixture is tenant-scoped.
    async function replaceProperties(properties: Record<string, unknown>) {
      await inTenantTransaction(a.tenantId, async (client) => {
        const result = await client.query("UPDATE items SET properties = $3::jsonb WHERE tenant_id = $1 AND id = $2", [
          a.tenantId,
          a.fileItemId,
          JSON.stringify(properties),
        ]);
        expect(result.rowCount).toBe(1);
      });
    }
    try {
      await replaceProperties(historical);
      const answer = await send(a.member, { method: "GET", path });
      expect(answer.status).toBe(200);
      const body: unknown = JSON.parse(answer.text);
      expect(body).toMatchObject({ properties: historical });
      expect(body).not.toHaveProperty("blobs");
    } finally {
      await replaceProperties(original);
    }
  });

  it("isolates link operations through HTTP and MCP on the runtime role", async () => {
    const cp = createChokePoint(pool);
    const setup = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const database = await cp.createDatabase({ name: "Link isolation" });
        await cp.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
        const source = await cp.createItem({ databaseId: database.id, properties: { note: "source" } });
        const target = await cp.createItem({ databaseId: database.id, properties: { note: "target" } });
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: target.id,
            propertyKey: "note",
            ruleKey: "test",
            sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "note" }],
          }),
        );
        return target.id;
      });
    const foreign = await setup(a.tenantId);
    const own = await setup(b.tenantId);
    const readForeign = () => send(a.member, { method: "GET", path: `/api/items/${foreign}?include=links` });
    const before = await readForeign();
    expect(before.status).toBe(200);
    for (const action of ["unlink", "relink"]) {
      const refused = await expectForeignLikeRandom(b.member, [foreign], ([id]) => ({
        method: "POST",
        path: `/api/items/${id}/links/note/${action}`,
      }));
      expect(refused.status).toBe(404);
      expect((await send(b.member, { method: "POST", path: `/api/items/${own}/links/note/${action}` })).status).toBe(
        200,
      );
      expect(await readForeign()).toEqual(before);
    }
    for (const caller of [b.member, mcpRunCredential]) {
      for (const action of ["unlink", "relink"] as const) {
        const operation: GenericOperationName = action === "unlink" ? "link.unlink" : "link.relink";
        const refused = await expectForeignLikeRandom(caller, [foreign], ([itemId]) =>
          mcpCall(operation, { itemId, propertyKey: "note" }),
        );
        expect(refused.status).toBe(200);
        expect(refused.text).toContain('"error"');
        const allowed = await send(caller, mcpCall(operation, { itemId: own, propertyKey: "note" }));
        expect(allowed.status).toBe(200);
        expect(allowed.text).not.toContain('"error"');
        expect(await readForeign()).toEqual(before);
      }
    }
  });

  it("answers A's own ids differently from random ids on every probed route, so a foreign answer is a real refusal", async () => {
    // Positive control for the tenant cases: for each id they probe, A naming its own row must
    // take another branch than A naming a random id. Mutating probes are idempotent for A's rows
    // or are undone right after; the destructive routes share their ids with a read probed here.
    for (const probe of ownerProbes()) {
      const random = probe.ids.map(() => randomUUID());
      const own = await send(a.member, probe.build(probe.ids));
      const unknown = await send(a.member, probe.build(random));
      const label = `${probe.label}: ${own.status} ${own.text.slice(0, 200)}`;
      expect.soft(masked(own, probe.ids), label).not.toEqual(masked(unknown, random));
      if (probe.status !== undefined) expect.soft(own.status, label).toBe(probe.status);
      if (probe.contains !== undefined) {
        expect
          .soft(
            probe.contains.filter((value) => !own.text.includes(value)),
            label,
          )
          .toEqual([]);
      }
      await probe.undo?.();
    }
    a.itemVersion = readString(await sendOk(a.member, { method: "GET", path: `/api/items/${a.itemId}` }), "updatedAt");
  });

  for (const entry of API_ENTRIES) {
    const run = ROUTE_CASES[entry.name];
    it(`${entry.tenancy}: ${entry.name} (${entry.method} ${entry.path})`, async () => {
      if (!run) throw new Error(`no isolation case for '${entry.name}'`);
      await run();
    });
  }

  describe("MCP generic operations", () => {
    it("has a case for every generic operation", () => {
      expect(Object.keys(MCP_CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
    });

    it("serves B's own rows to both callers, so a foreign answer is a real refusal", async () => {
      for (const caller of [b.member, mcpRunCredential]) {
        const own = await send(caller, mcpCall("item.get", { itemId: b.itemId }));
        expect(own.status).toBe(200);
        expect(own.text).toContain(b.itemId);
        expect(own.text).not.toContain('"error"');
      }
    });

    for (const operation of GENERIC_OPERATION_NAMES) {
      for (const via of ["session bearer", "mcp run credential"] as const) {
        it(`${operation} via ${via}`, async () => {
          const caller = via === "session bearer" ? b.member : mcpRunCredential;
          await leavesAUnchanged(() => MCP_CASES[operation](mcpProbe(caller, operation)));
        });
      }
    }
  });
});
