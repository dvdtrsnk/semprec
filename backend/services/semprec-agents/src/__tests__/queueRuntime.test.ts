import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  AGENT_TASK_NAMES,
  CORE_TASK_NAMES,
  enqueueJob,
  resolveQueueConcurrency,
  runWorker,
  type Runner,
} from "@semprec/queue";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "@semprec/data/testSupport";
import { ModuleRegistry } from "@semprec/module-registry";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createAgentRun,
  createAgentTaskList,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  sendSempMessage,
  withTransaction,
} from "@semprec/data";
import { createAgentsActionRegistry } from "../actionRegistryComposition.js";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createSempMessageTask } from "../sempMessageTask.js";
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

    await inTenantZero(() => enqueueJob(pool, "agentsFixture.doThing", { hello: "agents" }));
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, {}));
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN, {}));

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

  it("reserves Semp capacity while every general worker is busy and stop awaits both runners", async () => {
    const rolePool = await createRuntimeRolePool(pool, "semprec_data");
    let releaseGeneral!: () => void;
    let releaseChat!: () => void;
    const generalGate = new Promise<void>((resolve) => {
      releaseGeneral = resolve;
    });
    const chatGate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    let failure: { error: unknown } | undefined;
    let stop: Promise<void> | undefined;
    try {
      const role = await runAsSystem("test:queue-role", () =>
        rolePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(pool);
      await createUser(pool, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenant, () => seedSystem(rolePool));
      const registry = await loadFullModuleRegistry();
      const slots = resolveQueueConcurrency(process.env);
      if (slots > 16) throw new Error("Queue capacity fixture supports at most 16 general slots");
      const faux = fauxProvider();
      faux.setResponses([
        ...Array.from({ length: slots }, () => async () => {
          await generalGate;
          return fauxAssistantMessage("general");
        }),
        async () => {
          await chatGate;
          return fauxAssistantMessage("chat");
        },
      ]);
      const gateway: GatewayModel = {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      };
      const inFlight = createInFlightAgentRuns();
      runtime = await createAgentsQueueRuntime(rolePool, registry, {
        agentRunTask: createAgentRunTask(rolePool, registry, gateway, inFlight),
        sempMessageTask: createSempMessageTask(rolePool, registry, gateway, inFlight),
      });
      const project = await runInTenant(tenant, () =>
        withTransaction(rolePool, async (client) => (await getDatabaseByModuleId(client, "inbox"))?.ownerProjectItemId),
      );
      if (!project) throw new Error("Missing Semprec project");
      for (let i = 0; i < slots; i++) {
        const run = await runInTenant(tenant, () =>
          createAgentRun(rolePool, { projectItemId: project, triggeredBy: "user", task: `general ${i}` }),
        );
        await runInTenant(tenant, () => enqueueJob(rolePool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));
      }
      await waitFor(async () => faux.state.callCount === slots);
      const chat = await runInTenant(tenant, () =>
        withTransaction(rolePool, (client) =>
          sendSempMessage(client, { text: "chat", context: [], hasContext: false }),
        ),
      );
      await waitFor(async () => faux.state.callCount === slots + 1);
      expect(
        (
          await runInTenant(tenant, () =>
            rolePool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
              chat.assistantMessageId,
            ]),
          )
        ).rows,
      ).toEqual([{ status: "running" }]);
      let stopped = false;
      stop = runtime.stop().then(() => {
        stopped = true;
      });
      await sleep(100);
      expect(stopped).toBe(false);
      releaseGeneral();
      await sleep(100);
      expect(stopped).toBe(false);
      releaseChat();
      await stop;
      runtime = undefined;
      expect(stopped).toBe(true);
      expect(
        (
          await runInTenant(tenant, () =>
            rolePool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
              chat.assistantMessageId,
            ]),
          )
        ).rows,
      ).toEqual([{ status: "done" }]);
    } catch (error) {
      failure = { error };
    }
    releaseGeneral();
    releaseChat();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (stop) await stop;
        else await runtime?.stop();
      },
      async () => rolePool.end(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    runtime = undefined;
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Queue capacity cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("claims a later Semp job before an equal-age heartbeat on one real worker", async () => {
    const rolePool = await createRuntimeRolePool(pool, "semprec_data");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let worker: Runner | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const role = await runAsSystem("test:priority-role", () =>
        rolePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(pool);
      await createUser(pool, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenant, () => seedSystem(rolePool));
      const registry = await loadFullModuleRegistry();
      const faux = fauxProvider();
      faux.setResponses([
        async () => {
          await gate;
          return fauxAssistantMessage("chat");
        },
      ]);
      const gateway: GatewayModel = {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      };
      const inFlight = createInFlightAgentRuns();
      const actions = createAgentsActionRegistry(
        rolePool,
        createRunAgentForHeartbeats(rolePool, registry, gateway, inFlight),
      );
      const tasks = createAgentTaskList(
        rolePool,
        actions,
        registry,
        createAgentRunTask(rolePool, registry, gateway, inFlight),
        createAgentRunTask(rolePool, registry, gateway, inFlight),
        createSempMessageTask(rolePool, registry, gateway, inFlight),
      );
      const heartbeat = tasks[AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT];
      const semp = tasks[AGENT_TASK_NAMES.SEMP_MESSAGE];
      if (!heartbeat || !semp) throw new Error("Missing registered task");
      const heartbeatKey = `priority-heartbeat:${randomUUID()}`;
      const turn = await runInTenant(tenant, () =>
        withTransaction(rolePool, async (client) => {
          // Invalid business payload is intentional: the actual heartbeat handler still records a claim.
          await enqueueJob(client, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {}, { jobKey: heartbeatKey, maxAttempts: 1 });
          return sendSempMessage(client, { text: "priority", context: [], hasContext: false });
        }),
      );
      const chatKey = `sempMessage:${turn.assistantMessageId}`;
      const queued = await pool.query<{ key: string; priority: number; run_at: Date }>(
        "SELECT key, priority, run_at FROM graphile_worker.jobs WHERE key = ANY($1::text[])",
        [[heartbeatKey, chatKey]],
      );
      const byKey = new Map(queued.rows.map((row) => [row.key, row]));
      expect(byKey.get(heartbeatKey)?.run_at).toEqual(byKey.get(chatKey)?.run_at);
      expect(byKey.get(chatKey)?.priority).toBeLessThan(byKey.get(heartbeatKey)?.priority ?? -1);
      worker = await runWorker({
        pgPool: rolePool,
        concurrency: 1,
        noHandleSignals: true,
        taskList: {
          [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: heartbeat,
          [AGENT_TASK_NAMES.SEMP_MESSAGE]: semp,
        },
      });
      await waitFor(async () => faux.state.callCount === 1);
      const waiting = await pool.query<{ attempts: number; locked_at: Date | null }>(
        "SELECT attempts, locked_at FROM graphile_worker.jobs WHERE key = $1",
        [heartbeatKey],
      );
      expect(waiting.rows).toEqual([{ attempts: 0, locked_at: null }]);
      release();
      await waitFor(async () => {
        const row = await pool.query<{ attempts: number }>("SELECT attempts FROM graphile_worker.jobs WHERE key = $1", [
          heartbeatKey,
        ]);
        return row.rows[0]?.attempts === 1;
      });
    } catch (error) {
      failure = { error };
    }
    release();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [async () => worker?.stop(), async () => rolePool.end()]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Queue priority cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("never executes a task outside its own affinity — api-only jobs stay unexecuted", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    const apiOnlyIdentifiers = [
      CORE_TASK_NAMES.HEARTBEAT_SWEEP,
      CORE_TASK_NAMES.TRASH_PURGE,
      CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
      CORE_TASK_NAMES.NOTIFICATION_FANOUT,
    ];
    for (const identifier of apiOnlyIdentifiers) {
      await inTenantZero(() => enqueueJob(pool, identifier, {}));
    }

    // This runtime's taskList has no handler for any of these api-affinity identifiers, so
    // graphile-worker's own job fetcher (which only claims jobs for task identifiers the
    // connected worker supports) never claims them — there is no "it ran and failed" signal to
    // poll for, only their continued, unclaimed presence after giving this runner ample time to
    // have picked them up if it could.
    await sleep(1_500);
    const { rows } = await pool.query<{ identifier: string; attempts: number }>(
      `SELECT tasks.identifier, jobs.attempts FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = ANY($1)
       ORDER BY tasks.identifier`,
      [apiOnlyIdentifiers],
    );
    expect(rows).toEqual([...apiOnlyIdentifiers].sort().map((identifier) => ({ identifier, attempts: 0 })));
  });

  it("executes heartbeatFireAgent only in the agents runtime", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {}));

    // An empty payload fails this handler's own field validation, so it never completes — but
    // graphile-worker still has to claim and invoke it to discover that. `attempts >= 1` is
    // therefore the positive counterpart to the negative "never claimed" proof above: it shows
    // this runtime is the one that owns and runs this task name, regardless of whether the
    // specific payload used here happens to be valid business data (irrelevant to ownership).
    await waitFor(async () => {
      const { rows } = await pool.query<{ attempts: number }>(
        `SELECT jobs.attempts FROM graphile_worker._private_jobs jobs
         JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
         WHERE tasks.identifier = $1`,
        [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT],
      );
      return (rows[0]?.attempts ?? 0) >= 1;
    });
  });

  it("rejects two active modules declaring the same task name before either composition root starts", async () => {
    const registry = new ModuleRegistry(
      () => new Set(["fixture-agents-duplicate-task-a", "fixture-agents-duplicate-task-b"]),
    );
    await registry.loadModule(fixturePath("agentsDuplicateTaskModuleA.js"));
    await expect(registry.loadModule(fixturePath("agentsDuplicateTaskModuleB.js"))).rejects.toThrow(
      /Duplicate task name/,
    );
  });

  it("rejects a module task colliding with an agent task name at startup", async () => {
    const registry = await buildRegistryWith("agentsCollidingTaskModule.js", "fixture-agents-colliding-task");
    await expect(createAgentsQueueRuntime(pool, registry)).rejects.toThrow(/collides with a core\/agent task name/);
  });

  it("rejects a module task with an invalid queueAffinity value before either composition root starts", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-agents-invalid-affinity-task"]));
    await expect(registry.loadModule(fixturePath("agentsInvalidAffinityTaskModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
  });

  it("is idempotent to stop twice, and never closes the pool", async () => {
    const registry = await buildRegistryWith("agentsFixtureModule.js", "fixture-agents-queue-runtime");
    runtime = await createAgentsQueueRuntime(pool, registry);

    const attempt = runtime.stopForShutdown();
    expect(runtime.stopForShutdown()).toBe(attempt);
    const first = runtime.stop();
    expect(runtime.stop()).toBe(first);
    expect(await Promise.all([attempt.general, attempt.chat])).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    await expect(first).resolves.toBeUndefined();

    await expect(pool.query("SELECT 1")).resolves.toBeDefined();
  });
});
