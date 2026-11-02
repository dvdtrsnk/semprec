import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  clearHooksForTests,
  hasItemPreWriteTransform,
  registerItemPreWriteTransform,
  registerItemUpdateHook,
  runItemPreWriteTransforms,
  runItemUpdateHooks,
  type ItemPreWriteTransformContext,
  type ItemUpdateHookContext,
} from "../hooks.js";
import { ValidationError } from "../../errors.js";
import { SYSTEM_WRITER } from "../writerKind.js";

const offlineClient = Object.assign(new Client(), {
  query: vi.fn(() => {
    throw new Error("Offline fixture cannot query");
  }),
  release: vi.fn(),
});
afterAll(() => {
  offlineClient.removeAllListeners();
  vi.restoreAllMocks();
});

const CONTEXT: ItemUpdateHookContext = {
  client: offlineClient,
  database: {
    id: "db",
    key: null,
    name: null,
    parentItemId: null,
    ownerProjectItemId: null,
    ownerModuleId: null,
    schemaLocked: false,
    system: false,
    icon: null,
    color: null,
    archivedAt: null,
  },
  item: { id: "item", databaseId: "db", properties: {}, computed: {}, updatedAt: "", deletedAt: null },
  propertiesPatch: {},
  writer: SYSTEM_WRITER,
};

describe("chokePoint/hooks item-update registry", () => {
  beforeEach(() => {
    clearHooksForTests();
  });

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

const PRE_WRITE_CONTEXT: ItemPreWriteTransformContext = {
  client: offlineClient,
  database: CONTEXT.database,
  stored: null,
  patch: { title: "a" },
  writer: SYSTEM_WRITER,
};

describe("chokePoint/hooks item pre-write transform registry", () => {
  beforeEach(() => {
    clearHooksForTests();
  });

  it("returns the patch unchanged and reports no transform for a module that registered none", async () => {
    expect(hasItemPreWriteTransform("events")).toBe(false);
    await expect(runItemPreWriteTransforms("events", PRE_WRITE_CONTEXT)).resolves.toEqual({ title: "a" });
  });

  it("runs a module's transforms in registration order, each receiving the previous output", async () => {
    registerItemPreWriteTransform("events", async ({ patch }) => ({
      ...patch,
      title: `${String(patch.title)} first`,
    }));
    registerItemPreWriteTransform("events", async ({ patch }) => ({
      ...patch,
      title: `${String(patch.title)} second`,
    }));

    await expect(runItemPreWriteTransforms("events", PRE_WRITE_CONTEXT)).resolves.toEqual({
      title: "a first second",
    });
  });

  it("runs a transform registered twice only once", async () => {
    let calls = 0;
    const transform = async ({ patch }: ItemPreWriteTransformContext) => {
      calls += 1;
      return patch;
    };
    registerItemPreWriteTransform("events", transform);
    registerItemPreWriteTransform("events", transform);

    await runItemPreWriteTransforms("events", PRE_WRITE_CONTEXT);

    expect(calls).toBe(1);
  });

  it("keeps each module's transforms apart", async () => {
    registerItemPreWriteTransform("events", async () => ({ title: "events" }));

    expect(hasItemPreWriteTransform("events")).toBe(true);
    expect(hasItemPreWriteTransform("tasks")).toBe(false);
    await expect(runItemPreWriteTransforms("tasks", PRE_WRITE_CONTEXT)).resolves.toEqual({ title: "a" });
  });

  it("propagates a rejection and runs no later transform of the module", async () => {
    let laterRan = false;
    registerItemPreWriteTransform("events", async () => {
      throw new ValidationError("bad title");
    });
    registerItemPreWriteTransform("events", async ({ patch }) => {
      laterRan = true;
      return patch;
    });

    await expect(runItemPreWriteTransforms("events", PRE_WRITE_CONTEXT)).rejects.toThrow("bad title");
    expect(laterRan).toBe(false);
  });

  it("clears every module's transforms with clearHooksForTests", () => {
    registerItemPreWriteTransform("events", async () => ({ title: "events" }));

    clearHooksForTests();

    expect(hasItemPreWriteTransform("events")).toBe(false);
  });
});
