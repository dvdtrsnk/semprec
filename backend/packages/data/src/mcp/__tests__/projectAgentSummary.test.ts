import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createAgentRun, finishAgentRun } from "../../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../../agentRuns/agentRunEventsStore.js";
import { createUser } from "../../auth/usersStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { withTransaction } from "../../db/pool.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { agentGuidanceDriftFindingsStore } from "../../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { createHeartbeat, type CreateHeartbeatInput } from "../../scheduler/schedulerStore.js";
import { createProjectHeartbeatsRouteHandler } from "../../scheduler/projectHeartbeatsRoute.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { claimSempMessage, finishSempMessageTurn, startSempMessageTurn } from "../../semp/sempMessagesStore.js";
import type { SempReplyStep } from "../../semp/sempReplySteps.js";
import { getOrCreateTickThread } from "../../semp/sempTickThreadStore.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createPendingApprovalRequest, decideApprovalRequest } from "../approvalRequestsStore.js";
import { setProjectMcpGrantForAgentPage } from "../mcpAgentPageGrants.js";
import { upsertMcpToolRegistration } from "../mcpToolRegistrationsStore.js";
import { getProjectAgentSummary, type ProjectAgentSummary } from "../projectAgentSummary.js";
import { createProjectAgentSummaryRouteHandler } from "../projectAgentSummaryRouteHandler.js";

const EVERY_DAY = { kind: "interval", minutes: 5 } as const;
const STORED_STEP_TIMES = { startedAt: "2026-11-01T10:00:00.000Z", durationMs: 5 };
const NO_ATTENTION = { activeDriftFindings: 0, failingHeartbeats: 0, pendingApprovals: 0, needsAttention: false };

const behaviorPayload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};

let pool: Pool;
let runtimePool: Pool;
let userId: string;
let mcpServersId: string;

async function summaryOf(projectItemId: string): Promise<ProjectAgentSummary> {
  return withTransaction(pool, (client) => getProjectAgentSummary(client, projectItemId));
}

async function createServer(name: string, active: boolean): Promise<string> {
  const server = await withTransaction(pool, (client) =>
    itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name, active } }),
  );
  return server.id;
}

/** A tool on a new server; `granted` sets the project's grant of it, `serverActive` the server item's state. */
async function addTool(
  projectItemId: string,
  options: { granted: boolean; serverActive?: boolean; registrationActive?: boolean },
): Promise<string> {
  const serverId = await createServer(`Server ${randomUUID()}`, options.serverActive ?? true);
  const registration = await upsertMcpToolRegistration(pool, {
    mcpServerItemId: serverId,
    toolName: `tool_${randomUUID().slice(0, 8)}`,
    toolSchema: {},
    ...(options.registrationActive === undefined ? {} : { active: options.registrationActive }),
  });
  await withTransaction(pool, (client) =>
    setProjectMcpGrantForAgentPage(client, {
      projectItemId,
      mcpToolRegistrationId: registration.id,
      granted: options.granted,
    }),
  );
  return registration.id;
}

async function addHeartbeat(
  projectItemId: string,
  options: Pick<CreateHeartbeatInput, "origin" | "enabled"> = { origin: "user" },
): Promise<string> {
  const heartbeat = await withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId,
      name: `Heartbeat ${randomUUID().slice(0, 8)}`,
      rule: EVERY_DAY,
      actionId: "noop",
      ...options,
    }),
  );
  return heartbeat.id;
}

async function addGuidance(projectItemId: string, markdown: string): Promise<string> {
  const row = await withTransaction(pool, (client) =>
    projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId: userId, markdown }),
  );
  return row.updatedAt;
}

async function addDriftFinding(projectItemId: string, status: "active" | "resolved" | "dismissed"): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { finding } = await agentGuidanceDriftFindingsStore.upsertActive(client, {
      projectItemId,
      fingerprint: randomUUID(),
      payload: behaviorPayload,
      seenAt: new Date("2026-01-01T00:00:00Z"),
    });
    if (status === "resolved") await agentGuidanceDriftFindingsStore.resolve(client, finding.id, new Date());
    if (status === "dismissed") {
      await agentGuidanceDriftFindingsStore.decide(client, finding.id, {
        status: "dismissed",
        choice: "dismiss",
        userId,
        at: new Date(),
      });
    }
  });
}

