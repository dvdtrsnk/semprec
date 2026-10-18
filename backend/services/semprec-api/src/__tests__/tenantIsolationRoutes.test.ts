import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
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
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  getDatabaseByModuleId,
  hashPassword,
  insertAgentRunEvent,
  listPushSubscriptionsForUser,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  writeNotification,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { ROUTE_MATRIX, ROUTE_TENANCIES, type RouteMatrixEntry } from "../routeMatrix.js";

/**
 * Issue #1053: every `surface: "api"` entry of `ROUTE_MATRIX` and every MCP generic operation is
 * driven as tenant B against tenant A's real rows, on a runtime-role pool with
 * `SEMPREC_TENANT_SCOPE=strict`. A foreign id must be answered exactly like a random one (same
 * status, same body once each requested id is masked), a mutation must leave A's rows as A reads
 * them, and no list, query or count may contain any of A's ids.
 */

const SETUP_TOKEN = "tenant-isolation-setup-token";
const EXAMPLE_ID = "00000000-0000-0000-0000-000000000000";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-isolation-${randomUUID()}`);
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
}

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
  blobId: string;
  projectItemId: string;
  heartbeatId: string;
  notificationId: string;
  agentRunId: string;
  /** A bigint, so it is not in `ids`: as a substring it would match any digit. */
  agentRunEventId: string;
  approvalRequestId: string;
  mcpServerItemId: string;
  mcpToolRegistrationId: string;
  transcriptItemId: string;
  proposalItemId: string;
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

async function send(caller: Caller | null, request: Request): Promise<Answer> {
  const headers: Record<string, string> = { ...(caller?.headers ?? {}), ...(request.headers ?? {}) };
  let body: string | undefined;
  if (request.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }
  const res = await fetch(`${baseUrl}${request.path}`, { method: request.method, headers, body });
  return { status: res.status, text: await res.text() };
}

/** Expects a 2xx and returns the body text — for fixture writes made through the real routes. */
async function sendOk(caller: Caller, request: Request): Promise<string> {
  const answer = await send(caller, request);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${request.method} ${request.path} answered ${answer.status}: ${answer.text}`);
  }
  return answer.text;
}

