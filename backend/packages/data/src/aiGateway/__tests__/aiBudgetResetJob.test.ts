import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import { createSempStatusRouteHandler } from "../../semp/sempStatusRouteHandler.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { recordTokenGatewayCall } from "../aiGatewayCallsStore.js";
import { aiBudgetResetJobKey, enqueueAiBudgetReset, handleAiBudgetResetTask } from "../aiBudgetResetJob.js";

/**
 * Issue gh-2024: the one-shot `aiBudgetReset` job. Every tenant-side call runs on a `semprec_data` pool, so
 * row-level security applies. The job runs through the production `createCoreTaskList` handler drained with
 * `runOnce`; the queue is read through graphile-worker's public `jobs` view.
 */

interface QueuedJob {
  key: string | null;
  run_at: Date;
}

interface Announcement {
  tenantId: string | null;
  event: InvalidationEvent;
}

let admin: Pool;
let runtime: Pool;
let taskList: TaskList;
let tenantA: string;
let tenantB: string;
let announced: Announcement[];

/** 23 November 2026, 00:00 in Europe/Prague (UTC+1): an arbitrary window end in the future of the case. */
const RESETS_AT = new Date("2026-11-22T23:00:00.000Z");

async function queuedJobs(): Promise<QueuedJob[]> {
  const { rows } = await admin.query<QueuedJob>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.AI_BUDGET_RESET],
  );
  return rows;
}

/** Completes every unlocked job without running it, through graphile-worker's public `complete_jobs`. */
async function discardQueuedJobs(): Promise<void> {
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

function recordAnnouncements(): void {
  announced = [];
  setInvalidationHook((event) => {
    const scope = currentTenantScope();
    announced.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : null, event });
  });
}

/** Spend of `costUsd` for `tenantId`, written by the gateway's accounting writer in the tenant's scope. */
async function recordSpend(tenantId: string, costUsd: number): Promise<void> {
  await runInTenant(tenantId, () =>
    recordTokenGatewayCall(runtime, {
      provider: "anthropic",
      model: "reset-job-test",
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    }),
  );
}

async function statusProblemIds(tenantId: string): Promise<string[]> {
  const status = await runInTenant(tenantId, () => createSempStatusRouteHandler(runtime)());
  return status.body.problems.map((problem) => problem.id);
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const handler = createCoreTaskList(runtime, createActionRegistry())[CORE_TASK_NAMES.AI_BUDGET_RESET];
  if (!handler) throw new Error("createCoreTaskList has no aiBudgetReset handler");
  taskList = { [CORE_TASK_NAMES.AI_BUDGET_RESET]: handler };
}, 120_000);

beforeEach(async () => {
  await resetDatabase(admin);
  await discardQueuedJobs();
  tenantA = await createTestTenant(admin);
  tenantB = await createTestTenant(admin);
  recordAnnouncements();
});

afterEach(() => {
  setInvalidationHook(() => {});
});

afterAll(async () => {
  await runtime?.end();
});

describe("enqueueAiBudgetReset", () => {
  it("queues one job for the tenant of the scope, at the reset instant, under the key of tenant and instant", async () => {
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, RESETS_AT));

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: `aiBudgetReset:${tenantA}:2026-11-22T23:00:00.000Z`, run_at: RESETS_AT });
    expect(jobs[0]?.key).toBe(aiBudgetResetJobKey(tenantA, RESETS_AT));
  });

  it("is a repeat of the first enqueue for the same tenant and instant: one job, run time kept", async () => {
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, RESETS_AT));
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, RESETS_AT));

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_at).toEqual(RESETS_AT);
  });

  it("queues a second job for another reset instant of the same tenant", async () => {
    const nextWindow = new Date("2026-12-22T23:00:00.000Z");
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, RESETS_AT));
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, nextWindow));

    expect((await queuedJobs()).map((job) => job.key)).toEqual(
      [aiBudgetResetJobKey(tenantA, RESETS_AT), aiBudgetResetJobKey(tenantA, nextWindow)].sort(),
    );
  });

  it("keeps the jobs of two tenants with the same reset instant apart, each running in its own tenant", async () => {
    const passed = new Date(Date.now() - 1_000);
    await runInTenant(tenantA, () => enqueueAiBudgetReset(runtime, passed));
    await runInTenant(tenantB, () => enqueueAiBudgetReset(runtime, passed));

    expect((await queuedJobs()).map((job) => job.key)).toEqual(
      [aiBudgetResetJobKey(tenantA, passed), aiBudgetResetJobKey(tenantB, passed)].sort(),
    );
    await runOnce({ pgPool: admin, taskList });
    expect(announced.map((entry) => entry.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });

  it("refuses a system scope and a missing scope before queueing anything", async () => {
    await expect(runAsSystem("test", () => enqueueAiBudgetReset(runtime, RESETS_AT))).rejects.toThrow(
      "requires a tenant scope",
    );
    await expect(enqueueAiBudgetReset(runtime, RESETS_AT)).rejects.toThrow("requires a tenant scope");

    expect(await queuedJobs()).toEqual([]);
  });
});

