import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope, runInTenant, type TenantScope } from "@semprec/shared";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createPool,
  createUser,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";

const originalMode = process.env.SEMPREC_TENANT_SCOPE;

let resetPool: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;
let faux: FauxProviderHandle;
let fauxGateway: GatewayModel;
let streamScopes: (TenantScope | undefined)[];
let tenantZero: string;

/** Runs a fixture write or an assertion read in tenant zero's scope, as strict mode demands. */
function inTenantZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantZero, fn);
}

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

function jobCount(taskName: string): Promise<number> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = $1`,
      [taskName],
    );
    return Number(rows[0]?.count ?? 0);
  });
}

function runRow(id: string): Promise<{ status: string; result: string | null }> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

function errorNotificationCount(runId: string): Promise<number> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1`,
      [runId],
    );
    return Number(rows[0]?.count ?? 0);
  });
}

function seededSemprecProjectItemId(): Promise<string> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'`);
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  });
}

function seededAgentHeartbeat(): Promise<{ id: string; projectItemId: string }> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ id: string; project_item_id: string }>(
      `SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1`,
      [CORE_AGENT_RUN_ACTION_ID],
    );
    expect(rows).toHaveLength(1);
    return { id: rows[0]!.id, projectItemId: rows[0]!.project_item_id };
  });
}

/** Starts the runtime from the test body, with no ambient scope — as `serve.ts` does. */
async function startRuntime(): Promise<void> {
  expect(currentTenantScope()).toBeUndefined();
  runtime = await createAgentsQueueRuntime(pool, registry, {
    runAgent: createRunAgentForHeartbeats(pool, registry, fauxGateway),
    agentRunTask: createAgentRunTask(pool, registry, fauxGateway),
    delegatedAgentRunTask: createAgentRunTask(pool, registry, fauxGateway),
  });
}

function expectEveryStreamCallInTenantZero(): void {
  expect(streamScopes.length).toBeGreaterThan(0);
  for (const scope of streamScopes) expect(scope).toEqual({ kind: "tenant", tenantId: tenantZero });
}

describe("agents process runs each job inside its tenant under strict enforcement (issue #991)", () => {
  beforeEach(async () => {
    resetPool ??= getTestPool();
    pool ??= createPool(process.env.TEST_DATABASE_URL!);
    registry ??= await loadFullModuleRegistry();

    // Fixtures are written under the default (warn) mode first; strict is switched on once they exist.
    delete process.env.SEMPREC_TENANT_SCOPE;
    await resetDatabase(resetPool);
    const { rows } = await resetPool.query<{ id: string }>(`SELECT app_sole_tenant() AS id`);
    tenantZero = rows[0]!.id;
    await inTenantZero(async () => {
      await seedSystem(pool);
      await createUser(pool, { email: "owner@example.com", passwordHash: "unused" });
    });
    process.env.SEMPREC_TENANT_SCOPE = "strict";

    runtime = undefined;
    faux = fauxProvider();
    streamScopes = [];
    const streamFn: StreamFn = (model, context, options) => {
      streamScopes.push(currentTenantScope());
      return faux.provider.streamSimple(model, context, options);
    };
    fauxGateway = { model: faux.getModel(), streamFn };
  });

  afterEach(async () => {
    try {
      await runtime?.stop();
    } finally {
      if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
      else process.env.SEMPREC_TENANT_SCOPE = originalMode;
    }
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), resetPool?.end()]);
  });

  it("starts and stops the runtime with no ambient scope", async () => {
    await startRuntime();
    await expect(runtime!.stop()).resolves.toBeUndefined();
  });

  it.each([
    ["agentRun", AGENT_TASK_NAMES.AGENT_RUN],
    ["delegatedAgentRun", AGENT_TASK_NAMES.DELEGATED_AGENT_RUN],
  ])("runs a %s job to completion in its envelope's tenant", async (_label, taskName) => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await inTenantZero(() =>
      createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" }),
    );
    faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, taskName, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "done", result: "Hello from the agent." });
    await waitFor(async () => (await jobCount(taskName)) === 0);
    expectEveryStreamCallInTenantZero();
  });

  it("runs a heartbeatFireAgent job's core.agentRun run to completion in its envelope's tenant", async () => {
    const heartbeat = await seededAgentHeartbeat();
    // A manual (`triggeredByRunId`) fire skips the seeded rule's item-relation filter.
    const parentRun = await inTenantZero(() =>
      createAgentRun(pool, {
        projectItemId: heartbeat.projectItemId,
        triggeredBy: "user",
        task: "trigger the newEmail heartbeat",
      }),
    );
    faux.setResponses([fauxAssistantMessage("Triaged the new email.")]);

    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
        heartbeatId: heartbeat.id,
        triggeredByRunId: parentRun.id,
      }),
    );

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT)) === 0);
    const runs = await inTenantZero(async () => {
      const { rows } = await pool.query<{ status: string; result: string | null }>(
        `SELECT status, result FROM agent_runs WHERE heartbeat_id = $1`,
        [heartbeat.id],
      );
      return rows;
    });
    expect(runs).toEqual([{ status: "done", result: "Triaged the new email." }]);
    expectEveryStreamCallInTenantZero();
  });

  it("closes a failed run as error with one notification, without leaving the tenant's scope", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await inTenantZero(() =>
      createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" }),
    );
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "error", result: "gateway refused: budget" });
    expect(await errorNotificationCount(run.id)).toBe(1);
    expect(streamScopes).toEqual([{ kind: "tenant", tenantId: tenantZero }]);
  });
});
