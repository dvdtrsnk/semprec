import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
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
  type ChokePoint,
} from "@semprec/data";
import { createApprovalRequestsRequestListener } from "../approvalRequestsHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;

async function createTestUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

/** Tenant zero's user, which `beforeEach` creates; the first `authSession` of a test signs it in. */
let tenantUserEmail: string;
let tenantUserSignedIn: boolean;

/**
 * Signs in tenant zero's user on the first call of a test, and after it the user of a fresh tenant of
 * its own. A run's actor must be its own tenant's user (`agent_runs_actor_user_id_tenant_fkey`, issue
 * #1066) and a tenant has one user, so only the first session can own a request; a later one is the
 * non-owner, in another tenant as every other account is.
 */
async function authSession(): Promise<{ headers: { Authorization: string }; userId: string }> {
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

async function authHeader(): Promise<{ Authorization: string }> {
  return (await authSession()).headers;
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

async function createPendingRequest(ownerUserId: string): Promise<string> {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerUserId });
  const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } };
  const created = await createPendingApprovalRequest(pool, {
    agentRunId: run.id,
    toolName: "search_web",
    riskClass: "unclassified",
    payload,
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  });
  return created.id;
}

describe("createApprovalRequestsRequestListener", () => {
  let server: Server;
  let baseUrl: string;
  let chokePoint: ChokePoint;

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

  it("rejects a request with no credentials", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("rejects a request with a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: await authHeader() });
    expect(res.status).toBe(404);
  });

  it("approves a pending request", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: "approved", decidedBy: session.userId });
    expect(await countExecuteJobs(id)).toBe(1);
  });

  it("rejects a pending request", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", decidedByUserId: session.userId }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: "rejected" });
  });

  it("returns 400 for an invalid decision value", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "maybe", decidedByUserId: session.userId }),
    });
    expect(res.status).toBe(400);
  });

  it("records the session user as the decider when the body carries only the decision", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ decidedBy: session.userId });
    const { rows } = await pool.query<{ decided_by: string }>(
      `SELECT decided_by FROM approval_requests WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.decided_by).toBe(session.userId);
  });

  it("ignores a body decidedByUserId and records the session user as the decider", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);
    const claimedDecider = randomUUID();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: claimedDecider }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ decidedBy: session.userId });
    expect(body).not.toMatchObject({ decidedBy: claimedDecider });
  });

  it("returns the decision without the payload's argument values", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).not.toHaveProperty("payload");
    expect(JSON.stringify(body)).not.toContain('"hi"');
    // The fixture's server item and registration do not exist: still 200, with null names.
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
      createItemWithClient(client, {
        databaseId,
        properties: { name: "Search server", active: true },
      }),
    );
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: serverItem.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
    const request = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "write",
      payload: {
        mcpToolRegistrationId: registration.id,
        mcpServerItemId: serverItem.id,
        args: { query: "private-argument" },
      },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const list = async (): Promise<unknown> => {
      const response = await fetch(`${baseUrl}/api/approval-requests`, { headers: session.headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await list();
    expect(before).toMatchObject({
      rows: [
        expect.objectContaining({
          id: request.id,
          safeSummary: expect.objectContaining({
            mcpServerName: "Search server",
            mcpToolName: "search_web",
            argKeys: ["query"],
          }),
        }),
      ],
    });
    expect(JSON.stringify(before)).not.toContain("private-argument");
    expect(await chokePoint.softDeleteItem(databaseId, serverItem.id, session.userId)).not.toBeNull();
    const after = await list();
    expect(after).toMatchObject({
      rows: [
        expect.objectContaining({
          id: request.id,
          safeSummary: expect.objectContaining({ mcpServerName: null, mcpToolName: "search_web", argKeys: ["query"] }),
        }),
      ],
    });
    const decision = await fetch(`${baseUrl}/api/approval-requests/${request.id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(decision.status).toBe(200);
    const result: unknown = await decision.json();
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
    let id: string;
    if (generic) {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
      const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "destructive",
        payload: {
          operationName: "item.delete",
          canonicalInput: { itemId: "private-marker" },
          actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: session.userId },
          resourceSnapshot,
        },
        resourceSnapshot,
      });
      id = request.id;
    } else {
      id = await createPendingRequest(session.userId);
    }
    const decide = () =>
      fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
    expect((await decide()).status).toBe(200);
    // Recreate persisted historical execution outcomes for the response boundary.
    await pool.query(
      "UPDATE approval_requests SET execution_status = 'conflict', execution_result_jsonb = $2::jsonb WHERE id = $1",
      [id, JSON.stringify(executionResult)],
    );
    const response = await decide();
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ executionStatus: "conflict", conflictReason: { key } });
    expect(body).not.toHaveProperty("executionResult");
    expect(JSON.stringify(body)).not.toContain("private-marker");
    expect(JSON.stringify(body)).not.toContain('"hi"');
  });

  it("treats a repeated decision by the owner as a deterministic no-op, returning the current state with 200", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const first = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(first.status).toBe(200);
    expect(await countExecuteJobs(id)).toBe(1);

    const second = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(second.status).toBe(200);
    const body: unknown = await second.json();
    expect(body).toMatchObject({ status: "approved", decidedBy: session.userId });
    expect(await countExecuteJobs(id)).toBe(1);
  });

  it("answers a non-owner's PATCH with the same 404 as a random id, before and after the owner decides (issue #1028)", async () => {
    const owner = await authSession();
    const id = await createPendingRequest(owner.userId);
    const other = await authSession();
    const patch = (requestId: string, headers: { Authorization: string }, decision: string) =>
      fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });

    const unknown = await patch(randomUUID(), other.headers, "approved");
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    const foreignBeforeDecision = await patch(id, other.headers, "approved");
    expect(foreignBeforeDecision.status).toBe(404);
    expect(await foreignBeforeDecision.text()).toBe(unknownBody);

    const { rows: pendingRows } = await pool.query<{ status: string; decided_by: string | null }>(
      `SELECT status, decided_by FROM approval_requests WHERE id = $1`,
      [id],
    );
    expect(pendingRows[0]).toEqual({ status: "pending", decided_by: null });
    expect(await countExecuteJobs(id)).toBe(0);

    await patch(id, owner.headers, "approved");
    expect(await countExecuteJobs(id)).toBe(1);
    const foreignAfterDecision = await patch(id, other.headers, "approved");
    expect(foreignAfterDecision.status).toBe(404);
    expect(await foreignAfterDecision.text()).toBe(unknownBody);
    expect(await countExecuteJobs(id)).toBe(1);

    const { rows: decidedRows } = await pool.query<{ status: string; decided_by: string | null }>(
      `SELECT status, decided_by FROM approval_requests WHERE id = $1`,
      [id],
    );
    expect(decidedRows[0]).toEqual({ status: "approved", decided_by: owner.userId });
  });

  it("returns 404 for an unknown approval request id", async () => {
    const userId = await createTestUser();

    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: userId }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 validation_failed naming 'id' for a non-UUID approval request id", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/foo`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ code: "validation_failed", details: { field: "id" } });
  });

  it("rejects a PATCH with a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PATCH whose body exceeds the maximum allowed size", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  describe("GET /api/approval-requests (issue #132)", () => {
    it("rejects a request with no credentials", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests`);
      expect(res.status).toBe(401);
    });

    it("returns an empty queue when there are no pending requests", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests`, {
        headers: await authHeader(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rows: [] });
    });

    it("lists a pending request with its source project name and agent-run link", async () => {
      const session = await authSession();
      const projects = await chokePoint.createDatabase({ name: "Projects" });
      await chokePoint.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "title" });
      const projectItem = await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Kitchen" } });
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "test",
        projectItemId: projectItem.id,
        userId: session.userId,
      });
      const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } };
      await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "write",
        payload,
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });

      const res = await fetch(`${baseUrl}/api/approval-requests`, {
        headers: session.headers,
      });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        rows: [
          {
            toolName: "send_email",
            riskClass: "write",
            agentRunId: run.id,
            projectItemId: projectItem.id,
            projectName: "Kitchen",
            safeSummary: {
              mcpToolRegistrationId: payload.mcpToolRegistrationId,
              mcpServerItemId: payload.mcpServerItemId,
              mcpServerName: null,
              mcpToolName: null,
              argKeys: ["to"],
            },
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("a@b.com");
    });

    it("keeps every earlier field of a row unchanged and adds the source (issue #1766)", async () => {
      const session = await authSession();
      const projects = await chokePoint.createDatabase({ name: "Projects" });
      await chokePoint.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "title" });
      const projectItem = await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Kitchen" } });
      const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
      // Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway.
      await pool.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, "Kitchen plans"]);
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "test",
        projectItemId: projectItem.id,
        userId: session.userId,
        threadId,
      });
      const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } };
      const description = { key: "approval.mcpInvoke", params: { toolName: "send_email" } };
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload,
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        reason: "The customer asked for a quote",
        description,
      });

      const res = await fetch(`${baseUrl}/api/approval-requests`, { headers: session.headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
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
            agentRunId: run.id,
            projectItemId: projectItem.id,
            projectName: "Kitchen",
            reason: "The customer asked for a quote",
            description,
            source: {
              kind: "chat",
              threadId,
              threadTitle: "Kitchen plans",
              heartbeatId: null,
              heartbeatName: null,
              mcpClientName: null,
            },
          },
        ],
      });
    });

    it("returns the source on the decision of a request (issue #1766)", async () => {
      const session = await authSession();
      const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId, threadId });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        status: "rejected",
        source: {
          kind: "chat",
          threadId,
          threadTitle: null,
          heartbeatId: null,
          heartbeatName: null,
          mcpClientName: null,
        },
      });
    });

    it("does not list a decided request", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);
      await fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      const res = await fetch(`${baseUrl}/api/approval-requests`, {
        headers: session.headers,
      });
      expect(await res.json()).toEqual({ rows: [] });
    });

    it("lists only the caller's own pending requests (issue #1028)", async () => {
      const owner = await authSession();
      const ownId = await createPendingRequest(owner.userId);
      // The other account's request lives in its own tenant, the only place its run can be recorded.
      const otherTenant = await createTestTenant(pool);
      const other = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: otherTenant,
      });
      await withTenantTransaction(pool, otherTenant, async (client) => {
        const run = await createAgentRun(client, { triggeredBy: "user", task: "test", userId: other.id });
        await createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      });

      const res = await fetch(`${baseUrl}/api/approval-requests`, { headers: owner.headers });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ rows: [{ id: ownId }] });
    });
  });

  describe("GET /api/approval-requests with list parameters (issue #1785)", () => {
    const pageSchema = z.strictObject({
      rows: z.array(z.looseObject({ id: z.uuid() })),
      nextCursor: z.string().nullable(),
    });

    /** The fields of a row of the pending list, in sort order: those the unpaged queue returns. */
    const PENDING_ROW_KEYS = [
      "agentRunId",
      "description",
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

    async function getList(session: { headers: { Authorization: string } }, query: string): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests${query}`, { headers: session.headers });
    }

    async function listPage(session: { headers: { Authorization: string } }, query: string) {
      const res = await getList(session, query);
      expect(res.status, `GET /api/approval-requests${query}`).toBe(200);
      return pageSchema.parse(await res.json());
    }

    async function decide(session: { headers: { Authorization: string } }, id: string, decision: string) {
      const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      expect(res.status).toBe(200);
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

      const res = await getList(session, query);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ rows: [{ id }], nextCursor: null });
      expect(Object.keys(pageSchema.parse(body)).sort()).toEqual(["nextCursor", "rows"]);
      expect(Object.keys(pageSchema.parse(body).rows[0] ?? {}).sort()).toEqual(PENDING_ROW_KEYS);
    });

    it("keeps the answer without parameters at pending requests, oldest first, in rows only", async () => {
      const session = await authSession();
      const first = await createPendingRequest(session.userId);
      const second = await createPendingRequest(session.userId);
      const decided = await createPendingRequest(session.userId);
      await decide(session, decided, "approved");

      const res = await getList(session, "");
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ rows: [{ id: first }, { id: second }] });
      expect(body).toHaveProperty("rows.length", 2);
      expect(body).not.toHaveProperty("nextCursor");
    });

    it("pages pending requests newest first, 50 to a page unless limit says otherwise", async () => {
      const session = await authSession();
      const ids: string[] = [];
      for (let index = 0; index < 51; index += 1) ids.push(await createPendingRequest(session.userId));
      const newestFirst = [...ids].reverse();

      const firstPage = await listPage(session, "?status=pending");
      expect(firstPage.rows.map((row) => row.id)).toEqual(newestFirst.slice(0, 50));
      expect(firstPage.nextCursor).not.toBeNull();
      const lastPage = await listPage(session, `?status=pending&cursor=${firstPage.nextCursor}`);
      expect(lastPage).toMatchObject({ rows: [{ id: ids[0] }], nextCursor: null });
      expect(lastPage.rows).toHaveLength(1);

      const whole = await listPage(session, "?limit=100");
      expect(whole.rows.map((row) => row.id)).toEqual(newestFirst);
      expect(whole.nextCursor).toBeNull();
      const single = await listPage(session, "?limit=1&order=asc");
      expect(single.rows.map((row) => row.id)).toEqual([ids[0]]);
      expect(single.nextCursor).not.toBeNull();
    });

    it("lists decided requests newest decision first with their status, decision time and execution status", async () => {
      const session = await authSession();
      const approved = await createPendingRequest(session.userId);
      const rejected = await createPendingRequest(session.userId);
      const pending = await createPendingRequest(session.userId);
      // The later request is decided first, so the order of the decisions is not the order of the requests.
      await decide(session, rejected, "rejected");
      await decide(session, approved, "approved");

      const res = await getList(session, "?status=decided");
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        rows: [
          { id: approved, status: "approved", executionStatus: "queued", conflictReason: null },
          { id: rejected, status: "rejected", executionStatus: "not_approved", conflictReason: null },
        ],
        nextCursor: null,
      });
      const rows = pageSchema.parse(body).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          [...PENDING_ROW_KEYS, "conflictReason", "decidedAt", "executionStatus", "status"].sort(),
        );
        expect(z.iso.datetime().safeParse(row.decidedAt).success).toBe(true);
      }
      expect(JSON.stringify(body)).not.toContain(pending);
      expect((await listPage(session, "?status=decided&order=asc")).rows.map((row) => row.id)).toEqual([
        rejected,
        approved,
      ]);
    });

    it("filters by source and finds a request by a word of its description, without diacritics", async () => {
      const session = await authSession();
      const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
      const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };
      const payload = () => ({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} });
      const chatRun = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "chat",
        userId: session.userId,
        threadId,
      });
      const delegated = await createAgentRun(pool, {
        triggeredBy: "supervisor",
        task: "delegated",
        parentRunId: chatRun.id,
      });
      const mcpRun = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp", userId: session.userId });
      const fromChat = await createPendingApprovalRequest(pool, {
        agentRunId: delegated.id,
        toolName: "property.delete",
        riskClass: "destructive",
        payload: payload(),
        resourceSnapshot,
        description: {
          key: "approval.propertyDelete",
          params: { propertyName: "Nálada", databaseKey: "journal", databaseName: "Deník", affectedCount: 3 },
        },
      });
      const fromMcp = await createPendingApprovalRequest(pool, {
        agentRunId: mcpRun.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: payload(),
        resourceSnapshot,
      });
      const ids = async (query: string) => (await listPage(session, query)).rows.map((row) => row.id);

      expect(await ids("?source=chat")).toEqual([fromChat.id]);
      expect(await ids("?source=mcp")).toEqual([fromMcp.id]);
      expect(await ids("?source=tick")).toEqual([]);
      expect(await ids("?source=mcp,chat,mcp")).toEqual([fromMcp.id, fromChat.id]);
      expect(await ids("?q=nalada")).toEqual([fromChat.id]);
      expect(await ids("?q=%20NALADA%20")).toEqual([fromChat.id]);
      expect(await ids("?q=nalada&source=mcp")).toEqual([]);
      // A blank `q` is no filter, and still selects the paged answer.
      expect(await ids("?q=")).toEqual([fromMcp.id, fromChat.id]);
      expect(await ids(`?q=${"a".repeat(100)}`)).toEqual([]);
    });

    it.each([
      ["limit", "?limit=0"],
      ["limit", "?limit=101"],
      ["limit", "?limit=abc"],
      ["limit", "?limit=1.5"],
      ["limit", "?limit=-1"],
      ["limit", "?limit="],
      ["limit", "?limit=1&limit=2"],
      ["status", "?status=done"],
      ["status", "?status="],
      ["status", "?status=PENDING"],
      ["status", "?status=pending&status=decided"],
      ["order", "?order=newest"],
      ["order", "?order="],
      ["order", "?order=asc&order=desc"],
      ["source", "?source=inbox"],
      ["source", "?source=chat,"],
      ["source", "?source=CHAT"],
      ["source", "?source=chat&source=mcp"],
      ["cursor", "?cursor=abc"],
      ["cursor", "?cursor="],
      ["cursor", "?cursor=a&cursor=b"],
      ["q", `?q=${"a".repeat(101)}`],
      ["q", "?q=a%00b"],
      ["q", "?q=a&q=b"],
    ])("answers 400 naming %s for %s", async (field, query) => {
      const session = await authSession();
      await createPendingRequest(session.userId);

      const res = await getList(session, query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field } });
    });

    it("rejects a list request with no credentials whatever its parameters", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests?status=decided`);
      expect(res.status).toBe(401);
    });
  });
});