describe("the aiBudgetReset task", () => {
  /** Enqueues the job for an instant that has just passed, so `runOnce` finds it due, and drains the queue. */
  async function runDueJob(tenantId: string): Promise<void> {
    await runInTenant(tenantId, () => enqueueAiBudgetReset(runtime, new Date(Date.now() - 1_000)));
    await runOnce({ pgPool: admin, taskList });
  }

  it("announces one Semp status invalidation, in the tenant of the job, and completes", async () => {
    await runDueJob(tenantA);

    expect(announced).toEqual([{ tenantId: tenantA, event: { scope: "sempStatus" } }]);
    expect(await queuedJobs()).toEqual([]);
  });

  it("announces nothing for another tenant", async () => {
    await runDueJob(tenantA);

    expect(announced.filter((entry) => entry.tenantId === tenantB)).toEqual([]);
  });

  it("rejects a payload that carries anything and announces nothing", async () => {
    await expect(runInTenant(tenantA, () => handleAiBudgetResetTask(runtime, { tenantId: tenantB }))).rejects.toThrow();
    await expect(runInTenant(tenantA, () => handleAiBudgetResetTask(runtime, null))).rejects.toThrow();

    expect(announced).toEqual([]);
  });

  it("is followed by a status read that no longer lists the exhausted budget", async () => {
    await setTenantAiBudget(admin, tenantA, { dailyCapUsd: 1, monthlyCapUsd: null });
    await recordSpend(tenantA, 1);
    expect(await statusProblemIds(tenantA)).toEqual([expect.stringMatching(/^aiBudgetExhausted:/)]);

    // Raw SQL: the clock of the database cannot be moved, so the spend of the exhausted day is moved two days back,
    // which is where it sits once the window has reset. The monthly cap is null, so the month does not matter.
    await admin.query("UPDATE ai_gateway_calls SET at = at - interval '2 days' WHERE tenant_id = $1", [tenantA]);
    await runDueJob(tenantA);

    expect(announced).toEqual([{ tenantId: tenantA, event: { scope: "sempStatus" } }]);
    expect(await statusProblemIds(tenantA)).toEqual([]);
  });

  it("leaves the exhausted budget of a tenant listed until its own window resets", async () => {
    await setTenantAiBudget(admin, tenantA, { dailyCapUsd: 1, monthlyCapUsd: null });
    await setTenantAiBudget(admin, tenantB, { dailyCapUsd: 1, monthlyCapUsd: null });
    await recordSpend(tenantA, 1);
    await recordSpend(tenantB, 1);

    await runDueJob(tenantB);

    expect(await statusProblemIds(tenantA)).toEqual([expect.stringMatching(/^aiBudgetExhausted:/)]);
    expect(announced.map((entry) => entry.tenantId)).toEqual([tenantB]);
  });
});

describe("the job key", () => {
  it("renders the instant as toISOString does, so every process builds the same key", () => {
    const tenantId = randomUUID();
    expect(aiBudgetResetJobKey(tenantId, new Date("2026-12-01T00:00:00Z"))).toBe(
      `aiBudgetReset:${tenantId}:2026-12-01T00:00:00.000Z`,
    );
  });
});
