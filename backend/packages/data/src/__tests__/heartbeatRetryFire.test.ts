import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createTenantZeroUser, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getLatestRunOfOccurrence, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import {
  CORE_AGENT_RUN_ACTION_ID,
  coreAgentRunAction,
  createActionRegistry,
  type ActionRegistry,
} from "../scheduler/actions.js";
import {
  createHeartbeat,
  getHeartbeatOccurrenceStatus,
  manualHeartbeatFireJobKey,
  retryHeartbeatFireJobKey,
} from "../scheduler/schedulerStore.js";
import { createHeartbeatFireAgentTask } from "../scheduler/sweep.js";
import { enqueueManualHeartbeatFire } from "../scheduler/heartbeatAgentTools.js";
import { ValidationError } from "../errors.js";

let pool: Pool;
let person: string;

interface QueuedJob {
  task: string;
  queueName: string | null;
  maxAttempts: number;
  payload: unknown;
}

/**
 * The jobs queued under a key with the task and queue they run on and the payload the task will read,
 * from graphile-worker 0.17.3's private tables: the public `jobs` view has no payload and no queue name.
 */
async function jobsByKey(key: string): Promise<QueuedJob[]> {
  const { rows } = await pool.query<{
    identifier: string;
    queue_name: string | null;
    max_attempts: number;
    payload: unknown;
  }>(
    `SELECT t.identifier, jq.queue_name, j.max_attempts, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE j.key = $1
     ORDER BY j.id`,
    [key],
  );
  return rows.map((row) => ({
    task: row.identifier,
    queueName: row.queue_name,
    maxAttempts: row.max_attempts,
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

async function createAgentHeartbeat(): Promise<{ heartbeatId: string; projectItemId: string }> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'projects') LIMIT 1",
  );
  const projectItemId = rows[0]?.id;
  if (!projectItemId) throw new Error("the seeded projects database has no item");
  const heartbeat = await withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId,
      name: "Process inbox",
      rule: { kind: "interval", minutes: 5 },
      actionId: CORE_AGENT_RUN_ACTION_ID,
      actionConfig: { task: "process the inbox" },
    }),
  );
  return { heartbeatId: heartbeat.id, projectItemId };
}

