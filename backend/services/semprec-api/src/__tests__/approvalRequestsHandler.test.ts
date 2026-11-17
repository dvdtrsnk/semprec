import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import {
  createViewTypeRegistry,
  seedSystem,
  createAgentRun,
  createPendingApprovalRequest,
  createItemWithClient,
  createSempChatThread,
  getDatabaseByModuleId,
  sendSempMessage,
  upsertMcpToolRegistration,
  withTransaction,
  createChokePoint,
  createUser,
  hashPassword,
  login,
  approvalNotificationBody,
  approvalNotificationLinkHref,
  buildMcpInvokeApprovalDescription,
  writeNotification,
  type ChokePoint,
} from "@semprec/data";
import { createApprovalRequestsRequestListener } from "../approvalRequestsHandler.js";

const PASSWORD = "s3cret-password";
const RESOURCE_SNAPSHOT = { kind: "test", resourceId: "test", sha256: null };

let pool: Pool;

let tenantUserEmail: string;
let tenantUserSignedIn: boolean;

type AuthHeaders = { Authorization: string };
type Session = { headers: AuthHeaders; userId: string };

/**
 * The first call signs in tenant zero's user, later ones the user of a fresh tenant. A run's actor must be its
 * own tenant's user and a tenant has one user, so only the first session can own a request.
 */
async function authSession(): Promise<Session> {
  let email = tenantUserEmail;
  if (tenantUserSignedIn) {
    email = `${randomUUID()}@example.com`;
    await createUser(pool, {
      email,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: await createTestTenant(pool),
    });
  }
  tenantUserSignedIn = true;
  const { token, user } = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { headers: { Authorization: `Bearer ${token}` }, userId: user.id };
}

