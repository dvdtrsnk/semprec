import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { ModuleRegistry } from "@semprec/module-registry";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";
import * as apiFixtureModule from "./fixtures/apiFixtureModule.js";

const EXPECTED_CRONTAB_IDENTIFIERS = [
  CORE_TASK_NAMES.HEARTBEAT_SWEEP,
  CORE_TASK_NAMES.DOC_COMPACTION_SWEEP,
  CORE_TASK_NAMES.DOC_HISTORY_CLEANUP,
  CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP,
  CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP,
  CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP,
  CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM,
  CORE_TASK_NAMES.TRASH_PURGE,
].sort();

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
let runtime: ApiQueueRuntime | undefined;

describe("createApiQueueRuntime (issue #91)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("TRUNCATE graphile_worker._private_known_crontabs");
    apiFixtureModule.calls.length = 0;
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("installs CORE_CRONTAB exactly once and hosts core + api-affinity module tasks", async () => {
    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry);

    const { rows: crontabRows } = await pool.query<{ identifier: string }>(
      "SELECT identifier FROM graphile_worker._private_known_crontabs ORDER BY identifier",
    );
    expect(crontabRows.map((row) => row.identifier).sort()).toEqual(EXPECTED_CRONTAB_IDENTIFIERS);

    await enqueueJob(pool, "apiFixture.doThing", { hello: "world" });
    await enqueueJob(pool, CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM, {});

    await waitFor(async () => apiFixtureModule.calls.length > 0);
    expect(apiFixtureModule.calls).toEqual([{ hello: "world" }]);

    await waitFor(async () => {
      const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM observability_checks`);
      return Number(rows[0]?.count ?? 0) > 0;
    });
  });

  it("never executes a task outside its own affinity — an agents-only job stays unexecuted", async () => {
    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry);

    await enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {});

    // This runtime's taskList has no `heartbeatFireAgent` handler, so graphile-worker's own job
    // fetcher (which only claims jobs for task identifiers the connected worker supports) never
    // claims it — there is no "it ran and failed" signal to poll for, only its continued,
    // unclaimed presence after giving this runner ample time to have picked it up if it could.
    await sleep(1_500);
    const { rows } = await pool.query<{ attempts: number }>(
      `SELECT jobs.attempts FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = $1`,
      [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT],
    );
    expect(rows).toEqual([{ attempts: 0 }]);
  });

  it("rejects a module task colliding with a core task name at startup", async () => {
    const registry = await buildRegistryWith("apiCollidingTaskModule.js", "fixture-api-colliding-task");
    await expect(createApiQueueRuntime(pool, registry)).rejects.toThrow(/collides with a core\/agent task name/);
  });

  it("is idempotent to install twice and to stop twice, and never closes the pool", async () => {
    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry);
    const second = await createApiQueueRuntime(pool, registry);
    await second.stop();

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();

    await expect(pool.query("SELECT 1")).resolves.toBeDefined();
  });
});
