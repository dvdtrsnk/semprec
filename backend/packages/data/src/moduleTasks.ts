import { CORE_TASK_NAMES, type Task, type TaskList } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";

export const CORE_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(CORE_TASK_NAMES));

/**
 * Merges core's task handlers with the currently active modules' registered tasks into one
 * `TaskList` for the queue engine (issue #109). Re-running this after activation changes
 * yields a fresh merge — nothing here is cached across calls, matching `ModuleRegistry`'s own
 * "always evaluate current activation" contract.
 *
 * A module task name colliding with a core task name is normally rejected at
 * `ModuleRegistry.loadModule` time (via its `reservedTaskNames` option, which callers should
 * construct from `CORE_TASK_NAME_SET`) — but that option is opt-in, so a `ModuleRegistry`
 * constructed without it would otherwise let a module task silently shadow a core handler here.
 * This function re-checks against `CORE_TASK_NAME_SET` itself as a defense-in-depth guard that
 * doesn't depend on the caller having configured the registry correctly. Two active modules
 * colliding with each other is already impossible regardless: `ModuleRegistry` rejects a
 * duplicate task name at load time, before either module can become active.
 */
export async function mergeModuleTaskList(coreTaskList: TaskList, moduleRegistry: ModuleRegistry): Promise<TaskList> {
  const merged: TaskList = { ...coreTaskList };
  const moduleTasks = await moduleRegistry.getTaskDefinitions();
  for (const task of moduleTasks) {
    if (CORE_TASK_NAME_SET.has(task.name)) {
      throw new Error(`Module "${task.moduleId}" task "${task.name}" collides with a core task name`);
    }
    const wrapped: Task = async (payload, helpers) => {
      const parsedPayload = task.payloadSchema.parse(payload);
      await task.handler(parsedPayload, helpers);
    };
    merged[task.name] = wrapped;
  }
  return merged;
}
