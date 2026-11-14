import type { Pool } from "pg";
import type { AiGatewayClientPort } from "@semprec/shared";
import {
  AGENT_TASK_NAMES,
  ensureQueueSchema,
  grantQueueSchemaPrivileges,
  resolveSempChatQueueConcurrency,
  runWorker,
} from "@semprec/queue";
import {
  assertTaskListMatchesAffinity,
  createAgentTaskList,
  mergeModuleTaskListForAffinity,
  resolveTaskAffinitySets,
  type AgentQueueTaskHandler,
  type RunAgentFn,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentsActionRegistry, unwiredRunAgent } from "./actionRegistryComposition.js";
import { AGENTS_STOP_WINDOW_MS } from "./shutdown.js";

export interface AgentsQueueRuntime {
  /** Idempotent: awaits both runners exactly once. The caller owns `pool`. */
  stop(): Promise<void>;
  stopForShutdown(): AgentRunnerStopAttempt;
}

export interface AgentRunnerStopAttempt {
  general: Promise<PromiseSettledResult<void>>;
  chat: Promise<PromiseSettledResult<void>>;
}

/**
 * The agent session wiring `serve.ts` composes (issue #647). Each one left out keeps its
 * placeholder: `core.agentRun` closes its run as `error`, and the optional queued handlers
 * complete without doing anything.
 */
export interface AgentsQueueRuntimeOptions {
  runAgent?: RunAgentFn;
  agentRunTask?: AgentQueueTaskHandler;
  delegatedAgentRunTask?: AgentQueueTaskHandler;
  sempMessageTask?: AgentQueueTaskHandler;
  /** The client of `core.agentRun`'s `answerExpectedFilter` gate (issue gh-1941); `serve.ts` composes it. */
  aiGateway?: AiGatewayClientPort;
}

/**
 * Issue #91's `agents` composition root: the second long-lived graphile-worker runner over the
 * same queue as `services/semprec-api`'s. Hosts every `queueAffinity: 'agents'` handler —
 * `heartbeatFireAgent`, `agentRun`, `delegatedAgentRun`, `sempMessage`, plus active modules'
 * agents-affinity tasks. A dedicated runner reserves capacity for Semp messages. Neither runner
 * installs a crontab; `semprec-api` is the queue's scheduler.
 */
export async function createAgentsQueueRuntime(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  options: AgentsQueueRuntimeOptions = {},
): Promise<AgentsQueueRuntime> {
  // Idempotent (graphile-worker's own migration runner and this GRANT block are both re-runnable)
  // — this runtime starts independently of, and possibly before, the API runtime's own install.
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);

  const actionRegistry = createAgentsActionRegistry(pool, options.runAgent ?? unwiredRunAgent, options.aiGateway);
  const coreTaskList = createAgentTaskList(
    pool,
    actionRegistry,
    moduleRegistry,
    options.agentRunTask,
    options.delegatedAgentRunTask,
    options.sempMessageTask,
  );
  const taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "agents");

  // Before this runner reports readiness (returns from `run()` below), prove its registered
  // handler set matches exactly what the shared affinity resolution says the agents runtime owns.
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(taskList, affinitySets.agents, "agents");

  const chatTask = taskList[AGENT_TASK_NAMES.SEMP_MESSAGE];
  if (!chatTask) throw new Error("Missing Semp message task");
  const generalTasks = Object.fromEntries(
    Object.entries(taskList).filter(([name]) => name !== AGENT_TASK_NAMES.SEMP_MESSAGE),
  );
  const chatConcurrency = resolveSempChatQueueConcurrency(process.env);
  const runner = await runWorker({
    pgPool: pool,
    taskList: generalTasks,
    noHandleSignals: true,
  });
  let chatRunner: Awaited<ReturnType<typeof runWorker>>;
  try {
    chatRunner = await runWorker({
      pgPool: pool,
      taskList: { [AGENT_TASK_NAMES.SEMP_MESSAGE]: chatTask },
      concurrency: chatConcurrency,
      gracefulShutdownAbortTimeout: AGENTS_STOP_WINDOW_MS,
      noHandleSignals: true,
    });
  } catch (error) {
    try {
      await runner.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Chat worker startup and general worker cleanup failed", {
        // The startup error remains primary; cleanupError is retained in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        cause: error,
      });
    }
    throw error;
  }

  let attempt: AgentRunnerStopAttempt | undefined;
  let stopped: Promise<void> | null = null;
  const stopOnce = (): AgentRunnerStopAttempt => {
    attempt ??= {
      general: Promise.resolve()
        .then(() => runner.stop())
        .then(
          () => ({ status: "fulfilled" as const, value: undefined }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      chat: Promise.resolve()
        .then(() => chatRunner.stop())
        .then(
          () => ({ status: "fulfilled" as const, value: undefined }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
    };
    return attempt;
  };
  return {
    stopForShutdown: stopOnce,
    stop(): Promise<void> {
      stopped ??= (async () => {
        const current = stopOnce();
        const results = await Promise.all([current.general, current.chat]);
        const errors: unknown[] = [];
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        if (errors.length) throw new AggregateError(errors, "Agent queue workers failed to stop", { cause: errors[0] });
      })();
      return stopped;
    },
  };
}
