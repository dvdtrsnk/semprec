import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createUser,
  finishAgentRun,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";

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

/** The seeded `core.agentRun` heartbeat (the `newEmail` rule) and the Semprec project it belongs to. */
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
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused" });
    runtime = undefined;

    faux = fauxProvider();
    requestHeaders = [];
    const streamFn: StreamFn = (model, context, options) => {
      requestHeaders.push({ ...options?.headers });
      return faux.provider.streamSimple(model, context, options);
    };
    fauxGateway = { model: faux.getModel(), streamFn };
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startRuntime(): Promise<void> {
    runtime = await createAgentsQueueRuntime(pool, registry, {
      runAgent: createRunAgentForHeartbeats(pool, registry, fauxGateway),
      agentRunTask: createAgentRunTask(pool, registry, fauxGateway),
      delegatedAgentRunTask: createAgentRunTask(pool, registry, fauxGateway),
    });
  }

  it("runs a queued agentRun job's session and closes the row as done with the model's text", async () => {
    const { projectItemId } = await seededAgentHeartbeat();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);

    await startRuntime();
    await enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id });

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "done", result: "Hello from the agent." });
    const events = await runEvents(run.id);
    expect(events.map((event) => event.kind)).toEqual([
      "run_status",
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[0]?.payload).toMatchObject({ status: "running" });
    expect(events[4]?.payload).toMatchObject({ status: "done" });
    expect(requestHeaders).toEqual([expect.objectContaining({ "x-semprec-agent-run-id": run.id })]);
    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.AGENT_RUN)) === 0);
  });

  it("closes the row as error with one agent_run_error notification when the model call fails", async () => {
    const { projectItemId } = await seededAgentHeartbeat();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    await startRuntime();
    await enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id });

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "error", result: "gateway refused: budget" });
    const events = await runEvents(run.id);
    expect(events.at(-1)).toMatchObject({ kind: "run_status", payload: { status: "error" } });
    expect(await errorNotificationCount(run.id)).toBe(1);
  });

  it("writes nothing for a job naming a run that is no longer running", async () => {
    const { projectItemId } = await seededAgentHeartbeat();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    await finishAgentRun(pool, run.id, "done", "earlier result");
    faux.setResponses([fauxAssistantMessage("must not run")]);

    await startRuntime();
    await enqueueJob(pool, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN, { agentRunId: run.id });

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.DELEGATED_AGENT_RUN)) === 0);
    expect(await runRow(run.id)).toEqual({ status: "done", result: "earlier result" });
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
    await enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
      heartbeatId: heartbeat.id,
      triggeredByRunId: parentRun.id,
    });

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
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[4]?.payload).toMatchObject({ status: "done" });

    const { rows: heartbeats } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM project_heartbeats WHERE id = $1`,
      [heartbeat.id],
    );
    expect(heartbeats[0]?.last_error).toBeNull();
  });
});
