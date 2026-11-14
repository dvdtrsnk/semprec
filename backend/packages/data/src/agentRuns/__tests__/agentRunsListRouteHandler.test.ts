import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { ValidationError } from "../../errors.js";
import { withTransaction } from "../../db/pool.js";
import { failGatewayCall, recordTokenGatewayCall, reserveGatewayCall } from "../../aiGateway/aiGatewayCallsStore.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import {
  assistantEvent,
  finishPlayedTurn,
  playTurn,
  toolResultEvent,
  toolUseEvent,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type EventSpec,
  type TurnSetup,
} from "../../semp/__tests__/sempReplyTestSupport.js";
import { createSempChatThread } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTestProjectItem } from "../../testSupport/projectFixtures.js";
import { insertApprovalOutcomeSystemMessage } from "../../semp/sempMessagesStore.js";
import { getOrCreateTickThread } from "../../testSupport/testDb.js";
import {
  ANSWER_CLOCK_START,
  askQuestion,
  createChatSession,
  playAnswer,
  playQueuedAnswer,
  retryAnswer,
  settleAnswerCall,
  type AnswerSetup,
  type ChatSession,
} from "./chatAnswerFixtures.js";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRun,
  listProjectAgentRuns,
  type AgentRunErrorCode,
  type AgentRunRow,
} from "../agentRunsStore.js";
import { createListAgentRunsRouteHandler } from "../agentRunsListRouteHandler.js";

interface TenantSetup {
  tenant: string;
  userId: string;
}

let admin: Pool;
let runtime: Pool;
let tenantA: TenantSetup;
let tenantB: TenantSetup;

const rowSchema = z
  .object({
    id: z.string(),
    agentRunId: z.string(),
    messageId: z.string().nullable(),
    title: z.string(),
    triggeredBy: z.enum(["user", "heartbeat", "mcp"]),
    triggerLabel: z.string(),
    startedAt: z.string(),
    durationMs: z.number().nullable(),
    costUsd: z.number(),
    displayStatus: z.enum(["running", "done", "waiting_approval", "error"]),
    errorSummary: z.string().nullable(),
    attempt: z.number(),
    attempts: z
      .array(
        z.strictObject({
          id: z.string(),
          attempt: z.number(),
          startedAt: z.string(),
          durationMs: z.number().nullable(),
          costUsd: z.number(),
          displayStatus: z.enum(["running", "done", "waiting_approval", "error"]),
        }),
      )
      .optional(),
  })
  .strict();
const bodySchema = z.strictObject({ rows: z.array(rowSchema) });
type ListRow = z.infer<typeof rowSchema>;

/** Calls the handler as the adapter does: inside the tenant's scope, with the request URL and the caller. */
async function call(
  query: string,
  caller: { tenant: TenantSetup; userId?: string; locale?: string } = { tenant: tenantA },
): Promise<{ status: number; body: unknown }> {
  return runInTenant(caller.tenant.tenant, () =>
    createListAgentRunsRouteHandler(runtime)({
      req: { url: `/api/agent-runs${query}` },
      identity: { user: { id: caller.userId ?? caller.tenant.userId, locale: caller.locale ?? "en" } },
    }),
  );
}

/** The rows of a successful list, parsed with a strict schema so an added or missing field is noticed. */
async function listRows(
  projectItemId: string,
  options: { limit?: string; tenant?: TenantSetup; userId?: string; locale?: string } = {},
): Promise<ListRow[]> {
  const limit = options.limit === undefined ? "" : `&limit=${options.limit}`;
  const result = await call(`?projectItemId=${projectItemId}${limit}`, {
    tenant: options.tenant ?? tenantA,
    userId: options.userId,
    locale: options.locale,
  });
  expect(result.status).toBe(200);
  // The body as JSON carries it, so a value JSON cannot represent would be noticed.
  return bodySchema.parse(JSON.parse(JSON.stringify(result.body))).rows;
}

/** The SQL text of the first argument of a `query` call: a string, or the `text` of a query config. */
function statementText(statement: unknown): string | null {
  if (typeof statement === "string") return statement;
  if (typeof statement === "object" && statement !== null && "text" in statement) {
    return typeof statement.text === "string" ? statement.text : null;
  }
  return null;
}

async function rejection(query: string): Promise<unknown> {
  return call(query).then(
    () => {
      throw new Error("The handler accepted the request");
    },
    (error: unknown) => error,
  );
}

async function createProject(tenant = tenantA): Promise<string> {
  return runInTenant(tenant.tenant, () => createTestProjectItem(runtime));
}

interface RunInput {
  projectItemId: string;
  triggeredBy?: AgentRunRow["triggeredBy"];
  unit?: AgentRunRow["unit"];
  task?: string;
  heartbeatId?: string;
  tenant?: TenantSetup;
}

async function createRun(input: RunInput): Promise<AgentRunRow> {
  const tenant = input.tenant ?? tenantA;
  return runInTenant(tenant.tenant, () =>
    createAgentRun(runtime, {
      projectItemId: input.projectItemId,
      triggeredBy: input.triggeredBy ?? "user",
      unit: input.unit ?? "invocation",
      task: input.task ?? "a task",
      ...(input.heartbeatId === undefined ? {} : { heartbeatId: input.heartbeatId }),
      userId: tenant.userId,
    }),
  );
}

/**
 * Gives the run the instants a test asserts. Raw SQL on the admin pool, because the production writers stamp
 * `now()` and the order and the durations a test asserts need a clock it controls; `finished_at` stays NULL for a
 * run that has not finished.
 */
async function setInstants(runId: string, startedAt: string, finishedAt: string | null = null): Promise<void> {
  const result = await admin.query(
    `UPDATE agent_runs SET started_at = $2::timestamptz,
       finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE $3::timestamptz END
     WHERE id = $1`,
    [runId, startedAt, finishedAt],
  );
  expect(result.rowCount).toBe(1);
}

async function closeRun(runId: string, tenant = tenantA): Promise<void> {
  expect(await runInTenant(tenant.tenant, () => finishAgentRun(runtime, runId, "done", "finished"))).toBe(true);
}

async function failRun(runId: string, errorCode: AgentRunErrorCode = "modelError", tenant = tenantA): Promise<void> {
  expect(await runInTenant(tenant.tenant, () => finishAgentRun(runtime, runId, "error", errorCode))).toBe(true);
}

async function createNamedHeartbeat(projectItemId: string, name: string): Promise<string> {
  return runInTenant(tenantA.tenant, async () => {
    const heartbeat = await withTransaction(runtime, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name,
        rule: { kind: "interval", minutes: 5 },
        actionId: "noop",
      }),
    );
    return heartbeat.id;
  });
}

async function recordCost(runId: string, costUsd: number): Promise<void> {
  await runInTenant(tenantA.tenant, () =>
    recordTokenGatewayCall(runtime, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      costUsd,
      agentRunId: runId,
    }),
  );
}

async function requestApproval(runId: string): Promise<void> {
  await runInTenant(tenantA.tenant, () =>
    createPendingApprovalRequest(runtime, {
      agentRunId: runId,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    }),
  );
}

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGISTRATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** An MCP call of the server "GitHub" that fails as unavailable, as `agentSessionComposition` stores a failure. */
function unavailableMcpCall(): EventSpec[] {
  const identity = { toolRegistrationId: REGISTRATION, serverItemId: SERVER, serverName: "GitHub", toolName: "search" };
  return [
    {
      kind: "tool_use",
      atMs: 100,
      payload: {
        kind: "tool_use",
        toolCallId: "mcp-1",
        name: "mcp_search_aaaaaaaa",
        arguments: { query: "anything" },
        mcp: identity,
      },
    },
    {
      kind: "tool_result",
      atMs: 400,
      payload: {
        kind: "tool_result",
        toolCallId: "mcp-1",
        name: "mcp_search_aaaaaaaa",
        mcp: identity,
        result: {
          content: [{ type: "text", text: "The call failed." }],
          details: { error: true, failureKind: "unavailable", connectorName: "GitHub" },
        },
        isError: false,
      },
    },
  ];
}

/** A heartbeat run of `projectItemId` whose one reply ended `done` after the tool events, with the run closed as done. */
async function createRunWithReply(projectItemId: string, toolEvents: EventSpec[]): Promise<AgentRunRow> {
  const setup: TurnSetup = { admin, runtime, tenant: tenantA.tenant };
  const threadId = await runInTenant(tenantA.tenant, () => withTransaction(runtime, createSempChatThread));
  const run = await runInTenant(tenantA.tenant, () =>
    createAgentRun(runtime, {
      projectItemId,
      triggeredBy: "heartbeat",
      task: "tick",
      threadId,
      userId: tenantA.userId,
    }),
  );
  const turn = await playTurn(
    setup,
    [
      userMessageEvent(),
      turnStartEvent(10),
      ...toolEvents,
      assistantEvent("Here is the answer.", 900),
      turnEndEvent(1000),
    ],
    { threadId, runId: run.id },
  );
  await finishPlayedTurn(setup, turn, "done");
  await closeRun(run.id);
  return run;
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const tenants: TenantSetup[] = [];
  for (let i = 0; i < 2; i += 1) {
    const tenant = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    tenants.push({ tenant, userId: user.id });
  }
  const [a, b] = tenants;
  if (a === undefined || b === undefined) throw new Error("The tenant fixtures are missing");
  tenantA = a;
  tenantB = b;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
});

