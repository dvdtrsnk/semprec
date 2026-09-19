import type { Pool } from "pg";
import { AGENT_TASK_NAMES, registerTask, type Task, type TaskList } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createHeartbeatFireAgentTask } from "./scheduler/sweep.js";
import type { ActionRegistry } from "./scheduler/actions.js";

/**
 * `agentRun`/`delegatedAgentRun`'s handler shape (issue #91 only closes the name catalog and
 * hosts these under the agents runtime — actually starting/continuing an agent session from a
 * standalone queued job, rather than from a heartbeat fire, is a later agent-orchestration
 * issue's business logic, the same "pluggable, injected, no real implementation yet" pattern
 * `RunAgentFn` (scheduler/actions.ts) and `LibraryMetadataFetcher` (library/libraryMetadataJob.ts)
 * already use for exactly this reason).
 */
export type AgentQueueTaskHandler = (payload: unknown, helpers: { job: { id: string } }) => Promise<void>;

export const noopAgentQueueTask: AgentQueueTaskHandler = async () => {};

/**
 * Composes the agents runtime's (issue #91's second composition root) own task list: the closed
 * `AGENT_TASK_NAMES` catalog only. Module tasks with `queueAffinity: 'agents'` are merged in
 * separately, by the composition root, via `mergeModuleTaskListForAffinity`.
 */
export function createAgentTaskList(
  pool: Pool,
  actionRegistry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
  agentRunTask: AgentQueueTaskHandler = noopAgentQueueTask,
  delegatedAgentRunTask: AgentQueueTaskHandler = noopAgentQueueTask,
): TaskList {
  const handlers: TaskList = {
    [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: createHeartbeatFireAgentTask(pool, actionRegistry, moduleRegistry),
    [AGENT_TASK_NAMES.AGENT_RUN]: async (payload, helpers) => {
      await agentRunTask(payload, { job: { id: String(helpers.job.id) } });
    },
    [AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]: async (payload, helpers) => {
      await delegatedAgentRunTask(payload, { job: { id: String(helpers.job.id) } });
    },
  };

  return Object.fromEntries(
    Object.entries(handlers)
      .filter((entry): entry is [string, Task] => entry[1] !== undefined)
      .map(([name, task]) => [name, registerTask(name, task)]),
  );
}
