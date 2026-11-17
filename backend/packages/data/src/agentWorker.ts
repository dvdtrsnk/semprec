import type { Pool } from "pg";
import { AGENT_TASK_NAMES, registerTask, type Task, type TaskList } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createHeartbeatFireAgentTask } from "./scheduler/sweep.js";
import type { ActionRegistry } from "./scheduler/actions.js";

/**
 * Handler for `agentRun`/`delegatedAgentRun`, injected like `RunAgentFn` and `LibraryMetadataFetcher`: starting an
 * agent session from a standalone queued job has no implementation in this layer.
 */
export type AgentQueueTaskHandler = (payload: unknown, helpers: { job: { id: string } }) => Promise<void>;

export const noopAgentQueueTask: AgentQueueTaskHandler = async () => {};

/**
 * The agents runtime's task list: the closed `AGENT_TASK_NAMES` catalog only. The composition root merges
 * `queueAffinity: 'agents'` module tasks via `mergeModuleTaskListForAffinity`.
 */
export function createAgentTaskList(
  pool: Pool,
  actionRegistry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
  agentRunTask: AgentQueueTaskHandler = noopAgentQueueTask,
  delegatedAgentRunTask: AgentQueueTaskHandler = noopAgentQueueTask,
  sempMessageTask: AgentQueueTaskHandler = noopAgentQueueTask,
): TaskList {
  const handlers: Record<string, Task> = {
    [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: createHeartbeatFireAgentTask(pool, actionRegistry, moduleRegistry),
    [AGENT_TASK_NAMES.AGENT_RUN]: async (payload, helpers) => {
      await agentRunTask(payload, { job: { id: String(helpers.job.id) } });
    },
    [AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]: async (payload, helpers) => {
      await delegatedAgentRunTask(payload, { job: { id: String(helpers.job.id) } });
    },
    [AGENT_TASK_NAMES.SEMP_MESSAGE]: async (payload, helpers) => {
      await sempMessageTask(payload, { job: { id: String(helpers.job.id) } });
    },
  };

  return Object.fromEntries(Object.entries(handlers).map(([name, task]) => [name, registerTask(name, task)]));
}
