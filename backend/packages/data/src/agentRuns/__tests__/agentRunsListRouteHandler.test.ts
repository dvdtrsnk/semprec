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
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type EventSpec,
  type TurnSetup,
} from "../../semp/__tests__/sempReplyTestSupport.js";
import { createSempChatThread } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTestProjectItem } from "../../testSupport/projectFixtures.js";
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
      // occurrence index, so nothing sorts, groups or ranks the project's history before LIMIT.
      expect(indexNames.sort()).toEqual(["agent_runs_occurrence_idx", "agent_runs_tenant_project_started_idx"]);
      for (const unbounded of ["Sort", "Incremental Sort", "WindowAgg", "Aggregate", "Unique", "Seq Scan"]) {
        expect(nodeTypes).not.toContain(unbounded);
      }
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
