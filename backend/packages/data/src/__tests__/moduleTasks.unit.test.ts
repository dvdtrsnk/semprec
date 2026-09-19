import { describe, expect, it } from "vitest";
import type { ModuleRegistry, ModuleTaskDefinition, ModuleTaskProjection } from "@semprec/module-registry";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, type TaskList } from "@semprec/queue";
import {
  mergeModuleTaskList,
  mergeModuleTaskListForAffinity,
  assertTaskListMatchesAffinity,
  CORE_TASK_NAME_SET,
  AGENT_TASK_NAME_SET,
  RESERVED_TASK_NAMES,
  resolveTaskAffinitySets,
} from "../moduleTasks.js";

function fakeRegistry(definitions: ModuleTaskDefinition[]): ModuleRegistry {
  return { getTaskDefinitions: async () => definitions } as unknown as ModuleRegistry;
}

function fakeTaskRegistry(tasks: ModuleTaskProjection[]): ModuleRegistry {
  return { getTasks: async () => tasks } as unknown as ModuleRegistry;
}

describe("CORE_TASK_NAME_SET", () => {
  it("contains every core task name", () => {
    expect(CORE_TASK_NAME_SET.has(CORE_TASK_NAMES.HEARTBEAT_SWEEP)).toBe(true);
    expect(CORE_TASK_NAME_SET.has(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)).toBe(true);
  });
});

describe("AGENT_TASK_NAME_SET", () => {
  it("contains exactly the three closed agent task names", () => {
    expect([...AGENT_TASK_NAME_SET].sort()).toEqual(
      [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, AGENT_TASK_NAMES.AGENT_RUN, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN].sort(),
    );
  });
});

describe("RESERVED_TASK_NAMES", () => {
  it("is the union of the core and agent catalogs", () => {
    expect(RESERVED_TASK_NAMES.has(CORE_TASK_NAMES.HEARTBEAT_SWEEP)).toBe(true);
    expect(RESERVED_TASK_NAMES.has(AGENT_TASK_NAMES.AGENT_RUN)).toBe(true);
  });
});

describe("resolveTaskAffinitySets", () => {
  it("partitions active module tasks by their manifest queueAffinity, alongside the core/agent catalogs", async () => {
    const registry = fakeTaskRegistry([
      {
        moduleId: "fixture-module",
        name: "fixtureModule.apiThing",
        payloadSchemaExport: "s",
        handlerExport: "h",
        queueAffinity: "api",
      },
      {
        moduleId: "fixture-module",
        name: "fixtureModule.agentThing",
        payloadSchemaExport: "s",
        handlerExport: "h",
        queueAffinity: "agents",
      },
    ]);

    const { api, agents } = await resolveTaskAffinitySets(registry);
    expect(api.has(CORE_TASK_NAMES.HEARTBEAT_SWEEP)).toBe(true);
    expect(api.has("fixtureModule.apiThing")).toBe(true);
    expect(agents.has(AGENT_TASK_NAMES.AGENT_RUN)).toBe(true);
    expect(agents.has("fixtureModule.agentThing")).toBe(true);
    expect(api.has("fixtureModule.agentThing")).toBe(false);
    expect(agents.has("fixtureModule.apiThing")).toBe(false);
  });

  it("rejects a module task name colliding with a core/agent catalog name, even if the registry didn't reserve it", async () => {
    const registry = fakeTaskRegistry([
      {
        moduleId: "fixture-module",
        name: CORE_TASK_NAMES.HEARTBEAT_SWEEP,
        payloadSchemaExport: "s",
        handlerExport: "h",
        queueAffinity: "api",
      },
    ]);
    await expect(resolveTaskAffinitySets(registry)).rejects.toThrow(/collides with a core\/agent task name/);
  });
});

