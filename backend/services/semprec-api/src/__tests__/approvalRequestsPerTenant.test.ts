import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createAgentRun, createPendingApprovalRequest, createUser, hashPassword, login } from "@semprec/data";
import { createApprovalRequestsRequestListener } from "../approvalRequestsHandler.js";

const PASSWORD = "s3cret-password";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let server: Server;
let baseUrl: string;

async function createUserIn(tenantId: string): Promise<{ id: string; headers: { Authorization: string } }> {
  const email = `${randomUUID()}@example.com`;
  const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { id: user.id, headers: { Authorization: `Bearer ${token}` } };
}

/** A pending request on a run whose actor is `ownerUserId`, created in `tenantId`'s own scope. */
async function createPendingRequestIn(tenantId: string, ownerUserId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerUserId });
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return created.id;
  });
}

async function patch(
  headers: { Authorization: string },
  requestId: string,
  decision: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  return { status: res.status, text: await res.text() };
}

describe("approval requests across two tenants (issue #1028)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    server = createServer(createApprovalRequestsRequestListener(pool));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers tenant B's PATCH on tenant A's request exactly like a random id and leaves the request pending", async () => {
    const aUser = await createUserIn(tenantA);
    const bUser = await createUserIn(tenantB);
    const aRequestId = await createPendingRequestIn(tenantA, aUser.id);

    const foreign = await patch(bUser.headers, aRequestId, "approved");
    const random = await patch(bUser.headers, randomUUID(), "approved");

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(random);
    const { rows } = await adminPool.query<{ status: string; decided_by: string | null }>(
      `SELECT status, decided_by FROM approval_requests WHERE id = $1`,
      [aRequestId],
    );
    expect(rows[0]).toEqual({ status: "pending", decided_by: null });
    const { rows: jobs } = await adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = 'approvalExecute'`,
    );
    expect(jobs[0]!.count).toBe(0);
  });

  it("never lists tenant A's pending request for tenant B's user", async () => {
    const aUser = await createUserIn(tenantA);
    const bUser = await createUserIn(tenantB);
    const aRequestId = await createPendingRequestIn(tenantA, aUser.id);

    const bList = await fetch(`${baseUrl}/api/approval-requests`, { headers: bUser.headers });
    expect(bList.status).toBe(200);
    expect(await bList.json()).toEqual({ rows: [] });

    const aList = await fetch(`${baseUrl}/api/approval-requests`, { headers: aUser.headers });
    const aBody = (await aList.json()) as { rows: Array<{ id: string }> };
    expect(aBody.rows.map((row) => row.id)).toEqual([aRequestId]);
  });
});
