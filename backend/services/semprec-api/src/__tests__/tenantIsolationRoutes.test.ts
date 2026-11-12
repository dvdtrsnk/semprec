import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { z } from "zod";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { Pool, type PoolClient } from "pg";
import {
  CAPABILITY_IDS,
  fingerprintGuidanceDriftSubject,
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
  ensureFolderItem,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  reconcileGmailAccount,
  resetDatabase,
  setTenantAiBudget,
  storeCredential,
  type GmailMailClient,
} from "@semprec/data/testSupport";
import {
  agentGuidanceDriftFindingsStore,
  createActionRegistry,
  coreAgentRunAction,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createHeartbeat,
  createInvite,
  createItemWithClient,
  createPasswordResetToken,
  createPendingApprovalRequest,
  createUser,
  generateOpaqueToken,
  getDatabaseByModuleId,
  getPasswordResetTokenByHash,
  getUserById,
  transcriptionSourceLink,
  updateItemWithClient,
  writeComputed,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
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
  MailAuthFailedError,
  provisionTenant,
  raiseProblem,
  recordTokenGatewayCall,
  reserveGatewayCall,
  resolveMailModuleIds,
  resolveNotificationsBySource,
  settleAudioGatewayCall,
  storeMessageSpeech,
  setSempThreadInvalidationHook,
  setInvalidationHook,
  type InvalidationEvent,
  revokeInvite,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  writeNotification,
  upsertMailServerSettings,
  type PasswordResetMailer,
} from "@semprec/data";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob, runOnce, runWorker, type TaskList } from "@semprec/queue";
import { createDispatcher } from "../app.js";
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
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
const MAILBOX_PASSWORD = "isolation-mailbox-password";
const REFUSED_MAILBOX_PASSWORD = "isolation-refused-mailbox-password";

/**
 * What the composition root hands the password connect route (issue gh-1736). The mail server accepts every
 * login except one with `REFUSED_MAILBOX_PASSWORD`, so a case creates mailboxes and none reaches a real server.
 */
