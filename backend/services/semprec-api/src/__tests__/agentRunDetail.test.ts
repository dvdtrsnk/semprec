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
  finishTickRunWithMessage,
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
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  postApprovalOutcomeMessage,
  seedSystem,
  sendSempMessage,
  setAgentRunMcpClientName,
  startSempMessageTurn,
  updateUserLocale,
  withTransaction,
  type AgentRunRow,
  type SempReplyStep,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import {
  CLOCK_START,
  createApproval,
  createChatRun,
  playQueuedAssistant,
  playReply,
  queueAssistantMessage,
  settleCall,
  type ChatRun,
  type ReplySetup,
} from "./agentRunReplyFixtures.js";

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

/** The fields the reply-scoped detail of issue #1889 changes, as this test reads them from a response. */
const replyDetailSchema = z.object({
  id: z.string(),
  displayStatus: z.enum(["running", "done", "waiting_approval", "error"]),
  startedAt: z.string(),
  title: z.string(),
  durationMs: z.number().nullable(),
  approvals: z.object({
    count: z.number(),
    pending: z.number(),
    approved: z.number(),
    rejected: z.number(),
    requestIds: z.array(z.string()),
  }),
  usage: z.object({
    totalCostUsd: z.number(),
    estimated: z.boolean(),
    perModel: z.array(
      z.object({ callCount: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
    ),
  }),
});

type ReplyDetail = z.infer<typeof replyDetailSchema>;

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

  describe("with ?messageId= (issue #1889)", () => {
    const NOT_FOUND = { status: 404, body: { error: "Not found" } };

    const replySetup = (session: Session): ReplySetup => ({
      admin,
      pool,
      tenant: session.tenant,
      userId: session.userId,
    });

    async function readScoped(session: Session, runId: string, messageId: string): Promise<ReplyDetail> {
      const res = await fetch(`${baseUrl}/api/agent-runs/${runId}?messageId=${messageId}`, {
        headers: session.headers,
      });
      const body: unknown = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return replyDetailSchema.parse(body);
    }

    async function readScopedRaw(
      session: Session,
      runId: string,
      query: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(`${baseUrl}/api/agent-runs/${runId}${query}`, { headers: session.headers });
      return { status: res.status, body: await res.json() };
    }

    /**
     * A chat run with two replies. Reply A has one tool call with a pending approval request and one model call;
     * reply B has two tool calls, each with a pending request, and two model calls.
     */
    async function twoReplies(session: Session) {
      const setup = replySetup(session);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, {
        userText: "Plan my week",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
      });
      const b = await playReply(setup, chat, {
        userText: "Summarise the inbox",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b1" }, { toolCallId: "call-b2" }],
      });
      const requestA = await createApproval(setup, chat.runId, "call-a");
      const requestB1 = await createApproval(setup, chat.runId, "call-b1");
      const requestB2 = await createApproval(setup, chat.runId, "call-b2");
      await settleCall(setup, chat.runId, a.assistantMessageId, { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
      await settleCall(setup, chat.runId, b.assistantMessageId, { inputTokens: 200, outputTokens: 20, costUsd: 0.02 });
      await settleCall(setup, chat.runId, b.assistantMessageId, { inputTokens: 300, outputTokens: 30, costUsd: 0.03 });
      return { setup, chat, a, b, requestA, requestB1, requestB2 };
    }

    it("describes only the first reply of a chat run: its title, start, duration, approvals and usage", async () => {
      const owner = await tenantSession();
      const { chat, a, requestA, requestB1, requestB2 } = await twoReplies(owner);

      const detail = await readScoped(owner, chat.runId, a.assistantMessageId);

      expect(detail).toEqual({
        id: chat.runId,
        displayStatus: "waiting_approval",
        title: "Plan my week",
        startedAt: new Date(CLOCK_START).toISOString(),
        durationMs: 400,
        approvals: { count: 1, pending: 1, approved: 0, rejected: 0, requestIds: [requestA] },
        usage: {
          totalCostUsd: 0.01,
          estimated: false,
          perModel: [{ callCount: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.01 }],
        },
      });
      expect(detail.approvals.requestIds).not.toContain(requestB1);
      expect(detail.approvals.requestIds).not.toContain(requestB2);
    });

    it("describes only the second reply of the same run with its own values", async () => {
      const owner = await tenantSession();
      const { chat, b, requestA, requestB1, requestB2 } = await twoReplies(owner);

      const detail = await readScoped(owner, chat.runId, b.assistantMessageId);

      expect(detail).toEqual({
        id: chat.runId,
        displayStatus: "waiting_approval",
        title: "Summarise the inbox",
        startedAt: new Date(CLOCK_START + 10_000).toISOString(),
        durationMs: 600,
        approvals: { count: 2, pending: 2, approved: 0, rejected: 0, requestIds: [requestB1, requestB2] },
        usage: {
          totalCostUsd: 0.05,
          estimated: false,
          perModel: [{ callCount: 2, inputTokens: 500, outputTokens: 50, costUsd: 0.05 }],
        },
      });
      expect(detail.approvals.requestIds).not.toContain(requestA);
    });

    it("keeps every field of the run's row beside the scoped ones", async () => {
      const owner = await tenantSession();
      const { chat, a } = await twoReplies(owner);
      const row = await runInTenant(owner.tenant, () => getAgentRun(pool, chat.runId));
      if (!row) throw new Error("The run is missing");

      const answer = await readScopedRaw(owner, chat.runId, `?messageId=${a.assistantMessageId}`);

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        id: row.id,
        triggeredBy: "user",
        unit: "session",
        task: "Chat",
        status: "running",
        finishedAt: null,
        trigger: { kind: "user", threadId: chat.threadId, mcpClientName: null },
      });
    });

    it("answers the whole run without a messageId: every approval, every call, the run's title and no duration", async () => {
      const owner = await tenantSession();
      const { chat, requestA, requestB1, requestB2 } = await twoReplies(owner);

      const whole = replyDetailSchema.parse((await readDetail(owner, chat.runId)).body);

      expect(whole.title).toBe("Chat");
      expect(whole.durationMs).toBeNull();
      expect(whole.approvals).toEqual({
        count: 3,
        pending: 3,
        approved: 0,
        rejected: 0,
        requestIds: [requestA, requestB1, requestB2],
      });
      expect(whole.usage).toEqual({
        totalCostUsd: 0.06,
        estimated: false,
        perModel: [{ callCount: 3, inputTokens: 600, outputTokens: 60, costUsd: 0.06 }],
      });
    });

    it("does not show a reply as waiting_approval for a pending request of another reply of the run", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      const b = await playReply(setup, chat, {
        userText: "Second",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b" }],
      });
      await createApproval(setup, chat.runId, "call-b");

      expect((await readScoped(owner, chat.runId, a.assistantMessageId)).displayStatus).toBe("done");
      expect((await readScoped(owner, chat.runId, b.assistantMessageId)).displayStatus).toBe("waiting_approval");
    });

    it("counts the approvals of a reply that is still running through its events, as none is stored on it yet", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      const b = await playReply(setup, chat, {
        userText: "Second",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b" }],
        end: "running",
      });
      await createApproval(setup, chat.runId, "call-a");
      const requestB = await createApproval(setup, chat.runId, "call-b");

      const running = await readScoped(owner, chat.runId, b.assistantMessageId);
      const first = await readScoped(owner, chat.runId, a.assistantMessageId);

      expect(running.approvals).toMatchObject({ count: 1, requestIds: [requestB] });
      expect(running.durationMs).toBeNull();
      expect(first.approvals.count).toBe(1);
      expect(first.approvals.requestIds).not.toContain(requestB);
    });

    it("leaves a request without a tool call id out of every reply, while the whole run counts it", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      await createApproval(setup, chat.runId, null);

      const scoped = await readScoped(owner, chat.runId, a.assistantMessageId);
      const whole = replyDetailSchema.parse((await readDetail(owner, chat.runId)).body);

      expect(scoped.approvals.count).toBe(0);
      expect(whole.approvals.count).toBe(1);
    });

    it("shows a reply that failed as error, even while it has a pending request", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const failed = await playReply(setup, chat, {
        userText: "First",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
        end: "error",
      });
      await createApproval(setup, chat.runId, "call-a");

      const detail = await readScoped(owner, chat.runId, failed.assistantMessageId);

      expect(detail.displayStatus).toBe("error");
      expect(detail.approvals.pending).toBe(1);
    });

    it("shows a finished reply with a failed tool call as error", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const reply = await playReply(setup, chat, {
        userText: "First",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a", fails: true }],
      });

      expect((await readScoped(owner, chat.runId, reply.assistantMessageId)).displayStatus).toBe("error");
    });

    it("shows a reply that is still running as running", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const reply = await playReply(setup, chat, { userText: "First", startMs: 0, end: "running" });

      expect((await readScoped(owner, chat.runId, reply.assistantMessageId)).displayStatus).toBe("running");
    });

    it("shows a retried reply as its latest attempt, whichever attempt the request names", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const first = await playReply(setup, chat, {
        userText: "Plan my week",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-1", fails: true }],
        end: "error",
      });
      const attemptId = await queueAssistantMessage(setup, chat, first.userMessageId);
      const second = await playQueuedAssistant(setup, chat, attemptId, {
        userMessageId: first.userMessageId,
        startMs: 5_000,
        toolCalls: [{ toolCallId: "call-2" }, { toolCallId: "call-3" }],
      });
      await settleCall(setup, chat.runId, first.assistantMessageId, {
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.01,
      });
      await settleCall(setup, chat.runId, second.assistantMessageId, {
        inputTokens: 700,
        outputTokens: 70,
        costUsd: 0.07,
      });
      const requestOfFirst = await createApproval(setup, chat.runId, "call-1");

      const named = await readScoped(owner, chat.runId, first.assistantMessageId);
      const latest = await readScoped(owner, chat.runId, second.assistantMessageId);

      expect(named).toEqual(latest);
      expect(latest).toMatchObject({
        displayStatus: "done",
        title: "Plan my week",
        startedAt: new Date(CLOCK_START + 5_000).toISOString(),
        durationMs: 600,
        usage: { totalCostUsd: 0.07, perModel: [{ callCount: 1, inputTokens: 700, outputTokens: 70 }] },
      });
      expect(latest.approvals.requestIds).not.toContain(requestOfFirst);
    });

    it("keeps the earlier attempt's events out of a later reply to another message", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const failed = await playReply(setup, chat, {
        userText: "First",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
        end: "error",
      });
      await playReply(setup, chat, { userText: "Second", startMs: 10_000, toolCalls: [{ toolCallId: "call-b" }] });
      const requestB = await createApproval(setup, chat.runId, "call-b");

      // The failed reply stored no last event, so its range ends before the next reply's first event.
      const detail = await readScoped(owner, chat.runId, failed.assistantMessageId);

      expect(detail.approvals.requestIds).not.toContain(requestB);
      expect(detail.displayStatus).toBe("error");
    });

    it("uses the run's title for a reply that answers no message", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const orphanId = await queueAssistantMessage(setup, chat, null);
      await playQueuedAssistant(setup, chat, orphanId, { userMessageId: null, startMs: 0 });

      expect((await readScoped(owner, chat.runId, orphanId)).title).toBe("Chat");
    });

    it("counts a reply whose first event the message does not name through the steps stored on it", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      const requestA = await createApproval(setup, chat.runId, "call-a");
      // No production write leaves a started reply without its first event id; the column is cleared by SQL.
      await admin.query("UPDATE semp_messages SET event_from_id = NULL, event_to_id = NULL WHERE id = $1", [
        a.assistantMessageId,
      ]);

      const detail = await readScoped(owner, chat.runId, a.assistantMessageId);

      expect(detail.approvals).toMatchObject({ count: 1, requestIds: [requestA] });
      expect(detail.startedAt).not.toBe(new Date(CLOCK_START).toISOString());
    });

    it("answers a reply message without a status with a 500 that carries no data", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "Secret question", startMs: 0 });
      // The status column is nullable for user messages; a corrupt assistant row is made by SQL.
      await admin.query("UPDATE semp_messages SET status = NULL WHERE id = $1", [a.assistantMessageId]);

      const answer = await readScopedRaw(owner, chat.runId, `?messageId=${a.assistantMessageId}`);

      expect(answer).toEqual({ status: 500, body: { error: "Internal server error" } });
    });

    describe("the title of a reply to a system message", () => {
      /** A chat run in a tick thread whose approval outcome message `systemKey` the reply answers. */
      async function replyToApprovalOutcome(session: Session, outcome: "executed" | "rejected" | "conflict") {
        const setup = replySetup(session);
        const projectItemId = await createProject(session, "Weekly review");
        const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(
          session,
          projectItemId,
          "Sunday planning",
        );
        const heartbeatRun = await createRun(session, {
          projectItemId,
          heartbeatId,
          threadId: tickThreadId,
          triggeredBy: "heartbeat",
          task: "t",
        });
        const request = await runInTenant(session.tenant, () =>
          createPendingApprovalRequest(pool, {
            agentRunId: heartbeatRun.id,
            toolName: "probe",
            riskClass: "unclassified",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          }),
        );
        await runInTenant(session.tenant, () =>
          withTransaction(pool, (client) => postApprovalOutcomeMessage(client, request, outcome)),
        );
        const queued = await admin.query<{ id: string; reply_to_message_id: string }>(
          "SELECT id, reply_to_message_id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant' AND status = 'queued'",
          [tickThreadId],
        );
        const assistant = queued.rows[0];
        if (!assistant) throw new Error("The approval outcome queued no reply");
        const run = await createRun(session, {
          threadId: tickThreadId,
          triggeredBy: "user",
          unit: "session",
          task: "t",
        });
        const chat: ChatRun = { runId: run.id, threadId: tickThreadId };
        await playQueuedAssistant(setup, chat, assistant.id, {
          userMessageId: assistant.reply_to_message_id,
          startMs: 0,
        });
        return { chat, assistantId: assistant.id, systemMessageId: assistant.reply_to_message_id };
      }

      it.each([
        ["executed", "Approved action carried out"],
        ["rejected", "Action rejected"],
        ["conflict", "Approved action could not be carried out"],
      ] as const)("is the English title of approval.outcome.%s", async (outcome, title) => {
        const owner = await tenantSession();
        await updateUserLocale(admin, owner.userId, "en");
        const { chat, assistantId } = await replyToApprovalOutcome(owner, outcome);

        expect((await readScoped(owner, chat.runId, assistantId)).title).toBe(title);
      });

      it("is written in the user's locale", async () => {
        const owner = await tenantSession();
        await updateUserLocale(admin, owner.userId, "cs");
        const { chat, assistantId } = await replyToApprovalOutcome(owner, "rejected");

        expect((await readScoped(owner, chat.runId, assistantId)).title).toBe("Akce zamítnuta");
      });

      it("is the generic title for a system key the catalog has no entry for", async () => {
        const owner = await tenantSession();
        await updateUserLocale(admin, owner.userId, "en");
        const { chat, assistantId, systemMessageId } = await replyToApprovalOutcome(owner, "executed");
        // No production writer makes another system key yet; the stored key is replaced by SQL.
        await admin.query("UPDATE semp_messages SET system_key = 'approval.outcome.unheardOf' WHERE id = $1", [
          systemMessageId,
        ]);

        expect((await readScoped(owner, chat.runId, assistantId)).title).toBe("Automatic follow-up");
      });
    });

    it("answers a message of another run of the same tenant like an unknown id", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      await playReply(setup, chat, { userText: "First", startMs: 0 });
      const otherChat = await createChatRun(setup);
      const other = await playReply(setup, otherChat, { userText: "Elsewhere", startMs: 0 });

      const foreign = await readScopedRaw(owner, chat.runId, `?messageId=${other.assistantMessageId}`);
      const unknown = await readScopedRaw(owner, chat.runId, `?messageId=${randomUUID()}`);

      expect(foreign).toEqual(NOT_FOUND);
      expect(unknown).toEqual(foreign);
    });

    it("answers a message of another tenant like an unknown id", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const chat = await createChatRun(replySetup(owner));
      await playReply(replySetup(owner), chat, { userText: "First", startMs: 0 });
      const strangerChat = await createChatRun(replySetup(stranger));
      const foreignReply = await playReply(replySetup(stranger), strangerChat, { userText: "Private", startMs: 0 });

      const foreign = await readScopedRaw(owner, chat.runId, `?messageId=${foreignReply.assistantMessageId}`);
      const unknown = await readScopedRaw(owner, chat.runId, `?messageId=${randomUUID()}`);

      expect(foreign).toEqual(NOT_FOUND);
      expect(unknown).toEqual(foreign);
      expect(JSON.stringify(foreign)).not.toContain("Private");
    });

    it("answers a message that is not an assistant message like an unknown id, even when it names the run", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const reply = await playReply(setup, chat, { userText: "First", startMs: 0 });
      // No production write gives a user message a run; the link is set by SQL so that only its role is refused.
      await admin.query("UPDATE semp_messages SET agent_run_id = $2 WHERE id = $1", [reply.userMessageId, chat.runId]);

      const user = await readScopedRaw(owner, chat.runId, `?messageId=${reply.userMessageId}`);
      const assistant = await readScopedRaw(owner, chat.runId, `?messageId=${reply.assistantMessageId}`);

      expect(user).toEqual(NOT_FOUND);
      expect(assistant.status).toBe(200);
    });

    it.each([
      ["a messageId that is not a UUID", "?messageId=not-a-uuid"],
      ["an empty messageId", "?messageId="],
      ["a repeated messageId", `?messageId=${randomUUID()}&messageId=${randomUUID()}`],
    ])("answers %s with 400 validation_failed naming the field", async (_label, query) => {
      const owner = await tenantSession();
      const chat = await createChatRun(replySetup(owner));

      const answer = await readScopedRaw(owner, chat.runId, query);

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: "validation_failed", details: { field: "messageId" } });
    });

    it("answers a message of a run that another actor owns with the 404 of the run itself", async () => {
      const owner = await tenantSession();
      const chat = await createChatRun(replySetup(owner));
      const reply = await playReply(replySetup(owner), chat, { userText: "First", startMs: 0 });
      // The stranger's own tenant cannot see the run, so the answer is the run's 404 before any message is read.
      const stranger = await tenantSession();

      const answer = await readScopedRaw(stranger, chat.runId, `?messageId=${reply.assistantMessageId}`);

      expect(answer).toEqual(NOT_FOUND);
    });

    /**
     * A finished heartbeat run in the project, with its one assistant message in the tick thread. `prepare` runs
     * before the run finishes.
     */
    async function heartbeatRunWithMessage(
      session: Session,
      projectItemId: string,
      name: string,
      prepare: (runId: string) => Promise<void> = async () => {},
    ): Promise<{ runId: string; tickThreadId: string; messageId: string }> {
      const { heartbeatId, tickThreadId } = await createHeartbeatWithThread(session, projectItemId, name);
      const run = await createRun(session, {
        projectItemId,
        heartbeatId,
        threadId: tickThreadId,
        triggeredBy: "heartbeat",
        task: "t",
      });
      await runInTenant(session.tenant, () => insertAgentRunEvent(pool, run.id, "run_status", { status: "running" }));
      await prepare(run.id);
      await runInTenant(session.tenant, () =>
        withTransaction(pool, (client) =>
          finishTickRunWithMessage(client, {
            thread: { id: tickThreadId, tenantId: session.tenant, heartbeatId },
            agentRunId: run.id,
            outcome: { status: "done", result: "ok" },
          }),
        ),
      );
      const message = await admin.query<{ id: string }>(
        "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant'",
        [tickThreadId],
      );
      const messageId = message.rows[0]?.id;
      if (messageId === undefined) throw new Error("The tick run stored no message");
      return { runId: run.id, tickThreadId, messageId };
    }

    it("accepts the message of a heartbeat run and answers the whole run, as the run holds one message", async () => {
      const owner = await tenantSession();
      const projectItemId = await createProject(owner, "Weekly review");
      const { runId, messageId } = await heartbeatRunWithMessage(
        owner,
        projectItemId,
        "Sunday planning",
        async (id) => {
          await createRequest(owner, id);
          await settleCall(replySetup(owner), id, null, { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
        },
      );

      const whole = await readScopedRaw(owner, runId, "");
      const scoped = await readScopedRaw(owner, runId, `?messageId=${messageId}`);
      const unknown = await readScopedRaw(owner, runId, `?messageId=${randomUUID()}`);

      expect(whole.status).toBe(200);
      expect(scoped).toEqual(whole);
      expect(scoped.body).toMatchObject({
        title: "Sunday planning",
        approvals: { count: 1 },
        usage: { perModel: [{ callCount: 1 }] },
      });
      expect(unknown).toEqual(NOT_FOUND);
    });

    describe("a heartbeat run refuses a message that is not its own assistant message", () => {
      it("answers the assistant message of another run of the same tenant like an unknown id", async () => {
        const owner = await tenantSession();
        const projectItemId = await createProject(owner, "Weekly review");
        const run = await heartbeatRunWithMessage(owner, projectItemId, "Sunday planning");
        const other = await heartbeatRunWithMessage(owner, projectItemId, "Monday planning");

        const foreign = await readScopedRaw(owner, run.runId, `?messageId=${other.messageId}`);
        const unknown = await readScopedRaw(owner, run.runId, `?messageId=${randomUUID()}`);
        const own = await readScopedRaw(owner, run.runId, `?messageId=${run.messageId}`);

        expect(foreign).toEqual(NOT_FOUND);
        expect(unknown).toEqual(foreign);
        expect(own.status).toBe(200);
      });

      it("answers a user message of the run's thread like an unknown id, even when it names the run", async () => {
        const owner = await tenantSession();
        const projectItemId = await createProject(owner, "Weekly review");
        const run = await heartbeatRunWithMessage(owner, projectItemId, "Sunday planning");
        // No production write gives a user message a run; the row is made by SQL so that only its role is refused.
        const user = await admin.query<{ id: string }>(
          `INSERT INTO semp_messages (tenant_id, thread_id, role, text, agent_run_id)
           VALUES ($1, $2, 'user', 'Private question', $3) RETURNING id`,
          [owner.tenant, run.tickThreadId, run.runId],
        );
        const userMessageId = user.rows[0]?.id;
        if (userMessageId === undefined) throw new Error("The user message was not inserted");

        const refused = await readScopedRaw(owner, run.runId, `?messageId=${userMessageId}`);
        const own = await readScopedRaw(owner, run.runId, `?messageId=${run.messageId}`);

        expect(refused).toEqual(NOT_FOUND);
        expect(own.status).toBe(200);
      });

      it("answers a message of another tenant like an unknown id", async () => {
        const owner = await tenantSession();
        const stranger = await tenantSession();
        const run = await heartbeatRunWithMessage(
          owner,
          await createProject(owner, "Weekly review"),
          "Sunday planning",
        );
        const foreignRun = await heartbeatRunWithMessage(
          stranger,
          await createProject(stranger, "Private project"),
          "Private planning",
        );

        const foreign = await readScopedRaw(owner, run.runId, `?messageId=${foreignRun.messageId}`);
        const unknown = await readScopedRaw(owner, run.runId, `?messageId=${randomUUID()}`);

        expect(foreign).toEqual(NOT_FOUND);
        expect(unknown).toEqual(foreign);
        expect(JSON.stringify(foreign)).not.toContain("Private");
      });
    });

    it("still returns the stored duration, approvals and usage of a reply whose events retention removed", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, {
        userText: "Plan my week",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
      });
      const checkpoint = await runInTenant(owner.tenant, () =>
        insertAgentRunEvent(pool, chat.runId, "compaction", { kind: "compaction" }),
      );
      const b = await playReply(setup, chat, { userText: "Next", startMs: 10_000 });
      const requestA = await createApproval(setup, chat.runId, "call-a");
      await settleCall(setup, chat.runId, a.assistantMessageId, { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
      await runInTenant(owner.tenant, () => finishAgentRun(pool, chat.runId, "done", null));
      // The reply's events and the checkpoint after them are older than the retention window; reply B's are not.
      await admin.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1 AND id <= $3::bigint", [
        chat.runId,
        new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        checkpoint.id,
      ]);
      const before = await readScoped(owner, chat.runId, a.assistantMessageId);

      const { deleted } = await handleAgentRunEventsRetentionTask(pool);
      const after = await readScoped(owner, chat.runId, a.assistantMessageId);

      expect(deleted).toBe(a.eventIds.length);
      const created = await admin.query<{ created_at: Date }>("SELECT created_at FROM semp_messages WHERE id = $1", [
        a.assistantMessageId,
      ]);
      // Nothing but the start of the reply, which the removed first event gave, differs.
      expect(after).toEqual({ ...before, startedAt: created.rows[0]?.created_at.toISOString() });
      expect(after).toMatchObject({
        durationMs: 400,
        approvals: { count: 1, requestIds: [requestA] },
        usage: { totalCostUsd: 0.01 },
        title: "Plan my week",
      });
      expect((await readScoped(owner, chat.runId, b.assistantMessageId)).title).toBe("Next");
    });
  });
});