describe("GET /api/agent-runs of a project (issue gh-1909)", () => {
  it("lists a finished heartbeat run, a finished chat run, a run waiting for approval and a failed run, newest first", async () => {
    const projectItemId = await createProject();
    const review = await createNamedHeartbeat(projectItemId, "Morning review");
    const sweep = await createNamedHeartbeat(projectItemId, "Inbox sweep");
    const finishedHeartbeat = await createRun({
      projectItemId,
      triggeredBy: "heartbeat",
      heartbeatId: review,
      task: "Review the project",
    });
    const finishedChat = await createRun({
      projectItemId,
      triggeredBy: "user",
      unit: "session",
      task: "What changed this week?",
    });
    const waiting = await createRun({
      projectItemId,
      triggeredBy: "heartbeat",
      heartbeatId: review,
      task: "Review the project",
    });
    const failed = await createRun({
      projectItemId,
      triggeredBy: "heartbeat",
      heartbeatId: sweep,
      task: "Sweep the inbox",
    });
    for (const run of [finishedHeartbeat, finishedChat, waiting]) await closeRun(run.id);
    await requestApproval(waiting.id);
    await failRun(failed.id);
    await setInstants(finishedHeartbeat.id, "2026-11-01T10:00:00.000Z", "2026-11-01T10:00:42.000Z");
    await setInstants(finishedChat.id, "2026-11-01T10:10:00.000Z", "2026-11-01T10:12:00.000Z");
    await setInstants(waiting.id, "2026-11-01T10:20:00.000Z", "2026-11-01T10:20:05.000Z");
    await setInstants(failed.id, "2026-11-01T10:30:00.000Z", "2026-11-01T10:30:07.000Z");
    await recordCost(finishedHeartbeat.id, 0.02);
    await recordCost(finishedHeartbeat.id, 0.04);
    await recordCost(finishedChat.id, 0.5);

    expect(await listRows(projectItemId)).toEqual([
      {
        id: failed.id,
        agentRunId: failed.id,
        messageId: null,
        title: "Inbox sweep",
        triggeredBy: "heartbeat",
        triggerLabel: "Tick",
        startedAt: "2026-11-01T10:30:00.000Z",
        durationMs: 7000,
        costUsd: 0,
        displayStatus: "error",
        errorSummary: "AI model error",
        attempt: 1,
      },
      {
        id: waiting.id,
        agentRunId: waiting.id,
        messageId: null,
        title: "Morning review",
        triggeredBy: "heartbeat",
        triggerLabel: "Tick",
        startedAt: "2026-11-01T10:20:00.000Z",
        durationMs: 5000,
        costUsd: 0,
        displayStatus: "waiting_approval",
        errorSummary: null,
        attempt: 1,
      },
      {
        id: finishedChat.id,
        agentRunId: finishedChat.id,
        messageId: null,
        title: "What changed this week?",
        triggeredBy: "user",
        triggerLabel: "Chat",
        startedAt: "2026-11-01T10:10:00.000Z",
        durationMs: null,
        costUsd: 0.5,
        displayStatus: "done",
        errorSummary: null,
        attempt: 1,
      },
      {
        id: finishedHeartbeat.id,
        agentRunId: finishedHeartbeat.id,
        messageId: null,
        title: "Morning review",
        triggeredBy: "heartbeat",
        triggerLabel: "Tick",
        startedAt: "2026-11-01T10:00:00.000Z",
        durationMs: 42000,
        costUsd: 0.06,
        displayStatus: "done",
        errorSummary: null,
        attempt: 1,
      },
    ]);
  });

  it("writes the trigger label and the error summary in the caller's locale and falls back to English", async () => {
    const projectItemId = await createProject();
    const failed = await createRun({ projectItemId, triggeredBy: "heartbeat" });
    const mcp = await createRun({ projectItemId, triggeredBy: "mcp" });
    const chat = await createRun({ projectItemId, triggeredBy: "user" });
    await failRun(failed.id);
    await setInstants(failed.id, "2026-11-02T10:00:00.000Z");
    await setInstants(mcp.id, "2026-11-02T10:01:00.000Z");
    await setInstants(chat.id, "2026-11-02T10:02:00.000Z");
    const read = async (locale: string) =>
      Object.fromEntries(
        (await listRows(projectItemId, { locale })).map((row) => [row.id, [row.triggerLabel, row.errorSummary]]),
      );

    expect(await read("cs")).toEqual({
      [failed.id]: ["Tik", "Chyba AI modelu"],
      [mcp.id]: ["MCP", null],
      [chat.id]: ["Chat", null],
    });
    expect(await read("en")).toEqual({
      [failed.id]: ["Tick", "AI model error"],
      [mcp.id]: ["MCP", null],
      [chat.id]: ["Chat", null],
    });
    expect(await read("de")).toEqual(await read("en"));
  });

  it("titles a run with its task when it names no heartbeat", async () => {
    const projectItemId = await createProject();
    const run = await createRun({ projectItemId, triggeredBy: "user", task: "Plan the release" });

    expect((await listRows(projectItemId)).map((row) => [row.id, row.title])).toEqual([[run.id, "Plan the release"]]);
  });

  it("shows a run that is still running as running, without a duration or an error summary", async () => {
    const projectItemId = await createProject();
    const run = await createRun({ projectItemId, triggeredBy: "heartbeat" });

    expect(await listRows(projectItemId)).toMatchObject([
      { id: run.id, displayStatus: "running", durationMs: null, errorSummary: null },
    ]);
  });

  it("orders runs that started at the same instant by id, descending", async () => {
    const projectItemId = await createProject();
    const runs = [
      await createRun({ projectItemId }),
      await createRun({ projectItemId }),
      await createRun({ projectItemId }),
    ];
    for (const run of runs) await setInstants(run.id, "2026-11-03T10:00:00.000Z");

    expect((await listRows(projectItemId)).map((row) => row.id)).toEqual(
      runs
        .map((run) => run.id)
        .sort()
        .reverse(),
    );
  });

  it("shows a finished run whose reply left a failed tool call as an error with the reason of the unavailable server", async () => {
    const projectItemId = await createProject();
    const incomplete = await createRunWithReply(projectItemId, unavailableMcpCall());
    const complete = await createRunWithReply(projectItemId, []);
    await setInstants(incomplete.id, "2026-11-04T10:00:00.000Z", "2026-11-04T10:00:30.000Z");
    await setInstants(complete.id, "2026-11-04T10:05:00.000Z", "2026-11-04T10:05:30.000Z");

    expect(await listRows(projectItemId)).toMatchObject([
      { id: complete.id, displayStatus: "done", errorSummary: null },
      { id: incomplete.id, displayStatus: "error", errorSummary: "GitHub unavailable" },
    ]);
    expect(await listRows(projectItemId, { locale: "cs" })).toMatchObject([
      { id: complete.id },
      { id: incomplete.id, displayStatus: "error", errorSummary: "GitHub není dostupný" },
    ]);
  });

  describe("cost", () => {
    it("is the sum of the run's gateway calls, leaves a failed call out and counts a reserved call at its estimate", async () => {
      const projectItemId = await createProject();
      const summed = await createRun({ projectItemId });
      const withFailedCall = await createRun({ projectItemId });
      const withReservedCall = await createRun({ projectItemId });
      const withoutCalls = await createRun({ projectItemId });
      await recordCost(summed.id, 0.013);
      await recordCost(summed.id, 0.008);
      await recordCost(summed.id, 0.1);
      await recordCost(withFailedCall.id, 0.25);
      await runInTenant(tenantA.tenant, async () => {
        const failedCall = await reserveGatewayCall(runtime, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          estimatedCostUsd: 5,
          agentRunId: withFailedCall.id,
        });
        await failGatewayCall(runtime, failedCall.id);
        await reserveGatewayCall(runtime, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          estimatedCostUsd: 0.75,
          agentRunId: withReservedCall.id,
        });
      });

      const costs = new Map((await listRows(projectItemId)).map((row) => [row.id, row.costUsd]));

      expect(costs.get(summed.id)).toBe(0.121);
      expect(costs.get(withFailedCall.id)).toBe(0.25);
      expect(costs.get(withReservedCall.id)).toBe(0.75);
      expect(costs.get(withoutCalls.id)).toBe(0);
      expect(costs.size).toBe(4);
    });

    it("is read with one statement over ai_gateway_calls whatever the number of rows", async () => {
      const projectItemId = await createProject();
      const runs: AgentRunRow[] = [];
      for (let i = 0; i < 2; i += 1) runs.push(await createRun({ projectItemId }));
      const gatewayStatements = async (): Promise<number> => {
        const spy = vi.spyOn(pg.Client.prototype, "query");
        try {
          await listRows(projectItemId);
          return spy.mock.calls.filter(([statement]) => statementText(statement)?.includes("ai_gateway_calls") === true)
            .length;
        } finally {
          spy.mockRestore();
        }
      };
      for (const run of runs) await recordCost(run.id, 0.01);
      const two = await gatewayStatements();
      for (let i = 0; i < 7; i += 1) runs.push(await createRun({ projectItemId }));
      for (const run of runs.slice(2)) await recordCost(run.id, 0.01);
      const nine = await gatewayStatements();

      expect(runs).toHaveLength(9);
      expect((await listRows(projectItemId)).filter((row) => row.costUsd === 0.01)).toHaveLength(9);
      expect(two).toBe(1);
      expect(nine).toBe(1);
    });
  });

  describe("limit and projectItemId", () => {
    it("returns at most 20 rows when limit is omitted, the newest first", async () => {
      const projectItemId = await createProject();
      const ids: string[] = [];
      for (let i = 0; i < 22; i += 1) ids.push((await createRun({ projectItemId })).id);
      for (const [index, id] of ids.entries()) {
        await setInstants(id, new Date(Date.parse("2026-11-05T10:00:00.000Z") + index * 60_000).toISOString());
      }

      expect((await listRows(projectItemId)).map((row) => row.id)).toEqual(ids.slice(2).reverse());
    });

    it("accepts limit 100 and 1, and bounds the rows by the limit", async () => {
      const projectItemId = await createProject();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push((await createRun({ projectItemId })).id);
      for (const [index, id] of ids.entries()) {
        await setInstants(id, new Date(Date.parse("2026-11-06T10:00:00.000Z") + index * 60_000).toISOString());
      }

      expect((await listRows(projectItemId, { limit: "100" })).map((row) => row.id)).toEqual([...ids].reverse());
      expect((await listRows(projectItemId, { limit: "1" })).map((row) => row.id)).toEqual([ids[2]]);
    });

    it.each(["101", "0", "-1", "1.5", "abc", "", "1e1", " 5"])(
      "rejects limit=%j with a validation error",
      async (limit) => {
        const error = await rejection(`?projectItemId=${randomUUID()}&limit=${encodeURIComponent(limit)}`);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "limit" } });
      },
    );

    it.each(["", "?projectItemId=not-a-uuid", "?projectItemId=", "?limit=5"])(
      "rejects the query %j without a UUID projectItemId with a validation error",
      async (query) => {
        const error = await rejection(query);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "projectItemId" } });
      },
    );

    it("answers an empty list for a project id that holds no run of the caller", async () => {
      const emptyProject = await createProject();
      expect(await listRows(emptyProject)).toEqual([]);
      expect(await listRows(randomUUID())).toEqual([]);
    });
  });

  describe("which runs are listed", () => {
    it("never lists a run with triggered_by supervisor, and lists the run it was delegated from", async () => {
      const projectItemId = await createProject();
      const supervisor = await createRun({ projectItemId, triggeredBy: "heartbeat" });
      const delegated = await runInTenant(tenantA.tenant, () =>
        createAgentRun(runtime, {
          projectItemId,
          parentRunId: supervisor.id,
          triggeredBy: "supervisor",
          task: "delegated work",
        }),
      );
      expect(delegated.triggeredBy).toBe("supervisor");
      expect(delegated.projectItemId).toBe(projectItemId);

      expect((await listRows(projectItemId)).map((row) => row.id)).toEqual([supervisor.id]);
    });

    it("lists a run to its actor and not to another user, in the store and through the route", async () => {
      const projectItemId = await createProject();
      const run = await createRun({ projectItemId });
      const otherUserId = randomUUID();

      expect((await listRows(projectItemId)).map((row) => row.id)).toEqual([run.id]);
      expect(await listRows(projectItemId, { userId: otherUserId })).toEqual([]);
      const store = (actorUserId: string) =>
        runInTenant(tenantA.tenant, () =>
          listProjectAgentRuns(runtime, { projectItemId, actorUserId, limit: 10 }).then((runs) =>
            runs.map((r) => r.id),
          ),
        );
      expect(await store(tenantA.userId)).toEqual([run.id]);
      expect(await store(otherUserId)).toEqual([]);
    });

    it("lists only the runs of the project asked for", async () => {
      const projectItemId = await createProject();
      const otherProjectItemId = await createProject();
      const run = await createRun({ projectItemId });
      const otherRun = await createRun({ projectItemId: otherProjectItemId });

      expect((await listRows(projectItemId)).map((row) => row.id)).toEqual([run.id]);
      expect((await listRows(otherProjectItemId)).map((row) => row.id)).toEqual([otherRun.id]);
    });
  });

  describe("another tenant", () => {
    it("answers a user of another tenant an empty list for the project, as for a random id", async () => {
      const projectItemId = await createProject();
      const run = await createRun({ projectItemId });
      await recordCost(run.id, 0.02);
      const ownRun = await createRun({ projectItemId: await createProject(tenantB), tenant: tenantB });
      const foreignProject = await listRows(projectItemId, { tenant: tenantB });
      const randomProject = await listRows(randomUUID(), { tenant: tenantB });

      expect(foreignProject).toEqual([]);
      expect(foreignProject).toEqual(randomProject);
      // The caller of the other tenant claims the first tenant's user, so only the tenant scope can refuse.
      expect(await listRows(projectItemId, { tenant: tenantB, userId: tenantA.userId })).toEqual([]);
      expect((await listRows(projectItemId)).map((row) => row.id)).toEqual([run.id]);
      expect(ownRun.projectItemId).not.toBeNull();
      expect((await listRows(ownRun.projectItemId ?? "", { tenant: tenantB })).map((row) => row.id)).toEqual([
        ownRun.id,
      ]);
    });
  });

  describe("index", () => {
    /** Every node of an EXPLAIN (FORMAT JSON) result: the result is an array holding `{ Plan }`, a plan has `Plans`. */
    function planNodes(node: unknown): Record<string, unknown>[] {
      if (Array.isArray(node)) return node.flatMap(planNodes);
      if (typeof node !== "object" || node === null) return [];
      const record: Record<string, unknown> = Object.fromEntries(Object.entries(node));
      return [record, ...planNodes(record.Plan), ...planNodes(record.Plans)];
    }

    /** The nodes from the root of `plan` down to the first node that satisfies `match`, the matching node last; `[]` when none does. */
    function ancestorsOf(plan: unknown, match: (node: Record<string, unknown>) => boolean): Record<string, unknown>[] {
      const root = Array.isArray(plan) ? plan[0] : plan;
      const visit = (node: unknown, path: Record<string, unknown>[]): Record<string, unknown>[] => {
        if (typeof node !== "object" || node === null) return [];
        const record: Record<string, unknown> = Object.fromEntries(Object.entries(node));
        const here = [...path, record];
        if (match(record)) return here;
        const children = [record.Plans, record.Plan].flatMap((child) => (Array.isArray(child) ? child : [child]));
        for (const child of children) {
          const found = visit(child, here);
          if (found.length > 0) return found;
        }
        return [];
      };
      return visit(root, []);
    }

    it("serves the list query of a project with many runs from agent_runs_tenant_project_started_idx", async () => {
      const projects: string[] = [];
      for (let i = 0; i < 8; i += 1) projects.push(await createProject());
      const [target] = projects;
      if (target === undefined) throw new Error("The project fixtures are missing");
      // Bulk fixture by raw SQL on the admin pool: 8 projects of 400 runs each cannot be written one by one
      // through the store in reasonable time, and the planner needs rows to prefer the index over a sort.
      await admin.query(
        `INSERT INTO agent_runs (tenant_id, project_item_id, triggered_by, unit, task, actor_user_id, started_at)
         SELECT $1, p.project, 'user', 'invocation', 'bulk', $3, now() - (g || ' minutes')::interval
         FROM generate_series(1, 400) AS g CROSS JOIN unnest($2::uuid[]) AS p(project)`,
        [tenantA.tenant, projects, tenantA.userId],
      );
      await admin.query("ANALYZE agent_runs");
      const spy = vi.spyOn(pg.Client.prototype, "query");
      let statement: { text: string; values: unknown[] } | undefined;
      try {
        await listRows(target, { limit: "20" });
        for (const [call, params] of spy.mock.calls) {
          const text = statementText(call);
          if (
            text?.includes("FROM agent_runs") &&
            text.includes("ORDER BY r.started_at DESC") &&
            Array.isArray(params)
          ) {
            statement = { text, values: params };
          }
        }
      } finally {
        spy.mockRestore();
      }
      if (statement === undefined) throw new Error("The list statement was not sent");
      const { text, values } = statement;

      // `text` is the production statement captured above, a constant of the store with its values still bound as
      // parameters, so nothing from a request is interpolated.
      const plan = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, async (client) => {
          const { rows } = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${text}`, values);
          return rows[0]?.["QUERY PLAN"];
        }),
      );

      const nodes = planNodes(plan);
      const indexNames = nodes
        .map((node) => node["Index Name"])
        .filter((name): name is string => typeof name === "string");
      const nodeTypes = nodes.map((node) => node["Node Type"]);
      // The scan of the project's index reads in the order of the list and the probe for a later attempt uses the
      // occurrence index, so nothing groups or ranks the project's history before LIMIT, and no table is scanned
      // whole. (The answers of chat runs are sorted by their start, which no index covers: a Sort over them is
      // allowed, a Sort over the runs is checked below.)
      expect(indexNames).toContain("agent_runs_tenant_project_started_idx");
      expect(indexNames).toContain("agent_runs_occurrence_idx");
      for (const unbounded of ["WindowAgg", "Aggregate", "Unique", "Seq Scan"]) {
        expect(nodeTypes).not.toContain(unbounded);
      }
      const projectScan = ancestorsOf(plan, (node) => node["Index Name"] === "agent_runs_tenant_project_started_idx");
      const nearestLimit = projectScan.map((node) => node["Node Type"]).lastIndexOf("Limit");
      expect(nearestLimit).toBeGreaterThanOrEqual(0);
      // Between the scan of the project's runs and the LIMIT that bounds it nothing sorts them.
      expect(projectScan.slice(nearestLimit).map((node) => node["Node Type"])).not.toContain("Sort");
      expect(projectScan.slice(nearestLimit).map((node) => node["Node Type"])).not.toContain("Incremental Sort");
    });
  });
});

describe("GET /api/agent-runs of a project, retried heartbeat occurrences (issue gh-1914)", () => {
  let occurrenceCount = 0;

  interface Tick {
    projectItemId: string;
    heartbeatId: string;
  }

  async function createTick(name: string): Promise<Tick> {
    const projectItemId = await createProject();
    return { projectItemId, heartbeatId: await createNamedHeartbeat(projectItemId, name) };
  }

  /**
   * A heartbeat occurrence of `heartbeatId`. Raw SQL: only the heartbeat sweep writes occurrences, and nothing
   * else in the data layer creates one for a test to start from.
   */
  async function createOccurrence(heartbeatId: string, tenant = tenantA): Promise<string> {
    occurrenceCount += 1;
    return runInTenant(tenant.tenant, async () => {
      const { rows } = await runtime.query<{ id: string }>(
        `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
         VALUES ($1, $2::timestamptz, '{}', 'queued') RETURNING id`,
        [heartbeatId, new Date(Date.UTC(2026, 0, 1) + occurrenceCount * 60_000).toISOString()],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("The occurrence insert returned no row");
      return row.id;
    });
  }

  /** The attempts 1..`count` of one occurrence, chained as the scheduler chains them, each started a minute after the last. */
  async function createAttempts(
    tick: Tick,
    occurrenceId: string,
    count: number,
    startAt: string,
  ): Promise<AgentRunRow[]> {
    const attempts: AgentRunRow[] = [];
    for (let attempt = 1; attempt <= count; attempt += 1) {
      const previous = attempts[attempt - 2];
      const base = {
        projectItemId: tick.projectItemId,
        heartbeatId: tick.heartbeatId,
        heartbeatOccurrenceId: occurrenceId,
        triggeredBy: "heartbeat",
        task: "tick",
        attempt,
      } as const;
      const run =
        previous === undefined
          ? await runInTenant(tenantA.tenant, () => createAgentRun(runtime, { ...base, userId: tenantA.userId }))
          : await runInTenant(tenantA.tenant, () =>
              createChainedAgentRun(runtime, { ...base, retryOfRunId: previous.id }),
            );
      if (run === null) throw new Error("The retry was already taken");
      await setInstants(run.id, new Date(Date.parse(startAt) + (attempt - 1) * 60_000).toISOString());
      attempts.push(run);
    }
    return attempts;
  }

  it("lists one row for an occurrence tried three times, with the attempt number, status, error summary, start and duration of the third run", async () => {
    const tick = await createTick("Daily digest");
    const [first, second, third] = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      3,
      "2026-11-10T10:00:00.000Z",
    );
    if (first === undefined || second === undefined || third === undefined) throw new Error("Missing attempts");
    await failRun(first.id, "modelError");
    await failRun(second.id, "interrupted");
    await failRun(third.id, "budgetExceeded");
    await setInstants(first.id, "2026-11-10T10:00:00.000Z", "2026-11-10T10:00:01.000Z");
    await setInstants(second.id, "2026-11-10T10:01:00.000Z", "2026-11-10T10:01:02.000Z");
    await setInstants(third.id, "2026-11-10T10:02:00.000Z", "2026-11-10T10:02:03.000Z");

    const rows = await listRows(tick.projectItemId);

    expect(rows).toEqual([
      {
        id: third.id,
        agentRunId: third.id,
        messageId: null,
        title: "Daily digest",
        triggeredBy: "heartbeat",
        triggerLabel: "Tick",
        startedAt: "2026-11-10T10:02:00.000Z",
        durationMs: 3000,
        costUsd: 0,
        displayStatus: "error",
        errorSummary: "AI budget used up",
        attempt: 3,
        attempts: [
          {
            id: first.id,
            attempt: 1,
            startedAt: "2026-11-10T10:00:00.000Z",
            durationMs: 1000,
            costUsd: 0,
            displayStatus: "error",
          },
          {
            id: second.id,
            attempt: 2,
            startedAt: "2026-11-10T10:01:00.000Z",
            durationMs: 2000,
            costUsd: 0,
            displayStatus: "error",
          },
          {
            id: third.id,
            attempt: 3,
            startedAt: "2026-11-10T10:02:00.000Z",
            durationMs: 3000,
            costUsd: 0,
            displayStatus: "error",
          },
        ],
      },
    ]);
  });

  it("shows the status of a third attempt that finished, with no error summary", async () => {
    const tick = await createTick("Daily digest");
    const [first, second, third] = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      3,
      "2026-11-10T11:00:00.000Z",
    );
    if (first === undefined || second === undefined || third === undefined) throw new Error("Missing attempts");
    await failRun(first.id);
    await failRun(second.id);
    await closeRun(third.id);

    expect(await listRows(tick.projectItemId)).toMatchObject([
      {
        id: third.id,
        attempt: 3,
        displayStatus: "done",
        errorSummary: null,
        attempts: [{ displayStatus: "error" }, { displayStatus: "error" }, { displayStatus: "done" }],
      },
    ]);
  });

  it("sums the cost of the attempts and lists each attempt with its own cost, in attempt order", async () => {
    const tick = await createTick("Daily digest");
    const attempts = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      3,
      "2026-11-10T12:00:00.000Z",
    );
    for (const [index, cost] of [0.01, 0.02, 0.03].entries()) await recordCost(attempts[index]?.id ?? "", cost);

    const [row] = await listRows(tick.projectItemId);

    expect(row?.costUsd).toBe(0.06);
    expect(row?.attempts?.map((attempt) => [attempt.attempt, attempt.costUsd])).toEqual([
      [1, 0.01],
      [2, 0.02],
      [3, 0.03],
    ]);
  });

  it("drops the binary floating-point noise of the sum of the costs", async () => {
    const tick = await createTick("Daily digest");
    const attempts = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      2,
      "2026-11-10T12:30:00.000Z",
    );
    await recordCost(attempts[0]?.id ?? "", 0.1);
    await recordCost(attempts[1]?.id ?? "", 0.2);

    expect(0.1 + 0.2).not.toBe(0.3);
    expect((await listRows(tick.projectItemId))[0]?.costUsd).toBe(0.3);
  });

  it("reads the costs of every attempt with one statement over ai_gateway_calls whatever the number of attempts", async () => {
    const few = await createTick("Few");
    const many = await createTick("Many");
    const fewAttempts = await createAttempts(
      few,
      await createOccurrence(few.heartbeatId),
      2,
      "2026-11-10T13:00:00.000Z",
    );
    const manyAttempts = [
      ...(await createAttempts(many, await createOccurrence(many.heartbeatId), 5, "2026-11-10T13:10:00.000Z")),
      ...(await createAttempts(many, await createOccurrence(many.heartbeatId), 4, "2026-11-10T13:20:00.000Z")),
    ];
    for (const run of [...fewAttempts, ...manyAttempts]) await recordCost(run.id, 0.01);
    const gatewayStatements = async (projectItemId: string): Promise<number> => {
      const spy = vi.spyOn(pg.Client.prototype, "query");
      try {
        await listRows(projectItemId);
        return spy.mock.calls.filter(([statement]) => statementText(statement)?.includes("ai_gateway_calls") === true)
          .length;
      } finally {
        spy.mockRestore();
      }
    };

    expect(await gatewayStatements(few.projectItemId)).toBe(1);
    expect(await gatewayStatements(many.projectItemId)).toBe(1);
    expect((await listRows(many.projectItemId)).map((row) => row.costUsd)).toEqual([0.04, 0.05]);
  });

  it("returns limit rows when an occurrence with several attempts is among the newest, because it collapses before the limit", async () => {
    const tick = await createTick("Daily digest");
    const retried = await createAttempts(tick, await createOccurrence(tick.heartbeatId), 3, "2026-11-10T14:30:00.000Z");
    const others: AgentRunRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      const run = await createRun({
        projectItemId: tick.projectItemId,
        triggeredBy: "heartbeat",
        heartbeatId: tick.heartbeatId,
      });
      await setInstants(run.id, new Date(Date.parse("2026-11-10T14:00:00.000Z") + i * 60_000).toISOString());
      others.push(run);
    }
    const last = retried[2];
    if (last === undefined) throw new Error("Missing attempts");
    // The three attempts are the three newest runs, so a limit applied before the collapse would leave 3 rows.
    const store = await runInTenant(tenantA.tenant, () =>
      listProjectAgentRuns(runtime, { projectItemId: tick.projectItemId, actorUserId: tenantA.userId, limit: 5 }),
    );

    expect(store.map((run) => run.id)).toEqual([
      last.id,
      ...others
        .slice()
        .reverse()
        .slice(0, 4)
        .map((run) => run.id),
    ]);
    expect((await listRows(tick.projectItemId, { limit: "5" })).map((row) => row.id)).toEqual(
      store.map((run) => run.id),
    );
    expect(await listRows(tick.projectItemId, { limit: "6" })).toHaveLength(6);
    expect(await listRows(tick.projectItemId, { limit: "100" })).toHaveLength(6);
  });

  it("counts six occurrences as six rows whichever of them was retried", async () => {
    const tick = await createTick("Daily digest");
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const attempts = await createAttempts(
        tick,
        await createOccurrence(tick.heartbeatId),
        i === 2 ? 3 : 1,
        new Date(Date.parse("2026-11-10T15:00:00.000Z") + i * 3_600_000).toISOString(),
      );
      ids.push(attempts[attempts.length - 1]?.id ?? "");
    }

    expect((await listRows(tick.projectItemId, { limit: "5" })).map((row) => row.id)).toEqual(ids.slice(1).reverse());
    expect((await listRows(tick.projectItemId, { limit: "6" })).map((row) => row.id)).toEqual(ids.slice().reverse());
  });

  it("positions a collapsed row at the start of its latest attempt", async () => {
    const tick = await createTick("Daily digest");
    const attempts = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      3,
      "2026-11-10T16:00:00.000Z",
    );
    const between = await createRun({ projectItemId: tick.projectItemId, triggeredBy: "user" });
    await setInstants(between.id, "2026-11-10T16:01:30.000Z");
    const last = attempts[2];
    if (last === undefined) throw new Error("Missing attempts");

    // The first attempt started before `between` and the third started after it.
    expect((await listRows(tick.projectItemId)).map((row) => row.id)).toEqual([last.id, between.id]);
  });

  it("returns a run with no occurrence unchanged: attempt 1 and no attempts key", async () => {
    const tick = await createTick("Daily digest");
    const chat = await createRun({ projectItemId: tick.projectItemId, triggeredBy: "user", unit: "session" });
    const manual = await createRun({
      projectItemId: tick.projectItemId,
      triggeredBy: "heartbeat",
      heartbeatId: tick.heartbeatId,
    });
    const mcp = await createRun({ projectItemId: tick.projectItemId, triggeredBy: "mcp" });

    const rows = await listRows(tick.projectItemId);

    expect(rows.map((row) => row.id).sort()).toEqual([chat.id, manual.id, mcp.id].sort());
    for (const row of rows) {
      expect(row.attempt).toBe(1);
      expect("attempts" in row).toBe(false);
    }
  });

  it("lists an occurrence tried once with one attempt equal to the row", async () => {
    const tick = await createTick("Daily digest");
    const [only] = await createAttempts(tick, await createOccurrence(tick.heartbeatId), 1, "2026-11-10T17:00:00.000Z");
    if (only === undefined) throw new Error("Missing attempt");
    await closeRun(only.id);
    await setInstants(only.id, "2026-11-10T17:00:00.000Z", "2026-11-10T17:00:09.000Z");
    await recordCost(only.id, 0.07);

    const [row] = await listRows(tick.projectItemId);

    expect(row).toMatchObject({ id: only.id, attempt: 1, costUsd: 0.07 });
    expect(row?.attempts).toEqual([
      {
        id: only.id,
        attempt: 1,
        startedAt: row?.startedAt,
        durationMs: row?.durationMs,
        costUsd: row?.costUsd,
        displayStatus: row?.displayStatus,
      },
    ]);
    expect(row?.durationMs).toBe(9000);
  });

  it("rounds the cost of the one attempt of an occurrence as the row's, so the entry equals the row for a cost with floating-point noise", async () => {
    const tick = await createTick("Daily digest");
    const [only] = await createAttempts(tick, await createOccurrence(tick.heartbeatId), 1, "2026-11-10T17:10:00.000Z");
    if (only === undefined) throw new Error("Missing attempt");
    await closeRun(only.id);
    // 0.1 + 0.2 in a double: 17 significant digits, as a gateway that computes a cost in floating point settles it.
    await recordCost(only.id, 0.1 + 0.2);

    const [row] = await listRows(tick.projectItemId);

    expect(0.1 + 0.2).not.toBe(0.3);
    expect(row?.costUsd).toBe(0.3);
    expect(row?.attempts).toHaveLength(1);
    expect(row?.attempts?.[0]?.costUsd).toBe(row?.costUsd);
  });

  it("rounds the cost of a run with no occurrence in the same way", async () => {
    const tick = await createTick("Daily digest");
    const chat = await createRun({ projectItemId: tick.projectItemId, triggeredBy: "user" });
    await recordCost(chat.id, 0.1 + 0.2);

    expect((await listRows(tick.projectItemId))[0]?.costUsd).toBe(0.3);
  });

  it("takes the highest attempt as the latest and orders the attempts by attempt even when a higher attempt started earlier", async () => {
    const tick = await createTick("Daily digest");
    const attempts = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      3,
      "2026-11-10T17:30:00.000Z",
    );
    const [first, second, third] = attempts;
    if (first === undefined || second === undefined || third === undefined) throw new Error("Missing attempts");
    await setInstants(first.id, "2026-11-10T17:30:00.000Z");
    await setInstants(second.id, "2026-11-10T17:40:00.000Z");
    await setInstants(third.id, "2026-11-10T17:35:00.000Z");

    const rows = await listRows(tick.projectItemId);

    expect(rows.map((row) => [row.id, row.attempt, row.startedAt])).toEqual([
      [third.id, 3, "2026-11-10T17:35:00.000Z"],
    ]);
    expect(rows[0]?.attempts?.map((attempt) => [attempt.attempt, attempt.id])).toEqual([
      [1, first.id],
      [2, second.id],
      [3, third.id],
    ]);
  });

  it("keeps the later of two runs of one occurrence that have the same attempt number", async () => {
    const tick = await createTick("Daily digest");
    const occurrenceId = await createOccurrence(tick.heartbeatId);
    const heartbeatRun = () =>
      runInTenant(tenantA.tenant, () =>
        createAgentRun(runtime, {
          projectItemId: tick.projectItemId,
          heartbeatId: tick.heartbeatId,
          heartbeatOccurrenceId: occurrenceId,
          triggeredBy: "heartbeat",
          task: "tick",
          userId: tenantA.userId,
        }),
      );
    const earlier = await heartbeatRun();
    const later = await heartbeatRun();
    await setInstants(earlier.id, "2026-11-10T18:00:00.000Z");
    await setInstants(later.id, "2026-11-10T18:00:30.000Z");

    const rows = await listRows(tick.projectItemId);

    expect(rows.map((row) => row.id)).toEqual([later.id]);
    expect(rows[0]?.attempts?.map((attempt) => attempt.id)).toEqual([earlier.id, later.id]);
  });

  it("keeps the run with the greater id when two runs of one occurrence have the same attempt and start", async () => {
    const tick = await createTick("Daily digest");
    const occurrenceId = await createOccurrence(tick.heartbeatId);
    const heartbeatRun = () =>
      runInTenant(tenantA.tenant, () =>
        createAgentRun(runtime, {
          projectItemId: tick.projectItemId,
          heartbeatId: tick.heartbeatId,
          heartbeatOccurrenceId: occurrenceId,
          triggeredBy: "heartbeat",
          task: "tick",
          userId: tenantA.userId,
        }),
      );
    const runs = [await heartbeatRun(), await heartbeatRun()];
    for (const run of runs) await setInstants(run.id, "2026-11-10T18:30:00.000Z");

    expect((await listRows(tick.projectItemId)).map((row) => row.id)).toEqual([runs.map((run) => run.id).sort()[1]]);
  });

  it("does not list a delegated sub-run of the run, in the rows or among the attempts", async () => {
    const tick = await createTick("Daily digest");
    const [attempt] = await createAttempts(
      tick,
      await createOccurrence(tick.heartbeatId),
      1,
      "2026-11-10T19:00:00.000Z",
    );
    if (attempt === undefined) throw new Error("Missing attempt");
    const delegated = await runInTenant(tenantA.tenant, () =>
      createAgentRun(runtime, {
        projectItemId: tick.projectItemId,
        parentRunId: attempt.id,
        triggeredBy: "supervisor",
        task: "delegated work",
      }),
    );
    await recordCost(delegated.id, 0.5);

    const rows = await listRows(tick.projectItemId);

    expect(rows.map((row) => row.id)).toEqual([attempt.id]);
    expect(rows[0]?.attempts?.map((entry) => entry.id)).toEqual([attempt.id]);
    expect(rows[0]?.costUsd).toBe(0);
  });

  it("never merges a run of another tenant that has the same occurrence id into the rows or the attempts", async () => {
    const tick = await createTick("Daily digest");
    const occurrenceId = await createOccurrence(tick.heartbeatId);
    const attempts = await createAttempts(tick, occurrenceId, 3, "2026-11-10T20:00:00.000Z");
    for (const run of attempts) await recordCost(run.id, 0.01);
    const third = attempts[2];
    if (third === undefined) throw new Error("Missing attempts");
    // Raw fixture on the admin pool: the composite key of agent_runs refuses another tenant's occurrence, so this
    // run of tenant B, which names tenant A's project and occurrence with a higher attempt that started later,
    // can only be forged by skipping the foreign-key triggers for this one insert.
    const forged = await withTransaction(admin, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (tenant_id, project_item_id, heartbeat_occurrence_id, attempt, triggered_by, task, actor_user_id, started_at)
         VALUES ($1, $2, $3, 9, 'heartbeat', 'forged', $4, '2026-11-10T21:00:00.000Z') RETURNING id`,
        [tenantB.tenant, tick.projectItemId, occurrenceId, tenantB.userId],
      );
      return rows[0]?.id;
    });
    if (forged === undefined) throw new Error("The forged run was not inserted");

    const own = await listRows(tick.projectItemId);
    const foreign = await listRows(tick.projectItemId, { tenant: tenantB });

    expect(own.map((row) => row.id)).toEqual([third.id]);
    expect(own[0]).toMatchObject({ attempt: 3, costUsd: 0.03 });
    expect(own[0]?.attempts?.map((attempt) => attempt.id)).toEqual(attempts.map((run) => run.id));
    expect(foreign.map((row) => row.id)).toEqual([forged]);
    expect(foreign[0]?.attempts?.map((attempt) => attempt.id)).toEqual([forged]);
    expect(foreign[0]?.costUsd).toBe(0);
  });
});

