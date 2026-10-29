import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RISK_CLASSES } from "@semprec/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser as createRawUser } from "../auth/usersStore.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  type ApprovalDescription,
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

describe("approvalRequestsStore reason (issue #1420)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insertWithReason(reason: string | null | undefined) {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    return createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(reason === undefined ? {} : { reason }),
    });
  }

  it("stores the reason and reads it back", async () => {
    const created = await insertWithReason("You last filled in Mood in August.");
    expect(created.reason).toBe("You last filled in Mood in August.");
    expect((await getApprovalRequest(pool, created.id))!.reason).toBe("You last filled in Mood in August.");
  });

  it("reads null when no reason was given", async () => {
    expect((await insertWithReason(undefined)).reason).toBeNull();
    expect((await insertWithReason(null)).reason).toBeNull();
  });

  it("accepts a reason of exactly 500 characters and rejects 501 at the database", async () => {
    expect((await insertWithReason("x".repeat(500))).reason).toHaveLength(500);
    await expect(insertWithReason("x".repeat(501))).rejects.toThrow(/approval_requests_reason_length_check/);
  });
});

describe("approval_requests.risk_class closed set (issue #1423)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(new URL("../db/migrations/0094_approval_requests_risk_class_check.sql", import.meta.url)),
    "utf8",
  );

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insertRaw(riskClass: string): Promise<string> {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, resource_snapshot)
       VALUES ($1, 'search_web', $2, '{}'::jsonb, '{"kind":"test","resourceId":"test","sha256":null}'::jsonb) RETURNING id`,
      [run.id, riskClass],
    );
    return rows[0]!.id;
  }

  it("rejects an unknown class at the database", async () => {
    await expect(insertRaw("high")).rejects.toThrow(/approval_requests_risk_class_check/);
    for (const value of RISK_CLASSES) await insertRaw(value);
  });

  it("backfills a legacy unknown class to unclassified when the migration runs", async () => {
    await pool.query("ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_risk_class_check");
    const legacyId = await insertRaw("high");
    const knownId = await insertRaw("destructive");

    await pool.query(migrationSql);

    expect((await getApprovalRequest(pool, legacyId))!.riskClass).toBe("unclassified");
    expect((await getApprovalRequest(pool, knownId))!.riskClass).toBe("destructive");
    await expect(insertRaw("high")).rejects.toThrow(/approval_requests_risk_class_check/);
  });
});

describe("approvalRequestsStore toolCallId (issue #1618)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insert(agentRunId: string, toolCallId?: string | null) {
    return createPendingApprovalRequest(pool, {
      agentRunId,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }

  it("stores the tool call id and reads it back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id, "call_1");
    expect(created.toolCallId).toBe("call_1");
    expect((await getApprovalRequest(pool, created.id))!.toolCallId).toBe("call_1");
  });

  it("leaves tool_call_id NULL when none is supplied, and allows several such requests per run", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const first = await insert(run.id);
    const second = await insert(run.id, null);
    expect(first.toolCallId).toBeNull();
    expect(second.toolCallId).toBeNull();
    expect(second.id).not.toBe(first.id);
  });

  it("returns the existing request for a repeated (run, tool call id) and keeps one row", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const first = await insert(run.id, "call_1");
    const again = await insert(run.id, "call_1");
    expect(again.id).toBe(first.id);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM approval_requests WHERE agent_run_id = $1", [
      run.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("creates separate requests for the same tool call id in different runs or different ids in one run", async () => {
    const runA = await createAgentRun(pool, { triggeredBy: "user", task: "a", userId: ownerId });
    const runB = await createAgentRun(pool, { triggeredBy: "user", task: "b", userId: ownerId });
    const a1 = await insert(runA.id, "call_1");
    const b1 = await insert(runB.id, "call_1");
    const a2 = await insert(runA.id, "call_2");
    expect(new Set([a1.id, b1.id, a2.id]).size).toBe(3);
  });
});

describe("approvalRequestsStore description (issue #1683)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    ownerId = await createUser();
  });

  async function insert(runId: string, description?: ApprovalDescription) {
    return createPendingApprovalRequest(pool, {
      agentRunId: runId,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      ...(description === undefined ? {} : { description }),
    });
  }

  it("stores the description and reads it back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const description: ApprovalDescription = {
      key: "approval.viewDelete",
      params: { viewName: "Open", databaseName: null, count: 3 },
    };
    const created = await insert(run.id, description);
    expect(created.description).toEqual(description);
    expect((await getApprovalRequest(pool, created.id))!.description).toEqual(description);
  });

  it("returns null for a row without a description and leaves every other field unchanged", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id);
    await pool.query(`UPDATE approval_requests SET description = NULL WHERE id = $1`, [created.id]);
    const read = await getApprovalRequest(pool, created.id);
    expect(read).toEqual(created);
    expect(read!.description).toBeNull();
    expect(read!.toolName).toBe("search_web");
  });

  it.each([
    ["a non-object", "approval.x"],
    ["a missing key", { params: {} }],
    ["missing params", { key: "approval.x" }],
    ["a nested param value", { key: "approval.x", params: { a: { b: 1 } } }],
    ["a malformed endsInheritance", { key: "approval.x", params: {}, endsInheritance: [{ itemId: 1 }] }],
  ])("rejects a row whose description is %s", async (_label, description) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", userId: ownerId });
    const created = await insert(run.id);
    await pool.query(`UPDATE approval_requests SET description = $2::jsonb WHERE id = $1`, [
      created.id,
      JSON.stringify(description),
    ]);
    await expect(getApprovalRequest(pool, created.id)).rejects.toThrow("Malformed description in database row");
  });
});

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

      const second = await decideApprovalRequest(pool, id, "rejected", ownerId);

      expect(second).toBeNull();
      const stored = await getApprovalRequest(pool, id);
      expect(stored!.status).toBe("approved");
      expect(stored!.decidedBy).toBe(userId);
    });

    it("returns null for an unknown id", async () => {
      const userId = ownerId;
      expect(await decideApprovalRequest(pool, randomUUID(), "approved", userId)).toBeNull();
    });

    it("only one of two concurrent decisions by the owner wins", async () => {
      const id = await createPendingRequest();

      const [a, b] = await Promise.all([
        decideApprovalRequest(pool, id, "approved", ownerId),
        decideApprovalRequest(pool, id, "rejected", ownerId),
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
      // Another account's run lives in that account's own tenant: a run's actor must be its own
      // tenant's user (agent_runs_actor_user_id_tenant_fkey, issue #1066).
      const foreignTenant = await createTestTenant(pool);
      const foreignUser = await createRawUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: foreignTenant,
      });
      await withTenantTransaction(pool, foreignTenant, async (client) => {
        const foreignRun = await createAgentRun(client, { triggeredBy: "user", task: "other", userId: foreignUser.id });
        await createPendingApprovalRequest(client, {
          agentRunId: foreignRun.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
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