describe("mergeModuleTaskList", () => {
  const coreTaskList: TaskList = {
    [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {},
  };

  it("adds an active module's task, validating its payload before invoking the handler", async () => {
    const calls: unknown[] = [];
    const registry = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: "fixtureModule.processThing",
        payloadSchema: { parse: (raw: unknown) => ({ ...(raw as object), validated: true }) },
        handler: async (payload: unknown) => {
          calls.push(payload);
        },
        queueAffinity: "api",
      },
    ]);

    const merged = await mergeModuleTaskList(coreTaskList, registry);
    expect(Object.keys(merged).sort()).toEqual([CORE_TASK_NAMES.HEARTBEAT_SWEEP, "fixtureModule.processThing"].sort());

    await merged["fixtureModule.processThing"]!({ itemId: "abc" }, {} as never);
    expect(calls).toEqual([{ itemId: "abc", validated: true }]);
  });

  it("leaves the core task list's own handlers untouched", async () => {
    const registry = fakeRegistry([]);
    const merged = await mergeModuleTaskList(coreTaskList, registry);
    expect(merged[CORE_TASK_NAMES.HEARTBEAT_SWEEP]).toBe(coreTaskList[CORE_TASK_NAMES.HEARTBEAT_SWEEP]);
  });

  it("propagates a payload schema rejection instead of running the handler", async () => {
    let ran = false;
    const registry = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: "fixtureModule.processThing",
        payloadSchema: {
          parse: () => {
            throw new Error("invalid payload");
          },
        },
        handler: async () => {
          ran = true;
        },
        queueAffinity: "api",
      },
    ]);

    const merged = await mergeModuleTaskList(coreTaskList, registry);
    await expect(merged["fixtureModule.processThing"]!({}, {} as never)).rejects.toThrow("invalid payload");
    expect(ran).toBe(false);
  });

  it("omits a module task once its module is no longer active", async () => {
    const registryActive = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: "fixtureModule.processThing",
        payloadSchema: { parse: (raw: unknown) => raw },
        handler: async () => {},
        queueAffinity: "api",
      },
    ]);
    const mergedActive = await mergeModuleTaskList(coreTaskList, registryActive);
    expect(Object.keys(mergedActive)).toContain("fixtureModule.processThing");

    const registryInactive = fakeRegistry([]);
    const mergedInactive = await mergeModuleTaskList(coreTaskList, registryInactive);
    expect(Object.keys(mergedInactive)).not.toContain("fixtureModule.processThing");
  });

  it("rejects a module task colliding with a core task name, even if the registry didn't reserve it", async () => {
    const registry = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: CORE_TASK_NAMES.HEARTBEAT_SWEEP,
        payloadSchema: { parse: (raw: unknown) => raw },
        handler: async () => {},
        queueAffinity: "api",
      },
    ]);
    await expect(mergeModuleTaskList(coreTaskList, registry)).rejects.toThrow(/collides with a core task name/);
  });
});

describe("mergeModuleTaskListForAffinity", () => {
  const coreTaskList: TaskList = {
    [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {},
  };

  it("adds only the module tasks matching the requested affinity", async () => {
    const registry = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: "fixtureModule.apiThing",
        payloadSchema: { parse: (raw: unknown) => raw },
        handler: async () => {},
        queueAffinity: "api",
      },
      {
        moduleId: "fixture-module",
        name: "fixtureModule.agentsThing",
        payloadSchema: { parse: (raw: unknown) => raw },
        handler: async () => {},
        queueAffinity: "agents",
      },
    ]);

    const merged = await mergeModuleTaskListForAffinity(coreTaskList, registry, "api");
    expect(Object.keys(merged).sort()).toEqual([CORE_TASK_NAMES.HEARTBEAT_SWEEP, "fixtureModule.apiThing"].sort());
  });

  it("rejects a module task colliding with a core/agent task name", async () => {
    const registry = fakeRegistry([
      {
        moduleId: "fixture-module",
        name: AGENT_TASK_NAMES.AGENT_RUN,
        payloadSchema: { parse: (raw: unknown) => raw },
        handler: async () => {},
        queueAffinity: "agents",
      },
    ]);
    await expect(mergeModuleTaskListForAffinity(coreTaskList, registry, "agents")).rejects.toThrow(
      /collides with a core\/agent task name/,
    );
  });
});

describe("assertTaskListMatchesAffinity", () => {
  it("passes silently when the registered handlers exactly match the expected set", () => {
    const taskList: TaskList = {
      [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {},
    };
    expect(() =>
      assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.HEARTBEAT_SWEEP]), "api"),
    ).not.toThrow();
  });

  it("throws an actionable error when a handler is missing", () => {
    const taskList: TaskList = {};
    expect(() => assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.HEARTBEAT_SWEEP]), "api")).toThrow(
      /missing handler\(s\) for: heartbeatSweep/,
    );
  });

  it("throws an actionable error when a handler is registered outside its affinity", () => {
    const taskList: TaskList = {
      [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {},
      [AGENT_TASK_NAMES.AGENT_RUN]: async () => {},
    };
    expect(() => assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.HEARTBEAT_SWEEP]), "api")).toThrow(
      /unexpected handler\(s\) outside its affinity for: agentRun/,
    );
  });

  it("reports both missing and unexpected handlers together", () => {
    const taskList: TaskList = {
      [AGENT_TASK_NAMES.AGENT_RUN]: async () => {},
    };
    expect(() => assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.HEARTBEAT_SWEEP]), "api")).toThrow(
      /missing handler\(s\) for: heartbeatSweep; unexpected handler\(s\) outside its affinity for: agentRun/,
    );
  });
});
