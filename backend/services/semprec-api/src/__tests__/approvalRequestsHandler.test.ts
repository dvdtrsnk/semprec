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
  approvalNotificationBody,
  approvalNotificationLinkHref,
  buildMcpInvokeApprovalDescription,
  writeNotification,
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

  it("leaves an already rejected request rejected when it is approved afterwards, returning that status and queuing no execution (issue #1831)", async () => {
    const session = await authSession();
    const id = await createPendingRequest(session.userId);

    const first = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(second.status).toBe(200);
    const body: unknown = await second.json();
    expect(body).toMatchObject({ id, status: "rejected", decidedBy: session.userId });
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM approval_requests WHERE id = $1", [id]);
    expect(rows).toEqual([{ status: "rejected" }]);
    expect(await countExecuteJobs(id)).toBe(0);
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
            breaksLinks: [],
            endsInheritance: [],
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

  describe("outcome of the decision (issue #2022)", () => {
    function patch(session: { headers: { Authorization: string } }, id: string, decision: string): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    }

    it.each([
      ["approved", 1],
      ["rejected", 0],
    ])("answers outcome decided for the call that %s a pending request", async (decision, jobs) => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      const res = await patch(session, id, decision);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, status: decision, outcome: "decided" });
      expect(await countExecuteJobs(id)).toBe(jobs);
    });

    it.each([
      ["approved", "approved", 1],
      ["approved", "rejected", 1],
      ["rejected", "rejected", 0],
      ["rejected", "approved", 0],
    ])(
      "answers 200 with the current state and outcome unchanged for %s decided again as %s, and queues no second job",
      async (first, second, jobs) => {
        const session = await authSession();
        const id = await createPendingRequest(session.userId);
        const firstBody = z.looseObject({}).parse(await (await patch(session, id, first)).json());
        expect(firstBody).toMatchObject({ status: first, outcome: "decided" });

        const res = await patch(session, id, second);
        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toEqual({ ...firstBody, outcome: "unchanged" });
        expect(body).toMatchObject({ status: first, decidedBy: session.userId });
        expect(await countExecuteJobs(id)).toBe(jobs);
      },
    );

    it("answers outcome decided to one of two concurrent decisions and unchanged to the other", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      const answers = await Promise.all([patch(session, id, "approved"), patch(session, id, "approved")]);
      const outcomes = await Promise.all(
        answers.map(async (res) => {
          expect(res.status).toBe(200);
          return z.looseObject({ outcome: z.enum(["decided", "unchanged"]) }).parse(await res.json()).outcome;
        }),
      );

      expect([...outcomes].sort()).toEqual(["decided", "unchanged"]);
      expect(await countExecuteJobs(id)).toBe(1);
    });

    it("answers the 404 without an outcome for an unknown id and for another account's request", async () => {
      const owner = await authSession();
      const id = await createPendingRequest(owner.userId);
      const other = await authSession();

      for (const requestId of [randomUUID(), id]) {
        const res = await patch(other, requestId, "approved");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
      expect(await countExecuteJobs(id)).toBe(0);
    });

    it("does not carry the outcome on the reads of requests, decided ones included", async () => {
      const session = await authSession();
      const decidedId = await createPendingRequest(session.userId);
      const pendingId = await createPendingRequest(session.userId);
      await patch(session, decidedId, "approved");
      await patch(session, decidedId, "approved");

      const read = async (path: string): Promise<string> => {
        const res = await fetch(`${baseUrl}${path}`, { headers: session.headers });
        expect(res.status, path).toBe(200);
        return res.text();
      };
      for (const path of [
        `/api/approval-requests/${decidedId}`,
        `/api/approval-requests/${pendingId}`,
        "/api/approval-requests",
        "/api/approval-requests?status=pending",
        "/api/approval-requests?status=decided",
      ]) {
        const text = await read(path);
        expect(text, path).not.toContain("outcome");
      }
      // The decided list holds the request, so its answer above is not empty by accident.
      expect(await read("/api/approval-requests?status=decided")).toContain(decidedId);
    });
  });

  describe("GET /api/approval-requests/:id (issue #1786)", () => {
    function getOne(headers: { Authorization: string } | undefined, id: string): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests/${id}`, headers ? { headers } : {});
    }

    async function decide(session: { headers: { Authorization: string } }, id: string, decision: string) {
      const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      expect(res.status).toBe(200);
      return res;
    }

    it("rejects a request with no credentials", async () => {
      expect((await getOne(undefined, randomUUID())).status).toBe(401);
    });

    it("returns the view of a pending request with its source and risk class, and no payload", async () => {
      const session = await authSession();
      const threadId = await withTransaction(pool, (client) => createSempChatThread(client));
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId, threadId });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });

      const res = await getOne(session.headers, created.id);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        id: created.id,
        status: "pending",
        decidedAt: null,
        decidedBy: null,
        executionStatus: "not_approved",
        toolName: "send_email",
        riskClass: "outbound",
        agentRunId: run.id,
        safeSummary: { kind: "mcpInvoke", argKeys: ["to"] },
        source: { kind: "chat", threadId, heartbeatId: null, heartbeatName: null, mcpClientName: null },
      });
      expect(body).not.toHaveProperty("payload");
      // The values of an MCP request are those of `arguments`, redacted and bounded (issue #2021), and only there.
      expect(body).toMatchObject({ arguments: { to: "a@b.com" }, argumentsTruncated: false });
      expect(JSON.stringify(body).split("a@b.com")).toHaveLength(2);
    });

    it("carries the value links a request would end, as the list does (issue #1758)", async () => {
      const session = await authSession();
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
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
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "relation.set",
        riskClass: "breaksLink",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        description: { key: "approval.breaksLink", params: {}, breaksLinks, endsInheritance },
      });

      const one = await getOne(session.headers, created.id);
      const list = await fetch(`${baseUrl}/api/approval-requests`, { headers: session.headers });

      expect(one.status).toBe(200);
      expect(await one.json()).toMatchObject({
        riskClass: "breaksLink",
        riskLevel: "breaksLink",
        breaksLinks,
        endsInheritance,
      });
      expect(await list.json()).toMatchObject({ rows: [{ id: created.id, breaksLinks, endsInheritance }] });
    });

    it("carries empty link lists for a request that ends no link (issue #1758)", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);

      const body: unknown = await (await getOne(session.headers, id)).json();

      expect(body).toMatchObject({ breaksLinks: [], endsInheritance: [] });
    });

    it("returns a decided request with the view the PATCH answered", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);
      const { outcome, ...decision } = z
        .looseObject({ outcome: z.string() })
        .parse(await (await decide(session, id, "approved")).json());

      const res = await getOne(session.headers, id);
      expect(res.status).toBe(200);
      // The PATCH answer is the view and the outcome of that call, which a read does not carry (issue #2022).
      // The read adds the argument values of an MCP request, which the PATCH answer does not (issue #2021).
      expect(outcome).toBe("decided");
      expect(await res.json()).toEqual({ ...decision, arguments: { query: "hi" }, argumentsTruncated: false });
      expect(decision).toMatchObject({ status: "approved", executionStatus: "queued" });
    });

    it("answers a request of another account, an unknown id and a decided request of another account with one 404", async () => {
      const owner = await authSession();
      const pendingId = await createPendingRequest(owner.userId);
      const decidedId = await createPendingRequest(owner.userId);
      await decide(owner, decidedId, "rejected");
      // The second session is the user of another tenant, which is where every other account lives.
      const other = await authSession();

      const unknown = await getOne(other.headers, randomUUID());
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.text();
      expect(JSON.parse(unknownBody)).toEqual({ error: "Not found" });
      for (const id of [pendingId, decidedId]) {
        const foreign = await getOne(other.headers, id);
        expect(foreign.status).toBe(404);
        expect(await foreign.text()).toBe(unknownBody);
        // The same id is served to the owner, so the 404 above is a refusal and not a missing route.
        expect((await getOne(owner.headers, id)).status).toBe(200);
      }
    });

    it("answers 404 for an unknown id", async () => {
      const res = await getOne(await authHeader(), randomUUID());
      expect(res.status).toBe(404);
    });

    it("answers 400 validation_failed naming 'id' for an id that is no UUID", async () => {
      const res = await getOne(await authHeader(), "foo");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field: "id" } });
    });

    it("answers 404 to a method other than GET and PATCH", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, { method, headers: session.headers });
        expect(res.status, method).toBe(404);
      }
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM approval_requests WHERE id = $1", [id]);
      expect(rows).toEqual([{ status: "pending" }]);
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
      session: { headers: { Authorization: string }; userId: string };
    }

    /**
     * A pending `send_email` request of the session's user with `args`, made the way the approval-gated MCP tool
     * makes it: the description snapshot of the production builder, and the notification its body renders.
     */
    async function createMcpRequest(args: Record<string, unknown>): Promise<McpRequest> {
      const session = await authSession();
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        description: buildMcpInvokeApprovalDescription("Mail server", "send_email"),
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

    function getDetail(request: McpRequest): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests/${request.id}`, { headers: request.session.headers });
    }

    const emailArgs = () => ({
      to: RECIPIENT,
      subject: SUBJECT,
      body: "Hello, the invoice is attached.",
      apiKey: API_KEY,
      options: { headers: { Authorization: BEARER, "X-Trace": "trace-1" }, password: PASSWORD_VALUE },
    });

    it("returns the argument values to the owner: the recipient and the subject of an e-mail", async () => {
      const request = await createMcpRequest(emailArgs());

      const res = await getDetail(request);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        id: request.id,
        safeSummary: { kind: "mcpInvoke" },
        arguments: { to: RECIPIENT, subject: SUBJECT, body: "Hello, the invoice is attached." },
        argumentsTruncated: false,
      });
      // The safe summary keeps naming the arguments only; Postgres stores them in an order of its own.
      expect(
        z
          .looseObject({ safeSummary: z.looseObject({ argKeys: z.array(z.string()) }) })
          .parse(body)
          .safeSummary.argKeys.sort(),
      ).toEqual(["apiKey", "body", "options", "subject", "to"]);
    });

    it("redacts an argument named apiKey, a nested authorization header and a nested password", async () => {
      const request = await createMcpRequest(emailArgs());

      const res = await getDetail(request);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({
        arguments: {
          apiKey: "[redacted]",
          options: { headers: { Authorization: "[redacted]", "X-Trace": "trace-1" }, password: "[redacted]" },
        },
        argumentsTruncated: false,
      });
      for (const secret of [API_KEY, BEARER, PASSWORD_VALUE]) expect(text).not.toContain(secret);
    });

    it("shortens a 5,000-character body to 2,000 characters and sets argumentsTruncated", async () => {
      const request = await createMcpRequest({ to: RECIPIENT, body: "x".repeat(5000) });

      const res = await getDetail(request);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        arguments: { to: RECIPIENT, body: "x".repeat(2000) },
        argumentsTruncated: true,
      });
    });

    it("keeps the arguments within 16 KiB and sets argumentsTruncated", async () => {
      const entries = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`part${index}`, "y".repeat(1900)]));
      const request = await createMcpRequest({ to: RECIPIENT, ...entries });

      const body = z
        .looseObject({ arguments: z.record(z.string(), z.unknown()), argumentsTruncated: z.boolean() })
        .parse(await (await getDetail(request)).json());

      expect(Buffer.byteLength(JSON.stringify(body.arguments), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(Object.keys(body.arguments).length).toBeLessThan(13);
      expect(body.arguments.to).toBe(RECIPIENT);
      expect(body.argumentsTruncated).toBe(true);
    });

    it("returns the argument values of a decided request to its owner as well", async () => {
      const request = await createMcpRequest(emailArgs());
      const decision = await fetch(`${baseUrl}/api/approval-requests/${request.id}`, {
        method: "PATCH",
        headers: { ...request.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      expect(decision.status).toBe(200);

      const res = await getDetail(request);
      expect(await res.json()).toMatchObject({ status: "rejected", arguments: { to: RECIPIENT, subject: SUBJECT } });
    });

    it("has neither field for a request of a generic operation", async () => {
      const session = await authSession();
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
      const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "item.delete",
        riskClass: "destructive",
        payload: {
          operationName: "item.delete",
          canonicalInput: { itemId: "generic-input-marker" },
          actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: session.userId },
          resourceSnapshot,
        },
        resourceSnapshot,
      });

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}`, { headers: session.headers });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body: unknown = JSON.parse(text);
      expect(body).toMatchObject({ id: created.id, safeSummary: { kind: "genericOperation", argKeys: ["itemId"] } });
      expect(body).not.toHaveProperty("arguments");
      expect(body).not.toHaveProperty("argumentsTruncated");
      expect(text).not.toContain("generic-input-marker");
    });

    it("has neither field for a request of a module tool, pending or decided (issue #1791)", async () => {
      const session = await authSession();
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: session.userId });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "mail_send_draft",
        riskClass: "outbound",
        payload: {
          moduleToolName: "mail_send_draft",
          args: { to: RECIPIENT, apiKey: API_KEY, body: "module-tool-body-marker" },
        },
        resourceSnapshot: { kind: "module_tool", resourceId: "mail_send_draft", sha256: null },
      });

      const read = async (): Promise<unknown> => {
        const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}`, { headers: session.headers });
        expect(res.status).toBe(200);
        const text = await res.text();
        for (const value of [RECIPIENT, API_KEY, "module-tool-body-marker"]) expect(text).not.toContain(value);
        return JSON.parse(text);
      };

      const pending = await read();
      expect(pending).toMatchObject({
        id: created.id,
        status: "pending",
        safeSummary: { kind: "moduleTool", toolName: "mail_send_draft" },
      });
      expect(pending).not.toHaveProperty("arguments");
      expect(pending).not.toHaveProperty("argumentsTruncated");

      const decided = await fetch(`${baseUrl}/api/approval-requests/${created.id}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      expect(decided.status).toBe(200);
      const after = await read();
      expect(after).toMatchObject({ status: "rejected" });
      expect(after).not.toHaveProperty("arguments");
      expect(after).not.toHaveProperty("argumentsTruncated");
    });

    it("answers a request of another account and an unknown id with one 404 that holds no value", async () => {
      const request = await createMcpRequest(emailArgs());
      const other = await authSession();
      const read = (id: string) => fetch(`${baseUrl}/api/approval-requests/${id}`, { headers: other.headers });

      const unknown = await read(randomUUID());
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.text();
      const foreign = await read(request.id);
      expect(foreign.status).toBe(404);
      const foreignBody = await foreign.text();
      expect(foreignBody).toBe(unknownBody);
      expect(foreignBody).not.toContain(RECIPIENT);
      // The same id gives its values to the owner, so the 404 is a refusal and not a missing request.
      expect((await getDetail(request)).status).toBe(200);
    });

    it("keeps every value out of the list, the count, the PATCH answer and the notification body", async () => {
      const request = await createMcpRequest(emailArgs());
      const values = [RECIPIENT, SUBJECT, "the invoice is attached", API_KEY, BEARER, PASSWORD_VALUE];
      const expectNoValue = (text: string, what: string) => {
        for (const value of values) expect(text, what).not.toContain(value);
      };
      const read = async (path: string): Promise<string> => {
        const res = await fetch(`${baseUrl}${path}`, { headers: request.session.headers });
        expect(res.status, path).toBe(200);
        return res.text();
      };

      // The detail has the values, so the reads below are not empty of them by accident.
      expect(await (await getDetail(request)).text()).toContain(RECIPIENT);
      for (const path of [
        "/api/approval-requests",
        "/api/approval-requests?status=pending",
        "/api/approval-requests?status=pending&source=chat",
        "/api/approval-requests/count",
      ]) {
        const text = await read(path);
        expectNoValue(text, path);
      }
      expect(await read("/api/approval-requests?status=pending")).toContain(request.id);

      const decision = await fetch(`${baseUrl}/api/approval-requests/${request.id}`, {
        method: "PATCH",
        headers: { ...request.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      expect(decision.status).toBe(200);
      const decisionText = await decision.text();
      expectNoValue(decisionText, "PATCH");
      expect(JSON.parse(decisionText)).not.toHaveProperty("arguments");
      expect(JSON.parse(decisionText)).not.toHaveProperty("argumentsTruncated");
      // A repeated decision answers the same view.
      const repeated = await fetch(`${baseUrl}/api/approval-requests/${request.id}`, {
        method: "PATCH",
        headers: { ...request.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      const repeatedText = await repeated.text();
      expectNoValue(repeatedText, "repeated PATCH");
      expect(JSON.parse(repeatedText)).not.toHaveProperty("arguments");

      const decidedList = await read("/api/approval-requests?status=decided");
      expect(decidedList).toContain(request.id);
      expectNoValue(decidedList, "decided list");

      const { rows } = await pool.query<{ title: string; body: string | null }>(
        "SELECT title, body FROM notifications WHERE source_table = 'approval_requests' AND source_id = $1",
        [request.id],
      );
      expect(rows).toHaveLength(1);
      const notification = rows[0];
      expect(notification?.body).toEqual(expect.stringContaining("send_email"));
      expectNoValue(`${notification?.title} ${notification?.body}`, "notification");
    });
  });

  describe("GET /api/approval-requests/count (issue #1786)", () => {
    function getCount(headers: { Authorization: string } | undefined, query = ""): Promise<Response> {
      return fetch(`${baseUrl}/api/approval-requests/count${query}`, headers ? { headers } : {});
    }

    async function countOf(session: { headers: { Authorization: string } }, query = ""): Promise<number> {
      const res = await getCount(session.headers, query);
      expect(res.status, `GET /api/approval-requests/count${query}`).toBe(200);
      const body = z.strictObject({ count: z.number().int() }).parse(await res.json());
      return body.count;
    }

    async function listedLength(session: { headers: { Authorization: string } }, query: string): Promise<number> {
      const res = await fetch(`${baseUrl}/api/approval-requests${query}`, { headers: session.headers });
      expect(res.status).toBe(200);
      return z.looseObject({ rows: z.array(z.unknown()) }).parse(await res.json()).rows.length;
    }

    /** A pending request of a new run that `triggeredBy` started and, for `chat`, a chat thread holds. */
    async function pendingRequestFrom(userId: string, kind: "chat" | "mcp"): Promise<string> {
      const threadId = kind === "chat" ? await withTransaction(pool, (client) => createSempChatThread(client)) : null;
      const run = await createAgentRun(pool, {
        triggeredBy: kind === "chat" ? "user" : "mcp",
        task: "test",
        userId,
        ...(threadId === null ? {} : { threadId }),
      });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "outbound",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      return created.id;
    }

    it("rejects a request with no credentials", async () => {
      expect((await getCount(undefined)).status).toBe(401);
      expect((await getCount(undefined, "?status=pending")).status).toBe(401);
    });

    it("counts zero when the owner has no pending request", async () => {
      const session = await authSession();
      expect(await countOf(session)).toBe(0);
      expect(await countOf(session, "?status=pending&source=chat")).toBe(0);
    });

    it("counts the owner's pending requests, with or without status=pending, and not the decided ones", async () => {
      const session = await authSession();
      await createPendingRequest(session.userId);
      await createPendingRequest(session.userId);
      const decided = await createPendingRequest(session.userId);
      await fetch(`${baseUrl}/api/approval-requests/${decided}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(await countOf(session)).toBe(2);
      expect(await countOf(session, "?status=pending")).toBe(2);
      expect(await listedLength(session, "?status=pending")).toBe(2);
    });

    it("counts the requests of the given source kinds, as many as the list returns for the same filter", async () => {
      const session = await authSession();
      await pendingRequestFrom(session.userId, "chat");
      await pendingRequestFrom(session.userId, "chat");
      await pendingRequestFrom(session.userId, "mcp");

      for (const [query, expected] of [
        ["?status=pending&source=chat", 2],
        ["?status=pending&source=mcp", 1],
        ["?source=tick", 0],
        ["?source=chat,mcp", 3],
        ["?source=mcp,chat,mcp", 3],
        ["?status=pending", 3],
      ] as const) {
        expect(await countOf(session, query), query).toBe(expected);
        expect(await listedLength(session, query), query).toBe(expected);
      }
    });

    it("does not count another account's pending request", async () => {
      const owner = await authSession();
      await createPendingRequest(owner.userId);
      // The other account's request lives in its own tenant, the only place its run can be recorded.
      const otherTenant = await createTestTenant(pool);
      const other = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
        tenantId: otherTenant,
      });
      await withTenantTransaction(pool, otherTenant, async (client) => {
        const run = await createAgentRun(client, { triggeredBy: "user", task: "test", userId: other.id });
        for (let copy = 0; copy < 2; copy += 1) {
          await createPendingApprovalRequest(client, {
            agentRunId: run.id,
            toolName: "search_web",
            riskClass: "unclassified",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          });
        }
      });

      expect(await countOf(owner)).toBe(1);
    });

    it.each([
      ["status", "?status=decided"],
      ["status", "?status="],
      ["status", "?status=PENDING"],
      ["status", "?status=pending&status=pending"],
      ["source", "?status=pending&source=inbox"],
      ["source", "?source="],
      ["source", "?source=chat,"],
      ["source", "?source=CHAT"],
      ["source", "?source=chat,inbox"],
      ["source", "?source=chat&source=mcp"],
    ])("answers 400 naming %s for %s", async (field, query) => {
      const session = await authSession();
      await createPendingRequest(session.userId);

      const res = await getCount(session.headers, query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field } });
    });

    it("serves the literal path as a count and not as a request id", async () => {
      const session = await authSession();
      const res = await getCount(session.headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 0 });
    });

    it("answers 404 to a method other than GET, and makes no decision", async () => {
      const session = await authSession();
      const id = await createPendingRequest(session.userId);
      for (const method of ["PATCH", "POST", "DELETE"]) {
        const res = await fetch(`${baseUrl}/api/approval-requests/count`, {
          method,
          headers: { ...session.headers, "Content-Type": "application/json" },
          ...(method === "DELETE" ? {} : { body: JSON.stringify({ decision: "approved" }) }),
        });
        expect(res.status, method).toBe(404);
        expect(await res.json(), method).toEqual({ error: "Not found" });
      }
      expect(await countOf(session)).toBe(1);
      expect(await countExecuteJobs(id)).toBe(0);
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

  it("reads one request in the reader's locale and answers another tenant's id like a random one (issue #1786)", async () => {
    const english = await tenantSession("en");
    const czech = await tenantSession("cs");
    const ofEnglish = await itemThreadRequest(english, "Buy milk");
    const ofCzech = await itemThreadRequest(czech, "Zavolat domů");
    const getOne = (session: Session, id: string) =>
      fetch(`${baseUrl}/api/approval-requests/${id}`, { headers: session.headers });

    const own = await getOne(czech, ofCzech.requestId);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      id: ofCzech.requestId,
      source: { kind: "chat", threadId: ofCzech.threadId, threadTitle: "Úprava: Zavolat domů" },
    });
    const ownEnglish = await getOne(english, ofEnglish.requestId);
    expect(await ownEnglish.json()).toMatchObject({ source: { threadTitle: "Edit: Buy milk" } });

    const unknown = await getOne(english, randomUUID());
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    const foreign = await getOne(english, ofCzech.requestId);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(unknownBody);
    expect([...foreign.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
  });

  it("counts only the caller's tenant's requests (issue #1786)", async () => {
    const first = await tenantSession("en");
    const second = await tenantSession("en");
    await itemThreadRequest(first, "One");
    await itemThreadRequest(second, "Two");
    await itemThreadRequest(second, "Three");
    const count = async (session: Session, query: string): Promise<unknown> => {
      const res = await fetch(`${baseUrl}/api/approval-requests/count${query}`, { headers: session.headers });
      expect(res.status).toBe(200);
      return res.json();
    };

    expect(await count(first, "")).toEqual({ count: 1 });
    expect(await count(second, "")).toEqual({ count: 2 });
    expect(await count(second, "?status=pending&source=chat")).toEqual({ count: 2 });
    expect(await count(second, "?source=mcp,tick")).toEqual({ count: 0 });
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
