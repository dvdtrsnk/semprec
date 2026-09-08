import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest, getApprovalRequest } from "../mcp/approvalRequestsStore.js";

let pool: Pool;

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
});
