import { describe, expect, it } from "vitest";
import { resolveProperty } from "../manifest/catalogResolution.js";
import type { PropertyRow, PropertyType } from "../types.js";

function property(type: PropertyType, config: Record<string, unknown>): PropertyRow {
  return {
    id: "property",
    databaseId: "database",
    key: "value",
    name: "Value",
    type,
    config,
    owner: "user",
    ownerProcess: null,
    locked: false,
    migrationStatus: "stable",
  };
}

describe("default config projection", () => {
  it.each([
    ["select", "inProgress"],
    ["multi_select", "one"],
    ["checkbox", false],
    ["number", 0],
    ["text", ""],
    ["date", "today"],
  ] as const)("passes the stored %s default through", (type, value) => {
    expect(resolveProperty(property(type, { default: value }), null, undefined, "en").config).toEqual({
      default: value,
    });
  });
  it("omits config when no default is stored", () => {
    expect(resolveProperty(property("text", {}), null, undefined, "en")).not.toHaveProperty("config");
  });
  it("keeps unsupported config out of the projection", () => {
    expect(resolveProperty(property("relation", { default: "id" }), null, undefined, "en")).not.toHaveProperty(
      "config",
    );
  });
});
