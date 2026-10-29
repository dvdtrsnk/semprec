import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest, decideApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { listApprovalRequestsQueue, toApprovalRequestDecisionView } from "../mcp/approvalRequestsQueue.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";

let pool: Pool;
let chokePoint: ChokePoint;
let ownerId: string;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

describe("listApprovalRequestsQueue (issue #132)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    ownerId = await createUser();
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
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: created.id,
      toolName: "send_email",
      riskClass: "moderate",
      requestedAt: created.requestedAt,
      safeSummary: {
        kind: "mcpInvoke",
        mcpToolRegistrationId: payload.mcpToolRegistrationId,
        mcpServerItemId: payload.mcpServerItemId,
        mcpServerName: null,
        mcpToolName: null,
        argKeys: ["to", "apiKey"],
      },
      agentRunId: run.id,
      projectItemId: projectItem.id,
      projectName: "Renovate the kitchen",
      reason: null,
    });
  });

  it("surfaces the agent-supplied reason on the queue entry and on the decision view, null when absent", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const base = {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "moderate",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    };
    const withReason = await createPendingApprovalRequest(pool, { ...base, reason: "Customer asked for a quote" });
    const withoutReason = await createPendingApprovalRequest(pool, base);

    const rows = await listApprovalRequestsQueue(pool, ownerId);
    expect(rows.find((row) => row.id === withReason.id)!.reason).toBe("Customer asked for a quote");
    expect(rows.find((row) => row.id === withoutReason.id)!.reason).toBeNull();

    expect(toApprovalRequestDecisionView(withReason).reason).toBe("Customer asked for a quote");
    expect(toApprovalRequestDecisionView(withoutReason).reason).toBeNull();
  });

  it("summarizes a generic-operation-originated request with its operationName, never mcp fields (issue #220)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = {
      operationName: "item.delete",
      canonicalInput: { itemId: randomUUID() },
      actor: { runId: run.id, agentProjectItemId: randomUUID(), userId: run.actorUserId },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "item.delete",
      riskClass: "destructive",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.safeSummary).toEqual({
      kind: "genericOperation",
      operationName: "item.delete",
      argKeys: ["itemId"],
    });
  });

  describe("MCP server and tool names", () => {
    const resourceSnapshot = { kind: "test", resourceId: "test", sha256: null };

    async function seedMcpRequest(source: "user" | "heartbeat" | "supervisor" | "mcp") {
      await seedSystem(pool, createViewTypeRegistry());
      const database = await withTransaction(pool, (client) =>
        databasesStore.getDatabaseByModuleId(client, "mcpServers"),
      );
      if (!database) throw new Error("mcpServers database was not seeded");
      const server = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, { databaseId: database.id, properties: { name: "Search server" } }),
      );
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: server.id,
        toolName: "search_web",
        toolSchema: { type: "object" },
      });
      const run = await createAgentRun(pool, { triggeredBy: source, task: "test" });
      const created = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "search_web",
        riskClass: "moderate",
        payload: { mcpToolRegistrationId: registration.id, mcpServerItemId: server.id, args: { q: "x" } },
        resourceSnapshot,
      });
      return { database, server, created };
    }

    it("names the server and the tool in the listed summary, whatever the run's trigger", async () => {
      for (const source of ["user", "heartbeat", "supervisor", "mcp"] as const) {
        await resetDatabase(pool);
        ownerId = await createUser();
        await seedMcpRequest(source);
        const rows = await listApprovalRequestsQueue(pool, ownerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.safeSummary).toMatchObject({
          kind: "mcpInvoke",
          mcpServerName: "Search server",
          mcpToolName: "search_web",
          argKeys: ["q"],
        });
      }
    });

    it("names them in the decision view too", async () => {
      const { created } = await seedMcpRequest("user");
      const view = await toApprovalRequestDecisionView(pool, created);
      expect(view.safeSummary).toMatchObject({ mcpServerName: "Search server", mcpToolName: "search_web" });
    });

    it("yields a null server name, with the tool name kept, once the server item is deleted", async () => {
      const { database, server } = await seedMcpRequest("user");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, database.id, server.id));
      const rows = await listApprovalRequestsQueue(pool, ownerId);
      expect(rows[0]!.safeSummary).toMatchObject({ mcpServerName: null, mcpToolName: "search_web" });
    });

    it("yields a null tool name when the registration row is gone", async () => {
      await seedMcpRequest("user");
      // Raw delete: no store function removes a registration, and the read must survive one vanishing.
      await pool.query(`DELETE FROM mcp_tool_registrations`);
      const rows = await listApprovalRequestsQueue(pool, ownerId);
      expect(rows[0]!.safeSummary).toMatchObject({ mcpServerName: "Search server", mcpToolName: null });
    });
  });

  it("never includes argument values, only their keys", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const payload = {
      mcpToolRegistrationId: randomUUID(),
      mcpServerItemId: randomUUID(),
      args: { password: "hunter2" },
    };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "login",
      riskClass: "high",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId);

    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(rows[0]!.safeSummary.argKeys).toEqual(["password"]);
  });

  it("returns null project fields for a run with no project (e.g. the supervisor's own run)", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "test" });
    const payload = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };
    await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "noop",
      riskClass: "low",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });

    const rows = await listApprovalRequestsQueue(pool, ownerId);

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
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const second = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "second",
      riskClass: "low",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    const decided = await createPendingApprovalRequest(pool, {
      agentRunId: run.id,
      toolName: "third",
      riskClass: "low",
      payload,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    await decideApprovalRequest(pool, decided.id, "approved", ownerId);

    const rows = await listApprovalRequestsQueue(pool, ownerId);

    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("returns an empty array when there are no pending requests", async () => {
    expect(await listApprovalRequestsQueue(pool, ownerId)).toEqual([]);
  });
});
