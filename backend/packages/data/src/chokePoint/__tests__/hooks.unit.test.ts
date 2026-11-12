import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type PoolClient } from "pg";
import type { Item } from "@semprec/shared";
import {
  clearHooksForTests,
  getItemDeleteApprovalGuard,
  hasItemPreWriteTransform,
  registerItemDeleteApprovalGuard,
  registerItemPreWriteTransform,
  registerItemUpdateHook,
  registerRelationEdgeChangedHook,
  registerAutomationBatchReader,
  registerItemDeleteHook,
  registerItemRestoreHook,
  runAutomationBatchReader,
  runItemDeleteHooks,
  runItemRestoreHooks,
  runRelationEdgeChangedHooks,
  runItemPreWriteTransforms,
  runItemUpdateHooks,
  type ItemDeleteHookContext,
  type ItemPreWriteTransformContext,
  type ItemRestoreHookContext,
  type ItemUpdateHookContext,
  type RelationEdgeChangedHookContext,
} from "../hooks.js";
import { ValidationError } from "../../errors.js";
import { SYSTEM_WRITER } from "../writerKind.js";

const offlineClient = Object.assign(new Client(), {
  query: vi.fn(() => {
    throw new Error("Offline fixture cannot query");
  }),
  release: vi.fn(),
});

