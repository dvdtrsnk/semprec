import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  createPendingApprovalRequest,
  getApprovalRequest,
  getApprovalRequestForOwner,
  decideApprovalRequest,
  listPendingApprovalRequests,
  claimApprovalRequestExecution,
  recordApprovalRequestOutcome,
} from "../mcp/approvalRequestsStore.js";

let pool: Pool;
let ownerId: string;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function createPendingRequest(): Promise<string> {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
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

describe("approvalRequestsStore (issue #130)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    ownerId = await createUser();
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
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
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

  describe("resource_snapshot shape at the read boundary", () => {
    it("reads back a snapshot whose sha256 is null", async () => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2 WHERE id = $1`, [
        id,
        JSON.stringify({ kind: "item", resourceId: "item-1", sha256: null }),
      ]);

      const read = await getApprovalRequest(pool, id);
      expect(read?.resourceSnapshot).toEqual({ kind: "item", resourceId: "item-1", sha256: null });
    });

    it("reads back a snapshot that carries a sha256", async () => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2 WHERE id = $1`, [
        id,
        JSON.stringify({ kind: "item", resourceId: "item-1", sha256: "abc" }),
      ]);

      const read = await getApprovalRequest(pool, id);
      expect(read?.resourceSnapshot).toEqual({ kind: "item", resourceId: "item-1", sha256: "abc" });
    });

    it.each([
      ["a JSON null", null],
      ["a non-object", "item-1"],
      ["a missing kind", { resourceId: "item-1", sha256: null }],
      ["a non-string resourceId", { kind: "item", resourceId: 1, sha256: null }],
      ["a missing sha256", { kind: "item", resourceId: "item-1" }],
      ["a non-string sha256", { kind: "item", resourceId: "item-1", sha256: 1 }],
    ])("rejects a row whose snapshot is %s instead of passing it through", async (_label, snapshot) => {
      const id = await createPendingRequest();
      await pool.query(`UPDATE approval_requests SET resource_snapshot = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify(snapshot),
      ]);

      await expect(getApprovalRequest(pool, id)).rejects.toThrow("Malformed resource_snapshot in database row");
    });
  });

  describe("decideApprovalRequest (issue #131)", () => {
    it("transitions a pending request to approved and records who/when", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;

      const decided = await decideApprovalRequest(pool, id, "approved", userId);

      expect(decided).not.toBeNull();
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedBy).toBe(userId);
      expect(decided!.decidedAt).not.toBeNull();
    });

    it("transitions a pending request to rejected", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;

      const decided = await decideApprovalRequest(pool, id, "rejected", userId);

      expect(decided!.status).toBe("rejected");
    });

    it("returns null and makes no change for a request that is already decided", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);

      const otherUser = await createUser();
      const second = await decideApprovalRequest(pool, id, "rejected", otherUser);

      expect(second).toBeNull();
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("approved");
      expect(stored!.decidedBy).toBe(userId);
    });

    it("returns null for an unknown id", async () => {
      const userId = ownerId;
      expect(await decideApprovalRequest(pool, randomUUID(), "approved", userId)).toBeNull();
    });

    it("only one of two concurrent decisions wins", async () => {
      const id = await createPendingRequest();
      const userB = await createUser();

      const [a, b] = await Promise.all([
        decideApprovalRequest(pool, id, "approved", ownerId),
        decideApprovalRequest(pool, id, "rejected", userB),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe(winners[0]!.status);
      expect(stored!.decidedBy).toBe(winners[0]!.decidedBy);
    });

    it("returns null and changes nothing when the decider is not the run's actor (issue #1028)", async () => {
      const id = await createPendingRequest();
      const foreignUser = await createUser();

      expect(await decideApprovalRequest(pool, id, "approved", foreignUser)).toBeNull();

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("pending");
      expect(stored!.decidedBy).toBeNull();
    });

    it("returns null for a foreign caller even after the owner decided (issue #1028)", async () => {
      const id = await createPendingRequest();
      await decideApprovalRequest(pool, id, "approved", ownerId);

      expect(await decideApprovalRequest(pool, id, "rejected", await createUser())).toBeNull();
      expect((await getApprovalRequest(pool, id))!.decidedBy).toBe(ownerId);
    });

    it("getApprovalRequestForOwner returns the row only for its run's actor (issue #1028)", async () => {
      const id = await createPendingRequest();

      expect((await getApprovalRequestForOwner(pool, id, ownerId))!.id).toBe(id);
      expect(await getApprovalRequestForOwner(pool, id, await createUser())).toBeNull();
    });

    it("listPendingApprovalRequests returns only the owner's pending requests (issue #1028)", async () => {
      const ownRequestId = await createPendingRequest();
      const foreignUser = await createUser();
      const foreignRun = await createAgentRun(pool, { triggeredBy: "user", task: "other", userId: foreignUser });
      await createPendingApprovalRequest(pool, {
        agentRunId: foreignRun.id,
        toolName: "search_web",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });

      const ids = (await listPendingApprovalRequests(pool, ownerId)).map((request) => request.id);

      expect(ids).toEqual([ownRequestId]);
    });
  });

  describe("claimApprovalRequestExecution / recordApprovalRequestOutcome (issue #131)", () => {
    it("claims an approved, unexecuted request exactly once", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
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
      const userId = ownerId;
      await decideApprovalRequest(pool, rejectedId, "rejected", userId);
      expect(await claimApprovalRequestExecution(pool, rejectedId)).toBeNull();
    });

    it("records the execution outcome on the claimed row", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);
      await claimApprovalRequestExecution(pool, id);

      await recordApprovalRequestOutcome(pool, id, { error: false, result: "ok" });

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.executionError).toBe(false);
      expect(stored!.executionResult).toBe("ok");
      expect(stored!.executionStatus).toBe("succeeded");
    });

    it("records a failed outcome as 'conflict', not 'succeeded' (issue #89)", async () => {
      const id = await createPendingRequest();
      const userId = ownerId;
      await decideApprovalRequest(pool, id, "approved", userId);
      await claimApprovalRequestExecution(pool, id);

      await recordApprovalRequestOutcome(pool, id, { error: true, result: "it broke" });

      const stored = await getApprovalRequest(pool, id);
      expect(stored!.executionError).toBe(true);
      expect(stored!.executionResult).toBe("it broke");
      expect(stored!.executionStatus).toBe("conflict");
    });
  });
});
