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
  type AiGatewayCompletionInput,
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
  stubDnsLookup,
  writeMailboxAddresses,
  type GmailMailClient,
} from "@semprec/data/testSupport";
import {
  agentGuidanceDriftFindingsStore,
  createActionRegistry,
  coreAgentRunAction,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  CALENDAR_MODULE_ID,
  createChokePoint,
  createCoreTaskList,
  createEventInCalendar,
  createHeartbeat,
  createInvite,
  createItemWithClient,
  createPasswordResetToken,
  createRelationWithClient,
  createPendingApprovalRequest,
  claimSempMessage,
  createSempChatThread,
  createUser,
  finishAgentRun,
  finishSempMessageTurn,
  generateOpaqueToken,
  getDatabaseByModuleId,
  getPasswordResetTokenByHash,
  getUserById,
  listPropertiesByDatabase,
  transcriptionSourceLink,
  updateItemWithClient,
  writeComputed,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPTION_OWNER_PROCESS,
  getOrCreateJournalItem,
  ensureJournalPeriodDoc,
  hashPassword,
  handleObservabilityCheckSystemTask,
  handleAgentRunEventsRetentionTask,
  insertAgentRunEvent,
  insertValueLink,
  listPushSubscriptionsForUser,
  loadFullModuleRegistry,
  retryHeartbeatFireJobKey,
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
  type MailTransportMessage,
  revokeInvite,
  sendSempMessage,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  writeNotification,
  upsertMailServerSettings,
  type PasswordResetMailer,
} from "@semprec/data";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob, runOnce, runWorker, type TaskList } from "@semprec/queue";
import { createDispatcher } from "../app.js";
import { createChatRun, playReply, type ReplySetup } from "./agentRunReplyFixtures.js";
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
import { createVoiceChannel, type VoiceIdentity } from "../voiceChannel.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { ROUTE_MATRIX, ROUTE_TENANCIES, type RouteMatrixEntry } from "../routeMatrix.js";

/**
 * Every `surface: "api"` entry of `ROUTE_MATRIX` and every MCP generic operation is driven as
 * tenant B against tenant A's rows on a runtime-role pool with `SEMPREC_TENANT_SCOPE=strict`. A
 * foreign id must be answered exactly like a random one (same status, body and headers once
 * requested ids are masked), a mutation must leave A's rows as A reads them, and a list, query or
 * count must contain B's own rows and none of A's ids.
 *
 * Most cases also run a positive control (A's own request, or B's request on its own row) so a
 * refusal or an empty answer cannot pass for isolation by accident.
 */

const SETUP_TOKEN = "tenant-isolation-setup-token";
const EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";
const MAILBOX_PASSWORD = "isolation-mailbox-password";
const REFUSED_MAILBOX_PASSWORD = "isolation-refused-mailbox-password";

/**
 * The mail server accepts every login except `REFUSED_MAILBOX_PASSWORD`, so no case reaches a real
 * server.
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
/**
 * Names every task `THREAD_TASK_AI_NAME` and records its requests, so a case can tell which
 * threads' text reached the model.
 */
const THREAD_TASK_AI_NAME = "Isolation thread task";
const threadTaskGatewayCalls: AiGatewayCompletionInput[] = [];
const THREAD_TASK_DEPENDENCIES: CustomRouteDependencies = {
  aiGateway: {
    async complete(input) {
      threadTaskGatewayCalls.push(input);
      return { content: { name: THREAD_TASK_AI_NAME }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  },
};
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-isolation-${randomUUID()}`);
const filesStorage = new LocalFsBlobStorageWriter(join(tmpBlobDir, "files"));
/** Records every message it is asked to deliver, so a case can tell whose mail reached it. */
const deliveredMail: MailTransportMessage[] = [];
const MAIL_SEND_DEPENDENCIES: CustomRouteDependencies = {
  mailServerClients: {
    ...MAILBOX_PASSWORD_DEPENDENCIES.mailServerClients,
    send: {
      transports: {
        forMailbox: async () => ({
          async send(message) {
            deliveredMail.push(message);
            return {};
          },
        }),
      },
      attachmentStorage: { files: filesStorage, mailAttachments: filesStorage },
    },
  },
};
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

/**
 * The provider refuses every authorization code, so a case gets as far as the provider call and
 * none reaches a real provider.
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
  headers: Record<string, string>;
}

/**
 * Headers that differ per request or connection whatever the row. `content-length` is left out
 * because masking a value of a different length would change it; the body is compared itself.
 */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(["date", "connection", "keep-alive", "content-length"]);

interface Request {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A request without a `body` argument sends no body at all. */
function requestOf(method: string) {
  return (path: string, body?: unknown): Request => (body === undefined ? { method, path } : { method, path, body });
}
const GET = requestOf("GET");
const POST = requestOf("POST");
const PUT = requestOf("PUT");
const PATCH = requestOf("PATCH");
const DELETE = requestOf("DELETE");

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
  fileContent: string;
  recordingContent: string;
  blobId: string;
  /** The value its ETag is derived from. */
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
  /** Target of the removal-impact route. */
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
  /** `ids` without users, sessions, push subscriptions and the Graph subscription. */
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

function approvalRequestRead(id: string): Request {
  return GET(`/api/approval-requests/${id}`);
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

function restoreStatuses(text: string): Array<{ id: string; status: string }> {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error(`expected a results array in ${text}`);
  return body.results.map((result: unknown) => {
    if (!isRecord(result) || typeof result.id !== "string" || typeof result.status !== "string")
      throw new Error(`expected an id and a status on every result in ${text}`);
    return { id: result.id, status: result.status };
  });
}

/** Strict enforcement requires a tenant scope on the runtime-role pool. */
function inTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

/**
 * The two messages are inserted by SQL in the shape `insertSempUserTurn` and `startSempMessageTurn`
 * leave them, because the production writer queues a worker job this case must not leave behind.
 * Undone by `removeScopedReply`.
 */
async function seedScopedReply(tenantId: string, userId: string) {
  return inTenantTransaction(tenantId, async (client) => {
    const threadId = await createSempChatThread(client);
    const run = await createAgentRun(client, {
      triggeredBy: "user",
      unit: "session",
      task: "message scope probe",
      userId,
      threadId,
    });
    const event = await insertAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
    const user = await client.query<{ id: string }>(
      "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'scope probe') RETURNING id",
      [threadId],
    );
    const assistant = await client.query<{ id: string }>(
      `INSERT INTO semp_messages (thread_id, role, reply_to_message_id, agent_run_id, event_from_id, status)
       VALUES ($1, 'assistant', $2, $3, $4, 'running') RETURNING id`,
      [threadId, user.rows[0]?.id, run.id, event.id],
    );
    const messageId = assistant.rows[0]?.id;
    if (messageId === undefined) throw new Error("The scoped reply was not inserted");
    return { threadId, runId: run.id, messageId, eventId: event.id };
  });
}

async function removeScopedReply(seeded: { threadId: string; runId: string }): Promise<void> {
  await adminPool.query("DELETE FROM semp_threads WHERE id = $1", [seeded.threadId]);
  await adminPool.query("DELETE FROM agent_run_events WHERE agent_run_id = $1", [seeded.runId]);
  const removed = await adminPool.query("DELETE FROM agent_runs WHERE id = $1", [seeded.runId]);
  expect(removed.rowCount).toBe(1);
}

/** Invitations are global, so no tenant scope applies. */
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

/** Read as the superuser so the count sees every tenant. */
async function tenantCount(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants");
  return rows[0]?.n ?? -1;
}

async function send(caller: Caller | null, request: Request): Promise<Answer> {
  const headers: Record<string, string> = { ...(caller?.headers ?? {}), ...(request.headers ?? {}) };
  let body: string | Buffer | undefined;
  if (request.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body =
      typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
  }
  const res = await fetch(`${baseUrl}${request.path}`, { method: request.method, headers, body });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (!IGNORED_HEADERS.has(name)) responseHeaders[name] = value;
  });
  return { status: res.status, text: await res.text(), headers: responseHeaders };
}

/** `POST /api/blobs` stores only bytes whose type it recognises. */
function pngBytesOf(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
}

async function sendOk(caller: Caller, request: Request): Promise<string> {
  const answer = await send(caller, request);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${request.method} ${request.path} answered ${answer.status}: ${answer.text}`);
  }
  return answer.text;
}

/** Every occurrence of a requested value, in the body and the headers, is replaced with `<id>`. */
function masked(answer: Answer, values: readonly string[]): Answer {
  const mask = (text: string): string => values.reduce((acc, value) => acc.split(value).join("<id>"), text);
  return {
    status: answer.status,
    text: mask(answer.text),
    headers: Object.fromEntries(Object.entries(answer.headers).map(([name, value]) => [name, mask(value)])),
  };
}

/** `random` holds one fresh UUID per foreign value. Returns the foreign answer. */
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

/** `expectForeignLikeRandom` where the shared answer is the 404 of an unknown row. */
async function expectForeign404(
  caller: Caller | null,
  foreign: readonly string[],
  build: (values: readonly string[]) => Request,
): Promise<Answer> {
  const answer = await expectForeignLikeRandom(caller, foreign, build);
  expect(answer.status).toBe(404);
  return answer;
}

/** An anonymous request naming A's email answers exactly like one naming an unknown email. */
async function expectAEmailLikeUnknown(build: (email: string) => Request): Promise<void> {
  const unknownEmail = `${randomUUID()}@example.test`;
  const known = await send(null, build(a.member.email));
  const unknown = await send(null, build(unknownEmail));
  expect(masked(known, [a.member.email])).toEqual(masked(unknown, [unknownEmail]));
}

/** `text` holds every one of `present` and none of `absent`. */
function expectText(text: string, present: readonly string[], absent: readonly string[]): void {
  expect({
    missing: present.filter((value) => !text.includes(value)),
    leaked: absent.filter((value) => text.includes(value)),
  }).toEqual({ missing: [], leaked: [] });
}

function expectNoneOf(text: string, ids: readonly string[], what: string): void {
  const leaked = ids.filter((id) => text.includes(id));
  expect(leaked, `${what} contains ids it must not`).toEqual([]);
}

/** Also requires every one of `ownIds`, so an empty answer cannot pass for the wrong reason. */
async function expectExcludesA(
  caller: Caller,
  request: Request,
  ownIds: readonly string[] = [],
  moreIdsOfA: readonly string[] = [],
): Promise<Answer> {
  const answer = await send(caller, request);
  const what = `${request.method} ${request.path}`;
  expect(answer.status, `${what}: ${answer.text}`).toBeLessThan(300);
  expectNoneOf(answer.text, [...a.ids, ...moreIdsOfA], what);
  expect(
    ownIds.filter((id) => !answer.text.includes(id)),
    `${what} is missing B's own rows`,
  ).toEqual([]);
  return answer;
}

function aStateReads(): Request[] {
  return [
    GET("/api/databases?limit=200"),
    GET(`/api/databases/${a.databaseId}`),
    GET(`/api/databases/${a.targetDatabaseId}`),
    GET(`/api/databases/${a.archivedDatabaseId}`),
    GET(`/api/databases/${a.databaseId}/properties`),
    GET(`/api/databases/${a.targetDatabaseId}/properties`),
    GET(`/api/views?limit=200`),
    GET(`/api/views/${a.viewId}`),
    GET(`/api/views/${a.curatedViewId}`),
    POST(`/api/views/${a.curatedViewId}/query`, {}),
    POST(`/api/databases/${a.databaseId}/query`, {}),
    POST(`/api/databases/${a.databaseId}/query`, { inTrash: true }),
    POST(`/api/databases/${a.targetDatabaseId}/query`, {}),
    GET(`/api/items/${a.itemId}`),
    GET(`/api/items/${a.targetItemId}`),
    GET(`/api/items/${a.fileItemId}`),
    GET(`/api/items/${a.mcpServerItemId}`),
    GET(`/api/items/${a.transcriptItemId}`),
    GET(`/api/items/${a.proposalItemId}`),
    GET(`/api/items/${a.projectItemId}`),
    GET(`/api/blobs/${a.blobId}`),
    GET("/api/notifications/unread"),
    GET("/api/approval-requests"),
    GET(`/api/agent-runs/${a.agentRunId}`),
    GET(`/api/projects/${a.projectItemId}/mcp-grants`),
    GET(`/api/mail/mailboxes`),
    GET(`/api/mail/mailboxes/${a.mailboxItemId}`),
    GET(`/api/transcripts/${a.transcriptItemId}/speakers`),
    GET(`/api/transcripts/${a.transcriptItemId}`),
    GET("/api/account/exports"),
  ];
}

/** Also covers the heartbeats, run events, relation edges and push subscriptions no route lists. */
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

async function readAAccountState(): Promise<string[]> {
  const lines: string[] = [];
  for (const session of [a.member, a.secondSession, a.webSession]) {
    const answer = await send(session, GET("/api/auth/session"));
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

async function leavesAUnchanged(body: () => Promise<void>): Promise<void> {
  const before = await readAState();
  await body();
  expect(await readAState()).toEqual(before);
}

/**
 * So a case that sends an invitation does not depend on whether "set self person" ran before it.
 */
async function linkOwnPerson(tenant: TenantFixture): Promise<void> {
  const personId = await createItemAs(tenant, "people", { name: "Organizer probe" });
  await sendOk(tenant.member, PUT("/api/auth/self-person", { personId }));
}

/** An open inbox proposal card; `properties` override or add to the defaults, every one as a system key. */
async function createProposalCard(client: PoolClient, properties: Record<string, unknown> = {}): Promise<string> {
  const all = { kind: "inbox", status: "proposed", proposal: null, ...properties };
  const database = await moduleDatabase(client, "processingProposals");
  const card = await createItemWithClient(
    client,
    { databaseId: database.id, properties: all },
    { allowedSystemKeys: Object.keys(all) },
  );
  return card.id;
}

/** Seeded per case, so a case that changes a card changes none of the rows A and B share. */
function seedProposalCard(tenant: TenantFixture, properties: Record<string, unknown> = {}): Promise<string> {
  return inTenantTransaction(tenant.tenantId, (client) => createProposalCard(client, properties));
}

/** The same assistant proposal of one task, as both the effective and the assistant envelope. */
async function seededTaskProposal(tenant: TenantFixture) {
  const envelope = {
    entityKind: "database",
    target: await databaseIdFor(tenant.tenantId, "tasks"),
    properties: { name: "Seeded task" },
  };
  return { proposal: envelope, aiProposal: envelope };
}

/** A pending approval of a fresh heartbeat run of the tenant's member. */
function seedPendingApproval(tenant: TenantFixture, task: string): Promise<string> {
  return runInTenant(tenant.tenantId, async () => {
    const run = await createAgentRun(pool, { triggeredBy: "heartbeat", task, userId: tenant.member.userId });
    const approval = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return approval.id;
  });
}

/** A rejected card is not open, so the "inbox cards" case never counts it. */
function rejectProposalCard(tenant: TenantFixture, cardId: string): Promise<void> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const cards = await moduleDatabase(client, "processingProposals");
    await updateItemWithClient(
      client,
      { databaseId: cards.id, itemId: cardId, propertiesPatch: { status: "rejected" } },
      { allowedSystemKeys: ["status"] },
    );
  });
}

async function createInboxItem(client: PoolClient, text: string): Promise<string> {
  const inbox = await moduleDatabase(client, "inbox");
  const item = await createItemWithClient(client, {
    databaseId: inbox.id,
    properties: { date: "2026-08-28", time: "09:00", text },
  });
  return item.id;
}

async function createInboxType(client: PoolClient, name: string): Promise<string> {
  const types = await moduleDatabase(client, "inboxItemTypes");
  const type = await createItemWithClient(client, {
    databaseId: types.id,
    properties: { name, emoji: "☑️", status: "active", processingMethod: "pageContent" },
  });
  return type.id;
}

/** The `sourceInbox` edge the inbox pipeline writes from a card to its inbox item. */
async function linkProposalSource(client: PoolClient, cardId: string, sourceId: string): Promise<void> {
  const cards = await moduleDatabase(client, "processingProposals");
  const property = (await listPropertiesByDatabase(client, cards.id)).find(({ key }) => key === "sourceInbox");
  if (!property) throw new Error("no 'sourceInbox' property");
  await createRelationWithClient(
    client,
    { relationPropertyId: property.id, callerItemId: cardId, targetItemId: sourceId },
    { ownerProcess: "processingProposals" },
  );
}

/**
 * B's `request` on a card of A answers like a random id and leaves it unchanged. `owner`'s request
 * on its own card then answers 200 and passes `check`, and A's card is still unchanged. Both cards
 * are rejected at the end.
 */
async function expectProposalCardRoute(options: {
  seed: (tenant: TenantFixture) => Promise<string>;
  owner: TenantFixture;
  request: (cardId: string) => Request;
  check: (text: string) => void;
}): Promise<void> {
  const [own, foreign] = [await options.seed(options.owner), await options.seed(a)];
  const readCard = () => sendOk(a.member, GET(`/api/items/${foreign}`));
  const foreignBefore = await readCard();
  await leavesAUnchanged(async () => {
    await expectForeign404(b.member, [foreign], ([id]) => options.request(id!));
  });
  expect(await readCard()).toBe(foreignBefore);

  const answer = await send(options.owner.member, options.request(own));
  expect(answer.status, answer.text).toBe(200);
  options.check(answer.text);
  expect(await readCard()).toBe(foreignBefore);
  await Promise.all([rejectProposalCard(options.owner, own), rejectProposalCard(a, foreign)]);
}

interface SeededSubpage {
  hostItemId: string;
  pageItemId: string;
}

/** Seeded per case, so a case that needs a page changes none of the rows A and B share. */
async function seedSubpage(tenant: TenantFixture): Promise<SeededSubpage> {
  const hostItemId = readString(
    await sendOk(tenant.member, POST(`/api/databases/${tenant.databaseId}/items`, { properties: {} })),
    "id",
  );
  const created = await sendOk(
    tenant.member,
    POST(`/api/items/${hostItemId}/page/subpages`, { title: "Isolation page" }),
  );
  const page = z.object({ pages: z.array(z.object({ pageItemId: z.string() })).length(1) }).parse(JSON.parse(created))
    .pages[0];
  if (!page) throw new Error("expected one created page");
  return { hostItemId, pageItemId: page.pageItemId };
}

/** For a host seeded by `seedSubpage` this is the `page` block of its subpage. */
async function firstBlockIdOfPage(member: TenantFixture["member"], hostItemId: string): Promise<string> {
  const read = await sendOk(member, GET(`/api/items/${hostItemId}/page`));
  const block = z.object({ blocks: z.array(z.object({ id: z.string() })).min(1) }).parse(JSON.parse(read)).blocks[0];
  if (!block) throw new Error("expected the page block of the host");
  return block.id;
}

/**
 * Seeded before the MCP cases: every MCP case runs inside `leavesAUnchanged`, so A's page cannot be
 * created inside one.
 */
let mcpPages: { foreign: SeededSubpage; own: SeededSubpage };

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

/** A web session's token comes back only in its cookie. */
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
  const sessionText = await sendOk({ headers }, GET("/api/auth/session"));
  return {
    userId: readString(text, "user", "id"),
    email,
    password,
    token,
    sessionId: readString(sessionText, "session", "id"),
    headers,
  };
}

async function signUp(tenantId: string, role: "admin" | "member", locale?: "cs" | "en"): Promise<Member> {
  const email = `${randomUUID()}@example.test`;
  // Every user gets its own password, so B presenting A's password is a wrong password for B.
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () =>
    createUser(adminPool, { email, passwordHash, tenantId, role, locale }),
  );
  return signIn(email, password, "ios");
}

/** The seeded database a module owns; every tenant here is provisioned with all of them. */
async function moduleDatabase(client: PoolClient, moduleId: string) {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`no '${moduleId}' database`);
  return database;
}

async function databaseIdFor(tenantId: string, moduleId: string): Promise<string> {
  return (await inTenantTransaction(tenantId, (client) => moduleDatabase(client, moduleId))).id;
}

/** Created through the REST route, as the tenant's member. */
async function createItemAs(
  tenant: TenantFixture,
  moduleId: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const databaseId = await databaseIdFor(tenant.tenantId, moduleId);
  return readString(await sendOk(tenant.member, POST(`/api/databases/${databaseId}/items`, { properties })), "id");
}

/** A pending invitation; iMIP ingest is its only production writer, so this writes the row it would. */
async function seedInvitation(tenant: TenantFixture, title: string, uid: string): Promise<string> {
  const invitationsDatabaseId = await databaseIdFor(tenant.tenantId, "invitations");
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const properties = {
      title,
      startsAt: "2026-11-20T09:00:00.000Z",
      endsAt: "2026-11-20T10:00:00.000Z",
      allDay: false,
      status: "pending",
      kind: "invite",
      uid,
      sequence: 0,
    };
    const invitation = await createItemWithClient(
      client,
      { databaseId: invitationsDatabaseId, properties },
      { allowedSystemKeys: Object.keys(properties), systemOwnerProcess: CALENDAR_MODULE_ID },
    );
    return invitation.id;
  });
}

async function seedSearchTask(tenant: TenantFixture, title: string): Promise<string> {
  return createItemAs(tenant, "tasks", { name: title });
}

