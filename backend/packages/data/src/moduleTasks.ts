import {
  AGENT_TASK_NAMES,
  CORE_TASK_AFFINITY,
  CORE_TASK_NAMES,
  registerTask,
  type Task,
  type TaskAffinity,
  type TaskList,
} from "@alldots/queue";
import type { ModuleRegistry } from "@alldots/module-registry";

export const CORE_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(CORE_TASK_NAMES));

export const AGENT_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(AGENT_TASK_NAMES));

/** Names no module task may claim; the shape `ModuleRegistry`'s `reservedTaskNames` option expects. */
export const RESERVED_TASK_NAMES: ReadonlySet<string> = new Set([...CORE_TASK_NAME_SET, ...AGENT_TASK_NAME_SET]);

export interface TaskAffinitySets {
  api: ReadonlySet<string>;
  agents: ReadonlySet<string>;
  transcribe: ReadonlySet<string>;
}

/**
 * The core catalogs plus every active module task, partitioned by manifest `queueAffinity`. Each runtime's
 * composition root checks its handlers against this before reporting readiness. Re-checks name collisions in case
 * the registry was built without `reservedTaskNames`.
 */
export async function resolveTaskAffinitySets(moduleRegistry: ModuleRegistry): Promise<TaskAffinitySets> {
  const api = new Set<string>();
  const agents = new Set<string>(AGENT_TASK_NAME_SET);
  const transcribe = new Set<string>();
  for (const [name, affinity] of Object.entries(CORE_TASK_AFFINITY)) {
    if (affinity === "api") api.add(name);
    else if (affinity === "transcribe") transcribe.add(name);
  }
  const moduleTasks = await moduleRegistry.getTasks();
  for (const task of moduleTasks) {
    if (api.has(task.name) || agents.has(task.name) || transcribe.has(task.name)) {
      throw new Error(`Module "${task.moduleId}" task "${task.name}" collides with a core/agent task name`);
    }
    (task.queueAffinity === "api" ? api : task.queueAffinity === "agents" ? agents : transcribe).add(task.name);
  }
  return { api, agents, transcribe };
}

/**
 * Core handlers plus the active modules' tasks; nothing cached, so activation changes are picked up. Re-checks core
 * name collisions because the registry's `reservedTaskNames` guard is opt-in.
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
    // `registerTask` unwraps the `enqueueJob` envelope (restoring the producer's trace) before `wrapped` runs, so
    // `payloadSchema` validates the module's own shape.
    merged[task.name] = registerTask(task.name, wrapped);
  }
  return merged;
}

/** Like `mergeModuleTaskList`, but only module tasks whose `queueAffinity` matches `affinity`. */
export async function mergeModuleTaskListForAffinity(
  coreTaskList: TaskList,
  moduleRegistry: ModuleRegistry,
  affinity: TaskAffinity,
): Promise<TaskList> {
  const merged: TaskList = { ...coreTaskList };
  const moduleTasks = await moduleRegistry.getTaskDefinitions();
  for (const task of moduleTasks) {
    if (task.queueAffinity !== affinity) continue;
    if (CORE_TASK_NAME_SET.has(task.name) || AGENT_TASK_NAME_SET.has(task.name)) {
      throw new Error(`Module "${task.moduleId}" task "${task.name}" collides with a core/agent task name`);
    }
    const wrapped: Task = async (payload, helpers) => {
      const parsedPayload = task.payloadSchema.parse(payload);
      await task.handler(parsedPayload, helpers);
    };
    merged[task.name] = registerTask(task.name, wrapped);
  }
  return merged;
}

/**
 * Fails startup when a runtime's handlers differ from its affinity set: a missing handler, or one for a task of
 * another runtime.
 */
export function assertTaskListMatchesAffinity(
  taskList: TaskList,
  expected: ReadonlySet<string>,
  runtime: TaskAffinity,
): void {
  const registered = new Set(Object.keys(taskList));
  const missing = [...expected].filter((name) => !registered.has(name));
  const unexpected = [...registered].filter((name) => !expected.has(name));
  if (missing.length === 0 && unexpected.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing handler(s) for: ${missing.join(", ")}`);
  if (unexpected.length > 0) parts.push(`unexpected handler(s) outside its affinity for: ${unexpected.join(", ")}`);
  throw new Error(
    `"${runtime}" queue runtime's registered task list does not match its affinity set — ${parts.join("; ")}`,
  );
}
