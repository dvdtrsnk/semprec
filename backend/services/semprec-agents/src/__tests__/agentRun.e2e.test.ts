import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { SempConversation } from "@semprec/agent-runtime";
import { runInTenant } from "@semprec/shared";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createUser,
  finishAgentRun,
  getAgentRun,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import { createGatewayModel, type GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";

/**
 * Lets a test run code while a run's session is being composed — to fail the composition, or to
 * close the run in the gap before the handler claims it. Unset, the real composition runs as is.
 */
const composition = vi.hoisted(() => ({ during: undefined as ((agentRunId: string) => Promise<void>) | undefined }));

vi.mock("../agentSessionComposition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentSessionComposition.js")>();
  return {
    ...actual,
    createAgentSessionFactoryForRun: async (...args: Parameters<typeof actual.createAgentSessionFactoryForRun>) => {
      await composition.during?.(args[3].id);
      return actual.createAgentSessionFactoryForRun(...args);
    },
  };
});

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

let pool: Pool;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;
let faux: FauxProviderHandle;
let fauxGateway: GatewayModel;
let requestHeaders: Record<string, string | null>[];

async function jobCount(taskName: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [taskName],
  );
  return Number(rows[0]?.count ?? 0);
}

async function runRow(id: string): Promise<{ status: string; result: string | null }> {
  const { rows } = await pool.query<{ status: string; result: string | null }>(
    `SELECT status, result FROM agent_runs WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function runEvents(id: string): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
    `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id`,
    [id],
  );
  return rows;
}

async function errorNotificationCount(runId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1`,
    [runId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The Semprec project item `seedSystem` creates — the project the directly created runs belong to. */
async function seededSemprecProjectItemId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'`);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/**
 * The seeded `core.agentRun` heartbeat (the `newEmail` rule) and the project that owns it — the
 * Email project, not Semprec, since a heartbeat fire opens its run for the heartbeat's own project.
 */
async function seededAgentHeartbeat(): Promise<{ id: string; projectItemId: string }> {
  const { rows } = await pool.query<{ id: string; project_item_id: string }>(
    `SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1`,
    [CORE_AGENT_RUN_ACTION_ID],
  );
  expect(rows).toHaveLength(1);
  return { id: rows[0]!.id, projectItemId: rows[0]!.project_item_id };
}

describe("agent sessions in semprec-agents (issue #647)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    registry ??= await loadFullModuleRegistry();
    await resetDatabase(pool);
    await seedSystem(pool);
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused", tenantId: getTenantZeroId() });
    runtime = undefined;
    composition.during = undefined;

    faux = fauxProvider();
    requestHeaders = [];
    const streamFn: StreamFn = (model, context, options) => {
      requestHeaders.push({ ...options?.headers });
      return faux.provider.streamSimple(model, context, options);
    };
    fauxGateway = { model: faux.getModel(), streamFn, isBudgetRefusal: () => false };
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startRuntime(): Promise<void> {
    runtime = await createAgentsQueueRuntime(pool, registry, {
      runAgent: createRunAgentForHeartbeats(pool, registry, fauxGateway, createInFlightAgentRuns()),
      agentRunTask: createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns()),
      delegatedAgentRunTask: createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns()),
    });
  }

  it("runs a queued agentRun job's session and closes the row as done with the model's text", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "done", result: "Hello from the agent." });
    const events = await runEvents(run.id);
    expect(events.map((event) => event.kind)).toEqual([
      "run_status",
      "user_message",
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[0]?.payload).toMatchObject({ status: "running" });
    expect(events[5]?.payload).toMatchObject({ status: "done" });
    expect(requestHeaders).toEqual([expect.objectContaining({ "x-semprec-agent-run-id": run.id })]);
    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.AGENT_RUN)) === 0);
  });

  it("persists each validated turn's own refs before prompting in a composed conversation", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const thread = { kind: "chat" as const, threadId: rows[0]!.id };
    const ref = { kind: "item" as const, itemId: randomUUID(), databaseId: randomUUID(), label: "At send" };
    const secondRef = { kind: "block" as const, itemId: randomUUID(), blockId: randomUUID(), label: "Block" };
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => projectItemId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(pool, registry, fauxGateway, run),
    });
    const starts: string[] = [];
    try {
      const malformed: unknown = { ...ref, expanded: "expanded-secret-sentinel" };
      await expect(
        runInTenant(getTenantZeroId(), () =>
          // @ts-expect-error Exercise invalid input crossing the conversation boundary.
          conversation.send("invalid", thread, { context: [malformed] }),
        ),
      ).rejects.toThrow("Invalid user turn context");
      expect(requestHeaders).toHaveLength(0);
      const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_run_events");
      expect(before.rows[0]?.count).toBe("0");
      const send = (text: string, context?: (typeof ref)[] | (typeof secondRef)[]) =>
        runInTenant(getTenantZeroId(), () =>
          conversation.send(text, thread, {
            context,
            onTurnStart: async ({ agentRunId, firstEventId }) => {
              const events = await runEvents(agentRunId);
              expect(events.at(-1)).toMatchObject({ kind: "user_message", payload: { text, context: context ?? [] } });
              expect(requestHeaders).toHaveLength(starts.length);
              starts.push(firstEventId);
            },
          }),
        );
      await send("first", [ref]);
      await send("second", [secondRef]);
      await send("third");
      expect(starts).toHaveLength(3);
      expect(requestHeaders).toHaveLength(3);
    } finally {
      conversation.clear();
    }
  });

  it("closes the row as error with one agent_run_error notification when the model call fails", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "error", result: "gateway refused: budget" });
    const events = await runEvents(run.id);
    expect(events.at(-1)).toMatchObject({ kind: "run_status", payload: { status: "error" } });
    expect(await errorNotificationCount(run.id)).toBe(1);
  });

  it("closes a composed run with the budget code after a gateway HTTP refusal", async () => {
    const gatewayServer = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/json", "x-semprec-error-code": "budget_exceeded" });
        res.end(JSON.stringify({ error: "response-secret-sentinel" }));
      });
    });
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = gatewayServer.address() as AddressInfo;
      const gateway = createGatewayModel({
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
        AI_GATEWAY_INTERNAL_TOKEN: "credential-secret-sentinel",
        AGENT_MODEL: "test-model",
      });
      const projectItemId = await seededSemprecProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "request-secret-sentinel" });
      const task = createAgentRunTask(pool, registry, gateway, createInFlightAgentRuns());
      await expect(
        runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
      ).rejects.toThrow("AI budget exceeded");
      expect(await getAgentRun(pool, run.id)).toMatchObject({
        status: "error",
        errorCode: "budgetExceeded",
        result: "AI budget exceeded",
      });
    } finally {
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("keeps budget classification isolated across overlapping composed runs", async () => {
    const pending: { runId: string | undefined; response: import("node:http").ServerResponse }[] = [];
    let refusedRunId = "";
    const gatewayServer = createServer((req, res) => {
      const deadline = setTimeout(() => res.destroy(), 3000);
      res.once("close", () => clearTimeout(deadline));
      req.resume();
      req.on("end", () => {
        const header = req.headers["x-semprec-agent-run-id"];
        pending.push({ runId: typeof header === "string" ? header : undefined, response: res });
        if (pending.length !== 2) return;
        for (const request of pending) {
          const refused = request.runId === refusedRunId;
          request.response.writeHead(refused ? 403 : 500, {
            "content-type": "application/json",
            ...(refused ? { "x-semprec-error-code": "budget_exceeded" } : {}),
          });
          request.response.end(JSON.stringify({ error: "provider-response-sentinel" }));
        }
      });
    });
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = gatewayServer.address() as AddressInfo;
      const gateway = createGatewayModel({
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
        AI_GATEWAY_INTERNAL_TOKEN: "credential-sentinel",
        AGENT_MODEL: "test-model",
      });
      const projectItemId = await seededSemprecProjectItemId();
      const refused = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "first" });
      const failed = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "second" });
      refusedRunId = refused.id;
      const task = createAgentRunTask(pool, registry, gateway, createInFlightAgentRuns());
      const outcomes = await Promise.allSettled(
        [refused.id, failed.id].map((id) =>
          runInTenant(getTenantZeroId(), () => task({ agentRunId: id }, { job: { id } })),
        ),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(pending.map(({ runId }) => runId).sort()).toEqual([refused.id, failed.id].sort());
      expect(await getAgentRun(pool, refused.id)).toMatchObject({
        errorCode: "budgetExceeded",
        result: "AI budget exceeded",
      });
      expect(await getAgentRun(pool, failed.id)).toMatchObject({ errorCode: "modelError" });
    } finally {
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("writes nothing for a job naming a run that is no longer running", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    await finishAgentRun(pool, run.id, "done", "earlier result");
    faux.setResponses([fauxAssistantMessage("must not run")]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.DELEGATED_AGENT_RUN)) === 0);
    expect(await runRow(run.id)).toEqual({ status: "done", result: "earlier result" });
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("closes the row as error with the composition error when the session cannot be composed", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async () => {
      throw new Error("mcp grants unavailable");
    };
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await expect(
      runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
    ).rejects.toThrow("mcp grants unavailable");

    expect(await runRow(run.id)).toEqual({ status: "error", result: "mcp grants unavailable" });
    expect(await errorNotificationCount(run.id)).toBe(1);
    const events = await runEvents(run.id);
    expect(events).toEqual([{ kind: "run_status", payload: { kind: "run_status", status: "error" } }]);
    expect(requestHeaders).toEqual([]);
  });

  it("writes no error event for a run closed elsewhere before its failed composition closes it", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async (agentRunId) => {
      await finishAgentRun(pool, agentRunId, "done", "closed elsewhere");
      throw new Error("mcp grants unavailable");
    };
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await expect(
      runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
    ).rejects.toThrow("mcp grants unavailable");

    expect(await runRow(run.id)).toEqual({ status: "done", result: "closed elsewhere" });
    expect(await errorNotificationCount(run.id)).toBe(0);
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("writes nothing for a run closed while its session was being composed", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async (agentRunId) => {
      await finishAgentRun(pool, agentRunId, "done", "closed elsewhere");
    };
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));

    expect(await runRow(run.id)).toEqual({ status: "done", result: "closed elsewhere" });
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("runs the seeded core.agentRun heartbeat's session through coreAgentRunAction", async () => {
    const heartbeat = await seededAgentHeartbeat();
    // A manual (`triggeredByRunId`) fire skips the seeded rule's item-relation filter, which only
    // applies to an item-triggered fire.
    const parentRun = await createAgentRun(pool, {
      projectItemId: heartbeat.projectItemId,
      triggeredBy: "user",
      task: "trigger the newEmail heartbeat",
    });
    faux.setResponses([fauxAssistantMessage("Triaged the new email.")]);

    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
        heartbeatId: heartbeat.id,
        triggeredByRunId: parentRun.id,
      }),
    );

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT)) === 0);
    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE heartbeat_id = $1`,
      [heartbeat.id],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "done", result: "Triaged the new email." });
    const events = await runEvents(runs[0]!.id);
    expect(events.map((event) => event.kind)).toEqual([
      "run_status",
      "user_message",
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[5]?.payload).toMatchObject({ status: "done" });

    const { rows: heartbeats } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM project_heartbeats WHERE id = $1`,
      [heartbeat.id],
    );
    expect(heartbeats[0]?.last_error).toBeNull();
  });

  /**
   * Fires the seeded heartbeat as a single-attempt job, so its one failure is the final attempt that
   * records `last_error`, then returns the one run it opened and that `last_error`.
   */
  async function fireFailingHeartbeat(): Promise<{
    run: { id: string; status: string; result: string | null };
    lastError: string | null;
  }> {
    const heartbeat = await seededAgentHeartbeat();
    const parentRun = await createAgentRun(pool, {
      projectItemId: heartbeat.projectItemId,
      triggeredBy: "user",
      task: "trigger the newEmail heartbeat",
    });

    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(
        pool,
        AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT,
        { heartbeatId: heartbeat.id, triggeredByRunId: parentRun.id },
        { maxAttempts: 1 },
      ),
    );

    const lastError = async (): Promise<string | null> => {
      const { rows } = await pool.query<{ last_error: string | null }>(
        `SELECT last_error FROM project_heartbeats WHERE id = $1`,
        [heartbeat.id],
      );
      return rows[0]?.last_error ?? null;
    };
    await waitFor(async () => (await lastError()) !== null);
    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE heartbeat_id = $1`,
      [heartbeat.id],
    );
    expect(runs).toHaveLength(1);
    return { run: runs[0]!, lastError: await lastError() };
  }

  it("closes a heartbeat run as error with the composition error when its session cannot be composed", async () => {
    composition.during = async () => {
      throw new Error("mcp grants unavailable");
    };

    const { run, lastError } = await fireFailingHeartbeat();

    expect(run).toMatchObject({ status: "error", result: "mcp grants unavailable" });
    expect(lastError).toBe("mcp grants unavailable");
    expect(await errorNotificationCount(run.id)).toBe(1);
    expect(await runEvents(run.id)).toEqual([{ kind: "run_status", payload: { kind: "run_status", status: "error" } }]);
    expect(requestHeaders).toEqual([]);
  });

  it("closes a heartbeat run as error with the model's error when the model call fails", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    const { run, lastError } = await fireFailingHeartbeat();

    expect(run).toMatchObject({ status: "error", result: "gateway refused: budget" });
    expect(lastError).toBe("gateway refused: budget");
    expect(await errorNotificationCount(run.id)).toBe(1);
    const events = await runEvents(run.id);
    expect(events[0]).toMatchObject({ kind: "run_status", payload: { status: "running" } });
    expect(events.at(-1)).toMatchObject({ kind: "run_status", payload: { status: "error" } });
    expect(events.filter((event) => event.kind === "run_status")).toHaveLength(2);
    expect(requestHeaders).toEqual([expect.objectContaining({ "x-semprec-agent-run-id": run.id })]);
  });
});