/** The comparison rule: every occurrence of a requested value is replaced with `<id>`. */
function masked(answer: Answer, values: readonly string[]): Answer {
  let text = answer.text;
  for (const value of values) text = text.split(value).join("<id>");
  return { status: answer.status, text };
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

async function expectExcludesA(caller: Caller, request: Request): Promise<Answer> {
  const answer = await send(caller, request);
  expectNoneOf(answer.text, a.ids, `${request.method} ${request.path}`);
  return answer;
}

/** The reads A uses to observe its own rows; compared before and after every mutating case. */
function aStateReads(): Request[] {
  return [
    { method: "GET", path: "/api/databases?limit=100" },
    { method: "GET", path: `/api/databases/${a.databaseId}` },
    { method: "GET", path: `/api/databases/${a.targetDatabaseId}` },
    { method: "GET", path: `/api/databases/${a.archivedDatabaseId}` },
    { method: "GET", path: `/api/databases/${a.databaseId}/properties` },
    { method: "GET", path: `/api/databases/${a.targetDatabaseId}/properties` },
    { method: "GET", path: `/api/views?limit=100` },
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
    { method: "GET", path: `/api/transcripts/${a.transcriptItemId}/speakers` },
    { method: "GET", path: "/api/account/exports" },
  ];
}

/** A's own view of its rows, plus the heartbeat, run events and push subscriptions no route lists. */
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
    return { heartbeats: heartbeats.rows, events: events.rows };
  });
  lines.push(`heartbeats ${JSON.stringify(rows.heartbeats)}`);
  lines.push(`agent run events ${JSON.stringify(rows.events)}`);
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
  // Re-read after the relation write, which may have bumped the item's version.
  const itemVersion = readString(await sendOk(member, { method: "GET", path: `/api/items/${item.id}` }), "updatedAt");

  const fileContent = `audio of ${randomUUID()}`;
  const fileItemId = readString(
    await sendOk(member, {
      method: "POST",
      path: "/api/files",
      body: fileContent,
      headers: { "Content-Type": "audio/mpeg", "X-Filename": "probe.mp3" },
    }),
    "id",
  );
  const blobId = await inTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM blobs");
    if (rows.length !== 1) throw new Error(`expected exactly one blob in tenant ${tenantId}`);
    return rows[0]!.id;
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
    await sendOk(member, { method: "GET", path: "/api/databases?limit=100" }),
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
    blobId,
    projectItemId,
    ...scoped,
    transcriptItemId,
    proposalItemId,
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
    expect(refused).toEqual({ status: 403, text: JSON.stringify({ error: { code: "admin_required" } }) });

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
  "revoke session": async () => {
    await expectForeignLikeRandom(b.member, [a.secondSession.sessionId], ([id]) => ({
      method: "POST",
      path: entryPath("revoke session", id!),
      body: {},
    }));
    await expectAAccountActive();
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
      await expectAAccountActive();
    } finally {
      // Re-register A's device as A when the case displaced it, so later cases start from an
      // active subscription instead of failing on this case's leftover.
      const subscriptions = await runInTenant(a.tenantId, () => listPushSubscriptionsForUser(pool, a.member.userId));
      if (subscriptions.find((subscription) => subscription.id === a.pushSubscriptionId)?.revokedAt !== null) {
        a.pushSubscriptionId = readString(await sendOk(a.member, register(a.pushDeviceToken)), "subscription", "id");
      }
    }
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
    await expectExcludesA(b.member, { method: "GET", path: "/api/notifications/unread" });
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
      await expectExcludesA(b.member, { method: "POST", path: "/api/notifications/mark-all-read", body: {} });
    }),
  "schema projection": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/schema" });
  },
  "ai usage report": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/ai-usage?from=2026-01-01&to=2030-01-01" });
  },
  "system health report": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/system-health" });
  },
  "confirm proposal": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.proposalItemId], ([id]) => ({
        method: "POST",
        path: `/api/proposals/${id}/confirm`,
        body: {},
      }));
    }),
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
    await expectExcludesA(b.member, { method: "GET", path: "/api/approval-requests" });
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
      const withoutTimestamps = (answer: Answer, project: string): Answer => ({
        status: answer.status,
        text: masked(answer, [project]).text.replace(/"(createdAt|updatedAt)":"[^"]*"/g, '"$1":"<at>"'),
      });
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
    await expectExcludesA(b.member, { method: "GET", path: "/api/databases?limit=100" });
  },
  "create database": () =>
    leavesAUnchanged(async () => {
      await expectForeignLikeRandom(b.member, [a.itemId], ([parentItemId]) => ({
        method: "POST",
        path: "/api/databases",
        body: { name: "Child of a foreign item", parentItemId },
      }));
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
    await expectExcludesA(b.member, { method: "GET", path: "/api/views?limit=100" });
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
  "add/reposition curated view item": () =>
    leavesAUnchanged(async () => {
      await curatedItemCases("PUT", { position: 0 });
    }),
  "reorder curated view item": () =>
    leavesAUnchanged(async () => {
      await curatedItemCases("PATCH", { position: 0 });
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
    for (const databaseId of [b.databaseId, b.targetDatabaseId]) {
      for (const inTrash of [false, true]) {
        await expectExcludesA(b.member, {
          method: "POST",
          path: `/api/databases/${databaseId}/query`,
          body: { inTrash },
        });
      }
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
      await expectExcludesA(b.member, { method: "POST", path: `/api/views/${viewId}/query`, body: {} });
    }
  },
  "create/replace relation": () =>
    leavesAUnchanged(async () => {
      await relationCases("PUT", {});
    }),
  "delete relation": () =>
    leavesAUnchanged(async () => {
      await relationCases("DELETE", undefined);
    }),

  // --- tenant: files, exports, account deletion ----------------------------------------------
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
      const foreign = await expectExcludesA(b.member, upload(a.fileContent));
      const random = await expectExcludesA(b.member, upload(`audio of ${randomUUID()}`));
      expect(random.status).toBe(201);
      expect(foreign.status, foreign.text).toBe(random.status);
    }),
  "download blob": async () => {
    await expectForeignLikeRandom(b.member, [a.blobId], ([id]) => ({ method: "GET", path: `/api/blobs/${id}` }));
  },
  "request account export": () =>
    leavesAUnchanged(async () => {
      const answer = await expectExcludesA(b.member, { method: "POST", path: "/api/account/exports", body: {} });
      expect(answer.status).toBeLessThan(300);
    }),
  "list account exports": async () => {
    await expectExcludesA(b.member, { method: "GET", path: "/api/account/exports" });
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

// ---------------------------------------------------------------------------------------------
// MCP cases, one per generic operation
// ---------------------------------------------------------------------------------------------

interface McpProbe {
  /** `tools/call` with A's ids answers exactly as with random ids. */
  foreignLikeRandom(
    foreign: readonly string[],
    args: (values: readonly string[]) => Record<string, unknown>,
  ): Promise<void>;
  /** `tools/call` returns none of A's ids. */
  excludesA(args: Record<string, unknown>): Promise<void>;
}

type McpCase = (probe: McpProbe) => Promise<void>;

const MCP_CASES = {
  "database.list": (p) => p.excludesA({}),
  "database.get": (p) => p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId })),
  "database.create": (p) =>
    p.foreignLikeRandom([a.itemId], ([parentItemId]) => ({ name: "Child of a foreign item", parentItemId })),
  "database.patch": (p) =>
    p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, patch: { name: "Renamed by B" } })),
  "database.archive": (p) => p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId })),
  "database.restore": (p) => p.foreignLikeRandom([a.archivedDatabaseId], ([databaseId]) => ({ databaseId })),
  "property.list": async (p) => {
    await p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId }));
    await p.excludesA({ databaseId: b.databaseId });
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
  "view.list": (p) => p.excludesA({}),
  "view.get": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId })),
  "view.create": (p) =>
    p.foreignLikeRandom([a.databaseId], ([databaseId]) => ({ databaseId, type: "table", name: "Probe" })),
  "view.patch": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId, patch: { name: "Renamed by B" } })),
  "view.delete": (p) => p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId })),
  "view.query": async (p) => {
    await p.foreignLikeRandom([a.viewId], ([viewId]) => ({ viewId }));
    await p.foreignLikeRandom([a.curatedViewId], ([viewId]) => ({ viewId }));
    await p.excludesA({ viewId: b.viewId });
    await p.excludesA({ viewId: b.curatedViewId });
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
    await p.excludesA({ databaseId: b.databaseId });
    await p.excludesA({ databaseId: b.databaseId, inTrash: true });
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
    async excludesA(args) {
      const answer = await expectExcludesA(caller, mcpCall(operation, args));
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
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: SETUP_TOKEN,
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    a = await seedTenant();
    b = await seedTenant();
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

  it("sees its own fixture rows as A, so a foreign answer is a real refusal", async () => {
    // Positive control: each id the cases probe is visible to A, and differs from a random id.
    const reads: Array<(id: string) => Request> = [
      (id) => ({ method: "GET", path: `/api/databases/${id}` }),
      (id) => ({ method: "GET", path: `/api/items/${id}` }),
      (id) => ({ method: "GET", path: `/api/agent-runs/${id}` }),
      (id) => ({ method: "GET", path: `/api/blobs/${id}` }),
      (id) => ({ method: "GET", path: `/api/views/${id}` }),
      (id) => ({ method: "GET", path: `/api/properties/${id}` }),
    ];
    const ids = [a.databaseId, a.itemId, a.agentRunId, a.blobId, a.viewId, a.propertyId];
    for (const [index, read] of reads.entries()) {
      const own = await send(a.member, read(ids[index]!));
      expect(own.status, own.text).toBe(200);
      expect((await send(b.member, read(ids[index]!))).status).not.toBe(200);
    }
    expect(readIdArray(await sendOk(a.member, { method: "GET", path: "/api/approval-requests" }), "rows")).toEqual([
      a.approvalRequestId,
    ]);
    const notifications = await sendOk(a.member, { method: "GET", path: "/api/notifications/unread" });
    expect(readIdArray(notifications, "notifications")).toEqual([a.notificationId]);
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
