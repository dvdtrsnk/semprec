import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../registry.js";
import { moduleManifestSchema } from "../manifest.js";
import { manifest } from "./fixtures/searchFieldsModule.js";

describe("database search fields", () => {
  it("validates and projects declared, absent and empty search fields", async () => {
    const registry = new ModuleRegistry(() => new Set(["searchFixture"]));
    await registry.loadModule(new URL("./fixtures/searchFieldsModule.js", import.meta.url).href);
    expect(await registry.getDatabases()).toEqual([
      {
        moduleId: "searchFixture",
        key: "searchItems",
        name: "Search items",
        searchFields: ["name", "description", "missing"],
      },
      { moduleId: "searchFixture", key: "defaultItems", name: "Default items" },
      { moduleId: "searchFixture", key: "emptyItems", name: "Empty items", searchFields: [] },
    ]);
  });
  it.each(["name", [1], [""], Array.from({ length: 1001 }, () => "field")])(
    "refuses malformed or oversized search fields: %j",
    (searchFields) => {
      expect(
        moduleManifestSchema.safeParse({ ...manifest, databases: [{ key: "items", name: "Items", searchFields }] })
          .success,
      ).toBe(false);
    },
  );
});