describe("approval requests under the runtime role (issues #1766 and #1785)", () => {
  let admin: Pool;
  let runtime: Pool;
  let server: Server;
  let baseUrl: string;

  interface Session {
    tenant: string;
    userId: string;
    headers: { Authorization: string };
  }

  /** A seeded tenant with its user, whose `users.locale` is `locale`, and that user's bearer session. */
  async function tenantSession(locale: string): Promise<Session> {
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

  /** A pending request of a run in the item thread of a new Inbox item with `text`. */
  async function itemThreadRequest(session: Session, text: string): Promise<{ threadId: string; requestId: string }> {
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
      const run = await createAgentRun(runtime, {
        triggeredBy: "user",
        task: "test",
        userId: session.userId,
        threadId: turn.threadId,
      });
      const request = await createPendingApprovalRequest(runtime, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
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

  it("derives each tenant's sources in that user's locale and shows neither tenant the other's request", async () => {
    const english = await tenantSession("en");
    const czech = await tenantSession("cs");
    const ofEnglish = await itemThreadRequest(english, "Buy milk");
    const ofCzech = await itemThreadRequest(czech, "Zavolat domů");

    const list = async (session: Session): Promise<unknown> => {
      const res = await fetch(`${baseUrl}/api/approval-requests`, { headers: session.headers });
      expect(res.status).toBe(200);
      return res.json();
    };
    const source = (threadId: string, threadTitle: string) => ({
      kind: "chat",
      threadId,
      threadTitle,
      heartbeatId: null,
      heartbeatName: null,
      mcpClientName: null,
    });

    const englishBody = await list(english);
    expect(englishBody).toMatchObject({
      rows: [{ id: ofEnglish.requestId, source: source(ofEnglish.threadId, "Edit: Buy milk") }],
    });
    expect(englishBody).toHaveProperty("rows.length", 1);
    expect(JSON.stringify(englishBody)).not.toContain(ofCzech.threadId);
    expect(JSON.stringify(englishBody)).not.toContain("Zavolat");

    const czechBody = await list(czech);
    expect(czechBody).toMatchObject({
      rows: [{ id: ofCzech.requestId, source: source(ofCzech.threadId, "Úprava: Zavolat domů") }],
    });
    expect(czechBody).toHaveProperty("rows.length", 1);
    expect(JSON.stringify(czechBody)).not.toContain(ofEnglish.threadId);
    expect(JSON.stringify(czechBody)).not.toContain("Buy milk");
  });

  it("writes the source of a decided request in the deciding user's locale", async () => {
    const czech = await tenantSession("cs");
    const { threadId, requestId } = await itemThreadRequest(czech, "Zavolat domů");

    const res = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
      method: "PATCH",
      headers: { ...czech.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      id: requestId,
      status: "rejected",
      source: {
        kind: "chat",
        threadId,
        threadTitle: "Úprava: Zavolat domů",
        heartbeatId: null,
        heartbeatName: null,
        mcpClientName: null,
      },
    });
  });

  it("never returns another tenant's request from the paged list, whatever the status, source or search (issue #1785)", async () => {
    /** One pending and one decided request of a run in a chat thread titled "Společný název". */
    const seed = async (session: Session): Promise<{ pending: string; decided: string }> => {
      const ids = await runInTenant(session.tenant, async () => {
        const threadId = await withTransaction(runtime, (client) => createSempChatThread(client));
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
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
            description: { key: "approval.propertyDelete", params: { propertyName: "Nálada" } },
          });
        return { pending: (await create()).id, decided: (await create()).id };
      });
      const decision = await fetch(`${baseUrl}/api/approval-requests/${ids.decided}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      expect(decision.status).toBe(200);
      return ids;
    };
    const first = await tenantSession("en");
    const second = await tenantSession("cs");
    const ofFirst = await seed(first);
    const ofSecond = await seed(second);

    const ids = async (session: Session, query: string): Promise<string[]> => {
      const res = await fetch(`${baseUrl}/api/approval-requests${query}`, { headers: session.headers });
      expect(res.status, query).toBe(200);
      const body = z.object({ rows: z.array(z.object({ id: z.uuid() })) }).parse(await res.json());
      return body.rows.map((row) => row.id);
    };

    for (const [session, own] of [
      [first, ofFirst],
      [second, ofSecond],
    ] as const) {
      expect(await ids(session, "?status=pending")).toEqual([own.pending]);
      expect(await ids(session, "?status=decided")).toEqual([own.decided]);
      expect(await ids(session, "?source=chat")).toEqual([own.pending]);
      expect(await ids(session, "?source=chat&status=decided")).toEqual([own.decided]);
      expect(await ids(session, "?q=spolecny")).toEqual([own.pending]);
      expect(await ids(session, "?q=nalada&status=decided")).toEqual([own.decided]);
      expect(await ids(session, "?q=property.delete&limit=100&order=asc")).toEqual([own.pending]);
    }
  });

  it("titles an item thread of the paged list in the caller's locale and finds it by the item's text (issue #1785)", async () => {
    const czech = await tenantSession("cs");
    const { threadId, requestId } = await itemThreadRequest(czech, "Zavolat domů");

    for (const query of ["?status=pending", "?q=zavolat%20domu"]) {
      const res = await fetch(`${baseUrl}/api/approval-requests${query}`, { headers: czech.headers });
      expect(res.status, query).toBe(200);
      const body: unknown = await res.json();
      expect(body, query).toMatchObject({
        rows: [{ id: requestId, source: { kind: "chat", threadId, threadTitle: "Úprava: Zavolat domů" } }],
        nextCursor: null,
      });
      expect(body, query).toHaveProperty("rows.length", 1);
    }
  });
});
