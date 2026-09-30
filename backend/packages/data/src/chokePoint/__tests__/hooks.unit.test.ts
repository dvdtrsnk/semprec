import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { registerItemUpdateHook, runItemUpdateHooks, type ItemUpdateHookContext } from "../hooks.js";

const CONTEXT: ItemUpdateHookContext = {
  client: {} as PoolClient,
  database: {
    id: "db",
    key: null,
    name: null,
    parentItemId: null,
    ownerProjectItemId: null,
    ownerModuleId: null,
    schemaLocked: false,
    system: false,
    archivedAt: null,
  },
  item: { id: "item", databaseId: "db", properties: {}, computed: {}, updatedAt: "", deletedAt: null },
  propertiesPatch: {},
};

describe("chokePoint/hooks item-update registry", () => {
  it("runs a hook registered twice only once", async () => {
    let calls = 0;
    const hook = async () => {
      calls += 1;
    };
    registerItemUpdateHook(hook);
    registerItemUpdateHook(hook);

    await runItemUpdateHooks(CONTEXT);

    expect(calls).toBe(1);
  });

  it("runs hooks in registration order", async () => {
    const order: string[] = [];
    registerItemUpdateHook(async () => {
      order.push("first");
    });
    registerItemUpdateHook(async () => {
      order.push("second");
    });

    await runItemUpdateHooks(CONTEXT);

    expect(order).toEqual(["first", "second"]);
  });

  it("stops the sequence and rejects run* when a hook rejects", async () => {
    let secondRan = false;
    registerItemUpdateHook(async () => {
      throw new Error("boom");
    });
    registerItemUpdateHook(async () => {
      secondRan = true;
    });

    await expect(runItemUpdateHooks(CONTEXT)).rejects.toThrow("boom");
    expect(secondRan).toBe(false);
  });
});
