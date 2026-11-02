import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import {
  CORE_AGENT_RUN_ACTION_ID,
  coreAgentRunAction,
  createActionRegistry,
  resolveHeartbeatFireTaskName,
  type ActionRegistry,
} from "../scheduler/actions.js";
import {
  createHeartbeat,
  manualHeartbeatFireJobKey,
  occurrenceFireJobKey,
  setHeartbeatEnabled,
} from "../scheduler/schedulerStore.js";
import { createHeartbeatFireAgentTask } from "../scheduler/sweep.js";
import { createHeartbeatTriggerTool, enqueueManualHeartbeatFire } from "../scheduler/heartbeatAgentTools.js";
import { createTriggerHeartbeatRouteHandler } from "../scheduler/triggerHeartbeatRoute.js";
import {
  HeartbeatDisabledError,
  HeartbeatEventTriggeredError,
  HeartbeatRunningError,
  NotFoundError,
} from "../errors.js";

let pool: Pool;
let trigger: ReturnType<typeof createTriggerHeartbeatRouteHandler>;
/**
 * The person who presses Run. A tenant holds one user (`users_tenant_id_key`), so this is also the
 * tenant's fallback actor: the attribution assertions below show the actor, not which path chose it.
 */
let person: string;

/** Another project's id: an agent run scoped to it must not reach a heartbeat of the seeded project. */
const PROJECT_B = "22222222-2222-2222-2222-222222222222";

interface QueuedJob {
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  payload: unknown;
}

/**
 * The jobs queued under a key, read from graphile-worker's private tables (graphile-worker 0.17.3):
 * the public `jobs` view has no `payload` column, and a test must see what the worker will read.
 */
async function jobsByKey(key: string): Promise<QueuedJob[]> {
  const { rows } = await pool.query<{
    attempts: number;
    max_attempts: number;
    locked_at: Date | null;
    payload: unknown;
  }>(
    `SELECT j.attempts, j.max_attempts, j.locked_at, j.payload
     FROM graphile_worker._private_jobs j
     WHERE j.key = $1
     ORDER BY j.id`,
    [key],
  );
  return rows.map((row) => ({
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedAt: row.locked_at,
    payload: row.payload,
  }));
}

/** The job's own payload inside graphile-worker's `{ traceId, payload }` envelope (issue #167), as the task receives it. */
function innerPayloadOf(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null || !("payload" in envelope)) {
    throw new Error("queued job has no envelope");
  }
  return envelope.payload;
}

/**
 * Puts a queued job into a state only a worker produces: locked by a running attempt, or with its
 * attempts exhausted by a failed one. Test-only, on graphile-worker 0.17.3's private table, because
 * no API moves a job through those states without running a worker.
 */
async function forceJobState(key: string, state: { attempts: number; locked: boolean }): Promise<void> {
  await pool.query(
    `UPDATE graphile_worker._private_jobs
     SET attempts = $2, locked_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
     WHERE key = $1`,
    [key, state.attempts, state.locked],
  );
}

async function semprecProjectItemId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'projects') LIMIT 1",
  );
  const item = rows[0];
  if (!item) throw new Error("the seeded projects database has no item");
  return item.id;
}

async function createAgentHeartbeat(): Promise<string> {
  const projectItemId = await semprecProjectItemId();
  const heartbeat = await withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId,
      name: "Process inbox",
      rule: { kind: "interval", minutes: 5 },
      actionId: CORE_AGENT_RUN_ACTION_ID,
      actionConfig: { task: "process the inbox" },
    }),
  );
  return heartbeat.id;
}

/** `POST /api/heartbeats/:id/trigger` as the signed-in person would send it. */
function triggerAs(heartbeatId: string) {
  return trigger({ params: { id: heartbeatId }, body: {}, identity: { user: { id: person } } });
}

/** The error a refused trigger raises; fails the test if the trigger was accepted instead. */
async function refusalOf(heartbeatId: string): Promise<unknown> {
  try {
    await triggerAs(heartbeatId);
  } catch (err) {
    return err;
  }
  throw new Error("expected the trigger to be refused");
}

/** Runs the manual fire job queued for the heartbeat through the real fire task, as the agents worker does. */
async function runQueuedFire(heartbeatId: string, registry: ActionRegistry): Promise<void> {
  const [job] = await jobsByKey(manualHeartbeatFireJobKey(heartbeatId));
  if (!job) throw new Error("no manual fire job is queued for the heartbeat");
  const task = createHeartbeatFireAgentTask(pool, registry);
  const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 3 } } as Parameters<typeof task>[1];
  await task(innerPayloadOf(job.payload), helpers);
}

