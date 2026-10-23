import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
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
    const body = (await res.json()) as { status: string; decidedBy: string };
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toBe(session.userId);
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
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("rejected");
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
    const body = (await res.json()) as { decidedBy: string };
    expect(body.decidedBy).toBe(session.userId);
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
    const body = (await res.json()) as { decidedBy: string };
    expect(body.decidedBy).toBe(session.userId);
    expect(body.decidedBy).not.toBe(claimedDecider);
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
    const body = (await res.json()) as Record<string, unknown> & { safeSummary: { argKeys: string[] } };
    expect(body).not.toHaveProperty("payload");
    expect(JSON.stringify(body)).not.toContain('"hi"');
    expect(body.safeSummary.argKeys).toEqual(["query"]);
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
    const body = (await second.json()) as { status: string; decidedBy: string };
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toBe(session.userId);
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
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe("validation_failed");
    expect(body.details).toEqual({ field: "id" });
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
        riskClass: "moderate",
        payload,
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });

      const res = await fetch(`${baseUrl}/api/approval-requests`, {
        headers: session.headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({
        toolName: "send_email",
        riskClass: "moderate",
        agentRunId: run.id,
        projectItemId: projectItem.id,
        projectName: "Kitchen",
        safeSummary: {
          mcpToolRegistrationId: payload.mcpToolRegistrationId,
          mcpServerItemId: payload.mcpServerItemId,
          argKeys: ["to"],
        },
      });
      expect(JSON.stringify(body)).not.toContain("a@b.com");
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
      const body = (await res.json()) as { rows: Array<{ id: string }> };
      expect(body.rows.map((row) => row.id)).toEqual([ownId]);
    });
  });
});
