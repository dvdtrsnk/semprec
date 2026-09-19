import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, ensureQueueSchema, enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { seedSystem, createHeartbeat, withTransaction } from "@semprec/data";
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

async function jobCountFor(pool: Pool, identifier: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return Number(rows[0]?.count ?? 0);
}

async function getSemprecProjectId(pool: Pool): Promise<string> {
  const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = 'projects'");
  if (rows.length === 0) throw new Error("getSemprecProjectId: no database with owner_module_id 'projects'");
  const { rows: items } = await pool.query("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [rows[0].id]);
  if (items.length === 0) throw new Error("getSemprecProjectId: the projects database has no seeded items");
  return items[0].id as string;
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

  it("executes heartbeatSweep, trashPurge, approvalExecute and notificationFanout only in the API runtime", async () => {
    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry);

    await enqueueJob(pool, CORE_TASK_NAMES.HEARTBEAT_SWEEP, {});
    await enqueueJob(pool, CORE_TASK_NAMES.TRASH_PURGE, {});
    await enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: randomUUID() });
    await enqueueJob(pool, CORE_TASK_NAMES.NOTIFICATION_FANOUT, { notificationId: randomUUID() });

    // None of these four handlers throw on an unresolvable id (each is a graceful `if (!row)
    // return`), so successful completion means the job row disappears — a positive proof that
    // the API runtime, not just "some" runtime, actually ran each of these core task names.
    for (const identifier of [
      CORE_TASK_NAMES.HEARTBEAT_SWEEP,
      CORE_TASK_NAMES.TRASH_PURGE,
      CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
      CORE_TASK_NAMES.NOTIFICATION_FANOUT,
    ]) {
      await waitFor(async () => (await jobCountFor(pool, identifier)) === 0);
    }
  });

  it("fires the CORE_CRONTAB-installed heartbeatSweep entry through a test-specific crontab cadence, without waiting on the real minute boundary", async () => {
    // graphile-worker only backfills an identifier it already knows about (`known_since`/
    // `last_execution` present in `_private_known_crontabs`) — a freshly-unknown one always
    // waits for the real next minute boundary. Pre-seeding this identifier as "known" a few
    // minutes in the past, then installing a crontab entry carrying a `?fill=` backfill window
    // covering that gap, makes the cadence itself the test-specific override `ApiQueueRuntimeOptions.crontab`
    // exists for: the installed cron fires its backfilled catch-up run immediately at startup,
    // observable in seconds instead of the real ~60s+ wait a freshly-unknown identifier requires.
    await ensureQueueSchema(pool);
    const seededLastExecution = new Date(Date.now() - 5 * 60_000);
    await pool.query(
      `INSERT INTO graphile_worker._private_known_crontabs (identifier, known_since, last_execution) VALUES ($1, $2, $2)`,
      [CORE_TASK_NAMES.HEARTBEAT_SWEEP, seededLastExecution],
    );

    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry, {
      crontab: `* * * * * ${CORE_TASK_NAMES.HEARTBEAT_SWEEP} ?fill=1h\n`,
    });

    await waitFor(async () => {
      const { rows } = await pool.query<{ last_execution: string | null }>(
        `SELECT last_execution FROM graphile_worker._private_known_crontabs WHERE identifier = $1`,
        [CORE_TASK_NAMES.HEARTBEAT_SWEEP],
      );
      const lastExecution = rows[0]?.last_execution;
      return lastExecution !== null && lastExecution !== undefined && new Date(lastExecution) > seededLastExecution;
    });
  });

  it("re-enqueues a legacy heartbeatFire job exactly once under its split task name at install, and the deterministic heartbeat actually executes in the API runtime", async () => {
    await seedSystem(pool);
    const projectItemId = await getSemprecProjectId(pool);
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Legacy deterministic (issue #91 install migration)",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );
    await enqueueJob(
      pool,
      "heartbeatFire",
      { heartbeatId: heartbeat.id, occurrenceId: "legacy-occurrence", generation: 0 },
      { jobKey: "legacy-key-issue-91", maxAttempts: 3, queueName: "legacy-queue" },
    );

    const registry = await buildRegistryWith("apiFixtureModule.js", "fixture-api-queue-runtime");
    runtime = await createApiQueueRuntime(pool, registry);

    expect(await jobCountFor(pool, "heartbeatFire")).toBe(0);
    expect(await jobCountFor(pool, CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE)).toBe(1);

    // Presence alone only proves the migration ran, not that the API runtime actually owns and
    // runs `heartbeatFireCore` — this runtime's action registry has no handler for `"noop"`, so
    // the job errors rather than completing, but graphile-worker still has to claim and invoke
    // it to discover that. `attempts >= 1` is the positive proof of real execution: the same
    // "claimed and invoked, regardless of business-payload validity" idiom the
    // `heartbeatFireAgent`-only-in-agents-runtime test below uses for the same reason.
    await waitFor(async () => {
      const { rows } = await pool.query<{ attempts: number }>(
        `SELECT jobs.attempts FROM graphile_worker._private_jobs jobs
         JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
         WHERE tasks.identifier = $1`,
        [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE],
      );
      return (rows[0]?.attempts ?? 0) >= 1;
    });
  });

  it("rejects two active modules declaring the same task name before either composition root starts", async () => {
    const registry = new ModuleRegistry(
      () => new Set(["fixture-api-duplicate-task-a", "fixture-api-duplicate-task-b"]),
    );
    await registry.loadModule(fixturePath("apiDuplicateTaskModuleA.js"));
    await expect(registry.loadModule(fixturePath("apiDuplicateTaskModuleB.js"))).rejects.toThrow(/Duplicate task name/);
  });

  it("rejects a module task colliding with a core task name at startup", async () => {
    const registry = await buildRegistryWith("apiCollidingTaskModule.js", "fixture-api-colliding-task");
    await expect(createApiQueueRuntime(pool, registry)).rejects.toThrow(/collides with a core\/agent task name/);
  });

  it("rejects a module task with an invalid queueAffinity value before either composition root starts", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-api-invalid-affinity-task"]));
    await expect(registry.loadModule(fixturePath("apiInvalidAffinityTaskModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
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
