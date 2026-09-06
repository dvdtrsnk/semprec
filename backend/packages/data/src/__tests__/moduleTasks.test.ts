import { describe, expect, it } from "vitest";
import type { ModuleRegistry, ModuleTaskDefinition } from "@semprec/module-registry";
import { CORE_TASK_NAMES, type TaskList } from "@semprec/queue";
import { mergeModuleTaskList, CORE_TASK_NAME_SET } from "../moduleTasks.js";

function fakeRegistry(definitions: ModuleTaskDefinition[]): ModuleRegistry {
  return { getTaskDefinitions: async () => definitions } as unknown as ModuleRegistry;
}

describe("CORE_TASK_NAME_SET", () => {
  it("contains every core task name", () => {
    expect(CORE_TASK_NAME_SET.has(CORE_TASK_NAMES.HEARTBEAT_SWEEP)).toBe(true);
    expect(CORE_TASK_NAME_SET.has(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)).toBe(true);
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
      },
    ]);
    const mergedActive = await mergeModuleTaskList(coreTaskList, registryActive);
    expect(Object.keys(mergedActive)).toContain("fixtureModule.processThing");

    const registryInactive = fakeRegistry([]);
    const mergedInactive = await mergeModuleTaskList(coreTaskList, registryInactive);
    expect(Object.keys(mergedInactive)).not.toContain("fixtureModule.processThing");
  });
});
