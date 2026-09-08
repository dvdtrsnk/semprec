import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest, decideApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { listApprovalRequestsQueue } from "../mcp/approvalRequestsQueue.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
  return rows[0]!.id;
}

describe("listApprovalRequestsQueue (issue #132)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns pending requests joined with their source project's name and agent run", async () => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    await chokePoint.createProperty({ databaseId: projects.id, key: "name", name: "Name", type: "title" });
    const projectItem = await chokePoint.createItem({
      databaseId: projects.id,
      properties: { name: "Renovate the kitchen" },
    });
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test", projectItemId: projectItem.id });

    const payload = {
      mcpToolRegistrationId: randomUUID(),
      mcpServerItemId: randomUUID(),
      args: { to: "a@b.com", apiKey: "secret" },
    };
    const created = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "moderate",
      payload,
    });

    const rows = await listApprovalRequestsQueue(pool);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: created.id,
      toolName: "send_email",
      riskClass: "moderate",
      requestedAt: created.requestedAt,
      safeSummary: {
        mcpToolRegistrationId: payload.mcpToolRegistrationId,
        mcpServerItemId: payload.mcpServerItemId,
        argKeys: ["to", "apiKey"],
      },
      agentRunId: run.id,
      projectItemId: projectItem.id,
      projectName: "Renovate the kitchen",
    });
  });

  it("never includes argument values, only their keys", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = {
      mcpToolRegistrationId: randomUUID(),
      mcpServerItemId: randomUUID(),
      args: { password: "hunter2" },
    };
    await createPendingApprovalRequest(pool, { agentRunId: run.id, toolName: "login", riskClass: "high", payload });

    const rows = await listApprovalRequestsQueue(pool);

    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(rows[0]!.safeSummary.argKeys).toEqual(["password"]);
  });

  it("returns null project fields for a run with no project (e.g. the supervisor's own run)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
    await createPendingApprovalRequest(pool, { agentRunId: run.id, toolName: "noop", riskClass: "low", payload });

    const rows = await listApprovalRequestsQueue(pool);

    expect(rows[0]!.projectItemId).toBeNull();
    expect(rows[0]!.projectName).toBeNull();
  });

  it("orders oldest request first and excludes decided requests", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
    const first = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "first",
      riskClass: "low",
      payload,
    });
    const second = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "second",
      riskClass: "low",
      payload,
    });
    const decided = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "third",
      riskClass: "low",
      payload,
    });
    await decideApprovalRequest(pool, decided.id, "approved", await createUser());

    const rows = await listApprovalRequestsQueue(pool);

    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("returns an empty array when there are no pending requests", async () => {
    expect(await listApprovalRequestsQueue(pool)).toEqual([]);
  });
});
