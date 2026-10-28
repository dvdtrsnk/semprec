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
    expect(resolveProperty(property(type, { default: value }), null, undefined, "en").config).toMatchObject({
      default: value,
    });
  });
  it("has an empty config when nothing is stored", () => {
    expect(resolveProperty(property("text", {}), null, undefined, "en").config).toEqual({});
  });
  it("keeps unsupported config out of the projection", () => {
    expect(resolveProperty(property("relation", { default: "id" }), null, undefined, "en").config).toEqual({});
  });
});

describe("typed config and filterable projection (issue #1360)", () => {
  it("returns an empty relation config when no definition is readable", () => {
    const resolved = resolveProperty(property("relation", { targetDatabaseId: "db" }), null, undefined, "en");
    expect(resolved).toMatchObject({ id: "property", type: "relation", filterable: true, config: {} });
  });
  it("projects target database and stored cardinality for a relation", () => {
    const definitions = new Map([
      ["property", { id: "def", propertyIdA: "property", propertyIdB: null, cardinality: "many_to_many" as const }],
    ]);
    expect(
      resolveProperty(property("relation", { targetDatabaseId: "db" }), null, undefined, "en", definitions).config,
    ).toEqual({ targetDatabaseId: "db", cardinality: "many_to_many" });
  });
  it("defaults date includeTime to false", () => {
    expect(resolveProperty(property("date", {}), null, undefined, "en").config).toEqual({ includeTime: false });
    expect(resolveProperty(property("date", { includeTime: true }), null, undefined, "en").config).toEqual({
      includeTime: true,
    });
  });
  it("makes a number filterable only with non-empty filterPresets", () => {
    expect(resolveProperty(property("number", {}), null, undefined, "en")).toMatchObject({
      filterable: false,
      config: {},
    });
    expect(resolveProperty(property("number", { filterPresets: [] }), null, undefined, "en").filterable).toBe(false);
    expect(resolveProperty(property("number", { filterPresets: [{ key: "a" }] }), null, undefined, "en")).toMatchObject(
      { filterable: true, config: { filterPresets: [{ key: "a" }] } },
    );
  });
  it.each(["text", "longText", "url", "file"] as const)("treats %s as unfilterable with an empty config", (type) => {
    expect(resolveProperty(property(type, {}), null, undefined, "en")).toMatchObject({ filterable: false, config: {} });
  });
});