async function countExecuteJobs(approvalRequestId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = 'approvalExecute' AND j.payload->'payload'->>'approvalRequestId' = $1`,
    [approvalRequestId],
  );
  return rows[0]!.count;
}

async function requestRow(id: string) {
  const { rows } = await pool.query<{ status: string; decided_by: string | null }>(
    "SELECT status, decided_by FROM approval_requests WHERE id = $1",
    [id],
  );
  return rows[0];
}

type RequestInput = Parameters<typeof createPendingApprovalRequest>[1];

/** An MCP request of a new run; `run` and `request` override the run and request fields. */
async function createRequest(
  userId: string | null,
  {
    run = {},
    request = {},
    db = pool,
  }: {
    run?: Partial<Parameters<typeof createAgentRun>[1]>;
    request?: Partial<RequestInput>;
    db?: Pool | PoolClient;
  } = {},
) {
  const created = await createAgentRun(db, {
    triggeredBy: "user",
    task: "test",
    ...(userId === null ? {} : { userId }),
    ...run,
  });
  const pending = await createPendingApprovalRequest(db, {
    agentRunId: created.id,
    toolName: "send_email",
    riskClass: "outbound",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: RESOURCE_SNAPSHOT,
    ...request,
  });
  return { ...pending, runId: created.id };
}

/** The request most tests decide: an unclassified MCP call whose one argument is `query: "hi"`. */
async function createPendingRequest(ownerUserId: string): Promise<string> {
  const created = await createRequest(ownerUserId, {
    request: {
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } },
    },
  });
  return created.id;
}

/** A request of a generic operation that deletes an item. */
async function createGenericRequest(session: Session, itemId: string) {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
  return createPendingApprovalRequest(pool, {
    agentRunId: run.id,
    toolName: "item.delete",
    riskClass: "destructive",
    payload: {
      operationName: "item.delete",
      canonicalInput: { itemId },
      actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: session.userId },
      resourceSnapshot: RESOURCE_SNAPSHOT,
    },
    resourceSnapshot: RESOURCE_SNAPSHOT,
  });
}

function chatThread(db: Pool = pool): Promise<string> {
  return withTransaction(db, (client) => createSempChatThread(client));
}

const chatSource = (threadId: string, threadTitle: string | null) => ({
  kind: "chat",
  threadId,
  threadTitle,
  heartbeatId: null,
  heartbeatName: null,
  mcpClientName: null,
});

/** The HTTP calls of the listener served at `baseUrl()`. */
function api(baseUrl: () => string) {
  const get = (headers: AuthHeaders | undefined, path: string) =>
    fetch(`${baseUrl()}${path}`, headers ? { headers } : {});
  const patch = (headers: AuthHeaders, id: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl()}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const decide = (headers: AuthHeaders, id: string, decision: string) => patch(headers, id, { decision });
  /** A read that must answer 200, as parsed JSON. */
  const read = async (headers: AuthHeaders, path: string): Promise<unknown> => {
    const res = await get(headers, path);
    expect(res.status, path).toBe(200);
    return res.json();
  };
  /** A read that must answer 200, as text. */
  const readText = async (headers: AuthHeaders, path: string): Promise<string> => {
    const res = await get(headers, path);
    expect(res.status, path).toBe(200);
    return res.text();
  };
  /** A decision that must answer 200, as parsed JSON. */
  const decided = async (headers: AuthHeaders, id: string, decision: string): Promise<unknown> => {
    const res = await decide(headers, id, decision);
    expect(res.status).toBe(200);
    return res.json();
  };
  const ids = async (headers: AuthHeaders, query: string): Promise<string[]> =>
    z
      .object({ rows: z.array(z.object({ id: z.uuid() })) })
      .parse(await read(headers, `/api/approval-requests${query}`))
      .rows.map((row) => row.id);
  return { get, patch, decide, read, readText, decided, ids };
}

describe("createApprovalRequestsRequestListener", () => {
  let server: Server;
  let baseUrl: string;
  let chokePoint: ChokePoint;
  const { get, patch, decide, read, readText, decided, ids } = api(() => baseUrl);

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    tenantUserEmail = `${randomUUID()}@example.com`;
    tenantUserSignedIn = false;
    await createTenantZeroUser(pool, tenantUserEmail);
    await pool.query("UPDATE users SET password_hash = $2 WHERE email = $1", [
      tenantUserEmail,
      await hashPassword(PASSWORD),
    ]);
    await seedSystem(pool, viewTypeRegistry);

    server = createServer(createApprovalRequestsRequestListener(pool));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.each([
    ["PATCH one request", "PATCH", `/api/approval-requests/${randomUUID()}`, undefined],
    [
      "PATCH one request with a garbage bearer token",
      "PATCH",
      `/api/approval-requests/${randomUUID()}`,
      "Bearer garbage",
    ],
    ["GET the list", "GET", "/api/approval-requests", undefined],
    ["GET the list whatever its parameters", "GET", "/api/approval-requests?status=decided", undefined],
    ["GET one request", "GET", `/api/approval-requests/${randomUUID()}`, undefined],
    ["GET the count", "GET", "/api/approval-requests/count", undefined],
    ["GET the count with a status", "GET", "/api/approval-requests/count?status=pending", undefined],
  ])("rejects %s with no valid credentials with 401", async (_label, method, path, authorization) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      ...(authorization ? { headers: { Authorization: authorization } } : {}),
    });
    expect(res.status).toBe(401);
  });

  it.each<[string, string | undefined, Record<string, unknown> | string, number, Record<string, unknown>?]>([
    ["an invalid decision value", undefined, { decision: "maybe" }, 400],
    [
      "a non-UUID approval request id",
      "foo",
      { decision: "approved" },
      400,
      { code: "validation_failed", details: { field: "id" } },
    ],
    ["a malformed JSON body", undefined, "{not valid json", 400],
    [
      "a body over the maximum allowed size",
      undefined,
      { decision: "approved", decidedByUserId: "x".repeat(2 * 1024 * 1024) },
      413,
    ],
  ])("refuses a PATCH with %s", async (_label, id, body, status, error) => {
    const session = await authSession();
    const requestId = id ?? (await createPendingRequest(session.userId));
    const res = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    expect(res.status).toBe(status);
    if (error) expect(await res.json()).toMatchObject(error);
    if (id === undefined) expect(await requestRow(requestId)).toEqual({ status: "pending", decided_by: null });
  });

  it.each([
    ["an unknown path", "GET", "/not-a-real-path"],
    ["a method other than GET and PATCH on a request: POST", "POST", "/api/approval-requests/:id"],
    ["a method other than GET and PATCH on a request: PUT", "PUT", "/api/approval-requests/:id"],
    ["a method other than GET and PATCH on a request: DELETE", "DELETE", "/api/approval-requests/:id"],
    ["a method other than GET on the count: PATCH", "PATCH", "/api/approval-requests/count"],
    ["a method other than GET on the count: POST", "POST", "/api/approval-requests/count"],
    ["a method other than GET on the count: DELETE", "DELETE", "/api/approval-requests/count"],
  ])("answers 404 to %s and makes no decision", async (_label, method, path) => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);
    const res = await fetch(`${baseUrl}${path.replace(":id", id)}`, {
      method,
      headers: { ...session.headers, "Content-Type": "application/json" },
      ...(path.endsWith("/count") && method !== "DELETE" ? { body: JSON.stringify({ decision: "approved" }) } : {}),
    });
    expect(res.status).toBe(404);
    if (path.endsWith("/count")) expect(await res.json()).toEqual({ error: "Not found" });
    expect(await requestRow(id)).toEqual({ status: "pending", decided_by: null });
    expect(await countExecuteJobs(id)).toBe(0);
  });

  it("approves a pending request for the session user, ignoring a body decidedByUserId, and answers without the payload's argument values", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);
    const claimedDecider = randomUUID();

    const res = await patch(session.headers, id, { decision: "approved", decidedByUserId: claimedDecider });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: "approved", decidedBy: session.userId });
    expect(body).not.toMatchObject({ decidedBy: claimedDecider });
    expect(await requestRow(id)).toEqual({ status: "approved", decided_by: session.userId });
    expect(await countExecuteJobs(id)).toBe(1);
    expect(body).not.toHaveProperty("payload");
    expect(JSON.stringify(body)).not.toContain('"hi"');
    // The server item and registration do not exist: still 200, with null names.
    expect(body).toMatchObject({ safeSummary: { argKeys: ["query"], mcpServerName: null, mcpToolName: null } });
  });

  it("returns names and a null deleted server name in actual approval responses", async () => {
    const session = await authSession();
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      "mcpServers",
    ]);
    const databaseId = rows[0]?.id;
    if (!databaseId) throw new Error("Missing MCP server database");
    const serverItem = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name: "Search server", active: true } }),
    );
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: serverItem.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const request = await createRequest(session.userId, {
      request: {
        toolName: "search_web",
        riskClass: "write",
        payload: {
          mcpToolRegistrationId: registration.id,
          mcpServerItemId: serverItem.id,
          args: { query: "private-argument" },
        },
      },
    });
    const listed = (mcpServerName: string | null) => ({
      rows: [
        expect.objectContaining({
          id: request.id,
          safeSummary: expect.objectContaining({ mcpServerName, mcpToolName: "search_web", argKeys: ["query"] }),
        }),
      ],
    });
    const before = await read(session.headers, "/api/approval-requests");
    expect(before).toMatchObject(listed("Search server"));
    expect(JSON.stringify(before)).not.toContain("private-argument");
    expect(await chokePoint.softDeleteItem(databaseId, serverItem.id, session.userId)).not.toBeNull();
    expect(await read(session.headers, "/api/approval-requests")).toMatchObject(listed(null));
    const result = await decided(session.headers, request.id, "rejected");
    expect(result).toMatchObject({ safeSummary: { mcpServerName: null, mcpToolName: "search_web" } });
    expect(JSON.stringify(result)).not.toContain("private-argument");
  });

  it.each([
    [
      { error: { code: "version_conflict", details: { currentResource: "private-marker" } } },
      "approval.conflict.changed",
    ],
    [{ error: { code: "version_conflict", details: { reason: "not_found" } } }, "approval.conflict.deleted"],
    [
      { error: { code: "version_conflict", details: { reason: "owner_violation" } } },
      "approval.conflict.provenanceChanged",
    ],
    [{ error: { code: "version_conflict", details: { reason: "database_archived" } } }, "approval.conflict.archived"],
    [{ error: { code: "version_conflict", details: { reason: "unknown" } } }, "approval.conflict.other"],
    [{ text: "private-marker", outcomeKind: "toolUnavailable" }, "approval.conflict.toolUnavailable"],
    [{ text: "private-marker", outcomeKind: "callFailed" }, "approval.outcome.failed"],
    ["private-marker", "approval.conflict.other"],
  ])("returns a safe conflict reason through PATCH", async (executionResult, key) => {
    const session = await authSession();
    const generic = typeof executionResult === "object" && executionResult !== null && "error" in executionResult;
    const id = generic
      ? (await createGenericRequest(session, "private-marker")).id
      : await createPendingRequest(session.userId);
    await decided(session.headers, id, "approved");
    // Raw SQL: the conflict is the execute job's result, which needs the real tool call.
    await pool.query(
      "UPDATE approval_requests SET execution_status = 'conflict', execution_result_jsonb = $2::jsonb WHERE id = $1",
      [id, JSON.stringify(executionResult)],
    );
    const body = await decided(session.headers, id, "approved");
    expect(body).toMatchObject({ executionStatus: "conflict", conflictReason: { key } });
    expect(body).not.toHaveProperty("executionResult");
    expect(JSON.stringify(body)).not.toContain("private-marker");
    expect(JSON.stringify(body)).not.toContain('"hi"');
  });

  it("answers a non-owner's PATCH with the same 404 as a random id and no outcome, before and after the owner decides (issue #1028)", async () => {
    const owner = await authSession();
    const id = await createPendingRequest(owner.userId);
    const other = await authSession();

    const unknown = await decide(other.headers, randomUUID(), "approved");
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    expect(JSON.parse(unknownBody)).toEqual({ error: "Not found" });
    const foreignBeforeDecision = await decide(other.headers, id, "approved");
    expect(foreignBeforeDecision.status).toBe(404);
    expect(await foreignBeforeDecision.text()).toBe(unknownBody);
    expect(await requestRow(id)).toEqual({ status: "pending", decided_by: null });
    expect(await countExecuteJobs(id)).toBe(0);

    await decided(owner.headers, id, "approved");
    expect(await countExecuteJobs(id)).toBe(1);
    const foreignAfterDecision = await decide(other.headers, id, "approved");
    expect(foreignAfterDecision.status).toBe(404);
    expect(await foreignAfterDecision.text()).toBe(unknownBody);
    expect(await countExecuteJobs(id)).toBe(1);
    expect(await requestRow(id)).toEqual({ status: "approved", decided_by: owner.userId });
  });

  describe("GET /api/approval-requests (issue #132)", () => {
    it("returns an empty queue and a zero count when there are no pending requests", async () => {
      const session = await authSession();
      expect(await read(session.headers, "/api/approval-requests")).toEqual({ rows: [] });
      // The literal path is a count, not a request id.
      expect(await read(session.headers, "/api/approval-requests/count")).toEqual({ count: 0 });
      expect(await read(session.headers, "/api/approval-requests/count?status=pending&source=chat")).toEqual({
        count: 0,
      });
    });

    it("keeps every earlier field of a row unchanged and adds the source (issue #1766)", async () => {
      const session = await authSession();
      const projects = await chokePoint.createDatabase({ name: "Projects" });
      await chokePoint.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "title" });
      const projectItem = await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Kitchen" } });
      const threadId = await chatThread();
      // Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway.
      await pool.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, "Kitchen plans"]);
      const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } };
      const description = { key: "approval.mcpInvoke", params: { toolName: "send_email" } };
      const created = await createRequest(session.userId, {
        run: { projectItemId: projectItem.id, threadId },
        request: { payload, reason: "The customer asked for a quote", description },
      });

      const body = await read(session.headers, "/api/approval-requests");
      expect(body).toEqual({
        rows: [
          {
            id: created.id,
            toolName: "send_email",
            riskClass: "outbound",
            riskLevel: "outbound",
            requestedAt: new Date(created.requestedAt).toISOString(),
            safeSummary: {
              kind: "mcpInvoke",
              mcpToolRegistrationId: payload.mcpToolRegistrationId,
              mcpServerItemId: payload.mcpServerItemId,
              mcpServerName: null,
              mcpToolName: null,
              argKeys: ["to"],
            },
            agentRunId: created.runId,
            projectItemId: projectItem.id,
            projectName: "Kitchen",
            reason: "The customer asked for a quote",
            description,
            breaksLinks: [],
            endsInheritance: [],
            source: chatSource(threadId, "Kitchen plans"),
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("a@b.com");
    });

    it("lists and counts only the caller's own pending requests (issue #1028)", async () => {
      const owner = await authSession();
      const ownId = await createPendingRequest(owner.userId);
      // The other account's requests live in its own tenant, the only place its run can be recorded.
      const otherTenant = await createTestTenant(pool);
      const other = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: otherTenant,
      });
      await withTenantTransaction(pool, otherTenant, async (client) => {
        for (let copy = 0; copy < 2; copy += 1) await createRequest(other.id, { db: client });
      });

      expect(await read(owner.headers, "/api/approval-requests")).toEqual({
        rows: [expect.objectContaining({ id: ownId })],
      });
      expect(await read(owner.headers, "/api/approval-requests/count")).toEqual({ count: 1 });
    });
  });

  describe("GET /api/approval-requests with list parameters (issue #1785)", () => {
    const pageSchema = z.strictObject({
      rows: z.array(z.looseObject({ id: z.uuid() })),
      nextCursor: z.string().nullable(),
    });

    /** In sort order: the fields the unpaged queue returns. */
    const PENDING_ROW_KEYS = [
      "agentRunId",
      "breaksLinks",
      "description",
      "endsInheritance",
      "id",
      "projectItemId",
      "projectName",
      "reason",
      "requestedAt",
      "riskClass",
      "riskLevel",
      "safeSummary",
      "source",
      "toolName",
    ];

    async function listPage(session: Session, query: string) {
      return pageSchema.parse(await read(session.headers, `/api/approval-requests${query}`));
    }

    function encodeCursor(text: string): string {
      return Buffer.from(text).toString("base64url");
    }

    it.each([
      ["status", "?status=pending"],
      ["source", "?source=chat"],
      ["q", "?q=search"],
      ["order", "?order=asc"],
      ["limit", "?limit=10"],
      ["cursor", `?cursor=${encodeCursor(`9999-01-01T00:00:00.000000Z|${randomUUID()}`)}`],
    ])("answers one page with nextCursor when only %s is given", async (_name, query) => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      const page = await listPage(session, query);
      expect(page).toMatchObject({ rows: [{ id }], nextCursor: null });
      expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual(PENDING_ROW_KEYS);
    });

    it("keeps the answer without parameters at pending requests, oldest first, in rows only, as the count counts them", async () => {
      const session = await authSession();
      const first = await createPendingRequest(session.userId);
      const second = await createPendingRequest(session.userId);
      const decidedId = await createPendingRequest(session.userId);
      await decided(session.headers, decidedId, "approved");

      const body = await read(session.headers, "/api/approval-requests");
      expect(body).toEqual({ rows: [expect.objectContaining({ id: first }), expect.objectContaining({ id: second })] });
      expect(await read(session.headers, "/api/approval-requests/count")).toEqual({ count: 2 });
      expect(await read(session.headers, "/api/approval-requests/count?status=pending")).toEqual({ count: 2 });
      expect(await ids(session.headers, "?status=pending")).toHaveLength(2);
    });

    it("pages pending requests newest first, 50 to a page unless limit says otherwise", async () => {
      const session = await authSession();
      const created: string[] = [];
      for (let index = 0; index < 51; index += 1) created.push(await createPendingRequest(session.userId));
      const newestFirst = [...created].reverse();

      const firstPage = await listPage(session, "?status=pending");
      expect(firstPage.rows.map((row) => row.id)).toEqual(newestFirst.slice(0, 50));
      expect(firstPage.nextCursor).not.toBeNull();
      const lastPage = await listPage(session, `?status=pending&cursor=${firstPage.nextCursor}`);
      expect(lastPage).toEqual({ rows: [expect.objectContaining({ id: created[0] })], nextCursor: null });

      const whole = await listPage(session, "?limit=100");
      expect(whole.rows.map((row) => row.id)).toEqual(newestFirst);
      expect(whole.nextCursor).toBeNull();
      const single = await listPage(session, "?limit=1&order=asc");
      expect(single.rows.map((row) => row.id)).toEqual([created[0]]);
      expect(single.nextCursor).not.toBeNull();
    });

    it("lists decided requests newest decision first with their status, decision time and execution status", async () => {
      const session = await authSession();
      const approved = await createPendingRequest(session.userId);
      const rejected = await createPendingRequest(session.userId);
      const pending = await createPendingRequest(session.userId);
      // Decided in reverse, so decision order differs from request order.
      await decided(session.headers, rejected, "rejected");
      await decided(session.headers, approved, "approved");

      const page = await listPage(session, "?status=decided");
      expect(page).toMatchObject({
        rows: [
          { id: approved, status: "approved", executionStatus: "queued", conflictReason: null },
          { id: rejected, status: "rejected", executionStatus: "not_approved", conflictReason: null },
        ],
        nextCursor: null,
      });
      expect(page.rows).toHaveLength(2);
      for (const row of page.rows) {
        expect(Object.keys(row).sort()).toEqual(
          [...PENDING_ROW_KEYS, "conflictReason", "decidedAt", "executionStatus", "status"].sort(),
        );
        expect(z.iso.datetime().safeParse(row.decidedAt).success).toBe(true);
      }
      expect(JSON.stringify(page)).not.toContain(pending);
      expect(await ids(session.headers, "?status=decided&order=asc")).toEqual([rejected, approved]);
    });

    it("filters by source and finds a request by a word of its description, without diacritics", async () => {
      const session = await authSession();
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "chat",
        userId: session.userId,
        threadId: await chatThread(),
      });
      const fromChat = await createRequest(null, {
        run: { triggeredBy: "supervisor", task: "delegated", parentRunId: chatRun.id },
        request: {
          toolName: "property.delete",
          riskClass: "destructive",
          description: {
            key: "approval.propertyDelete",
            params: { propertyName: "Nálada", databaseKey: "journal", databaseName: "Deník", affectedCount: 3 },
          },
        },
      });
      const fromMcp = await createRequest(session.userId, { run: { triggeredBy: "mcp", task: "mcp" } });

      for (const [query, expected] of [
        ["?source=chat", [fromChat.id]],
        ["?source=mcp", [fromMcp.id]],
        ["?source=tick", []],
        ["?source=mcp,chat,mcp", [fromMcp.id, fromChat.id]],
        ["?q=nalada", [fromChat.id]],
        ["?q=%20NALADA%20", [fromChat.id]],
        ["?q=nalada&source=mcp", []],
        ["?q=", [fromMcp.id, fromChat.id]],
        [`?q=${"a".repeat(100)}`, []],
      ] as const)
        expect(await ids(session.headers, query), query).toEqual(expected);
    });

    it("counts the requests of the given source kinds, as many as the list returns for the same filter", async () => {
      const session = await authSession();
      for (const kind of ["chat", "chat", "mcp"] as const)
        await createRequest(session.userId, {
          run: kind === "chat" ? { threadId: await chatThread() } : { triggeredBy: "mcp" },
        });

      for (const [query, expected] of [
        ["?status=pending&source=chat", 2],
        ["?status=pending&source=mcp", 1],
        ["?source=tick", 0],
        ["?source=chat,mcp", 3],
        ["?source=mcp,chat,mcp", 3],
        ["?status=pending", 3],
      ] as const) {
        expect(await read(session.headers, `/api/approval-requests/count${query}`), query).toEqual({ count: expected });
        expect(await ids(session.headers, query), query).toHaveLength(expected);
      }
    });

    it.each([
      ["list", "limit", "?limit=0"],
      ["list", "limit", "?limit=101"],
      ["list", "limit", "?limit=abc"],
      ["list", "limit", "?limit=1.5"],
      ["list", "limit", "?limit=-1"],
      ["list", "limit", "?limit="],
      ["list", "limit", "?limit=1&limit=2"],
      ["list", "status", "?status=done"],
      ["list", "status", "?status="],
      ["list", "status", "?status=PENDING"],
      ["list", "status", "?status=pending&status=decided"],
      ["list", "order", "?order=newest"],
      ["list", "order", "?order="],
      ["list", "order", "?order=asc&order=desc"],
      ["list", "source", "?source=inbox"],
      ["list", "source", "?source=chat,"],
      ["list", "source", "?source=CHAT"],
      ["list", "source", "?source=chat&source=mcp"],
      ["list", "cursor", "?cursor=abc"],
      ["list", "cursor", "?cursor="],
      ["list", "cursor", "?cursor=a&cursor=b"],
      ["list", "q", `?q=${"a".repeat(101)}`],
      ["list", "q", "?q=a%00b"],
      ["list", "q", "?q=a&q=b"],
      ["count", "status", "?status=decided"],
      ["count", "status", "?status="],
      ["count", "status", "?status=PENDING"],
      ["count", "status", "?status=pending&status=pending"],
      ["count", "source", "?status=pending&source=inbox"],
      ["count", "source", "?source="],
      ["count", "source", "?source=chat,"],
      ["count", "source", "?source=CHAT"],
      ["count", "source", "?source=chat,inbox"],
      ["count", "source", "?source=chat&source=mcp"],
    ])("answers the %s 400 naming %s for %s", async (endpoint, field, query) => {
      const session = await authSession();
      await createPendingRequest(session.userId);

      const res = await get(session.headers, `/api/approval-requests${endpoint === "count" ? "/count" : ""}${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field } });
    });
  });

  describe("outcome of the decision (issue #2022)", () => {
    it.each([
      ["approved", 1],
      ["rejected", 0],
    ])("answers outcome decided for the call that %s a pending request", async (decision, jobs) => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      expect(await decided(session.headers, id, decision)).toMatchObject({ id, status: decision, outcome: "decided" });
      expect(await countExecuteJobs(id)).toBe(jobs);
    });

    it.each([
      ["approved", "approved", 1],
      ["approved", "rejected", 1],
      ["rejected", "rejected", 0],
      // An already rejected request stays rejected and queues no execution (issue #1831).
      ["rejected", "approved", 0],
    ])(
      "answers 200 with the current state and outcome unchanged for %s decided again as %s, and queues no second job",
      async (first, second, jobs) => {
        const session = await authSession();
        const id = await createPendingRequest(session.userId);
        const firstBody = z.looseObject({}).parse(await decided(session.headers, id, first));
        expect(firstBody).toMatchObject({ status: first, outcome: "decided" });

        const body = await decided(session.headers, id, second);
        expect(body).toEqual({ ...firstBody, outcome: "unchanged" });
        expect(body).toMatchObject({ status: first, decidedBy: session.userId });
        expect(await requestRow(id)).toEqual({ status: first, decided_by: session.userId });
        expect(await countExecuteJobs(id)).toBe(jobs);
      },
    );

    it("answers outcome decided to one of two concurrent decisions and unchanged to the other", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      const answers = await Promise.all([
        decided(session.headers, id, "approved"),
        decided(session.headers, id, "approved"),
      ]);
      const outcomes = answers.map(
        (body) => z.looseObject({ outcome: z.enum(["decided", "unchanged"]) }).parse(body).outcome,
      );

      expect([...outcomes].sort()).toEqual(["decided", "unchanged"]);
      expect(await countExecuteJobs(id)).toBe(1);
    });

    it("does not carry the outcome on the reads of requests, decided ones included", async () => {
      const session = await authSession();
      const decidedId = await createPendingRequest(session.userId);
      const pendingId = await createPendingRequest(session.userId);
      await decided(session.headers, decidedId, "approved");
      await decided(session.headers, decidedId, "approved");

      for (const path of [
        `/api/approval-requests/${decidedId}`,
        `/api/approval-requests/${pendingId}`,
        "/api/approval-requests",
        "/api/approval-requests?status=pending",
        "/api/approval-requests?status=decided",
      ])
        expect(await readText(session.headers, path), path).not.toContain("outcome");
      // Proves the answer above is not empty by accident.
      expect(await readText(session.headers, "/api/approval-requests?status=decided")).toContain(decidedId);
    });
  });

  describe("GET /api/approval-requests/:id (issue #1786)", () => {
    it("returns the view of a pending request with its source, risk class and empty link lists, and no payload", async () => {
      const session = await authSession();
      const threadId = await chatThread();
      const created = await createRequest(session.userId, {
        run: { threadId },
        request: {
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } },
        },
      });

      const body = await read(session.headers, `/api/approval-requests/${created.id}`);
      expect(body).toMatchObject({
        id: created.id,
        status: "pending",
        decidedAt: null,
        decidedBy: null,
        executionStatus: "not_approved",
        toolName: "send_email",
        riskClass: "outbound",
        agentRunId: created.runId,
        safeSummary: { kind: "mcpInvoke", argKeys: ["to"] },
        source: { kind: "chat", threadId, heartbeatId: null, heartbeatName: null, mcpClientName: null },
        breaksLinks: [],
        endsInheritance: [],
      });
      expect(body).not.toHaveProperty("payload");
      // An MCP request's values come from `arguments`, redacted and bounded, and only there.
      expect(body).toMatchObject({ arguments: { to: "a@b.com" }, argumentsTruncated: false });
      expect(JSON.stringify(body).split("a@b.com")).toHaveLength(2);
    });

    it("carries the value links a request would end, as the list does (issue #1758)", async () => {
      const session = await authSession();
      const breaksLinks = [
        {
          itemId: randomUUID(),
          itemName: "a.pdf",
          propertyKey: "project",
          sourceItemId: randomUUID(),
          sourceItemName: "Plan trip",
          sourceDatabaseKey: "tasks",
          newValueName: "Beta",
        },
      ];
      const endsInheritance = [{ itemId: randomUUID(), propertyKey: "project", sourceName: "a.pdf" }];
      const created = await createRequest(session.userId, {
        request: {
          toolName: "relation.set",
          riskClass: "breaksLink",
          description: { key: "approval.breaksLink", params: {}, breaksLinks, endsInheritance },
        },
      });

      expect(await read(session.headers, `/api/approval-requests/${created.id}`)).toMatchObject({
        riskClass: "breaksLink",
        riskLevel: "breaksLink",
        breaksLinks,
        endsInheritance,
      });
      expect(await read(session.headers, "/api/approval-requests")).toMatchObject({
        rows: [{ id: created.id, breaksLinks, endsInheritance }],
      });
    });

    it("returns a decided request with the view the PATCH answered, its source included", async () => {
      const session = await authSession();
      const threadId = await chatThread();
      const { id } = await createRequest(session.userId, {
        run: { threadId },
        request: {
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } },
        },
      });
      const { outcome, ...decision } = z
        .looseObject({ outcome: z.string() })
        .parse(await decided(session.headers, id, "approved"));

      // The PATCH answer carries the call's outcome, which a read does not; the read adds an MCP request's argument
      // values, which the PATCH answer does not.
      expect(outcome).toBe("decided");
      expect(decision).toMatchObject({
        status: "approved",
        executionStatus: "queued",
        source: chatSource(threadId, null),
      });
      expect(await read(session.headers, `/api/approval-requests/${id}`)).toEqual({
        ...decision,
        arguments: { query: "hi" },
        argumentsTruncated: false,
      });
    });

    it("answers a request of another account, an unknown id and a decided request of another account with one 404", async () => {
      const owner = await authSession();
      const pendingId = await createPendingRequest(owner.userId);
      const decidedId = await createPendingRequest(owner.userId);
      await decided(owner.headers, decidedId, "rejected");
      const other = await authSession();

      const unknown = await get(other.headers, `/api/approval-requests/${randomUUID()}`);
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.text();
      expect(JSON.parse(unknownBody)).toEqual({ error: "Not found" });
      for (const id of [pendingId, decidedId]) {
        const foreign = await get(other.headers, `/api/approval-requests/${id}`);
        expect(foreign.status).toBe(404);
        expect(await foreign.text()).toBe(unknownBody);
        // The owner gets the same id, so the 404 above is a refusal and not a missing route.
        expect((await get(owner.headers, `/api/approval-requests/${id}`)).status).toBe(200);
      }
    });

    it("answers 400 validation_failed naming 'id' for an id that is no UUID", async () => {
      const res = await get((await authSession()).headers, "/api/approval-requests/foo");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field: "id" } });
    });
  });

  describe("argument values in the detail of one request (issue #2021)", () => {
    const RECIPIENT = "zebra-recipient@example.com";
    const SUBJECT = "Invoice 42 for the zebra project";
    const API_KEY = "sk-live-api-key-marker";
    const BEARER = "Bearer bearer-marker-value";
    const PASSWORD_VALUE = "password-marker-value";

    interface McpRequest {
      id: string;
      session: Session;
    }

    /** Made the way the approval-gated MCP tool makes it: the production description snapshot and notification. */
    async function createMcpRequest(args: Record<string, unknown>): Promise<McpRequest> {
      const session = await authSession();
      const created = await createRequest(session.userId, {
        request: {
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args },
          description: buildMcpInvokeApprovalDescription("Mail server", "send_email"),
        },
      });
      await withTransaction(pool, (client) =>
        writeNotification(client, {
          userId: session.userId,
          kind: "approval_pending",
          ...approvalNotificationBody(created),
          linkHref: approvalNotificationLinkHref("chat", created.id),
          sourceTable: "approval_requests",
          sourceId: created.id,
          transitionInstance: created.id,
        }),
      );
      return { id: created.id, session };
    }

    const detailText = (request: McpRequest) =>
      readText(request.session.headers, `/api/approval-requests/${request.id}`);

    const emailArgs = () => ({
      to: RECIPIENT,
      subject: SUBJECT,
      body: "Hello, the invoice is attached.",
      apiKey: API_KEY,
      options: { headers: { Authorization: BEARER, "X-Trace": "trace-1" }, password: PASSWORD_VALUE },
    });

    it("returns the argument values to the owner, pending and decided, and redacts an apiKey, a nested authorization header and a nested password", async () => {
      const request = await createMcpRequest(emailArgs());

      const text = await detailText(request);
      const body: unknown = JSON.parse(text);
      expect(body).toMatchObject({
        id: request.id,
        safeSummary: { kind: "mcpInvoke" },
        arguments: {
          to: RECIPIENT,
          subject: SUBJECT,
          body: "Hello, the invoice is attached.",
          apiKey: "[redacted]",
          options: { headers: { Authorization: "[redacted]", "X-Trace": "trace-1" }, password: "[redacted]" },
        },
        argumentsTruncated: false,
      });
      for (const secret of [API_KEY, BEARER, PASSWORD_VALUE]) expect(text).not.toContain(secret);
      // The safe summary names the arguments only; Postgres stores them in an order of its own.
      expect(
        z
          .looseObject({ safeSummary: z.looseObject({ argKeys: z.array(z.string()) }) })
          .parse(body)
          .safeSummary.argKeys.sort(),
      ).toEqual(["apiKey", "body", "options", "subject", "to"]);

      await decided(request.session.headers, request.id, "rejected");
      expect(JSON.parse(await detailText(request))).toMatchObject({
        status: "rejected",
        arguments: { to: RECIPIENT, subject: SUBJECT },
      });
    });

    it("shortens a 5,000-character body to 2,000 characters and sets argumentsTruncated", async () => {
      const request = await createMcpRequest({ to: RECIPIENT, body: "x".repeat(5000) });

      expect(JSON.parse(await detailText(request))).toMatchObject({
        arguments: { to: RECIPIENT, body: "x".repeat(2000) },
        argumentsTruncated: true,
      });
    });

    it("keeps the arguments within 16 KiB and sets argumentsTruncated", async () => {
      const entries = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`part${index}`, "y".repeat(1900)]));
      const request = await createMcpRequest({ to: RECIPIENT, ...entries });

      const body = z
        .looseObject({ arguments: z.record(z.string(), z.unknown()), argumentsTruncated: z.boolean() })
        .parse(JSON.parse(await detailText(request)));

      expect(Buffer.byteLength(JSON.stringify(body.arguments), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(Object.keys(body.arguments).length).toBeLessThan(13);
      expect(body.arguments.to).toBe(RECIPIENT);
      expect(body.argumentsTruncated).toBe(true);
    });

    it("has neither field for a request of a generic operation", async () => {
      const session = await authSession();
      const created = await createGenericRequest(session, "generic-input-marker");

      const text = await readText(session.headers, `/api/approval-requests/${created.id}`);
      const body: unknown = JSON.parse(text);
      expect(body).toMatchObject({ id: created.id, safeSummary: { kind: "genericOperation", argKeys: ["itemId"] } });
      expect(body).not.toHaveProperty("arguments");
      expect(body).not.toHaveProperty("argumentsTruncated");
      expect(text).not.toContain("generic-input-marker");
    });

    it("has neither field for a request of a module tool, pending or decided (issue #1791)", async () => {
      const session = await authSession();
      const created = await createRequest(session.userId, {
        request: {
          toolName: "mail_send_draft",
          payload: {
            moduleToolName: "mail_send_draft",
            args: { to: RECIPIENT, apiKey: API_KEY, body: "module-tool-body-marker" },
          },
          resourceSnapshot: { kind: "module_tool", resourceId: "mail_send_draft", sha256: null },
        },
      });

      const readView = async (status: string): Promise<void> => {
        const text = await readText(session.headers, `/api/approval-requests/${created.id}`);
        for (const value of [RECIPIENT, API_KEY, "module-tool-body-marker"]) expect(text).not.toContain(value);
        const body: unknown = JSON.parse(text);
        expect(body).toMatchObject({
          id: created.id,
          status,
          safeSummary: { kind: "moduleTool", toolName: "mail_send_draft" },
        });
        expect(body).not.toHaveProperty("arguments");
        expect(body).not.toHaveProperty("argumentsTruncated");
      };

      await readView("pending");
      await decided(session.headers, created.id, "rejected");
      await readView("rejected");
    });

    it("answers a request of another account and an unknown id with one 404 that holds no value", async () => {
      const request = await createMcpRequest(emailArgs());
      const other = await authSession();

      const unknown = await get(other.headers, `/api/approval-requests/${randomUUID()}`);
      expect(unknown.status).toBe(404);
      const foreign = await get(other.headers, `/api/approval-requests/${request.id}`);
      expect(foreign.status).toBe(404);
      const foreignBody = await foreign.text();
      expect(foreignBody).toBe(await unknown.text());
      expect(foreignBody).not.toContain(RECIPIENT);
      // The owner gets the values, so the 404 is a refusal and not a missing request.
      expect(await detailText(request)).toContain(RECIPIENT);
    });

    it("keeps every value out of the list, the count, the PATCH answer and the notification body", async () => {
      const request = await createMcpRequest(emailArgs());
      const headers = request.session.headers;
      const values = [RECIPIENT, SUBJECT, "the invoice is attached", API_KEY, BEARER, PASSWORD_VALUE];
      const expectNoValue = (text: string, what: string) => {
        for (const value of values) expect(text, what).not.toContain(value);
      };

      expect(await detailText(request)).toContain(RECIPIENT);
      for (const path of [
        "/api/approval-requests",
        "/api/approval-requests?status=pending",
        "/api/approval-requests?status=pending&source=chat",
        "/api/approval-requests/count",
      ])
        expectNoValue(await readText(headers, path), path);
      expect(await readText(headers, "/api/approval-requests?status=pending")).toContain(request.id);

      for (const what of ["PATCH", "repeated PATCH"]) {
        const decision = await decide(headers, request.id, "approved");
        expect(decision.status).toBe(200);
        const decisionText = await decision.text();
        expectNoValue(decisionText, what);
        expect(JSON.parse(decisionText)).not.toHaveProperty("arguments");
        expect(JSON.parse(decisionText)).not.toHaveProperty("argumentsTruncated");
      }

      const decidedList = await readText(headers, "/api/approval-requests?status=decided");
      expect(decidedList).toContain(request.id);
      expectNoValue(decidedList, "decided list");

      const { rows } = await pool.query<{ title: string; body: string | null }>(
        "SELECT title, body FROM notifications WHERE source_table = 'approval_requests' AND source_id = $1",
        [request.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toEqual(expect.stringContaining("send_email"));
      expectNoValue(`${rows[0]?.title} ${rows[0]?.body}`, "notification");
    });
  });
});