describe("manual heartbeat trigger over HTTP (issue #1453)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    person = (await createTenantZeroUser(pool)).id;
    trigger = createTriggerHeartbeatRouteHandler(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("answers 202 with the job key and no active run, and enqueues one job attributed to the person", async () => {
    const heartbeatId = await createAgentHeartbeat();

    const outcome = await triggerAs(heartbeatId);

    expect(outcome).toEqual({ status: 202, body: { jobKey: manualHeartbeatFireJobKey(heartbeatId), activeRun: null } });
    const jobs = await jobsByKey(manualHeartbeatFireJobKey(heartbeatId));
    expect(jobs).toHaveLength(1);
    expect(innerPayloadOf(jobs[0]!.payload)).toEqual({ heartbeatId, triggeredByUserId: person });
  });

  it("the worker creates the run with no parent run and the person as its actor", async () => {
    const heartbeatId = await createAgentHeartbeat();
    await triggerAs(heartbeatId);
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async () => ({ result: "done" })),
    );

    await runQueuedFire(heartbeatId, registry);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ parentRunId: null, triggeredBy: "heartbeat", status: "done", actorUserId: person });
  });

  it("a second trigger while the first run is running answers 409 heartbeat_running with that run, and only one run exists", async () => {
    const heartbeatId = await createAgentHeartbeat();
    await triggerAs(heartbeatId);
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async () => {
        markStarted();
        await runGate;
        return { result: "done" };
      }),
    );
    const fire = runQueuedFire(heartbeatId, registry);
    await started;
    const [running] = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(running).toMatchObject({ status: "running" });

    const refusal = await refusalOf(heartbeatId);

    expect(refusal).toBeInstanceOf(HeartbeatRunningError);
    expect(refusal).toMatchObject({
      code: "heartbeat_running",
      details: { activeRun: { id: running!.id, status: "running", triggeredBy: "heartbeat" } },
    });
    releaseRun();
    await fire;
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(1);
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toHaveLength(1);
  });

  it("a second trigger while the first is still waiting answers 409 heartbeat_running with no active run, and queues nothing new", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const key = manualHeartbeatFireJobKey(heartbeatId);
    await triggerAs(heartbeatId);
    const before = await jobsByKey(key);

    const refusal = await refusalOf(heartbeatId);

    expect(refusal).toBeInstanceOf(HeartbeatRunningError);
    expect(refusal).toMatchObject({ code: "heartbeat_running", details: { activeRun: null } });
    expect(await jobsByKey(key)).toEqual(before);
  });

  it("serializes overlapping manual enqueue checks and leaves one job", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const first = await pool.connect();
    let second;
    try {
      second = await pool.connect();
    } catch (error) {
      let releaseFailure: { error: unknown } | undefined;
      try {
        first.release();
      } catch (cleanup) {
        releaseFailure = { error: cleanup };
      }
      if (releaseFailure)
        throw new AggregateError([error, releaseFailure.error], "Enqueue setup cleanup failed", { cause: error });
      throw error;
    }
    let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query("SET LOCAL statement_timeout = '5s'");
      await second.query("SET LOCAL statement_timeout = '5s'");
      const holderPid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const contenderPid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (holderPid === undefined || contenderPid === undefined) throw new Error("Missing backend PID");
      const request = {
        heartbeatId,
        projectItemId: null,
        trigger: { triggeredByUserId: person },
        refuseWhileActive: true,
      };
      await enqueueManualHeartbeatFire(first, request);
      pending = enqueueManualHeartbeatFire(second, request).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [holderPid, contenderPid],
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await first.query("COMMIT");
      const outcome = await pending;
      pending = undefined;
      if (!("error" in outcome)) throw new Error("Second enqueue unexpectedly succeeded");
      expect(outcome.error).toBeInstanceOf(HeartbeatRunningError);
      expect(outcome.error).toMatchObject({ details: { activeRun: null } });
      await second.query("ROLLBACK");
    } catch (error) {
      failure = { error };
    }
    const errors: unknown[] = [];
    for (const client of [first, second]) {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
    }
    if (pending) {
      const outcome = await pending;
      if ("error" in outcome) errors.push(outcome.error);
    }
    for (const client of [first, second]) {
      try {
        client.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Enqueue overlap cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toHaveLength(1);
  });

  it("a waiting job whose attempts are exhausted does not block a new trigger, and the new trigger revives it", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const key = manualHeartbeatFireJobKey(heartbeatId);
    await triggerAs(heartbeatId);
    await forceJobState(key, { attempts: 3, locked: false });

    const outcome = await triggerAs(heartbeatId);

    expect(outcome).toEqual({ status: 202, body: { jobKey: key, activeRun: null } });
    const jobs = await jobsByKey(key);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ attempts: 0 });
  });

  it("a job a worker holds locked on its final attempt blocks a new trigger, even before its run exists", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const key = manualHeartbeatFireJobKey(heartbeatId);
    await triggerAs(heartbeatId);
    await forceJobState(key, { attempts: 3, locked: true });

    const refusal = await refusalOf(heartbeatId);

    expect(refusal).toBeInstanceOf(HeartbeatRunningError);
    expect(refusal).toMatchObject({ code: "heartbeat_running", details: { activeRun: null } });
    expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(0);
  });

  it("a scheduled occurrence fire waiting for the heartbeat blocks a manual trigger", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const occurrenceId = randomUUID();
    await enqueueJob(
      pool,
      resolveHeartbeatFireTaskName(CORE_AGENT_RUN_ACTION_ID),
      { heartbeatId, occurrenceId, generation: 1 },
      { jobKey: occurrenceFireJobKey(heartbeatId, occurrenceId, 1), maxAttempts: 3 },
    );

    const refusal = await refusalOf(heartbeatId);

    expect(refusal).toBeInstanceOf(HeartbeatRunningError);
    expect(refusal).toMatchObject({ code: "heartbeat_running", details: { activeRun: null } });
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toHaveLength(0);
  });

  it("answers 409 heartbeat_disabled for a disabled heartbeat and enqueues nothing", async () => {
    const heartbeatId = await createAgentHeartbeat();
    await withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeatId, false));

    const refusal = await refusalOf(heartbeatId);

    expect(refusal).toBeInstanceOf(HeartbeatDisabledError);
    expect(refusal).toMatchObject({ code: "heartbeat_disabled", status: 409 });
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toHaveLength(0);
  });

  it("answers 409 heartbeat_event_triggered for an onItemEvent heartbeat and enqueues nothing", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
    const database = rows[0];
    if (!database) throw new Error("the seeded projects database is missing");
    const projectItemId = await semprecProjectItemId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "On create",
        rule: { kind: "onItemEvent", databaseId: database.id, event: "create" },
        actionId: CORE_AGENT_RUN_ACTION_ID,
      }),
    );

    const refusal = await refusalOf(heartbeat.id);

    expect(refusal).toBeInstanceOf(HeartbeatEventTriggeredError);
    expect(refusal).toMatchObject({ code: "heartbeat_event_triggered" });
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeat.id))).toHaveLength(0);
  });

  it("answers 404 not_found for an unknown id, and 400 validation_failed for a malformed one, before any lookup", async () => {
    const unknownId = randomUUID();
    expect(await refusalOf(unknownId)).toBeInstanceOf(NotFoundError);
    expect(await jobsByKey(manualHeartbeatFireJobKey(unknownId))).toHaveLength(0);

    await expect(
      trigger({ params: { id: "not-a-uuid" }, body: {}, identity: { user: { id: person } } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("the agent tool keeps its earlier results: it enqueues while a run is running and merges a repeat into a waiting job", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const projectItemId = await semprecProjectItemId();
    await createAgentRun(pool, { projectItemId, heartbeatId, triggeredBy: "heartbeat", task: "running now" });
    const firstCaller = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "trigger" });
    const secondCaller = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "trigger again" });
    const heartbeatTrigger = createHeartbeatTriggerTool(pool);

    const first = await heartbeatTrigger(firstCaller.id, { heartbeatId });
    const second = await heartbeatTrigger(secondCaller.id, { heartbeatId });

    expect(first).toEqual({ error: false, result: JSON.stringify({ heartbeatId }) });
    expect(second).toEqual({ error: false, result: JSON.stringify({ heartbeatId }) });
    const jobs = await jobsByKey(manualHeartbeatFireJobKey(heartbeatId));
    expect(jobs).toHaveLength(1);
    expect(innerPayloadOf(jobs[0]!.payload)).toEqual({ heartbeatId, triggeredByRunId: secondCaller.id });
  });

  it("the agent tool answers a heartbeat outside the calling run's project as not found, and enqueues nothing", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const otherProjectRun = await createAgentRun(pool, {
      projectItemId: PROJECT_B,
      triggeredBy: "user",
      task: "from elsewhere",
    });

    const outcome = await createHeartbeatTriggerTool(pool)(otherProjectRun.id, { heartbeatId });

    expect(outcome).toEqual({ error: true, result: `Heartbeat ${heartbeatId} not found` });
    expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toHaveLength(0);
  });

  it("a fire payload carrying both triggeredByRunId and triggeredByUserId is refused with validation_failed", async () => {
    const heartbeatId = await createAgentHeartbeat();
    const task = createHeartbeatFireAgentTask(pool, createActionRegistry());
    const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 3 } } as Parameters<typeof task>[1];

    await expect(
      task({ heartbeatId, triggeredByRunId: randomUUID(), triggeredByUserId: person }, helpers),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