/** A word no other row holds, so a search for it finds only what the case seeded. */
function freshSearchWord(): string {
  return `isolationsearch${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** One row of every kind a route addresses, created through production writes. */
async function seedTenant(): Promise<TenantFixture> {
  const tenantId = await createTestTenant(adminPool);
  await provisionTenant(pool, tenantId);
  const member = await signUp(tenantId, "member");
  const secondSession = await signIn(member.email, member.password, "ios");
  const webSession = await signIn(member.email, member.password, "web");

  const createDatabase = async (name: string): Promise<string> =>
    readString(await sendOk(member, POST("/api/databases", { name })), "id");
  const databaseId = await createDatabase("Isolation probe");
  const targetDatabaseId = await createDatabase("Isolation targets");
  const archivedDatabaseId = await createDatabase("Isolation archived");
  await sendOk(member, DELETE(`/api/databases/${archivedDatabaseId}`));

  const propertyKey = "note";
  const propertyId = readString(
    await sendOk(
      member,
      POST(`/api/databases/${databaseId}/properties`, { key: propertyKey, name: "Note", type: "text" }),
    ),
    "id",
  );
  const relationPropertyKey = "link";
  const relationPropertyId = readString(
    await sendOk(
      member,
      POST(`/api/databases/${databaseId}/properties`, {
        key: relationPropertyKey,
        name: "Link",
        type: "relation",
        targetDatabaseId,
        cardinality: "many_to_many",
        locked: false,
      }),
    ),
    "id",
  );
  const viewId = readString(
    await sendOk(member, POST(`/api/databases/${databaseId}/views`, { type: "table", name: "All rows" })),
    "id",
  );
  const curatedView = await runInTenant(tenantId, () =>
    createChokePoint(pool).createView({ type: "list", name: "Collection", config: { membership: "manual" } }),
  );

  const createItem = async (inDatabaseId: string): Promise<{ id: string; updatedAt: string }> => {
    const text = await sendOk(member, POST(`/api/databases/${inDatabaseId}/items`, { properties: {} }));
    return { id: readString(text, "id"), updatedAt: readString(text, "updatedAt") };
  };
  const item = await createItem(databaseId);
  const targetItem = await createItem(targetDatabaseId);
  const trashedItem = await createItem(databaseId);
  await sendOk(member, DELETE(`/api/items/${trashedItem.id}`));
  await sendOk(member, PUT(`/api/items/${item.id}/relations/${relationPropertyKey}/${targetItem.id}`, {}));
  await sendOk(member, PUT(`/api/views/${curatedView.id}/items/${item.id}`, {}));
  // A second member, so a foreign reorder of the first one to position 1 would change the order.
  await sendOk(member, PUT(`/api/views/${curatedView.id}/items/${targetItem.id}`, {}));
  // Re-read after the relation write, which may have bumped the item's version.
  const itemVersion = readString(await sendOk(member, GET(`/api/items/${item.id}`)), "version");

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
  await sendOk(member, POST("/api/transcriptions", { fileItemId }));
  const transcriptItemId = await runInTenant(tenantId, () => createTestModuleItem(pool, "transcripts"));
  // One speaker key, so A's speaker probes reach the key check and not only the transcript lookup.
  await inTenantTransaction(tenantId, async (client) => {
    const transcripts = await moduleDatabase(client, "transcripts");
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
    await sendOk(
      member,
      POST("/api/push-subscriptions", {
        channel: "apns",
        platform: "ios",
        deviceToken: pushDeviceToken,
        apnsEnvironment: "sandbox",
      }),
    ),
    "subscription",
    "id",
  );
  const exportId = readString(await sendOk(member, POST("/api/account/exports", {})), "export", "id");

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

  const listedDatabaseIds = readIdArray(await sendOk(member, GET("/api/databases?limit=200")), "databases");

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

function entryPath(name: string, id: string): string {
  const entry = ROUTE_MATRIX.find((route) => route.name === name);
  if (!entry) throw new Error(`no route matrix entry named '${name}'`);
  return entry.path.split(EXAMPLE_ID).join(id);
}

/** Written the way the sync job writes it. */
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

/** A mailbox item of the tenant's Mailboxes database. */
async function createMailbox(client: PoolClient, name: string): Promise<string> {
  const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
  const mailbox = await createItemWithClient(client, {
    databaseId: mailboxesDatabaseId,
    properties: { name, provider: "gmail" },
  });
  return mailbox.id;
}

/** A folder of `mailboxItemId`, written the way the sync job writes it. */
async function ensureMailboxFolder(
  client: PoolClient,
  mailboxItemId: string,
  folder: { providerId: string; name: string; behavior: "label" | "folder"; specialPurpose: string },
): Promise<string> {
  const ids = await resolveMailModuleIds(client);
  const folderProperties = await createChokePoint(pool).listProperties(ids.foldersDatabaseId);
  const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
  if (!mailboxProperty) throw new Error("the Folders database has no mailbox property");
  return ensureFolderItem(client, {
    foldersDatabaseId: ids.foldersDatabaseId,
    mailboxItemId,
    mailboxRelationPropertyId: mailboxProperty.id,
    ...folder,
  });
}

function mailboxWithInboxFolder(tenant: TenantFixture): Promise<{ mailboxId: string; folderId: string }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const mailboxId = await createMailbox(client, "With a folder");
    const folderId = await ensureMailboxFolder(client, mailboxId, {
      providerId: "INBOX",
      name: "INBOX",
      behavior: "label",
      specialPurpose: "inbox",
    });
    return { mailboxId, folderId };
  });
}

const DRAFT_ADDRESS = "drafts@example.test";

function mailboxForDrafts(tenant: TenantFixture): Promise<string> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const mailboxItemId = await createMailbox(client, "With drafts");
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId, address: DRAFT_ADDRESS });
    await ensureMailboxFolder(client, mailboxItemId, {
      providerId: "DRAFTS",
      name: "Drafts",
      behavior: "folder",
      specialPurpose: "drafts",
    });
    return mailboxItemId;
  });
}

async function addSentFolder(tenant: TenantFixture, mailboxId: string): Promise<void> {
  await inTenantTransaction(tenant.tenantId, (client) =>
    ensureMailboxFolder(client, mailboxId, {
      providerId: "SENT",
      name: "Sent",
      behavior: "folder",
      specialPurpose: "sent",
    }),
  );
}

function draftBody(mailboxId: string, subject: string): Record<string, unknown> {
  return {
    mailboxId,
    from: DRAFT_ADDRESS,
    to: [{ address: "recipient@example.test", name: "Recipient" }],
    cc: [],
    bcc: [],
    subject,
    body: "Draft text",
  };
}

async function seedDraft(tenant: TenantFixture): Promise<{ mailboxId: string; draftId: string; version: string }> {
  const mailboxId = await mailboxForDrafts(tenant);
  const text = await sendOk(
    tenant.member,
    POST("/api/mail/drafts", draftBody(mailboxId, `Draft of ${tenant.tenantId}`)),
  );
  return { mailboxId, draftId: readString(text, "id"), version: readString(text, "version") };
}

async function uploadAttachableFile(tenant: TenantFixture): Promise<string> {
  return readString(
    await sendOk(tenant.member, {
      method: "POST",
      path: "/api/files",
      body: `attachment of ${randomUUID()}`,
      headers: { "Content-Type": "text/plain", "X-Filename": "attachment.txt" },
    }),
    "id",
  );
}

async function startMailOauth(member: Member): Promise<string> {
  const started = await sendOk(member, POST("/api/mail/mailboxes/oauth/start", { provider: "gmail" }));
  const state = new URL(readString(started, "authorizeUrl")).searchParams.get("state");
  if (state === null) throw new Error("the authorization URL carries no state");
  return state;
}

interface MailOauthStateSnapshot {
  id: string;
  user_id: string;
  used_at: string | null;
}

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
  const text = await sendOk(admin, POST("/api/admin/invites", { email: `${randomUUID()}@example.test` }));
  return readString(text, "invite", "id");
}

/** `providerId` names the provider's message; a second seed in one tenant needs its own, or it converges on the first. */
function seedMailThread(
  fixture: TenantFixture,
  messageId: string,
  providerId = "message",
  providerThreadId = "thread",
  attachmentNames: string[] = [],
): Promise<string> {
  return inTenantTransaction(fixture.tenantId, async (client) => {
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
          attachments: attachmentNames.map((filename) => ({
            filename,
            contentType: "application/pdf",
            contentId: null,
            disposition: "attachment" as const,
            openStream: () => Readable.from([Buffer.from(filename)]),
          })),
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
  });
}

function addFolderToThreadMailbox(
  fixture: TenantFixture,
  threadId: string,
  providerId: string,
  specialPurpose: string,
): Promise<void> {
  return inTenantTransaction(fixture.tenantId, async (client) => {
    const holder = await client.query<{ mailbox_item_id: string }>(
      "SELECT mailbox_item_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND thread_id = $1",
      [threadId],
    );
    const mailboxId = holder.rows[0]?.mailbox_item_id;
    if (!mailboxId) throw new Error("the seeded mail thread has no mailbox");
    await ensureMailboxFolder(client, mailboxId, { providerId, name: providerId, behavior: "label", specialPurpose });
  });
}

async function inboxThreadIds(caller: Caller): Promise<string[]> {
  const parsed = z
    .object({ threads: z.array(z.object({ threadId: z.string() })) })
    .parse(JSON.parse(await sendOk(caller, GET("/api/mail/threads?box=inbox&limit=200"))));
  return parsed.threads.map((thread) => thread.threadId);
}

async function mailThreadItemId(client: PoolClient, threadId: string): Promise<string> {
  const { rows } = await client.query<{ item_id: string | null }>("SELECT item_id FROM mail_threads WHERE id = $1", [
    threadId,
  ]);
  const itemId = rows[0]?.item_id;
  if (!itemId) throw new Error(`mail thread ${threadId} has no item`);
  return itemId;
}

/**
 * The link rule that writes such links is not part of this tree, so the value links are written
 * with `insertValueLink` after the user's edges, which would otherwise end them.
 */
async function seedThreadProjectAndCompany(
  fixture: TenantFixture,
  threadId: string,
  marker: string,
): Promise<{ projectName: string; companyName: string; domain: string }> {
  const projectName = `${marker}-project`;
  const companyName = `${marker}-company`;
  const domain = `${marker}.example`;
  await runInTenant(fixture.tenantId, async () => {
    const cp = createChokePoint(pool);
    const found = await withTransaction(pool, async (client) => ({
      threads: await moduleDatabase(client, "threads"),
      projects: await moduleDatabase(client, "projects"),
      companies: await moduleDatabase(client, "companies"),
      itemId: await mailThreadItemId(client, threadId),
    }));
    const properties = await cp.listProperties(found.threads.id);
    for (const [key, database, name] of [
      ["project", found.projects, projectName],
      ["company", found.companies, companyName],
    ] as const) {
      const relation = properties.find((entry) => entry.key === key);
      if (!relation) throw new Error(`Missing Threads.${key}`);
      const target = await cp.createItem({ databaseId: database.id, properties: { name } });
      await cp.createRelation(
        { relationPropertyId: relation.id, callerItemId: found.itemId, targetItemId: target.id },
        { writerKind: "user" },
      );
    }
    await withTransaction(pool, async (client) => {
      for (const key of ["project", "company"]) {
        await insertValueLink(client, {
          itemId: found.itemId,
          propertyKey: key,
          ruleKey: "test.isolation",
          sources: [{ kind: "senderDomain", domain, sourcePropertyKey: key }],
        });
      }
    });
  });
  return { projectName, companyName, domain };
}

/**
 * Gives the attachment its own project, so the file's project and link entry differ from the
 * thread's (the ingest link ends with `broken_by` user). Returns the project's name.
 */
async function seedAttachmentProject(
  fixture: TenantFixture,
  threadId: string,
  fileName: string,
  marker: string,
): Promise<string> {
  const projectName = `${marker}-file-project`;
  await runInTenant(fixture.tenantId, async () => {
    const cp = createChokePoint(pool);
    const found = await withTransaction(pool, async (client) => {
      const files = await getDatabaseByModuleId(client, "files");
      const projects = await getDatabaseByModuleId(client, "projects");
      const { rows } = await client.query<{ id: string }>(
        `SELECT f.id FROM mail_threads t
         JOIN mail_message_meta m ON m.tenant_id = t.tenant_id AND m.thread_id = t.id
         JOIN mail_attachments a ON a.tenant_id = t.tenant_id AND a.message_item_id = m.item_id AND a.filename = $2
         JOIN items f ON f.tenant_id = t.tenant_id AND f.database_id = $3 AND f.properties->>'name' = a.filename
         WHERE t.tenant_id = app_tenant_default() AND t.id = $1`,
        [threadId, fileName, files?.id],
      );
      if (!files || !projects || rows.length !== 1 || !rows[0]) throw new Error("Missing Files, Projects or the file");
      return { files, projects, fileId: rows[0].id };
    });
    const relation = (await cp.listProperties(found.files.id)).find((entry) => entry.key === "projects");
    if (!relation) throw new Error("Missing Files.projects");
    const project = await cp.createItem({ databaseId: found.projects.id, properties: { name: projectName } });
    await cp.createRelation(
      { relationPropertyId: relation.id, callerItemId: found.fileId, targetItemId: project.id },
      { writerKind: "user" },
    );
  });
  return projectName;
}

async function seedThreadTask(fixture: TenantFixture, threadId: string): Promise<string> {
  return runInTenant(fixture.tenantId, async () => {
    const cp = createChokePoint(pool);
    const { threadsDatabaseId, tasksDatabaseId, threadItemId } = await withTransaction(pool, async (client) => ({
      threadsDatabaseId: (await moduleDatabase(client, "threads")).id,
      tasksDatabaseId: (await moduleDatabase(client, "tasks")).id,
      threadItemId: await mailThreadItemId(client, threadId),
    }));
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

/** Has a credential, a sync state and server settings, for the removal route. */
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
 * The thread through the real reconcile path; the area, the project and both relations through the
 * choke point.
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

async function datedTask(tenant: TenantFixture): Promise<string> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const tasks = await moduleDatabase(client, "tasks");
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

async function taskAndEvent(tenant: TenantFixture): Promise<{ taskId: string; eventId: string }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const tasks = await moduleDatabase(client, "tasks");
    const events = await moduleDatabase(client, "events");
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

/** A multi_select of a schema-locked system database. */
async function healthTagsPropertyId(tenant: TenantFixture): Promise<string> {
  const databaseId = await databaseIdFor(tenant.tenantId, "healthRecords");
  const property = await runInTenant(tenant.tenantId, () =>
    createChokePoint(pool).getPropertyByKey(databaseId, "tags"),
  );
  if (!property) throw new Error(`no Health records 'tags' property in tenant ${tenant.tenantId}`);
  return property.id;
}

/**
 * Created per case, so the case writes its own rows and leaves the shared fixture rows as they are.
 */
async function caseOptionPropertyId(tenant: TenantFixture, databaseName: string): Promise<string> {
  const databaseId = readString(await sendOk(tenant.member, POST("/api/databases", { name: databaseName })), "id");
  return readString(
    await sendOk(
      tenant.member,
      POST(`/api/databases/${databaseId}/properties`, {
        key: "choice",
        name: "Choice",
        type: "multi_select",
        config: { options: [{ key: "one", label: "One" }] },
      }),
    ),
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

async function storedOptions(tenant: TenantFixture, propertyId: string): Promise<StoredOption[]> {
  const text = await sendOk(tenant.member, GET(`/api/properties/${propertyId}`));
  return storedOptionsBody.parse(JSON.parse(text)).config.options;
}

/** Exactly as the seed stores it: a color and no label. */
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

/** No other case writes a task of this name. */
const ACTION_ITEM_TASK_NAME = "Send the revised offer";

/**
 * An Event and a linked transcript whose stored notes hold one action item without an owner. The
 * shared fixture rows are not touched.
 */
async function seedActionItemWorld(tenant: TenantFixture): Promise<ActionItemWorld> {
  const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
    const transcripts = await moduleDatabase(client, "transcripts");
    const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Offer" } });
    // Notes only the transcription process writes.
    await writeComputed(client, transcripts.id, item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, {
      title: "Offer",
      summary: "",
      shortSummary: "",
      decisions: [],
      actionItems: [{ text: ACTION_ITEM_TASK_NAME, ownerSpeaker: null, due: "2026-10-23", startsAt: null }],
    });
    return item.id;
  });
  const eventId = await createItemAs(tenant, "events", { name: "Offer meeting", date: "2026-10-16" });
  await sendOk(tenant.member, PUT(`/api/items/${transcriptId}/relations/event/${eventId}`, {}));
  return { eventId, transcriptId };
}

/**
 * A transcript with speaker SPEAKER_00, an Event it is linked to and a person who participates in
 * that Event. The shared fixture rows are not touched.
 */
async function seedSpeakerWorld(tenant: TenantFixture): Promise<SpeakerWorld> {
  const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
    const transcripts = await moduleDatabase(client, "transcripts");
    const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Speakers" } });
    // Segments only the transcription process writes.
    await writeComputed(client, transcripts.id, item.id, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, [
      { speaker: "SPEAKER_00", text: "Welcome to the speaker probe.", startsAt: 0, endsAt: 2 },
    ]);
    return item.id;
  });
  const create = (moduleId: string, properties: Record<string, unknown>) => createItemAs(tenant, moduleId, properties);
  const eventId = await create("events", { name: "Speaker probe", date: "2026-10-16" });
  const personId = await create("people", { name: "Speaker probe person" });
  await sendOk(tenant.member, PUT(`/api/items/${eventId}/relations/people/${personId}`, {}));
  await sendOk(tenant.member, PUT(`/api/items/${transcriptId}/relations/event/${eventId}`, {}));
  return { eventId, transcriptId, personId };
}

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

/**
 * Its metadata job is queued by the refresh route; `runCoverCandidateJobs` stores one candidate
 * whose image URL names the item.
 */
async function seedCoverCandidateItem(tenant: TenantFixture): Promise<{ itemId: string; imageUrl: string }> {
  const itemId = await createItemAs(tenant, "books", { name: "Candidate probe" });
  await sendOk(tenant.member, POST(`/api/items/${itemId}/cover-candidates/refresh`, {}));
  return { itemId, imageUrl: `https://covers.example.test/${itemId}.jpg` };
}

/** The fetcher finds every item and offers one candidate named by its id. */
async function runCoverCandidateJobs(): Promise<void> {
  const tasks = createCoreTaskList(pool, createActionRegistry(), async (item) => ({
    status: "found",
    source: "openLibrary",
    candidates: [{ title: `Candidate of ${item.id}`, coverUrl: `https://covers.example.test/${item.id}.jpg` }],
  }));
  const task = tasks[CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS];
  if (!task) throw new Error("Missing library metadata task");
  await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: task } });
}

async function coverCandidateState(
  tenant: TenantFixture,
  itemId: string,
): Promise<{ status: string; imageUrls: string[] }> {
  return inTenantTransaction(tenant.tenantId, async (client) => {
    const status = await client.query<{ status: string }>("SELECT status FROM item_automation WHERE item_id = $1", [
      itemId,
    ]);
    const urls = await client.query<{ image_url: string }>(
      "SELECT image_url FROM library_cover_candidates WHERE item_id = $1 ORDER BY idx",
      [itemId],
    );
    return { status: status.rows[0]?.status ?? "none", imageUrls: urls.rows.map((row) => row.image_url) };
  });
}

/** One active permission finding on the tenant's project, written through the findings store. */
async function seedDriftFinding(fixture: TenantFixture): Promise<string> {
  const subject = { operation: "items.delete", databaseId: null };
  const { finding } = await inTenantTransaction(fixture.tenantId, (client) =>
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
  );
  return finding.id;
}

/** Every graphile-worker job, read as the superuser so it sees every tenant's. */
async function workerJobs(): Promise<Array<{ id: string; key: string | null }>> {
  return (
    await adminPool.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id")
  ).rows;
}

/** One agents problem on the tenant's heartbeat, raised for its member. */
async function raiseAgentsProblem(
  fixture: TenantFixture,
  kind: "agentHeartbeat" | "processStale",
  severity: "warning" | "critical",
  dedupe: string,
): Promise<string> {
  const result = await inTenantTransaction(fixture.tenantId, (client) =>
    raiseProblem(client, {
      userId: fixture.member.userId,
      category: "agents",
      kind,
      severity,
      sourceTable: "project_heartbeats",
      sourceId: fixture.heartbeatId,
      dedupeKey: `agents:${dedupe}:${fixture.heartbeatId}`,
    }),
  );
  return result.problemId;
}

const threadDetailFlag =
  (field: "unread" | "flagged") =>
  async (caller: Caller, threadId: string): Promise<boolean> =>
    z
      .boolean()
      .parse(
        z.record(z.string(), z.unknown()).parse(JSON.parse(await sendOk(caller, GET(`/api/mail/threads/${threadId}`))))[
          field
        ],
      );

const threadInInbox = async (caller: Caller, threadId: string): Promise<boolean> =>
  (await inboxThreadIds(caller)).includes(threadId);

/**
 * B's `action` on its own thread answers `result` and turns `state` from `before` to its opposite.
 * On A's thread it answers like a random id and leaves A's state as it was; A's own action then
 * answers `result` and changes A's state.
 */
async function expectMailThreadAction(options: {
  action: string;
  body?: unknown;
  prepare?: (fixture: TenantFixture, threadId: string) => Promise<void>;
  state: (caller: Caller, threadId: string) => Promise<boolean>;
  before: boolean;
  result: Record<string, unknown>;
}): Promise<void> {
  const seed = async (fixture: TenantFixture) => {
    const threadId = await seedMailThread(
      fixture,
      `<${randomUUID()}@example.test>`,
      `${options.action}-${randomUUID()}`,
      `thread-${randomUUID()}`,
    );
    await options.prepare?.(fixture, threadId);
    return threadId;
  };
  const foreign = await seed(a);
  const own = await seed(b);
  const request = (id: string): Request => POST(`/api/mail/threads/${id}/${options.action}`, options.body);
  expect(await options.state(a.member, foreign)).toBe(options.before);
  expect(await options.state(b.member, own)).toBe(options.before);

  const answer = await expectExcludesA(b.member, request(own), [own]);
  expect(JSON.parse(answer.text)).toEqual({ threadId: own, ...options.result });
  expect(await options.state(b.member, own)).toBe(!options.before);

  await expectForeign404(b.member, [foreign], ([id]) => request(id!));
  expect(await options.state(a.member, foreign)).toBe(options.before);

  const ownerAnswer = await send(a.member, request(foreign));
  expect({ status: ownerAnswer.status, body: JSON.parse(ownerAnswer.text) }).toEqual({
    status: 200,
    body: { threadId: foreign, ...options.result },
  });
  expect(await options.state(a.member, foreign)).toBe(!options.before);
}