/** The failed run of a new occurrence: raw SQL for the occurrence, because only the sweep inserts one and it needs a due rule. */
async function failedRunOfOccurrence(
  heartbeatId: string,
  projectItemId: string,
): Promise<{ runId: string; occurrenceId: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
     VALUES ($1, now(), '{}', 'failed') RETURNING id`,
    [heartbeatId],
  );
  const occurrenceId = rows[0]!.id;
  const failing = coreAgentRunAction(pool, async () => {
    throw new Error("model failed");
  });
  await expect(
    failing(
      { task: "process the inbox" },
      { heartbeatId, projectItemId, occurrenceId, attempt: 1, isFinalAttempt: true },
    ),
  ).rejects.toThrow("model failed");
  const run = await getLatestRunOfOccurrence(pool, occurrenceId);
  if (!run) throw new Error("the failing attempt created no run");
  return { runId: run.id, occurrenceId };
}

function agentRegistry(runAgent: Parameters<typeof coreAgentRunAction>[1]): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction(pool, runAgent));
  return registry;
}

describe("the fire of a heartbeat run's retry (issue #1908)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    person = (await createTenantZeroUser(pool)).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("getHeartbeatOccurrenceStatus", () => {
    it.each(["queued", "running", "succeeded", "failed", "cancelled"] as const)(
      "reads the status %s of an occurrence",
      async (status) => {
        const { heartbeatId } = await createAgentHeartbeat();
        // Raw SQL: only the sweep inserts an occurrence, and it does so for a due rule at a time the test cannot set.
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
           VALUES ($1, now(), '{}', $2) RETURNING id`,
          [heartbeatId, status],
        );

        expect(await getHeartbeatOccurrenceStatus(pool, rows[0]!.id)).toBe(status);
      },
    );

    it("throws for an occurrence that does not exist instead of guessing a status", async () => {
      await expect(getHeartbeatOccurrenceStatus(pool, "00000000-0000-4000-8000-0000000000bb")).rejects.toThrow(
        "Expected exactly one row from heartbeat_occurrences row, got none",
      );
    });
  });

  describe("enqueueManualHeartbeatFire", () => {
    it("queues the retry payload on the agent-run lane under the given key with the given attempts", async () => {
      const { heartbeatId, projectItemId } = await createAgentHeartbeat();
      const { runId } = await failedRunOfOccurrence(heartbeatId, projectItemId);

      const queued = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          enqueueManualHeartbeatFire(client, {
            heartbeatId,
            projectItemId: null,
            trigger: { retryOfRunId: runId },
            refuseWhileActive: false,
            jobKey: retryHeartbeatFireJobKey(runId),
            maxAttempts: 1,
          }),
        ),
      );

      expect(queued).toEqual({ heartbeatId, jobKey: `heartbeat-fire:retry:${runId}` });
      const jobs = await jobsByKey(retryHeartbeatFireJobKey(runId));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        task: "heartbeatFireAgent",
        queueName: `agent-run:${getTenantZeroId()}`,
        maxAttempts: 1,
      });
      expect(innerPayloadOf(jobs[0]!.payload)).toEqual({ heartbeatId, retryOfRunId: runId });
      expect(await jobsByKey(manualHeartbeatFireJobKey(heartbeatId))).toEqual([]);
    });

    it("keeps the manual key and three attempts for a caller that gives neither", async () => {
      const { heartbeatId } = await createAgentHeartbeat();

      const queued = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          enqueueManualHeartbeatFire(client, {
            heartbeatId,
            projectItemId: null,
            trigger: { triggeredByUserId: person },
            refuseWhileActive: false,
          }),
        ),
      );

      expect(queued.jobKey).toBe(manualHeartbeatFireJobKey(heartbeatId));
      const jobs = await jobsByKey(queued.jobKey);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.maxAttempts).toBe(3);
    });
  });

  describe("the heartbeat fire task", () => {
    it("starts the retry of the run in `retryOfRunId` and no other run", async () => {
      const { heartbeatId, projectItemId } = await createAgentHeartbeat();
      const { runId, occurrenceId } = await failedRunOfOccurrence(heartbeatId, projectItemId);
      const task = createHeartbeatFireAgentTask(
        pool,
        agentRegistry(async () => ({ result: "recovered" })),
      );
      const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];

      await task({ heartbeatId, retryOfRunId: runId }, helpers);

      const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
      expect(runs).toHaveLength(2);
      expect(await getLatestRunOfOccurrence(pool, occurrenceId)).toMatchObject({
        attempt: 2,
        retryOfRunId: runId,
        status: "done",
      });
    });

    it("fails the job of a retry that fails, with the job's single attempt as the final one", async () => {
      const { heartbeatId, projectItemId } = await createAgentHeartbeat();
      const { runId } = await failedRunOfOccurrence(heartbeatId, projectItemId);
      const task = createHeartbeatFireAgentTask(
        pool,
        agentRegistry(async () => {
          throw new Error("model failed again");
        }),
      );
      const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];

      await expect(task({ heartbeatId, retryOfRunId: runId }, helpers)).rejects.toThrow("model failed again");

      const { rows } = await pool.query<{ source_id: string }>(
        "SELECT source_id FROM notifications WHERE kind = 'agent_run_error' ORDER BY created_at",
      );
      const retry = await pool.query<{ id: string }>("SELECT id FROM agent_runs WHERE retry_of_run_id = $1", [runId]);
      expect(rows.map((row) => row.source_id)).toContain(retry.rows[0]!.id);
      expect(rows).toHaveLength(2);
    });

    it("refuses a payload with the retry key and another discriminator, and runs nothing", async () => {
      const { heartbeatId, projectItemId } = await createAgentHeartbeat();
      const { runId } = await failedRunOfOccurrence(heartbeatId, projectItemId);
      const runAgent = vi.fn(async () => undefined);
      const task = createHeartbeatFireAgentTask(pool, agentRegistry(runAgent));
      const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];

      const refusal = task({ heartbeatId, retryOfRunId: runId, triggeredByUserId: person }, helpers);

      await expect(refusal).rejects.toBeInstanceOf(ValidationError);
      await expect(refusal).rejects.toMatchObject({ code: "validation_failed" });
      expect(runAgent).not.toHaveBeenCalled();
      expect(await listAgentRunsByHeartbeat(pool, heartbeatId)).toHaveLength(1);
    });

    it("refuses a payload with a `retryOfRunId` that is not a string", async () => {
      const { heartbeatId } = await createAgentHeartbeat();
      const task = createHeartbeatFireAgentTask(
        pool,
        agentRegistry(async () => undefined),
      );
      const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];

      await expect(task({ heartbeatId, retryOfRunId: 42 }, helpers)).rejects.toThrow(
        "heartbeat fire job payload field 'retryOfRunId' must be a string when present",
      );
    });

    it("refuses a payload without any discriminator", async () => {
      const { heartbeatId } = await createAgentHeartbeat();
      const task = createHeartbeatFireAgentTask(
        pool,
        agentRegistry(async () => undefined),
      );
      const helpers = { job: { id: "job-1", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];

      await expect(task({ heartbeatId }, helpers)).rejects.toMatchObject({ code: "validation_failed" });
    });
  });
});