describe("automation batch reader registry", () => {
  beforeEach(() => clearHooksForTests());

  it("rejects an unregistered reader and resets registration for tests", async () => {
    expect(() => runAutomationBatchReader(offlineClient, ["item"])).toThrow(
      "Automation batch reader is not registered",
    );
    const reader = vi.fn(async () => new Map<string, NonNullable<Item["automation"]>>());
    registerAutomationBatchReader(reader);
    await expect(runAutomationBatchReader(offlineClient, ["item"])).resolves.toEqual(new Map());
    clearHooksForTests();
    expect(() => runAutomationBatchReader(offlineClient, ["item"])).toThrow(
      "Automation batch reader is not registered",
    );
  });

  it("deduplicates the same owner and rejects a replacement", async () => {
    const reader = vi.fn(async () => new Map<string, NonNullable<Item["automation"]>>());
    registerAutomationBatchReader(reader);
    registerAutomationBatchReader(reader);
    expect(() => registerAutomationBatchReader(async () => new Map<string, NonNullable<Item["automation"]>>())).toThrow(
      "Automation batch reader is already registered",
    );
    await runAutomationBatchReader(offlineClient, ["item"]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("forwards the exact client and ids and preserves reader rejection", async () => {
    const ids = ["one", "two"];
    const failure = new Error("reader failed");
    const reader = vi.fn(async (_client: PoolClient, _ids: string[]) => {
      throw failure;
    });
    registerAutomationBatchReader(reader);
    await expect(runAutomationBatchReader(offlineClient, ids)).rejects.toBe(failure);
    expect(reader).toHaveBeenCalledWith(offlineClient, ids);
    expect(reader.mock.calls[0]?.[1]).toBe(ids);
  });
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
    overviewHidden: false,
    archivedAt: null,
  },
  item: { id: "item", databaseId: "db", properties: {}, computed: {}, createdAt: "", updatedAt: "", deletedAt: null },
  propertiesPatch: {},
  writer: SYSTEM_WRITER,
};

describe("changed relation hook registry", () => {
  beforeEach(() => clearHooksForTests());
  const context: RelationEdgeChangedHookContext = {
    client: offlineClient,
    op: "create",
    relationDefinitionId: "definition",
    propertyId: "property",
    itemA: "a",
    itemB: "b",
    metadata: {},
    writer: SYSTEM_WRITER,
  };
  it("deduplicates and runs hooks in registration order", async () => {
    const calls: number[] = [];
    const first = async () => {
      calls.push(1);
    };
    registerRelationEdgeChangedHook(first);
    registerRelationEdgeChangedHook(first);
    registerRelationEdgeChangedHook(async () => {
      calls.push(2);
    });
    await runRelationEdgeChangedHooks(context);
    expect(calls).toEqual([1, 2]);
  });
  it("propagates errors and releases the recursion guard", async () => {
    registerRelationEdgeChangedHook(async () => runRelationEdgeChangedHooks(context));
    await expect(runRelationEdgeChangedHooks(context)).rejects.toThrow("Recursive relation edge change");
    clearHooksForTests();
    await expect(runRelationEdgeChangedHooks(context)).resolves.toBeUndefined();
  });
  it("stops after the first rejection", async () => {
    const later = vi.fn();
    registerRelationEdgeChangedHook(async () => {
      throw new Error("hook failed");
    });
    registerRelationEdgeChangedHook(async () => {
      later();
    });
    await expect(runRelationEdgeChangedHooks(context)).rejects.toThrow("hook failed");
    expect(later).not.toHaveBeenCalled();
  });
  it("allows a different edge in the same client and releases both guards", async () => {
    const seen: string[] = [];
    registerRelationEdgeChangedHook(async (current) => {
      seen.push(current.itemB);
      if (current.itemB === "b") await runRelationEdgeChangedHooks({ ...current, itemB: "c" });
    });
    await runRelationEdgeChangedHooks(context);
    await runRelationEdgeChangedHooks(context);
    expect(seen).toEqual(["b", "c", "b", "c"]);
  });
});

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

describe.each([
  {
    name: "item delete",
    register: registerItemDeleteHook,
    run: runItemDeleteHooks,
    other: { register: registerItemRestoreHook, run: runItemRestoreHooks },
  },
  {
    name: "item restore",
    register: registerItemRestoreHook,
    run: runItemRestoreHooks,
    other: { register: registerItemDeleteHook, run: runItemDeleteHooks },
  },
])("chokePoint/hooks $name registry (issue #1601)", ({ register, run, other }) => {
  const TRASH_CONTEXT: ItemDeleteHookContext & ItemRestoreHookContext = {
    client: offlineClient,
    database: CONTEXT.database,
    item: { ...CONTEXT.item, deletedAt: "2026-11-07T10:00:00.000Z" },
    rootItemId: "root",
    deletedAt: "2026-11-07T10:00:00.000Z",
    deletedAtExact: "2026-11-07T10:00:00.000123Z",
    queueAffinity: new Map(),
    writerKind: "agent",
    agentRunId: "run",
    actingUserId: "user",
  };

  beforeEach(() => {
    clearHooksForTests();
  });

  it("passes the exact context to each hook, in registration order", async () => {
    const seen: Array<[string, unknown]> = [];
    register(async (context) => {
      seen.push(["first", context]);
    });
    register(async (context) => {
      seen.push(["second", context]);
    });

    await run(TRASH_CONTEXT);

    expect(seen).toEqual([
      ["first", TRASH_CONTEXT],
      ["second", TRASH_CONTEXT],
    ]);
  });

  it("runs a hook registered twice only once", async () => {
    const hook = vi.fn(async () => {});
    register(hook);
    register(hook);

    await run(TRASH_CONTEXT);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("propagates the first rejection and runs no later hook", async () => {
    const failure = new ValidationError("vetoed");
    const later = vi.fn(async () => {});
    register(async () => {
      throw failure;
    });
    register(later);

    await expect(run(TRASH_CONTEXT)).rejects.toBe(failure);
    expect(later).not.toHaveBeenCalled();
  });

  it("keeps the delete and restore registries apart", async () => {
    const hook = vi.fn(async () => {});
    other.register(hook);

    await run(TRASH_CONTEXT);
    expect(hook).not.toHaveBeenCalled();
    await other.run(TRASH_CONTEXT);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("is cleared by clearHooksForTests", async () => {
    const hook = vi.fn(async () => {});
    register(hook);

    clearHooksForTests();
    await run(TRASH_CONTEXT);

    expect(hook).not.toHaveBeenCalled();
  });
});

describe("chokePoint/hooks item delete approval guard registry (issue gh-2031)", () => {
  beforeEach(() => {
    clearHooksForTests();
  });

  it("answers the guard registered for a module, and none for a module that registered none", async () => {
    const guard = vi.fn(async () => "refused");
    registerItemDeleteApprovalGuard("mailboxes", guard);

    expect(getItemDeleteApprovalGuard("mailboxes")).toBe(guard);
    expect(getItemDeleteApprovalGuard("events")).toBeUndefined();
  });

  it("refuses a second guard for the same module and keeps the first", () => {
    const first = vi.fn(async () => null);
    registerItemDeleteApprovalGuard("mailboxes", first);

    expect(() => registerItemDeleteApprovalGuard("mailboxes", async () => "other")).toThrow(
      "Duplicate item delete approval guard",
    );
    expect(() => registerItemDeleteApprovalGuard("mailboxes", first)).toThrow("Duplicate item delete approval guard");
    expect(getItemDeleteApprovalGuard("mailboxes")).toBe(first);
  });

  it("is cleared by clearHooksForTests", () => {
    registerItemDeleteApprovalGuard("mailboxes", async () => null);

    clearHooksForTests();

    expect(getItemDeleteApprovalGuard("mailboxes")).toBeUndefined();
  });
});