/**
 * One scheduled occurrence of a heartbeat. Raw SQL, because the production writer is the sweep, which inserts a row
 * only for a due time of the clock and so cannot produce a past occurrence at a chosen instant.
 */
async function addOccurrence(heartbeatId: string, scheduledFor: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
     VALUES ($1, $2, $3::jsonb, 'queued') RETURNING id`,
    [heartbeatId, scheduledFor, JSON.stringify(EVERY_DAY)],
  );
  const [row] = rows;
  if (!row) throw new Error("The occurrence was not inserted");
  return row.id;
}

type Closing = "done" | "error" | "running";

/** The run of a new occurrence of the heartbeat, closed as `closing`. */
async function addOccurrenceRun(
  projectItemId: string,
  heartbeatId: string,
  scheduledFor: string,
  closing: Closing,
  threadId: string | null = null,
) {
  const occurrenceId = await addOccurrence(heartbeatId, scheduledFor);
  const run = await createAgentRun(pool, {
    userId,
    projectItemId,
    heartbeatId,
    heartbeatOccurrenceId: occurrenceId,
    threadId,
    triggeredBy: "heartbeat",
    task: "Plan the week",
  });
  if (closing === "done") await finishAgentRun(pool, run.id, "done", "finished");
  if (closing === "error") await finishAgentRun(pool, run.id, "error", "modelError");
  return run;
}

function failedMcpStep(): SempReplyStep {
  return {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "mcp_search_aaaaaaaa",
    label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
    detail: { key: "agentStep.summary.failed", params: {} },
    status: "error",
    errorCode: "unavailable",
    connectorName: "GitHub",
    ...STORED_STEP_TIMES,
  };
}

/**
 * Stores an incomplete reply (a failed tool call, issue #1890) as an assistant message of `run`. `threadId` is the
 * thread to send into; without it a new chat thread is created. Returns the thread the message was sent into.
 */
async function addIncompleteReply(run: { id: string }, eventId: string, threadId: string | undefined): Promise<string> {
  // Queuing the reply message is a tenant task, so it needs a tenant scope.
  return runInTenant(getTenantZeroId(), () =>
    withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, {
        ...(threadId === undefined ? {} : { threadId }),
        text: "tick",
        context: [],
        hasContext: false,
      });
      await claimSempMessage(client, sent.threadId, sent.assistantMessageId);
      await startSempMessageTurn(client, sent.assistantMessageId, run.id, eventId);
      const stored = await finishSempMessageTurn(client, sent.assistantMessageId, {
        status: "done",
        text: "The answer.",
        lastEventId: eventId,
        summary: { steps: [failedMcpStep()], durationMs: null, tokens: { input: 0, output: 0 }, changes: [] },
      });
      expect(stored).toBe(true);
      return sent.threadId;
    }),
  );
}

/**
 * An occurrence whose run closed as `done` with a reply that left a failed tool call (issue #1890): it reads `failed`.
 * `extraReply` adds a second assistant message of the same run, in the run's own thread (`"same-thread"`, so the run
 * has two replies and no single one to judge) or in another thread (`"other-thread"`, so only one reply is the run's).
 */
async function addIncompleteReplyOccurrence(
  projectItemId: string,
  heartbeatId: string,
  scheduledFor: string,
  extraReply?: "same-thread" | "other-thread",
) {
  const thread = await withTransaction(pool, (client) => getOrCreateTickThread(client, heartbeatId));
  const run = await addOccurrenceRun(projectItemId, heartbeatId, scheduledFor, "running", thread.id);
  const event = await insertAgentRunEvent(pool, run.id, "user_message", {
    kind: "user_message",
    text: "tick",
    context: [],
  });
  await addIncompleteReply(run, event.id, thread.id);
  if (extraReply !== undefined) {
    await addIncompleteReply(run, event.id, extraReply === "same-thread" ? thread.id : undefined);
  }
  await finishAgentRun(pool, run.id, "done", "finished");
  return run;
}

async function addPendingApproval(runId: string): Promise<string> {
  const request = await createPendingApprovalRequest(pool, {
    agentRunId: runId,
    toolName: "probe",
    riskClass: "unclassified",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  });
  return request.id;
}

/** A run of the project that is not tied to a heartbeat. */
function addUserRun(projectItemId: string) {
  return createAgentRun(pool, { userId, projectItemId, triggeredBy: "user", task: "Ask" });
}

/** The statements `fn` sends over one transaction's client. The client is wrapped, never patched. */
async function countStatements<T>(fn: (client: PoolClient) => Promise<T>): Promise<{ result: T; statements: number }> {
  let statements = 0;
  const result = await withTransaction(pool, (client) =>
    fn(
      new Proxy(client, {
        get(target, key) {
          if (key === "query") {
            return (...args: unknown[]): unknown => {
              statements += 1;
              const query: unknown = Reflect.get(target, "query", target);
              if (typeof query !== "function") throw new Error("The client has no query method");
              return Reflect.apply(query, target, args);
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    ),
  );
  return { result, statements };
}

afterAll(async () => {
  await runtimePool?.end();
  await pool?.end();
});

describe("getProjectAgentSummary (issue gh-1935)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
    userId = (
      await createUser(pool, {
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        tenantId: getTenantZeroId(),
        role: "admin",
      })
    ).id;
  });

  it("reports a project with guidance, three effective grants, two enabled user heartbeats and one active finding", async () => {
    const project = await createTestProjectItem(pool);
    const updatedAt = await addGuidance(project, "## Purpose\nKeep the weekly review.\n");
    for (let index = 0; index < 3; index += 1) await addTool(project, { granted: true });
    await addHeartbeat(project);
    await addHeartbeat(project);
    await addDriftFinding(project, "active");

    expect(await summaryOf(project)).toEqual({
      hasGuidance: true,
      guidanceUpdatedAt: updatedAt,
      grantedToolCount: 3,
      enabledHeartbeatCount: 2,
      attention: { activeDriftFindings: 1, failingHeartbeats: 0, pendingApprovals: 0, needsAttention: true },
    });
  });

  it("reads all zeros for a project that has nothing", async () => {
    const project = await createTestProjectItem(pool);

    expect(await summaryOf(project)).toEqual({
      hasGuidance: false,
      guidanceUpdatedAt: null,
      grantedToolCount: 0,
      enabledHeartbeatCount: 0,
      attention: NO_ATTENTION,
    });
  });

  describe("hasGuidance and guidanceUpdatedAt", () => {
    it("is false with the record's timestamp when the record holds only whitespace", async () => {
      const project = await createTestProjectItem(pool);
      const updatedAt = await addGuidance(project, "  \n\n ");

      expect(await summaryOf(project)).toMatchObject({ hasGuidance: false, guidanceUpdatedAt: updatedAt });
    });

    it("does not read the guidance of another project", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      await addGuidance(other, "## Purpose\nAnother project.\n");

      expect(await summaryOf(project)).toMatchObject({ hasGuidance: false, guidanceUpdatedAt: null });
    });
  });

  describe("grantedToolCount", () => {
    it("counts a granted tool of an active server only", async () => {
      const project = await createTestProjectItem(pool);
      await addTool(project, { granted: true });
      await addTool(project, { granted: true, serverActive: false });
      await addTool(project, { granted: false });
      await addTool(project, { granted: true, registrationActive: false });

      expect((await summaryOf(project)).grantedToolCount).toBe(1);
    });

    it("counts the grants of the project, not those of another project", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      const registrationId = await addTool(other, { granted: true });
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId: project,
          mcpToolRegistrationId: registrationId,
          granted: false,
        }),
      );

      expect((await summaryOf(project)).grantedToolCount).toBe(0);
      expect((await summaryOf(other)).grantedToolCount).toBe(1);
    });
  });

  describe("enabledHeartbeatCount", () => {
    it("counts enabled user heartbeats only, not system or switched-off ones, and not another project's", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      await addHeartbeat(project, { origin: "user", enabled: true });
      await addHeartbeat(project, { origin: "user", enabled: false });
      await addHeartbeat(project, { origin: "system", enabled: true });
      await addHeartbeat(other, { origin: "user", enabled: true });

      expect((await summaryOf(project)).enabledHeartbeatCount).toBe(1);
    });
  });

  describe("attention.activeDriftFindings", () => {
    it("counts active findings only, not resolved or dismissed ones, and not another project's", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      await addDriftFinding(project, "active");
      await addDriftFinding(project, "active");
      await addDriftFinding(project, "resolved");
      await addDriftFinding(project, "dismissed");
      await addDriftFinding(other, "active");

      expect((await summaryOf(project)).attention).toEqual({
        ...NO_ATTENTION,
        activeDriftFindings: 2,
        needsAttention: true,
      });
    });
  });

  describe("attention.failingHeartbeats", () => {
    it("counts a user heartbeat whose last occurrence failed", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project);
      await addOccurrenceRun(project, heartbeat, "2026-11-01T08:00:00Z", "error");

      expect((await summaryOf(project)).attention).toEqual({
        ...NO_ATTENTION,
        failingHeartbeats: 1,
        needsAttention: true,
      });
    });

    it("counts a heartbeat whose last run closed as done but left a failed tool call in its reply", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project);
      await addIncompleteReplyOccurrence(project, heartbeat, "2026-11-01T08:00:00Z");

      expect((await summaryOf(project)).attention.failingHeartbeats).toBe(1);
    });

    it("does not count a heartbeat whose last occurrence succeeded after an earlier failure", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project);
      await addOccurrenceRun(project, heartbeat, "2026-11-01T08:00:00Z", "error");
      await addOccurrenceRun(project, heartbeat, "2026-11-02T08:00:00Z", "done");

      expect((await summaryOf(project)).attention.failingHeartbeats).toBe(0);
    });

    it("does not count a heartbeat whose last finished run is done, nor one with no occurrence", async () => {
      const project = await createTestProjectItem(pool);
      const finished = await addHeartbeat(project);
      await addHeartbeat(project);
      await addOccurrenceRun(project, finished, "2026-11-01T08:00:00Z", "done");

      expect((await summaryOf(project)).attention.failingHeartbeats).toBe(0);
    });

    it("reads past an occurrence that is still running to the last finished one", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project);
      await addOccurrenceRun(project, heartbeat, "2026-11-01T08:00:00Z", "error");
      await addOccurrenceRun(project, heartbeat, "2026-11-02T08:00:00Z", "running");

      expect((await summaryOf(project)).attention.failingHeartbeats).toBe(1);
    });

    it("does not count a run that waits for approval as failing, but counts its approval", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project);
      const run = await addOccurrenceRun(project, heartbeat, "2026-11-01T08:00:00Z", "done");
      await addPendingApproval(run.id);

      expect((await summaryOf(project)).attention).toEqual({
        ...NO_ATTENTION,
        pendingApprovals: 1,
        needsAttention: true,
      });
    });

    it("does not count a system heartbeat that failed, nor the failure of another project's heartbeat", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      const system = await addHeartbeat(project, { origin: "system" });
      const foreign = await addHeartbeat(other);
      await addOccurrenceRun(project, system, "2026-11-01T08:00:00Z", "error");
      await addOccurrenceRun(other, foreign, "2026-11-01T08:00:00Z", "error");

      expect((await summaryOf(project)).attention).toEqual(NO_ATTENTION);
    });

    it("counts a switched-off user heartbeat whose last occurrence failed, as the heartbeat list shows it", async () => {
      const project = await createTestProjectItem(pool);
      const heartbeat = await addHeartbeat(project, { origin: "user", enabled: false });
      await addOccurrenceRun(project, heartbeat, "2026-11-01T08:00:00Z", "error");

      expect(await summaryOf(project)).toMatchObject({
        enabledHeartbeatCount: 0,
        attention: { failingHeartbeats: 1, needsAttention: true },
      });
    });

    it("counts the heartbeats the heartbeat list shows as failed", async () => {
      const project = await createTestProjectItem(pool);
      const failedRun = await addHeartbeat(project);
      const incompleteReply = await addHeartbeat(project);
      const recovered = await addHeartbeat(project);
      const done = await addHeartbeat(project);
      const approvalWaiting = await addHeartbeat(project);
      const twoReplies = await addHeartbeat(project);
      const replyInOtherThread = await addHeartbeat(project);
      await addOccurrenceRun(project, failedRun, "2026-11-01T08:00:00Z", "error");
      await addIncompleteReplyOccurrence(project, incompleteReply, "2026-11-01T08:00:00Z");
      await addOccurrenceRun(project, recovered, "2026-11-01T08:00:00Z", "error");
      await addOccurrenceRun(project, recovered, "2026-11-02T08:00:00Z", "done");
      await addOccurrenceRun(project, done, "2026-11-01T08:00:00Z", "done");
      await addPendingApproval((await addOccurrenceRun(project, approvalWaiting, "2026-11-01T08:00:00Z", "done")).id);
      // Two incomplete replies in the run's thread: no single reply stands for the run, so the list reads it as ok.
      await addIncompleteReplyOccurrence(project, twoReplies, "2026-11-01T08:00:00Z", "same-thread");
      // A second reply of the run in another thread is not the run's reply: the one in its own thread decides.
      await addIncompleteReplyOccurrence(project, replyInOtherThread, "2026-11-01T08:00:00Z", "other-thread");

      const listed = await createProjectHeartbeatsRouteHandler(pool)({
        params: { id: project },
        identity: { user: { locale: "en" } },
      });
      const listedBody = z
        .object({ rows: z.array(z.object({ lastOccurrence: z.object({ status: z.string() }).nullable() })) })
        .parse(listed.body);
      const statuses = listedBody.rows.map((row) => row.lastOccurrence?.status ?? null);
      expect([...statuses].sort()).toEqual(["failed", "failed", "failed", "ok", "ok", "ok", "waiting_approval"]);
      expect((await summaryOf(project)).attention.failingHeartbeats).toBe(
        statuses.filter((status) => status === "failed").length,
      );
    });
  });

  describe("attention.pendingApprovals", () => {
    it("counts pending requests of the project's runs only", async () => {
      const project = await createTestProjectItem(pool);
      const other = await createTestProjectItem(pool);
      await addPendingApproval((await addUserRun(project)).id);
      await addPendingApproval((await addUserRun(project)).id);
      await addPendingApproval((await addUserRun(other)).id);

      expect((await summaryOf(project)).attention).toEqual({
        ...NO_ATTENTION,
        pendingApprovals: 2,
        needsAttention: true,
      });
    });

    it("does not count a request that has been decided", async () => {
      const project = await createTestProjectItem(pool);
      const requestId = await addPendingApproval((await addUserRun(project)).id);
      const decided = await decideApprovalRequest(pool, requestId, "approved", userId);
      expect(decided?.status).toBe("approved");

      expect((await summaryOf(project)).attention).toEqual(NO_ATTENTION);
    });
  });

  describe("needsAttention", () => {
    it("is false when the three counts are zero, even for a project with a full setup", async () => {
      const project = await createTestProjectItem(pool);
      await addGuidance(project, "## Purpose\nKeep the weekly review.\n");
      await addTool(project, { granted: true });
      await addHeartbeat(project);

      expect((await summaryOf(project)).attention).toEqual(NO_ATTENTION);
    });
  });

  describe("statements", () => {
    it("does not grow with the number of tools, heartbeats, runs, replies or approvals", async () => {
      const small = await createTestProjectItem(pool);
      const large = await createTestProjectItem(pool);
      await addTool(small, { granted: true });
      const first = await addHeartbeat(small);
      // A finished run with a reply, so both projects take every read: the reply read is skipped when no run is done.
      await addIncompleteReplyOccurrence(small, first, "2026-11-01T08:00:00Z");
      for (let index = 0; index < 4; index += 1) await addTool(large, { granted: true });
      for (let index = 0; index < 4; index += 1) {
        const heartbeat = await addHeartbeat(large);
        if (index % 2 === 0) {
          await addPendingApproval((await addOccurrenceRun(large, heartbeat, "2026-11-01T08:00:00Z", "done")).id);
        } else {
          await addIncompleteReplyOccurrence(large, heartbeat, "2026-11-01T08:00:00Z");
        }
      }

      const one = await countStatements((client) => getProjectAgentSummary(client, small));
      const many = await countStatements((client) => getProjectAgentSummary(client, large));

      expect(one.result).toMatchObject({ grantedToolCount: 1, enabledHeartbeatCount: 1 });
      expect(one.result.attention).toMatchObject({ failingHeartbeats: 1 });
      expect(many.result).toMatchObject({ grantedToolCount: 4, enabledHeartbeatCount: 4 });
      expect(many.result.attention).toMatchObject({ failingHeartbeats: 2, pendingApprovals: 2 });
      expect(many.statements).toBe(one.statements);
    });
  });
});

describe("createProjectAgentSummaryRouteHandler (issue gh-1935)", () => {
  let tenantA: string;
  let tenantB: string;
  let projectOfA: string;
  let projectOfB: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtimePool ??= await createRuntimeRolePool(pool, "semprec_data");
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(runtimePool));
    projectOfA = await runInTenant(tenantA, () => createTestProjectItem(runtimePool));
    projectOfB = await runInTenant(tenantB, () => createTestProjectItem(runtimePool));
    // A's project gets a heartbeat, so a 404 for B cannot be an artefact of an empty project.
    await runInTenant(tenantA, () =>
      withTransaction(runtimePool, (client) =>
        createHeartbeat(client, {
          projectItemId: projectOfA,
          name: "Weekly review",
          rule: EVERY_DAY,
          actionId: "noop",
          origin: "user",
        }),
      ),
    );
  });

  const call = (tenant: string, id: string) =>
    runInTenant(tenant, () => createProjectAgentSummaryRouteHandler(runtimePool)({ params: { id } }));

  it("answers 200 with the summary of a live project of the caller's tenant", async () => {
    const answer = await call(tenantA, projectOfA);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      hasGuidance: false,
      guidanceUpdatedAt: null,
      grantedToolCount: 0,
      enabledHeartbeatCount: 1,
      attention: NO_ATTENTION,
    });
  });

  it("answers the same 404 for another tenant's project, a trashed project and an unknown id, and counts nothing of A for B", async () => {
    const trashed = await runInTenant(tenantB, () => createTestProjectItem(runtimePool));
    await runInTenant(tenantB, () =>
      withTransaction(runtimePool, async (client) => {
        const projects = await databasesStore.getDatabaseByModuleId(client, "projects");
        if (!projects) throw new Error("The Projects database is missing");
        await itemsStore.softDeleteItem(client, projects.id, trashed);
      }),
    );

    const rejections = [];
    for (const id of [projectOfA, trashed, randomUUID()]) {
      const error: unknown = await call(tenantB, id).then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(NotFoundError);
      rejections.push(error instanceof Error ? error.message : null);
    }
    expect(new Set(rejections)).toEqual(new Set(["Project not found"]));
    expect((await call(tenantB, projectOfB)).body).toMatchObject({ enabledHeartbeatCount: 0 });
  });

  it("answers 400 for an id that is not a UUID, before reading anything", async () => {
    const error: unknown = await call(tenantA, "not-a-uuid").then(
      () => null,
      (rejected: unknown) => rejected,
    );

    expect(error).toBeInstanceOf(ValidationError);
  });
});