describe("GET /api/agent-runs of a project, one row per chat answer (issue gh-1932)", () => {
  const setupOf = (tenant: TenantSetup): AnswerSetup => ({
    admin,
    runtime,
    tenant: tenant.tenant,
    userId: tenant.userId,
  });
  const setup = (): AnswerSetup => setupOf(tenantA);
  /** The instant `ms` milliseconds into the fixture clock, as the list writes it. */
  const at = (ms: number): string => new Date(ANSWER_CLOCK_START + ms).toISOString();

  async function chatSession(projectItemId: string, task = "Chat"): Promise<ChatSession> {
    return createChatSession(setup(), projectItemId, { task });
  }

  /** The row a finished answer of `session` with no cost, no retry and no failure has. */
  function answerRow(
    session: ChatSession,
    messageId: string,
    expected: { title: string; startMs: number; durationMs: number | null } & Partial<ListRow>,
  ): ListRow {
    const { title, startMs, durationMs, ...rest } = expected;
    return {
      id: session.runId,
      agentRunId: session.runId,
      messageId,
      title,
      triggeredBy: "user",
      triggerLabel: "Chat",
      startedAt: at(startMs),
      durationMs,
      costUsd: 0,
      displayStatus: "done",
      errorSummary: null,
      attempt: 1,
      ...rest,
    };
  }

  /** A pending approval request of the run for the tool call `toolCallId`. */
  async function requestApprovalFor(runId: string, toolCallId: string | null): Promise<void> {
    await runInTenant(tenantA.tenant, () =>
      createPendingApprovalRequest(runtime, {
        agentRunId: runId,
        toolName: "probe",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        ...(toolCallId === null ? {} : { toolCallId }),
      }),
    );
  }

  const statementsOver = async (table: string, run: () => Promise<unknown>): Promise<number> => {
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      await run();
      return spy.mock.calls.filter(([statement]) => statementText(statement)?.includes(table) === true).length;
    } finally {
      spy.mockRestore();
    }
  };

  it("lists a chat run that answered three questions as three rows, each with its question, start, duration and cost", async () => {
    const projectItemId = await createProject();
    const session = await chatSession(projectItemId, "What changed this week?");
    const first = await playAnswer(setup(), session, "What changed this week?", { startMs: 0, durationMs: 4000 });
    const second = await playAnswer(setup(), session, "Summarize the inbox", { startMs: 60_000, durationMs: 9000 });
    const third = await playAnswer(setup(), session, "Plan the release", { startMs: 120_000, durationMs: 2500 });
    await settleAnswerCall(setup(), session.runId, first.assistantMessageId, 0.01);
    await settleAnswerCall(setup(), session.runId, second.assistantMessageId, 0.02);
    await settleAnswerCall(setup(), session.runId, second.assistantMessageId, 0.03);
    await settleAnswerCall(setup(), session.runId, third.assistantMessageId, 0.04);
    // A call of the run that no message owns is part of no answer.
    await settleAnswerCall(setup(), session.runId, null, 0.5);

    expect(await listRows(projectItemId)).toEqual([
      answerRow(session, third.assistantMessageId, {
        title: "Plan the release",
        startMs: 120_000,
        durationMs: 2500,
        costUsd: 0.04,
      }),
      answerRow(session, second.assistantMessageId, {
        title: "Summarize the inbox",
        startMs: 60_000,
        durationMs: 9000,
        costUsd: 0.05,
      }),
      answerRow(session, first.assistantMessageId, {
        title: "What changed this week?",
        startMs: 0,
        durationMs: 4000,
        costUsd: 0.01,
      }),
    ]);
    expect(await listRows(projectItemId, { userId: randomUUID() })).toEqual([]);
  });

  it("orders the answers of a chat run together with the other runs of the project by start time", async () => {
    const projectItemId = await createProject();
    const session = await chatSession(projectItemId);
    const first = await playAnswer(setup(), session, "First", { startMs: 0, durationMs: 1000 });
    const second = await playAnswer(setup(), session, "Second", { startMs: 120_000, durationMs: 1000 });
    const between = await createRun({ projectItemId, triggeredBy: "heartbeat" });
    const before = await createRun({ projectItemId, triggeredBy: "mcp" });
    await setInstants(between.id, at(60_000));
    await setInstants(before.id, at(-60_000));

    expect((await listRows(projectItemId)).map((row) => [row.id, row.messageId])).toEqual([
      [session.runId, second.assistantMessageId],
      [between.id, null],
      [session.runId, first.assistantMessageId],
      [before.id, null],
    ]);
  });

  it("orders the answers that started at the same instant by message id, descending", async () => {
    const projectItemId = await createProject();
    const session = await chatSession(projectItemId);
    const answers = [
      await playAnswer(setup(), session, "One", { startMs: 5000, durationMs: 100 }),
      await playAnswer(setup(), session, "Two", { startMs: 5000, durationMs: 100 }),
      await playAnswer(setup(), session, "Three", { startMs: 5000, durationMs: 100 }),
    ];

    expect((await listRows(projectItemId)).map((row) => row.messageId)).toEqual(
      answers
        .map((answer) => answer.assistantMessageId)
        .sort()
        .reverse(),
    );
  });

  it("counts the limit in rows after the answers are expanded", async () => {
    const projectItemId = await createProject();
    const session = await chatSession(projectItemId);
    const answers = [
      await playAnswer(setup(), session, "A", { startMs: 100_000, durationMs: 10 }),
      await playAnswer(setup(), session, "B", { startMs: 200_000, durationMs: 10 }),
      await playAnswer(setup(), session, "C", { startMs: 300_000, durationMs: 10 }),
    ];
    const older = await createRun({ projectItemId, triggeredBy: "heartbeat" });
    await setInstants(older.id, at(0));
    const newest = await createRun({ projectItemId, triggeredBy: "mcp" });
    await setInstants(newest.id, at(400_000));
    const keys = (rows: ListRow[]) => rows.map((row) => row.messageId ?? row.id);
    const [a, b, c] = answers.map((answer) => answer.assistantMessageId);

    expect(keys(await listRows(projectItemId, { limit: "1" }))).toEqual([newest.id]);
    expect(keys(await listRows(projectItemId, { limit: "2" }))).toEqual([newest.id, c]);
    expect(keys(await listRows(projectItemId, { limit: "3" }))).toEqual([newest.id, c, b]);
    expect(keys(await listRows(projectItemId, { limit: "4" }))).toEqual([newest.id, c, b, a]);
    expect(keys(await listRows(projectItemId, { limit: "5" }))).toEqual([newest.id, c, b, a, older.id]);
    expect(keys(await listRows(projectItemId, { limit: "100" }))).toEqual([newest.id, c, b, a, older.id]);
    const store = await runInTenant(tenantA.tenant, () =>
      listProjectAgentRuns(runtime, { projectItemId, actorUserId: tenantA.userId, limit: 3 }),
    );
    expect(store.map((entry) => entry.answer?.messageId ?? null)).toEqual([null, c, b]);
  });

  it("lists nothing but the answers when the answers alone fill the limit", async () => {
    const projectItemId = await createProject();
    const session = await chatSession(projectItemId);
    const answers = [];
    for (let i = 0; i < 4; i += 1) {
      answers.push(await playAnswer(setup(), session, `Question ${i}`, { startMs: i * 10_000, durationMs: 10 }));
    }
    const older = await createRun({ projectItemId, triggeredBy: "heartbeat" });
    await setInstants(older.id, at(-10_000));

    expect((await listRows(projectItemId, { limit: "4" })).map((row) => row.messageId)).toEqual(
      answers.map((answer) => answer.assistantMessageId).reverse(),
    );
  });

  describe("an answer that was retried", () => {
    /** A question whose first attempt failed, with the queued retry, and the session it was asked in. */
    async function failedFirstAttempt(projectItemId: string) {
      const session = await chatSession(projectItemId);
      const first = await playAnswer(setup(), session, "Why did it fail?", {
        startMs: 0,
        durationMs: 1000,
        end: "error",
        errorCode: "modelError",
      });
      return { session, first };
    }

    it("is one row for three attempts, with attempt 3 and the start, duration, cost and status of the latest attempt", async () => {
      const projectItemId = await createProject();
      const { session, first } = await failedFirstAttempt(projectItemId);
      const secondId = await retryAnswer(setup(), session, first.assistantMessageId);
      const second = await playQueuedAnswer(setup(), session, secondId, first.userMessageId, {
        startMs: 10_000,
        durationMs: 2000,
        end: "error",
        errorCode: "interrupted",
      });
      const thirdId = await retryAnswer(setup(), session, second.assistantMessageId);
      await playQueuedAnswer(setup(), session, thirdId, first.userMessageId, { startMs: 20_000, durationMs: 3000 });
      await settleAnswerCall(setup(), session.runId, first.assistantMessageId, 0.1);
      await settleAnswerCall(setup(), session.runId, second.assistantMessageId, 0.2);
      await settleAnswerCall(setup(), session.runId, thirdId, 0.3);

      expect(await listRows(projectItemId)).toEqual([
        answerRow(session, thirdId, {
          title: "Why did it fail?",
          startMs: 20_000,
          durationMs: 3000,
          costUsd: 0.3,
          attempt: 3,
        }),
      ]);
    });

    it("shows the error summary of the latest attempt when it failed too", async () => {
      const projectItemId = await createProject();
      const { session, first } = await failedFirstAttempt(projectItemId);
      const secondId = await retryAnswer(setup(), session, first.assistantMessageId);
      await playQueuedAnswer(setup(), session, secondId, first.userMessageId, {
        startMs: 10_000,
        durationMs: 2000,
        end: "error",
        errorCode: "budgetExceeded",
      });

      expect(await listRows(projectItemId)).toEqual([
        answerRow(session, secondId, {
          title: "Why did it fail?",
          startMs: 10_000,
          durationMs: 2000,
          attempt: 2,
          displayStatus: "error",
          errorSummary: "AI budget used up",
        }),
      ]);
      expect((await listRows(projectItemId, { locale: "cs" }))[0]?.errorSummary).not.toBe("AI budget used up");
    });

    it("keeps the earlier attempt as the row while the retry is queued and has no run", async () => {
      const projectItemId = await createProject();
      const { session, first } = await failedFirstAttempt(projectItemId);
      await retryAnswer(setup(), session, first.assistantMessageId);

      expect(await listRows(projectItemId)).toEqual([
        answerRow(session, first.assistantMessageId, {
          title: "Why did it fail?",
          startMs: 0,
          durationMs: 1000,
          displayStatus: "error",
          errorSummary: "AI model error",
        }),
      ]);
    });

    it("lists the answer under the run of its latest attempt when the retry started another run, and the earlier run has no row", async () => {
      const projectItemId = await createProject();
      const { session, first } = await failedFirstAttempt(projectItemId);
      const later = await createChatSession(setup(), projectItemId, { threadId: session.threadId });
      const secondId = await retryAnswer(setup(), session, first.assistantMessageId);
      await playQueuedAnswer(setup(), later, secondId, first.userMessageId, {
        startMs: 30_000,
        durationMs: 500,
        runId: later.runId,
      });

      expect(await listRows(projectItemId)).toEqual([
        answerRow(later, secondId, { title: "Why did it fail?", startMs: 30_000, durationMs: 500, attempt: 2 }),
      ]);
    });

    it("never takes a later attempt of another tenant for the latest attempt", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const answer = await playAnswer(setup(), session, "Only attempt", { startMs: 0, durationMs: 100 });
      // Raw fixture on the admin pool: the composite keys refuse another tenant's thread and message, so this
      // assistant message of tenant B, which names tenant A's thread, question and run with attempt 9, can only be
      // forged by skipping the foreign-key triggers for this one insert.
      await withTransaction(admin, async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO semp_messages (tenant_id, thread_id, role, reply_to_message_id, agent_run_id, status, attempt)
           VALUES ($1, $2, 'assistant', $3, $4, 'done', 9)`,
          [tenantB.tenant, session.threadId, answer.userMessageId, session.runId],
        );
      });

      expect((await listRows(projectItemId)).map((row) => [row.messageId, row.attempt])).toEqual([
        [answer.assistantMessageId, 1],
      ]);
    });
  });

  describe("the title", () => {
    /** A tick thread of a new heartbeat of the project, with a chat run the user started in it. */
    async function tickSession(projectItemId: string): Promise<ChatSession> {
      const heartbeatId = await createNamedHeartbeat(projectItemId, "Morning review");
      const threadId = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, async (client) => (await getOrCreateTickThread(client, heartbeatId)).id),
      );
      return createChatSession(setup(), projectItemId, { threadId });
    }

    /** The approval outcome `key` in the tick thread and the answer to it, played as the turn handler plays it. */
    async function playApprovalOutcome(session: ChatSession, key: string, startMs: number) {
      await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, (client) =>
          insertApprovalOutcomeSystemMessage(client, session.threadId, randomUUID(), key, {}),
        ),
      );
      const { rows } = await admin.query<{ id: string }>(
        `SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant' AND status = 'queued'`,
        [session.threadId],
      );
      const queued = rows[0]?.id;
      if (queued === undefined || rows.length !== 1) throw new Error("Expected one queued assistant message");
      return playQueuedAnswer(setup(), session, queued, null, { startMs, durationMs: 100 });
    }

    it("is the localized label of the system key for an answer to an approval outcome, and a generic label for an unknown key", async () => {
      const projectItemId = await createProject();
      const session = await tickSession(projectItemId);
      const executed = await playApprovalOutcome(session, "approval.outcome.executed", 0);
      const rejected = await playApprovalOutcome(session, "approval.outcome.rejected", 10_000);
      const conflict = await playApprovalOutcome(session, "approval.outcome.conflict", 20_000);
      const unknown = await playApprovalOutcome(session, "approval.outcome.somethingNew", 30_000);
      const titles = async (locale: string) =>
        Object.fromEntries((await listRows(projectItemId, { locale })).map((row) => [row.messageId ?? "", row.title]));

      expect(await titles("en")).toEqual({
        [executed.assistantMessageId]: "Approved action carried out",
        [rejected.assistantMessageId]: "Action rejected",
        [conflict.assistantMessageId]: "Approved action could not be carried out",
        [unknown.assistantMessageId]: "Automatic follow-up",
      });
      expect(await titles("cs")).toEqual({
        [executed.assistantMessageId]: "Schválená akce provedena",
        [rejected.assistantMessageId]: "Akce zamítnuta",
        [conflict.assistantMessageId]: "Schválenou akci se nepodařilo provést",
        [unknown.assistantMessageId]: "Automatické pokračování",
      });
      expect(await titles("de")).toEqual(await titles("en"));
    });

    it("is the run's own task for an answer that replies to no message", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId, "Weekly planning");
      // Raw insert: no production write makes an assistant message that answers no message in a chat thread.
      const queued = await Promise.all(
        [0, 1].map(async () => {
          const { rows } = await admin.query<{ id: string }>(
            `INSERT INTO semp_messages (tenant_id, thread_id, role, status)
             VALUES ($1, $2, 'assistant', 'queued') RETURNING id`,
            [tenantA.tenant, session.threadId],
          );
          const id = rows[0]?.id;
          if (id === undefined) throw new Error("The fixture message was not inserted");
          return id;
        }),
      );
      for (const [index, id] of queued.entries()) {
        await playQueuedAnswer(setup(), session, id, null, { startMs: index * 10_000, durationMs: 100 });
      }

      const rows = await listRows(projectItemId);

      expect(rows.map((row) => row.messageId)).toEqual([...queued].reverse());
      expect(rows.map((row) => row.title)).toEqual(["Weekly planning", "Weekly planning"]);
      expect(rows.map((row) => row.attempt)).toEqual([1, 1]);
    });
  });

  describe("the trigger label", () => {
    it("is the label of a tick for every answer in a heartbeat tick thread, and the label of a chat in a chat thread", async () => {
      const projectItemId = await createProject();
      const heartbeatId = await createNamedHeartbeat(projectItemId, "Morning review");
      const tickThreadId = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, async (client) => (await getOrCreateTickThread(client, heartbeatId)).id),
      );
      const tick = await createChatSession(setup(), projectItemId, { threadId: tickThreadId });
      const chat = await chatSession(projectItemId);
      const tickAnswer = await playAnswer(setup(), tick, "Why did the review skip the budget?", {
        startMs: 0,
        durationMs: 100,
      });
      const chatAnswer = await playAnswer(setup(), chat, "Hello", { startMs: 10_000, durationMs: 100 });
      const labels = async (locale: string) =>
        Object.fromEntries(
          (await listRows(projectItemId, { locale })).map((row) => [
            row.messageId,
            [row.triggerLabel, row.triggeredBy],
          ]),
        );

      expect(await labels("cs")).toEqual({
        [tickAnswer.assistantMessageId]: ["Tik", "user"],
        [chatAnswer.assistantMessageId]: ["Chat", "user"],
      });
      expect(await labels("en")).toEqual({
        [tickAnswer.assistantMessageId]: ["Tick", "user"],
        [chatAnswer.assistantMessageId]: ["Chat", "user"],
      });
    });
  });

  describe("a chat run without answers", () => {
    it("stays one row titled with its first task when its thread holds no message, when it has no thread, and when its only reply is still queued", async () => {
      const projectItemId = await createProject();
      const noThread = await createRun({ projectItemId, triggeredBy: "user", unit: "session", task: "Old chat" });
      const emptyThread = await chatSession(projectItemId, "Empty chat");
      const queued = await chatSession(projectItemId, "Waiting chat");
      await askQuestion(setup(), queued, "Not answered yet");
      await setInstants(noThread.id, at(0));
      await setInstants(emptyThread.runId, at(10_000));
      await setInstants(queued.runId, at(20_000));

      expect(await listRows(projectItemId)).toEqual([
        {
          id: queued.runId,
          agentRunId: queued.runId,
          messageId: null,
          title: "Waiting chat",
          triggeredBy: "user",
          triggerLabel: "Chat",
          startedAt: expect.any(String),
          durationMs: null,
          costUsd: 0,
          displayStatus: "running",
          errorSummary: null,
          attempt: 1,
        },
        expect.objectContaining({ id: emptyThread.runId, messageId: null, title: "Empty chat" }),
        expect.objectContaining({ id: noThread.id, messageId: null, title: "Old chat" }),
      ]);
    });

    it("does not list the answers of a chat run that another user of the tenant started", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      await playAnswer(setup(), session, "Mine", { startMs: 0, durationMs: 100 });

      expect(await listRows(projectItemId)).toHaveLength(1);
      expect(await listRows(projectItemId, { userId: randomUUID() })).toEqual([]);
    });
  });

  describe("status, error and duration of an answer", () => {
    it("shows an answer whose turn is still running as running, without a duration or an error summary", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const done = await playAnswer(setup(), session, "Finished", { startMs: 0, durationMs: 100 });
      const running = await playAnswer(setup(), session, "Still working", {
        startMs: 10_000,
        durationMs: 0,
        end: "running",
      });

      expect(await listRows(projectItemId)).toEqual([
        answerRow(session, running.assistantMessageId, {
          title: "Still working",
          startMs: 10_000,
          durationMs: null,
          displayStatus: "running",
        }),
        answerRow(session, done.assistantMessageId, { title: "Finished", startMs: 0, durationMs: 100 }),
      ]);
    });

    it("shows a finished answer whose reply left a failed tool call as an error with the reason of that reply, and its sibling as done", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const incomplete = await playAnswer(setup(), session, "Search GitHub", {
        startMs: 0,
        durationMs: 1000,
        toolEvents: unavailableMcpCall(),
      });
      const complete = await playAnswer(setup(), session, "Say hello", { startMs: 10_000, durationMs: 1000 });

      expect(await listRows(projectItemId)).toMatchObject([
        { messageId: complete.assistantMessageId, displayStatus: "done", errorSummary: null },
        { messageId: incomplete.assistantMessageId, displayStatus: "error", errorSummary: "GitHub unavailable" },
      ]);
      expect(await listRows(projectItemId, { locale: "cs" })).toMatchObject([
        { messageId: complete.assistantMessageId },
        { messageId: incomplete.assistantMessageId, errorSummary: "GitHub není dostupný" },
      ]);
    });

    it("waits for approval only on the answer whose tool call asked for it", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const call = { toolCallId: "call-1", name: "database_list", operation: "database.list" };
      const asking = await playAnswer(setup(), session, "Change the project", {
        startMs: 0,
        durationMs: 1000,
        toolEvents: [toolUseEvent(call, 100), toolResultEvent(call, 200)],
      });
      const other = await playAnswer(setup(), session, "Thanks", { startMs: 10_000, durationMs: 100 });
      await requestApprovalFor(session.runId, "call-1");

      expect((await listRows(projectItemId)).map((row) => [row.messageId, row.displayStatus])).toEqual([
        [other.assistantMessageId, "done"],
        [asking.assistantMessageId, "waiting_approval"],
      ]);
    });

    it("keeps an answer waiting for approval after retention removed its events, by the steps stored on the message", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const call = { toolCallId: "call-2", name: "database_list", operation: "database.list" };
      const asking = await playAnswer(setup(), session, "Change the project", {
        startMs: 0,
        durationMs: 1000,
        toolEvents: [toolUseEvent(call, 100), toolResultEvent(call, 200)],
      });
      await requestApprovalFor(session.runId, "call-2");
      // Retention removes the tool call's event but not the steps stored on the message.
      await admin.query(
        `DELETE FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_use' AND payload->>'toolCallId' = 'call-2'`,
        [session.runId],
      );

      expect((await listRows(projectItemId)).map((row) => [row.messageId, row.displayStatus])).toEqual([
        [asking.assistantMessageId, "waiting_approval"],
      ]);
    });

    it("does not count a pending request stored without a tool call id, or one of a tool call outside the answer, for any answer", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const answer = await playAnswer(setup(), session, "Hello", { startMs: 0, durationMs: 100 });
      await requestApprovalFor(session.runId, null);
      await requestApprovalFor(session.runId, "call-of-nobody");

      expect((await listRows(projectItemId)).map((row) => [row.messageId, row.displayStatus])).toEqual([
        [answer.assistantMessageId, "done"],
      ]);
    });

    it("starts a row at the message's creation when retention removed the first event of its turn", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const answer = await playAnswer(setup(), session, "Hello", { startMs: 0, durationMs: 100 });
      const first = answer.eventIds[0];
      await admin.query("DELETE FROM agent_run_events WHERE id = $1", [first]);
      const created = await admin.query<{ created_at: Date }>("SELECT created_at FROM semp_messages WHERE id = $1", [
        answer.assistantMessageId,
      ]);

      expect((await listRows(projectItemId)).map((row) => row.startedAt)).toEqual([
        created.rows[0]?.created_at.toISOString(),
      ]);
    });
  });

  describe("cost of an answer", () => {
    it("counts a reserved call at its estimate, leaves a failed call out, and is 0 for an answer without calls", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const reserved = await playAnswer(setup(), session, "Reserved", { startMs: 0, durationMs: 10 });
      const failed = await playAnswer(setup(), session, "Failed", { startMs: 1000, durationMs: 10 });
      const free = await playAnswer(setup(), session, "Free", { startMs: 2000, durationMs: 10 });
      await runInTenant(tenantA.tenant, async () => {
        await reserveGatewayCall(runtime, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          estimatedCostUsd: 0.75,
          agentRunId: session.runId,
          sempMessageId: reserved.assistantMessageId,
        });
        const failedCall = await reserveGatewayCall(runtime, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          estimatedCostUsd: 5,
          agentRunId: session.runId,
          sempMessageId: failed.assistantMessageId,
        });
        await failGatewayCall(runtime, failedCall.id);
      });
      await settleAnswerCall(setup(), session.runId, failed.assistantMessageId, 0.25);

      expect(new Map((await listRows(projectItemId)).map((row) => [row.messageId, row.costUsd]))).toEqual(
        new Map([
          [reserved.assistantMessageId, 0.75],
          [failed.assistantMessageId, 0.25],
          [free.assistantMessageId, 0],
        ]),
      );
    });

    it("drops the binary floating-point noise of the sum of the calls", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const answer = await playAnswer(setup(), session, "Noise", { startMs: 0, durationMs: 10 });
      await settleAnswerCall(setup(), session.runId, answer.assistantMessageId, 0.1 + 0.2);

      expect(0.1 + 0.2).not.toBe(0.3);
      expect((await listRows(projectItemId))[0]?.costUsd).toBe(0.3);
    });
  });

  describe("cost statements", () => {
    it("reads the costs of all answers with one statement over ai_gateway_calls whatever the number of answers", async () => {
      const few = await createProject();
      const many = await createProject();
      const fewSession = await chatSession(few);
      const manySession = await chatSession(many);
      for (let i = 0; i < 2; i += 1) {
        const answer = await playAnswer(setup(), fewSession, `Few ${i}`, { startMs: i * 1000, durationMs: 10 });
        await settleAnswerCall(setup(), fewSession.runId, answer.assistantMessageId, 0.01);
      }
      for (let i = 0; i < 7; i += 1) {
        const answer = await playAnswer(setup(), manySession, `Many ${i}`, { startMs: i * 1000, durationMs: 10 });
        await settleAnswerCall(setup(), manySession.runId, answer.assistantMessageId, 0.01);
      }

      expect(await statementsOver("ai_gateway_calls", () => listRows(few))).toBe(1);
      expect(await statementsOver("ai_gateway_calls", () => listRows(many))).toBe(1);
      expect((await listRows(many)).filter((row) => row.costUsd === 0.01)).toHaveLength(7);
    });

    it("reads the costs of the other rows with a statement of their own beside the one of the answers", async () => {
      const projectItemId = await createProject();
      const session = await chatSession(projectItemId);
      const answer = await playAnswer(setup(), session, "Hello", { startMs: 0, durationMs: 10 });
      const run = await createRun({ projectItemId, triggeredBy: "heartbeat" });
      await settleAnswerCall(setup(), session.runId, answer.assistantMessageId, 0.02);
      await recordCost(run.id, 0.03);

      expect(await statementsOver("ai_gateway_calls", () => listRows(projectItemId))).toBe(2);
      expect(new Map((await listRows(projectItemId)).map((row) => [row.messageId ?? row.id, row.costUsd]))).toEqual(
        new Map([
          [answer.assistantMessageId, 0.02],
          [run.id, 0.03],
        ]),
      );
    });
  });

  describe("another tenant", () => {
    it("lists no answer of another tenant, and answers a project of another tenant as an unknown project", async () => {
      const projectA = await createProject();
      const projectB = await createProject(tenantB);
      const sessionA = await chatSession(projectA);
      const sessionB = await createChatSession(setupOf(tenantB), projectB);
      const answerA = await playAnswer(setup(), sessionA, "Tenant A asks", { startMs: 0, durationMs: 100 });
      const answerB = await playAnswer(setupOf(tenantB), sessionB, "Tenant B asks", { startMs: 0, durationMs: 100 });
      await settleAnswerCall(setupOf(tenantB), sessionB.runId, answerB.assistantMessageId, 0.9);

      const own = await listRows(projectA);
      const ownOfB = await listRows(projectB, { tenant: tenantB });
      const foreign = await listRows(projectA, { tenant: tenantB });
      const claimed = await listRows(projectA, { tenant: tenantB, userId: tenantA.userId });

      expect(own.map((row) => row.messageId)).toEqual([answerA.assistantMessageId]);
      expect(ownOfB.map((row) => [row.messageId, row.costUsd])).toEqual([[answerB.assistantMessageId, 0.9]]);
      expect(foreign).toEqual(await listRows(randomUUID(), { tenant: tenantB }));
      expect(foreign).toEqual([]);
      expect(claimed).toEqual([]);
      expect(await listRows(projectB)).toEqual([]);
    });
  });
});
