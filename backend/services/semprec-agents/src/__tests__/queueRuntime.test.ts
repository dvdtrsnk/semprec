import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { ModuleRegistry } from "@semprec/module-registry";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import * as agentsFixtureModule from "./fixtures/agentsFixtureModule.js";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

async function buildRegistryWith(fixtureFile: string, moduleId: string): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set([moduleId]));
  await registry.loadModule(fixturePath(fixtureFile));
  return registry;
}

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

let pool: Pool;
let runtime: AgentsQueueRuntime | undefined;

describe("createAgentsQueueRuntime (issue #91)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("TRUNCATE graphile_worker._private_known_crontabs");
    agentsFixtureModule.calls.length = 0;
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("installs no crontab and hosts the closed agent catalog plus agents-affinity module tasks", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    const { rows: crontabRows } = await pool.query("SELECT identifier FROM graphile_worker._private_known_crontabs");
    expect(crontabRows).toEqual([]);

    await enqueueJob(pool, "agentsFixture.doThing", { hello: "agents" });
    await enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, {});
    await enqueueJob(pool, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN, {});

    await waitFor(async () => agentsFixtureModule.calls.length > 0);
    expect(agentsFixtureModule.calls).toEqual([{ hello: "agents" }]);

    await waitFor(async () => {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
         JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
         WHERE tasks.identifier = ANY($1)`,
        [[AGENT_TASK_NAMES.AGENT_RUN, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]],
      );
      return Number(rows[0]?.count ?? 0) === 0;
    });
  });

  it("never executes a task outside its own affinity — an api-only job stays unexecuted", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    await enqueueJob(pool, CORE_TASK_NAMES.HEARTBEAT_SWEEP, {});

    // This runtime's taskList has no `heartbeatSweep` handler, so graphile-worker's own job
    // fetcher (which only claims jobs for task identifiers the connected worker supports) never
    // claims it — there is no "it ran and failed" signal to poll for, only its continued,
    // unclaimed presence after giving this runner ample time to have picked it up if it could.
    await sleep(1_500);
    const { rows } = await pool.query<{ attempts: number }>(
      `SELECT jobs.attempts FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = $1`,
      [CORE_TASK_NAMES.HEARTBEAT_SWEEP],
    );
    expect(rows).toEqual([{ attempts: 0 }]);
  });

  it("rejects a module task colliding with an agent task name at startup", async () => {
    const registry = await buildRegistryWith("agentsCollidingTaskModule.js", "fixture-agents-colliding-task");
    await expect(createAgentsQueueRuntime(pool, registry)).rejects.toThrow(/collides with a core\/agent task name/);
  });

  it("is idempotent to stop twice, and never closes the pool", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();

    await expect(pool.query("SELECT 1")).resolves.toBeDefined();
  });
});
