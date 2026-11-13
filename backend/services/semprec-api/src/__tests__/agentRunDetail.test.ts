import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getOrCreateTickThread,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createPendingApprovalRequest,
  createSempChatThread,
  createUser,
  createViewTypeRegistry,
  finishAgentRun,
  getAgentRun,
  getAgentRunDetail,
  claimSempMessage,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  sendSempMessage,
  setAgentRunMcpClientName,
  startSempMessageTurn,
  withTransaction,
  type AgentRunRow,
  type SempReplyStep,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "agent-run-detail-password";

/**
 * A copy of `agentRunSchema` of `web/src/api/agentRunOperations.ts`, the schema the web client parses
 * this route's response with. The backend cannot import the web package, so the contract test below
 * parses with this copy; it has to follow the web schema when that changes.
 */
const webAgentRunSchema = z.object({
  id: z.string(),
  projectItemId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  heartbeatId: z.string().nullable(),
  triggeredBy: z.enum(["user", "heartbeat", "supervisor", "mcp"]),
  unit: z.enum(["invocation", "session"]),
  task: z.string(),
  status: z.enum(["running", "done", "error"]),
  result: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

/**
 * The fields issues #1805 and #1820 add, and the two instants of the run's row (`startedAt`, `finishedAt`) that
 * `durationMs` is checked against, as this test reads them from a response.
 */
const addedFieldsSchema = z.object({
  displayStatus: z.enum(["running", "done", "waiting_approval", "error"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  title: z.string(),
  projectName: z.string().nullable(),
  heartbeatName: z.string().nullable(),
  durationMs: z.number().nullable(),
  trigger: z.object({
    kind: z.string(),
    threadId: z.string().nullable(),
    mcpClientName: z.string().nullable(),
  }),
  approvals: z.object({
    count: z.number(),
    pending: z.number(),
    approved: z.number(),
    rejected: z.number(),
    requestIds: z.array(z.string()),
  }),
});

interface Session {
  tenant: string;
  userId: string;
  headers: { Authorization: string };
}

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

/** A tenant with its user, a seeded system and that user's bearer header. */
async function tenantSession(): Promise<Session> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  return { tenant, userId: user.id, headers: { Authorization: `Bearer ${session.token}` } };
}

/** A Projects item of the tenant with the given name. */
function createProject(session: Session, name: string): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!projects) throw new Error("The Projects database is missing");
    const project = await createChokePoint(pool).createItem({ databaseId: projects.id, properties: { name } });
    return project.id;
  });
}

/** A heartbeat of the project and its tick thread. */
function createHeartbeatWithThread(
  session: Session,
  projectItemId: string,
  name: string,
): Promise<{ heartbeatId: string; tickThreadId: string }> {
  return runInTenant(session.tenant, () =>
    withTransaction(pool, async (client) => {
      const heartbeat = await createHeartbeat(client, {
        projectItemId,
        name,
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "Plan the week" },
      });
      const tick = await getOrCreateTickThread(client, heartbeat.id);
      return { heartbeatId: heartbeat.id, tickThreadId: tick.id };
    }),
  );
}

function createRun(session: Session, input: Parameters<typeof createAgentRun>[1]): Promise<AgentRunRow> {
  return runInTenant(session.tenant, () => createAgentRun(pool, { userId: session.userId, ...input }));
}

const STORED_STEP_TIMES = { startedAt: "2026-11-01T10:00:00.000Z", durationMs: 5 };

/** A stored tool step of an MCP call that failed with `failureKind`, as the projector of issue #1860 writes it. */
function failedMcpStep(failureKind: string, extra: Partial<SempReplyStep> = {}): SempReplyStep {
  return {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "mcp_search_aaaaaaaa",
    label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
    detail: { key: "agentStep.summary.failed", params: {} },
    status: "error",
    errorCode: failureKind,
    connectorName: "GitHub",
    ...STORED_STEP_TIMES,
    ...extra,
  };
}

/**
 * Gives `run` (still running) the single reply of its thread, finished as `done` with `steps` stored on it the
 * way the turn handler stores them, and then closes the run as done.
 */