const ROUTE_CASES: Record<string, RouteCase> = {
  "project guidance read": async () => {
    const own = await sendOk(b.member, GET(`/api/projects/${b.projectItemId}/agent-guidance`));
    expect(own).toContain('"sections"');
    await expectForeign404(b.member, [a.projectItemId], ([id]) => GET(`/api/projects/${id}/agent-guidance`));
  },
  "project guidance save": () =>
    leavesAUnchanged(async () => {
      const body = {
        sections: { purpose: "Isolation", allowed: "", notAllowed: "", generalInstructions: "" },
        expectedUpdatedAt: null,
      };
      const own = await sendOk(b.member, PUT(`/api/projects/${b.projectItemId}/agent-guidance`, body));
      expect(own).toContain("Isolation");
      await expectForeign404(b.member, [a.projectItemId], ([id]) => PUT(`/api/projects/${id}/agent-guidance`, body));
    }),
  // Each tenant's project gets one active finding through the findings store; B's list must show
  // only its own, and A's project id must answer exactly like a random id.
  "project guidance drift read": async () => {
    const findingIds = [await seedDriftFinding(a), await seedDriftFinding(b)];
    // A project lists its findings only once it has guidance, so B saves guidance first, against
    // its current version (an earlier case may already have saved one).
    const current: unknown = JSON.parse(await sendOk(b.member, GET(`/api/projects/${b.projectItemId}/agent-guidance`)));
    const expectedUpdatedAt = isRecord(current) && typeof current.updatedAt === "string" ? current.updatedAt : null;
    await sendOk(
      b.member,
      PUT(`/api/projects/${b.projectItemId}/agent-guidance`, {
        sections: { purpose: "Drift", allowed: "", notAllowed: "", generalInstructions: "" },
        expectedUpdatedAt,
      }),
    );
    const own = await sendOk(b.member, GET(`/api/projects/${b.projectItemId}/agent-guidance/drift`));
    expect(own).toContain(findingIds[1]);
    expect(own).not.toContain(findingIds[0]);
    const result = await expectForeign404(b.member, [a.projectItemId], ([id]) =>
      GET(`/api/projects/${id}/agent-guidance/drift`),
    );
    expect(result.text).not.toContain(findingIds[0]);
  },
  "guidance drift resolve": async () => {
    const findingId = await seedDriftFinding(a);
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
            [findingId],
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
            [findingId],
          )
        ).rows,
      }));
    const before = await state();
    const jobs = await workerJobs();
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await expectForeign404(b.member, [findingId], ([id]) =>
        POST(`/api/agent-guidance-drift/${id}/resolve`, { choice: "dismiss", expectedGuidanceUpdatedAt: null }),
      );
    } finally {
      setInvalidationHook(() => {});
    }
    expect(await state()).toEqual(before);
    expect(await workerJobs()).toEqual(jobs);
    expect(events).toEqual([]);
  },
  "server identity": async () => {
    const answer = await send(null, GET("/api/server-info"));
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"product":"semprec"}');
    expectNoneOf(answer.text, a.ids, "server identity");
    const refused = await send(null, POST("/api/server-info"));
    expect(refused.status).toBe(404);
  },
  // --- anonymous ---------------------------------------------------------------------------
  "shallow health check": async () => {
    // No `api` heartbeat runs here, so the probe answers 503; either way it names nothing of A.
    const answer = await send(null, GET("/healthz"));
    expectNoneOf(answer.text, a.ids, "healthz");
  },
  login: () =>
    expectAEmailLikeUnknown((email) => POST("/api/auth/login", { email, password: "wrong-password", platform: "ios" })),
  "password-reset request": () =>
    expectAEmailLikeUnknown((email) => POST("/api/auth/password-reset/request", { email })),
  "password-reset consume": async () => {
    await leavesAUnchanged(async () => {
      await expectForeignLikeRandom(null, [a.member.token], ([token]) =>
        POST("/api/auth/password-reset/consume", { token, newPassword: `pw-${randomUUID()}` }),
      );
    });
  },
  "first-account setup (API)": () =>
    expectAEmailLikeUnknown((email) => ({
      ...POST("/api/setup", { email, password: "setup-password" }),
      headers: { Authorization: `Bearer ${SETUP_TOKEN}` },
    })),
  "accept invitation": async () => {
    // A revoked invitation's token stands in for a foreign one; no tenant may be created by either
    // request.
    const revokedToken = await revokedInvitationToken(a.member.userId);
    const tenantsBefore = await tenantCount();
    await expectForeignLikeRandom(null, [revokedToken], ([token]) =>
      POST("/api/invitations/accept", { token, password: "accepted-password" }),
    );
    expect(await tenantCount()).toBe(tenantsBefore);
  },
  "Microsoft Graph mail webhook": async () => {
    await expectForeignLikeRandom(null, [a.graphSubscriptionId], ([subscriptionId]) =>
      POST("/api/mail/graph/webhook", {
        value: [{ subscriptionId, clientState: "not-the-client-state", changeType: "updated" }],
      }),
    );
  },

  // --- account -----------------------------------------------------------------------------
  logout: async () => {
    const throwaway = await signIn(b.member.email, b.member.password, "ios");
    const answer = await send(throwaway, POST("/api/auth/logout", {}));
    expect(answer.status).toBe(200);
    expectNoneOf(answer.text, a.ids, "logout");
    await expectAAccountActive();
  },
  "list sessions": async () => {
    const own = await send(b.member, GET("/api/auth/sessions"));
    expect(own.status).toBe(200);
    expect(own.text).toContain(b.member.sessionId);
    expectNoneOf(own.text, [a.member.sessionId, a.secondSession.sessionId], "list sessions");
    await expectAAccountActive();
  },
  "revoke session": async () => {
    await expectForeignLikeRandom(b.member, [a.secondSession.sessionId], ([id]) =>
      POST(entryPath("revoke session", id!), {}),
    );
    await expectAAccountActive();
  },
  "revoke other sessions": async () => {
    // A member of a third tenant calls it: B's own sessions are fixtures the cases after this one use.
    const caller = await signUp(await createTestTenant(adminPool), "member");
    const second = await signIn(caller.email, caller.password, "ios");
    const answer = await send(caller, POST("/api/auth/sessions/revoke-others", {}));
    expect(answer.status, answer.text).toBe(200);
    expect(answer.text).toBe(JSON.stringify({ revokedCount: 1 }));
    expect((await send(second, GET("/api/auth/session"))).status).toBe(401);
    expectNoneOf(answer.text, a.ids, "revoke other sessions");
    await expectAAccountActive();
  },
  "set self person": async () => {
    const person = async (fixture: TenantFixture) =>
      inTenantTransaction(fixture.tenantId, async (client) => {
        const people = await moduleDatabase(client, "people");
        return createItemWithClient(client, { databaseId: people.id, properties: { name: "Self" } });
      });
    const ownA = await person(a);
    const ownB = await person(b);
    const set = (personId: string | null): Request => PUT("/api/auth/self-person", { personId });
    expect((await send(a.member, set(ownA.id))).status).toBe(200);
    const foreign = await send(b.member, set(ownA.id));
    const missing = await send(b.member, set(randomUUID()));
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(missing);
    expect((await send(b.member, set(ownB.id))).status).toBe(200);
    const sessionB = await send(b.member, GET("/api/auth/session"));
    expect(readString(sessionB.text, "user", "personId")).toBe(ownB.id);
    const sessionA = await send(a.member, GET("/api/auth/session"));
    expect(readString(sessionA.text, "user", "personId")).toBe(ownA.id);
  },
  "current session": async () => {
    for (const session of [b.member, b.webSession]) {
      const answer = await expectExcludesA(session, GET("/api/auth/session"));
      expect(answer.status).toBe(200);
    }
    await expectAAccountActive();
  },
  "change password": async () => {
    // A member of a third tenant calls it: B's password and sessions are fixtures the cases after this one use.
    const caller = await signUp(await createTestTenant(adminPool), "member");
    const second = await signIn(caller.email, caller.password, "ios");
    // Global identity tables, read in the system scope the route uses.
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
    const change = (currentPassword: string): Request =>
      POST("/api/auth/password-change", { currentPassword, newPassword });

    // A's real password is a wrong current password for the caller.
    const refused = await expectForeignLikeRandom(caller, [a.member.password], ([password]) => change(password!));
    expect(refused.status).toBe(403);
    expect((await send(second, GET("/api/auth/session"))).status).toBe(200);

    const answer = await send(caller, change(caller.password));
    expect(answer.status, answer.text).toBe(200);
    expect(answer.text).toBe(JSON.stringify({ ok: true }));
    expectNoneOf(answer.text, a.ids, "change password");
    expect((await send(caller, GET("/api/auth/session"))).status).toBe(200);
    expect((await send(second, GET("/api/auth/session"))).status).toBe(401);

    await expectAAccountActive();
    for (const session of [b.member, b.secondSession, b.webSession]) {
      expect((await send(session, GET("/api/auth/session"))).status).toBe(200);
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
    const register = (deviceToken: string): Request =>
      POST("/api/push-subscriptions", { channel: "apns", platform: "ios", deviceToken, apnsEnvironment: "sandbox" });
    try {
      const foreign = await expectExcludesA(b.member, register(a.pushDeviceToken));
      const random = await send(b.member, register(randomBytes(32).toString("hex")));
      expect(foreign.status).toBe(random.status);
      expect(foreign.status).toBe(200);
      // Push device tokens are deliberately global identity-plane keys: registering the same
      // physical device moves it to the caller, as `upsertApnsSubscription` specifies. This differs
      // from revoking a foreign row id.
      const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
      expect(subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId)?.revokedAt).toEqual(
        expect.any(String),
      );
    } finally {
      // Re-register A's device so later cases start from an active subscription.
      const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
      if (subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId)?.revokedAt !== null) {
        a.pushSubscriptionId = readString(await sendOk(a.member, register(a.pushDeviceToken)), "subscription", "id");
        a.ids.push(a.pushSubscriptionId);
      }
    }
    await expectAAccountActive();
  },
  "revoke push subscription": async () => {
    await expectForeignLikeRandom(b.member, [a.pushSubscriptionId], ([id]) =>
      POST(entryPath("revoke push subscription", id!), {}),
    );
    await expectAAccountActive();
  },

  // --- tenant: notifications, reports, inbox, transcription --------------------------------
  "unread notifications": async () => {
    await expectExcludesA(b.member, GET("/api/notifications/unread"), [b.notificationId]);
  },
  "resolved notifications": async () => {
    const ids: string[] = [];
    for (const fixture of [a, b]) {
      const id = await inTenantTransaction(fixture.tenantId, async (client) => {
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
      });
      ids.push(id);
    }
    const answer = await expectExcludesA(b.member, GET("/api/notifications/resolved?since=2020-01-01T00%3A00%3A00Z"), [
      ids[1]!,
    ]);
    expect(answer.text).not.toContain(ids[0]);
  },
  "visit notification": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.notificationId], ([id]) => POST(`/api/notifications/${id}/visit`, {}));
    }),
  "mark all notifications read": () =>
    leavesAUnchanged(async () => {
      await expectExcludesA(b.member, POST("/api/notifications/mark-all-read", {}), [b.notificationId]);
    }),
  // Preferences hold no ids, so these cases compare values: A stores non-default values, and B must
  // read its own defaults and change only its own row.
  "get notification preferences": async () => {
    await sendOk(a.member, PATCH("/api/notification-preferences", { badgeInbox: true }));
    try {
      expect(JSON.parse(await sendOk(a.member, GET("/api/notification-preferences")))).toMatchObject({
        badgeInbox: true,
      });
      const foreign = await expectExcludesA(b.member, GET("/api/notification-preferences"));
      expect(JSON.parse(foreign.text)).toMatchObject({ approvals: true, badgeInbox: false });
    } finally {
      await sendOk(a.member, PATCH("/api/notification-preferences", { badgeInbox: false }));
    }
  },
  "patch notification preferences": async () => {
    const aBefore = await sendOk(a.member, GET("/api/notification-preferences"));
    try {
      expect(
        JSON.parse(
          await sendOk(b.member, PATCH("/api/notification-preferences", { approvals: false, badgeApprovals: false })),
        ),
      ).toMatchObject({ approvals: false, badgeApprovals: false });
      expect(await sendOk(a.member, GET("/api/notification-preferences"))).toEqual(aBefore);
    } finally {
      await sendOk(b.member, PATCH("/api/notification-preferences", { approvals: true, badgeApprovals: true }));
    }
  },
  // The lookup is tenant-scoped and a refused trigger writes nothing.
  "trigger heartbeat": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.heartbeatId], ([id]) => POST(entryPath("trigger heartbeat", id!), {}));
    }),
  "set heartbeat enabled": () =>
    leavesAUnchanged(async () => {
      await expectForeign404(b.member, [a.heartbeatId], ([id]) =>
        PATCH(entryPath("set heartbeat enabled", id!), { enabled: false }),
      );
    }),
  "schema projection": async () => {
    await expectExcludesA(b.member, GET("/api/schema"));
  },
  // A has no AI budget row, so A's status lists `aiBudgetMissing`; B's status must carry neither
  // A's stored problem nor A's budget problem.
  "semp status": async () => {
    await setTenantAiBudget(adminPool, b.tenantId);
    const ids = [
      await raiseAgentsProblem(a, "agentHeartbeat", "warning", "heartbeat"),
      await raiseAgentsProblem(b, "agentHeartbeat", "warning", "heartbeat"),
    ];
    const answer = await expectExcludesA(b.member, GET("/api/semp-status"), [ids[1]!]);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.text).not.toContain(ids[0]);
    expect(answer.text).not.toContain("aiBudget");
    expect(await sendOk(a.member, GET("/api/semp-status"))).toContain('"id":"aiBudgetMissing"');
  },
  // Each tenant gets one critical agents problem. B has an AI budget row and A has none, so A's
  // missing budget must not become B's banner.
  "semp status summary": async () => {
    await setTenantAiBudget(adminPool, b.tenantId);
    const ids = [
      await raiseAgentsProblem(a, "processStale", "critical", "summary"),
      await raiseAgentsProblem(b, "processStale", "critical", "summary"),
    ];
    const answer = await expectExcludesA(b.member, GET("/api/semp-status/summary"), [ids[1]!]);
    expect(answer.text).not.toContain(ids[0]);
    expect(JSON.parse(answer.text)).toMatchObject({ banner: { problemId: ids[1], instanceId: ids[1] } });
  },
  "ai usage report": async () => {
    await expectExcludesA(b.member, GET("/api/ai-usage?from=2026-01-01&to=2026-12-31"));
  },
  // A's spend goes through the gateway's accounting writer; B has no spend, so its figures stay at
  // zero.
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
    const answer = await expectExcludesA(b.member, GET("/api/ai-usage/summary"));
    expect(JSON.parse(answer.text)).toMatchObject({ spentTodayUsd: 0, spentMonthUsd: 0 });
  },
  "system health report": async () => {
    await expectExcludesA(b.member, GET("/api/system-health"));
  },
  // Both answers are the 404 of an unknown mailbox.
  "mail contacts": async () => {
    async function person(tenantId: string, email: string) {
      return inTenantTransaction(tenantId, async (client) => {
        const db = await moduleDatabase(client, "people");
        return createItemWithClient(client, { databaseId: db.id, properties: { name: "Contact", emails: email } });
      });
    }
    const foreign = await person(a.tenantId, "foreign-contact@example.com");
    const own = await person(b.tenantId, "own-contact@example.com");
    const answer = await expectExcludesA(b.member, GET("/api/mail/contacts?q=contact"), [own.id]);
    expectText(answer.text, [], [foreign.id, "foreign-contact@example.com"]);
  },
  "mail threads": async () => {
    const seed = (fixture: TenantFixture) => seedMailThread(fixture, `<${fixture.tenantId}@example.test>`);
    const first = await seed(a);
    const second = await seed(b);
    // Each thread has a project and a company of its own tenant with a value link: B's list carries
    // only B's.
    const foreignValues = await seedThreadProjectAndCompany(a, first, `list-${randomUUID()}`);
    const ownValues = await seedThreadProjectAndCompany(b, second, `list-${randomUUID()}`);
    const answer = await expectExcludesA(b.member, GET("/api/mail/threads"), [second]);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expectText(answer.text, [...Object.values(ownValues)], [first, ...Object.values(foreignValues)]);
  },
  "mail thread detail": async () => {
    // Each attachment's file has a project of its own tenant.
    const foreignFile = `foreign-${randomUUID()}.pdf`;
    const ownFile = `own-${randomUUID()}.pdf`;
    const foreign = await seedMailThread(
      a,
      `<${randomUUID()}@example.test>`,
      `detail-${randomUUID()}`,
      `thread-${randomUUID()}`,
      [foreignFile],
    );
    const own = await seedMailThread(
      b,
      `<${randomUUID()}@example.test>`,
      `detail-${randomUUID()}`,
      `thread-${randomUUID()}`,
      [ownFile],
    );
    const foreignFileProject = await seedAttachmentProject(a, foreign, foreignFile, `detail-${randomUUID()}`);
    const ownFileProject = await seedAttachmentProject(b, own, ownFile, `detail-${randomUUID()}`);
    const foreignTask = await seedThreadTask(a, foreign);
    const ownTask = await seedThreadTask(b, own);
    const foreignValues = await seedThreadProjectAndCompany(a, foreign, `detail-${randomUUID()}`);
    const ownValues = await seedThreadProjectAndCompany(b, own, `detail-${randomUUID()}`);
    const answer = await expectExcludesA(b.member, GET(`/api/mail/threads/${own}`), [own, ownTask]);
    expectText(
      answer.text,
      [...Object.values(ownValues), ownFile, ownFileProject, "inheritedBroken"],
      [foreign, foreignTask, ...Object.values(foreignValues), foreignFile, foreignFileProject],
    );
    const result = await expectForeign404(b.member, [foreign], ([id]) => GET(`/api/mail/threads/${id}`));
    expectText(result.text, [], [foreignTask, foreignFile, foreignFileProject, ...Object.values(foreignValues)]);
    const owner = await send(a.member, GET(`/api/mail/threads/${foreign}`));
    expect(owner.status).toBe(200);
    expectText(
      owner.text,
      [foreignTask, ...Object.values(foreignValues), foreignFile, foreignFileProject],
      [ownTask, ownFile, ownFileProject],
    );
  },
  "mail draft create": async () => {
    const ofA = await mailboxForDrafts(a);
    const ofB = await mailboxForDrafts(b);
    const create = (mailboxId: string | undefined): Request =>
      POST("/api/mail/drafts", draftBody(mailboxId ?? "", "Isolation draft"));
    await leavesAUnchanged(async () => {
      const own = await expectExcludesA(b.member, create(ofB), [ofB]);
      expectNoneOf(own.text, [ofA], "B's new draft");
      await expectForeign404(b.member, [ofA], ([id]) => create(id));
    });
    expect(await sendOk(a.member, create(ofA))).toContain(ofA);
  },
  "mail draft read": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    const read = (id: string | undefined): Request => GET(`/api/mail/drafts/${id}`);
    const answer = await expectExcludesA(b.member, read(own.draftId), [own.draftId, own.mailboxId]);
    expectNoneOf(answer.text, [foreign.draftId, foreign.mailboxId], "B's draft");
    await expectForeign404(b.member, [foreign.draftId], ([id]) => read(id));
    expect(await sendOk(a.member, read(foreign.draftId))).toContain(foreign.mailboxId);
  },
  "mail draft update": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    const update = (id: string | undefined, version: string): Request =>
      PATCH(`/api/mail/drafts/${id}`, { ifVersion: version, subject: "Changed by the isolation test" });
    const readOfA = () => sendOk(a.member, GET(`/api/mail/drafts/${foreign.draftId}`));
    const before = await readOfA();
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.draftId], ([id]) => update(id, foreign.version));
    });
    expect(await readOfA()).toBe(before);
    const answer = await expectExcludesA(b.member, update(own.draftId, own.version), [own.draftId]);
    expect(readString(answer.text, "subject")).toBe("Changed by the isolation test");
    const owner = await send(a.member, update(foreign.draftId, foreign.version));
    expect(owner.status).toBe(200);
  },
  "mail draft discard": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    const discard = (id: string | undefined): Request => DELETE(`/api/mail/drafts/${id}`);
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.draftId], ([id]) => discard(id));
    });
    expect(await sendOk(a.member, GET(`/api/mail/drafts/${foreign.draftId}`))).toContain(foreign.mailboxId);
    const discarded = await send(b.member, discard(own.draftId));
    expect({ status: discarded.status, body: JSON.parse(discarded.text) }).toEqual({
      status: 200,
      body: { id: own.draftId },
    });
    const again = await send(b.member, discard(own.draftId));
    expect(again.status).toBe(404);
  },
  // A's draft stays unsent and no transport is asked to deliver it; A sends its own afterwards.
  "mail draft send": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    await addSentFolder(a, foreign.mailboxId);
    await addSentFolder(b, own.mailboxId);
    const sendRequest = (id: string | undefined): Request => POST(`/api/mail/drafts/${id}/send`);
    const readOfA = () => sendOk(a.member, GET(`/api/mail/drafts/${foreign.draftId}`));
    const before = await readOfA();
    const deliveredBefore = deliveredMail.length;

    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.draftId], ([id]) => sendRequest(id));
    });
    expect(await readOfA()).toBe(before);
    expect(deliveredMail).toHaveLength(deliveredBefore);

    const answer = await expectExcludesA(b.member, sendRequest(own.draftId), [own.draftId, own.mailboxId]);
    expect(JSON.parse(answer.text)).toMatchObject({ emailId: own.draftId, mailbox: { id: own.mailboxId } });
    expect(deliveredMail).toHaveLength(deliveredBefore + 1);
    expect(deliveredMail.at(-1)?.raw.toString("utf8")).toContain(`Draft of ${b.tenantId}`);

    const owner = await send(a.member, sendRequest(foreign.draftId));
    expect(owner.status).toBe(200);
    expect(JSON.parse(owner.text)).toMatchObject({ emailId: foreign.draftId, mailbox: { id: foreign.mailboxId } });
    expect(deliveredMail.at(-1)?.raw.toString("utf8")).toContain(`Draft of ${a.tenantId}`);
  },
  // A's draft lists nothing and A's file stays free for A to attach.
  "mail draft attachment add": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    const foreignFile = await uploadAttachableFile(a);
    const ownFile = await uploadAttachableFile(b);
    const add = (draftId: string | undefined, fileItemId: string | undefined): Request =>
      POST(`/api/mail/drafts/${draftId}/attachments`, { fileItemId });
    const readOfA = () => sendOk(a.member, GET(`/api/mail/drafts/${foreign.draftId}`));
    const before = await readOfA();

    const answer = await expectExcludesA(b.member, add(own.draftId, ownFile), [own.draftId, ownFile]);
    expect(JSON.parse(answer.text)).toMatchObject({ id: own.draftId, attachments: [{ fileItemId: ownFile }] });
    await expectForeign404(b.member, [foreignFile], ([id]) => add(own.draftId, id));
    await expectForeign404(b.member, [foreign.draftId], ([id]) => add(id, ownFile));

    expect(await readOfA()).toBe(before);
    const owner = await send(a.member, add(foreign.draftId, foreignFile));
    expect(owner.status).toBe(200);
    expect(JSON.parse(owner.text)).toMatchObject({ id: foreign.draftId, attachments: [{ fileItemId: foreignFile }] });
  },
  "mail draft attachment remove": async () => {
    const foreign = await seedDraft(a);
    const own = await seedDraft(b);
    const foreignFile = await uploadAttachableFile(a);
    const ownFile = await uploadAttachableFile(b);
    const attach = (member: Member, draftId: string, fileItemId: string) =>
      sendOk(member, POST(`/api/mail/drafts/${draftId}/attachments`, { fileItemId }));
    await attach(a.member, foreign.draftId, foreignFile);
    await attach(b.member, own.draftId, ownFile);
    const remove = (draftId: string | undefined, fileItemId: string | undefined): Request =>
      DELETE(`/api/mail/drafts/${draftId}/attachments/${fileItemId}`);
    const readOfA = () => sendOk(a.member, GET(`/api/mail/drafts/${foreign.draftId}`));
    const before = await readOfA();
    expect(before).toContain(foreignFile);

    await expectForeign404(b.member, [foreign.draftId, foreignFile], ([draftId, fileId]) => remove(draftId, fileId));
    expect(await readOfA()).toBe(before);

    const answer = await expectExcludesA(b.member, remove(own.draftId, ownFile), [own.draftId]);
    expect(JSON.parse(answer.text)).toMatchObject({ id: own.draftId, attachments: [] });
    const owner = await send(a.member, remove(foreign.draftId, foreignFile));
    expect(owner.status).toBe(200);
    expect(JSON.parse(owner.text)).toMatchObject({ id: foreign.draftId, attachments: [] });
  },
  // A reads its thread unread before and after, then marks it read itself.
  "mail thread read": () =>
    expectMailThreadAction({
      action: "read",
      body: { read: true },
      state: threadDetailFlag("unread"),
      before: true,
      result: { unread: false },
    }),
  // A's thread gets no model call and no task; A then creates a task itself.
  "mail thread task create": async () => {
    const seed = (fixture: TenantFixture) =>
      seedMailThread(fixture, `<${randomUUID()}@example.test>`, `task-${randomUUID()}`, `thread-${randomUUID()}`);
    const foreign = await seed(a);
    const own = await seed(b);
    const create = (id: string, body: Record<string, unknown>): Request => POST(`/api/mail/threads/${id}/tasks`, body);
    const tasksOf = async (caller: Caller, id: string): Promise<string[]> =>
      readIdArray(await sendOk(caller, GET(`/api/mail/threads/${id}`)), "tasks");
    threadTaskGatewayCalls.length = 0;

    await leavesAUnchanged(async () => {
      const named = await expectExcludesA(b.member, create(own, { name: "Own task", date: "2026-12-01" }));
      expect(JSON.parse(named.text)).toEqual({ id: expect.any(String), name: "Own task", date: "2026-12-01" });
      expect(threadTaskGatewayCalls).toHaveLength(0);
      const generated = await expectExcludesA(b.member, create(own, {}));
      expect(JSON.parse(generated.text)).toEqual({ id: expect.any(String), name: THREAD_TASK_AI_NAME, date: null });
      expect(threadTaskGatewayCalls).toHaveLength(1);
      expect(await tasksOf(b.member, own)).toHaveLength(2);

      for (const body of [{}, { name: "Foreign task" }]) {
        await expectForeign404(b.member, [foreign], ([id]) => create(id!, body));
      }
      expect(threadTaskGatewayCalls).toHaveLength(1);
    });

    expect(await tasksOf(a.member, foreign)).toEqual([]);
    const owner = await send(a.member, create(foreign, { name: "A's task" }));
    expect(owner.status).toBe(201);
    expect(await tasksOf(a.member, foreign)).toEqual([readString(owner.text, "id")]);
  },
  "mail thread flag": () =>
    expectMailThreadAction({
      action: "flag",
      body: { flagged: true },
      state: threadDetailFlag("flagged"),
      before: false,
      result: { flagged: true },
    }),
  // A's threads stay in A's Inbox; A then archives and trashes them itself.
  "mail thread archive": () =>
    expectMailThreadAction({ action: "archive", state: threadInInbox, before: true, result: { moved: 1 } }),
  "mail thread trash": () =>
    expectMailThreadAction({
      action: "trash",
      prepare: (fixture, threadId) => addFolderToThreadMailbox(fixture, threadId, "TRASH", "trash"),
      state: threadInInbox,
      before: true,
      result: { moved: 1 },
    }),
  // A's archived thread stays in A's Archive; A then restores it itself.
  "mail thread restore": () =>
    expectMailThreadAction({
      action: "restore",
      prepare: async (fixture, threadId) => {
        expect((await send(fixture.member, POST(`/api/mail/threads/${threadId}/archive`))).status).toBe(200);
      },
      state: threadInInbox,
      before: false,
      result: { moved: 1 },
    }),
  // The grant has no writer by design: both tenants' projects get `emailSendAutonomous` by SQL, as
  // the server operator would set it.
  "mail autonomous send projects": async () => {
    for (const fixture of [a, b]) {
      await inTenantTransaction(fixture.tenantId, (client) =>
        client.query(
          "UPDATE items SET properties = properties || '{\"emailSendAutonomous\": true}'::jsonb WHERE tenant_id = app_tenant_default() AND id = $1",
          [fixture.projectItemId],
        ),
      );
    }
    const answer = await expectExcludesA(b.member, GET("/api/mail/autonomous-send-projects"), [b.projectItemId]);
    expect(answer.text).not.toContain(a.projectItemId);
    const mailboxes = await expectExcludesA(b.member, GET("/api/mail/mailboxes"), [b.mailboxItemId]);
    expect(mailboxes.text).toContain('"autonomousSendProjectCount":1');
  },
  "mailbox list": async () => {
    await expectExcludesA(b.member, GET("/api/mail/mailboxes"), [b.mailboxItemId]);
  },
  "mailbox detail": async () => {
    const own = await send(b.member, GET(`/api/mail/mailboxes/${b.mailboxItemId}`));
    expect(own.status).toBe(200);
    await expectForeign404(b.member, [a.mailboxItemId], ([id]) => GET(`/api/mail/mailboxes/${id}`));
  },
  // An address A holds answers B exactly like an unused one. The same address a second time is
  // refused inside B, so the 201 is the duplicate rule's own answer.
  "mailbox password connect": async () => {
    const connect = (address: string, password = MAILBOX_PASSWORD): Request =>
      POST("/api/mail/mailboxes", {
        provider: "generic",
        address,
        password,
        imapHost: "imap.isolation.example.test",
        smtpHost: "smtp.isolation.example.test",
      });
    const unusedAddress = (): string => `${randomUUID()}@isolation.example.test`;
    const mailboxesOf = async (member: Member): Promise<string[]> =>
      readIdArray(await sendOk(member, GET("/api/mail/mailboxes")), "mailboxes");
    /** What two created mailboxes have in common. */
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

      const refused = await send(b.member, connect(unusedAddress(), REFUSED_MAILBOX_PASSWORD));
      expect(refused.status).toBe(400);
      expect(readString(refused.text, "error", "code")).toBe("mail_auth_failed");
      expect((await mailboxesOf(b.member)).filter((id) => !knownToB.includes(id)).sort()).toEqual(created);
    });
    expect(await mailboxesOf(a.member)).toContain(ofA);
    expect(await mailboxesOf(b.member)).not.toContain(ofA);
  },
  "mailbox removal impact": async () => {
    const own = await send(b.member, GET(entryPath("mailbox removal impact", b.mailboxItemId)));
    expect(own.status).toBe(200);
    expect(JSON.parse(own.text)).toEqual({ messages: 0, drafts: 0, threads: 0, attachmentsKept: 0 });
    await expectForeign404(b.member, [a.mailboxItemId], ([id]) => GET(entryPath("mailbox removal impact", id!)));
  },
  // An unread inbox thread arriving in A leaves B's counts as they were; one arriving in B raises
  // B's unread count by exactly one.
  "mail summary": async () => {
    const summaryOfB = async (ownIds: readonly string[] = []) => {
      const answer = await expectExcludesA(b.member, GET("/api/mail/summary"), ownIds);
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
  "mailbox folder list": async () => {
    const ofA = await mailboxWithInboxFolder(a);
    const ofB = await mailboxWithInboxFolder(b);
    const foldersOf = (mailboxId: string | undefined): Request => GET(`/api/mail/mailboxes/${mailboxId}/folders`);
    const own = await expectExcludesA(b.member, foldersOf(ofB.mailboxId), [ofB.folderId]);
    expectNoneOf(own.text, [ofA.mailboxId, ofA.folderId], "B's folder list");
    await expectForeign404(b.member, [ofA.mailboxId], ([id]) => foldersOf(id));
    expect(await sendOk(a.member, foldersOf(ofA.mailboxId))).toContain(ofA.folderId);
  },
  // A's mailbox gets no state for B; A then starts a reauthorization itself.
  "mailbox reauthorize": async () => {
    const ofA = await mailboxNeedingReauthorization(a);
    const ofB = await mailboxNeedingReauthorization(b);
    const reauthorize = (mailboxId: string | undefined): Request =>
      POST(`/api/mail/mailboxes/${mailboxId}/reauthorize`, {});
    const statesOfA = await mailOauthStates(a);
    const knownToB = (await mailOauthStates(b)).map((row) => row.id);
    await leavesAUnchanged(async () => {
      const own = await expectExcludesA(b.member, reauthorize(ofB));
      expectNoneOf(own.text, [ofA, ofB], "B's authorization URL");
      expect(new URL(readString(own.text, "authorizeUrl")).searchParams.get("state")).not.toBeNull();
      await expectForeign404(b.member, [ofA], ([id]) => reauthorize(id));
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
  // A's ids select for B what random ids select: no thread. The thread detail's pattern matches
  // this path too, so the facets body shows which route answered.
  "mail thread facets": async () => {
    const ofA = await mailThreadInProjectOfArea(a);
    const ofB = await mailThreadInProjectOfArea(b);
    const facets: Request = GET("/api/mail/threads/facets");
    const own = await expectExcludesA(b.member, facets, [ofB.areaId, ofB.projectId]);
    expectNoneOf(own.text, [ofA.areaId, ofA.projectId], "B's facets");
    const body = mailThreadFacetsBody.parse(JSON.parse(own.text));
    expect(body.areas.items).toContainEqual({ id: ofB.areaId, count: 1 });
    expect(body.projects.items).toContainEqual({ id: ofB.projectId, areaId: ofB.areaId, count: 1 });

    const narrowed = await expectForeignLikeRandom(b.member, [ofA.areaId, ofA.projectId], ([areaId, projectId]) =>
      GET(`/api/mail/threads/facets?areaId=${areaId}&projectId=${projectId}`),
    );
    expect(narrowed.status).toBe(200);
    const none = mailThreadFacetsBody.parse(JSON.parse(narrowed.text));
    expect({ areas: none.areas.total, projects: none.projects }).toEqual({
      areas: 0,
      projects: { total: 0, items: [] },
    });
    expect(await sendOk(a.member, facets)).toContain(ofA.projectId);
  },
  "mail oauth start": async () => {
    await startMailOauth(a.member);
    const statesOfA = await mailOauthStates(a);
    const knownToB = (await mailOauthStates(b)).map((row) => row.id);
    await leavesAUnchanged(async () => {
      await expectExcludesA(b.member, POST("/api/mail/mailboxes/oauth/start", { provider: "gmail" }));
    });
    expect(await mailOauthStates(a)).toEqual(statesOfA);
    const added = (await mailOauthStates(b)).filter((row) => !knownToB.includes(row.id));
    expect(added.map((row) => [row.user_id, row.used_at])).toEqual([[b.member.userId, null]]);
    expectNoneOf(JSON.stringify(added), a.ids, "B's new sign-in state");
  },
  // A itself gets past the state check with it (the fixture's provider then refuses the code).
  "mail oauth complete": async () => {
    const stateOfA = await startMailOauth(a.member);
    const complete = (state: string | undefined): Request =>
      POST("/api/mail/mailboxes/oauth/complete", { state, code: "isolation-code" });
    const mailboxesOfB = (): Promise<string[]> =>
      sendOk(b.member, GET("/api/mail/mailboxes")).then((text) => readIdArray(text, "mailboxes"));
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
  // The public callback only reads the redirect target of an open state, and A's state names none,
  // so it is handed on like a random value and stays unused.
  "mail oauth callback": async () => {
    const stateOfA = await startMailOauth(a.member);
    await leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(null, [stateOfA], ([state]) =>
        GET(`/api/mail/oauth/callback?code=isolation-code&state=${state}`),
      );
      expect(answer.status).toBe(200);
    });
    expect((await mailOauthStates(a, stateOfA)).map((row) => row.used_at)).toEqual([null]);
  },
  "mailbox removal": async () => {
    const foreign = await seedRemovableMailbox(a);
    const own = await seedRemovableMailbox(b);
    const connected = { trashed: false, credentials: 1, syncStates: 1, serverSettings: 1 };
    expect(await removableMailboxRows(a, foreign)).toEqual([connected]);
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign], ([id]) => DELETE(entryPath("mailbox removal", id!)));
    });
    expect(await removableMailboxRows(a, foreign)).toEqual([connected]);

    expect(await removableMailboxRows(b, own)).toEqual([connected]);
    const removed = await send(b.member, DELETE(entryPath("mailbox removal", own)));
    expect({ status: removed.status, body: removed.text }).toEqual({ status: 200, body: JSON.stringify({ id: own }) });
    expect(await removableMailboxRows(b, own)).toEqual([
      { trashed: true, credentials: 0, syncStates: 0, serverSettings: 0 },
    ]);
    const again = await send(b.member, DELETE(entryPath("mailbox removal", own)));
    expect(again.status).toBe(404);
  },
  "confirm proposal": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.proposalItemId], ([id]) => POST(`/api/proposals/${id}/confirm`, {}));
    }),
  "reject proposal": async () => {
    const card = await seedProposalCard(a);
    const cardOf = () => sendOk(a.member, GET(`/api/items/${card}`));
    const before = await cardOf();
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [card], ([id]) => POST(`/api/proposals/${id}/reject`, { message: "Not mine" }));
    });
    expect(await cardOf()).toBe(before);
    const own = await send(a.member, POST(`/api/proposals/${card}/reject`, {}));
    expect(own.status).toBe(200);
    expect(readString(own.text, "properties", "status")).toBe("rejected");
  },
  // A's own reopen of a second card succeeds.
  "reopen proposal": () =>
    expectProposalCardRoute({
      seed: async (tenant) => seedProposalCard(tenant, { status: "rejected", ...(await seededTaskProposal(tenant)) }),
      owner: a,
      request: (id) => POST(`/api/proposals/${id}/reopen`, {}),
      check: (text) => {
        expect(readString(text, "properties", "status")).toBe("proposed");
        expect(text).toContain('"keptItems":[]');
      },
    }),
  "revise proposal": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.proposalItemId], ([id]) =>
        POST(`/api/proposals/${id}/revise`, { message: "Use the other Event" }),
      );
    }),
  "update proposal values": () =>
    expectProposalCardRoute({
      seed: async (tenant) => seedProposalCard(tenant, await seededTaskProposal(tenant)),
      owner: b,
      request: (id) => PATCH(`/api/proposals/${id}/values`, { set: { primary: { name: "Edit" } } }),
      check: (text) => expect(text).toContain('"userEditedKeys":["primary.name"]'),
    }),
  "reset proposal overrides": () =>
    expectProposalCardRoute({
      seed: async (tenant) => {
        const { aiProposal } = await seededTaskProposal(tenant);
        return seedProposalCard(tenant, {
          proposal: { ...aiProposal, properties: { name: "Edited task" } },
          aiProposal,
          userOverrides: { primary: { name: "Edited task" } },
          userEditedKeys: ["primary.name"],
        });
      },
      owner: b,
      request: (id) => POST(`/api/proposals/${id}/reset-overrides`, {}),
      check: (text) => expect(text).toContain('"userEditedKeys":[]'),
    }),
  // B's recompute of its own card succeeds (`computing`).
  "recompute proposal": () =>
    expectProposalCardRoute({
      seed: (tenant) =>
        inTenantTransaction(tenant.tenantId, async (client) => {
          const card = await createProposalCard(client);
          await linkProposalSource(client, card, await createInboxItem(client, "Isolation inbox item"));
          return card;
        }),
      owner: b,
      request: (id) => POST(`/api/proposals/${id}/recompute`, {}),
      check: (text) => expect(text).toContain('"status":"computing"'),
    }),
  // Each tenant's options hold only its own project.
  "list proposal options": async () => {
    const seed = (tenant: TenantFixture, name: string) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const projects = await moduleDatabase(client, "projects");
        const project = await createItemWithClient(client, { databaseId: projects.id, properties: { name } });
        return { cardId: await createProposalCard(client), projectId: project.id };
      });
    const [own, foreign] = [await seed(b, "Options project of B"), await seed(a, "Options project of A")];
    const options = (id: string) => GET(`/api/proposals/${id}/options?field=project`);

    await expectForeign404(b.member, [foreign.cardId], ([id]) => options(id!));
    for (const [caller, mine, other] of [
      [b, own, foreign],
      [a, foreign, own],
    ] as const) {
      const answer = await send(caller.member, options(mine.cardId));
      expect(answer.status, answer.text).toBe(200);
      expect(answer.text).toContain(mine.projectId);
      expectNoneOf(answer.text, [other.projectId, other.cardId], "the options");
    }
    await Promise.all([rejectProposalCard(b, own.cardId), rejectProposalCard(a, foreign.cardId)]);
  },
  "task recurrence set": async () => {
    const [own, foreign] = [await datedTask(b), await datedTask(a)];
    const request = (id: string) => PUT(`/api/tasks/${id}/recurrence`, { preset: "weekly" });
    const answer = await sendOk(b.member, request(own));
    expect(readString(answer, "properties", "seriesId")).toMatch(/^[0-9a-f-]{36}$/);
    const before = await recurrenceState(a, foreign);
    await expectForeign404(b.member, [foreign], ([id]) => request(id!));
    expect(await recurrenceState(a, foreign)).toEqual(before);
  },
  "task series edit": async () => {
    const seriesOf = async (tenant: TenantFixture): Promise<string> => {
      const task = await datedTask(tenant);
      const answer = await sendOk(tenant.member, PUT(`/api/tasks/${task}/recurrence`, { preset: "daily" }));
      return readString(answer, "properties", "seriesId");
    };
    const [own, foreign] = [await seriesOf(b), await seriesOf(a)];
    const request = (id: string) => PATCH(`/api/tasks/series/${id}`, { timeFrom: "08:00" });
    const answer = await sendOk(b.member, request(own));
    expect(readString(answer, "seriesId")).toBe(own);
    const before = await seriesTemplate(a, foreign);
    await expectForeign404(b.member, [foreign], ([id]) => request(id!));
    expect(await seriesTemplate(a, foreign)).toEqual(before);
  },
  "task recurrence clear": async () => {
    const [own, foreign] = [await datedTask(b), await datedTask(a)];
    const path = (id: string) => `/api/tasks/${id}/recurrence`;
    await sendOk(b.member, PUT(path(own), { preset: "weekly" }));
    await sendOk(a.member, PUT(path(foreign), { preset: "weekly" }));
    const cleared = await sendOk(b.member, DELETE(path(own)));
    expect(JSON.parse(cleared)).toMatchObject({ properties: { seriesId: null, recurrence: null } });
    const before = await recurrenceState(a, foreign);
    await expectForeign404(b.member, [foreign], ([id]) => DELETE(path(id!)));
    expect(await recurrenceState(a, foreign)).toEqual(before);
  },
  "task occurrence materialize": async () => {
    // A daily series anchored on the task's date, 22 October 2026.
    const seriesOf = async (tenant: TenantFixture): Promise<string> => {
      const task = await datedTask(tenant);
      const answer = await sendOk(tenant.member, PUT(`/api/tasks/${task}/recurrence`, { preset: "daily" }));
      return readString(answer, "properties", "seriesId");
    };
    const [own, foreign] = [await seriesOf(b), await seriesOf(a)];
    const onRuleDate = (id: string) => POST(entryPath("task occurrence materialize", id), { status: "done" });
    const beforeAnchor = (id: string) => POST(`/api/tasks/series/${id}/occurrences/2026-10-21`, { status: "done" });
    // The two answers a foreign series must not get.
    const created = await send(b.member, onRuleDate(own));
    expect(created.status, created.text).toBe(201);
    expect(readString(created.text, "properties", "seriesId")).toBe(own);
    expect(readString(created.text, "properties", "occurrenceDate")).toBe("2026-10-25");
    expect(readString(created.text, "properties", "status")).toBe("done");
    expect((await send(b.member, beforeAnchor(own))).status).toBe(400);

    const before = await seriesOccurrenceState(a, foreign);
    expect(before).toMatchObject({ items: [{ id: expect.any(String) }], series: [{ item_id: expect.any(String) }] });
    for (const request of [onRuleDate, beforeAnchor]) {
      await expectForeign404(b.member, [foreign], ([id]) => request(id!));
    }
    expect(await seriesOccurrenceState(a, foreign)).toEqual(before);
    expect(await seriesOccurrenceState(b, foreign)).toEqual({ items: [], series: [] });
  },
  "task host event put": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    const placed = await sendOk(b.member, PUT(hostEventPath(own.taskId, own.eventId)));
    expect(readString(placed, "taskId")).toBe(own.taskId);
    expect(placed).toContain(own.eventId);
    // The generic relation endpoint refuses both sides of the relation, for an edge that exists.
    for (const [source, key, target] of [
      [own.taskId, "hostEvents", own.eventId],
      [own.eventId, "hostedTasks", own.taskId],
    ] as const) {
      const generic = await send(b.member, PUT(`/api/items/${source}/relations/${key}/${target}`));
      expect(generic.status).toBe(403);
      expect(readString(generic.text, "error", "code")).toBe("owner_violation");
    }
    const ownBefore = await hostEventState(b, own.taskId);
    expect(ownBefore.edges).toHaveLength(1);
    const before = await hostEventState(a, foreign.taskId);
    await expectForeign404(b.member, [foreign.taskId], ([id]) => PUT(hostEventPath(id!, own.eventId)));
    await expectForeign404(b.member, [foreign.eventId], ([id]) => PUT(hostEventPath(own.taskId, id!)));
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    expect(await hostEventState(b, own.taskId)).toEqual(ownBefore);
  },
  "task host event remove": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    await sendOk(b.member, PUT(hostEventPath(own.taskId, own.eventId)));
    await sendOk(a.member, PUT(hostEventPath(foreign.taskId, foreign.eventId)));
    const before = await hostEventState(a, foreign.taskId);
    expect(before.edges).toHaveLength(1);
    await expectForeign404(b.member, [foreign.taskId, foreign.eventId], ([taskId, eventId]) =>
      DELETE(hostEventPath(taskId!, eventId!)),
    );
    // For B's own task, A's event is an event the task does not sit in: 200 with B's list, as for a random id.
    const foreignEvent = await expectForeignLikeRandom(b.member, [foreign.eventId], ([id]) =>
      DELETE(hostEventPath(own.taskId, id!)),
    );
    expect(foreignEvent.status).toBe(200);
    expect(foreignEvent.text).toContain(own.eventId);
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    const removed = await sendOk(b.member, DELETE(hostEventPath(own.taskId, own.eventId)));
    expect(JSON.parse(removed)).toEqual({ taskId: own.taskId, hostEvents: [] });
  },
  "task host events clear": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    await sendOk(b.member, PUT(hostEventPath(own.taskId, own.eventId)));
    await sendOk(a.member, PUT(hostEventPath(foreign.taskId, foreign.eventId)));
    const request = (id: string) => DELETE(`/api/tasks/${id}/host-events`, { date: "2026-10-30", timeFrom: "09:00" });
    const before = await hostEventState(a, foreign.taskId);
    expect(before.edges).toHaveLength(1);
    await expectForeign404(b.member, [foreign.taskId], ([id]) => request(id!));
    expect(await hostEventState(a, foreign.taskId)).toEqual(before);
    const cleared = await sendOk(b.member, request(own.taskId));
    expect(JSON.parse(cleared)).toEqual({ taskId: own.taskId, hostEvents: [] });
    const item = await sendOk(b.member, GET(`/api/items/${own.taskId}`));
    expect(readString(item, "properties", "date")).toBe("2026-10-30");
    expect(readString(item, "properties", "timeFrom")).toBe("09:00");
  },
  "journal period ensure": async () => {
    const request = PUT("/api/journal/periods/day/2032-08-15/doc", {});
    const owner = await sendOk(a.member, request);
    const [other, repeat] = await Promise.all([sendOk(b.member, request), sendOk(b.member, request)]);
    expect(readString(other, "itemId")).toBe(readString(repeat, "itemId"));
    expect(readString(other, "docId")).toBe(readString(repeat, "docId"));
    expect(readString(other, "itemId")).not.toBe(readString(owner, "itemId"));
    expect(readString(other, "docId")).not.toBe(readString(owner, "docId"));
    const counts = await inTenantTransaction(b.tenantId, async (client) => {
      const journal = await moduleDatabase(client, "journal");
      return client.query<{ items: number; docs: number }>(
        `SELECT (SELECT count(*)::int FROM items WHERE database_id = $1 AND properties ->> 'type' = 'day' AND properties ->> 'period' = $2 AND deleted_at IS NULL) AS items,
                (SELECT count(*)::int FROM docs WHERE item_id = $3) AS docs`,
        [journal.id, "2032-08-15", readString(other, "itemId")],
      );
    });
    expect(counts.rows).toEqual([{ items: 1, docs: 1 }]);
    const invalid = await send(b.member, PUT("/api/journal/periods/week/2027-W53/doc", {}));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "journal period read": async () => {
    const createPeriod = async (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const journal = await moduleDatabase(client, "journal");
        return getOrCreateJournalItem(client, journal.id, "day", new Date("2026-10-16T12:00:00Z"), "Europe/Prague");
      });
    const ownA = await createPeriod(a);
    const ownB = await createPeriod(b);
    /** The ids its `events` entry carries. */
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
        // `status` is a system key only the transcription process may write.
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
    const response = await sendOk(b.member, GET(path));
    expect(readString(response, "item", "id")).toBe(ownB.id);
    expect(response).not.toContain(ownA.id);
    expect(dayEventOfB.filter((id) => !response.includes(id))).toEqual([]);
    expectNoneOf(response, dayEventOfA, "B's journal day");
    const asA = await sendOk(a.member, GET(path));
    expect(dayEventOfA.filter((id) => !asA.includes(id))).toEqual([]);
    expectNoneOf(asA, dayEventOfB, "A's journal day");
    const invalid = await send(b.member, GET("/api/journal/periods/week/2027-W53"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "create transcription": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.fileItemId], ([fileItemId]) =>
        POST("/api/transcriptions", { fileItemId }),
      );
    }),
  "transcription rerun": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) =>
        POST(`/api/transcriptions/${id}/rerun`, {}),
      );
    }),
  "transcript list": async () => {
    await expectExcludesA(b.member, GET("/api/transcripts"), [b.transcriptItemId]);
    // A foreign filter id narrows to nothing, exactly like a random one.
    for (const field of ["eventId", "personId", "projectId"]) {
      const answer = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) =>
        GET(`/api/transcripts?${field}=${id}`),
      );
      expect(answer.status).toBe(200);
      expect(answer.text).toBe('{"transcripts":[],"nextCursor":null}');
    }
  },
  // B restores its own recording through the generic Trash route.
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
      const transcriptId = await inTenantTransaction(b.tenantId, async (client) => {
        const transcripts = await moduleDatabase(client, "transcripts");
        // The link only the transcription process writes.
        const item = await createItemWithClient(
          client,
          { databaseId: transcripts.id, properties: { name: "Delete me", link: transcriptionSourceLink(fileId) } },
          { allowedSystemKeys: ["link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        return item.id;
      });
      const deleted = await sendOk(b.member, DELETE(`/api/transcripts/${transcriptId}`));
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
      await sendOk(b.member, POST(`/api/items/${transcriptId}/restore`, {}));
      expect(await trashed()).toEqual([false, false]);
      await expectForeign404(b.member, [a.transcriptItemId], ([id]) => DELETE(`/api/transcripts/${id}`));
    }),
  "transcript detail": async () => {
    await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => GET(`/api/transcripts/${id}`));
  },
  "transcript speakers": async () => {
    await expectForeignLikeRandom(b.member, [a.transcriptItemId], ([id]) => GET(`/api/transcripts/${id}/speakers`));
  },
  "transcript summaries": async () => {
    const seedEvent = async (tenant: TenantFixture): Promise<string> => {
      const eventId = await createItemAs(tenant, "events", { name: "Summary probe", date: "2026-10-16T08:00:00Z" });
      const transcriptId = await inTenantTransaction(tenant.tenantId, async (client) => {
        const transcripts = await moduleDatabase(client, "transcripts");
        // `status` is a system key only the transcription process may write.
        const item = await createItemWithClient(
          client,
          { databaseId: transcripts.id, properties: { name: "Summary probe", status: "done" } },
          { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        return item.id;
      });
      await sendOk(tenant.member, PUT(`/api/items/${transcriptId}/relations/event/${eventId}`, {}));
      return eventId;
    };
    const [own, foreign] = [await seedEvent(b), await seedEvent(a)];
    const path = (ids: readonly string[]) => `/api/transcript-summaries?eventIds=${ids.join(",")}`;
    expect(JSON.parse(await sendOk(a.member, GET(path([foreign]))))).toEqual({
      [foreign]: { count: 1, doneCount: 1 },
    });
    const answer = await expectForeignLikeRandom(b.member, [foreign], (ids) => GET(path([own, ...ids])));
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      [own]: { count: 1, doneCount: 1 },
      [foreign]: { count: 0, doneCount: 0 },
    });
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    for (const ids of [tooMany, [own, "not-a-uuid"]]) {
      const invalid = await send(b.member, GET(path(ids)));
      expect(invalid.status).toBe(400);
      expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
    }
  },
  // B names A's transcript: `null` would delete A's state and `noted` on item 1 would add one. Both
  // answer like a random id and A's state rows stay as they are.
  "transcript action item state": async () => {
    const transcriptWithNotes = (tenant: TenantFixture): Promise<string> =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const transcripts = await moduleDatabase(client, "transcripts");
        const item = await createItemWithClient(client, { databaseId: transcripts.id, properties: { name: "Notes" } });
        // Notes only the transcription process writes.
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
    const request = (id: string, actionItemId: number, state: "noted" | null): Request =>
      PUT(`/api/transcripts/${id}/action-items/${actionItemId}/state`, { state });
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
      await expectForeign404(b.member, [foreign], ([id]) => request(id!, actionItemId, state));
    }
    expect(await states(a, foreign)).toEqual(before);
    expect(await states(b, foreign)).toEqual([]);
    expect((await states(b, own)).map((row) => [row.action_item_id, row.state])).toEqual([[0, "noted"]]);
  },
  // B names A's transcript: the add creates no task in either tenant and no state for A's
  // transcript.
  "transcript action item task create": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const request = (id: string | undefined): Request => POST(`/api/transcripts/${id}/action-items/0/task`, {});
    const [tasksOfA, tasksOfB] = [
      (await actionItemRows(a, foreign.transcriptId)).tasks,
      (await actionItemRows(b, own.transcriptId)).tasks,
    ];
    await expectForeign404(b.member, [foreign.transcriptId], ([id]) => request(id));
    expect(await actionItemRows(a, foreign.transcriptId)).toEqual({ states: [], tasks: tasksOfA });
    expect(await actionItemRows(b, foreign.transcriptId)).toEqual({ states: [], tasks: tasksOfB });
    expect(readString(await sendOk(b.member, request(own.transcriptId)), "taskId")).toMatch(UUID_PATTERN);
    expect(readString(await sendOk(a.member, request(foreign.transcriptId)), "taskId")).toMatch(UUID_PATTERN);
    expect((await actionItemRows(a, foreign.transcriptId)).states).toMatchObject([
      { action_item_id: 0, state: "added" },
    ]);
    expect((await actionItemRows(a, own.transcriptId)).states).toEqual([]);
  },
  "transcript action item task remove": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const path = (id: string | undefined): string => `/api/transcripts/${id}/action-items/0/task`;
    await sendOk(b.member, POST(path(own.transcriptId), {}));
    await sendOk(a.member, POST(path(foreign.transcriptId), {}));
    const before = await actionItemRows(a, foreign.transcriptId);
    expect(before.states).toMatchObject([{ action_item_id: 0, state: "added" }]);
    expect(before.tasks).toContain(before.states[0]?.task_item_id);
    await expectForeign404(b.member, [foreign.transcriptId], ([id]) => DELETE(path(id)));
    expect(await actionItemRows(a, foreign.transcriptId)).toEqual(before);
    expect(await sendOk(b.member, DELETE(path(own.transcriptId)))).toBe('{"actionItemId":0,"state":null}');
    expect((await actionItemRows(b, own.transcriptId)).states).toEqual([]);
  },
  "event transcript action items": async () => {
    const [own, foreign] = [await seedActionItemWorld(b), await seedActionItemWorld(a)];
    const proposalsOf = (eventId: string | undefined): Request => GET(`/api/events/${eventId}/transcript-action-items`);
    expect(await sendOk(a.member, proposalsOf(foreign.eventId))).toContain(foreign.transcriptId);
    const listed = await expectExcludesA(b.member, proposalsOf(own.eventId), [own.transcriptId]);
    expectNoneOf(listed.text, [foreign.eventId, foreign.transcriptId], "B's action item proposals");
    await expectForeign404(b.member, [foreign.eventId], ([id]) => proposalsOf(id));
  },
  // B names A's transcript with its own person, and its own transcript with A's person; A's speaker
  // stays unmapped.
  "transcript speaker assign": async () => {
    const [own, foreign] = [await seedSpeakerWorld(b), await seedSpeakerWorld(a)];
    const assign = (transcriptId: string | undefined, personId: string | undefined): Request =>
      PUT(`/api/transcripts/${transcriptId}/speakers/SPEAKER_00`, { personId });
    const speakersOf = (caller: Caller, transcriptId: string): Promise<string> =>
      sendOk(caller, GET(`/api/transcripts/${transcriptId}/speakers`));
    const before = await speakersOf(a.member, foreign.transcriptId);
    expect(before).toContain('"personId":null');

    await expectForeign404(b.member, [foreign.transcriptId], ([id]) => assign(id, own.personId));
    await expectForeign404(b.member, [foreign.personId], ([id]) => assign(own.transcriptId, id));
    expect(await speakersOf(a.member, foreign.transcriptId)).toBe(before);
    expect(await speakersOf(b.member, own.transcriptId)).toContain('"personId":null');
    expect(readString(await sendOk(b.member, assign(own.transcriptId, own.personId)), "personId")).toBe(own.personId);
    expect(readString(await sendOk(a.member, assign(foreign.transcriptId, foreign.personId)), "personId")).toBe(
      foreign.personId,
    );
    expect(await speakersOf(b.member, own.transcriptId)).not.toContain(foreign.personId);
  },
  "transcript speaker candidates": async () => {
    const [own, foreign] = [await seedSpeakerWorld(b), await seedSpeakerWorld(a)];
    const candidatesOf = (transcriptId: string | undefined): Request =>
      GET(`/api/transcripts/${transcriptId}/speaker-candidates`);
    expect(await sendOk(a.member, candidatesOf(foreign.transcriptId))).toContain(foreign.personId);
    const listed = await expectExcludesA(b.member, candidatesOf(own.transcriptId), [own.personId]);
    expectNoneOf(listed.text, [foreign.personId, foreign.transcriptId, foreign.eventId], "B's speaker candidates");
    await expectForeign404(b.member, [foreign.transcriptId], ([id]) => candidatesOf(id));
  },
  "event people": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ eventId: string; personId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const eventId = await create("events", { name: "Participants probe", date: "2026-10-16" });
      const personId = await create("people", { name: "Participant probe" });
      await sendOk(tenant.member, PUT(`/api/items/${eventId}/relations/people/${personId}`, {}));
      return { eventId, personId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const peopleOf = (eventId: string | undefined): Request => GET(`/api/events/${eventId}/people`);
    expect(await sendOk(a.member, peopleOf(foreign.eventId))).toContain(foreign.personId);
    const listed = await expectExcludesA(b.member, peopleOf(own.eventId), [own.personId]);
    expectNoneOf(listed.text, [foreign.eventId, foreign.personId], "B's participant list");
    await expectForeign404(b.member, [foreign.eventId], ([id]) => peopleOf(id));
  },
  // B replaces the people of A's Event, names A's person and names A's mailbox; each answers like a
  // random id. B then invites through its own Event, so the refusals are not what every request
  // gets; that invitation queues one job in B and creates B's organizer edge.
  "event people replace": async () => {
    await linkOwnPerson(b);
    const seed = async (tenant: TenantFixture): Promise<{ eventId: string; personId: string; keptId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const eventId = await create("events", { name: "Replace probe", date: "2026-11-02" });
      const personId = await create("people", { name: "Replace probe person", emails: "replace-probe@example.com" });
      const keptId = await create("people", { name: "Replace probe kept person" });
      await sendOk(tenant.member, PUT(`/api/items/${eventId}/relations/people/${keptId}`, {}));
      return { eventId, personId, keptId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const replace = (
      eventId: string | undefined,
      people: Array<string | undefined>,
      sendInvites: boolean,
      mailboxId?: string,
    ): Request =>
      PUT(`/api/events/${eventId}/people`, {
        people: people.map((personId) => ({ personId })),
        sendInvites,
        mailboxId,
      });
    const peopleOf = (caller: Caller, eventId: string): Promise<string> =>
      sendOk(caller, GET(`/api/events/${eventId}/people`));

    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.eventId], ([id]) => replace(id, [own.personId], false));
      const person = await expectForeignLikeRandom(b.member, [foreign.personId], ([id]) =>
        replace(own.eventId, [own.keptId, id], false),
      );
      expect(person.status).toBe(400);
      const mailbox = await expectForeignLikeRandom(b.member, [a.mailboxItemId], ([id]) =>
        replace(own.eventId, [own.keptId, own.personId], true, id),
      );
      expect(mailbox.status).toBe(400);
      // None of the refused requests changed B's Event either.
      expect(await peopleOf(b.member, own.eventId)).not.toContain(own.personId);
    });
    const replaced = await sendOk(b.member, replace(own.eventId, [own.keptId, own.personId], true, b.mailboxItemId));
    expect(replaced).toContain(own.personId);
    expect(readNumber(replaced, "invited")).toBe(1);
    expectNoneOf(replaced, [foreign.eventId, foreign.personId, foreign.keptId], "B's participant list");
    expectText(await peopleOf(a.member, foreign.eventId), [foreign.keptId], [foreign.personId]);
  },
  // B invites through A's Event, A's person and A's mailbox; each answers like a random id. B then
  // invites its own person, which queues one job in B.
  "event person invite": async () => {
    await linkOwnPerson(b);
    const seed = async (tenant: TenantFixture): Promise<{ eventId: string; personId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const eventId = await create("events", { name: "Invite probe", date: "2026-11-02" });
      const personId = await create("people", { name: "Invite probe person", emails: "invite-probe@example.com" });
      await sendOk(tenant.member, PUT(`/api/items/${eventId}/relations/people/${personId}`, {}));
      return { eventId, personId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const invite = (
      eventId: string | undefined,
      personId: string | undefined,
      mailboxId: string | undefined,
    ): Request => POST(`/api/events/${eventId}/people/${personId}/invite`, { mailboxId });
    const peopleOf = (caller: Caller, eventId: string): Promise<string> =>
      sendOk(caller, GET(`/api/events/${eventId}/people`));
    const stateOfA = await peopleOf(a.member, foreign.eventId);

    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.eventId], ([id]) => invite(id, own.personId, b.mailboxItemId));
      await expectForeign404(b.member, [foreign.personId], ([id]) => invite(own.eventId, id, b.mailboxItemId));
      const mailbox = await expectForeignLikeRandom(b.member, [a.mailboxItemId], ([id]) =>
        invite(own.eventId, own.personId, id),
      );
      expect(mailbox.status).toBe(400);
    });
    expect(await peopleOf(a.member, foreign.eventId)).toBe(stateOfA);
    expect(stateOfA).toContain(foreign.personId);
    const invited = await sendOk(b.member, invite(own.eventId, own.personId, b.mailboxItemId));
    expectText(invited, [own.personId, '"status":"pending"'], []);
    expectNoneOf(invited, [foreign.eventId, foreign.personId], "B's participant list");
    expect(await peopleOf(a.member, foreign.eventId)).toBe(stateOfA);
  },
  "event tasks": async () => {
    const [own, foreign] = [await taskAndEvent(b), await taskAndEvent(a)];
    await sendOk(b.member, PUT(hostEventPath(own.taskId, own.eventId)));
    await sendOk(a.member, PUT(hostEventPath(foreign.taskId, foreign.eventId)));
    const tasksOf = (eventId: string | undefined): Request => GET(`/api/events/${eventId}/tasks`);
    expect(await sendOk(a.member, tasksOf(foreign.eventId))).toContain(foreign.taskId);
    const listed = await expectExcludesA(b.member, tasksOf(own.eventId), [own.taskId]);
    expectNoneOf(listed.text, [foreign.eventId, foreign.taskId], "B's event tasks");
    // The Event's day is fixed, so the state is open or missed depending on when the test runs;
    // both count as open.
    expect(JSON.parse(listed.text)).toMatchObject({
      eventId: own.eventId,
      tasks: [{ taskId: own.taskId }],
      counts: { open: 1, total: 1 },
    });
    await expectForeign404(b.member, [foreign.eventId], ([id]) => tasksOf(id));
    const invalid = await send(b.member, tasksOf("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  // An overdue task is in the overview's list whatever day the test runs on.
  "area overview": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ areaId: string; projectId: string; taskId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const relate = (itemId: string, key: string, targetId: string): Promise<string> =>
        sendOk(tenant.member, PUT(`/api/items/${itemId}/relations/${key}/${targetId}`, {}));
      const areaId = await create("areas", { name: "Overview probe" });
      const projectId = await create("projects", { name: "Overview probe project" });
      const taskId = await create("tasks", { name: "Overview probe task", date: "2026-01-05" });
      await relate(projectId, "area", areaId);
      await relate(taskId, "project", projectId);
      return { areaId, projectId, taskId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const overviewOf = (areaId: string | undefined): Request => GET(`/api/areas/${areaId}/overview`);
    const asOwner = await sendOk(a.member, overviewOf(foreign.areaId));
    expect([foreign.projectId, foreign.taskId].filter((id) => !asOwner.includes(id))).toEqual([]);
    const listed = await expectExcludesA(b.member, overviewOf(own.areaId), [own.projectId, own.taskId]);
    expectNoneOf(listed.text, Object.values(foreign), "B's area overview");
    await expectForeign404(b.member, [foreign.areaId], ([id]) => overviewOf(id));
    const invalid = await send(b.member, overviewOf("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "library automation retry": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ itemId: string; blobId: string }> => {
      const created = await sendOk(
        tenant.member,
        POST(`/api/databases/${await databaseIdFor(tenant.tenantId, "books")}/items`, {
          properties: { name: "Retry probe" },
        }),
      );
      const itemId = readString(created, "id");
      const version = readString(created, "version");
      const upload = await sendOk(tenant.member, {
        method: "POST",
        path: "/api/blobs",
        body: pngBytesOf(`retry probe cover ${randomUUID()}`),
        headers: { "Content-Type": "image/png" },
      });
      const blobId = readString(upload, "blobId");
      await sendOk(
        tenant.member,
        PATCH(`/api/items/${itemId}`, {
          properties: { coverOverride: { blobId }, coverSource: "userPhoto" },
          ifVersion: version,
        }),
      );
      return { itemId, blobId };
    };
    const stateOf = async (tenant: TenantFixture, itemId: string): Promise<{ cover: unknown; status: string }> => {
      const item = await sendOk(tenant.member, GET(`/api/items/${itemId}`));
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
    const retry = (id: string): Request => POST(`/api/items/${id}/automation/retry`, {});
    expect(await stateOf(b, own.itemId)).toMatchObject({ cover: { blobId: own.blobId } });
    const accepted = await send(b.member, retry(own.itemId));
    expect(accepted.status).toBe(202);
    expect(await stateOf(b, own.itemId)).toEqual({ cover: null, status: "pending" });
    const before = await stateOf(a, foreign.itemId);
    expect(before.cover).toEqual({ blobId: foreign.blobId });
    await expectForeign404(b.member, [foreign.itemId], ([id]) => retry(id!));
    expect(await stateOf(a, foreign.itemId)).toEqual(before);
  },
  // The metadata job is the only writer of the stored candidate set.
  "library cover candidates list": async () => {
    const [own, foreign] = [await seedCoverCandidateItem(b), await seedCoverCandidateItem(a)];
    await runCoverCandidateJobs();
    const listOf = (id: string): Request => GET(`/api/items/${id}/cover-candidates`);
    const listed = await expectExcludesA(b.member, listOf(own.itemId), [own.imageUrl]);
    expectNoneOf(listed.text, [foreign.itemId, foreign.imageUrl], "B's cover candidates");
    expect(await send(a.member, listOf(foreign.itemId))).toMatchObject({ status: 200 });
    await expectForeign404(b.member, [foreign.itemId], ([id]) => listOf(id!));
    const invalid = await send(b.member, listOf("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "library cover candidates refresh": async () => {
    const [own, foreign] = [await seedCoverCandidateItem(b), await seedCoverCandidateItem(a)];
    await runCoverCandidateJobs();
    const refresh = (id: string): Request => POST(`/api/items/${id}/cover-candidates/refresh`, {});
    const before = await coverCandidateState(a, foreign.itemId);
    expect(before).toEqual({ status: "done", imageUrls: [foreign.imageUrl] });
    expect((await send(b.member, refresh(own.itemId))).status).toBe(202);
    expect(await coverCandidateState(b, own.itemId)).toEqual({ status: "pending", imageUrls: [own.imageUrl] });
    await expectForeign404(b.member, [foreign.itemId], ([id]) => refresh(id!));
    expect(await coverCandidateState(a, foreign.itemId)).toEqual(before);
    const invalid = await send(b.member, refresh("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "library cover candidate select": async () => {
    const [own, foreign] = [await seedCoverCandidateItem(b), await seedCoverCandidateItem(a)];
    await runCoverCandidateJobs();
    const selectOf = (id: string, index = 0): Request => POST(`/api/items/${id}/cover-candidates/${index}/select`, {});
    const coverOf = async (tenant: TenantFixture, itemId: string): Promise<unknown> => {
      const item = await sendOk(tenant.member, GET(`/api/items/${itemId}`));
      return z.object({ properties: z.record(z.string(), z.unknown()) }).parse(JSON.parse(item)).properties
        .coverOverride;
    };
    // The candidate host resolves to a private address, so a request that reaches the download is
    // refused with a 400 on `index`: the route is mounted and checked the address, and no image is
    // fetched.
    const dns = stubDnsLookup({ "covers.example.test": ["10.0.0.1"] });
    try {
      const refused = await send(b.member, selectOf(own.itemId));
      expect(refused.status).toBe(400);
      expect(readString(refused.text, "error", "code")).toBe("validation_failed");
      expect(dns.calls).toHaveLength(1);
      // A position with no candidate is a 404 before any download.
      expect((await send(b.member, selectOf(own.itemId, 2))).status).toBe(404);
      await expectForeign404(b.member, [foreign.itemId], ([id]) => selectOf(id!));
      expect(dns.calls).toHaveLength(1);
      const invalid = await send(b.member, selectOf("not-a-uuid"));
      expect(invalid.status).toBe(400);
      expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
    } finally {
      dns.restore();
    }
    expect(await coverOf(a, foreign.itemId)).toBeUndefined();
    expect(await coverOf(b, own.itemId)).toBeUndefined();
  },
  "inbox types": async () => {
    await expectExcludesA(b.member, GET("/api/inbox-types"));
  },
  "inbox cards": async () => {
    const seedStack = async (tenant: TenantFixture) => ({
      cardId: await seedProposalCard(tenant),
      approvalId: await seedPendingApproval(tenant, "inbox cards isolation"),
    });
    const [own, foreign] = [await seedStack(b), await seedStack(a)];
    const request: Request = GET("/api/inbox/cards");

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
  // B's change of A's item, and of its own item with A's type, each answer like a random id and
  // leave no edge. B's own change then succeeds.
  "change inbox item type": async () => {
    const seed = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => ({
        typeId: await createInboxType(client, "Isolation type"),
        itemId: await createInboxItem(client, "Isolation inbox item"),
      }));
    const edgeCount = (tenant: TenantFixture, itemId: string, typeId: string) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
          [itemId, typeId],
        );
        return rows[0]?.n;
      });
    const [own, foreign] = [await seed(b), await seed(a)];

    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.itemId], ([id]) =>
        PUT(`/api/inbox/items/${id}/type`, { typeId: own.typeId }),
      );
      const unknownType = await expectForeignLikeRandom(b.member, [foreign.typeId], ([id]) =>
        PUT(`/api/inbox/items/${own.itemId}/type`, { typeId: id }),
      );
      expect(unknownType.status).toBe(400);
    });
    expect(await edgeCount(a, foreign.itemId, own.typeId)).toBe(0);
    expect(await edgeCount(a, foreign.itemId, foreign.typeId)).toBe(0);
    expect(await edgeCount(b, own.itemId, foreign.typeId)).toBe(0);

    const changed = await send(b.member, PUT(`/api/inbox/items/${own.itemId}/type`, { typeId: own.typeId }));
    expect(changed.status).toBe(200);
    expect(await edgeCount(b, own.itemId, own.typeId)).toBe(1);
  },
  // B's capture with A's type writes no item in either tenant; B's capture with its own type
  // succeeds.
  "capture inbox item": async () => {
    const marker = "Isolation capture route probe";
    const seedType = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, (client) => createInboxType(client, "Isolation capture type"));
    const captured = (tenant: TenantFixture, text = marker) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string; type_edges: number }>(
          `SELECT i.id, (SELECT count(*)::int FROM item_relations r WHERE r.item_a = i.id OR r.item_b = i.id) AS type_edges
             FROM items i JOIN databases d ON d.id = i.database_id
            WHERE d.owner_module_id = 'inbox' AND i.properties->>'text' = $1`,
          [text],
        );
        return rows;
      });
    const attachmentBlobIds = (tenant: TenantFixture, text: string) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ blob_id: string }>(
          `SELECT a.blob_id FROM inbox_attachments a JOIN items i ON i.id = a.inbox_item_id
            WHERE i.properties->>'text' = $1 ORDER BY a.position`,
          [text],
        );
        return rows.map((row) => row.blob_id);
      });
    const [ownType, foreignType] = [await seedType(b), await seedType(a)];
    const body = (typeId: string) => ({
      text: marker,
      date: "2026-08-28",
      time: "09:00",
      captureChannel: "typed",
      typeId,
    });

    await leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [foreignType], ([typeId]) =>
        POST("/api/inbox/items", body(typeId ?? "")),
      );
      expect(answer.status).toBe(400);
    });
    expect(await captured(a)).toEqual([]);
    expect(await captured(b)).toEqual([]);

    const own = await send(b.member, POST("/api/inbox/items", body(ownType)));
    expect(own.status, own.text).toBe(201);
    const [item, ...rest] = await captured(b);
    expect(rest).toEqual([]);
    expect(own.text).toContain(item?.id);
    // The `type` edge and the `journalDay` edge of the item.
    expect(item?.type_edges).toBe(2);
    expect(await captured(a)).toEqual([]);

    // B naming A's blob creates no item and no attachment in either tenant; B's own blob then
    // attaches.
    const attachmentText = "Isolation capture attachment probe";
    const withAttachment = (blobId: string) => ({
      text: attachmentText,
      date: "2026-08-28",
      time: "09:00",
      captureChannel: "typed",
      attachments: [{ blobId, source: "files" }],
    });
    await leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [a.blobId], ([blobId]) =>
        POST("/api/inbox/items", withAttachment(blobId ?? "")),
      );
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({
        error: { code: "validation_failed", details: { field: "attachments" } },
      });
    });
    expect(await captured(a, attachmentText)).toEqual([]);
    expect(await captured(b, attachmentText)).toEqual([]);
    const ownBlob = readString(
      await sendOk(b.member, {
        method: "POST",
        path: "/api/blobs",
        body: pngBytesOf(`capture attachment ${randomUUID()}`),
        headers: { "Content-Type": "image/png" },
      }),
      "blobId",
    );
    const attached = await send(b.member, POST("/api/inbox/items", withAttachment(ownBlob)));
    expect(attached.status, attached.text).toBe(201);
    expect(await attachmentBlobIds(b, attachmentText)).toEqual([ownBlob]);
    expect(await captured(a, attachmentText)).toEqual([]);
    expect(await attachmentBlobIds(a, attachmentText)).toEqual([]);
  },
  // Counts are compared as deltas on top of whatever earlier cases left; each rises by its own
  // tenant's rows only.
  "inbox cards count": async () => {
    const request: Request = GET("/api/inbox/cards/count");
    const totalOf = async (tenant: TenantFixture): Promise<number> =>
      z.object({ total: z.number().int() }).parse(JSON.parse(await sendOk(tenant.member, request))).total;
    const seed = async (tenant: TenantFixture, cardCount: number) => {
      for (let n = 0; n < cardCount; n += 1) await seedProposalCard(tenant);
      await seedPendingApproval(tenant, "inbox cards count isolation");
    };
    const [aBefore, bBefore] = [await totalOf(a), await totalOf(b)];

    await seed(a, 3);
    await seed(b, 1);

    expect(await totalOf(a)).toBe(aBefore + 4);
    expect(await totalOf(b)).toBe(bBefore + 2);
  },
  // Counts are compared as deltas on top of whatever earlier cases left; the field without a source
  // stays 0 for both.
  "badge counts": async () => {
    const request: Request = GET("/api/badge-counts");
    const countsOf = async (tenant: TenantFixture) =>
      z
        .object({
          pendingApprovals: z.number().int(),
          pendingInvites: z.number().int(),
          openInboxItems: z.number().int(),
        })
        .parse(JSON.parse(await sendOk(tenant.member, request)));
    const seedApprovals = async (tenant: TenantFixture, count: number) => {
      for (let n = 0; n < count; n += 1) await seedPendingApproval(tenant, "badge counts isolation");
    };
    const seedInvitations = async (tenant: TenantFixture, count: number) => {
      for (let n = 0; n < count; n += 1) {
        await seedInvitation(tenant, `Badge count probe ${n}`, `badge-count-probe-${n}-${randomUUID()}@example.test`);
      }
    };
    const [aBefore, bBefore] = [await countsOf(a), await countsOf(b)];

    await seedApprovals(a, 3);
    await seedApprovals(b, 1);
    await seedInvitations(a, 2);
    await seedInvitations(b, 1);

    expect(await countsOf(a)).toEqual({
      pendingApprovals: aBefore.pendingApprovals + 3,
      pendingInvites: aBefore.pendingInvites + 2,
      openInboxItems: 0,
    });
    expect(await countsOf(b)).toEqual({
      pendingApprovals: bBefore.pendingApprovals + 1,
      pendingInvites: bBefore.pendingInvites + 1,
      openInboxItems: 0,
    });
  },
  "calendar timeline": async () => {
    const seedDay = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const ids: string[] = [];
        for (const moduleId of ["events", "tasks"]) {
          const database = await moduleDatabase(client, moduleId);
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
      const answer = await expectExcludesA(b.member, GET(`${path}${shape}`), own);
      expectNoneOf(answer.text, foreign, `B's calendar timeline${shape}`);
    }
    const asA = await sendOk(a.member, GET(path));
    expect(foreign.filter((id) => !asA.includes(id))).toEqual([]);
    expectNoneOf(asA, own, "A's calendar timeline");
    const invalid = await send(b.member, GET("/api/calendar/timeline?from=2026-10-17&to=2026-10-16"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "calendar agenda": async () => {
    const day = "2026-10-21";
    const seedDay = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const ids: string[] = [];
        for (const moduleId of ["events", "tasks"]) {
          const database = await moduleDatabase(client, moduleId);
          const item = await createItemWithClient(client, {
            databaseId: database.id,
            properties: { name: "Agenda", date: day },
          });
          ids.push(item.id);
        }
        return ids;
      });
    const foreign = await seedDay(a);
    const own = await seedDay(b);
    for (const direction of ["forward", "backward"]) {
      const path = `/api/calendar/agenda?from=${day}&direction=${direction}&limit=200`;
      const answer = await expectExcludesA(b.member, GET(path), own);
      expectNoneOf(answer.text, foreign, `B's calendar agenda ${direction}`);
      const asA = await sendOk(a.member, GET(path));
      expect(foreign.filter((id) => !asA.includes(id))).toEqual([]);
      expectNoneOf(asA, own, `A's calendar agenda ${direction}`);
    }
    // A cursor that names A's Event on that day answers B like a cursor that names no item.
    const continued = await expectForeignLikeRandom(b.member, foreign, ([eventId]) =>
      GET(
        `/api/calendar/agenda?from=${day}&direction=forward&cursor=${Buffer.from(`${day}|${eventId}`).toString("base64url")}`,
      ),
    );
    expect(continued.status).toBe(200);
    const invalid = await send(b.member, GET(`/api/calendar/agenda?from=${day}&direction=sideways`));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  // Both tenants keep their seeded plans, so a night that follows a plan is not mistaken for an
  // empty answer.
  "sleep nights": async () => {
    const seedNight = (tenant: TenantFixture, bedTime: string) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const database = await moduleDatabase(client, "sleepNights");
        await createItemWithClient(client, {
          databaseId: database.id,
          properties: { night: "2026-10-15", bedTime },
        });
      });
    const foreignBedTime = "21:17";
    const ownBedTime = "21:19";
    await seedNight(a, foreignBedTime);
    await seedNight(b, ownBedTime);
    const request: Request = GET("/api/sleep/nights?from=2026-10-15&to=2026-10-16");
    const asB = await expectExcludesA(b.member, request);
    expectText(asB.text, [`"bedTime":"${ownBedTime}"`], [foreignBedTime]);
    const asA = await sendOk(a.member, request);
    expectText(asA, [`"bedTime":"${foreignBedTime}"`], [ownBedTime]);
    const invalid = await send(b.member, GET("/api/sleep/nights?from=2026-10-17&to=2026-10-16"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  // B reads nothing of A first while only A has rows, then with rows of its own; A reads its own
  // rows, so B's answers are isolation and not an empty fixture.
  "overview summary": async () => {
    const overviewBody = z.object({
      areas: z.array(z.object({ id: z.string(), activeProjectCount: z.number() })),
      collections: z.array(z.object({ databaseId: z.string() })),
      journalTodayItemId: z.string().nullable(),
    });
    const request: Request = GET("/api/overview");
    const seed = async (tenant: TenantFixture): Promise<{ areaId: string; projectId: string; dayItemId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const areaId = await create("areas", { name: "Overview probe" });
      const projectId = await create("projects", { name: "Overview probe project", status: "inProgress" });
      await sendOk(tenant.member, PUT(`/api/items/${projectId}/relations/area/${areaId}`, {}));
      const day = await inTenantTransaction(tenant.tenantId, async (client) => {
        const journal = await moduleDatabase(client, "journal");
        // The seeded time zone of a tenant; the route reads the same setting.
        return getOrCreateJournalItem(client, journal.id, "day", new Date(), "Europe/Prague");
      });
      return { areaId, projectId, dayItemId: day.id };
    };
    const foreign = await seed(a);
    const tasksOfB = await databaseIdFor(b.tenantId, "tasks");
    const beforeOwn = await expectExcludesA(b.member, request, [tasksOfB]);
    expectNoneOf(beforeOwn.text, Object.values(foreign), "B's overview before B has rows of its own");
    expect(overviewBody.parse(JSON.parse(beforeOwn.text)).journalTodayItemId).toBeNull();

    const own = await seed(b);
    const afterOwn = await expectExcludesA(b.member, request, [tasksOfB, own.areaId, own.dayItemId]);
    expectNoneOf(afterOwn.text, Object.values(foreign), "B's overview");
    const bodyOfB = overviewBody.parse(JSON.parse(afterOwn.text));
    expect(bodyOfB.journalTodayItemId).toBe(own.dayItemId);
    expect(bodyOfB.areas).toContainEqual({ id: own.areaId, activeProjectCount: 1 });

    const asA = await sendOk(a.member, request);
    expect(
      [foreign.areaId, foreign.dayItemId, await databaseIdFor(a.tenantId, "tasks")].filter((id) => !asA.includes(id)),
    ).toEqual([]);
    expectNoneOf(asA, Object.values(own), "A's overview");
  },
  // Each tenant finds its own Task and never the other's, so an empty answer cannot pass for
  // isolation. A refused input answers 400 without repeating the query.
  "global search": async () => {
    const word = freshSearchWord();
    const foreignTaskId = await seedSearchTask(a, `${word} of A`);
    const ownTaskId = await seedSearchTask(b, `${word} of B`);
    const request: Request = GET(`/api/search?q=${word}&scope=task`);
    const asB = await expectExcludesA(b.member, request, [ownTaskId]);
    expectNoneOf(asB.text, [foreignTaskId], "B's search");
    const asA = await sendOk(a.member, request);
    expectText(asA, [foreignTaskId], [ownTaskId]);
    const invalid = await send(b.member, GET(`/api/search?q=${word}&scope=task,event&cursor=x`));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
    expect(invalid.text).not.toContain(word);
  },
  // An Idempotency-Key is a reservation of one tenant, so the key B used does not find A's copy.
  "calendar item duplicate": async () => {
    const seed = async (
      tenant: TenantFixture,
    ): Promise<{ eventId: string; personId: string; eventsDatabaseId: string }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const eventId = await create("events", { name: "Duplicate probe", date: "2026-11-02" });
      const personId = await create("people", { name: "Duplicate probe person" });
      await sendOk(tenant.member, PUT(`/api/items/${eventId}/relations/people/${personId}`, {}));
      return { eventId, personId, eventsDatabaseId: await databaseIdFor(tenant.tenantId, "events") };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const duplicateOf = (eventId: string | undefined): Request => ({
      method: "POST",
      path: `/api/calendar/items/${eventId}/duplicate`,
      body: { date: "2026-11-03" },
      headers: { "Idempotency-Key": "isolation-duplicate" },
    });
    const eventsOf = (caller: Caller, databaseId: string): Promise<string> =>
      sendOk(caller, POST(`/api/databases/${databaseId}/query`, {}));
    const peopleOf = (caller: Caller, eventId: string): Promise<string> =>
      sendOk(caller, GET(`/api/items/${eventId}/relations?propertyKey=people`));
    const [eventsOfA, eventsOfB] = [
      await eventsOf(a.member, foreign.eventsDatabaseId),
      await eventsOf(b.member, own.eventsDatabaseId),
    ];

    await expectForeign404(b.member, [foreign.eventId], ([id]) => duplicateOf(id));
    expect(await eventsOf(a.member, foreign.eventsDatabaseId)).toBe(eventsOfA);
    expect(await eventsOf(b.member, own.eventsDatabaseId)).toBe(eventsOfB);

    const copy = await sendOk(b.member, duplicateOf(own.eventId));
    const copyId = readString(copy, "id");
    expect(copyId).not.toBe(own.eventId);
    expectNoneOf(copy, [foreign.eventId, foreign.personId], "B's copy");
    expect(await peopleOf(b.member, copyId)).toContain(own.personId);
    expectNoneOf(await eventsOf(b.member, own.eventsDatabaseId), [foreign.eventId, foreign.personId], "B's Events");
    const copyOfA = readString(await sendOk(a.member, duplicateOf(foreign.eventId)), "id");
    expect(copyOfA).not.toBe(copyId);
    expect(await peopleOf(a.member, copyOfA)).toContain(foreign.personId);
    expect(await peopleOf(b.member, copyId)).not.toContain(foreign.personId);
  },
  // A's invitation stays pending with no Event made in either tenant; B's answer to its own makes
  // B's Event only.
  "calendar invitation respond": async () => {
    const seed = async (tenant: TenantFixture, title: string) => ({
      id: await seedInvitation(tenant, title, `${title}@example.test`),
      invitationsDatabaseId: await databaseIdFor(tenant.tenantId, "invitations"),
    });
    const [own, foreign] = [await seed(b, "Isolation probe of B"), await seed(a, "Isolation probe of A")];
    const respondTo = (id: string | undefined): Request =>
      POST(`/api/calendar/invitations/${id}/respond`, { response: "accepted" });
    const rowsOf = (caller: Caller, databaseId: string): Promise<string> =>
      sendOk(caller, POST(`/api/databases/${databaseId}/query`, {}));
    const [eventsDatabaseOfA, eventsDatabaseOfB] = [
      await databaseIdFor(a.tenantId, "events"),
      await databaseIdFor(b.tenantId, "events"),
    ];
    const [eventsOfA, invitationsOfA] = [
      await rowsOf(a.member, eventsDatabaseOfA),
      await rowsOf(a.member, foreign.invitationsDatabaseId),
    ];
    const eventsOfB = await rowsOf(b.member, eventsDatabaseOfB);

    await expectForeign404(b.member, [foreign.id], ([id]) => respondTo(id));
    expect(await rowsOf(a.member, eventsDatabaseOfA)).toBe(eventsOfA);
    expect(await rowsOf(a.member, foreign.invitationsDatabaseId)).toBe(invitationsOfA);
    expect(await rowsOf(b.member, eventsDatabaseOfB)).toBe(eventsOfB);

    const accepted = await sendOk(b.member, respondTo(own.id));
    expect(readString(accepted, "properties", "status")).toBe("accepted");
    expectNoneOf(accepted, [foreign.id], "B's answer");
    const eventsAfter = await rowsOf(b.member, eventsDatabaseOfB);
    expectText(eventsAfter, ["Isolation probe of B"], ["Isolation probe of A"]);
    expect(await rowsOf(a.member, eventsDatabaseOfA)).toBe(eventsOfA);
    expect(await rowsOf(a.member, foreign.invitationsDatabaseId)).toBe(invitationsOfA);
    // The answer is the only way to change the status: a generic write of it is refused.
    const generic = await send(
      b.member,
      PATCH(`/api/items/${own.id}`, { properties: { status: "declined" }, ifVersion: readString(accepted, "version") }),
    );
    expect(generic.status, generic.text).toBe(403);
  },
  // B's request naming A's account answers like a random id, queues nothing for A and does not debounce A's own.
  "calendar account sync": async () => {
    const switchOn = (tenant: TenantFixture) =>
      runInTenant(tenant.tenantId, async () => {
        const mailboxesDatabaseId = await databaseIdFor(tenant.tenantId, "mailboxes");
        await createChokePoint(pool).updateItem({
          databaseId: mailboxesDatabaseId,
          itemId: tenant.mailboxItemId,
          propertiesPatch: { calendarsEnabled: true },
        });
      });
    await switchOn(a);
    await switchOn(b);
    const sync = (id: string | undefined): Request => POST(`/api/accounts/${id}/calendars/sync`, {});

    await expectForeign404(b.member, [a.mailboxItemId], ([id]) => sync(id));
    expect(await sendOk(b.member, sync(b.mailboxItemId))).toBe(JSON.stringify({ id: b.mailboxItemId, queued: true }));
    expect(await sendOk(a.member, sync(a.mailboxItemId))).toBe(JSON.stringify({ id: a.mailboxItemId, queued: true }));
  },
  // A's calendar holds more of everything than B's, so a leaked count would show in B's answer.
  "calendar cancellation impact": async () => {
    const seed = async (tenant: TenantFixture, eventCount: number): Promise<{ calendarId: string; ids: string[] }> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      const calendarId = await create("calendars", { name: "Cancellation probe" });
      const personId = await create("people", { name: "Cancellation probe person" });
      const eventsDatabaseId = await databaseIdFor(tenant.tenantId, "events");
      const eventIds = await runInTenant(tenant.tenantId, async () => {
        const chokePoint = createChokePoint(pool);
        const people = (await chokePoint.listProperties(eventsDatabaseId)).find(
          (property) => property.key === "people",
        );
        if (!people) throw new Error("Missing Events.people");
        const created: string[] = [];
        for (let index = 0; index < eventCount; index += 1) {
          const event = await withTransaction(pool, (client) =>
            createEventInCalendar(
              client,
              { properties: { name: `Cancellation probe event ${index}`, date: "2026-11-16" } },
              calendarId,
              { writer: { writerKind: "user" } },
            ),
          );
          // Invitations are written by the server only, hence the system writer kind.
          await chokePoint.createRelation({
            relationPropertyId: people.id,
            callerItemId: event.id,
            targetItemId: personId,
            metadata: {
              invitation: {
                status: "pending",
                email: `${tenant.tenantId}.${index}@example.com`,
                mailboxId: randomUUID(),
              },
            },
          });
          created.push(event.id);
        }
        return created;
      });
      return { calendarId, ids: [personId, ...eventIds] };
    };
    const [own, foreign] = [await seed(b, 1), await seed(a, 2)];
    const impactOf = (calendarId: string | undefined): Request =>
      GET(`/api/calendar/calendars/${calendarId}/cancellation-impact`);
    expect(JSON.parse(await sendOk(a.member, impactOf(foreign.calendarId)))).toEqual({
      eventCount: 2,
      cancellationCount: 2,
      recipientCount: 2,
    });
    const listed = await expectExcludesA(b.member, impactOf(own.calendarId));
    expect(JSON.parse(listed.text)).toEqual({ eventCount: 1, cancellationCount: 1, recipientCount: 1 });
    expectNoneOf(listed.text, [foreign.calendarId, ...foreign.ids], "B's cancellation impact");
    await expectForeign404(b.member, [foreign.calendarId], ([id]) => impactOf(id));
    const invalid = await send(b.member, impactOf("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "calendar reminders": async () => {
    const seedReminders = async (tenant: TenantFixture): Promise<string[]> => {
      const create = (moduleId: string, properties: Record<string, unknown>) =>
        createItemAs(tenant, moduleId, properties);
      return [
        await create("events", { name: "Reminder probe", date: "2026-10-16", timeFrom: "10:00", alertMinutes: 15 }),
        await create("tasks", { name: "Reminder probe", date: "2026-10-16", timeFrom: "14:00", notifications: true }),
      ];
    };
    const foreign = await seedReminders(a);
    const own = await seedReminders(b);
    const request: Request = GET("/api/calendar/reminders?from=2026-10-16T00%3A00%3A00Z");
    const asB = await expectExcludesA(b.member, request, own);
    expectNoneOf(asB.text, foreign, "B's calendar reminders");
    const asA = await sendOk(a.member, request);
    expect(foreign.filter((id) => !asA.includes(id))).toEqual([]);
    expectNoneOf(asA, own, "A's calendar reminders");
    const invalid = await send(b.member, GET("/api/calendar/reminders?from=2026-10-16T00%3A00%3A00Z&hours=0"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },

  "sleep night put": async () => {
    const path = "/api/sleep/nights/2026-10-23";
    const foreignBedTime = "20:41";
    const ownBedTime = "20:43";
    const foreignAnswer = await sendOk(a.member, PUT(path, { bedTime: foreignBedTime }));
    const foreignPlanId = readString(foreignAnswer, "night", "planId");
    const asB = await send(b.member, PUT(path, { bedTime: ownBedTime }));
    expect(asB.status, asB.text).toBe(200);
    expectNoneOf(asB.text, [...a.ids, foreignPlanId], "B's sleep night put");
    expectText(asB.text, [`"bedTime":"${ownBedTime}"`], [foreignBedTime]);
    // So B's put wrote B's tenant and not A's.
    const asA = await sendOk(a.member, GET("/api/sleep/nights?from=2026-10-23&to=2026-10-23"));
    expectText(asA, [`"bedTime":"${foreignBedTime}"`], [ownBedTime]);
    const invalid = await send(b.member, PUT("/api/sleep/nights/2026-13-01", {}));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },

  // A has already materialized the 14 October occurrence, so B's request for that date meets a
  // stored occurrence of A and must still answer like a random id.
  "event occurrence materialize": async () => {
    const seed = async (tenant: TenantFixture): Promise<{ seriesId: string; eventsDatabaseId: string }> => {
      const eventsDatabaseId = await databaseIdFor(tenant.tenantId, "events");
      const seriesId = readString(
        await sendOk(
          tenant.member,
          POST(`/api/databases/${eventsDatabaseId}/items`, {
            properties: {
              name: "Occurrence probe",
              date: "2026-10-12",
              timeFrom: "09:00",
              timeTo: "09:30",
              recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
            },
          }),
        ),
        "id",
      );
      return { seriesId, eventsDatabaseId };
    };
    const [own, foreign] = [await seed(b), await seed(a)];
    const materializeOf = (seriesId: string | undefined, date = "2026-10-14"): Request =>
      POST(`/api/events/series/${seriesId}/occurrences/${date}`);
    const eventsOf = (caller: Caller, databaseId: string): Promise<string> =>
      sendOk(caller, POST(`/api/databases/${databaseId}/query`, {}));

    const foreignCreated = await send(a.member, materializeOf(foreign.seriesId));
    expect(foreignCreated.status, foreignCreated.text).toBe(201);
    const foreignOccurrenceId = readString(foreignCreated.text, "id");
    const [eventsOfA, eventsOfB] = [
      await eventsOf(a.member, foreign.eventsDatabaseId),
      await eventsOf(b.member, own.eventsDatabaseId),
    ];

    for (const date of ["2026-10-14", "2026-10-15"]) {
      const answer = await expectForeignLikeRandom(b.member, [foreign.seriesId], ([id]) => materializeOf(id, date));
      expect(answer.status, date).toBe(404);
      expectNoneOf(answer.text, [foreign.seriesId, foreignOccurrenceId], "B's refusal");
    }
    expect(await eventsOf(a.member, foreign.eventsDatabaseId)).toBe(eventsOfA);
    expect(await eventsOf(b.member, own.eventsDatabaseId)).toBe(eventsOfB);

    // The three answers a foreign series must not get.
    const created = await send(b.member, materializeOf(own.seriesId));
    expect(created.status, created.text).toBe(201);
    expect(readString(created.text, "properties", "seriesId")).toBe(own.seriesId);
    expect(readString(created.text, "properties", "occurrenceDate")).toBe("2026-10-14");
    expectNoneOf(created.text, [foreign.seriesId, foreignOccurrenceId], "B's occurrence");
    const again = await send(b.member, materializeOf(own.seriesId));
    expect(again.status).toBe(200);
    expect(readString(again.text, "id")).toBe(readString(created.text, "id"));
    expect((await send(b.member, materializeOf(own.seriesId, "2026-10-17"))).status).toBe(400);
    expectNoneOf(await eventsOf(b.member, own.eventsDatabaseId), [foreign.seriesId, foreignOccurrenceId], "B's Events");
  },
  // A's own list holds A's seeded trashed item, so the absence of A's rows from B's answer is
  // isolation and not an empty fixture.
  "list trash items": async () => {
    const seededId = readString(
      await sendOk(b.member, POST(`/api/databases/${b.databaseId}/items`, { properties: {} })),
      "id",
    );
    await sendOk(b.member, DELETE(`/api/items/${seededId}`));
    await expectExcludesA(b.member, GET("/api/trash/items?limit=200"), [seededId, b.trashedItemId]);
    expect(await sendOk(a.member, GET("/api/trash/items?limit=200"))).toContain(a.trashedItemId);
    const invalid = await send(b.member, GET("/api/trash/items?limit=0"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  // A's own list holds A's seeded archived database, so the absence of A's rows from B's answer is
  // isolation and not an empty fixture.
  "list trash databases": async () => {
    const ownId = readString(await sendOk(b.member, POST("/api/databases", { name: "Isolation trash probe" })), "id");
    await sendOk(b.member, DELETE(`/api/databases/${ownId}`));
    const request: Request = GET("/api/trash/databases");
    const answer = await expectExcludesA(b.member, request, [ownId, b.archivedDatabaseId]);
    expect(readIdArray(answer.text, "databases")).not.toContain(a.archivedDatabaseId);
    expect(readIdArray(await sendOk(a.member, request), "databases")).toContain(a.archivedDatabaseId);
  },
  // A's trashed item and archived database answer `not_found` exactly as random ids do. B also
  // restores rows of its own, so `not_found` is a refusal and not a route that restores nothing.
  "restore trash": () =>
    leavesAUnchanged(async () => {
      const ownItemId = readString(
        await sendOk(b.member, POST(`/api/databases/${b.databaseId}/items`, { properties: {} })),
        "id",
      );
      await sendOk(b.member, DELETE(`/api/items/${ownItemId}`));
      const ownDatabaseId = readString(
        await sendOk(b.member, POST("/api/databases", { name: "Isolation restore probe" })),
        "id",
      );
      await sendOk(b.member, DELETE(`/api/databases/${ownDatabaseId}`));
      const restoreOf = (itemId: string, databaseId: string): Request =>
        POST("/api/trash/restore", { itemIds: [itemId], databaseIds: [databaseId] });

      const own = await send(b.member, restoreOf(ownItemId, ownDatabaseId));
      expect(own.status, own.text).toBe(200);
      expect(restoreStatuses(own.text)).toEqual([
        { id: ownDatabaseId, status: "restored" },
        { id: ownItemId, status: "restored" },
      ]);
      const foreign = await expectForeignLikeRandom(
        b.member,
        [a.trashedItemId, a.archivedDatabaseId],
        ([itemId, databaseId]) => restoreOf(itemId ?? "", databaseId ?? ""),
      );
      expect(foreign.status, foreign.text).toBe(200);
      expect(restoreStatuses(foreign.text)).toEqual([
        { id: a.archivedDatabaseId, status: "not_found" },
        { id: a.trashedItemId, status: "not_found" },
      ]);
      expect(await sendOk(a.member, GET("/api/trash/items?limit=200"))).toContain(a.trashedItemId);
      expect(readIdArray(await sendOk(a.member, GET("/api/trash/databases")), "databases")).toContain(
        a.archivedDatabaseId,
      );
    }),

  // --- tenant: approvals, agent runs, MCP ----------------------------------------------------
  "approval queue": async () => {
    await expectExcludesA(b.member, GET("/api/approval-requests"), [b.approvalRequestId]);
  },
  "approval decision": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.approvalRequestId], ([id]) =>
        PATCH(`/api/approval-requests/${id}`, { decision: "approved" }),
      );
    }),
  "approval request detail": async () => {
    expect(readString(await sendOk(b.member, approvalRequestRead(b.approvalRequestId)), "id")).toBe(
      b.approvalRequestId,
    );
    expect(readString(await sendOk(a.member, approvalRequestRead(a.approvalRequestId)), "id")).toBe(
      a.approvalRequestId,
    );
    await expectForeign404(b.member, [a.approvalRequestId], ([id]) => approvalRequestRead(id ?? ""));
    const invalid = await send(b.member, approvalRequestRead("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "code")).toBe("validation_failed");
  },
  // So a count that reached A's request would differ by one.
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
      const listed = readIdArray(await sendOk(tenant.member, GET("/api/approval-requests")), "rows");
      expect(listed).toContain(own);
      expect(listed).not.toContain(foreign);
      const counted = await sendOk(tenant.member, GET("/api/approval-requests/count"));
      expect(readNumber(counted, "count")).toBe(listed.length);
      const filtered = "?status=pending&source=chat,tick,mcp";
      expect(readNumber(await sendOk(tenant.member, GET(`/api/approval-requests/count${filtered}`)), "count")).toBe(
        listed.length,
      );
    }
    expect(readNumber(await sendOk(b.member, GET("/api/approval-requests/count")), "count")).toBe(2);
    const invalid = await send(b.member, GET("/api/approval-requests/count?status=decided"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "code")).toBe("validation_failed");
  },
  "mcp json-rpc endpoint": () =>
    leavesAUnchanged(async () => {
      // Every operation is covered by the MCP describe below; this is the endpoint's own entry.
      await expectExcludesA(b.member, POST("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      await expectForeignLikeRandom(b.member, [a.itemId], ([itemId]) =>
        POST("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "semprec.item.get", arguments: { itemId } },
        }),
      );
    }),
  "semp thread detail": async () => {
    const answer = await expectForeign404(b.member, [a.sempThreadId], ([id]) => GET(`/api/semp/threads/${id}`));
    expect(readString(answer.text, "error", "code")).toBe("not_found");
    await sendOk(b.member, GET(`/api/semp/threads/${b.sempThreadId}`));
  },
  "semp thread create message": () =>
    leavesAUnchanged(async () => {
      const answer = await expectForeignLikeRandom(b.member, [a.itemId], ([id]) =>
        POST("/api/semp/threads", { text: "Question", subject: { inboxItemId: id } }),
      );
      expect(answer.status).toBe(400);
      const own = await send(b.member, POST("/api/semp/threads", { text: "Question" }));
      expect(own.status).toBe(202);
    }),
  "semp thread send message": () =>
    leavesAUnchanged(async () => {
      await expectForeign404(b.member, [a.sempThreadId], ([id]) =>
        POST(`/api/semp/threads/${id}/messages`, { text: "Question" }),
      );
      const own = await send(b.member, POST(`/api/semp/threads/${b.sempThreadId}/messages`, { text: "Question" }));
      expect(own.status).toBe(202);
    }),
  "semp thread messages": async () => {
    const answer = await expectForeign404(b.member, [a.sempThreadId], ([id]) =>
      GET(`/api/semp/threads/${id}/messages`),
    );
    expect(readString(answer.text, "error", "code")).toBe("not_found");
    await sendOk(b.member, GET(`/api/semp/threads/${b.sempThreadId}/messages`));
  },
  "semp thread list": async () => {
    await expectExcludesA(b.member, GET("/api/semp/threads?kind=chat,item,tick&limit=100"), [b.sempThreadId]);
    // Case rows, created by the capture write and the send route.
    const seedItemThread = async (fixture: TenantFixture) => {
      const databaseId = await databaseIdFor(fixture.tenantId, "inbox");
      const capture = await inTenantTransaction(fixture.tenantId, (client) =>
        createItemWithClient(client, {
          databaseId,
          properties: { date: "2026-01-01", time: "12:00", text: "Isolation capture" },
        }),
      );
      const sent = await sendOk(
        fixture.member,
        POST("/api/semp/threads", { text: "Isolation question", subject: { inboxItemId: capture.id } }),
      );
      return { threadId: readString(sent, "threadId"), subjectId: capture.id };
    };
    const foreign = await seedItemThread(a);
    const own = await seedItemThread(b);
    const answer = await expectForeignLikeRandom(b.member, [foreign.subjectId], ([id]) =>
      GET(`/api/semp/threads?subjectInboxItemId=${id}`),
    );
    expect(answer.status).toBe(200);
    expect(readIdArray(answer.text, "rows")).toEqual([]);
    const bySubject = async (member: Member, subjectId: string) =>
      readIdArray(await sendOk(member, GET(`/api/semp/threads?subjectInboxItemId=${subjectId}`)), "rows");
    expect(await bySubject(b.member, own.subjectId)).toEqual([own.threadId]);
    expect(await bySubject(a.member, foreign.subjectId)).toEqual([foreign.threadId]);
  },
  "semp message speech": () =>
    leavesAUnchanged(async () => {
      const created = await sendOk(
        b.member,
        POST(`/api/semp/threads/${b.sempThreadId}/messages`, { text: "Speech isolation" }),
      );
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
      await expectForeign404(b.member, [a.sempThreadId, foreignMessage], ([thread, message]) =>
        POST(`/api/semp/threads/${thread}/messages/${message}/speech`),
      );
      const wrongThread = await send(
        b.member,
        POST(`/api/semp/threads/${b.sempThreadId}/messages/${foreignMessage}/speech`),
      );
      expect(wrongThread.status).toBe(404);
      const own = await send(b.member, POST(`/api/semp/threads/${b.sempThreadId}/messages/${ownMessageId}/speech`));
      expect(own.status).toBe(200);
      expect(own.text).toBe("AB");
    }),
  // B's own run is in its answer, so an empty list cannot pass for isolation; A's own request still
  // returns A's run.
  "list agent runs": async () => {
    const listFor = (projectItemId: string): Request => GET(`/api/agent-runs?projectItemId=${projectItemId}`);
    const own = await expectExcludesA(b.member, listFor(b.projectItemId), [b.agentRunId]);
    expect(readIdArray(own.text, "rows")).toContain(b.agentRunId);
    const foreign = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) => listFor(id ?? ""));
    expect(foreign.status).toBe(200);
    expect(readIdArray(foreign.text, "rows")).toEqual([]);
    expect(readIdArray(await sendOk(a.member, listFor(a.projectItemId)), "rows")).toContain(a.agentRunId);
    const invalid = await send(b.member, listFor("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(readString(invalid.text, "error", "code")).toBe("validation_failed");
  },
  "semp message retry": async () => {
    // Played with the production writers of the turn.
    const seedFailedReply = (fixture: TenantFixture) =>
      inTenantTransaction(fixture.tenantId, async (client) => {
        const sent = await sendSempMessage(client, { text: "Retry isolation", context: [], hasContext: false });
        expect(await claimSempMessage(client, sent.threadId, sent.assistantMessageId)).toBe(true);
        expect(
          await finishSempMessageTurn(client, sent.assistantMessageId, { status: "error", errorCode: "modelError" }),
        ).toBe(true);
        return { threadId: sent.threadId, messageId: sent.assistantMessageId };
      });
    const foreign = await seedFailedReply(a);
    const own = await seedFailedReply(b);
    const messageIdsOf = (fixture: TenantFixture, threadId: string) =>
      inTenantTransaction(fixture.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>("SELECT id FROM semp_messages WHERE thread_id = $1", [
          threadId,
        ]);
        return rows.map((row) => row.id);
      });
    const foreignMessagesBefore = await messageIdsOf(a, foreign.threadId);
    await leavesAUnchanged(async () => {
      const answer = await expectForeign404(b.member, [foreign.threadId, foreign.messageId], ([thread, message]) =>
        POST(`/api/semp/threads/${thread}/messages/${message}/retry`),
      );
      expect(readString(answer.text, "error", "code")).toBe("not_found");
      // A's message id in a thread of B's own is not found there either.
      await expectForeign404(b.member, [foreign.messageId], ([message]) =>
        POST(`/api/semp/threads/${own.threadId}/messages/${message}/retry`),
      );
    });
    expect(await messageIdsOf(a, foreign.threadId)).toEqual(foreignMessagesBefore);
    const retried = await send(b.member, POST(`/api/semp/threads/${own.threadId}/messages/${own.messageId}/retry`));
    expect(retried.status, retried.text).toBe(202);
    expect(await messageIdsOf(b, own.threadId)).toContain(readString(retried.text, "messageId"));
  },
  "semp message regenerate": async () => {
    // Played with the production writers of the turn.
    const seedDoneReply = async (fixture: TenantFixture) => {
      const setup: ReplySetup = {
        admin: adminPool,
        pool,
        tenant: fixture.tenantId,
        userId: fixture.member.userId,
      };
      const chat = await createChatRun(setup);
      const played = await playReply(setup, chat, { userText: "Regenerate isolation", startMs: 0 });
      return { threadId: chat.threadId, messageId: played.assistantMessageId };
    };
    const foreign = await seedDoneReply(a);
    const own = await seedDoneReply(b);
    const messageIdsOf = (fixture: TenantFixture, threadId: string) =>
      inTenantTransaction(fixture.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string; replaced_by_message_id: string | null }>(
          "SELECT id, replaced_by_message_id FROM semp_messages WHERE thread_id = $1 ORDER BY id",
          [threadId],
        );
        return rows;
      });
    const foreignMessagesBefore = await messageIdsOf(a, foreign.threadId);
    await leavesAUnchanged(async () => {
      const answer = await expectForeign404(b.member, [foreign.threadId, foreign.messageId], ([thread, message]) =>
        POST(`/api/semp/threads/${thread}/messages/${message}/regenerate`),
      );
      expect(readString(answer.text, "error", "code")).toBe("not_found");
      // A's message id in a thread of B's own is not found there either.
      await expectForeign404(b.member, [foreign.messageId], ([message]) =>
        POST(`/api/semp/threads/${own.threadId}/messages/${message}/regenerate`),
      );
    });
    // No replacement was queued and the reply is not marked as replaced.
    expect(await messageIdsOf(a, foreign.threadId)).toEqual(foreignMessagesBefore);
    const regenerated = await send(
      b.member,
      POST(`/api/semp/threads/${own.threadId}/messages/${own.messageId}/regenerate`),
    );
    expect(regenerated.status, regenerated.text).toBe(202);
    expect((await messageIdsOf(b, own.threadId)).map((row) => row.id)).toContain(
      readString(regenerated.text, "messageId"),
    );
  },
  "agent run detail": async () => {
    await expectForeignLikeRandom(b.member, [a.agentRunId], ([id]) => GET(`/api/agent-runs/${id}`));
    // A run of B's tenant with another actor answers like an unknown id.
    const own = await send(b.member, GET(`/api/agent-runs/${b.agentRunId}`));
    expect(own.status, own.text).toBe(200);
    expect(own.text).toContain(b.agentRunId);
    // A run's actor must be a user of its own tenant (agent_runs_actor_user_id_tenant_fkey) and a
    // tenant has one user, so the admin connection skips foreign-key triggers for this one insert.
    const otherActorRun = await runInTenant(b.tenantId, () =>
      withTransaction(adminPool, async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        return createAgentRun(client, { triggeredBy: "user", task: "actor probe", userId: a.member.userId });
      }),
    );
    const otherActor = await expectForeignLikeRandom(b.member, [otherActorRun.id], ([id]) =>
      GET(`/api/agent-runs/${id}`),
    );
    // Removed before the assertions, so no later case meets a run of a foreign actor.
    const removed = await adminPool.query("DELETE FROM agent_runs WHERE id = $1", [otherActorRun.id]);
    expect(removed.rowCount).toBe(1);
    expect(otherActor.status).toBe(404);
    // A message of A answers B like a random id, whether B asks about its own run or A's.
    const ownReply = await seedScopedReply(b.tenantId, b.member.userId);
    const foreignReply = await seedScopedReply(a.tenantId, a.member.userId);
    try {
      const foreignMessage = await expectForeignLikeRandom(b.member, [foreignReply.messageId], ([id]) =>
        GET(`/api/agent-runs/${ownReply.runId}?messageId=${id}`),
      );
      const foreignRun = await expectForeignLikeRandom(b.member, [foreignReply.runId], ([id]) =>
        GET(`/api/agent-runs/${id}?messageId=${foreignReply.messageId}`),
      );
      expect(foreignMessage.status).toBe(404);
      expect(foreignRun.status).toBe(404);
      expectNoneOf(
        foreignMessage.text + foreignRun.text,
        [foreignReply.messageId, foreignReply.runId],
        "agent run detail",
      );
      const ownScoped = await send(b.member, GET(`/api/agent-runs/${ownReply.runId}?messageId=${ownReply.messageId}`));
      expect(ownScoped.status, ownScoped.text).toBe(200);
      expectText(ownScoped.text, [ownReply.runId, "scope probe"], []);
    } finally {
      await removeScopedReply(ownReply);
      await removeScopedReply(foreignReply);
    }
  },
  "agent run steps": async () => {
    // A's run has an opening `run_status` event, so an unchecked answer would carry its id as a
    // step id.
    const foreign = await expectForeign404(b.member, [a.agentRunId], ([id]) => GET(`/api/agent-runs/${id}/steps`));
    expectNoneOf(foreign.text, [a.agentRunId, `"stepId":"${a.agentRunEventId}"`], "agent run steps");
    const own = await send(b.member, GET(`/api/agent-runs/${b.agentRunId}/steps`));
    expect(own.status, own.text).toBe(200);
    expect(own.text).toContain(`"stepId":"${b.agentRunEventId}"`);
    // A run of B's tenant with another actor answers like an unknown id; the actor foreign key is
    // skipped as in "agent run detail".
    const otherActor = await runInTenant(b.tenantId, () =>
      withTransaction(adminPool, async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        const run = await createAgentRun(client, { triggeredBy: "user", task: "actor probe", userId: a.member.userId });
        const event = await insertAgentRunEvent(client, run.id, "run_status", { status: "running" });
        return { runId: run.id, eventId: event.id };
      }),
    );
    const answer = await expectForeignLikeRandom(b.member, [otherActor.runId], ([id]) =>
      GET(`/api/agent-runs/${id}/steps`),
    );
    const removedEvents = await adminPool.query("DELETE FROM agent_run_events WHERE agent_run_id = $1", [
      otherActor.runId,
    ]);
    expect(removedEvents.rowCount).toBe(1);
    const removed = await adminPool.query("DELETE FROM agent_runs WHERE id = $1", [otherActor.runId]);
    expect(removed.rowCount).toBe(1);
    expect(answer.status).toBe(404);
    expectNoneOf(answer.text, [`"stepId":"${otherActor.eventId}"`], "agent run steps of another actor");
    // A message of A answers B like a random id, whether B asks about its own run or A's.
    const ownReply = await seedScopedReply(b.tenantId, b.member.userId);
    const foreignReply = await seedScopedReply(a.tenantId, a.member.userId);
    try {
      const foreignMessage = await expectForeignLikeRandom(b.member, [foreignReply.messageId], ([id]) =>
        GET(`/api/agent-runs/${ownReply.runId}/steps?messageId=${id}`),
      );
      const foreignRun = await expectForeignLikeRandom(b.member, [foreignReply.runId], ([id]) =>
        GET(`/api/agent-runs/${id}/steps?messageId=${foreignReply.messageId}`),
      );
      expect(foreignMessage.status).toBe(404);
      expect(foreignRun.status).toBe(404);
      expectNoneOf(
        foreignMessage.text + foreignRun.text,
        [foreignReply.messageId, foreignReply.runId, `"stepId":"${foreignReply.eventId}"`],
        "agent run steps",
      );
      const ownScoped = await send(
        b.member,
        GET(`/api/agent-runs/${ownReply.runId}/steps?messageId=${ownReply.messageId}`),
      );
      expect(ownScoped.status, ownScoped.text).toBe(200);
      expect(JSON.parse(ownScoped.text)).toMatchObject({ steps: [], truncatedHistory: false });
    } finally {
      await removeScopedReply(ownReply);
      await removeScopedReply(foreignReply);
    }
  },
  // A retryable run is seeded for each tenant, so a 404 for B shows the tenant scope and not the
  // eligibility rules. B's retry of A's run queues no job and leaves it without a successor; a run
  // of B's tenant with another actor answers the same 404.
  "retry agent run": async () => {
    const seedRetryableRun = (tenant: TenantFixture, userId: string, task: string) =>
      runInTenant(tenant.tenantId, async () => {
        // Only the sweep inserts an occurrence, for a due rule at a time the test cannot set.
        const occurrence = await pool.query<{ id: string }>(
          `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
           VALUES ($1, now(), '{"kind":"interval","minutes":5}'::jsonb, 'failed') RETURNING id`,
          [tenant.heartbeatId],
        );
        const occurrenceId = occurrence.rows[0]!.id;
        const run = await createAgentRun(pool, {
          projectItemId: tenant.projectItemId,
          heartbeatId: tenant.heartbeatId,
          heartbeatOccurrenceId: occurrenceId,
          triggeredBy: "heartbeat",
          task,
          userId,
        });
        await finishAgentRun(pool, run.id, "error", "internal");
        return { runId: run.id, occurrenceId };
      });
    const jobsOf = async (runId: string): Promise<number> => {
      const { rows } = await adminPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1",
        [retryHeartbeatFireJobKey(runId)],
      );
      return rows[0]!.count;
    };
    const successorsOf = async (runId: string): Promise<number> => {
      const { rows } = await adminPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agent_runs WHERE retry_of_run_id = $1",
        [runId],
      );
      return rows[0]!.count;
    };
    const foreignRun = await seedRetryableRun(a, a.member.userId, "retry isolation of A");
    const ownRun = await seedRetryableRun(b, b.member.userId, "retry isolation of B");
    // A run's actor must be a user of its own tenant (agent_runs_actor_user_id_tenant_fkey) and a
    // tenant has one user, so the admin connection skips foreign-key triggers for this one insert.
    const otherActorRun = await runInTenant(b.tenantId, () =>
      withTransaction(adminPool, async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        return createAgentRun(client, {
          projectItemId: b.projectItemId,
          heartbeatId: b.heartbeatId,
          heartbeatOccurrenceId: ownRun.occurrenceId,
          triggeredBy: "heartbeat",
          task: "retry actor probe",
          userId: a.member.userId,
        });
      }),
    );
    const failActorRun = await adminPool.query(
      "UPDATE agent_runs SET status = 'error', error_code = 'internal', finished_at = now() WHERE id = $1",
      [otherActorRun.id],
    );
    expect(failActorRun.rowCount).toBe(1);
    try {
      await expectForeign404(b.member, [foreignRun.runId], ([id]) => POST(`/api/agent-runs/${id}/retry`));
      expect(await jobsOf(foreignRun.runId)).toBe(0);
      expect(await successorsOf(foreignRun.runId)).toBe(0);
      await expectForeign404(b.member, [otherActorRun.id], ([id]) => POST(`/api/agent-runs/${id}/retry`));
      expect(await jobsOf(otherActorRun.id)).toBe(0);
      const own = await send(b.member, POST(`/api/agent-runs/${ownRun.runId}/retry`));
      expect(own.status, own.text).toBe(202);
      expect(await jobsOf(ownRun.runId)).toBe(1);
      expect(await jobsOf(foreignRun.runId)).toBe(0);
    } finally {
      // Removed before any later case reads the tenants' runs: the jobs, then the runs, then the
      // occurrences.
      await adminPool.query("SELECT graphile_worker.remove_job($1)", [retryHeartbeatFireJobKey(ownRun.runId)]);
      const removed = await adminPool.query("DELETE FROM agent_runs WHERE id = ANY($1::uuid[])", [
        [foreignRun.runId, ownRun.runId, otherActorRun.id],
      ]);
      expect(removed.rowCount).toBe(3);
      await adminPool.query("DELETE FROM heartbeat_occurrences WHERE id = ANY($1::uuid[])", [
        [foreignRun.occurrenceId, ownRun.occurrenceId],
      ]);
    }
  },
  "mint mcp run credential": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.projectItemId], ([projectItemId]) =>
        POST("/api/agent-runs/mcp-credentials", { projectItemId, capabilities: ["core.item.read"] }),
      );
    }),
  "project mcp grants": async () => {
    const answer = await expectForeignLikeRandom(b.member, [a.projectItemId], ([id]) =>
      GET(`/api/projects/${id}/mcp-grants`),
    );
    expectNoneOf(answer.text, a.ids, "project mcp grants");
  },
  "project mcp grant toggle": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.projectItemId, a.mcpToolRegistrationId], ([project, tool]) =>
        PATCH(`/api/projects/${project}/mcp-grants/${tool}`, { granted: false }),
      );
      // A's tool registration on a random project, against a random registration.
      await expectForeignLikeRandom(b.member, [a.mcpToolRegistrationId], ([tool]) =>
        PATCH(`/api/projects/${randomUUID()}/mcp-grants/${tool}`, { granted: true }),
      );
      // B's own registration granted on A's project, against a random project. The route writes a
      // grant for any project id, so both succeed and differ only by their timestamps.
      const grant = (project: string): Request =>
        PATCH(`/api/projects/${project}/mcp-grants/${b.mcpToolRegistrationId}`, { granted: true });
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
  "project database grants": async () => {
    const own = await sendOk(b.member, GET(`/api/projects/${b.projectItemId}/database-grants`));
    expect(own).toContain(b.databaseId);
    const answer = await expectForeign404(b.member, [a.projectItemId], ([id]) =>
      GET(`/api/projects/${id}/database-grants`),
    );
    expectNoneOf(answer.text, a.ids, "project database grants");
    // B's own project lists B's databases only: none of A's user-created or system databases.
    await expectExcludesA(b.member, GET(`/api/projects/${b.projectItemId}/database-grants`), [b.databaseId]);
  },
  "project database grant set": () =>
    leavesAUnchanged(async () => {
      const storedGrants = async (): Promise<string[]> => {
        const { rows } = await adminPool.query<{ project_item_id: string; database_id: string; access: string }>(
          "SELECT project_item_id, database_id, access FROM agent_database_grants WHERE project_item_id = ANY($1) ORDER BY project_item_id, database_id",
          [[a.projectItemId, b.projectItemId]],
        );
        return rows.map((row) => `${row.project_item_id} ${row.database_id} ${row.access}`);
      };
      const before = await storedGrants();
      // A's project, with B's own database and with A's.
      for (const databaseId of [b.databaseId, a.databaseId]) {
        await expectForeign404(b.member, [a.projectItemId], ([id]) =>
          PATCH(`/api/projects/${id}/database-grants`, { databaseId, access: "none" }),
        );
      }
      await expectForeign404(b.member, [a.databaseId], ([id]) =>
        PATCH(`/api/projects/${b.projectItemId}/database-grants`, { databaseId: id, access: "none" }),
      );
      expect(await storedGrants()).toEqual(before);
    }),
  // Each project gets one switched-off user automation (no sweep touches it): B lists B's only.
  "project heartbeats": async () => {
    const heartbeatIds: string[] = [];
    for (const fixture of [a, b]) {
      const heartbeat = await inTenantTransaction(fixture.tenantId, (client) =>
        createHeartbeat(client, {
          projectItemId: fixture.projectItemId,
          name: "Isolation automation",
          rule: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "08:30" },
          actionId: "noop",
          enabled: false,
          origin: "user",
        }),
      );
      heartbeatIds.push(heartbeat.id);
    }
    const [aHeartbeatId, bHeartbeatId] = heartbeatIds as [string, string];
    const own = await expectExcludesA(
      b.member,
      GET(`/api/projects/${b.projectItemId}/heartbeats`),
      [bHeartbeatId],
      [aHeartbeatId],
    );
    expect(own.text).toContain('"ruleLabel":"');
    const answer = await expectForeign404(b.member, [a.projectItemId], ([id]) => GET(`/api/projects/${id}/heartbeats`));
    expectNoneOf(answer.text, [...a.ids, aHeartbeatId], "project heartbeats");
  },
  // A fresh project of B, so its counts are known without leaning on rows other cases change.
  "project agent summary": async () => {
    const projectItemId = await runInTenant(b.tenantId, () => createTestProjectItem(pool));
    await runInTenant(b.tenantId, async () => {
      await withTransaction(pool, async (client) => {
        await createHeartbeat(client, {
          projectItemId,
          name: "Summary automation",
          rule: { kind: "interval", minutes: 5 },
          actionId: "noop",
          origin: "user",
        });
        await setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: b.mcpToolRegistrationId,
          granted: true,
        });
      });
    });
    const own = await sendOk(b.member, GET(`/api/projects/${projectItemId}/agent-summary`));
    expect(JSON.parse(own)).toEqual({
      hasGuidance: false,
      guidanceUpdatedAt: null,
      grantedToolCount: 1,
      enabledHeartbeatCount: 1,
      attention: { activeDriftFindings: 0, failingHeartbeats: 0, pendingApprovals: 0, needsAttention: false },
    });
    const answer = await expectForeign404(b.member, [a.projectItemId], ([id]) =>
      GET(`/api/projects/${id}/agent-summary`),
    );
    expectNoneOf(answer.text, a.ids, "project agent summary");
  },
  "mcp tool registration reclassify": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.mcpToolRegistrationId], ([id]) =>
        PATCH(`/api/mcp-tool-registrations/${id}`, { requiresApproval: false, riskClass: "read" }),
      );
    }),
  // The sync would record `syncStatus: "error"` on A's server, which `leavesAUnchanged` reads.
  "mcp server sync": () =>
    leavesAUnchanged(async () => {
      await expectForeign404(b.member, [a.mcpServerItemId], ([id]) => POST(`/api/mcp-servers/${id}/sync`));
    }),

  // --- tenant: databases ---------------------------------------------------------------------
  "list databases": async () => {
    await expectExcludesA(b.member, GET("/api/databases?limit=200"), [b.databaseId, b.targetDatabaseId]);
  },
  "create database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([parentItemId]) =>
        POST("/api/databases", { name: "Child of a foreign item", parentItemId }),
      );
      const footprint = () =>
        runInTenant(b.tenantId, () =>
          pool.query<{ databases: number; properties: number }>(
            "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties",
          ),
        );
      const before = (await footprint()).rows;
      const foreignAnswer = await expectForeignLikeRandom(b.member, [a.targetDatabaseId], ([targetDatabaseId]) =>
        POST("/api/databases", {
          name: "Foreign target",
          properties: [
            { key: "target", name: "Target", type: "relation", targetDatabaseId, cardinality: "many_to_many" },
          ],
        }),
      );
      expect(foreignAnswer.status).toBeGreaterThanOrEqual(400);
      expect(foreignAnswer.status).toBeLessThan(500);
      expect((await footprint()).rows).toEqual(before);
    }),
  "database detail": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => GET(`/api/databases/${id}`));
  },
  "rename database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) =>
        PATCH(`/api/databases/${id}`, { name: "Renamed by B" }),
      );
    }),
  "archive database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => DELETE(`/api/databases/${id}`));
    }),
  "restore database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.archivedDatabaseId], ([id]) =>
        POST(`/api/databases/${id}/restore`, {}),
      );
    }),
  "property catalog": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => GET(`/api/databases/${id}/properties`));
  },
  "create property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) =>
        POST(`/api/databases/${id}/properties`, { key: "probe", name: "Probe", type: "text" }),
      );
      await expectForeignLikeRandom(b.member, [a.targetDatabaseId], ([targetDatabaseId]) =>
        POST(`/api/databases/${b.databaseId}/properties`, {
          key: "probeRelation",
          name: "Probe relation",
          type: "relation",
          targetDatabaseId,
          cardinality: "many_to_many",
          locked: false,
        }),
      );
    }),
  "property list": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => GET(`/api/properties?databaseId=${id}`));
  },
  "property detail": async () => {
    await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) => GET(`/api/properties/${id}`));
  },
  "update property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) =>
        PATCH(`/api/properties/${id}`, { name: "Renamed by B" }),
      );
    }),
  "delete property": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.propertyId], ([id]) => DELETE(`/api/properties/${id}`));
    }),
  "add property option": async () => {
    const aTags = await healthTagsPropertyId(a);
    const label = "Isolation add probe";
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [aTags], ([id]) => POST(`/api/properties/${id}/options`, { label }));
    });
    // The same request on B's property is served, so the foreign answer is a refusal of A's row.
    const bProperty = await caseOptionPropertyId(b, "Isolation option add");
    const own = await send(b.member, POST(`/api/properties/${bProperty}/options`, { label }));
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
    // A seeded option of A's Health records, so a foreign rename would find its target.
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [aTags], ([id]) => PATCH(`/api/properties/${id}/options/medication`, { label }));
    });
    // The same kind of request on B's property is served, so the foreign answer is a refusal of A's
    // row.
    const bProperty = await caseOptionPropertyId(b, "Isolation option update");
    const own = await send(b.member, PATCH(`/api/properties/${bProperty}/options/one`, { label }));
    expect(own.status, own.text).toBe(200);
    expect(await storedOptions(b, bProperty)).toEqual([{ key: "one", label }]);
    const aOptions = await storedOptions(a, aTags);
    expect(aOptions).toContainEqual(SEEDED_MEDICATION_OPTION);
    expect(aOptions.map((option) => option.label)).not.toContain(label);
  },

  // --- tenant: views -------------------------------------------------------------------------
  "list views": async () => {
    // Curated views only; database-linked ones are listed per database.
    await expectExcludesA(b.member, GET("/api/views?limit=200"), [b.curatedViewId]);
  },
  "view detail": async () => {
    await expectForeignLikeRandom(b.member, [a.viewId], ([id]) => GET(`/api/views/${id}`));
  },
  "create view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) =>
        POST(`/api/databases/${id}/views`, { type: "table", name: "Probe" }),
      );
    }),
  "patch view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.viewId], ([id]) =>
        PATCH(`/api/views/${id}`, { name: "Renamed by B" }),
      );
    }),
  "delete view": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.viewId], ([id]) => DELETE(`/api/views/${id}`));
    }),
  // Position 1 moves A's first curated item behind its second, so a foreign write that landed would
  // change the order.
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
      await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) =>
        POST(`/api/databases/${id}/items`, { properties: {} }),
      );
    }),
  "item detail": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}`));
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}?include=path`));
  },
  "patch item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) =>
        PATCH(`/api/items/${id}`, { properties: { [a.propertyKey]: "written by B" }, ifVersion: a.itemVersion }),
      );
    }),
  "delete item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => DELETE(`/api/items/${id}`));
    }),
  "restore item": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.trashedItemId], ([id]) => POST(`/api/items/${id}/restore`, {}));
    }),
  "query database": async () => {
    await expectForeignLikeRandom(b.member, [a.databaseId], ([id]) => POST(`/api/databases/${id}/query`, {}));
    const ownQueries: Array<{ databaseId: string; inTrash: boolean; ownIds: string[] }> = [
      { databaseId: b.databaseId, inTrash: false, ownIds: [b.itemId] },
      { databaseId: b.databaseId, inTrash: true, ownIds: [b.trashedItemId] },
      { databaseId: b.targetDatabaseId, inTrash: false, ownIds: [b.targetItemId] },
      { databaseId: b.targetDatabaseId, inTrash: true, ownIds: [] },
    ];
    for (const { databaseId, inTrash, ownIds } of ownQueries) {
      await expectExcludesA(b.member, POST(`/api/databases/${databaseId}/query`, { inTrash }), ownIds);
    }
  },
  "query view": async () => {
    for (const viewId of [a.viewId, a.curatedViewId]) {
      await expectForeignLikeRandom(b.member, [viewId], ([id]) => POST(`/api/views/${id}/query`, {}));
    }
    for (const viewId of [b.viewId, b.curatedViewId]) {
      await expectExcludesA(b.member, POST(`/api/views/${viewId}/query`, {}), [b.itemId]);
    }
  },
  "create/replace relation": () =>
    leavesAUnchanged(async () => {
      // Metadata A's edge does not carry, so a foreign replace that landed changes it.
      await relationCases("PUT", { metadata: { writtenBy: "B" } });
    }),
  "set relation": () =>
    leavesAUnchanged(async () => {
      const key = `single${randomUUID().replaceAll("-", "")}`;
      await sendOk(
        b.member,
        POST(`/api/databases/${b.databaseId}/properties`, {
          key,
          name: "Single link",
          type: "relation",
          targetDatabaseId: b.targetDatabaseId,
          cardinality: "one_to_one",
          locked: false,
        }),
      );
      await sendOk(b.member, PUT(`/api/items/${b.itemId}/relations/${key}`, { targetItemId: b.targetItemId }));
      const before = await sendOk(b.member, GET(`/api/items/${b.itemId}/relations?propertyKey=${key}`));
      await expectForeignLikeRandom(b.member, [a.targetItemId], ([targetItemId]) =>
        PUT(`/api/items/${b.itemId}/relations/${key}`, { targetItemId }),
      );
      expect(await sendOk(b.member, GET(`/api/items/${b.itemId}/relations?propertyKey=${key}`))).toBe(before);
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) =>
        PUT(`/api/items/${id}/relations/${key}`, { targetItemId: b.targetItemId }),
      );
    }),
  "unlink value": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => POST(`/api/items/${id}/links/exampleKey/unlink`));
  },
  "relink value": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => POST(`/api/items/${id}/links/exampleKey/relink`));
  },
  "delete relation": () =>
    leavesAUnchanged(async () => {
      await relationCases("DELETE", undefined);
    }),
  "list relations": async () => {
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}/relations`));
    await expectForeignLikeRandom(b.member, [a.itemId], ([id]) =>
      GET(`/api/items/${id}/relations?propertyKey=${a.relationPropertyKey}`),
    );
  },
  "list related collections": async () => {
    for (const foreignId of [a.itemId, a.targetItemId]) {
      await expectForeignLikeRandom(b.member, [foreignId], ([id]) => GET(`/api/items/${id}/related`));
    }
    await expectExcludesA(b.member, GET(`/api/items/${b.targetItemId}/related`), [b.databaseId]);
  },
  "item delete impact": async () => {
    for (const foreignId of [a.itemId, a.targetItemId]) {
      await expectForeignLikeRandom(b.member, [foreignId], ([id]) => GET(`/api/items/${id}/delete-impact`));
    }
    // Two records of an inline database seeded for this case.
    await runInTenant(b.tenantId, async () => {
      const chokePoint = createChokePoint(pool);
      const inline = await chokePoint.createInlineDatabase({
        name: "Delete impact rows",
        parentItemId: b.targetItemId,
      });
      for (let index = 0; index < 2; index += 1) await chokePoint.createItem({ databaseId: inline.id, properties: {} });
    });
    const own = await expectExcludesA(b.member, GET(`/api/items/${b.targetItemId}/delete-impact`));
    expect(JSON.parse(own.text)).toMatchObject({ subtreeItemCount: 2, subtreePageCount: 0, linksToOwn: [] });
  },
  "count items": async () => {
    // Alone, grouped, with the collection filter, and behind an entry of B's own, where one
    // unresolvable entry fails the whole batch.
    const foreignEntries: Array<(values: readonly string[]) => Record<string, unknown>[]> = [
      ([databaseId]) => [{ databaseId }],
      ([databaseId]) => [{ databaseId, groupBy: a.relationPropertyKey }],
      ([databaseId]) => [{ databaseId, collection: true }],
      ([databaseId]) => [{ databaseId: b.databaseId }, { databaseId }],
    ];
    for (const items of foreignEntries) {
      await expectForeign404(b.member, [a.databaseId], (values) => POST("/api/items/count", { items: items(values) }));
    }
    await expectExcludesA(
      b.member,
      POST("/api/items/count", {
        items: [{ databaseId: b.databaseId, groupBy: b.relationPropertyKey }, { databaseId: b.targetDatabaseId }],
      }),
      [b.databaseId, b.targetDatabaseId, b.targetItemId],
    );
  },
  "database facets": async () => {
    // For a text facet, a relation facet and a path through it, and under a filter with an open
    // filter.
    const present = { type: "is_not_empty", property: a.propertyKey };
    const foreignBodies: Record<string, unknown>[] = [
      { facets: [a.propertyKey] },
      { facets: [a.relationPropertyKey, { path: [a.relationPropertyKey, a.propertyKey] }] },
      { facets: [a.propertyKey], filter: present, extra: { open: present } },
    ];
    for (const body of foreignBodies) {
      await expectForeign404(b.member, [a.databaseId], ([id]) => POST(`/api/databases/${id}/facets`, body));
    }
    await expectExcludesA(
      b.member,
      POST(`/api/databases/${b.databaseId}/facets`, { facets: [b.relationPropertyKey, b.propertyKey] }),
      [b.targetItemId],
    );
  },
  // B's origin read of A's confirmed item answers like a random id and like B's own hand-made item,
  // so the 404 has one body whatever its cause. B's read of its own confirmed item names its own
  // card, Inbox item and person.
  "item origin": async () => {
    interface ConfirmedCapture {
      cardId: string;
      inboxItemId: string;
      companyId: string;
      personId: string;
    }
    const seedConfirmed = async (tenant: TenantFixture, text: string): Promise<ConfirmedCapture> => {
      const seeded = await inTenantTransaction(tenant.tenantId, async (client) => {
        const companies = await moduleDatabase(client, "companies");
        const inboxItemId = await createInboxItem(client, text);
        const envelope = {
          entityKind: "database",
          target: companies.id,
          properties: { name: `${text} company` },
          operations: [
            {
              ref: "company",
              op: "create",
              databaseKey: "companies",
              role: "primary",
              properties: { name: `${text} company` },
            },
            {
              ref: "person",
              op: "create",
              databaseKey: "people",
              role: "secondary",
              properties: { name: `${text} person` },
              relations: { companies: [{ ref: "company" }] },
            },
          ],
        };
        const cardId = await createProposalCard(client, { proposal: envelope });
        await linkProposalSource(client, cardId, inboxItemId);
        return { cardId, inboxItemId };
      });
      await sendOk(tenant.member, POST(`/api/proposals/${seeded.cardId}/confirm`, {}));
      const created = await inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ item_id: string; module: string }>(
          `SELECT o.item_id, d.owner_module_id AS module
             FROM item_origins o JOIN items i ON i.id = o.item_id JOIN databases d ON d.id = i.database_id
            WHERE o.proposal_id = $1`,
          [seeded.cardId],
        );
        return rows;
      });
      const companyId = created.find((row) => row.module === "companies")?.item_id;
      const personId = created.find((row) => row.module === "people")?.item_id;
      if (!companyId || !personId)
        throw new Error(`the confirm wrote no company and person in tenant ${tenant.tenantId}`);
      return { ...seeded, companyId, personId };
    };
    const originPath = (id: string) => `/api/items/${id}/origin`;
    const [own, foreign] = [await seedConfirmed(b, "Origin probe of B"), await seedConfirmed(a, "Origin probe of A")];

    const refused = await expectForeign404(b.member, [foreign.companyId], ([id]) => GET(`/api/items/${id}/origin`));
    expect(refused.text).toContain('"not_found"');
    // No origin row; its answer is the foreign one to the byte.
    const byHand = await send(b.member, GET(originPath(b.itemId)));
    expect(byHand.status).toBe(404);
    expect(byHand.text).toBe(refused.text);

    const answer = await expectExcludesA(
      b.member,
      GET(originPath(own.companyId)),
      [own.cardId, own.inboxItemId, own.personId],
      [foreign.cardId, foreign.inboxItemId, foreign.companyId, foreign.personId],
    );
    expectText(answer.text, ["Origin probe of B person"], ["Origin probe of A"]);
    const foreignOwn = await send(a.member, GET(originPath(foreign.companyId)));
    expect(foreignOwn.status, foreignOwn.text).toBe(200);
    expect(foreignOwn.text).toContain(foreign.cardId);
  },

  // --- tenant: files, exports, account deletion ----------------------------------------------
  "ensure page": async () => {
    const before = await send(a.member, GET(`/api/items/${a.itemId}/page`));
    expect(before.status).toBe(200);
    await expectForeign404(b.member, [a.itemId], ([id]) => PUT(`/api/items/${id}/page`));
    expect(await send(a.member, GET(`/api/items/${a.itemId}/page`))).toEqual(before);
    const own = await send(b.member, PUT(`/api/items/${b.itemId}/page`));
    expect(own.status).toBe(200);
  },
  "get page": async () => {
    await expectForeign404(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}/page`));
    expect((await send(b.member, GET(`/api/items/${b.itemId}/page`))).status).toBe(200);
  },
  "list page changes": async () => {
    const since = encodeURIComponent(new Date(Date.now() - 1_000).toISOString());
    await expectForeign404(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}/page/changes?since=${since}`));
    const created = await send(b.member, POST(`/api/databases/${b.databaseId}/items`, { properties: {} }));
    expect(created.status, created.text).toBe(201);
    const fresh = z.object({ id: z.string() }).parse(JSON.parse(created.text)).id;
    const own = await send(b.member, GET(`/api/items/${fresh}/page/changes?since=${since}`));
    expect(own.status, own.text).toBe(200);
    expect(JSON.parse(own.text)).toEqual([]);
  },
  "read page markdown": async () => {
    await expectForeign404(b.member, [a.itemId], ([id]) => GET(`/api/items/${id}/page.md`));
    const own = await send(b.member, GET(`/api/items/${b.itemId}/page.md`));
    expect(own.status, own.text).toBe(200);
    expectNoneOf(own.text, a.ids, "B's own page.md");
  },
  "replace page markdown": () =>
    leavesAUnchanged(async () => {
      const markdownHeaders = (etag: string) => ({ "Content-Type": "text/markdown", "If-Match": `"${etag}"` });
      // Even with a current-looking token; nothing of A's is written.
      await expectForeign404(b.member, [a.itemId], ([id]) => ({
        method: "PUT",
        path: `/api/items/${id}/page.md`,
        headers: markdownHeaders("A".repeat(43)),
        body: "Foreign text",
      }));
      const fresh = readString(
        await sendOk(b.member, POST(`/api/databases/${b.databaseId}/items`, { properties: {} })),
        "id",
      );
      const read = await send(b.member, GET(`/api/items/${fresh}/page.md`));
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
      await expectForeign404(b.member, [a.itemId], ([id]) =>
        POST(`/api/items/${id}/page/insert`, { placement: "end", markdown: "Foreign text" }),
      );
      const own = await send(
        b.member,
        POST(`/api/items/${b.itemId}/page/insert`, { placement: "end", markdown: "Own text" }),
      );
      expect(own.status, own.text).toBe(200);
      expectNoneOf(own.text, a.ids, "B's own insert");
    }),
  "create subpage": () =>
    leavesAUnchanged(async () => {
      await expectForeign404(b.member, [a.itemId], ([id]) =>
        POST(`/api/items/${id}/page/subpages`, { title: "Foreign subpage" }),
      );
      const own = await send(b.member, POST(`/api/items/${b.itemId}/page/subpages`, { title: "Own subpage" }));
      expect(own.status, own.text).toBe(201);
      expectNoneOf(own.text, a.ids, "B's own subpage");
    }),
  "duplicate page": async () => {
    const foreign = await seedSubpage(a);
    const own = await seedSubpage(b);
    const readForeignHost = () => send(a.member, GET(`/api/items/${foreign.hostItemId}/page`));
    const before = await readForeignHost();
    expect(before.status, before.text).toBe(200);
    await leavesAUnchanged(async () => {
      // So does A's host item, which is not a page at all.
      for (const foreignId of [foreign.pageItemId, a.itemId]) {
        await expectForeign404(b.member, [foreignId], ([id]) => POST(`/api/items/${id}/page/duplicate`));
      }
      const copied = await send(b.member, POST(`/api/items/${own.pageItemId}/page/duplicate`));
      expect(copied.status, copied.text).toBe(201);
      expectNoneOf(copied.text, [...a.ids, foreign.hostItemId, foreign.pageItemId], "B's own duplicate");
    });
    // No copy was placed in it.
    expect(await readForeignHost()).toEqual(before);
  },
  "rename page": async () => {
    const foreign = await seedSubpage(a);
    const own = await seedSubpage(b);
    const readForeign = async (): Promise<Answer[]> => [
      await send(a.member, GET(`/api/items/${foreign.hostItemId}/page`)),
      await send(a.member, GET(`/api/items/${foreign.pageItemId}`)),
    ];
    const before = await readForeign();
    expect(before.map((answer) => answer.status)).toEqual([200, 200]);
    await leavesAUnchanged(async () => {
      // So does A's host item, which is not a page at all.
      for (const foreignId of [foreign.pageItemId, a.itemId]) {
        await expectForeign404(b.member, [foreignId], ([id]) =>
          PATCH(`/api/items/${id}/page/title`, { title: "Foreign title" }),
        );
      }
      const renamed = await send(b.member, PATCH(`/api/items/${own.pageItemId}/page/title`, { title: "Own title" }));
      expect(renamed.status, renamed.text).toBe(200);
      expectNoneOf(renamed.text, [...a.ids, foreign.hostItemId, foreign.pageItemId], "B's own rename");
    });
    // On its item and in the block of its host's page.
    expect(await readForeign()).toEqual(before);
  },
  "convert page block": async () => {
    const foreign = await seedSubpage(a);
    const own = await seedSubpage(b);
    const foreignBlockId = await firstBlockIdOfPage(a.member, foreign.hostItemId);
    const ownBlockId = await firstBlockIdOfPage(b.member, own.hostItemId);
    const readForeign = async (): Promise<Answer[]> => [
      await send(a.member, GET(`/api/items/${foreign.hostItemId}/page`)),
      await send(a.member, GET(`/api/items/${foreign.pageItemId}`)),
    ];
    const before = await readForeign();
    expect(before.map((answer) => answer.status)).toEqual([200, 200]);
    await leavesAUnchanged(async () => {
      await expectForeign404(b.member, [foreign.hostItemId], ([id]) =>
        POST(`/api/items/${id}/page/convert`, { blockId: foreignBlockId, type: "text", confirmedPageCount: 1 }),
      );
      // B learns nothing about A's blocks.
      const refusedBlock = await expectForeignLikeRandom(b.member, [foreignBlockId], ([blockId]) =>
        POST(`/api/items/${own.hostItemId}/page/convert`, { blockId, type: "text", confirmedPageCount: 1 }),
      );
      expect(refusedBlock.status).toBe(400);
      const converted = await send(
        b.member,
        POST(`/api/items/${own.hostItemId}/page/convert`, { blockId: ownBlockId, type: "text", confirmedPageCount: 1 }),
      );
      expect(converted.status, converted.text).toBe(200);
      expectNoneOf(converted.text, [...a.ids, foreign.hostItemId, foreign.pageItemId], "B's own conversion");
    });
    expect(await readForeign()).toEqual(before);
  },
  "restore page version": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([id]) =>
        POST(`/api/items/${id}/page/restore`, { at: new Date(Date.now() - 60 * 1000).toISOString() }),
      );
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
      // The bodies differ by the created ids, so statuses are compared: B uploading bytes A already
      // stored must not be told so.
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
      // Refused before B's body is read.
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
      // B must never be handed A's blob. The status is not compared: an earlier case may already
      // have stored the same bytes in B.
      const upload = (content: string | Buffer): Request => ({
        method: "POST",
        path: "/api/blobs",
        body: content,
        headers: { "Content-Type": "image/png" },
      });
      const foreign = await send(b.member, upload(a.fileContent));
      expectNoneOf(foreign.text, a.ids, "blob upload of A's bytes");
      const random = await expectExcludesA(b.member, upload(pngBytesOf(`image bytes of ${randomUUID()}`)));
      expect(random.status).toBe(201);
      expect(foreign.text).not.toContain(a.blobId);
    }),
  "download blob": async () => {
    await expectForeignLikeRandom(b.member, [a.blobId], ([id]) => GET(`/api/blobs/${id}`));
    // The conditional branches answer 304 with A's ETag and 416 with A's size to A itself, so B
    // naming A's content hash or an unsatisfiable range must still get the plain not-found.
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
      await expectExcludesA(b.member, POST("/api/account/exports", {}));
    }),
  "list account exports": async () => {
    await expectExcludesA(b.member, GET("/api/account/exports"), [b.exportId]);
  },
  // What A gains leaves every figure of B's summary where it was; the same rows in B raise B's
  // figures by exactly one each (the spend by its cost), so B's unchanged answers are isolation and
  // not an empty fixture.
  "account summary": async () => {
    const summaryBody = z.strictObject({
      activeSessions: z.number(),
      mailAccountCount: z.number(),
      mailAccountsNeedingReauth: z.array(z.strictObject({ id: z.string(), name: z.string() })),
      trashItems: z.number(),
      trashDatabases: z.number(),
      problemCount: z.number(),
      aiCostMonthUsd: z.number(),
    });
    const request: Request = GET("/api/account/summary");
    const summaryOfB = async (ownIds: readonly string[], idsOfA: readonly string[]) =>
      summaryBody.parse(JSON.parse((await expectExcludesA(b.member, request, ownIds, idsOfA)).text));
    // The extra session is the caller's own second login.
    const gain = async (tenant: TenantFixture, costUsd: number) => {
      const session = await signIn(tenant.member.email, tenant.member.password, "ios");
      const itemId = readString(
        await sendOk(tenant.member, POST(`/api/databases/${tenant.databaseId}/items`, { properties: {} })),
        "id",
      );
      await sendOk(tenant.member, DELETE(`/api/items/${itemId}`));
      const databaseId = readString(
        await sendOk(tenant.member, POST("/api/databases", { name: "Summary probe" })),
        "id",
      );
      await sendOk(tenant.member, DELETE(`/api/databases/${databaseId}`));
      const mailboxId = await mailboxNeedingReauthorization(tenant);
      await inTenantTransaction(tenant.tenantId, (client) =>
        raiseProblem(client, {
          userId: tenant.member.userId,
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          sourceTable: "project_heartbeats",
          sourceId: tenant.heartbeatId,
          dedupeKey: `agents:account-summary:${tenant.heartbeatId}`,
        }),
      );
      await runInTenant(tenant.tenantId, () =>
        recordTokenGatewayCall(pool, {
          provider: "anthropic",
          model: "isolation-test",
          inputTokens: 1,
          outputTokens: 1,
          costUsd,
        }),
      );
      return { session, itemId, databaseId, mailboxId };
    };
    const signedOutOfB = await mailboxNeedingReauthorization(b);
    const before = await summaryOfB([signedOutOfB], [a.mailboxItemId]);
    expect(before.mailAccountsNeedingReauth.map((mailbox) => mailbox.id)).toContain(signedOutOfB);

    const ofA = await gain(a, 3);
    const afterForeign = await summaryOfB([signedOutOfB], [ofA.mailboxId, ofA.itemId, ofA.databaseId]);
    expect(afterForeign).toEqual(before);
    const summaryOfA = summaryBody.parse(JSON.parse(await sendOk(a.member, request)));
    expect(summaryOfA.mailAccountsNeedingReauth.map((mailbox) => mailbox.id)).toContain(ofA.mailboxId);
    expect(summaryOfA.aiCostMonthUsd).toBeGreaterThanOrEqual(3);
    expect(summaryOfA.trashItems).toBeGreaterThanOrEqual(1);
    expect(summaryOfA.trashDatabases).toBeGreaterThanOrEqual(1);

    const ofB = await gain(b, 5);
    const afterOwn = await summaryOfB([signedOutOfB, ofB.mailboxId], [ofA.mailboxId, ofA.itemId, ofA.databaseId]);
    expect({
      ...afterOwn,
      mailAccountsNeedingReauth: afterOwn.mailAccountsNeedingReauth.map((mailbox) => mailbox.id),
    }).toEqual({
      activeSessions: before.activeSessions + 1,
      mailAccountCount: before.mailAccountCount + 1,
      mailAccountsNeedingReauth: [
        ...before.mailAccountsNeedingReauth.map((mailbox) => mailbox.id),
        ofB.mailboxId,
      ].sort(),
      trashItems: before.trashItems + 1,
      trashDatabases: before.trashDatabases + 1,
      problemCount: before.problemCount + 1,
      aiCostMonthUsd: before.aiCostMonthUsd + 5,
    });
    // Signing out this case's own second sessions leaves the members' sessions as other cases
    // expect.
    for (const [tenant, session] of [
      [a, ofA.session],
      [b, ofB.session],
    ] as const) {
      await sendOk(tenant.member, POST(`/api/auth/sessions/${session.sessionId}/revoke`, {}));
    }
  },
  "download account export": async () => {
    await expectForeignLikeRandom(b.member, [a.exportId], ([id]) => GET(`/api/account/exports/${id}/download`));
  },
  "delete own account": () =>
    leavesAUnchanged(async () => {
      // A's real password is a wrong password for B.
      await expectForeignLikeRandom(b.member, [a.member.password], ([password]) =>
        POST("/api/account/delete", { password }),
      );
    }),
  "update profile": async () => {
    // A third tenant calls it: B's user row is a fixture later cases read.
    const callerTenantId = await createTestTenant(adminPool);
    const caller = await signUp(callerTenantId, "member");
    // `users` is a global identity table, read in the system scope the session lookup uses.
    const userRow = async (userId: string) => {
      const user = await runAsSystem("isolation test user read", () => getUserById(pool, userId));
      if (!user) throw new Error(`no user ${userId}`);
      return user;
    };
    // Read through graphile-worker's public `jobs` view.
    const jobsOf = async (tenantId: string) => {
      return (await workerJobs()).filter((job) => job.key?.includes(tenantId) ?? false);
    };
    const before = {
      users: { a: await userRow(a.member.userId), b: await userRow(b.member.userId) },
      jobs: { a: await jobsOf(a.tenantId), b: await jobsOf(b.tenantId) },
    };
    const patch = (body: unknown): Request => PATCH("/api/account/profile", body);

    // The account comes from the session only.
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
    // The search rebuild belongs to the caller's tenant.
    expect((await jobsOf(callerTenantId)).map((job) => job.key)).toEqual([
      expect.stringContaining("item-search-backfill"),
    ]);

    expect({
      users: { a: await userRow(a.member.userId), b: await userRow(b.member.userId) },
      jobs: { a: await jobsOf(a.tenantId), b: await jobsOf(b.tenantId) },
    }).toEqual(before);
    const sessionA = await send(a.member, GET("/api/auth/session"));
    expect(readString(sessionA.text, "user", "locale")).toBe(before.users.a.locale);
    await expectAAccountActive();
  },

  // --- admin ---------------------------------------------------------------------------------
  "admin account list": adminCase("admin account list", "GET", async () => GET("/api/admin/accounts")),
  "admin operations health": adminCase("admin operations health", "GET", async () => GET("/api/admin/health")),
  "admin ai budgets": adminCase("admin ai budgets", "GET", async () => GET("/api/admin/ai-budgets")),
  "admin set ai budget": adminCase("admin set ai budget", "PUT", async () =>
    PUT(`/api/admin/accounts/${adminTarget.userId}/ai-budget`, { dailyCapUsd: 5, monthlyCapUsd: 50 }),
  ),
  "admin suspend account": adminCase("admin suspend account", "POST", async () =>
    POST(`/api/admin/accounts/${adminTarget.userId}/suspend`, {}),
  ),
  "admin reactivate account": adminCase("admin reactivate account", "POST", async () =>
    POST(`/api/admin/accounts/${adminTarget.userId}/reactivate`, {}),
  ),
  "admin change account role": adminCase("admin change account role", "PUT", async () =>
    PUT(`/api/admin/accounts/${adminTarget.userId}/role`, { role: "member" }),
  ),
  "admin create invite": adminCase("admin create invite", "POST", async () =>
    POST("/api/admin/invites", { email: `${randomUUID()}@example.test` }),
  ),
  "admin list invites": adminCase("admin list invites", "GET", async () => GET("/api/admin/invites")),
  "admin revoke invite": adminCase("admin revoke invite", "POST", async () =>
    POST(`/api/admin/invites/${await createInviteAsAdmin()}/revoke`, {}),
  ),
  // A member of a third tenant, so deleting it touches neither A nor B.
  "admin delete account": adminCase("admin delete account", "POST", async () =>
    POST(`/api/admin/accounts/${adminTarget.userId}/delete`, {}),
  ),
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
  /** Where the route has a single success answer. */
  status?: number;
  contains?: string[];
  /** Puts A's row back after a probe that changed it. */
  undo?: () => Promise<void>;
}

/** One probe per id the `tenant` cases name, sent as A. */
function ownerProbes(): OwnerProbe[] {
  const probe = (
    label: string,
    ids: string[],
    outcome: Pick<OwnerProbe, "status" | "contains" | "undo">,
    build: OwnerProbe["build"],
  ): OwnerProbe => ({ label, ids, build, ...outcome });
  return [
    probe("mailbox detail", [a.mailboxItemId], { status: 200 }, ([id]) => GET(`/api/mail/mailboxes/${id}`)),
    probe("mailbox removal impact", [a.mailboxItemId], { status: 200 }, ([id]) =>
      GET(`/api/mail/mailboxes/${id}/removal-impact`),
    ),
    probe("database detail", [a.databaseId], { status: 200 }, ([id]) => GET(`/api/databases/${id}`)),
    probe("archived database detail", [a.archivedDatabaseId], { status: 200 }, ([id]) => GET(`/api/databases/${id}`)),
    probe("property catalog", [a.databaseId], { status: 200, contains: [a.propertyId, a.relationPropertyId] }, ([id]) =>
      GET(`/api/databases/${id}/properties`),
    ),
    probe("property list", [a.databaseId], { status: 200, contains: [a.propertyId] }, ([id]) =>
      GET(`/api/properties?databaseId=${id}`),
    ),
    probe("property detail", [a.propertyId], { status: 200 }, ([id]) => GET(`/api/properties/${id}`)),
    probe("view detail", [a.viewId], { status: 200 }, ([id]) => GET(`/api/views/${id}`)),
    probe("curated view detail", [a.curatedViewId], { status: 200 }, ([id]) => GET(`/api/views/${id}`)),
    probe("item detail", [a.itemId], { status: 200 }, ([id]) => GET(`/api/items/${id}?include=path`)),
    probe("list relations", [a.itemId], { status: 200, contains: [a.targetItemId] }, ([id]) =>
      GET(`/api/items/${id}/relations`),
    ),
    probe("list related collections", [a.targetItemId], { status: 200, contains: [a.databaseId] }, ([id]) =>
      GET(`/api/items/${id}/related`),
    ),
    probe("item delete impact", [a.targetItemId], { status: 200 }, ([id]) => GET(`/api/items/${id}/delete-impact`)),
    probe("count items", [a.databaseId], { status: 200, contains: [a.databaseId, a.targetItemId] }, ([databaseId]) =>
      POST("/api/items/count", { items: [{ databaseId, groupBy: a.relationPropertyKey }] }),
    ),
    probe("database facets", [a.databaseId], { status: 200, contains: [a.targetItemId] }, ([id]) =>
      POST(`/api/databases/${id}/facets`, { facets: [a.relationPropertyKey] }),
    ),
    probe("query database", [a.databaseId], { status: 200, contains: [a.itemId] }, ([id]) =>
      POST(`/api/databases/${id}/query`, {}),
    ),
    probe("query database trash", [a.databaseId], { status: 200, contains: [a.trashedItemId] }, ([id]) =>
      POST(`/api/databases/${id}/query`, { inTrash: true }),
    ),
    probe("query view", [a.viewId], { status: 200, contains: [a.itemId] }, ([id]) =>
      POST(`/api/views/${id}/query`, {}),
    ),
    probe("query curated view", [a.curatedViewId], { status: 200, contains: [a.itemId] }, ([id]) =>
      POST(`/api/views/${id}/query`, {}),
    ),
    probe("download blob", [a.blobId], { status: 200 }, ([id]) => GET(`/api/blobs/${id}`)),
    probe("download blob, matching If-None-Match", [a.blobId], { status: 304 }, ([id]) => ({
      method: "GET",
      path: `/api/blobs/${id}`,
      headers: { "If-None-Match": `"${a.blobContentHash}"` },
    })),
    probe("download blob, unsatisfiable range", [a.blobId], { status: 416 }, ([id]) => ({
      method: "GET",
      path: `/api/blobs/${id}`,
      headers: { Range: "bytes=999999999-" },
    })),
    probe("download account export", [a.exportId], { status: 200 }, ([id]) =>
      GET(`/api/account/exports/${id}/download`),
    ),
    probe("agent run detail", [a.agentRunId], { status: 200 }, ([id]) => GET(`/api/agent-runs/${id}`)),
    probe("agent run steps", [a.agentRunId], { status: 200, contains: [`"stepId":"${a.agentRunEventId}"`] }, ([id]) =>
      GET(`/api/agent-runs/${id}/steps`),
    ),
    probe(
      "project mcp grants",
      [a.projectItemId],
      { status: 200, contains: [a.mcpToolRegistrationId, '"granted":true'] },
      ([id]) => GET(`/api/projects/${id}/mcp-grants`),
    ),
    probe("project agent summary", [a.projectItemId], { status: 200, contains: ['"hasGuidance":'] }, ([id]) =>
      GET(`/api/projects/${id}/agent-summary`),
    ),
    probe("project database grants", [a.projectItemId], { status: 200, contains: [a.databaseId] }, ([id]) =>
      GET(`/api/projects/${id}/database-grants`),
    ),
    probe("project heartbeats", [a.projectItemId], { status: 200 }, ([id]) => GET(`/api/projects/${id}/heartbeats`)),
    // The database's default access, so A's request stores nothing and needs no undo.
    probe("project database grant set", [a.projectItemId, a.databaseId], { status: 200 }, ([project, databaseId]) =>
      PATCH(`/api/projects/${project}/database-grants`, { databaseId, access: "write" }),
    ),
    probe("transcript detail", [a.transcriptItemId], {}, ([id]) => GET(`/api/transcripts/${id}`)),
    probe("transcript speakers", [a.transcriptItemId], {}, ([id]) => GET(`/api/transcripts/${id}/speakers`)),
    probe("transcript speaker candidates", [a.transcriptItemId], { status: 200 }, ([id]) =>
      GET(`/api/transcripts/${id}/speaker-candidates`),
    ),
    // Clearing an unmapped key writes nothing, so no undo is needed.
    probe("transcript speaker assignment", [a.transcriptItemId], { status: 200 }, ([id]) =>
      PUT(`/api/transcripts/${id}/speakers/SPEAKER_00`, { personId: null }),
    ),
    probe("create transcription", [a.fileItemId], {}, ([fileItemId]) => POST("/api/transcriptions", { fileItemId })),
    probe("transcription rerun", [a.transcriptItemId], {}, ([id]) => POST(`/api/transcriptions/${id}/rerun`, {})),
    // The fixture proposal has no status, so A's confirm is refused and writes nothing.
    probe("confirm proposal", [a.proposalItemId], { status: 400 }, ([id]) => POST(`/api/proposals/${id}/confirm`, {})),
    // The fixture proposal is not a transcript card, so A's revise is refused and writes nothing.
    probe("revise proposal", [a.proposalItemId], { status: 400 }, ([id]) =>
      POST(`/api/proposals/${id}/revise`, { message: "Use the other Event" }),
    ),
    // The fixture proposal has no status, so A's edit is refused and writes nothing.
    probe("update proposal values", [a.proposalItemId], { status: 400 }, ([id]) =>
      PATCH(`/api/proposals/${id}/values`, { set: { primary: { name: "Owner edit" } } }),
    ),
    // The fixture proposal has no status, so A's reset is refused and writes nothing.
    probe("reset proposal overrides", [a.proposalItemId], { status: 400 }, ([id]) =>
      POST(`/api/proposals/${id}/reset-overrides`, {}),
    ),
    // The fixture proposal is not an Inbox item card, so A's recompute is refused and writes
    // nothing.
    probe("recompute proposal", [a.proposalItemId], { status: 400 }, ([id]) =>
      POST(`/api/proposals/${id}/recompute`, {}),
    ),
    probe("mint mcp run credential", [a.projectItemId], { status: 201 }, ([projectItemId]) =>
      POST("/api/agent-runs/mcp-credentials", { projectItemId, capabilities: ["core.item.read"] }),
    ),
    probe("project mcp grant toggle", [a.projectItemId, a.mcpToolRegistrationId], { status: 200 }, ([project, tool]) =>
      PATCH(`/api/projects/${project}/mcp-grants/${tool}`, { granted: true }),
    ),
    // The seeded value differs from what B's foreign reclassify sends, so a cross-tenant write
    // would change what A reads.
    probe(
      "mcp tool registration reclassify",
      [a.mcpToolRegistrationId],
      { status: 200, contains: ['"requiresApproval":true'] },
      ([id]) => PATCH(`/api/mcp-tool-registrations/${id}`, { requiresApproval: true }),
    ),
    // The fixture server has no connectionConfig, so A's sync is refused at the connection
    // factory.
    probe("mcp server sync", [a.mcpServerItemId], { status: 502, contains: ['"reason":"invalid_config"'] }, ([id]) =>
      POST(`/api/mcp-servers/${id}/sync`, {}),
    ),
    probe("rename database", [a.databaseId], { status: 200 }, ([id]) =>
      PATCH(`/api/databases/${id}`, { name: "Isolation probe" }),
    ),
    probe("archive database", [a.archivedDatabaseId], {}, ([id]) => DELETE(`/api/databases/${id}`, {})),
    probe(
      "restore database",
      [a.archivedDatabaseId],
      {
        status: 200,
        undo: async () => {
          await sendOk(a.member, DELETE(`/api/databases/${a.archivedDatabaseId}`));
        },
      },
      ([id]) => POST(`/api/databases/${id}/restore`, {}),
    ),
    probe("update property", [a.propertyId], { status: 200 }, ([id]) =>
      PATCH(`/api/properties/${id}`, { name: "Note" }),
    ),
    probe("patch view", [a.viewId], { status: 200 }, ([id]) => PATCH(`/api/views/${id}`, { name: "All rows" })),
    probe("add curated view item", [a.curatedViewId, a.itemId], { status: 200 }, ([view, item]) =>
      PUT(`/api/views/${view}/items/${item}`, { position: 0 }),
    ),
    probe("reorder curated view item", [a.curatedViewId, a.itemId], { status: 200 }, ([view, item]) =>
      PATCH(`/api/views/${view}/items/${item}`, { position: 0 }),
    ),
    probe("patch item", [a.itemId], { status: 200 }, ([id]) =>
      PATCH(`/api/items/${id}`, { properties: {}, ifVersion: a.itemVersion }),
    ),
    probe(
      "restore item",
      [a.trashedItemId],
      {
        status: 200,
        undo: async () => {
          await sendOk(a.member, DELETE(`/api/items/${a.trashedItemId}`));
        },
      },
      ([id]) => POST(`/api/items/${id}/restore`, {}),
    ),
    probe("create/replace relation", [a.itemId, a.targetItemId], { status: 200 }, ([item, target]) =>
      PUT(`/api/items/${item}/relations/${a.relationPropertyKey}/${target}`, {}),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// MCP cases, one per generic operation
// ---------------------------------------------------------------------------------------------

interface McpProbe {
  foreignLikeRandom(
    foreign: readonly string[],
    args: (values: readonly string[]) => Record<string, unknown>,
  ): Promise<void>;
  /** Also excludes `moreIdsOfA` (rows the case seeded for A) and requires every one of `ownIds`. */
  excludesA(args: Record<string, unknown>, ownIds: readonly string[], moreIdsOfA?: readonly string[]): Promise<void>;
  /**
   * Answers 200 without any id of A, whether the call ran or was held for approval (as a run
   * credential is for an operation that needs it). Returns the text so the case can tell the two
   * apart; an error in it is not a failure here.
   */
  touchesNoneOfA(args: Record<string, unknown>, moreIdsOfA: readonly string[]): Promise<string>;
}

type McpCase = (probe: McpProbe) => Promise<void>;

/** One day per caller. */
let mergedJournalDays = 0;

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
  // REST-only: MCP answers both as unknown tools.
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
      await sendOk(
        b.member,
        POST(`/api/databases/${b.databaseId}/properties`, {
          key,
          name: "Single link",
          type: "relation",
          targetDatabaseId: b.targetDatabaseId,
          cardinality: "one_to_one",
          locked: false,
        }),
      ),
      "id",
    );
    await p.excludesA({ relationPropertyId: propertyId, callerItemId: b.itemId, targetItemId: b.targetItemId }, [
      b.itemId,
      b.targetItemId,
    ]);
    const before = await sendOk(b.member, GET(`/api/items/${b.itemId}/relations?propertyKey=${key}`));
    await p.foreignLikeRandom([a.targetItemId], ([targetItemId]) => ({
      relationPropertyId: propertyId,
      callerItemId: b.itemId,
      targetItemId,
    }));
    expect(await sendOk(b.member, GET(`/api/items/${b.itemId}/relations?propertyKey=${key}`))).toBe(before);
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
  "relation.related": async (p) => {
    // `a.targetItemId` has a collection of its own (the database holding the edge to it), which
    // must not be seen.
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId }));
    await p.foreignLikeRandom([a.targetItemId], ([itemId]) => ({ itemId }));
    await p.excludesA({ itemId: b.targetItemId }, [b.databaseId]);
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
  search: async (p) => {
    const word = freshSearchWord();
    const foreignTaskId = await seedSearchTask(a, `${word} of A`);
    const ownTaskId = await seedSearchTask(b, `${word} of B`);
    await p.excludesA({ q: word, scope: ["task"] }, [ownTaskId], [foreignTaskId]);
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
    // So does A's host item, which is not a page at all.
    await p.foreignLikeRandom([mcpPages.foreign.pageItemId], ([pageItemId]) => ({ pageItemId }));
    await p.foreignLikeRandom([a.itemId], ([pageItemId]) => ({ pageItemId }));
    await p.excludesA({ pageItemId: mcpPages.own.pageItemId }, []);
  },
  "page.rename": async (p) => {
    // So does A's host item, which is not a page at all.
    await p.foreignLikeRandom([mcpPages.foreign.pageItemId], ([pageItemId]) => ({
      pageItemId,
      title: "Foreign title",
    }));
    await p.foreignLikeRandom([a.itemId], ([pageItemId]) => ({ pageItemId, title: "Foreign title" }));
    await p.excludesA({ pageItemId: mcpPages.own.pageItemId, title: "Own title" }, [mcpPages.own.pageItemId]);
  },
  "page.convertToBlock": async (p) => {
    // Seeded per caller, because the caller that converts it leaves the page block gone.
    const foreignBlockId = await firstBlockIdOfPage(a.member, mcpPages.foreign.hostItemId);
    const own = await seedSubpage(b);
    const ownBlockId = await firstBlockIdOfPage(b.member, own.hostItemId);
    await p.foreignLikeRandom([mcpPages.foreign.hostItemId], ([parentItemId]) => ({
      parentItemId,
      blockId: foreignBlockId,
      type: "text",
      confirmedPageCount: 1,
    }));
    await p.foreignLikeRandom([foreignBlockId], ([blockId]) => ({
      parentItemId: own.hostItemId,
      blockId,
      type: "text",
      confirmedPageCount: 1,
    }));
    const answer = await p.touchesNoneOfA(
      { parentItemId: own.hostItemId, blockId: ownBlockId, type: "text", confirmedPageCount: 1 },
      [mcpPages.foreign.hostItemId, mcpPages.foreign.pageItemId, foreignBlockId],
    );
    // A session converts B's block; a run credential is held for approval or refused, and the page
    // stays.
    if (!answer.includes('"error"')) expect(answer).toContain("trashedPageCount");
  },
  "page.insert": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({ itemId, placement: "end", markdown: "Foreign insert" }));
    await p.excludesA({ itemId: b.itemId, placement: "end", markdown: "Own insert" }, []);
  },
  "page.ensureJournalPeriod": async (p) => {
    // The call names no id and resolves the period in B's own Journal.
    const ensureDay = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
    const ownA = await ensureDay(a);
    const ownB = await ensureDay(b);
    await p.excludesA({ type: "day", date: "2026-10-16" }, [ownB.itemId, ownB.docId], [ownA.itemId, ownA.docId]);
  },
  "page.mergeJournalDuplicates": async (p) => {
    // Both tenants hold two live entries of that day; each call gets its own day, because a merge
    // leaves its period without a duplicate.
    const period = `2026-12-${String(10 + ++mergedJournalDays)}`;
    const seedEntries = (tenant: TenantFixture) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const journal = await moduleDatabase(client, "journal");
        const entries: string[] = [];
        for (let n = 0; n < 2; n += 1) {
          // Lazy creation never produces two live entries of one period, so the fixture creates
          // them directly.
          const entry = await createItemWithClient(
            client,
            { databaseId: journal.id, properties: { name: `\u{1F4D3} ${period}`, type: "day", period } },
            { allowedSystemKeys: ["name", "type", "period"] },
          );
          entries.push(entry.id);
        }
        return entries;
      });
    const liveOf = (tenant: TenantFixture, ids: readonly string[]) =>
      inTenantTransaction(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
          [ids],
        );
        return rows.map((row) => row.id);
      });
    const ownA = await seedEntries(a);
    const ownB = await seedEntries(b);

    const answer = await p.touchesNoneOfA({ type: "day", period }, ownA);

    expect(await liveOf(a, ownA)).toEqual([...ownA].sort());
    const liveB = await liveOf(b, ownB);
    if (answer.includes('"error"')) {
      // A run credential is held for approval; nothing is merged until the user decides.
      expect(liveB).toEqual([...ownB].sort());
    } else {
      // A session merges B's pair; one of the two is in B's Trash.
      for (const id of ownB) expect(answer).toContain(id);
      expect(liveB).toHaveLength(1);
    }
  },
  // The probe's version token never matches, and nothing is written.
  "page.replace": async (p) => {
    await p.foreignLikeRandom([a.itemId], ([itemId]) => ({
      itemId,
      markdown: "Foreign replace",
      expectedEtag: "A".repeat(43),
    }));
  },
  "page.changes": async (p) => {
    // After every fixture page document exists and not in the future.
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
  return POST("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: `semprec.${name}`, arguments: args },
  });
}

function mcpProbe(caller: Caller, operation: GenericOperationName): McpProbe {
  return {
    async foreignLikeRandom(foreign, args) {
      const answer = await expectForeignLikeRandom(caller, foreign, (values) => mcpCall(operation, args(values)));
      expect(answer.status).toBe(200);
    },
    async touchesNoneOfA(args, moreIdsOfA) {
      const request = mcpCall(operation, args);
      const answer = await send(caller, request);
      expect(answer.status).toBe(200);
      expectNoneOf(answer.text, [...a.ids, ...moreIdsOfA], `${request.method} ${request.path}`);
      return answer.text;
    },
    async excludesA(args, ownIds, moreIdsOfA) {
      const answer = await expectExcludesA(caller, mcpCall(operation, args), ownIds, moreIdsOfA);
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
      customRouteDependencies: {
        ...MAIL_OAUTH_DEPENDENCIES,
        ...MAILBOX_PASSWORD_DEPENDENCIES,
        ...THREAD_TASK_DEPENDENCIES,
        ...MAIL_SEND_DEPENDENCIES,
      },
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

    const minted = await sendOk(
      b.member,
      POST("/api/agent-runs/mcp-credentials", { projectItemId: b.projectItemId, capabilities: [...CAPABILITY_IDS] }),
    );
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
      const answer = await send(a.member, GET(`/api/semp/threads/${thread.id}`));
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
        // The tick thread's own heartbeat header, and no active run (the fixture's run is the
        // user's).
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
      const answer = await send(a.member, GET(`/api/semp/threads/${fixture.chatId}/messages?limit=2${suffix}`));
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
      expect((await send(a.member, GET(`/api/semp/threads/${fixture.chatId}/messages?${query}`))).status).toBe(400);
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
    const before = await sendOk(a.member, GET(path));
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
      const response = await send(a.member, PATCH(path, { properties: { [key]: value }, ifVersion: version }));
      expect(response.status, key).toBe(403);
      expect(await sendOk(a.member, GET(path)), key).toBe(before);
    }
    const foreign = await send(b.member, PATCH(path, { properties: { reason: "foreign" }, ifVersion: version }));
    expect(foreign.status).toBe(404);
    expect(await sendOk(a.member, GET(path))).toBe(before);

    const created = await sendOk(a.member, POST(`/api/databases/${a.databaseId}/items`, { properties: {} }));
    const ownPath = `/api/items/${readString(created, "id")}`;
    const changed = await sendOk(
      a.member,
      PATCH(ownPath, {
        properties: { [a.propertyKey]: "allowed" },
        ifVersion: readString(created, "version"),
      }),
    );
    expect(JSON.parse(changed)).toMatchObject({ properties: { [a.propertyKey]: "allowed" } });
  });

  it("returns flat confirmed results and an unchanged replay through authenticated HTTP", async () => {
    const proposalId = await seedProposalCard(a, {
      proposal: {
        entityKind: "database",
        target: await databaseIdFor(a.tenantId, "tasks"),
        properties: { name: "Confirmed task" },
      },
    });
    const path = `/api/proposals/${proposalId}/confirm`;
    await expectForeign404(b.member, [proposalId], ([id]) => POST(`/api/proposals/${id}/confirm`, {}));
    const first = await send(a.member, POST(path, {}));
    expect(first.status).toBe(200);
    const firstBody: unknown = JSON.parse(first.text);
    expect(firstBody).toMatchObject({
      id: proposalId,
      properties: { status: "confirmed" },
      results: [{ ref: "primary", databaseKey: "tasks", role: "primary", followUp: null, blockIds: [] }],
    });
    expect(firstBody).not.toHaveProperty("item");
    const replay = await send(a.member, POST(path, {}));
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.text)).toEqual(firstBody);
  });

  it.each(["confirm", "reject"] as const)(
    "answers a stale ifVersion on %s with 409 and the current card, and keeps the replay of a decided card at 200",
    async (action) => {
      const cardId = await seedProposalCard(a, {
        proposal: {
          entityKind: "database",
          target: await databaseIdFor(a.tenantId, "tasks"),
          properties: { name: "Versioned task" },
        },
      });
      const path = `/api/proposals/${cardId}/${action}`;
      const decided = action === "confirm" ? "confirmed" : "rejected";
      const stale = "999999999";
      const current = readString(await sendOk(a.member, GET(`/api/items/${cardId}`)), "version");

      const conflict = await send(a.member, POST(path, { ifVersion: stale }));
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.text)).toMatchObject({
        error: {
          code: "version_conflict",
          details: { currentItem: { id: cardId, version: current, properties: { status: "proposed" } } },
        },
      });
      expect(await sendOk(a.member, GET(`/api/items/${cardId}`))).toContain('"status":"proposed"');

      const first = await send(a.member, POST(path, { ifVersion: current }));
      expect(first.status).toBe(200);
      expect(JSON.parse(first.text)).toMatchObject({ id: cardId, properties: { status: decided } });
      const replay = await send(a.member, POST(path, { ifVersion: stale }));
      expect(replay.status).toBe(200);
      expect(JSON.parse(replay.text)).toEqual(JSON.parse(first.text));

      // The other decision is incompatible with the stored status, whatever ifVersion says.
      const other = action === "confirm" ? "reject" : "confirm";
      const refused = await send(a.member, POST(`/api/proposals/${cardId}/${other}`, { ifVersion: stale }));
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toMatchObject({
        error: { code: "validation_failed", details: { field: "status", currentStatus: decided } },
      });
    },
  );

  it("lists A's own approval request and unread notification for A", async () => {
    expect(readIdArray(await sendOk(a.member, GET("/api/approval-requests")), "rows")).toEqual([a.approvalRequestId]);
    const notifications = await sendOk(a.member, GET("/api/notifications/unread"));
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
      const response = await sendOk(fixture.member, GET("/api/notifications/unread"));
      expectText(response, [], [marker, other.mailboxItemId]);
      expect(JSON.parse(response)).toMatchObject({
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
        // Reproduces a stored select value outside the option set.
        const changed = await client.query<{ id: string }>(
          "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text)) WHERE database_id = $1 AND id = $2 RETURNING id",
          [typesId, unknown.id, "legacyUnknown"],
        );
        expect(changed.rows).toHaveLength(1);
        return { task, note, unknown, archived };
      });
      const caller = await signUp(tenantId, "member", locale);
      const body: unknown = JSON.parse(await sendOk(caller, GET("/api/inbox-types")));
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
      const caller = await signUp(tenantId, "member", locale);
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
      const answer = await send(caller, GET(`/api/ai-usage?${range.toString()}`));
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
    const heartbeat = await inTenantTransaction(b.tenantId, (client) =>
      createHeartbeat(client, {
        projectItemId: b.projectItemId,
        name: "Manual worker evidence",
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "manual evidence" },
      }),
    );
    const path = `/api/heartbeats/${heartbeat.id}/trigger`;
    const first = await send(b.member, POST(path, {}));
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
      const second = await send(b.member, POST(path, {}));
      expect(second.status).toBe(409);
      expect(JSON.parse(second.text)).toMatchObject({
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
    const heartbeat = await inTenantTransaction(b.tenantId, (client) =>
      createHeartbeat(client, {
        projectItemId: b.projectItemId,
        name: "Pre-action failure",
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "not invoked" },
      }),
    );
    const answer = await send(b.member, POST(`/api/heartbeats/${heartbeat.id}/trigger`, {}));
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
    const heartbeats = await inTenantTransaction(b.tenantId, async (client) => {
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
    });
    for (const [heartbeat, code] of [
      [heartbeats.disabled, "heartbeat_disabled"],
      [heartbeats.event, "heartbeat_event_triggered"],
    ] as const) {
      const answer = await send(b.member, POST(`/api/heartbeats/${heartbeat.id}/trigger`, {}));
      expect(answer.status).toBe(409);
      expect(JSON.parse(answer.text)).toMatchObject({ error: { code } });
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
    const beforeText = await sendOk(a.member, GET(path));
    const before: unknown = JSON.parse(beforeText);
    if (!isRecord(before) || typeof before.approvals !== "boolean") throw new Error("Invalid preferences response");
    try {
      const changed: unknown = JSON.parse(await sendOk(a.member, PATCH(path, { approvals: false })));
      expect(changed).toMatchObject({ approvals: false });
      const persisted = await sendOk(a.member, GET(path));
      expect(JSON.parse(persisted)).toEqual(changed);
      for (const [body, field] of [
        [{ problemsLevel: "invalid" }, "problemsLevel"],
        [{ approvals: true, "private-key-sentinel": "private-value-sentinel" }, "body"],
      ] as const) {
        const errorLog = vi.spyOn(logger, "error");
        const warnLog = vi.spyOn(logger, "warn");
        let answer: Awaited<ReturnType<typeof send>>;
        try {
          answer = await send(a.member, PATCH(path, body));
          expect(errorLog).not.toHaveBeenCalled();
          expect(warnLog).not.toHaveBeenCalled();
        } finally {
          errorLog.mockRestore();
          warnLog.mockRestore();
        }
        expect(answer.status).toBe(400);
        expect(JSON.parse(answer.text)).toMatchObject({ error: { code: "validation_failed", details: { field } } });
        expectText(answer.text, [], ["private-key-sentinel", "private-value-sentinel"]);
        expect(await sendOk(a.member, GET(path))).toBe(persisted);
      }
    } finally {
      await sendOk(a.member, PATCH(path, { approvals: before.approvals }));
    }
  });

  it("serves the project database grants to a user session only and applies a patch to the project's agent", async () => {
    const path = `/api/projects/${b.projectItemId}/database-grants`;
    const healthId = await databaseIdFor(b.tenantId, "healthRecords");
    const tasksId = await databaseIdFor(b.tenantId, "tasks");
    const grants = async (): Promise<string[]> => {
      const { rows } = await adminPool.query<{ database_id: string; access: string }>(
        "SELECT database_id, access FROM agent_database_grants WHERE project_item_id = $1 ORDER BY database_id",
        [b.projectItemId],
      );
      return rows.map((row) => `${row.database_id} ${row.access}`);
    };
    const accessIn = (text: string, databaseId: string): unknown => {
      const rows: unknown = JSON.parse(text);
      const parsed = z.object({ rows: z.array(z.object({ databaseId: z.string(), access: z.string() })) }).parse(rows);
      return parsed.rows.find((row) => row.databaseId === databaseId)?.access;
    };
    const patch = (caller: Caller | null, body: unknown) => send(caller, PATCH(path, body));

    // Neither route answers without a session, nor to the run credential of the project's own agent.
    for (const caller of [null, mcpRunCredential]) {
      const attempts = [await send(caller, GET(path)), await patch(caller, { databaseId: healthId, access: "write" })];
      expect(attempts.map((attempt) => attempt.status)).toEqual([401, 401]);
    }
    expect(await grants()).toEqual([]);

    // A session sees the sensitive database closed, opens it, and the project's agent is let in.
    expect(accessIn(await sendOk(b.member, GET(path)), healthId)).toBe("none");
    const opened = await patch(b.member, { databaseId: healthId, access: "write" });
    expect(opened.status, opened.text).toBe(200);
    expect(JSON.parse(opened.text)).toMatchObject({ databaseId: healthId, key: "healthRecords", access: "write" });
    expect(await grants()).toEqual([`${healthId} write`]);
    expect(accessIn(await sendOk(b.member, GET(path)), healthId)).toBe("write");
    const record = readString(
      await sendOk(b.member, POST(`/api/databases/${healthId}/items`, { properties: { name: "Grants probe" } })),
      "id",
    );
    const agentRead = () => send(mcpRunCredential, mcpCall("item.get", { itemId: record }));
    const allowed = await agentRead();
    expect(allowed.status, allowed.text).toBe(200);
    expect(allowed.text).toContain(record);

    // Closing it again removes the row and the same agent call is refused.
    expect((await patch(b.member, { databaseId: healthId, access: "none" })).status).toBe(200);
    expect(await grants()).toEqual([]);
    const refused = await agentRead();
    expectText(refused.text, ['"code":"forbidden"'], ["Grants probe"]);

    // An open system database and a malformed body are 400 and store nothing.
    expect((await patch(b.member, { databaseId: tasksId, access: "none" })).status).toBe(400);
    expect((await patch(b.member, { databaseId: healthId, access: "admin" })).status).toBe(400);
    expect(await grants()).toEqual([]);
  });

  it("omits a historical foreign blob from an authenticated item envelope", async () => {
    const path = `/api/items/${a.fileItemId}`;
    const ownText = await sendOk(a.member, GET(path));
    const own: unknown = JSON.parse(ownText);
    if (!isRecord(own) || !isRecord(own.properties)) throw new Error("expected item properties");
    expect(own).toHaveProperty("blobs.file.blobId", a.blobId);
    const original = own.properties;
    const historical = { ...original, file: { blobId: b.blobId } };
    // Writes invalid JSONB the blob-reference guard would refuse; the fixture is tenant-scoped.
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
      const answer = await send(a.member, GET(path));
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
    const readForeign = () => send(a.member, GET(`/api/items/${foreign}?include=links`));
    const before = await readForeign();
    expect(before.status).toBe(200);
    for (const action of ["unlink", "relink"]) {
      await expectForeign404(b.member, [foreign], ([id]) => POST(`/api/items/${id}/links/note/${action}`));
      expect((await send(b.member, POST(`/api/items/${own}/links/note/${action}`))).status).toBe(200);
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
        // An agent run that ends an active link is asked for approval first, so the member ends the
        // link and the run's unlink is the no-op of an already broken one.
        if (caller === mcpRunCredential && action === "unlink") {
          await send(b.member, POST(`/api/items/${own}/links/note/unlink`));
        }
        const allowed = await send(caller, mcpCall(operation, { itemId: own, propertyKey: "note" }));
        expect(allowed.status).toBe(200);
        expect(allowed.text).not.toContain('"error"');
        expect(await readForeign()).toEqual(before);
      }
    }
  });

  it("answers A's own ids differently from random ids on every probed route, so a foreign answer is a real refusal", async () => {
    // Positive control for the tenant cases: for each id they probe, A naming its own row must take
    // another branch than A naming a random id. Mutating probes are idempotent for A's rows or
    // undone right after; the destructive routes share their ids with a read probed here.
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
    a.itemVersion = readString(await sendOk(a.member, GET(`/api/items/${a.itemId}`)), "updatedAt");
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
        expectText(own.text, [b.itemId], ['"error"']);
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