describe("approval requests under the runtime role (issues #1766 and #1785)", () => {
  let admin: Pool;
  let runtime: Pool;
  let server: Server;
  let baseUrl: string;
  const { get, decided, read, ids } = api(() => baseUrl);

  interface TenantSession extends Session {
    tenant: string;
  }

  async function tenantSession(locale: string): Promise<TenantSession> {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    const user = await createUser(admin, {
      tenantId: tenant,
      email,
      passwordHash: await hashPassword(PASSWORD),
      locale,
    });
    const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    await runInTenant(tenant, () => seedSystem(runtime));
    return { tenant, userId: user.id, headers: { Authorization: `Bearer ${session.token}` } };
  }

  async function itemThreadRequest(
    session: TenantSession,
    text: string,
  ): Promise<{ threadId: string; requestId: string }> {
    return runInTenant(session.tenant, async () => {
      const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox) throw new Error("Missing seeded Inbox database");
      const item = await createChokePoint(runtime).createItem({
        databaseId: inbox.id,
        properties: { date: "2026-01-01", time: "12:00", text },
      });
      const turn = await withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: item.id },
          text: "Make it a task",
          context: [],
          hasContext: false,
        }),
      );
      const request = await createRequest(session.userId, { run: { threadId: turn.threadId }, db: runtime });
      return { threadId: turn.threadId, requestId: request.id };
    });
  }

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    server = createServer(createApprovalRequestsRequestListener(runtime));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await runtime?.end();
    await admin?.end();
  });

  it("derives each tenant's sources in that user's locale, in the list, the one-request read and the decision, and shows neither tenant the other's request", async () => {
    const english = await tenantSession("en");
    const czech = await tenantSession("cs");
    const ofEnglish = await itemThreadRequest(english, "Buy milk");
    const ofCzech = await itemThreadRequest(czech, "Zavolat domů");

    for (const [session, own, title, foreign, foreignText] of [
      [english, ofEnglish, "Edit: Buy milk", ofCzech, "Zavolat"],
      [czech, ofCzech, "Úprava: Zavolat domů", ofEnglish, "Buy milk"],
    ] as const) {
      const body = await read(session.headers, "/api/approval-requests");
      expect(body).toEqual({
        rows: [expect.objectContaining({ id: own.requestId, source: chatSource(own.threadId, title) })],
      });
      expect(JSON.stringify(body)).not.toContain(foreign.threadId);
      expect(JSON.stringify(body)).not.toContain(foreignText);
      expect(await read(session.headers, `/api/approval-requests/${own.requestId}`)).toMatchObject({
        id: own.requestId,
        source: chatSource(own.threadId, title),
      });
    }

    const unknown = await get(english.headers, `/api/approval-requests/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    const foreign = await get(english.headers, `/api/approval-requests/${ofCzech.requestId}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    expect([...foreign.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());

    expect(await decided(czech.headers, ofCzech.requestId, "rejected")).toMatchObject({
      id: ofCzech.requestId,
      status: "rejected",
      source: chatSource(ofCzech.threadId, "Úprava: Zavolat domů"),
    });
  });

  it("counts only the caller's tenant's requests (issue #1786)", async () => {
    const first = await tenantSession("en");
    const second = await tenantSession("en");
    await itemThreadRequest(first, "One");
    await itemThreadRequest(second, "Two");
    await itemThreadRequest(second, "Three");
    const count = (session: Session, query: string) => read(session.headers, `/api/approval-requests/count${query}`);

    expect(await count(first, "")).toEqual({ count: 1 });
    expect(await count(second, "")).toEqual({ count: 2 });
    expect(await count(second, "?status=pending&source=chat")).toEqual({ count: 2 });
    expect(await count(second, "?source=mcp,tick")).toEqual({ count: 0 });
  });

  it("never returns another tenant's request from the paged list, whatever the status, source or search (issue #1785)", async () => {
    const seed = async (session: TenantSession): Promise<{ pending: string; decided: string }> => {
      const created = await runInTenant(session.tenant, async () => {
        const threadId = await chatThread(runtime);
        // Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway.
        await runtime.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, "Společný název"]);
        const run = await createAgentRun(runtime, {
          triggeredBy: "user",
          task: "test",
          userId: session.userId,
          threadId,
        });
        const create = () =>
          createPendingApprovalRequest(runtime, {
            agentRunId: run.id,
            toolName: "property.delete",
            riskClass: "destructive",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: RESOURCE_SNAPSHOT,
            description: { key: "approval.propertyDelete", params: { propertyName: "Nálada" } },
          });
        return { pending: (await create()).id, decided: (await create()).id };
      });
      await decided(session.headers, created.decided, "approved");
      return created;
    };
    const first = await tenantSession("en");
    const second = await tenantSession("cs");
    const ofFirst = await seed(first);
    const ofSecond = await seed(second);

    for (const [session, own] of [
      [first, ofFirst],
      [second, ofSecond],
    ] as const) {
      for (const [query, expected] of [
        ["?status=pending", own.pending],
        ["?status=decided", own.decided],
        ["?source=chat", own.pending],
        ["?source=chat&status=decided", own.decided],
        ["?q=spolecny", own.pending],
        ["?q=nalada&status=decided", own.decided],
        ["?q=property.delete&limit=100&order=asc", own.pending],
      ] as const)
        expect(await ids(session.headers, query), query).toEqual([expected]);
    }
  });

  it("titles an item thread of the paged list in the caller's locale and finds it by the item's text (issue #1785)", async () => {
    const czech = await tenantSession("cs");
    const { threadId, requestId } = await itemThreadRequest(czech, "Zavolat domů");

    for (const query of ["?status=pending", "?q=zavolat%20domu"])
      expect(await read(czech.headers, `/api/approval-requests${query}`), query).toEqual({
        rows: [
          expect.objectContaining({
            id: requestId,
            source: expect.objectContaining({ kind: "chat", threadId, threadTitle: "Úprava: Zavolat domů" }),
          }),
        ],
        nextCursor: null,
      });
  });
});
