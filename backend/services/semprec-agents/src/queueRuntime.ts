import type { Pool } from "pg";
import type { Runner } from "@semprec/queue";
import { ensureQueueSchema, grantQueueSchemaPrivileges, runWorker } from "@semprec/queue";
import {
  assertTaskListMatchesAffinity,
  createActionRegistry,
  createAgentTaskList,
  mergeModuleTaskListForAffinity,
  resolveTaskAffinitySets,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";

export interface AgentsQueueRuntime {
  runner: Runner;
  /** Idempotent: awaits `runner.stop()` exactly once. Never closes `pool` — the caller (`serve.ts`) owns that. */
  stop(): Promise<void>;
}

/**
 * Issue #91's `agents` composition root: the second long-lived graphile-worker runner over the
 * same queue as `services/semprec-api`'s. Hosts every `queueAffinity: 'agents'` handler —
 * `heartbeatFireAgent`, `agentRun`, `delegatedAgentRun`, plus active modules' agents-affinity
 * tasks — and installs no crontab: `semprec-api`'s runtime is the queue's one scheduler, this
 * one is a plain consumer.
 */
export async function createAgentsQueueRuntime(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
): Promise<AgentsQueueRuntime> {
  // Idempotent (graphile-worker's own migration runner and this GRANT block are both re-runnable)
  // — this runtime starts independently of, and possibly before, the API runtime's own install.
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);

  const actionRegistry = createActionRegistry();
  const coreTaskList = createAgentTaskList(pool, actionRegistry, moduleRegistry);
  const taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "agents");

  // Before this runner reports readiness (returns from `run()` below), prove its registered
  // handler set matches exactly what the shared affinity resolution says the agents runtime owns.
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(taskList, affinitySets.agents, "agents");

  const runner = await runWorker({
    pgPool: pool,
    taskList,
    noHandleSignals: true,
  });

  let stopped: Promise<void> | null = null;
  return {
    runner,
    stop(): Promise<void> {
      stopped ??= runner.stop();
      return stopped;
    },
  };
}