async function finishRunWithReply(session: Session, run: AgentRunRow, steps: SempReplyStep[]): Promise<void> {
  const threadId = run.threadId;
  if (threadId === null) throw new Error("The run has no thread");
  await runInTenant(session.tenant, async () => {
    const event = await insertAgentRunEvent(pool, run.id, "user_message", {
      kind: "user_message",
      text: "tick",
      context: [],
    });
    await withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, { threadId, text: "tick", context: [], hasContext: false });
      await claimSempMessage(client, threadId, sent.assistantMessageId);
      await startSempMessageTurn(client, sent.assistantMessageId, run.id, event.id);
      const stored = await finishSempMessageTurn(client, sent.assistantMessageId, {
        status: "done",
        text: "The answer.",
        lastEventId: event.id,
        summary: { steps, durationMs: null, tokens: { input: 0, output: 0 }, changes: [] },
      });
      expect(stored).toBe(true);
    });
    await finishAgentRun(pool, run.id, "done", "finished");
  });
}

function finishRun(session: Session, runId: string): Promise<boolean> {
  return runInTenant(session.tenant, () => finishAgentRun(pool, runId, "done", "finished"));
}

async function readDetail(session: Session, runId: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/agent-runs/${runId}`, { headers: session.headers });
  return { status: res.status, body: await res.json() };
}

/** The added fields of a 200 answer, with the row's two instants (see `addedFieldsSchema`). */
async function readAddedFields(session: Session, runId: string): Promise<z.infer<typeof addedFieldsSchema>> {
  const answer = await readDetail(session, runId);
  expect(answer.status).toBe(200);
  return addedFieldsSchema.parse(answer.body);
}

function createRequest(session: Session, agentRunId: string): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const request = await createPendingApprovalRequest(pool, {
      agentRunId,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return request.id;
  });
}

async function decide(session: Session, requestId: string, decision: "approved" | "rejected"): Promise<void> {
  const res = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
    method: "PATCH",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  expect(res.status).toBe(200);
}

describe("GET /api/agent-runs/:id detail fields (issue #1805)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-agent-run-detail-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });

  it("returns a finished chat run with its task as title, the project name, the user trigger, its thread and a duration", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const threadId = await runInTenant(owner.tenant, () => withTransaction(pool, createSempChatThread));
    const run = await createRun(owner, { projectItemId, threadId, triggeredBy: "user", task: "Summarize the inbox" });
    await finishRun(owner, run.id);

    const fields = await readAddedFields(owner, run.id);

    expect(fields).toMatchObject({
      title: "Summarize the inbox",
      projectName: "Weekly review",
      heartbeatName: null,
      trigger: { kind: "user", threadId, mcpClientName: null },
      approvals: { count: 0, pending: 0, approved: 0, rejected: 0, requestIds: [] },
    });
    if (fields.finishedAt === null) throw new Error("The run is not finished");
    expect(fields.durationMs).toBe(Date.parse(fields.finishedAt) - Date.parse(fields.startedAt));
    expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps every field of the run's row and still parses with the web client's schema", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const run = await createRun(owner, { projectItemId, triggeredBy: "user", task: "Summarize the inbox" });
    await finishRun(owner, run.id);
    const row = await runInTenant(owner.tenant, () => getAgentRun(pool, run.id));
    if (!row) throw new Error("The run is missing");
    const rowAsJson: unknown = JSON.parse(JSON.stringify(row));

    const answer = await readDetail(owner, run.id);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject(z.record(z.string(), z.unknown()).parse(rowAsJson));
    expect(webAgentRunSchema.parse(answer.body)).toEqual({
      id: row.id,
      projectItemId,
      parentRunId: null,
      heartbeatId: null,
      triggeredBy: "user",
      unit: "invocation",
      task: "Summarize the inbox",
      status: "done",
      result: "finished",
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  });

  it("returns a heartbeat run with the heartbeat's name as title, the tick trigger and the tick thread", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });

    const fields = await readAddedFields(owner, run.id);

    expect(fields).toMatchObject({
      title: "Sunday planning",
      heartbeatName: "Sunday planning",
      projectName: "Weekly review",
      trigger: { kind: "tick", threadId: tickThreadId, mcpClientName: null },
    });
  });

  it("reports a user's follow-up turn in a tick thread as a tick, and a delegated run there as its supervisor's", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const heartbeatRun = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    const followUp = await createRun(owner, {
      projectItemId,
      threadId: tickThreadId,
      triggeredBy: "user",
      unit: "session",
      task: "And the week after?",
    });
    const delegated = await createRun(owner, {
      projectItemId,
      parentRunId: heartbeatRun.id,
      triggeredBy: "supervisor",
      task: "Collect the open tasks",
    });

    const followUpFields = await readAddedFields(owner, followUp.id);
    const delegatedFields = await readAddedFields(owner, delegated.id);

    expect(followUpFields).toMatchObject({
      title: "And the week after?",
      heartbeatName: null,
      trigger: { kind: "tick", threadId: tickThreadId, mcpClientName: null },
    });
    expect(delegatedFields).toMatchObject({
      title: "Collect the open tasks",
      heartbeatName: null,
      trigger: { kind: "supervisor", threadId: tickThreadId, mcpClientName: null },
    });
  });

  it("returns an MCP run without a thread or duration, and its client name once the handshake recorded it", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const minted = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
      method: "POST",
      headers: { ...owner.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ projectItemId, capabilities: ["core.item.read"], task: "External client" }),
    });
    expect(minted.status).toBe(201);
    const { runId, token } = z.object({ runId: z.string(), token: z.string() }).parse(await minted.json());

    const before = await readAddedFields(owner, runId);
    const handshake = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Claude Desktop" } },
      }),
    });
    expect(handshake.status).toBe(200);
    await finishRun(owner, runId);
    const after = await readAddedFields(owner, runId);

    expect(before.trigger).toEqual({ kind: "mcp", threadId: null, mcpClientName: null });
    expect(after.trigger).toEqual({ kind: "mcp", threadId: null, mcpClientName: "Claude Desktop" });
    expect(after.finishedAt).not.toBeNull();
    expect(after.durationMs).toBeNull();
    expect(after.title).toBe("External client");
  });

  it("returns no client name for a run that no MCP client started, even when one is stored on it", async () => {
    const owner = await tenantSession();
    const run = await createRun(owner, { triggeredBy: "user", task: "Summarize the inbox" });
    await runInTenant(owner.tenant, () => setAgentRunMcpClientName(pool, run.id, "Claude Desktop"));

    const fields = await readAddedFields(owner, run.id);

    expect(fields.trigger).toEqual({ kind: "user", threadId: null, mcpClientName: null });
  });

  it("returns no duration for a finished session run and for an invocation run that is still running", async () => {
    const owner = await tenantSession();
    const session = await createRun(owner, { triggeredBy: "user", unit: "session", task: "A conversation" });
    await finishRun(owner, session.id);
    const running = await createRun(owner, { triggeredBy: "user", task: "Still working" });

    const sessionFields = await readAddedFields(owner, session.id);
    const runningFields = await readAddedFields(owner, running.id);

    expect(sessionFields.finishedAt).not.toBeNull();
    expect(sessionFields.durationMs).toBeNull();
    expect(runningFields.finishedAt).toBeNull();
    expect(runningFields.durationMs).toBeNull();
  });

  it("returns no project name for a run without a project, a project without a name and a project in the Trash", async () => {
    const owner = await tenantSession();
    const unnamedProjectId = await runInTenant(owner.tenant, () => createTestProjectItem(pool));
    const trashedProjectId = await createProject(owner, "Abandoned");
    const trashed = await fetch(`${baseUrl}/api/items/${trashedProjectId}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    expect(trashed.status).toBeLessThan(300);
    const withoutProject = await createRun(owner, { triggeredBy: "user", task: "No project" });
    const unnamed = await createRun(owner, { projectItemId: unnamedProjectId, triggeredBy: "user", task: "Unnamed" });
    const inTrash = await createRun(owner, { projectItemId: trashedProjectId, triggeredBy: "user", task: "Trashed" });

    expect((await readAddedFields(owner, withoutProject.id)).projectName).toBeNull();
    expect((await readAddedFields(owner, unnamed.id)).projectName).toBeNull();
    expect((await readAddedFields(owner, inTrash.id)).projectName).toBeNull();
  });

  it("counts the run's approval requests per status and lists their ids from the oldest", async () => {
    const owner = await tenantSession();
    const run = await createRun(owner, { triggeredBy: "user", task: "Needs approvals" });
    const otherRun = await createRun(owner, { triggeredBy: "user", task: "Another run" });
    const approved = await createRequest(owner, run.id);
    const pending = await createRequest(owner, run.id);
    const rejected = await createRequest(owner, run.id);
    const ofOtherRun = await createRequest(owner, otherRun.id);
    await decide(owner, approved, "approved");
    await decide(owner, rejected, "rejected");

    const fields = await readAddedFields(owner, run.id);
    const otherFields = await readAddedFields(owner, otherRun.id);

    expect(fields.approvals).toEqual({
      count: 3,
      pending: 1,
      approved: 1,
      rejected: 1,
      requestIds: [approved, pending, rejected],
    });
    expect(otherFields.approvals).toEqual({ count: 1, pending: 1, approved: 0, rejected: 0, requestIds: [ofOtherRun] });
  });

  it("shows a finished tick run with one pending request as waiting_approval and as done once the request is approved", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    const requestId = await createRequest(owner, run.id);
    await finishRun(owner, run.id);

    const waiting = await readAddedFields(owner, run.id);
    await decide(owner, requestId, "approved");
    const decided = await readAddedFields(owner, run.id);

    expect(waiting.displayStatus).toBe("waiting_approval");
    expect(waiting.approvals).toMatchObject({ count: 1, pending: 1, approved: 0 });
    expect(decided.displayStatus).toBe("done");
    expect(decided.approvals).toMatchObject({ count: 1, pending: 0, approved: 1 });
  });

  it("shows a finished run as done once its only request is rejected", async () => {
    const owner = await tenantSession();
    const run = await createRun(owner, { triggeredBy: "user", task: "Needs a decision" });
    const requestId = await createRequest(owner, run.id);
    await finishRun(owner, run.id);

    await decide(owner, requestId, "rejected");
    const fields = await readAddedFields(owner, run.id);

    expect(fields.displayStatus).toBe("done");
    expect(fields.approvals).toMatchObject({ pending: 0, rejected: 1 });
  });

  it("shows a running run with nothing pending as running, and a failed run with a pending request as error", async () => {
    const owner = await tenantSession();
    const running = await createRun(owner, { triggeredBy: "user", task: "Still working" });
    const failed = await createRun(owner, { triggeredBy: "user", task: "Went wrong" });
    await createRequest(owner, failed.id);
    await runInTenant(owner.tenant, () => finishAgentRun(pool, failed.id, "error", "internal"));

    const runningFields = await readAddedFields(owner, running.id);
    const failedFields = await readAddedFields(owner, failed.id);
    const failedAnswer = await readDetail(owner, failed.id);

    expect(runningFields.displayStatus).toBe("running");
    expect(failedFields.displayStatus).toBe("error");
    expect(failedFields.approvals.pending).toBe(1);
    expect(failedAnswer.body).toMatchObject({ status: "error", displayStatus: "error" });
  });

  it("runs the same number of statements for a run with one approval request and a run with six", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const input = { projectItemId, heartbeatId, threadId: tickThreadId, triggeredBy: "heartbeat", task: "t" } as const;
    const one = await createRun(owner, input);
    const six = await createRun(owner, input);
    await createRequest(owner, one.id);
    for (let index = 0; index < 6; index += 1) await createRequest(owner, six.id);
    // A pool of its own, so the spy never sits on a pool another test uses.
    const counted = await createRuntimeRolePool(admin, "semprec_data");
    try {
      const query = vi.spyOn(counted, "query");
      const detailOfOne = await runInTenant(owner.tenant, () => getAgentRunDetail(counted, one));
      const statementsForOne = query.mock.calls.length;
      const detailOfSix = await runInTenant(owner.tenant, () => getAgentRunDetail(counted, six));
      const statementsForSix = query.mock.calls.length - statementsForOne;
      query.mockRestore();

      expect(detailOfOne.approvals.count).toBe(1);
      expect(detailOfSix.approvals.count).toBe(6);
      expect(statementsForOne).toBe(4);
      expect(statementsForSix).toBe(statementsForOne);
    } finally {
      await counted.end();
    }
  });

  it("shows a finished tick run whose server was unavailable as error, with a summary naming the server", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    await finishRunWithReply(owner, run, [failedMcpStep("unavailable")]);

    const answer = await readDetail(owner, run.id);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "done",
      displayStatus: "error",
      errorCode: null,
      // The default locale of a user is Czech.
      errorSummary: "GitHub není dostupný",
    });
  });

  it("gives the seconds of the stored timeout in the summary of a tick run whose call timed out", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    await finishRunWithReply(owner, run, [failedMcpStep("timeout", { timeoutMs: 15000 })]);

    const answer = await readDetail(owner, run.id);

    expect(answer.body).toMatchObject({
      displayStatus: "error",
      errorCode: null,
      errorSummary: "spojení vypršelo (15 s)",
    });
  });

  it("keeps a finished tick run whose failed call was retried successfully as done, without an error summary", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    const registration = randomUUID();
    const retried: SempReplyStep = {
      kind: "tool",
      toolCallId: "call-2",
      toolName: "mcp_search_aaaaaaaa",
      label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
      detail: { key: "agentStep.summary.done", params: {} },
      status: "ok",
      mcpToolRegistrationId: registration,
      ...STORED_STEP_TIMES,
    };
    await finishRunWithReply(owner, run, [
      failedMcpStep("timeout", { mcpToolRegistrationId: registration, timeoutMs: 60000 }),
      retried,
    ]);

    const answer = await readDetail(owner, run.id);

    expect(answer.body).toMatchObject({ displayStatus: "done", errorCode: null, errorSummary: null });
  });

  it("keeps waiting_approval and gives no error summary to a finished tick run with a pending request and an incomplete reply", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const run = await createRun(owner, {
      projectItemId,
      heartbeatId,
      threadId: tickThreadId,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    });
    await finishRunWithReply(owner, run, [failedMcpStep("unavailable")]);
    const requestId = await createRequest(owner, run.id);

    const waiting = await readDetail(owner, run.id);
    await decide(owner, requestId, "approved");
    const decided = await readDetail(owner, run.id);

    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({
      status: "done",
      displayStatus: "waiting_approval",
      errorCode: null,
      errorSummary: null,
    });
    // Once nothing waits any more, the incomplete reply reads as the error it is.
    expect(decided.body).toMatchObject({
      displayStatus: "error",
      errorCode: null,
      errorSummary: "GitHub není dostupný",
    });
  });

  it("runs one statement more for a finished run to read its reply, whatever the number of its approval requests", async () => {
    const owner = await tenantSession();
    const projectItemId = await createProject(owner, "Weekly review");
    const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(owner, projectItemId, "Sunday planning");
    const input = { projectItemId, heartbeatId, threadId: tickThreadId, triggeredBy: "heartbeat", task: "t" } as const;
    const one = await createRun(owner, input);
    const six = await createRun(owner, input);
    await createRequest(owner, one.id);
    for (let index = 0; index < 6; index += 1) await createRequest(owner, six.id);
    await runInTenant(owner.tenant, async () => {
      await finishAgentRun(pool, one.id, "done", "finished");
      await finishAgentRun(pool, six.id, "done", "finished");
    });
    const finishedOne = await runInTenant(owner.tenant, () => getAgentRun(pool, one.id));
    const finishedSix = await runInTenant(owner.tenant, () => getAgentRun(pool, six.id));
    if (!finishedOne || !finishedSix) throw new Error("The runs are missing");
    const counted = await createRuntimeRolePool(admin, "semprec_data");
    try {
      const query = vi.spyOn(counted, "query");
      await runInTenant(owner.tenant, () => getAgentRunDetail(counted, finishedOne));
      const statementsForOne = query.mock.calls.length;
      await runInTenant(owner.tenant, () => getAgentRunDetail(counted, finishedSix));
      const statementsForSix = query.mock.calls.length - statementsForOne;
      query.mockRestore();

      expect(statementsForOne).toBe(5);
      expect(statementsForSix).toBe(statementsForOne);
    } finally {
      await counted.end();
    }
  });

  it("answers another tenant's run exactly like an unknown id, and the owner's own request with the run", async () => {
    const owner = await tenantSession();
    const other = await tenantSession();
    const run = await createRun(owner, { triggeredBy: "user", task: "Private to its tenant" });

    const foreign = await readDetail(other, run.id);
    const unknown = await readDetail(other, randomUUID());
    const own = await readDetail(owner, run.id);

    expect(foreign).toEqual({ status: 404, body: { error: "Not found" } });
    expect(unknown).toEqual(foreign);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: run.id, title: "Private to its tenant" });
  });
});
