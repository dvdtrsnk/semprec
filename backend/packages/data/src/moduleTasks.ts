import { AGENT_TASK_NAMES, CORE_TASK_NAMES, registerTask, type Task, type TaskList } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";

export const CORE_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(CORE_TASK_NAMES));

/** The closed agents-runtime task-name catalog (issue #221), as a set for collision checks. */
export const AGENT_TASK_NAME_SET: ReadonlySet<string> = new Set(Object.values(AGENT_TASK_NAMES));

/**
 * Every name a module task may never claim — the union of the core and agents catalogs. The
 * shape `ModuleRegistry`'s `reservedTaskNames` option expects (issue #221).
 */
export const RESERVED_TASK_NAMES: ReadonlySet<string> = new Set([...CORE_TASK_NAME_SET, ...AGENT_TASK_NAME_SET]);

export interface TaskAffinitySets {
  /** Every task name the API runtime's composition root (#91) must register a handler for. */
  api: ReadonlySet<string>;
  /** Every task name the agents runtime's composition root (#91) must register a handler for. */
  agents: ReadonlySet<string>;
}

/**
 * Resolves the full runtime-affinity picture (issue #221): the closed core API/agents catalogs
 * plus every active module task, partitioned by its manifest `queueAffinity`. #91's two
 * composition roots call this before either reports readiness, to prove their own registered
 * handler set matches the runtime they were started as.
 *
 * Throws if an active module task's name collides with a core/agent catalog name — defense in
 * depth mirroring `mergeModuleTaskList`'s own guard below, in case a caller constructs
 * `ModuleRegistry` without `reservedTaskNames: RESERVED_TASK_NAMES`. A module task can never
 * land in both sets: its `queueAffinity` is a single mandatory enum value, not a list.
 */
export async function resolveTaskAffinitySets(moduleRegistry: ModuleRegistry): Promise<TaskAffinitySets> {
  const api = new Set<string>(CORE_TASK_NAME_SET);
  const agents = new Set<string>(AGENT_TASK_NAME_SET);
  const moduleTasks = await moduleRegistry.getTasks();
  for (const task of moduleTasks) {
    if (api.has(task.name) || agents.has(task.name)) {
      throw new Error(`Module "${task.moduleId}" task "${task.name}" collides with a core/agent task name`);
    }
    (task.queueAffinity === "api" ? api : agents).add(task.name);
  }
  return { api, agents };
}

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
    // Issue #167: a module task is enqueued through the same `enqueueJob` envelope as a core
    // one, so it restores its producer's trace the same way — `registerTask` unwraps the
    // envelope before `wrapped` ever sees the payload, so `payloadSchema.parse` still validates
    // the module's own business shape, not the envelope.
    merged[task.name] = registerTask(task.name, wrapped);
  }
  return merged;
}
