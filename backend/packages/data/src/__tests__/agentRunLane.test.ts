import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob, registerTask, runWorker, type Runner, type TaskList } from "@semprec/queue";
import { currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import {
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { resolveAgentRunLane } from "../scheduler/actions.js";
import {
  createHeartbeat,
  heartbeatFireJobKey,
  manualHeartbeatFireJobKey,
  occurrenceFireJobKey,
  sweepDueHeartbeats,
} from "../scheduler/schedulerStore.js";
import { createHeartbeatTriggerTool } from "../scheduler/heartbeatAgentTools.js";
import { SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "../inbox/inboxTickKeys.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

interface FireJobRow {
  task: string;
  key: string;
  queue_name: string | null;
  max_attempts: number;
}

/** Every pending heartbeat fire job, read the way `inboxTick.test.ts` reads `queue_name`. */
async function fireJobs(): Promise<FireJobRow[]> {
  const { rows } = await pool.query<FireJobRow>(
    `SELECT t.identifier AS task, j.key, jq.queue_name, j.max_attempts
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE t.identifier IN ('heartbeatFireAgent', 'heartbeatFireCore')
     ORDER BY j.key`,
  );
  return rows;
}

async function createIntervalHeartbeat(actionId: string): Promise<string> {
  const heartbeat = await withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId: PROJECT,
      name: `Heartbeat ${actionId}`,
      rule: { kind: "interval", minutes: 5 },
      actionId,
    }),
  );
  return heartbeat.id;
}

async function makeDue(heartbeatId: string): Promise<void> {
  await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
    heartbeatId,
  ]);
}

async function occurrenceOf(heartbeatId: string): Promise<{ id: string; generation: number }> {
  const { rows } = await pool.query<{ id: string; generation: number }>(
    "SELECT id, generation FROM heartbeat_occurrences WHERE heartbeat_id = $1",
    [heartbeatId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("resolveAgentRunLane", () => {
  it("gives each tenant its own agent-run lane for core.agentRun", () => {
    expect(runInTenant(TENANT_A, () => resolveAgentRunLane("core.agentRun"))).toBe(`agent-run:${TENANT_A}`);
    expect(runInTenant(TENANT_B, () => resolveAgentRunLane("core.agentRun"))).toBe(`agent-run:${TENANT_B}`);
  });

  it("leaves non-agent heartbeat actions on their existing queue name", () => {
    expect(runInTenant(TENANT_A, () => resolveAgentRunLane(SEMPREC_TICK_ACTION_ID))).toBeUndefined();
  });

  it("returns undefined outside a tenant scope, so the job keeps a NULL queue_name", () => {
    expect(resolveAgentRunLane("core.agentRun")).toBeUndefined();
  });

  it("returns undefined under an explicit system scope", () => {
    expect(runAsSystem("test", () => resolveAgentRunLane("core.agentRun"))).toBeUndefined();
  });
});

describe("agent heartbeat fires enqueue onto the tenant's agent-run lane (issue #1047)", () => {
  let tenant: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    await createTenantZeroUser(pool);
    tenant = getTenantZeroId();
  });

  it("sweep: a core.agentRun fire gets agent-run:<T>, a non-agent fire keeps a NULL queue name", async () => {
    const agentId = await createIntervalHeartbeat("core.agentRun");
    const coreId = await createIntervalHeartbeat("noop");
    await makeDue(agentId);
    await makeDue(coreId);

    await runInTenant(tenant, () => withTransaction(pool, (client) => sweepDueHeartbeats(client)));

    const agentOccurrence = await occurrenceOf(agentId);
    const coreOccurrence = await occurrenceOf(coreId);
    expect(await fireJobs()).toEqual(
      [
        {
          task: "heartbeatFireAgent",
          key: occurrenceFireJobKey(agentId, agentOccurrence.id, agentOccurrence.generation),
          queue_name: `agent-run:${tenant}`,
          max_attempts: 3,
        },
        {
          task: "heartbeatFireCore",
          key: occurrenceFireJobKey(coreId, coreOccurrence.id, coreOccurrence.generation),
          queue_name: null,
          max_attempts: 3,
        },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it("onItemEvent: a core.agentRun fire gets agent-run:<T>, semprec.tick keeps its semprec-tick:<T> lane", async () => {
    const database = await withTransaction(pool, (client) => createDatabase(client, { name: "Lane Watched" }));
    const heartbeatIds: Record<string, string> = {};
    for (const actionId of ["core.agentRun", SEMPREC_TICK_ACTION_ID]) {
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: PROJECT,
          name: `On create ${actionId}`,
          rule: { kind: "onItemEvent", databaseId: database.id, event: "create" },
          actionId,
        }),
      );
      heartbeatIds[actionId] = heartbeat.id;
    }

    const item = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => createItemWithClient(client, { databaseId: database.id, properties: {} })),
    );

    const jobs = await fireJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.task === "heartbeatFireAgent")).toEqual({
      task: "heartbeatFireAgent",
      key: heartbeatFireJobKey(heartbeatIds["core.agentRun"]!, item.id),
      queue_name: `agent-run:${tenant}`,
      max_attempts: 3,
    });
    expect(jobs.find((j) => j.task === "heartbeatFireCore")).toEqual({
      task: "heartbeatFireCore",
      key: heartbeatFireJobKey(heartbeatIds[SEMPREC_TICK_ACTION_ID]!, item.id),
      queue_name: `${SEMPREC_TICK_QUEUE_NAME}:${tenant}`,
      max_attempts: 3,
    });
  });

  it("heartbeat.trigger: a core.agentRun fire gets agent-run:<T>, a non-agent fire keeps a NULL queue name", async () => {
    const agentId = await createIntervalHeartbeat("core.agentRun");
    const coreId = await createIntervalHeartbeat("noop");
    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT, triggeredBy: "user", task: "trigger" });
    const heartbeatTrigger = createHeartbeatTriggerTool(pool);

    await runInTenant(tenant, async () => {
      expect((await heartbeatTrigger(callingRun.id, { heartbeatId: agentId })).error).toBe(false);
      expect((await heartbeatTrigger(callingRun.id, { heartbeatId: coreId })).error).toBe(false);
    });

    expect(await fireJobs()).toEqual(
      [
        {
          task: "heartbeatFireAgent",
          key: manualHeartbeatFireJobKey(agentId),
          queue_name: `agent-run:${tenant}`,
          max_attempts: 3,
        },
        { task: "heartbeatFireCore", key: manualHeartbeatFireJobKey(coreId), queue_name: null, max_attempts: 3 },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it("enqueues agent fires with a NULL queue name when there is no tenant scope", async () => {
    const sweptId = await createIntervalHeartbeat("core.agentRun");
    const triggeredId = await createIntervalHeartbeat("core.agentRun");
    await makeDue(sweptId);
    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT, triggeredBy: "user", task: "trigger" });

    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    expect((await createHeartbeatTriggerTool(pool)(callingRun.id, { heartbeatId: triggeredId })).error).toBe(false);

    const jobs = await fireJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.task).toBe("heartbeatFireAgent");
      expect(job.queue_name).toBeNull();
    }
  });
});

