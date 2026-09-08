import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createViewTypeRegistry, seedSystem, createAgentRun, createPendingApprovalRequest } from "@semprec/data";
import { createApprovalRequestsRequestListener } from "../approvalRequestsHandler.js";

const AUTH_TOKEN = "test-token";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}

async function createPendingRequest(): Promise<string> {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
  const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } };
  const created = await createPendingApprovalRequest(pool, {
    agentRunId: run.id,
    toolName: "search_web",
    riskClass: "unclassified",
    payload,
  });
  return created.id;
}

describe("createApprovalRequestsRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);

    server = createServer(createApprovalRequestsRequestListener(pool, { authToken: AUTH_TOKEN }));
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

  it("rejects a request with no bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("approves a pending request", async () => {
    const id = await createPendingRequest();
    const userId = await createUser();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: userId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; decidedBy: string };
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toBe(userId);
  });

  it("rejects a pending request", async () => {
    const id = await createPendingRequest();
    const userId = await createUser();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", decidedByUserId: userId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("rejected");
  });

  it("returns 400 for an invalid decision value", async () => {
    const id = await createPendingRequest();
    const userId = await createUser();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "maybe", decidedByUserId: userId }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing decidedByUserId", async () => {
    const id = await createPendingRequest();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a decidedByUserId that references no user", async () => {
    const id = await createPendingRequest();

    const res = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: randomUUID() }),
    });
    expect(res.status).toBe(400);
  });

  it("treats a repeated decision as a deterministic no-op, returning the current state with 200", async () => {
    const id = await createPendingRequest();
    const userId = await createUser();
    const otherUser = await createUser();

    const first = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: userId }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/approval-requests/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", decidedByUserId: otherUser }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string; decidedBy: string };
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toBe(userId);
  });

  it("returns 404 for an unknown approval request id", async () => {
    const userId = await createUser();

    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: userId }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a PATCH with a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PATCH whose body exceeds the maximum allowed size", async () => {
    const res = await fetch(`${baseUrl}/api/approval-requests/${randomUUID()}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", decidedByUserId: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
