import { describe, expect, it } from "vitest";
import { moduleManifestSchema } from "../manifest.js";
import { ModuleRegistry } from "../registry.js";
import { manifest } from "./fixtures/searchFieldsModule.js";

function parse(database: Record<string, unknown>) {
  return moduleManifestSchema.safeParse({ ...manifest, databases: [{ key: "items", name: "Items", ...database }] });
}

describe("database collection metadata descriptor", () => {
  it("accepts a manifest that omits every new field", () => {
    expect(parse({}).success).toBe(true);
  });

  it("accepts valid icon, color, orders and override", () => {
    expect(
      parse({ icon: "book-open", color: "#A2845E", overviewOrder: 7, switcherOrder: null, clientVisible: true })
        .success,
    ).toBe(true);
  });

  it.each([{ color: "red" }, { color: "#12345" }, { color: "#GGGGGG" }, { color: "007AFF" }])(
    "rejects a bad color: %j",
    (field) => {
      expect(parse(field).success).toBe(false);
    },
  );

  it.each([{ overviewOrder: 0 }, { switcherOrder: -1 }, { overviewOrder: 1.5 }, { switcherOrder: "1" }])(
    "rejects a zero, negative or non-integer order: %j",
    (field) => {
      expect(parse(field).success).toBe(false);
    },
  );

  it.each([{ icon: "Folder" }, { icon: "1folder" }, { icon: "" }, { icon: "a".repeat(65) }, { icon: "has space" }])(
    "rejects a bad icon: %j",
    (field) => {
      expect(parse(field).success).toBe(false);
    },
  );

  it("rejects a non-boolean clientVisible", () => {
    expect(parse({ clientVisible: "yes" }).success).toBe(false);
  });

  it.each([true, false])("accepts overviewHideable %s", (overviewHideable) => {
    expect(parse({ overviewHideable }).success).toBe(true);
  });

  it.each(["yes", 1, null])("rejects a non-boolean overviewHideable: %j", (overviewHideable) => {
    expect(parse({ overviewHideable }).success).toBe(false);
  });

  it("projects overviewHideable as declared and omits it for a database that declares none", async () => {
    const registry = new ModuleRegistry(() => new Set(["overviewHideableFixture"]));
    await registry.loadModule(new URL("./fixtures/overviewHideableModule.js", import.meta.url).href);
    expect(await registry.getDatabases()).toEqual([
      { moduleId: "overviewHideableFixture", key: "hideableItems", name: "Hideable items", overviewHideable: true },
      { moduleId: "overviewHideableFixture", key: "fixedItems", name: "Fixed items", overviewHideable: false },
      { moduleId: "overviewHideableFixture", key: "plainItems", name: "Plain items" },
    ]);
  });
});