const MAILBOX_PASSWORD_DEPENDENCIES: CustomRouteDependencies = {
  mailServerClients: {
    verifyPassword: async (input) => {
      if (input.password === REFUSED_MAILBOX_PASSWORD) throw new MailAuthFailedError();
      return {
        imap: { host: input.imapHost ?? "imap.mail.me.com", port: 993, security: "tls" },
        smtp: { host: input.smtpHost ?? "smtp.mail.me.com", port: 465, security: "tls" },
      };
    },
  },
};
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-isolation-${randomUUID()}`);
const filesStorage = new LocalFsBlobStorageWriter(join(tmpBlobDir, "files"));
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

/**
 * What the composition root hands the mail sign-in routes (issue gh-1686). The provider refuses every
 * authorization code, so a case can get as far as the provider call and none reaches a real provider.
 */
const MAIL_OAUTH_DEPENDENCIES: CustomRouteDependencies = {
  oauth: {
    gmail: { clientId: "isolation-gmail-client", clientSecret: "isolation-gmail-secret" },
    redirectBaseUrl: "https://app.example.test",
  },
  outboundHttp: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
};

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

function readNumber(text: string, field: string): number {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body)) throw new Error(`expected a JSON object in ${text}`);
  const value = body[field];
  if (typeof value !== "number") throw new Error(`expected a number at '${field}' in ${text}`);
  return value;
}

/** `GET /api/approval-requests/:id`. */
function approvalRequestRead(id: string): Request {
  return { method: "GET", path: `/api/approval-requests/${id}` };
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

interface SeededSubpage {
  hostItemId: string;
  pageItemId: string;
}

/**
 * A subpage under a fresh host item of `tenant`, created through the real routes. These are rows of the one case that
 * asks for them: a case that needs a page changes none of the rows A and B share with the other cases.
 */
async function seedSubpage(tenant: TenantFixture): Promise<SeededSubpage> {
  const hostItemId = readString(
    await sendOk(tenant.member, {
      method: "POST",
      path: `/api/databases/${tenant.databaseId}/items`,
      body: { properties: {} },
    }),
    "id",
  );
  const created = await sendOk(tenant.member, {
    method: "POST",
    path: `/api/items/${hostItemId}/page/subpages`,
    body: { title: "Isolation page" },
  });
  const page = z.object({ pages: z.array(z.object({ pageItemId: z.string() })).length(1) }).parse(JSON.parse(created))
    .pages[0];
  if (!page) throw new Error("expected one created page");
  return { hostItemId, pageItemId: page.pageItemId };
}

/**
 * A page of A and a page of B for the MCP cases that name a page (`page.duplicate`, `page.rename`). Every MCP case
 * runs inside `leavesAUnchanged`, so A's page cannot be created inside the case; the MCP suite seeds both before its
 * cases.
 */
let mcpPages: { foreign: SeededSubpage; own: SeededSubpage };

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
  // One speaker key, so A's own speaker probes (issue gh-1770) reach the key check and not only the transcript lookup.
  await inTenantTransaction(tenantId, async (client) => {
    const transcripts = await getDatabaseByModuleId(client, "transcripts");
    if (!transcripts) throw new Error("Missing transcripts");
    await writeComputed(client, transcripts.id, transcriptItemId, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, [
      { speaker: "SPEAKER_00", text: "Welcome to the probe.", startsAt: 0, endsAt: 2 },
    ]);
  });
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

/** A Mailboxes item of `tenant` whose `syncStatus` is `needsReauthorization`, written the way the sync job writes it. */
async function mailboxNeedingReauthorization(tenant: TenantFixture): Promise<string> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const mailbox = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "Signed out", provider: "gmail" },
    });
    await updateItemWithClient(
      client,
      { databaseId: mailboxesDatabaseId, itemId: mailbox.id, propertiesPatch: { syncStatus: "needsReauthorization" } },
      { allowedSystemKeys: ["syncStatus"] },
    );
    return mailbox.id;
  });
}

/** A new Mailboxes item of `tenant` with one Inbox folder, the folder created the way folder discovery creates it. */
function mailboxWithInboxFolder(tenant: TenantFixture): Promise<{ mailboxId: string; folderId: string }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const folderProperties = await createChokePoint(pool).listProperties(ids.foldersDatabaseId);
    const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
    if (!mailboxProperty) throw new Error("the Folders database has no mailbox property");
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "With a folder", provider: "gmail" },
    });
    const folderId = await ensureFolderItem(client, {
      foldersDatabaseId: ids.foldersDatabaseId,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId: mailboxProperty.id,
      providerId: "INBOX",
      name: "INBOX",
      behavior: "label",
      specialPurpose: "inbox",
    });
    return { mailboxId: mailbox.id, folderId };
  });
}

/** Starts a Gmail sign-in as `member` through the real route and returns the state the provider would hand back. */
async function startMailOauth(member: Member): Promise<string> {
  const started = await sendOk(member, {
    method: "POST",
    path: "/api/mail/mailboxes/oauth/start",
    body: { provider: "gmail" },
  });
  const state = new URL(readString(started, "authorizeUrl")).searchParams.get("state");
  if (state === null) throw new Error("the authorization URL carries no state");
  return state;
}

interface MailOauthStateSnapshot {
  id: string;
  user_id: string;
  used_at: string | null;
}

/** The sign-in states `tenant` sees in its own scope: all of them, or the one row of `state`. */
async function mailOauthStates(tenant: TenantFixture, state?: string): Promise<MailOauthStateSnapshot[]> {
  const hash = state === undefined ? null : createHash("sha256").update(state, "utf8").digest("hex");
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const { rows } = await client.query<MailOauthStateSnapshot>(
      `SELECT id::text, user_id::text, used_at::text FROM mail_oauth_states
        WHERE $1::text IS NULL OR state_hash = $1 ORDER BY id`,
      [hash],
    );
    return rows;
  });
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

/** Ingests one Gmail message for the fixture's tenant through the real reconcile path; returns its thread id. */
/** `providerId` names the provider's message; a second seed in one tenant needs its own, or it converges on the first. */
function seedMailThread(
  fixture: TenantFixture,
  messageId: string,
  providerId = "message",
  providerThreadId = "thread",
): Promise<string> {
  return runInTenant(fixture.tenantId, () =>
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
        listAllMessageIds: async () => [providerId],
        listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
        fetchMessage: async () => ({
          id: providerId,
          threadId: providerThreadId,
          labelIds: ["INBOX"],
          message: {
            messageId,
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
}

/** A Tasks item of the fixture's tenant linked to mail thread `threadId` through `Threads.tasks`, as a user links it (issue gh-1692). */
async function seedThreadTask(fixture: TenantFixture, threadId: string): Promise<string> {
  return runInTenant(fixture.tenantId, async () => {
    const cp = createChokePoint(pool);
    const { threadsDatabaseId, tasksDatabaseId, threadItemId } = await withTransaction(pool, async (client) => {
      const threads = await getDatabaseByModuleId(client, "threads");
      const tasks = await getDatabaseByModuleId(client, "tasks");
      const { rows } = await client.query<{ item_id: string | null }>(
        "SELECT item_id FROM mail_threads WHERE id = $1",
        [threadId],
      );
      const itemId = rows[0]?.item_id;
      if (!threads || !tasks || !itemId) throw new Error("Missing Threads, Tasks or the thread item");
      return { threadsDatabaseId: threads.id, tasksDatabaseId: tasks.id, threadItemId: itemId };
    });
    const relationProperty = (await cp.listProperties(threadsDatabaseId)).find((entry) => entry.key === "tasks");
    if (!relationProperty) throw new Error("Missing Threads.tasks");
    const task = await cp.createItem({ databaseId: tasksDatabaseId, properties: { name: "Thread task" } });
    await cp.createRelation(
      { relationPropertyId: relationProperty.id, callerItemId: threadItemId, targetItemId: task.id },
      { writerKind: "user" },
    );
    return task.id;
  });
}

/** A Mailboxes item of the fixture's tenant with a credential, a sync state and server settings, for the removal route (issue gh-1690). */
function seedRemovableMailbox(fixture: TenantFixture): Promise<string> {
  return inTenantTransaction(fixture.tenantId, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Removable", provider: "generic" },
    });
    await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: randomUUID() });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
    await upsertMailServerSettings(client, mailbox.id, {
      imap: { host: "imap.example.test", port: 993, security: "tls" },
      smtp: null,
      username: "removable@example.test",
    });
    return mailbox.id;
  });
}

interface RemovableMailboxRows {
  trashed: boolean | null;
  credentials: number;
  syncStates: number;
  serverSettings: number;
}

/** Whether the mailbox is in the trash and how many of its secret-bearing rows exist, read in the fixture's tenant. */
function removableMailboxRows(fixture: TenantFixture, mailboxItemId: string): Promise<RemovableMailboxRows[]> {
  return inTenantTransaction(fixture.tenantId, async (client) => {
    const { rows } = await client.query<RemovableMailboxRows>(
      `SELECT (SELECT deleted_at IS NOT NULL FROM items WHERE id = $1) AS trashed,
              (SELECT count(*)::int FROM external_credentials WHERE item_id = $1) AS credentials,
              (SELECT count(*)::int FROM mail_account_sync_state WHERE item_id = $1) AS "syncStates",
              (SELECT count(*)::int FROM mail_account_server_settings WHERE mailbox_item_id = $1) AS "serverSettings"`,
      [mailboxItemId],
    );
    return rows;
  });
}

const mailThreadFacetsBody = z.object({
  areas: z.object({ total: z.number(), items: z.array(z.object({ id: z.string(), count: z.number() })) }),
  projects: z.object({
    total: z.number(),
    items: z.array(z.object({ id: z.string(), areaId: z.string().nullable(), count: z.number() })),
  }),
});

/**
 * A new mail thread of `tenant` in a new project of a new area: the thread through the real reconcile path, the
 * area, the project and both relations through the choke point (issue gh-1747).
 */
async function mailThreadInProjectOfArea(tenant: TenantFixture): Promise<{ areaId: string; projectId: string }> {
  const threadId = await seedMailThread(
    tenant,
    `<${randomUUID()}@example.test>`,
    `facets-${randomUUID()}`,
    `thread-${randomUUID()}`,
  );
  const threadItemId = await inTenantTransaction(tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ item_id: string | null }>("SELECT item_id FROM mail_threads WHERE id = $1", [
      threadId,
    ]);
    const itemId = rows[0]?.item_id;
    if (!itemId) throw new Error("the seeded mail thread has no Threads item");
    return itemId;
  });
  const projectsDatabaseId = await databaseIdFor(tenant.tenantId, "projects");
  const threadsDatabaseId = await databaseIdFor(tenant.tenantId, "threads");
  const areasDatabaseId = await databaseIdFor(tenant.tenantId, "areas");
  return runInTenant(tenant.tenantId, async () => {
    const chokePoint = createChokePoint(pool);
    const relationPropertyId = async (databaseId: string, key: string): Promise<string> => {
      const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!property) throw new Error(`no '${key}' property in database ${databaseId}`);
      return property.id;
    };
    const area = await chokePoint.createItem({ databaseId: areasDatabaseId, properties: { name: "Facets area" } });
    const project = await chokePoint.createItem({
      databaseId: projectsDatabaseId,
      properties: { name: "Facets project" },
    });
    await chokePoint.createRelation({
      relationPropertyId: await relationPropertyId(projectsDatabaseId, "area"),
      callerItemId: project.id,
      targetItemId: area.id,
    });
    await chokePoint.createRelation({
      relationPropertyId: await relationPropertyId(threadsDatabaseId, "project"),
      callerItemId: threadItemId,
      targetItemId: project.id,
    });
    return { areaId: area.id, projectId: project.id };
  });
}

/** A dated Tasks item of `tenant`, created through the choke point, for the recurrence routes (issue #1665). */
async function datedTask(tenant: TenantFixture): Promise<string> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const tasks = await getDatabaseByModuleId(client, "tasks");
    if (!tasks) throw new Error("Tasks not seeded");
    return (
      await createItemWithClient(client, { databaseId: tasks.id, properties: { name: "Weekly", date: "2026-10-22" } })
    ).id;
  });
}

interface TaskItemSnapshot {
  properties: unknown;
  updated_at: string;
}

interface TaskRecurrenceSnapshot {
  series_id: string;
  mode: string;
  rule: unknown;
  active: boolean;
  anchor_date: string | null;
}

/** A task's stored properties and its `task_recurrence` row, read in its own tenant. */
async function recurrenceState(tenant: TenantFixture, taskId: string): Promise<unknown> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const item = await client.query<TaskItemSnapshot>("SELECT properties, updated_at::text FROM items WHERE id = $1", [
      taskId,
    ]);
    const series = await client.query<TaskRecurrenceSnapshot>(
      "SELECT series_id::text, mode, rule, active, anchor_date::text FROM task_recurrence WHERE item_id = $1",
      [taskId],
    );
    return { item: item.rows, series: series.rows };
  });
}

/** A Tasks item and an Events item of `tenant`, created through the choke point, for the host event routes (issue gh-1764). */
async function taskAndEvent(tenant: TenantFixture): Promise<{ taskId: string; eventId: string }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const tasks = await getDatabaseByModuleId(client, "tasks");
    const events = await getDatabaseByModuleId(client, "events");
    if (!tasks || !events) throw new Error("Tasks or Events not seeded");
    const task = await createItemWithClient(client, {
      databaseId: tasks.id,
      properties: { name: "Hosted", date: "2026-10-22" },
    });
    const event = await createItemWithClient(client, {
      databaseId: events.id,
      properties: { name: "Host", date: "2026-10-16" },
    });
    return { taskId: task.id, eventId: event.id };
  });
}

interface HostEventState {
  edges: Array<{ item_a: string; item_b: string; metadata: unknown }>;
  item: TaskItemSnapshot[];
}

/** A task's stored relation edges, with their metadata, and its stored properties, read in its own tenant. */
async function hostEventState(tenant: TenantFixture, taskId: string): Promise<HostEventState> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const edges = await client.query<HostEventState["edges"][number]>(
      "SELECT item_a, item_b, metadata FROM item_relations WHERE item_a = $1 OR item_b = $1 ORDER BY item_a, item_b",
      [taskId],
    );
    const item = await client.query<TaskItemSnapshot>("SELECT properties, updated_at::text FROM items WHERE id = $1", [
      taskId,
    ]);
    return { edges: edges.rows, item: item.rows };
  });
}

const hostEventPath = (taskId: string, eventId: string): string => `/api/tasks/${taskId}/host-events/${eventId}`;

/** A series' stored `template`, read in its own tenant. */
async function seriesTemplate(tenant: TenantFixture, seriesId: string): Promise<Array<{ template: unknown }>> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ template: unknown }>(
      "SELECT template FROM task_recurrence WHERE series_id = $1::uuid",
      [seriesId],
    );
    return rows;
  });
}

interface SeriesOccurrenceSnapshot extends TaskItemSnapshot {
  id: string;
}

/** The items that carry `seriesId` and the item its `task_recurrence` row points at, read in `tenant`. */
async function seriesOccurrenceState(tenant: TenantFixture, seriesId: string): Promise<unknown> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const items = await client.query<SeriesOccurrenceSnapshot>(
      "SELECT id, properties, updated_at::text FROM items WHERE properties->>'seriesId' = $1 ORDER BY id",
      [seriesId],
    );
    const series = await client.query<{ item_id: string }>(
      "SELECT item_id FROM task_recurrence WHERE series_id = $1::uuid",
      [seriesId],
    );
    return { items: items.rows, series: series.rows };
  });
}

/** The `tags` property of a tenant's Health records, a multi_select of a schema-locked system database (issue #1699). */
async function healthTagsPropertyId(tenant: TenantFixture): Promise<string> {
  const databaseId = await databaseIdFor(tenant.tenantId, "healthRecords");
  const property = await runInTenant(tenant.tenantId, () =>
    createChokePoint(pool).getPropertyByKey(databaseId, "tags"),
  );
  if (!property) throw new Error(`no Health records 'tags' property in tenant ${tenant.tenantId}`);
  return property.id;
}

/**
 * A multi_select property with the option `one`, in a database the tenant's member creates for one case (issue
 * #1699): the case writes its own rows and leaves the shared fixture rows as they are.
 */
async function caseOptionPropertyId(tenant: TenantFixture, databaseName: string): Promise<string> {
  const databaseId = readString(
    await sendOk(tenant.member, { method: "POST", path: "/api/databases", body: { name: databaseName } }),
    "id",
  );
  return readString(
    await sendOk(tenant.member, {
      method: "POST",
      path: `/api/databases/${databaseId}/properties`,
      body: {
        key: "choice",
        name: "Choice",
        type: "multi_select",
        config: { options: [{ key: "one", label: "One" }] },
      },
    }),
    "id",
  );
}

interface StoredOption {
  key: string;
  label?: string;
  color?: string;
}

const storedOptionsBody = z.object({
  config: z.object({
    options: z.array(z.looseObject({ key: z.string(), label: z.string().optional(), color: z.string().optional() })),
  }),
});

/** A property's stored options as its own tenant's member reads them over `GET /api/properties/:id`. */
async function storedOptions(tenant: TenantFixture, propertyId: string): Promise<StoredOption[]> {
  const text = await sendOk(tenant.member, { method: "GET", path: `/api/properties/${propertyId}` });
  return storedOptionsBody.parse(JSON.parse(text)).config.options;
}

/** The `medication` option of the Health records `tags` exactly as the seed stores it: a color and no label (issue #1705). */
const SEEDED_MEDICATION_OPTION: StoredOption = { key: "medication", color: "#AF52DE" };

interface ActionItemWorld {
  eventId: string;
  transcriptId: string;
}

interface SpeakerWorld {
  eventId: string;
  transcriptId: string;
  personId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name of the task the action item of `seedActionItemWorld` becomes; no other case writes a task of that name. */
const ACTION_ITEM_TASK_NAME = "Send the revised offer";

/**
 * An Event and a transcript linked to it whose stored notes hold one action item without an owner, in
 * the tenant of `tenant`. The shared rows of the fixture are not touched; the ids are used by the cases
 * of issue gh-1767 only.
 */
async function seedActionItemWorld(tenant: TenantFixture): Promise<ActionItemWorld> {
  const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
    const transcripts = await getDatabaseByModuleId(client, "transcripts");
    if (!transcripts) throw new Error("Missing transcripts");
    const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Offer" } });
    // The notes only the transcription process writes, as its step 5 stores them.
    await writeComputed(client, transcripts.id, item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, {
      title: "Offer",
      summary: "",
      shortSummary: "",
      decisions: [],
      actionItems: [{ text: ACTION_ITEM_TASK_NAME, ownerSpeaker: null, due: "2026-10-23", startsAt: null }],
    });
    return item.id;
  });
  const created = await sendOk(tenant.member, {
    method: "POST",
    path: `/api/databases/${await databaseIdFor(tenant.tenantId, "events")}/items`,
    body: { properties: { name: "Offer meeting", date: "2026-10-16" } },
  });
  const eventId = readString(created, "id");
  await sendOk(tenant.member, {
    method: "PUT",
    path: `/api/items/${transcriptId}/relations/event/${eventId}`,
    body: {},
  });
  return { eventId, transcriptId };
}

/**
 * A transcript with one speaker, SPEAKER_00, an Event it is linked to and a person who participates in that
 * Event, in the tenant of `tenant`. The shared rows of the fixture are not touched; the ids are used by the
 * cases of issue gh-1770 only.
 */
async function seedSpeakerWorld(tenant: TenantFixture): Promise<SpeakerWorld> {
  const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
    const transcripts = await getDatabaseByModuleId(client, "transcripts");
    if (!transcripts) throw new Error("Missing transcripts");
    const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Speakers" } });
    // The segments only the transcription process writes, as its merge step stores them.
    await writeComputed(client, transcripts.id, item.id, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, [
      { speaker: "SPEAKER_00", text: "Welcome to the speaker probe.", startsAt: 0, endsAt: 2 },
    ]);
    return item.id;
  });
  const create = async (moduleId: string, properties: Record<string, unknown>): Promise<string> =>
    readString(
      await sendOk(tenant.member, {
        method: "POST",
        path: `/api/databases/${await databaseIdFor(tenant.tenantId, moduleId)}/items`,
        body: { properties },
      }),
      "id",
    );
  const eventId = await create("events", { name: "Speaker probe", date: "2026-10-16" });
  const personId = await create("people", { name: "Speaker probe person" });
  await sendOk(tenant.member, { method: "PUT", path: `/api/items/${eventId}/relations/people/${personId}`, body: {} });
  await sendOk(tenant.member, {
    method: "PUT",
    path: `/api/items/${transcriptId}/relations/event/${eventId}`,
    body: {},
  });
  return { eventId, transcriptId, personId };
}

/** The state rows of one transcript and the live tasks of the action item's name in the tenant, read inside the tenant. */
async function actionItemRows(
  tenant: TenantFixture,
  transcriptId: string,
): Promise<{ states: { action_item_id: number; state: string; task_item_id: string | null }[]; tasks: string[] }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const states = await client.query<{ action_item_id: number; state: string; task_item_id: string | null }>(
      "SELECT action_item_id, state, task_item_id FROM transcript_action_item_states WHERE transcript_item_id = $1 ORDER BY action_item_id",
      [transcriptId],
    );
    const tasks = await client.query<{ id: string }>(
      `SELECT item.id FROM items item JOIN databases db ON db.id = item.database_id
        WHERE db.owner_module_id = 'tasks' AND item.deleted_at IS NULL AND item.properties->>'name' = $1
        ORDER BY item.id`,
      [ACTION_ITEM_TASK_NAME],
    );
    return { states: states.rows, tasks: tasks.rows.map((row) => row.id) };
  });
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
  // Each tenant's project gets one active finding through the findings store; B's list must show
  // only its own, and A's project id must answer exactly like a random id.
  "project guidance drift read": async () => {
    const findingIds: string[] = [];
    for (const fixture of [a, b]) {
      const subject = { operation: "items.delete", databaseId: null };
      const finding = await runInTenant(fixture.tenantId, () =>
        withTransaction(pool, (client) =>
          agentGuidanceDriftFindingsStore.upsertActive(client, {
            projectItemId: fixture.projectItemId,
            fingerprint: fingerprintGuidanceDriftSubject(fixture.projectItemId, "permission", subject),
            payload: {
              kind: "permission",
              subject,
              claim: "Guidance allows deleting tasks",
              guidanceExcerpt: "Delete tasks freely",
              manifestFacts: ["items.delete is not granted"],
              severity: "blocking",
            },
            seenAt: new Date("2026-10-01T08:00:00.000Z"),
          }),
        ),
      );
      findingIds.push(finding.finding.id);
    }
    // R1 F4: a project lists its findings only once it has guidance, so B saves its guidance through
    // the real route first, against its current version (an earlier case may already have saved one).
    const current: unknown = JSON.parse(
      await sendOk(b.member, { method: "GET", path: `/api/projects/${b.projectItemId}/agent-guidance` }),
    );
    const expectedUpdatedAt = isRecord(current) && typeof current.updatedAt === "string" ? current.updatedAt : null;
    await sendOk(b.member, {
      method: "PUT",
      path: `/api/projects/${b.projectItemId}/agent-guidance`,
      body: { sections: { purpose: "Drift", allowed: "", notAllowed: "", generalInstructions: "" }, expectedUpdatedAt },
    });
    const own = await sendOk(b.member, {
      method: "GET",
      path: `/api/projects/${b.projectItemId}/agent-guidance/drift`,
    });
    expect(own).toContain(findingIds[1]);
    expect(own).not.toContain(findingIds[0]);
    const result = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => ({
      method: "GET",
      path: `/api/projects/${id}/agent-guidance/drift`,
    }));
    expect(result.status).toBe(404);
    expect(result.text).not.toContain(findingIds[0]);
  },
  "guidance drift resolve": async () => {
    const subject = { operation: "items.delete", databaseId: null };
    const finding = await runInTenant(a.tenantId, () =>
      withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId: a.projectItemId,
          fingerprint: fingerprintGuidanceDriftSubject(a.projectItemId, "permission", subject),
          payload: {
            kind: "permission",
            subject,
            claim: "Claim",
            guidanceExcerpt: "Excerpt",
            manifestFacts: ["Fact"],
            severity: "blocking",
          },
          seenAt: new Date("2026-10-01T08:00:00.000Z"),
        }),
      ),
    );
    const state = () =>
      runInTenant(a.tenantId, async () => ({
        finding: (
          await pool.query<{
            id: string;
            status: string;
            resolved_by: string | null;
            resolution_choice: string | null;
            resolved_at: Date | null;
          }>(
            "SELECT id, status, resolved_by, resolution_choice, resolved_at FROM agent_guidance_drift_findings WHERE id = $1",
            [finding.finding.id],
          )
        ).rows,
        guidance: (
          await pool.query<{ project_item_id: string; markdown: string; updated_at: Date }>(
            "SELECT project_item_id, markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
            [a.projectItemId],
          )
        ).rows,
        notifications: (
          await pool.query<{ id: string; payload: unknown }>(
            "SELECT id, payload FROM notifications WHERE source_id = $1 ORDER BY id",
            [finding.finding.id],
          )
        ).rows,
      }));
    const before = await state();
    const jobs = await adminPool.query<{ id: string; key: string | null }>(
      "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
    );
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const result = await expectForeignLikeRandom(b.member, [finding.finding.id], ([id]) => ({
        method: "POST",
        path: `/api/agent-guidance-drift/${id}/resolve`,
        body: { choice: "dismiss", expectedGuidanceUpdatedAt: null },
      }));
      expect(result.status).toBe(404);
    } finally {
      setInvalidationHook(() => {});
    }
    expect(await state()).toEqual(before);
    expect(
      (
        await adminPool.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        )
      ).rows,
    ).toEqual(jobs.rows);
    expect(events).toEqual([]);
  },
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
  "revoke other sessions": async () => {
    // A member of a third tenant calls it: B's own sessions are fixtures the cases after this one use.
    const caller = await signUp(await createTestTenant(adminPool), "member");
    const second = await signIn(caller.email, caller.password, "ios");
    const answer = await send(caller, { method: "POST", path: "/api/auth/sessions/revoke-others", body: {} });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.text).toBe(JSON.stringify({ revokedCount: 1 }));
    expect((await send(second, { method: "GET", path: "/api/auth/session" })).status).toBe(401);
    expectNoneOf(answer.text, a.ids, "revoke other sessions");
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
  "change password": async () => {
    // A member of a third tenant calls it: B's password and sessions are fixtures the cases after this one use.
    const caller = await signUp(await createTestTenant(adminPool), "member");
    const second = await signIn(caller.email, caller.password, "ios");
    // `users` and `password_reset_tokens` are global identity tables, read in the system scope the route uses.
    const passwordHashOf = async (userId: string): Promise<string> => {
      const user = await runAsSystem("isolation test user read", () => getUserById(pool, userId));
      if (!user) throw new Error(`no user ${userId}`);
      return user.passwordHash;
    };
    // An unconsumed reset token of A, seeded here: the caller's change must leave it unconsumed.
    const resetToken = generateOpaqueToken();
    await runAsSystem("isolation test reset token", () =>
      createPasswordResetToken(pool, {
        userId: a.member.userId,
        tokenHash: resetToken.tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }),
    );
    const hashesBefore = { a: await passwordHashOf(a.member.userId), b: await passwordHashOf(b.member.userId) };
    const newPassword = `pw-${randomUUID()}`;
    const change = (currentPassword: string): Request => ({
      method: "POST",
      path: "/api/auth/password-change",
      body: { currentPassword, newPassword },
    });

    // A's real password is a wrong current password for the caller: it is refused exactly as any other.
    const refused = await expectForeignLikeRandom(caller, [a.member.password], ([password]) => change(password!));
    expect(refused.status).toBe(403);
    expect((await send(second, { method: "GET", path: "/api/auth/session" })).status).toBe(200);

    const answer = await send(caller, change(caller.password));
    expect(answer.status, answer.text).toBe(200);
    expect(answer.text).toBe(JSON.stringify({ ok: true }));
    expectNoneOf(answer.text, a.ids, "change password");
    expect((await send(caller, { method: "GET", path: "/api/auth/session" })).status).toBe(200);
    expect((await send(second, { method: "GET", path: "/api/auth/session" })).status).toBe(401);

    await expectAAccountActive();
    for (const session of [b.member, b.secondSession, b.webSession]) {
      expect((await send(session, { method: "GET", path: "/api/auth/session" })).status).toBe(200);
    }
    expect({ a: await passwordHashOf(a.member.userId), b: await passwordHashOf(b.member.userId) }).toEqual(
      hashesBefore,
    );
    const tokenAfter = await runAsSystem("isolation test reset token", () =>
      getPasswordResetTokenByHash(pool, resetToken.tokenHash),
    );
    expect(tokenAfter && { userId: tokenAfter.userId, consumedAt: tokenAfter.consumedAt }).toEqual({
      userId: a.member.userId,
      consumedAt: null,
    });
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
  // A has no AI budget row, so A's own status lists `aiBudgetMissing` (issue gh-1871). B has a row,
  // and B's status must carry neither A's stored problem nor A's budget problem.
  "semp status": async () => {
    await setTenantAiBudget(adminPool, b.tenantId);
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
    expect(answer.text).not.toContain("aiBudget");
    expect(await sendOk(a.member, { method: "GET", path: "/api/semp-status" })).toContain('"id":"aiBudgetMissing"');
  },
  // Each tenant gets one critical agents problem, its banner candidate; B's banner and count must be
  // B's own only. B has an AI budget row and A has none, so A's missing budget must not become B's banner.
  "semp status summary": async () => {
    await setTenantAiBudget(adminPool, b.tenantId);
    const ids: string[] = [];
    for (const fixture of [a, b]) {
      const result = await runInTenant(fixture.tenantId, () =>
        withTransaction(pool, (client) =>
          raiseProblem(client, {
            userId: fixture.member.userId,
            category: "agents",
            kind: "processStale",
            severity: "critical",
            sourceTable: "project_heartbeats",
            sourceId: fixture.heartbeatId,
            dedupeKey: `agents:summary:${fixture.heartbeatId}`,
          }),
        ),
      );
      ids.push(result.problemId);
    }
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/semp-status/summary" }, [ids[1]!]);
    expect(answer.text).not.toContain(ids[0]);
    const body: unknown = JSON.parse(answer.text);
    expect(body).toMatchObject({ banner: { problemId: ids[1], instanceId: ids[1] } });
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
    const seed = (fixture: TenantFixture) => seedMailThread(fixture, `<${fixture.tenantId}@example.test>`);
    const first = await seed(a);
    const second = await seed(b);
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/threads" }, [second]);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.text).not.toContain(first);
  },
  "mail thread detail": async () => {
    const foreign = await seedMailThread(
      a,
      `<${randomUUID()}@example.test>`,
      `detail-${randomUUID()}`,
      `thread-${randomUUID()}`,
    );
    const own = await seedMailThread(
      b,
      `<${randomUUID()}@example.test>`,
      `detail-${randomUUID()}`,
      `thread-${randomUUID()}`,
    );
    // Each thread has a task of its own tenant (issue gh-1692): B's detail lists B's task and never A's.
    const foreignTask = await seedThreadTask(a, foreign);
    const ownTask = await seedThreadTask(b, own);
    const answer = await expectExcludesA(b.member, { method: "GET", path: `/api/mail/threads/${own}` }, [own, ownTask]);
    expect(answer.text).not.toContain(foreign);
    expect(answer.text).not.toContain(foreignTask);
    const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => ({
      method: "GET",
      path: `/api/mail/threads/${id}`,
    }));
    expect(result.status).toBe(404);
    expect(result.text).not.toContain(foreignTask);
    // A reads its own thread with its task, so the refusal above is a real one.
    const owner = await send(a.member, { method: "GET", path: `/api/mail/threads/${foreign}` });
    expect(owner.status).toBe(200);
    expect(owner.text).toContain(foreignTask);
    expect(owner.text).not.toContain(ownTask);
  },
  // No writer of the grant exists by design (issue #1635 is read only): both tenants' projects get
  // `emailSendAutonomous` by direct SQL, as the server operator would set it.
  "mail autonomous send projects": async () => {
    for (const fixture of [a, b]) {
      await inTenantTransaction(fixture.tenantId, (client) =>
        client.query(
          "UPDATE items SET properties = properties || '{\"emailSendAutonomous\": true}'::jsonb WHERE tenant_id = app_tenant_default() AND id = $1",
          [fixture.projectItemId],
        ),
      );
    }
    const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/autonomous-send-projects" }, [
      b.projectItemId,
    ]);
    expect(answer.text).not.toContain(a.projectItemId);
    const mailboxes = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/mailboxes" }, [
      b.mailboxItemId,
    ]);
    expect(mailboxes.text).toContain('"autonomousSendProjectCount":1');
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
  // An address that a mailbox of A holds answers B exactly like an address nobody holds: B gets its own mailbox and
  // learns nothing of A's. The same address a second time is refused inside B, so the 201 is the duplicate rule's
  // own answer and not what every request gets (issue gh-1736).
  "mailbox password connect": async () => {
    const connect = (address: string, password = MAILBOX_PASSWORD): Request => ({
      method: "POST",
      path: "/api/mail/mailboxes",
      body: {
        provider: "generic",
        address,
        password,
        imapHost: "imap.isolation.example.test",
        smtpHost: "smtp.isolation.example.test",
      },
    });
    const unusedAddress = (): string => `${randomUUID()}@isolation.example.test`;
    const mailboxesOf = async (member: Member): Promise<string[]> =>
      readIdArray(await sendOk(member, { method: "GET", path: "/api/mail/mailboxes" }), "mailboxes");
    /** The keys of an item envelope and of its properties: what two created mailboxes have in common. */
    const shapeOf = (text: string): string[][] => {
      const body: unknown = JSON.parse(text);
      if (!isRecord(body) || !isRecord(body.properties)) throw new Error(`expected an item envelope in ${text}`);
      return [Object.keys(body).sort(), Object.keys(body.properties).sort()];
    };
    const heldByA = unusedAddress();
    const ofA = readString(await sendOk(a.member, connect(heldByA)), "id");
    const knownToB = await mailboxesOf(b.member);

    await leavesAUnchanged(async () => {
      const foreign = await expectExcludesA(b.member, connect(heldByA));
      const unused = await expectExcludesA(b.member, connect(unusedAddress()));
      expect([foreign.status, unused.status]).toEqual([201, 201]);
      expect(shapeOf(foreign.text)).toEqual(shapeOf(unused.text));
      expect(foreign.headers).toEqual(unused.headers);
      expectNoneOf(`${foreign.text}${unused.text}`, [ofA, MAILBOX_PASSWORD], "B's new mailboxes");
      const created = [readString(foreign.text, "id"), readString(unused.text, "id")].sort();
      expect((await mailboxesOf(b.member)).filter((id) => !knownToB.includes(id)).sort()).toEqual(created);

      const again = await send(b.member, connect(heldByA));
      expect(again.status).toBe(409);
      expect(readString(again.text, "error", "code")).toBe("provider_account_already_connected");
      expectNoneOf(again.text, [...a.ids, ofA], "B's duplicate refusal");

      // The verification's refusal reaches the caller as its own 400 code, and creates nothing.
      const refused = await send(b.member, connect(unusedAddress(), REFUSED_MAILBOX_PASSWORD));
      expect(refused.status).toBe(400);
      expect(readString(refused.text, "error", "code")).toBe("mail_auth_failed");
      expect((await mailboxesOf(b.member)).filter((id) => !knownToB.includes(id)).sort()).toEqual(created);
    });
    expect(await mailboxesOf(a.member)).toContain(ofA);
    expect(await mailboxesOf(b.member)).not.toContain(ofA);
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
  // B's summary names B's signed-out mailbox and not A's, and an unread inbox thread that arrives in A leaves B's
  // counts where they were, while one that arrives in B raises B's unread count by exactly one (issue gh-1688).
  "mail summary": async () => {
    const summaryOfB = async (ownIds: readonly string[] = []) => {
      const answer = await expectExcludesA(b.member, { method: "GET", path: "/api/mail/summary" }, ownIds);
      const body: unknown = JSON.parse(answer.text);
      if (!isRecord(body) || typeof body.unreadInbox !== "number" || typeof body.flagged !== "number") {
        throw new Error(`expected the summary counts in ${answer.text}`);
      }
      return { unreadInbox: body.unreadInbox, flagged: body.flagged, text: answer.text };
    };
    const signedOutOfA = await mailboxNeedingReauthorization(a);
    const signedOutOfB = await mailboxNeedingReauthorization(b);
    const before = await summaryOfB([signedOutOfB]);
    expect(before.text).not.toContain(signedOutOfA);

    await seedMailThread(a, `<${randomUUID()}@example.test>`, `summary-${randomUUID()}`, `thread-${randomUUID()}`);
    const afterForeign = await summaryOfB([signedOutOfB]);
    expect({ unreadInbox: afterForeign.unreadInbox, flagged: afterForeign.flagged }).toEqual({
      unreadInbox: before.unreadInbox,
      flagged: before.flagged,
    });

    await seedMailThread(b, `<${randomUUID()}@example.test>`, `summary-${randomUUID()}`, `thread-${randomUUID()}`);
    expect((await summaryOfB([signedOutOfB])).unreadInbox).toBe(before.unreadInbox + 1);
  },
  // B lists the folder of B's own mailbox and nothing of A's. A's mailbox answers B like a mailbox that does not
  // exist, while A itself lists its folder there, so B's answer is a real refusal (issue gh-1689).
  "mailbox folder list": async () => {
    const ofA = await mailboxWithInboxFolder(a);
    const ofB = await mailboxWithInboxFolder(b);
    const foldersOf = (mailboxId: string | undefined): Request => ({
      method: "GET",
      path: `/api/mail/mailboxes/${mailboxId}/folders`,
    });
    const own = await expectExcludesA(b.member, foldersOf(ofB.mailboxId), [ofB.folderId]);
    expectNoneOf(own.text, [ofA.mailboxId, ofA.folderId], "B's folder list");
    const answer = await expectForeignLikeRandom(b.member, [ofA.mailboxId], ([id]) => foldersOf(id));
    expect(answer.status).toBe(404);
    expect(await sendOk(a.member, foldersOf(ofA.mailboxId))).toContain(ofA.folderId);
  },
  // B's reauthorization state lands in B's tenant for B's user and names B's mailbox. A's mailbox answers B like a
  // mailbox that does not exist and gets no state, while A itself starts a reauthorization of it, so B's answer
  // is a real refusal (issue gh-1742).
  "mailbox reauthorize": async () => {
    const ofA = await mailboxNeedingReauthorization(a);
    const ofB = await mailboxNeedingReauthorization(b);
    const reauthorize = (mailboxId: string | undefined): Request => ({
      method: "POST",
      path: `/api/mail/mailboxes/${mailboxId}/reauthorize`,
      body: {},
    });
    const statesOfA = await mailOauthStates(a);
    const knownToB = (await mailOauthStates(b)).map((row) => row.id);
    await leavesAUnchanged(async () => {
      const own = await expectExcludesA(b.member, reauthorize(ofB));
      expectNoneOf(own.text, [ofA, ofB], "B's authorization URL");
      expect(new URL(readString(own.text, "authorizeUrl")).searchParams.get("state")).not.toBeNull();
      const refused = await expectForeignLikeRandom(b.member, [ofA], ([id]) => reauthorize(id));
      expect(refused.status).toBe(404);
    });
    expect(await mailOauthStates(a)).toEqual(statesOfA);
    const added = await inTenantTransaction(b.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; user_id: string; mailbox_item_id: string | null }>(
        "SELECT id::text, user_id::text, mailbox_item_id::text FROM mail_oauth_states WHERE NOT (id::text = ANY($1::text[]))",
        [knownToB],
      );
      return rows;
    });
    expect(added.map((row) => [row.user_id, row.mailbox_item_id])).toEqual([[b.member.userId, ofB]]);

    await sendOk(a.member, reauthorize(ofA));
    const ofAStates = (await mailOauthStates(a)).filter((row) => !statesOfA.some((known) => known.id === row.id));
    expect(ofAStates.map((row) => [row.user_id, row.used_at])).toEqual([[a.member.userId, null]]);
  },
  // B's facets name B's own area and project, each with B's thread, and neither A's area nor A's project. A's ids
  // select for B what random ids select: no thread. A itself reads its project there, so its rows exist (issue
  // gh-1747). The thread detail's pattern matches this path too, so the facets body shows which route answered.
  "mail thread facets": async () => {
    const ofA = await mailThreadInProjectOfArea(a);
    const ofB = await mailThreadInProjectOfArea(b);
    const facets: Request = { method: "GET", path: "/api/mail/threads/facets" };
    const own = await expectExcludesA(b.member, facets, [ofB.areaId, ofB.projectId]);
    expectNoneOf(own.text, [ofA.areaId, ofA.projectId], "B's facets");
    const body = mailThreadFacetsBody.parse(JSON.parse(own.text));
    expect(body.areas.items).toContainEqual({ id: ofB.areaId, count: 1 });
    expect(body.projects.items).toContainEqual({ id: ofB.projectId, areaId: ofB.areaId, count: 1 });

    const narrowed = await expectForeignLikeRandom(b.member, [ofA.areaId, ofA.projectId], ([areaId, projectId]) => ({
      method: "GET",
      path: `/api/mail/threads/facets?areaId=${areaId}&projectId=${projectId}`,
    }));
    expect(narrowed.status).toBe(200);
    const none = mailThreadFacetsBody.parse(JSON.parse(narrowed.text));
    expect({ areas: none.areas.total, projects: none.projects }).toEqual({
      areas: 0,
      projects: { total: 0, items: [] },
    });
    expect(await sendOk(a.member, facets)).toContain(ofA.projectId);
  },
  // B's sign-in state lands in B's tenant for B's user, and A's states and rows stay as they were (issue gh-1686).
  "mail oauth start": async () => {
    await startMailOauth(a.member);
    const statesOfA = await mailOauthStates(a);
    const knownToB = (await mailOauthStates(b)).map((row) => row.id);
    await leavesAUnchanged(async () => {
      await expectExcludesA(b.member, {
        method: "POST",
        path: "/api/mail/mailboxes/oauth/start",
        body: { provider: "gmail" },
      });
    });
    expect(await mailOauthStates(a)).toEqual(statesOfA);
    const added = (await mailOauthStates(b)).filter((row) => !knownToB.includes(row.id));
    expect(added.map((row) => [row.user_id, row.used_at])).toEqual([[b.member.userId, null]]);
    expectNoneOf(JSON.stringify(added), a.ids, "B's new sign-in state");
  },
  // A's live sign-in state answers B exactly like a state nobody started, connects nothing and stays unused. A
  // itself gets past the state check with it (the fixture's provider then refuses the code), so B's answer is a
  // real refusal of the state and not what every caller gets.
  "mail oauth complete": async () => {
    const stateOfA = await startMailOauth(a.member);
    const complete = (state: string | undefined): Request => ({
      method: "POST",
      path: "/api/mail/mailboxes/oauth/complete",
      body: { state, code: "isolation-code" },
    });
    const mailboxesOfB = (): Promise<string[]> =>
      sendOk(b.member, { method: "GET", path: "/api/mail/mailboxes" }).then((text) => readIdArray(text, "mailboxes"));
    const before = await mailboxesOfB();
    await leavesAUnchanged(async () => {
      const refused = await expectForeignLikeRandom(b.member, [stateOfA], ([state]) => complete(state));
      expect(refused.status).toBe(400);
      expect(readString(refused.text, "error", "details", "field")).toBe("state");
    });
    expect(await mailboxesOfB()).toEqual(before);
    expect((await mailOauthStates(a, stateOfA)).map((row) => row.used_at)).toEqual([null]);

    const own = await send(a.member, complete(stateOfA));
    expect(own.status).toBe(400);
    expect(readString(own.text, "error", "details", "field")).toBe("code");
    const afterOwn = await mailOauthStates(a, stateOfA);
    expect(afterOwn).toHaveLength(1);
    expect(afterOwn[0]?.used_at).not.toBeNull();
  },
  // The public callback reads no row: A's live state is handed on exactly like a random value, and stays unused.
  "mail oauth callback": async () => {
    const stateOfA = await startMailOauth(a.member);
    await leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(null, [stateOfA], ([state]) => ({
        method: "GET",
        path: `/api/mail/oauth/callback?code=isolation-code&state=${state}`,
      }));
      expect(answer.status).toBe(200);
    });
    expect((await mailOauthStates(a, stateOfA)).map((row) => row.used_at)).toEqual([null]);
  },
  // Each tenant gets a mailbox of its own for this case, with a credential, a sync state and server
  // settings. A's answers B like a random id and keeps every row; B's own is removed by the same
  // route, so the refusal is real (issue gh-1690).
  "mailbox removal": async () => {
    const foreign = await seedRemovableMailbox(a);
    const own = await seedRemovableMailbox(b);
    const connected = { trashed: false, credentials: 1, syncStates: 1, serverSettings: 1 };
    expect(await removableMailboxRows(a, foreign)).toEqual([connected]);
    await leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [foreign], ([id]) => ({
        method: "DELETE",
        path: entryPath("mailbox removal", id!),
      }));
      expect(answer.status).toBe(404);
    });
    expect(await removableMailboxRows(a, foreign)).toEqual([connected]);

    expect(await removableMailboxRows(b, own)).toEqual([connected]);
    const removed = await send(b.member, { method: "DELETE", path: entryPath("mailbox removal", own) });
    expect({ status: removed.status, body: removed.text }).toEqual({ status: 200, body: JSON.stringify({ id: own }) });
    expect(await removableMailboxRows(b, own)).toEqual([
      { trashed: true, credentials: 0, syncStates: 0, serverSettings: 0 },
    ]);
    const again = await send(b.member, { method: "DELETE", path: entryPath("mailbox removal", own) });
    expect(again.status).toBe(404);
  },
  "confirm proposal": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.proposalItemId], ([id]) => ({
        method: "POST",
        path: `/api/proposals/${id}/confirm`,
        body: {},
      }));
    }),
  "task recurrence set": async () => {
    const [own, foreign] = [await datedTask(b), await datedTask(a)];
    const request = (id: string) => ({
      method: "PUT",
      path: `/api/tasks/${id}/recurrence`,
      body: { preset: "weekly" },
    });
    const answer = await sendOk(b.member, request(own));
    expect(readString(answer, "properties", "seriesId")).toMatch(/^[0-9a-f-]{36}$/);
    const before = await recurrenceState(a, foreign);
    const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => request(id!));
    expect(result.status).toBe(404);
    expect(await recurrenceState(a, foreign)).toEqual(before);
  },
  "task series edit": async () => {
    const seriesOf = async (tenant: TenantFixture): Promise<string> => {
      const task = await datedTask(tenant);
      const answer = await sendOk(tenant.member, {
        method: "PUT",
        path: `/api/tasks/${task}/recurrence`,
        body: { preset: "daily" },
      });
      return readString(answer, "properties", "seriesId");
    };
    const [own, foreign] = [await seriesOf(b), await seriesOf(a)];
    const request = (id: string) => ({ method: "PATCH", path: `/api/tasks/series/${id}`, body: { timeFrom: "08:00" } });
    const answer = await sendOk(b.member, request(own));
    expect(readString(answer, "seriesId")).toBe(own);
    const before = await seriesTemplate(a, foreign);
    const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => request(id!));
    expect(result.status).toBe(404);
    expect(await seriesTemplate(a, foreign)).toEqual(before);
  },
  "task recurrence clear": async () => {
    const [own, foreign] = [await datedTask(b), await datedTask(a)];
    const path = (id: string) => `/api/tasks/${id}/recurrence`;
    await sendOk(b.member, { method: "PUT", path: path(own), body: { preset: "weekly" } });
    await sendOk(a.member, { method: "PUT", path: path(foreign), body: { preset: "weekly" } });
    const cleared = await sendOk(b.member, { method: "DELETE", path: path(own) });
    expect(JSON.parse(cleared)).toMatchObject({ properties: { seriesId: null, recurrence: null } });
    const before = await recurrenceState(a, foreign);
    const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => ({
      method: "DELETE",
      path: path(id!),
    }));
    expect(result.status).toBe(404);
    expect(await recurrenceState(a, foreign)).toEqual(before);
  },
  "task occurrence materialize": async () => {
    // A daily series anchored on the task's date, 22 October 2026.
    const seriesOf = async (tenant: TenantFixture): Promise<string> => {
      const task = await datedTask(tenant);
      const answer = await sendOk(tenant.member, {
        method: "PUT",
        path: `/api/tasks/${task}/recurrence`,
        body: { preset: "daily" },
      });
      return readString(answer, "properties", "seriesId");
    };
    const [own, foreign] = [await seriesOf(b), await seriesOf(a)];
    const onRuleDate = (id: string) => ({
      method: "POST",
      path: entryPath("task occurrence materialize", id),
      body: { status: "done" },
    });
    const beforeAnchor = (id: string) => ({
      method: "POST",
      path: `/api/tasks/series/${id}/occurrences/2026-10-21`,
      body: { status: "done" },
    });
    // B's own series answers 201 and 400, the two answers a foreign series must not get.
    const created = await send(b.member, onRuleDate(own));
    expect(created.status, created.text).toBe(201);
    expect(readString(created.text, "properties", "seriesId")).toBe(own);
    expect(readString(created.text, "properties", "occurrenceDate")).toBe("2026-10-25");
    expect(readString(created.text, "properties", "status")).toBe("done");
    expect((await send(b.member, beforeAnchor(own))).status).toBe(400);

    const before = await seriesOccurrenceState(a, foreign);
    expect(before).toMatchObject({ items: [{ id: expect.any(String) }], series: [{ item_id: expect.any(String) }] });
    for (const request of [onRuleDate, beforeAnchor]) {
      const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => request(id!));
      expect(result.status).toBe(404);
    }
    expect(await seriesOccurrenceState(a, foreign)).toEqual(before);
    expect(await seriesOccurrenceState(b, foreign)).toEqual({ items: [], series: [] });
  },
  "task host event put": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    const placed = await sendOk(b.member, { method: "PUT", path: hostEventPath(own.taskId, own.eventId) });
    expect(readString(placed, "taskId")).toBe(own.taskId);
    expect(placed).toContain(own.eventId);
    // The generic relation endpoint still refuses both sides of the relation, for an edge that exists.
    for (const [source, key, target] of [
      [own.taskId, "hostEvents", own.eventId],
      [own.eventId, "hostedTasks", own.taskId],
    ] as const) {
      const generic = await send(b.member, { method: "PUT", path: `/api/items/${source}/relations/${key}/${target}` });
      expect(generic.status).toBe(403);
      expect(readString(generic.text, "error", "code")).toBe("owner_violation");
    }
    const ownBefore = await hostEventState(b, own.taskId);
    expect(ownBefore.edges).toHaveLength(1);
    const before = await hostEventState(a, foreign.taskId);
    const foreignTask = await expectForeignLikeRandom(b.member, [foreign.taskId], ([id]) => ({
      method: "PUT",
      path: hostEventPath(id!, own.eventId),
    }));
    expect(foreignTask.status).toBe(404);
    const foreignEvent = await expectForeignLikeRandom(b.member, [foreign.eventId], ([id]) => ({
      method: "PUT",
      path: hostEventPath(own.taskId, id!),
    }));
    expect(foreignEvent.status).toBe(404);
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    expect(await hostEventState(b, own.taskId)).toEqual(ownBefore);
  },
  "task host event remove": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    await sendOk(b.member, { method: "PUT", path: hostEventPath(own.taskId, own.eventId) });
    await sendOk(a.member, { method: "PUT", path: hostEventPath(foreign.taskId, foreign.eventId) });
    const before = await hostEventState(a, foreign.taskId);
    expect(before.edges).toHaveLength(1);
    const foreignTask = await expectForeignLikeRandom(
      b.member,
      [foreign.taskId, foreign.eventId],
      ([taskId, eventId]) => ({ method: "DELETE", path: hostEventPath(taskId!, eventId!) }),
    );
    expect(foreignTask.status).toBe(404);
    // For B's own task, A's event is an event the task does not sit in: 200 with B's list, as for a random id.
    const foreignEvent = await expectForeignLikeRandom(b.member, [foreign.eventId], ([id]) => ({
      method: "DELETE",
      path: hostEventPath(own.taskId, id!),
    }));
    expect(foreignEvent.status).toBe(200);
    expect(foreignEvent.text).toContain(own.eventId);
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    const removed = await sendOk(b.member, { method: "DELETE", path: hostEventPath(own.taskId, own.eventId) });
    expect(JSON.parse(removed)).toEqual({ taskId: own.taskId, hostEvents: [] });
  },
  "task host events clear": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    await sendOk(b.member, { method: "PUT", path: hostEventPath(own.taskId, own.eventId) });
    await sendOk(a.member, { method: "PUT", path: hostEventPath(foreign.taskId, foreign.eventId) });
    const request = (id: string) => ({
      method: "DELETE",
      path: `/api/tasks/${id}/host-events`,
      body: { date: "2026-10-30", timeFrom: "09:00" },
    });
    const before = await hostEventState(a, foreign.taskId);
    expect(before.edges).toHaveLength(1);
    const result = await expectForeignLikeRandom(b.member, [foreign.taskId], ([id]) => request(id!));
    expect(result.status).toBe(404);
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    const cleared = await sendOk(b.member, request(own.taskId));
    expect(JSON.parse(cleared)).toEqual({ taskId: own.taskId, hostEvents: [] });
    const item = await sendOk(b.member, { method: "GET", path: `/api/items/${own.taskId}` });
    expect(readString(item, "properties", "date")).toBe("2026-10-30");
    expect(readString(item, "properties", "timeFrom")).toBe("09:00");
  },
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
    /** An Event of that day with a project and a transcript (issue #1721): the ids its `events` entry carries. */
    const seedDayEvent = (tenant: TenantFixture) =>
      runInTenant(tenant.tenantId, async () => {
        const chokePoint = createChokePoint(pool);
        const eventsId = await databaseIdFor(tenant.tenantId, "events");
        const event = await chokePoint.createItem({
          databaseId: eventsId,
          properties: { name: "Journal day event", date: "2026-10-16", timeFrom: "10:00" },
        });
        const project = await chokePoint.createItem({
          databaseId: await databaseIdFor(tenant.tenantId, "projects"),
          properties: { name: "Journal day project" },
        });
        const transcriptsId = await databaseIdFor(tenant.tenantId, "transcripts");
        // `status` is a system key that only the transcription process may write.
        const transcript = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: transcriptsId, properties: { name: "Journal day transcript", status: "done" } },
            { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          ),
        );
        const properties = await chokePoint.listProperties(eventsId);
        for (const [key, targetItemId] of [
          ["project", project.id],
          ["transcript", transcript.id],
        ] as const) {
          const property = properties.find((entry) => entry.key === key);
          if (!property) throw new Error(`no '${key}' property on Events`);
          await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: event.id, targetItemId });
        }
        return [event.id, project.id, transcript.id];
      });
    const dayEventOfA = await seedDayEvent(a);
    const dayEventOfB = await seedDayEvent(b);
    const path = "/api/journal/periods/day/2026-10-16";
    const response = await sendOk(b.member, { method: "GET", path });
    expect(readString(response, "item", "id")).toBe(ownB.id);
    expect(response).not.toContain(ownA.id);
    expect(dayEventOfB.filter((id) => !response.includes(id))).toEqual([]);
    expectNoneOf(response, dayEventOfA, "B's journal day");
    // A's Event is on that day for A, so its absence from B's answer is isolation and not an empty day.
    const asA = await sendOk(a.member, { method: "GET", path });
    expect(dayEventOfA.filter((id) => !asA.includes(id))).toEqual([]);
    expectNoneOf(asA, dayEventOfB, "A's journal day");
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
  "transcript list": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/transcripts" }, [b.transcriptItemId]);
    // A foreign filter id narrows to nothing, exactly like a random one.
    for (const field of ["eventId", "personId", "projectId"]) {
      const answer = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => ({
        method: "GET",
        path: `/api/transcripts?${field}=${id}`,
      }));
      expect(answer.status).toBe(200);
      expect(answer.text).toBe('{"transcripts":[],"nextCursor":null}');
    }
  },
  // B deletes its own recording through the route and restores it through the generic Trash route;
  // A's transcript answers like a random id and A's rows stay as A reads them.
  "transcript delete": () =>
    leavesAUnchanged(async () => {
      const fileId = readString(
        await sendOk(b.member, {
          method: "POST",
          path: "/api/files",
          body: `ID3 audio of ${randomUUID()}`,
          headers: { "Content-Type": "audio/mpeg", "X-Filename": "delete.mp3" },
        }),
        "id",
      );
      const transcriptId = await runInTenant(b.tenantId, () =>
        withTransaction(pool, async (client) => {
          const transcripts = await getDatabaseByModuleId(client, "transcripts");
          if (!transcripts) throw new Error("Missing transcripts");
          // The link only the transcription process writes, as its step 0 writes it.
          const item = await createItemWithClient(
            client,
            { databaseId: transcripts.id, properties: { name: "Delete me", link: transcriptionSourceLink(fileId) } },
            { allowedSystemKeys: ["link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );
          return item.id;
        }),
      );
      const deleted = await sendOk(b.member, { method: "DELETE", path: `/api/transcripts/${transcriptId}` });
      expect(deleted).toContain(fileId);
      const trashed = () =>
        inTenantTransaction(b.tenantId, async (client) => {
          const { rows } = await client.query<{ id: string; trashed: boolean }>(
            "SELECT id, deleted_at IS NOT NULL AS trashed FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
            [[fileId, transcriptId]],
          );
          return rows.map((row) => row.trashed);
        });
      expect(await trashed()).toEqual([true, true]);
      await sendOk(b.member, { method: "POST", path: `/api/items/${transcriptId}/restore`, body: {} });
      expect(await trashed()).toEqual([false, false]);
      const result = await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => ({
        method: "DELETE",
        path: `/api/transcripts/${id}`,
      }));
      expect(result.status).toBe(404);
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
  // Each tenant gets an Event with one `done` transcript linked to it, seeded here and used by no other case.
  "transcript summaries": async () => {
    const seedEvent = async (tenant: TenantFixture): Promise<string> => {
      const eventId = readString(
        await sendOk(tenant.member, {
          method: "POST",
          path: `/api/databases/${await databaseIdFor(tenant.tenantId, "events")}/items`,
          body: { properties: { name: "Summary probe", date: "2026-10-16T08:00:00Z" } },
        }),
        "id",
      );
      const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        if (!transcripts) throw new Error("Missing transcripts");
        // `status` is a system key that only the transcription process may write.
        const item = await createItemWithClient(
          client,
          { databaseId: transcripts.id, properties: { name: "Summary probe", status: "done" } },
          { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        return item.id;
      });
      await sendOk(tenant.member, {
        method: "PUT",
        path: `/api/items/${transcriptId}/relations/event/${eventId}`,
        body: {},
      });
      return eventId;
    };
    const [own, foreign] = [await seedEvent(b), await seedEvent(a)];
    const path = (ids: readonly string[]) => `/api/transcript-summaries?eventIds=${ids.join(",")}`;
    // A reads the count of its own Event, so the zero B gets for it below is a refusal and not an empty fixture.
    expect(JSON.parse(await sendOk(a.member, { method: "GET", path: path([foreign]) }))).toEqual({
      [foreign]: { count: 1, doneCount: 1 },
    });
    const answer = await expectForeignLikeRandom(b.member, [foreign], (ids) => ({
      method: "GET",
      path: path([own, ...ids]),
    }));
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      [own]: { count: 1, doneCount: 1 },
      [foreign]: { count: 0, doneCount: 0 },
    });
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    for (const ids of [tooMany, [own, "not-a-uuid"]]) {
      const invalid = await send(b.member, { method: "GET", path: path(ids) });
      expect(invalid.status).toBe(400);
      expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
    }
  },
  // A and B each follow item 0 of a transcript of their own that this case seeds with notes. B then
  // names A's transcript: `null` would delete A's state and `noted` on item 1 would add one. Both
  // answer like a random id, A's state rows stay as they are and none appears in B's tenant.
  "transcript action item state": async () => {
    const transcriptWithNotes = (tenant: TenantFixture): Promise<string> =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        if (!transcripts) throw new Error("Missing transcripts");
        const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Notes" } });
        // The notes only the transcription process writes, as its step 5 stores them.
        await writeComputed(client, transcripts.id, item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, {
          title: "Notes",
          summary: "",
          shortSummary: "",
          decisions: [],
          actionItems: [
            { text: "First", ownerSpeaker: null, due: null, startsAt: null },
            { text: "Second", ownerSpeaker: null, due: null, startsAt: null },
          ],
        });
        return item.id;
      });
    const [own, foreign] = [await transcriptWithNotes(b), await transcriptWithNotes(a)];
    const request = (id: string, actionItemId: number, state: "noted" | null): Request => ({
      method: "PUT",
      path: `/api/transcripts/${id}/action-items/${actionItemId}/state`,
      body: { state },
    });
    const states = (tenant: TenantFixture, transcriptId: string) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ action_item_id: number; state: string; updated_at: string }>(
          `SELECT action_item_id, state, updated_at::text AS updated_at FROM transcript_action_item_states
            WHERE transcript_item_id = $1 ORDER BY action_item_id`,
          [transcriptId],
        );
        return rows;
      });
    const followed = '{"actionItemId":0,"state":"noted"}';
    expect(await sendOk(a.member, request(foreign, 0, "noted"))).toBe(followed);
    expect(await sendOk(b.member, request(own, 0, "noted"))).toBe(followed);
    const before = await states(a, foreign);
    expect(before.map((row) => [row.action_item_id, row.state])).toEqual([[0, "noted"]]);
    for (const [actionItemId, state] of [
      [0, null],
      [1, "noted"],
    ] as const) {
      const result = await expectForeignLikeRandom(b.member, [foreign], ([id]) => request(id!, actionItemId, state));
      expect(result.status).toBe(404);
    }
    expect(await states(a, foreign)).toEqual(before);
    expect(await states(b, foreign)).toEqual([]);
    expect((await states(b, own)).map((row) => [row.action_item_id, row.state])).toEqual([[0, "noted"]]);
  },
  // A and B each get a transcript with notes (an item without an owner) linked to an Event of their own,
  // seeded here and used by no other case (issue gh-1767). B names A's transcript: the add answers like a
  // random id and creates no task in either tenant and no state for A's transcript.
  "transcript action item task create": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const request = (id: string | undefined): Request => ({
      method: "POST",
      path: `/api/transcripts/${id}/action-items/0/task`,
      body: {},
    });
    const [tasksOfA, tasksOfB] = [
      (await actionItemRows(a, foreign.transcriptId)).tasks,
      (await actionItemRows(b, own.transcriptId)).tasks,
    ];
    const answer = await expectForeignLikeRandom(b.member, [foreign.transcriptId], ([id]) => request(id));
    expect(answer.status).toBe(404);
    expect(await actionItemRows(a, foreign.transcriptId)).toEqual({ states: [], tasks: tasksOfA });
    expect(await actionItemRows(b, foreign.transcriptId)).toEqual({ states: [], tasks: tasksOfB });
    // A and B can each add their own item, so the 404 above is a refusal and not a route that never works.
    expect(readString(await sendOk(b.member, request(own.transcriptId)), "taskId")).toMatch(UUID_PATTERN);
    expect(readString(await sendOk(a.member, request(foreign.transcriptId)), "taskId")).toMatch(UUID_PATTERN);
    expect((await actionItemRows(a, foreign.transcriptId)).states).toMatchObject([
      { action_item_id: 0, state: "added" },
    ]);
    expect((await actionItemRows(a, own.transcriptId)).states).toEqual([]);
  },
  // A and B each add the item of their own transcript. B then undoes the addition on A's transcript: it
  // answers like a random id and A's task stays alive and its state `added`.
  "transcript action item task remove": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const path = (id: string | undefined): string => `/api/transcripts/${id}/action-items/0/task`;
    await sendOk(b.member, { method: "POST", path: path(own.transcriptId), body: {} });
    await sendOk(a.member, { method: "POST", path: path(foreign.transcriptId), body: {} });
    const before = await actionItemRows(a, foreign.transcriptId);
    expect(before.states).toMatchObject([{ action_item_id: 0, state: "added" }]);
    expect(before.tasks).toContain(before.states[0]?.task_item_id);
    const answer = await expectForeignLikeRandom(b.member, [foreign.transcriptId], ([id]) => ({
      method: "DELETE",
      path: path(id),
    }));
    expect(answer.status).toBe(404);
    expect(await actionItemRows(a, foreign.transcriptId)).toEqual(before);
    // B undoes its own addition, so the 404 above is a refusal and not a route that never works.
    expect(await sendOk(b.member, { method: "DELETE", path: path(own.transcriptId) })).toBe(
      '{"actionItemId":0,"state":null}',
    );
    expect((await actionItemRows(b, own.transcriptId)).states).toEqual([]);
  },
  // Each tenant's Event offers the open item of its own transcript. B reads A's Event as a random id and
  // its own list holds nothing of A's.
  "event transcript action items": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const proposalsOf = (eventId: string | undefined): Request => ({
      method: "GET",
      path: `/api/events/${eventId}/transcript-action-items`,
    });
    // A reads the item of its own Event, so the 404 B gets for it below is a refusal and not an empty fixture.
    expect(await sendOk(a.member, proposalsOf(foreign.eventId))).toContain(foreign.transcriptId);
    const listed = await expectExcludesA(b.member, proposalsOf(own.eventId), [own.transcriptId]);
    expectNoneOf(listed.text, [foreign.eventId, foreign.transcriptId], "B's action item proposals");
    const answer = await expectForeignLikeRandom(b.member, [foreign.eventId], ([id]) => proposalsOf(id));
    expect(answer.status).toBe(404);
  },
  // A and B each get a transcript of one speaker, linked to an Event with one participant, seeded here and
  // used by no other case (issue gh-1770). B names A's transcript with its own person, and its own transcript
  // with A's person: both answer like a random id, and A's speaker stays unmapped.
  "transcript speaker assign": async () => {
    const [own, foreign] = [await seedSpeakerWorld(b), await seedSpeakerWorld(a)];
    const assign = (transcriptId: string | undefined, personId: string | undefined): Request => ({
      method: "PUT",
      path: `/api/transcripts/${transcriptId}/speakers/SPEAKER_00`,
      body: { personId },
    });
    const speakersOf = (caller: Caller, transcriptId: string): Promise<string> =>
      sendOk(caller, { method: "GET", path: `/api/transcripts/${transcriptId}/speakers` });
    const before = await speakersOf(a.member, foreign.transcriptId);
    expect(before).toContain('"personId":null');

    const onForeignTranscript = await expectForeignLikeRandom(b.member, [foreign.transcriptId], ([id]) =>
      assign(id, own.personId),
    );
    expect(onForeignTranscript.status).toBe(404);
    const withForeignPerson = await expectForeignLikeRandom(b.member, [foreign.personId], ([id]) =>
      assign(own.transcriptId, id),
    );
    expect(withForeignPerson.status).toBe(404);
    expect(await speakersOf(a.member, foreign.transcriptId)).toBe(before);
    expect(await speakersOf(b.member, own.transcriptId)).toContain('"personId":null');
    // A and B each map their own speaker, so the 404s above are refusals and not a route that never works.
    expect(readString(await sendOk(b.member, assign(own.transcriptId, own.personId)), "personId")).toBe(own.personId);
    expect(readString(await sendOk(a.member, assign(foreign.transcriptId, foreign.personId)), "personId")).toBe(
      foreign.personId,
    );
    expect(await speakersOf(b.member, own.transcriptId)).not.toContain(foreign.personId);
  },
  // Each tenant's candidates hold the participant of its own Event. B reads A's transcript as a random id.
  "transcript speaker candidates": async () => {
    const [own, foreign] = [await seedSpeakerWorld(b), await seedSpeakerWorld(a)];
    const candidatesOf = (transcriptId: string | undefined): Request => ({
      method: "GET",
      path: `/api/transcripts/${transcriptId}/speaker-candidates`,
    });
    // A reads the participant of its own Event, so the 404 B gets for it below is a refusal and not an empty fixture.
    expect(await sendOk(a.member, candidatesOf(foreign.transcriptId))).toContain(foreign.personId);
    const listed = await expectExcludesA(b.member, candidatesOf(own.transcriptId), [own.personId]);
    expectNoneOf(listed.text, [foreign.personId, foreign.transcriptId, foreign.eventId], "B's speaker candidates");
    const answer = await expectForeignLikeRandom(b.member, [foreign.transcriptId], ([id]) => candidatesOf(id));
    expect(answer.status).toBe(404);
  },
  // Each tenant gets an Event with one participant, seeded here and used by no other case (issue gh-1757).
  "event people": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ eventId: string; personId: string }> => {
      const create = async (moduleId: string, properties: Record<string, unknown>): Promise<string> =>
        readString(
          await sendOk(tenant.member, {
            method: "POST",
            path: `/api/databases/${await databaseIdFor(tenant.tenantId, moduleId)}/items`,
            body: { properties },
          }),
          "id",
        );
      const eventId = await create("events", { name: "Participants probe", date: "2026-10-16" });
      const personId = await create("people", { name: "Participant probe" });
      await sendOk(tenant.member, {
        method: "PUT",
        path: `/api/items/${eventId}/relations/people/${personId}`,
        body: {},
      });
      return { eventId, personId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const peopleOf = (eventId: string | undefined): Request => ({
      method: "GET",
      path: `/api/events/${eventId}/people`,
    });
    // A reads the participant of its own Event, so the 404 B gets for it below is a refusal and not an empty fixture.
    expect(await sendOk(a.member, peopleOf(foreign.eventId))).toContain(foreign.personId);
    const listed = await expectExcludesA(b.member, peopleOf(own.eventId), [own.personId]);
    expectNoneOf(listed.text, [foreign.eventId, foreign.personId], "B's participant list");
    const answer = await expectForeignLikeRandom(b.member, [foreign.eventId], ([id]) => peopleOf(id));
    expect(answer.status).toBe(404);
  },
  // Each tenant gets an area with one project that holds an overdue open task, seeded here and used by no
  // other case (issue gh-1760). An overdue task is in the overview's list whatever the day the test runs on.
  "area overview": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ areaId: string; projectId: string; taskId: string }> => {
      const create = async (moduleId: string, properties: Record<string, unknown>): Promise<string> =>
        readString(
          await sendOk(tenant.member, {
            method: "POST",
            path: `/api/databases/${await databaseIdFor(tenant.tenantId, moduleId)}/items`,
            body: { properties },
          }),
          "id",
        );
      const relate = (itemId: string, key: string, targetId: string): Promise<string> =>
        sendOk(tenant.member, { method: "PUT", path: `/api/items/${itemId}/relations/${key}/${targetId}`, body: {} });
      const areaId = await create("areas", { name: "Overview probe" });
      const projectId = await create("projects", { name: "Overview probe project" });
      const taskId = await create("tasks", { name: "Overview probe task", date: "2026-01-05" });
      await relate(projectId, "area", areaId);
      await relate(taskId, "project", projectId);
      return { areaId, projectId, taskId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const overviewOf = (areaId: string | undefined): Request => ({
      method: "GET",
      path: `/api/areas/${areaId}/overview`,
    });
    // A reads the task of its own area, so the 404 B gets for that area below is a refusal and not an empty fixture.
    const asOwner = await sendOk(a.member, overviewOf(foreign.areaId));
    expect([foreign.projectId, foreign.taskId].filter((id) => !asOwner.includes(id))).toEqual([]);
    const listed = await expectExcludesA(b.member, overviewOf(own.areaId), [own.projectId, own.taskId]);
    expectNoneOf(listed.text, Object.values(foreign), "B's area overview");
    const answer = await expectForeignLikeRandom(b.member, [foreign.areaId], ([id]) => overviewOf(id));
    expect(answer.status).toBe(404);
    const invalid = await send(b.member, overviewOf("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  // Each tenant gets a Books item that holds a chosen cover, seeded here and used by no other case (issue gh-1793).
  "library automation retry": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ itemId: string; blobId: string }> => {
      const created = await sendOk(tenant.member, {
        method: "POST",
        path: `/api/databases/${await databaseIdFor(tenant.tenantId, "books")}/items`,
        body: { properties: { name: "Retry probe" } },
      });
      const itemId = readString(created, "id");
      const version = readString(created, "updatedAt");
      const upload = await sendOk(tenant.member, {
        method: "POST",
        path: "/api/blobs",
        body: `retry probe cover ${randomUUID()}`,
        headers: { "Content-Type": "image/png" },
      });
      const blobId = readString(upload, "blobId");
      await sendOk(tenant.member, {
        method: "PATCH",
        path: `/api/items/${itemId}`,
        body: { properties: { coverOverride: { blobId }, coverSource: "userPhoto" }, ifVersion: version },
      });
      return { itemId, blobId };
    };
    const stateOf = async (tenant: TenantFixture, itemId: string): Promise<{ cover: unknown; status: string }> => {
      const item = await sendOk(tenant.member, { method: "GET", path: `/api/items/${itemId}` });
      const rows = await inTenantTransaction(
        tenant.tenantId,
        async (client) =>
          (await client.query<{ status: string }>("SELECT status FROM item_automation WHERE item_id = $1", [itemId]))
            .rows,
      );
      return {
        cover: z.object({ properties: z.record(z.string(), z.unknown()) }).parse(JSON.parse(item)).properties
          .coverOverride,
        status: rows[0]?.status ?? "none",
      };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const retry = (id: string): Request => ({ method: "POST", path: `/api/items/${id}/automation/retry`, body: {} });
    // B's own item is retried, so the 404 B gets for A's item below is a refusal and not a missing route.
    expect(await stateOf(b, own.itemId)).toMatchObject({ cover: { blobId: own.blobId } });
    const accepted = await send(b.member, retry(own.itemId));
    expect(accepted.status).toBe(202);
    expect(await stateOf(b, own.itemId)).toEqual({ cover: null, status: "pending" });
    const before = await stateOf(a, foreign.itemId);
    expect(before.cover).toEqual({ blobId: foreign.blobId });
    const answer = await expectForeignLikeRandom(b.member, [foreign.itemId], ([id]) => retry(id!));
    expect(answer.status).toBe(404);
    expect(await stateOf(a, foreign.itemId)).toEqual(before);
  },
  "inbox types": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/inbox-types" });
  },
  // A and B each get a card and a pending tick approval inside this case; each reads its own two and neither of the other's.
  "inbox cards": async () => {
    const seedStack = (tenant: TenantFixture) =>
      runInTenant(tenant.tenantId, async () => {
        const card = await inTenantTransaction(tenant.tenantId, async (client) => {
          const database = await getDatabaseByModuleId(client, "processingProposals");
          if (!database) throw new Error(`no 'processingProposals' database in tenant ${tenant.tenantId}`);
          return createItemWithClient(
            client,
            { databaseId: database.id, properties: { kind: "inbox", status: "proposed", proposal: null } },
            { allowedSystemKeys: ["kind", "status", "proposal"] },
          );
        });
        const run = await createAgentRun(pool, {
          triggeredBy: "heartbeat",
          task: "inbox cards isolation",
          userId: tenant.member.userId,
        });
        const approval = await createPendingApprovalRequest(pool, {
          agentRunId: run.id,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        return { cardId: card.id, approvalId: approval.id };
      });
    const [own, foreign] = [await seedStack(b), await seedStack(a)];
    const request: Request = { method: "GET", path: "/api/inbox/cards" };

    // A reads its own two, so the absence of them for B below is a refusal and not an empty fixture.
    const asOwner = await sendOk(a.member, request);
    expect(Object.values(foreign).filter((id) => !asOwner.includes(id))).toEqual([]);
    expectNoneOf(asOwner, Object.values(own), "A's inbox cards");
    const answer = await expectExcludesA(b.member, request, Object.values(own));
    expectNoneOf(answer.text, Object.values(foreign), "B's inbox cards");
    const body: unknown = JSON.parse(answer.text);
    const listed = isRecord(body) && Array.isArray(body.cards) ? body.cards : [];
    expect(listed.map((card): unknown => (isRecord(card) ? card.cardId : undefined)).sort()).toEqual(
      [own.approvalId, own.cardId].sort(),
    );
  },
  // A and B each get an Event and a Task on the same day; each reads its own two and neither of the other's.
  "calendar timeline": async () => {
    const seedDay = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const ids: string[] = [];
        for (const moduleId of ["events", "tasks"]) {
          const database = await getDatabaseByModuleId(client, moduleId);
          if (!database) throw new Error(`${moduleId} not seeded`);
          const item = await createItemWithClient(client, {
            databaseId: database.id,
            properties: { name: "Timeline", date: "2026-10-16" },
          });
          ids.push(item.id);
        }
        return ids;
      });
    const foreign = await seedDay(a);
    const own = await seedDay(b);
    const path = "/api/calendar/timeline?from=2026-10-16&to=2026-10-16";
    for (const shape of ["", "&shape=compact"]) {
      const answer = await expectExcludesA(b.member, { method: "GET", path: `${path}${shape}` }, own);
      expectNoneOf(answer.text, foreign, `B's calendar timeline${shape}`);
    }
    // A's rows are on that day for A, so their absence from B's answer is isolation and not an empty day.
    const asA = await sendOk(a.member, { method: "GET", path });
    expect(foreign.filter((id) => !asA.includes(id))).toEqual([]);
    expectNoneOf(asA, own, "A's calendar timeline");
    const invalid = await send(b.member, {
      method: "GET",
      path: "/api/calendar/timeline?from=2026-10-17&to=2026-10-16",
    });
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
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
  "approval request detail": async () => {
    // Both tenants read their own request, so the 404 for the foreign id is a refusal and not a missing route.
    expect(readString(await sendOk(b.member, approvalRequestRead(b.approvalRequestId)), "id")).toBe(
      b.approvalRequestId,
    );
    expect(readString(await sendOk(a.member, approvalRequestRead(a.approvalRequestId)), "id")).toBe(
      a.approvalRequestId,
    );
    const answer = await expectForeignLikeRandom(b.member, [a.approvalRequestId], ([id]) =>
      approvalRequestRead(id ?? ""),
    );
    expect(answer.status).toBe(404);
    const invalid = await send(b.member, approvalRequestRead("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "code")).toBe("validation_failed");
  },
  // B gets a second pending request of its own in this case, so a count that reached A's request would differ by one.
  "approval request count": async () => {
    await inTenantTransaction(b.tenantId, async (client) => {
      const run = await createAgentRun(client, { triggeredBy: "user", task: "count probe", userId: b.member.userId });
      await createPendingApprovalRequest(client, {
        agentRunId: run.id,
        toolName: "probe",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
    });
    for (const [tenant, own, foreign] of [
      [b, b.approvalRequestId, a.approvalRequestId],
      [a, a.approvalRequestId, b.approvalRequestId],
    ] as const) {
      const listed = readIdArray(
        await sendOk(tenant.member, { method: "GET", path: "/api/approval-requests" }),
        "rows",
      );
      expect(listed).toContain(own);
      expect(listed).not.toContain(foreign);
      const counted = await sendOk(tenant.member, { method: "GET", path: "/api/approval-requests/count" });
      expect(readNumber(counted, "count")).toBe(listed.length);
      const filtered = "?status=pending&source=chat,tick,mcp";
      expect(
        readNumber(
          await sendOk(tenant.member, { method: "GET", path: `/api/approval-requests/count${filtered}` }),
          "count",
        ),
      ).toBe(listed.length);
    }
    expect(readNumber(await sendOk(b.member, { method: "GET", path: "/api/approval-requests/count" }), "count")).toBe(
      2,
    );
    const invalid = await send(b.member, { method: "GET", path: "/api/approval-requests/count?status=decided" });
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "code")).toBe("validation_failed");
  },
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
  "semp thread list": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/semp/threads?kind=chat,item,tick&limit=100" }, [
      b.sempThreadId,
    ]);
    // Case rows: an Inbox item of each tenant and its item thread, created by the capture write and the send route.
    const seedItemThread = async (fixture: TenantFixture) => {
      const databaseId = await databaseIdFor(fixture.tenantId, "inbox");
      const capture = await inTenantTransaction(fixture.tenantId, (client) =>
        createItemWithClient(client, {
          databaseId,
          properties: { date: "2026-01-01", time: "12:00", text: "Isolation capture" },
        }),
      );
      const sent = await sendOk(fixture.member, {
        method: "POST",
        path: "/api/semp/threads",
        body: { text: "Isolation question", subject: { inboxItemId: capture.id } },
      });
      return { threadId: readString(sent, "threadId"), subjectId: capture.id };
    };
    const foreign = await seedItemThread(a);
    const own = await seedItemThread(b);
    const answer = await expectForeignLikeRandom(b.member, [foreign.subjectId], ([id]) => ({
      method: "GET",
      path: `/api/semp/threads?subjectInboxItemId=${id}`,
    }));
    expect(answer.status).toBe(200);
    expect(readIdArray(answer.text, "rows")).toEqual([]);
    // Each tenant finds its own item thread by that filter, so the empty answer above is not a filter that matches nothing.
    const bySubject = async (member: Member, subjectId: string) =>
      readIdArray(
        await sendOk(member, { method: "GET", path: `/api/semp/threads?subjectInboxItemId=${subjectId}` }),
        "rows",
      );
    expect(await bySubject(b.member, own.subjectId)).toEqual([own.threadId]);
    expect(await bySubject(a.member, foreign.subjectId)).toEqual([foreign.threadId]);
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
    // B's member reads B's own run; a run of B's tenant with another actor answers like an unknown id
    // (issue gh-1805).
    const own = await send(b.member, { method: "GET", path: `/api/agent-runs/${b.agentRunId}` });
    expect(own.status, own.text).toBe(200);
    expect(own.text).toContain(b.agentRunId);
    // Raw fixture: a run's actor must be its own tenant's user (agent_runs_actor_user_id_tenant_fkey) and a
    // tenant has one user, so the admin connection skips foreign-key triggers for this one insert.
    const otherActorRun = await runInTenant(b.tenantId, () =>
      withTransaction(adminPool, async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        return createAgentRun(client, { triggeredBy: "user", task: "actor probe", userId: a.member.userId });
      }),
    );
    const otherActor = await expectForeignLikeRandom(b.member, [otherActorRun.id], ([id]) => ({
      method: "GET",
      path: `/api/agent-runs/${id}`,
    }));
    // The forged run is removed before the assertions, so no later case meets a run of a foreign actor.
    const removed = await adminPool.query("DELETE FROM agent_runs WHERE id = $1", [otherActorRun.id]);
    expect(removed.rowCount).toBe(1);
    expect(otherActor.status).toBe(404);
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
  "add property option": async () => {
    const aTags = await healthTagsPropertyId(a);
    const label = "Isolation add probe";
    await leavesAUnchanged(async () => {
      const refused = await expectForeignLikeRandom(b.member, [aTags], ([id]) => ({
        method: "POST",
        path: `/api/properties/${id}/options`,
        body: { label },
      }));
      expect(refused.status).toBe(404);
    });
    // The same request on a property of B is served, so the foreign answer is a refusal of A's row.
    const bProperty = await caseOptionPropertyId(b, "Isolation option add");
    const own = await send(b.member, {
      method: "POST",
      path: `/api/properties/${bProperty}/options`,
      body: { label },
    });
    expect(own.status, own.text).toBe(201);
    const key = readString(own.text, "key");
    expect(await storedOptions(b, bProperty)).toContainEqual({ key, label });
    const aOptions = await storedOptions(a, aTags);
    expect(aOptions.map((option) => option.key)).not.toContain(key);
    expect(aOptions.map((option) => option.label)).not.toContain(label);
  },
  "update property option": async () => {
    const aTags = await healthTagsPropertyId(a);
    const label = "Isolation rename probe";
    // `medication` is a seeded option of A's Health records, so a foreign rename would find its target.
    await leavesAUnchanged(async () => {
      const refused = await expectForeignLikeRandom(b.member, [aTags], ([id]) => ({
        method: "PATCH",
        path: `/api/properties/${id}/options/medication`,
        body: { label },
      }));
      expect(refused.status).toBe(404);
    });
    // The same kind of request on a property of B is served, so the foreign answer is a refusal of A's row.
    const bProperty = await caseOptionPropertyId(b, "Isolation option update");
    const own = await send(b.member, {
      method: "PATCH",
      path: `/api/properties/${bProperty}/options/one`,
      body: { label },
    });
    expect(own.status, own.text).toBe(200);
    expect(await storedOptions(b, bProperty)).toEqual([{ key: "one", label }]);
    const aOptions = await storedOptions(a, aTags);
    expect(aOptions).toContainEqual(SEEDED_MEDICATION_OPTION);
    expect(aOptions.map((option) => option.label)).not.toContain(label);
  },

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
  "count items": async () => {
    // A foreign database answers exactly as a random one does: alone, grouped, with the collection filter, and
    // behind an entry of B's own, where one unresolvable entry fails the whole batch.
    const foreignEntries: Array<(values: readonly string[]) => Record<string, unknown>[]> = [
      ([databaseId]) => [{ databaseId }],
      ([databaseId]) => [{ databaseId, groupBy: a.relationPropertyKey }],
      ([databaseId]) => [{ databaseId, collection: true }],
      ([databaseId]) => [{ databaseId: b.databaseId }, { databaseId }],
    ];
    for (const items of foreignEntries) {
      const refused = await expectForeignLikeRandom(b.member, [a.databaseId], (values) => ({
        method: "POST",
        path: "/api/items/count",
        body: { items: items(values) },
      }));
      expect(refused.status).toBe(404);
    }
    // B's own counts name B's databases and the target of B's own edge, and nothing of A's.
    await expectExcludesA(
      b.member,
      {
        method: "POST",
        path: "/api/items/count",
        body: {
          items: [{ databaseId: b.databaseId, groupBy: b.relationPropertyKey }, { databaseId: b.targetDatabaseId }],
        },
      },
      [b.databaseId, b.targetDatabaseId, b.targetItemId],
    );
  },
  "database facets": async () => {
    // A foreign database answers exactly as a random one does: for a text facet, for a relation facet and a path
    // through it, and under a filter with an open filter.
    const present = { type: "is_not_empty", property: a.propertyKey };
    const foreignBodies: Record<string, unknown>[] = [
      { facets: [a.propertyKey] },
      { facets: [a.relationPropertyKey, { path: [a.relationPropertyKey, a.propertyKey] }] },
      { facets: [a.propertyKey], filter: present, extra: { open: present } },
    ];
    for (const body of foreignBodies) {
      const refused = await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => ({
        method: "POST",
        path: `/api/databases/${id}/facets`,
        body,
      }));
      expect(refused.status).toBe(404);
    }
    // B's own facets name the target of B's own edge, and nothing of A's.
    await expectExcludesA(
      b.member,
      {
        method: "POST",
        path: `/api/databases/${b.databaseId}/facets`,
        body: { facets: [b.relationPropertyKey, b.propertyKey] },
      },
      [b.targetItemId],
    );
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
  "list page changes": async () => {
    const since = encodeURIComponent(new Date(Date.now() - 1_000).toISOString());
    const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}/page/changes?since=${since}`,
    }));
    expect(refused.status).toBe(404);
    // The allowed side: B lists the changes of an item of its own that has no page, an empty list.
    const created = await send(b.member, {
      method: "POST",
      path: `/api/databases/${b.databaseId}/items`,
      body: { properties: {} },
    });
    expect(created.status, created.text).toBe(201);
    const fresh = z.object({ id: z.string() }).parse(JSON.parse(created.text)).id;
    const own = await send(b.member, { method: "GET", path: `/api/items/${fresh}/page/changes?since=${since}` });
    expect(own.status, own.text).toBe(200);
    expect(JSON.parse(own.text)).toEqual([]);
  },
  "read page markdown": async () => {
    const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
      method: "GET",
      path: `/api/items/${id}/page.md`,
    }));
    expect(refused.status).toBe(404);
    // The allowed side: B reads its own page, whose body and token carry none of A's ids.
    const own = await send(b.member, { method: "GET", path: `/api/items/${b.itemId}/page.md` });
    expect(own.status, own.text).toBe(200);
    expectNoneOf(own.text, a.ids, "B's own page.md");
  },
  "replace page markdown": () =>
    leavesAUnchanged(async () => {
      const markdownHeaders = (etag: string) => ({ "Content-Type": "text/markdown", "If-Match": `"${etag}"` });
      // A foreign item answers exactly as a random one does, with a current-looking token, and nothing of A's is written.
      const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "PUT",
        path: `/api/items/${id}/page.md`,
        headers: markdownHeaders("A".repeat(43)),
        body: "Foreign text",
      }));
      expect(refused.status).toBe(404);
      // The allowed side: B replaces the page of an item of its own, created inside this case.
      const fresh = readString(
        await sendOk(b.member, {
          method: "POST",
          path: `/api/databases/${b.databaseId}/items`,
          body: { properties: {} },
        }),
        "id",
      );
      const read = await send(b.member, { method: "GET", path: `/api/items/${fresh}/page.md` });
      const etag = read.headers.etag?.replaceAll('"', "") ?? "";
      expect(etag).not.toBe("");
      const own = await send(b.member, {
        method: "PUT",
        path: `/api/items/${fresh}/page.md`,
        headers: markdownHeaders(etag),
        body: "Own text",
      });
      expect(own.status, own.text).toBe(200);
      expectNoneOf(own.text, a.ids, "B's own replace");
    }),
  "insert page markdown": () =>
    leavesAUnchanged(async () => {
      // A foreign item answers exactly as a random one does, and nothing of A's page is written.
      const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "POST",
        path: `/api/items/${id}/page/insert`,
        body: { placement: "end", markdown: "Foreign text" },
      }));
      expect(refused.status).toBe(404);
      // The allowed side: B inserts into its own page.
      const own = await send(b.member, {
        method: "POST",
        path: `/api/items/${b.itemId}/page/insert`,
        body: { placement: "end", markdown: "Own text" },
      });
      expect(own.status, own.text).toBe(200);
      expectNoneOf(own.text, a.ids, "B's own insert");
    }),
  "create subpage": () =>
    leavesAUnchanged(async () => {
      // A foreign parent answers exactly as a random one does, and nothing of A's is written.
      const refused = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => ({
        method: "POST",
        path: `/api/items/${id}/page/subpages`,
        body: { title: "Foreign subpage" },
      }));
      expect(refused.status).toBe(404);
      // The allowed side: B creates one under B's own item.
      const own = await send(b.member, {
        method: "POST",
        path: `/api/items/${b.itemId}/page/subpages`,
        body: { title: "Own subpage" },
      });
      expect(own.status, own.text).toBe(201);
      expectNoneOf(own.text, a.ids, "B's own subpage");
    }),
  "duplicate page": async () => {
    const foreign = await seedSubpage(a);
    const own = await seedSubpage(b);
    const readForeignHost = () => send(a.member, { method: "GET", path: `/api/items/${foreign.hostItemId}/page` });
    const before = await readForeignHost();
    expect(before.status, before.text).toBe(200);
    await leavesAUnchanged(async () => {
      // A's page answers exactly as a random id does, and so does A's host item, which is not a page at all.
      for (const foreignId of [foreign.pageItemId, a.itemId]) {
        const refused = await expectForeignLikeRandom(b.member, [foreignId], ([id]) => ({
          method: "POST",
          path: `/api/items/${id}/page/duplicate`,
        }));
        expect(refused.status).toBe(404);
      }
      // The allowed side: B duplicates its own page.
      const copied = await send(b.member, { method: "POST", path: `/api/items/${own.pageItemId}/page/duplicate` });
      expect(copied.status, copied.text).toBe(201);
      expectNoneOf(copied.text, [...a.ids, foreign.hostItemId, foreign.pageItemId], "B's own duplicate");
    });
    // The page of A's host still holds exactly the block of its one page: no copy was placed in it.
    expect(await readForeignHost()).toEqual(before);
  },
  "rename page": async () => {
    const foreign = await seedSubpage(a);
    const own = await seedSubpage(b);
    const readForeign = async (): Promise<Answer[]> => [
      await send(a.member, { method: "GET", path: `/api/items/${foreign.hostItemId}/page` }),
      await send(a.member, { method: "GET", path: `/api/items/${foreign.pageItemId}` }),
    ];
    const before = await readForeign();
    expect(before.map((answer) => answer.status)).toEqual([200, 200]);
    await leavesAUnchanged(async () => {
      // A's page answers exactly as a random id does, and so does A's host item, which is not a page at all.
      for (const foreignId of [foreign.pageItemId, a.itemId]) {
        const refused = await expectForeignLikeRandom(b.member, [foreignId], ([id]) => ({
          method: "PATCH",
          path: `/api/items/${id}/page/title`,
          body: { title: "Foreign title" },
        }));
        expect(refused.status).toBe(404);
      }
      // The allowed side: B renames its own page.
      const renamed = await send(b.member, {
        method: "PATCH",
        path: `/api/items/${own.pageItemId}/page/title`,
        body: { title: "Own title" },
      });
      expect(renamed.status, renamed.text).toBe(200);
      expectNoneOf(renamed.text, [...a.ids, foreign.hostItemId, foreign.pageItemId], "B's own rename");
    });
    // A's page keeps its title, on its item and in the block of its host's page.
    expect(await readForeign()).toEqual(before);
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
      // Issue #1645: A's project as B's attach target answers exactly like a random id, before B's body is read.
      const attach = ([target]: readonly string[]): Request => ({
        method: "POST",
        path: "/api/files",
        body: `ID3 attached audio of ${randomUUID()}`,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Filename": "b.mp3",
          "X-Attach-To-Item": target!,
          "X-Attach-Relation": "projects",
        },
      });
      const attached = await expectForeignLikeRandom(b.member, [a.projectItemId], attach);
      expect(attached.status, attached.text).toBe(404);
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
  "update profile": async () => {
    // A member of a third tenant calls it: B's user row is a fixture the cases after this one read.
    const callerTenantId = await createTestTenant(adminPool);
    const caller = await signUp(callerTenantId, "member");
    // `users` is a global identity table, read in the system scope the session lookup uses.
    const userRow = async (userId: string) => {
      const user = await runAsSystem("isolation test user read", () => getUserById(pool, userId));
      if (!user) throw new Error(`no user ${userId}`);
      return user;
    };
    // The queued jobs whose key names the tenant, read through graphile-worker's public `jobs` view.
    const jobsOf = async (tenantId: string) => {
      const { rows } = await adminPool.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      return rows.filter((job) => job.key?.includes(tenantId) ?? false);
    };
    const before = {
      users: { a: await userRow(a.member.userId), b: await userRow(b.member.userId) },
      jobs: { a: await jobsOf(a.tenantId), b: await jobsOf(b.tenantId) },
    };
    const patch = (body: unknown): Request => ({ method: "PATCH", path: "/api/account/profile", body });

    // The account comes from the session only: A's user id in the body is refused exactly as a random one.
    const refused = await expectForeignLikeRandom(caller, [a.member.userId], ([userId]) =>
      patch({ locale: "en", userId }),
    );
    expect(refused.status).toBe(400);
    expect((await userRow(caller.userId)).locale).toBe("cs");

    const answer = await send(caller, patch({ locale: "en" }));
    expect(answer.status, answer.text).toBe(200);
    expect(readString(answer.text, "user", "id")).toBe(caller.userId);
    expect(readString(answer.text, "user", "locale")).toBe("en");
    expectNoneOf(answer.text, a.ids, "update profile");
    expect((await userRow(caller.userId)).locale).toBe("en");
    // The search rebuild the change queues belongs to the caller's tenant.
    expect((await jobsOf(callerTenantId)).map((job) => job.key)).toEqual([
      expect.stringContaining("item-search-backfill"),
    ]);

    expect({
      users: { a: await userRow(a.member.userId), b: await userRow(b.member.userId) },
      jobs: { a: await jobsOf(a.tenantId), b: await jobsOf(b.tenantId) },
    }).toEqual(before);
    const sessionA = await send(a.member, { method: "GET", path: "/api/auth/session" });
    expect(readString(sessionA.text, "user", "locale")).toBe(before.users.a.locale);
    await expectAAccountActive();
  },

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
      label: "count items",
      ids: [a.databaseId],
      build: ([databaseId]) => ({
        method: "POST",
        path: "/api/items/count",
        body: { items: [{ databaseId, groupBy: a.relationPropertyKey }] },
      }),
      status: 200,
      contains: [a.databaseId, a.targetItemId],
    },
    {
      label: "database facets",
      ids: [a.databaseId],
      build: call("POST", ([id]) => `/api/databases/${id}/facets`, { facets: [a.relationPropertyKey] }),
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
      label: "transcript speaker candidates",
      ids: [a.transcriptItemId],
      build: get(([id]) => `/api/transcripts/${id}/speaker-candidates`),
      status: 200,
    },
    {
      label: "transcript speaker assignment",
      ids: [a.transcriptItemId],
      // Clearing a key that is not mapped is a success that writes nothing, so no undo is needed.
      build: call("PUT", ([id]) => `/api/transcripts/${id}/speakers/SPEAKER_00`, { personId: null }),
      status: 200,
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
  // REST-only (issue #1699): MCP answers both as unknown tools, for A's Health records `tags` as for a random id.
  "property.option.add": async (p) => {
    const aTags = await healthTagsPropertyId(a);
    await p.foreignLikeRandom([aTags], ([propertyId]) => ({ propertyId, label: "Isolation MCP probe" }));
    expect((await storedOptions(a, aTags)).map((option) => option.label)).not.toContain("Isolation MCP probe");
  },
  "property.option.update": async (p) => {
    const aTags = await healthTagsPropertyId(a);
    await p.foreignLikeRandom([aTags], ([propertyId]) => ({
      propertyId,
      key: "medication",
      label: "Isolation MCP rename",
    }));
    expect(await storedOptions(a, aTags)).toContainEqual(SEEDED_MEDICATION_OPTION);
  },
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
  "item.count": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ items: [{ databaseId }] }));
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({
      items: [{ databaseId: b.databaseId }, { databaseId, groupBy: a.relationPropertyKey }],
    }));
    await p.excludesA({ items: [{ databaseId: b.databaseId, groupBy: b.relationPropertyKey }] }, [
      b.databaseId,
      b.targetItemId,
    ]);
  },
  "database.facets": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, facets: [a.propertyKey] }));
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({
      databaseId,
      facets: [a.relationPropertyKey, { path: [a.relationPropertyKey, a.propertyKey] }],
    }));
    await p.excludesA({ databaseId: b.databaseId, facets: [b.relationPropertyKey] }, [b.targetItemId]);
  },
  "link.unlink": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, propertyKey: a.propertyKey })),
  "link.relink": (p) => p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, propertyKey: a.propertyKey })),
  "page.ensure": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId }));
    await p.excludesA({ itemId: b.itemId }, []);
  },
  "page.createSubpage": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ parent: { itemId }, title: "Foreign subpage" }));
    await p.excludesA({ parent: { itemId: b.itemId }, title: "Own subpage" }, []);
  },
  "page.duplicate": async (p) => {
    // A's page answers exactly as a random id does, and so does A's host item, which is not a page at all.
    await p.foreignLikeRandom([mcpPages.foreign.pageItemId], ([pageItemId]) => ({ pageItemId }));
    await p.foreignLikeRandom([a.itemId], ([pageItemId]) => ({ pageItemId }));
    await p.excludesA({ pageItemId: mcpPages.own.pageItemId }, []);
  },
  "page.rename": async (p) => {
    // A's page answers exactly as a random id does, and so does A's host item, which is not a page at all.
    await p.foreignLikeRandom([mcpPages.foreign.pageItemId], ([pageItemId]) => ({
      pageItemId,
      title: "Foreign title",
    }));
    await p.foreignLikeRandom([a.itemId], ([pageItemId]) => ({ pageItemId, title: "Foreign title" }));
    await p.excludesA({ pageItemId: mcpPages.own.pageItemId, title: "Own title" }, [mcpPages.own.pageItemId]);
  },
  "page.insert": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, placement: "end", markdown: "Foreign insert" }));
    await p.excludesA({ itemId: b.itemId, placement: "end", markdown: "Own insert" }, []);
  },
  // REST-only (issue #1765): MCP answers A's item as an unknown tool, exactly as it answers a random id, and writes nothing.
  "page.replace": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({
      itemId,
      markdown: "Foreign replace",
      expectedEtag: "A".repeat(43),
    }));
  },
  "page.changes": async (p) => {
    // The probe instant: after every page document of the fixtures exists and not in the future.
    const since = new Date().toISOString();
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, since }));
    await p.excludesA({ itemId: b.itemId, since }, []);
  },
  "page.get": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, format: "summary" }));
    await p.excludesA({ itemId: b.itemId, format: "summary" }, []);
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, format: "markdown" }));
    await p.excludesA({ itemId: b.itemId, format: "markdown" }, []);
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
      customRouteDependencies: { ...MAIL_OAUTH_DEPENDENCIES, ...MAILBOX_PASSWORD_DEPENDENCIES },
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
      if (!isRecord(body)) throw new Error("Invalid thread response");
      if (thread.kind === "tick") {
        // Issue #1562: the tick thread's own heartbeat header, and no active run (the fixture's run is the user's).
        expect({ heartbeat: body.heartbeat, activeRun: body.activeRun }).toEqual({
          heartbeat: {
            id: a.heartbeatId,
            name: "Isolation heartbeat",
            rule: { kind: "interval", minutes: 5 },
            enabled: true,
            projectItemId: a.projectItemId,
            projectName: null,
            canTrigger: true,
          },
          activeRun: null,
        });
      } else {
        expect(body).not.toHaveProperty("heartbeat");
        expect(body).not.toHaveProperty("activeRun");
      }
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
        // An agent run that ends an active link is asked for approval first (issue #1758), so the member
        // ends the link and the run's unlink is the no-op of an already broken one.
        if (caller === mcpRunCredential && action === "unlink") {
          await send(b.member, { method: "POST", path: `/api/items/${own}/links/note/unlink` });
        }
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
    beforeAll(async () => {
      mcpPages = { foreign: await seedSubpage(a), own: await seedSubpage(b) };
    });

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
