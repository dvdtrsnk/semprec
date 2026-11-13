import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import {
  createActionRegistry,
  createAgentRun,
  createChokePoint,
  createCoreTaskList,
  createSempChatThread,
  createUser,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import * as piSession from "../piAgentSession.js";

const fixtureHref = new URL(
  "../../../../packages/module-registry/src/__tests__/fixtures/approvalGatedToolsModule.js",
  import.meta.url,
).href;

let admin: Pool;
let runtime: Pool;
let registry: ModuleRegistry;
let tenant: string;

interface Session {
  runId: string;
  userId: string;
  threadId: string;
  tools: AgentTool[];
}

/** A run of a project in `tenant` with a chat thread titled `T`, and the tools its composed session offers. */
async function openSession(): Promise<Session> {
  return runInTenant(tenant, async () => {
    await seedSystem(runtime);
    const chokePoint = createChokePoint(runtime);
    const projects = (await chokePoint.listDatabases()).find((database) => database.key === "projects");
    if (!projects) throw new Error("Projects database missing");
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: { name: "Owner" } });
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    const threadId = await withTransaction(runtime, (client) => createSempChatThread(client));
    // Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway.
    // The fixture module uses the title as the source its tools change and snapshot.
    await runtime.query("UPDATE semp_threads SET title = 'T' WHERE id = $1", [threadId]);
    const run = await createAgentRun(runtime, {
      projectItemId: project.id,
      userId: user.id,
      threadId,
      triggeredBy: "user",
      task: "gated",
    });
    let tools: AgentTool[] = [];
    const spy = vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((options) => {
      tools = options.tools;
      return () => ({ async *messages() {} });
    });
    try {
      const faux = fauxProvider();
      await createAgentSessionFactoryForRun(
        runtime,
        registry,
        {
          model: faux.getModel(),
          streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
    } finally {
      spy.mockRestore();
    }
    return { runId: run.id, userId: user.id, threadId, tools };
  });
}

/** Calls a tool of the session as the agent runtime does, inside the tenant of the run. */
function callTool(session: Session, name: string, toolCallId: string, args: Record<string, unknown>) {
  const tool = session.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not in the session`);
  return runInTenant(tenant, () => tool.execute(toolCallId, args));
}

async function titleOf(session: Session): Promise<string | null> {
  const { rows } = await admin.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [
    session.threadId,
  ]);
  return rows[0]?.title ?? null;
}

async function requestsOf(session: Session): Promise<ApprovalRequest[]> {
  const { rows } = await admin.query<{ id: string }>("SELECT id FROM approval_requests WHERE agent_run_id = $1", [
    session.runId,
  ]);
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const requests: ApprovalRequest[] = [];
      for (const row of rows) {
        const request = await getApprovalRequest(client, row.id);
        if (request) requests.push(request);
      }
      return requests;
    }),
  );
}

function decide(session: Session, requestId: string, decision: "approved" | "rejected") {
  return runInTenant(tenant, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision,
        decidedByUserId: session.userId,
      }),
    ),
  );
}

/** Runs the worker's `approvalExecute` handler once over the jobs that are due. */
async function drainApprovalJobs(): Promise<void> {
  const handler = createCoreTaskList(
    runtime,
    createActionRegistry(),
    undefined,
    undefined,
    undefined,
    undefined,
    registry,
  )[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE];
  if (!handler) throw new Error("Missing approval handler");
  await runOnce({ pgPool: runtime, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });
}

describe("approval-gated module tools in an agent session (issue #1791)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    registry = new ModuleRegistry(() => new Set(["gatedTools"]));
    await registry.loadModule(fixtureHref);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the gated tools beside the tool that runs at once", async () => {
    const session = await openSession();
    expect(session.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["gated_apply", "gated_noSnapshot", "gated_noneApproval", "gated_free"]),
    );
    expect(session.tools.map((tool) => tool.name)).not.toContain("gated_always");
  });

  it("runs a tool that does not require approval at once and creates no request", async () => {
    const session = await openSession();

    const result = await callTool(session, "gated_free", "call-free", { value: "x" });

    expect(result.details).toEqual({ error: false });
    expect(await titleOf(session)).toBe("T+x");
    expect(await requestsOf(session)).toEqual([]);
  });

  it("creates a moduleTool request and runs nothing when the agent calls a tool with requiresApproval", async () => {
    const session = await openSession();

    const result = await callTool(session, "gated_apply", "call-1", { value: "x" });

    const requests = await requestsOf(session);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolName: "gated.apply",
      status: "pending",
      toolCallId: "call-1",
      payload: { moduleToolName: "gated.apply", args: { value: "x" } },
      description: { key: "approval.moduleTool", params: { toolName: "gated.apply" } },
    });
    expect(result.details).toEqual({ error: false, approvalRequestId: requests[0]?.id });
    expect(JSON.stringify(result.content)).toContain("requires human approval");
    expect(await titleOf(session)).toBe("T");
  });

  it("runs the handler exactly once after approval, also when execution is delivered twice", async () => {
    const session = await openSession();
    await callTool(session, "gated_apply", "call-1", { value: "x" });
    const [request] = await requestsOf(session);
    if (!request) throw new Error("Request missing");
    await decide(session, request.id, "approved");

    await drainApprovalJobs();
    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        enqueueJob(
          client,
          CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
          { approvalRequestId: request.id },
          { jobKey: `redelivery-${request.id}` },
        ),
      ),
    );
    await drainApprovalJobs();

    expect(await titleOf(session)).toBe("T+x");
    expect((await requestsOf(session))[0]).toMatchObject({
      executionStatus: "succeeded",
      executionResult: "applied x",
    });
  });

  it("records a conflict and does not run the handler when the source changed before approval", async () => {
    const session = await openSession();
    await callTool(session, "gated_apply", "call-1", { value: "x" });
    const [request] = await requestsOf(session);
    if (!request) throw new Error("Request missing");
    // Raw SQL: models the user editing the source after the agent asked.
    await admin.query("UPDATE semp_threads SET title = 'edited' WHERE id = $1", [session.threadId]);
    await decide(session, request.id, "approved");

    await drainApprovalJobs();

    expect(await titleOf(session)).toBe("edited");
    expect((await requestsOf(session))[0]).toMatchObject({ executionStatus: "conflict", executionError: true });
  });

  it("never runs the handler for a rejected request", async () => {
    const session = await openSession();
    await callTool(session, "gated_apply", "call-1", { value: "x" });
    const [request] = await requestsOf(session);
    if (!request) throw new Error("Request missing");
    await decide(session, request.id, "rejected");

    await drainApprovalJobs();

    expect(await titleOf(session)).toBe("T");
    expect((await requestsOf(session))[0]).toMatchObject({ status: "rejected", executionStatus: "not_approved" });
  });

  it("answers a repeated tool call id with the same request", async () => {
    const session = await openSession();

    const first = await callTool(session, "gated_apply", "call-1", { value: "x" });
    const repeated = await callTool(session, "gated_apply", "call-1", { value: "x" });

    expect(repeated.details).toEqual(first.details);
    expect(await requestsOf(session)).toHaveLength(1);
  });
});