interface AgentFireRun {
  tenantId: string;
  start: number;
  end: number;
  /** For tenant B's run: whether one of tenant A's runs was executing once B had waited for A to start. */
  overlappedOtherTenant: boolean;
}

/**
 * How long one tenant's probe waits for the other tenant's probe to start before it carries on alone.
 * It only bounds the failure case (the lanes never overlap), so it sits well above graphile-worker's
 * 2s `pollInterval`.
 */
const OTHER_TENANT_WAIT_MS = 5_000;

/** Waits for `signal`, giving up after {@link OTHER_TENANT_WAIT_MS}. */
async function waitForOtherTenant(signal: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, OTHER_TENANT_WAIT_MS);
  });
  await Promise.race([signal, gaveUp]);
  clearTimeout(timer);
}

describe("the agent-run lane serializes one tenant's agent fires but not another tenant's (issue #1047)", () => {
  let runner: Runner | undefined;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
  });

  it("never overlaps two of tenant A's heartbeatFireAgent jobs, while tenant B's runs alongside", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);

    const runs: AgentFireRun[] = [];
    let runningA = 0;
    let releaseA!: () => void;
    const tenantBStarted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let markAStarted!: () => void;
    const tenantAStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });

    // A blocking stand-in for the real handler: tenant A's runs stay in flight until tenant B's run
    // has started, so a lane that failed to serialize would show two A runs overlapping, and lanes
    // that failed to run in parallel would show B starting only after A finished. The rendezvous is
    // symmetric — B also waits for an A run to start before it looks — so the outcome does not depend
    // on which handler the worker happens to start first.
    const taskList: TaskList = {
      heartbeatFireAgent: registerTask("heartbeatFireAgent", async () => {
        const scope = currentTenantScope();
        if (scope?.kind !== "tenant") throw new Error("heartbeatFireAgent ran outside a tenant scope");
        const start = Date.now();
        if (scope.tenantId === tenantA) {
          runningA += 1;
          markAStarted();
          await waitForOtherTenant(tenantBStarted);
          runningA -= 1;
          runs.push({ tenantId: tenantA, start, end: Date.now(), overlappedOtherTenant: false });
        } else {
          await waitForOtherTenant(tenantAStarted);
          const overlappedOtherTenant = runningA > 0;
          releaseA();
          runs.push({ tenantId: scope.tenantId, start, end: Date.now(), overlappedOtherTenant });
        }
      }),
    };

    for (const [tenantId, count] of [
      [tenantA, 2],
      [tenantB, 1],
    ] as const) {
      await runInTenant(tenantId, async () => {
        for (let i = 0; i < count; i += 1) {
          await enqueueJob(
            pool,
            "heartbeatFireAgent",
            { heartbeatId: randomUUID() },
            { queueName: resolveAgentRunLane("core.agentRun"), maxAttempts: 1 },
          );
        }
      });
    }

    runner = await runWorker({ pgPool: pool, taskList, noHandleSignals: true, concurrency: 4 });

    await vi.waitFor(
      () => {
        if (runs.length !== 3) throw new Error(`expected 3 agent fire runs, got ${runs.length}`);
      },
      { timeout: 4 * OTHER_TENANT_WAIT_MS, interval: 20 },
    );

    const [firstA, secondA] = runs.filter((r) => r.tenantId === tenantA).sort((a, b) => a.start - b.start);
    expect(secondA!.start).toBeGreaterThanOrEqual(firstA!.end);
    const runB = runs.find((r) => r.tenantId === tenantB);
    expect(runB?.overlappedOtherTenant).toBe(true);
  });
});
