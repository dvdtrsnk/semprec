import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModuleRegistry } from "@alldots/module-registry";
import { CORE_TASK_NAMES, runOnce } from "@alldots/queue";
import { runInTenant } from "@alldots/shared";
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
} from "@alldots/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import * as piSession from "../piAgentSession.js";

/** A call files a `moduleTool` approval request and changes nothing; the approved request runs the handler once. */

const calendarManifestHref = new URL(
  "../../../../packages/data/src/calendar/calendarModuleManifest.js",
  import.meta.url,
).href;
const REPLY_TASK = "calendarSendInvitationReply";

let admin: Pool;
let runtime: Pool;
let registry: ModuleRegistry;
let tenant: string;

interface Session {
  runId: string;
  userId: string;
  tools: AgentTool[];
  tasksId: string;
  eventsId: string;
}

/** A tenant with its system databases and a user; the project that owns the calendar databases. */
async function openSession(options: { inOtherProject?: boolean } = {}): Promise<Session> {
  return runInTenant(tenant, async () => {
    await seedSystem(runtime);
    const chokePoint = createChokePoint(runtime);
    const databases = await chokePoint.listDatabases();
    const database = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const calendarProject = database("calendars").ownerProjectItemId;
    if (!calendarProject) throw new Error("The calendars database has no owner project");
    const project = options.inOtherProject
      ? (await chokePoint.createItem({ databaseId: database("projects").id, properties: { name: "Other project" } })).id
      : calendarProject;
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    const threadId = await withTransaction(runtime, (client) => createSempChatThread(client));
    const run = await createAgentRun(runtime, {
      projectItemId: project,
      userId: user.id,
      threadId,
      triggeredBy: "user",
      task: "calendar",
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
    return { runId: run.id, userId: user.id, tools, tasksId: database("tasks").id, eventsId: database("events").id };
  });
}

function callTool(session: Session, name: string, toolCallId: string, args: Record<string, unknown>) {
  const tool = session.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not in the session`);
  return runInTenant(tenant, () => tool.execute(toolCallId, args));
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

function approve(session: Session, requestId: string) {
  return runInTenant(tenant, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: session.userId,
      }),
    ),
  );
}

async function drainApprovalJobs(): Promise<void> {
  const handler = createCoreTaskList(runtime, createActionRegistry(), undefined, undefined, undefined, registry)[
    CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE
  ];
  if (!handler) throw new Error("Missing approval handler");
  await runOnce({ pgPool: runtime, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });
}

/** The ids of the events the task sits in, from its `hostEvents` edges. */
async function hostEventIds(taskId: string): Promise<string[]> {
  const edges = await runInTenant(tenant, () => createChokePoint(runtime).listItemRelations(taskId));
  return (edges ?? []).filter((edge) => edge.propertyKey === "hostEvents").map((edge) => edge.targetItemId);
}

describe("calendar write tools in an agent session (issue gh-1957)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    registry = new ModuleRegistry(() => new Set(["calendar"]));
    await registry.loadModule(calendarManifestHref);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the three tools to a run whose project owns the calendar databases", async () => {
    const session = await openSession();
    expect(session.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "calendar_respondToInvitation",
        "calendar_placeTaskInEvent",
        "calendar_removeTaskFromEvent",
      ]),
    );
  });

  it("offers none of them to a run of another project, so a call cannot be named", async () => {
    const session = await openSession({ inOtherProject: true });
    expect(session.tools.map((tool) => tool.name).filter((name) => name.startsWith("calendar_"))).toEqual([]);
  });

  it("files a request for an answer to an invitation and answers nothing", async () => {
    const session = await openSession();
    const invitationId = randomUUID();

    const result = await callTool(session, "calendar_respondToInvitation", "call-1", {
      invitationId,
      response: "accepted",
    });

    const requests = await requestsOf(session);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolName: "calendar.respondToInvitation",
      status: "pending",
      riskClass: "outbound",
      payload: { moduleToolName: "calendar.respondToInvitation", args: { invitationId, response: "accepted" } },
    });
    expect(result.details).toEqual({ error: false, approvalRequestId: requests[0]?.id });
    const queued = await admin.query("SELECT 1 FROM graphile_worker.jobs WHERE task_identifier = $1", [REPLY_TASK]);
    expect(queued.rowCount).toBe(0);
  });

  it("files no request for arguments the tool does not accept", async () => {
    const session = await openSession();

    const result = await callTool(session, "calendar_respondToInvitation", "call-1", {
      invitationId: "not-a-uuid",
      response: "accepted",
    });

    expect(result.details).toEqual({ error: true });
    expect(await requestsOf(session)).toEqual([]);
  });

  it("files a request for a placement, changes nothing, and places the task once after approval", async () => {
    const session = await openSession();
    const chokePoint = createChokePoint(runtime);
    const [task, event] = await runInTenant(tenant, async () => [
      await chokePoint.createItem({ databaseId: session.tasksId, properties: { name: "Task" } }),
      await chokePoint.createItem({ databaseId: session.eventsId, properties: { name: "Event", date: "2026-10-16" } }),
    ]);
    if (!task || !event) throw new Error("Missing fixtures");

    await callTool(session, "calendar_placeTaskInEvent", "call-1", { taskId: task.id, eventId: event.id });

    const [request] = await requestsOf(session);
    if (!request) throw new Error("Request missing");
    expect(request).toMatchObject({ toolName: "calendar.placeTaskInEvent", status: "pending", riskClass: "write" });
    expect(await hostEventIds(task.id)).toEqual([]);

    await approve(session, request.id);
    await drainApprovalJobs();
    await drainApprovalJobs();

    expect(await hostEventIds(task.id)).toEqual([event.id]);
    expect((await requestsOf(session))[0]).toMatchObject({ executionStatus: "succeeded", executionError: false });
  });

  it("files a request for taking a task out of an event and removes it after approval", async () => {
    const session = await openSession();
    const chokePoint = createChokePoint(runtime);
    const [task, event] = await runInTenant(tenant, async () => [
      await chokePoint.createItem({ databaseId: session.tasksId, properties: { name: "Task" } }),
      await chokePoint.createItem({ databaseId: session.eventsId, properties: { name: "Event", date: "2026-10-16" } }),
    ]);
    if (!task || !event) throw new Error("Missing fixtures");
    // The task is placed through its own approved request first, so the removal has an edge to remove.
    await callTool(session, "calendar_placeTaskInEvent", "call-place", { taskId: task.id, eventId: event.id });
    const [placement] = await requestsOf(session);
    if (!placement) throw new Error("Request missing");
    await approve(session, placement.id);
    await drainApprovalJobs();
    expect(await hostEventIds(task.id)).toEqual([event.id]);

    await callTool(session, "calendar_removeTaskFromEvent", "call-remove", { taskId: task.id, eventId: event.id });
    const removal = (await requestsOf(session)).find((request) => request.toolName === "calendar.removeTaskFromEvent");
    if (!removal) throw new Error("Removal request missing");
    expect(removal.status).toBe("pending");
    expect(await hostEventIds(task.id)).toEqual([event.id]);

    await approve(session, removal.id);
    await drainApprovalJobs();

    expect(await hostEventIds(task.id)).toEqual([]);
  });
});
