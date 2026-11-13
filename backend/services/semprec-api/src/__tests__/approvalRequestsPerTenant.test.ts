import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  claimSempMessage,
  createAgentRun,
  createPendingApprovalRequest,
  createUser,
  finishSempMessageTurn,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  sendSempMessage,
  startSempMessageTurn,
  withTransaction,
} from "@semprec/data";
import type { SempReplyStep } from "@semprec/data";
import { createApprovalRequestsRequestListener } from "../approvalRequestsHandler.js";
import { createDispatcher } from "../app.js";

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

  /** The step of a call that asked for `approvalRequestId`, as the turn summary stores it. */
  function waitingStep(approvalRequestId: string): SempReplyStep {
    return {
      kind: "tool",
      toolCallId: randomUUID(),
      toolName: "send_email",
      label: { key: "agentStep.title.namedTool", params: { toolName: "send_email" } },
      detail: { key: "agentStep.summary.approvalRequested", params: {} },
      status: "wait",
      startedAt: "2026-11-01T10:00:00.000Z",
      durationMs: 12,
      approvalRequestId,
    };
  }

  const PLAIN_STEP: SempReplyStep = {
    kind: "tool",
    toolCallId: randomUUID(),
    toolName: "database_list",
    label: { key: "agentStep.title.namedTool", params: { toolName: "database_list" } },
    detail: { key: "agentStep.summary.done", params: {} },
    status: "ok",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 3,
  };

  /**
   * A finished assistant reply in `tenantId` whose stored summary holds `steps`, written by the production
   * writers: the message is sent, claimed, started on a run of `userId` and finished with its summary.
   */
  async function createRepliedThread(
    tenantId: string,
    userId: string,
    steps: SempReplyStep[],
  ): Promise<{ threadId: string; messageId: string }> {
    return runInTenant(tenantId, async () => {
      const sent = await withTransaction(pool, async (client) => {
        const message = await sendSempMessage(client, { text: "send it", context: [], hasContext: false });
        if (!(await claimSempMessage(client, message.threadId, message.assistantMessageId)))
          throw new Error("The fixture message could not be claimed");
        return message;
      });
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "reply",
        userId,
        threadId: sent.threadId,
      });
      const event = await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
      await withTransaction(pool, async (client) => {
        await startSempMessageTurn(client, sent.assistantMessageId, run.id, event.id);
        const finished = await finishSempMessageTurn(client, sent.assistantMessageId, {
          status: "done",
          text: "I asked for approval",
          lastEventId: event.id,
          summary: { steps, durationMs: 100, tokens: { input: 0, output: 0 }, changes: [] },
        });
        if (!finished) throw new Error("The fixture message was not finished");
      });
      return { threadId: sent.threadId, messageId: sent.assistantMessageId };
    });
  }

  interface HistoryStep {
    approvalRequestId?: string;
    approval?: unknown;
  }

  async function readSteps(headers: { Authorization: string }, threadId: string): Promise<HistoryStep[]> {
    const res = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, { headers });
    expect(res.status).toBe(200);
    const body = z
      .object({
        rows: z.array(z.object({ role: z.string(), steps: z.array(z.looseObject({})).optional() })),
      })
      .parse(await res.json());
    return body.rows
      .flatMap((row) => row.steps ?? [])
      .map((step) => z.looseObject({ approval: z.unknown().optional() }).parse(step));
  }

  describe("live approval state on thread steps across two tenants (issue #1887)", () => {
    let userA: { id: string; headers: { Authorization: string } };
    let userB: { id: string; headers: { Authorization: string } };

    beforeEach(async () => {
      // The outer beforeEach started the listener of the approval routes; these tests need the whole API.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      userA = await createUserIn(tenantA);
      userB = await createUserIn(tenantB);
      const dispatch = await createDispatcher(pool, {
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "https://example.test",
        setupToken: "test",
        moduleRegistry: await loadFullModuleRegistry(),
        blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-step-approval-test-${randomUUID()}`)),
        maxFileSizeBytes: 1024,
      });
      server = createServer(dispatch);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    it("returns the live state of the owner's request on the step, follows a decision and never rewrites the stored steps", async () => {
      const requestId = await createPendingRequestIn(tenantA, userA.id);
      const { threadId, messageId } = await createRepliedThread(tenantA, userA.id, [
        PLAIN_STEP,
        waitingStep(requestId),
      ]);
      const storedBefore = await adminPool.query<{ steps: unknown }>("SELECT steps FROM semp_messages WHERE id = $1", [
        messageId,
      ]);

      const pending = await readSteps(userA.headers, threadId);
      expect(pending[0]).not.toHaveProperty("approval");
      expect(pending[1]?.approval).toEqual({
        status: "pending",
        executionStatus: "not_approved",
        conflictReason: null,
      });

      expect((await patch(userA.headers, requestId, "rejected")).status).toBe(200);
      const rejected = await readSteps(userA.headers, threadId);
      expect(rejected[1]?.approval).toEqual({
        status: "rejected",
        executionStatus: "not_approved",
        conflictReason: null,
      });

      const storedAfter = await adminPool.query<{ steps: unknown }>("SELECT steps FROM semp_messages WHERE id = $1", [
        messageId,
      ]);
      expect(storedAfter.rows).toEqual(storedBefore.rows);
      expect(JSON.stringify(storedAfter.rows)).not.toContain('approval":');
    });

    it("returns neither the payload nor the arguments of the request on the step", async () => {
      const requestId = await createPendingRequestIn(tenantA, userA.id);
      const { threadId } = await createRepliedThread(tenantA, userA.id, [waitingStep(requestId)]);

      const res = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, { headers: userA.headers });
      const text = await res.text();

      expect(text).toContain('"approval"');
      expect(text).not.toContain("payload");
      expect(text).not.toContain("mcpToolRegistrationId");
      expect(text).not.toContain('"query"');
    });

    it("answers a step that points at another tenant's request exactly like a step that points at a random id", async () => {
      const foreignRequestId = await createPendingRequestIn(tenantA, userA.id);
      const foreign = await createRepliedThread(tenantB, userB.id, [waitingStep(foreignRequestId)]);
      const random = await createRepliedThread(tenantB, userB.id, [waitingStep(randomUUID())]);

      const foreignSteps = await readSteps(userB.headers, foreign.threadId);
      const randomSteps = await readSteps(userB.headers, random.threadId);

      expect(foreignSteps[0]).toHaveProperty("approval", null);
      expect(randomSteps[0]).toHaveProperty("approval", null);
      // The request is live for its owner, so the null above is the tenant scope, not a missing row.
      const own = await createRepliedThread(tenantA, userA.id, [waitingStep(foreignRequestId)]);
      expect((await readSteps(userA.headers, own.threadId))[0]?.approval).toMatchObject({ status: "pending" });
    });
  });
});
