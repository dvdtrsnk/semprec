import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  createPendingApprovalRequest,
  getApprovalRequest,
  decideApprovalRequest,
  claimApprovalRequestExecution,
  recordApprovalRequestOutcome,
} from "../mcp/approvalRequestsStore.js";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
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

describe("approvalRequestsStore (issue #130)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a pending request that snapshots the invocation and can be read back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { query: "hi" } };

    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload,
    });

    expect(created.status).toBe("pending");
    expect(created.decidedAt).toBeNull();
    expect(created.decidedBy).toBeNull();
    expect(created.agentRunId).toBe(run.id);
    expect(created.toolName).toBe("search_web");
    expect(created.riskClass).toBe("unclassified");
    expect(created.payload).toEqual(payload);

    const fetched = await getApprovalRequest(pool, created.id);
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    expect(await getApprovalRequest(pool, randomUUID())).toBeNull();
  });

  describe("decideApprovalRequest (issue #131)", () => {
    it("transitions a pending request to approved and records who/when", async () => {
      const id = await createPendingRequest();
      const userId = await createUser();

      const decided = await decideApprovalRequest(pool, id, "approved", userId);

      expect(decided).not.toBeNull();
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedBy).toBe(userId);
      expect(decided!.decidedAt).not.toBeNull();
    });

    it("transitions a pending request to rejected", async () => {
      const id = await createPendingRequest();
      const userId = await createUser();

      const decided = await decideApprovalRequest(pool, id, "rejected", userId);

      expect(decided!.status).toBe("rejected");
    });

    it("returns null and makes no change for a request that is already decided", async () => {
      const id = await createPendingRequest();
      const userId = await createUser();
      await decideApprovalRequest(pool, id, "approved", userId);

      const otherUser = await createUser();
      const second = await decideApprovalRequest(pool, id, "rejected", otherUser);

      expect(second).toBeNull();
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("approved");
      expect(stored!.decidedBy).toBe(userId);
    });

    it("returns null for an unknown id", async () => {
      const userId = await createUser();
      expect(await decideApprovalRequest(pool, randomUUID(), "approved", userId)).toBeNull();
    });

    it("only one of two concurrent decisions wins", async () => {
      const id = await createPendingRequest();
      const [userA, userB] = await Promise.all([createUser(), createUser()]);

      const [a, b] = await Promise.all([
        decideApprovalRequest(pool, id, "approved", userA),
        decideApprovalRequest(pool, id, "rejected", userB),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe(winners[0]!.status);
      expect(stored!.decidedBy).toBe(winners[0]!.decidedBy);
    });
  });

  describe("claimApprovalRequestExecution / recordApprovalRequestOutcome (issue #131)", () => {
    it("claims an approved, unexecuted request exactly once", async () => {
      const id = await createPendingRequest();
      const userId = await createUser();
      await decideApprovalRequest(pool, id, "approved", userId);

      const first = await claimApprovalRequestExecution(pool, id);
      const second = await claimApprovalRequestExecution(pool, id);

      expect(first).not.toBeNull();
      expect(first!.executedAt).not.toBeNull();
      expect(second).toBeNull();
    });

    it("does not claim a pending or rejected request", async () => {
      const pendingId = await createPendingRequest();
      expect(await claimApprovalRequestExecution(pool, pendingId)).toBeNull();

      const rejectedId = await createPendingRequest();
      const userId = await createUser();
      await decideApprovalRequest(pool, rejectedId, "rejected", userId);
      expect(await claimApprovalRequestExecution(pool, rejectedId)).toBeNull();
    });

    it("records the execution outcome on the claimed row", async () => {
      const id = await createPendingRequest();
      const userId = await createUser();
      await decideApprovalRequest(pool, id, "approved", userId);
      await claimApprovalRequestExecution(pool, id);

      await recordApprovalRequestOutcome(pool, id, { error: false, result: "ok" });

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.executionError).toBe(false);
      expect(stored!.executionResult).toBe("ok");
    });
  });
});
