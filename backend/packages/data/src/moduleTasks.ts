import { CORE_TASK_NAMES, type Task, type TaskList } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";

export const CORE_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(CORE_TASK_NAMES));

/**
 * Merges core's task handlers with the currently active modules' registered tasks into one
 * `TaskList` for the queue engine (issue #109). Re-running this after activation changes
 * yields a fresh merge — nothing here is cached across calls, matching `ModuleRegistry`'s own
 * "always evaluate current activation" contract.
 *
 * A module task name colliding with a core task name is rejected at `ModuleRegistry.loadModule`
 * time (via its `reservedTaskNames` option, which callers must construct from
 * `CORE_TASK_NAME_SET`) — never here — so every task this function receives from the registry
 * is already known not to collide with core. Two active modules colliding with each other is
 * likewise already impossible: `ModuleRegistry` rejects a duplicate task name at load time,
 * before either module can become active.
 */
export async function mergeModuleTaskList(coreTaskList: TaskList, moduleRegistry: ModuleRegistry): Promise<TaskList> {
  const merged: TaskList = { ...coreTaskList };
  const moduleTasks = await moduleRegistry.getTaskDefinitions();
  for (const task of moduleTasks) {
    const wrapped: Task = async (payload, helpers) => {
      const parsedPayload = task.payloadSchema.parse(payload);
      await task.handler(parsedPayload, helpers);
    };
    merged[task.name] = wrapped;
  }
  return merged;
}
