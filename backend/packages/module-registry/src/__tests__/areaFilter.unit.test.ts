import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../registry.js";
import { moduleManifestSchema } from "../manifest.js";
import { manifest } from "./fixtures/areaFilterModule.js";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

const SLOT = { areaValue: true };

function withAreaFilter(areaFilter: unknown): unknown {
  return { ...manifest, databases: [{ key: "items", name: "Items", areaFilter }] };
}

describe("database area filters (issue #1597)", () => {
  it("loads a declared area filter and projects it, absent for a database without one", async () => {
    const registry = new ModuleRegistry(() => new Set(["areaFilterFixture"]));
    await registry.loadModule(fixturePath("areaFilterModule.js"));
    const databases = await registry.getDatabases();
    expect(databases).toEqual([
      {
        moduleId: "areaFilterFixture",
        key: "areaFilteredItems",
        name: "Area filtered items",
        areaFilter: manifest.databases[0]?.areaFilter,
      },
      { moduleId: "areaFilterFixture", key: "plainItems", name: "Plain items" },
    ]);
    // The projection is a copy: editing it cannot change what the next projection returns.
    const projected = databases[0]?.areaFilter;
    if (projected?.type !== "or") throw new Error("expected an or-template");
    projected.nodes.length = 0;
    expect((await registry.getDatabases())[0]?.areaFilter).toEqual(manifest.databases[0]?.areaFilter);
  });

  it("rejects a manifest whose area filter has an invalid path when the module is loaded", async () => {
    const registry = new ModuleRegistry(() => new Set(["areaFilterInvalidPathFixture"]));
    await expect(registry.loadModule(fixturePath("areaFilterInvalidPathModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it.each([
    ["a one-hop path", { type: "relation_path_contains", path: ["project"], value: SLOT }],
    ["a three-hop path", { type: "relation_path_contains", path: ["a", "b", "c"], value: SLOT }],
    ["an empty path key", { type: "relation_path_contains", path: ["project", ""], value: SLOT }],
    ["an empty property key", { type: "relation_contains", property: "", value: SLOT }],
    ["a misspelled property field", { type: "relation_contains", proprety: "area", value: SLOT }],
    ["a literal area id instead of the slot", { type: "relation_contains", property: "area", value: "x" }],
    ["a false slot", { type: "relation_contains", property: "area", value: { areaValue: false } }],
    ["a condition outside the template set", { type: "equals", property: "area", value: SLOT }],
    ["a tree without any slot", { type: "relation_is_empty", property: "project" }],
    ["an empty or", { type: "or", nodes: [] }],
    [
      "nesting beyond the depth bound",
      {
        type: "and",
        nodes: [
          {
            type: "or",
            nodes: [
              {
                type: "and",
                nodes: [{ type: "or", nodes: [{ type: "relation_contains", property: "a", value: SLOT }] }],
              },
            ],
          },
        ],
      },
    ],
  ])("refuses an area filter with %s", (_label, areaFilter) => {
    expect(moduleManifestSchema.safeParse(withAreaFilter(areaFilter)).success).toBe(false);
  });

  it("accepts the three declared template shapes", () => {
    for (const areaFilter of [
      { type: "relation_contains", property: "area", value: SLOT },
      { type: "relation_path_contains", path: ["project", "area"], value: SLOT },
      manifest.databases[0]?.areaFilter,
    ]) {
      expect(moduleManifestSchema.safeParse(withAreaFilter(areaFilter)).success).toBe(true);
    }
  });
});
