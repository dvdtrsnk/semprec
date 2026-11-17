import { describe, expect, it } from "vitest";
import { catalogOptionLabels, resolveProperty } from "../manifest/catalogResolution.js";
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
    expect(
      resolveProperty(
        property("number", { filterPresets: [{ value: 3, op: "gte", labelKey: "property.x.value.preset.3" }] }),
        null,
        undefined,
        "en",
      ),
    ).toMatchObject({
      filterable: true,
      config: { filterPresets: [{ value: 3, op: "gte", label: "property.x.value.preset.3" }] },
    });
  });
  it("drops stored presets that fail the shape and is unfilterable when none remains (issue #1622)", () => {
    const resolved = resolveProperty(
      property("number", {
        filterPresets: [
          { key: "a" },
          { value: "5", op: "gte", labelKey: "k" },
          { value: 1, op: "eq", labelKey: "k" },
          { value: 2, op: "lte", labelKey: "k", label: "Up to two" },
        ],
        emptyPreset: { labelKey: "k" },
      }),
      null,
      undefined,
      "en",
    );
    expect(resolved).toMatchObject({
      filterable: true,
      config: { filterPresets: [{ value: 2, op: "lte", label: "Up to two" }] },
    });
    expect(resolved.config.emptyPreset).toBeUndefined();
    const none = resolveProperty(
      property("number", { filterPresets: [{ key: "a" }], emptyPreset: { labelKey: "k", matchZero: false } }),
      null,
      undefined,
      "en",
    );
    expect(none.filterable).toBe(false);
    expect(none.config).toEqual({ emptyPreset: { label: "k", matchZero: false } });
  });
  it.each(["text", "longText", "url", "file"] as const)("treats %s as unfilterable with an empty config", (type) => {
    expect(resolveProperty(property(type, {}), null, undefined, "en")).toMatchObject({ filterable: false, config: {} });
  });
});

describe("catalogOptionLabels (issue #1699)", () => {
  const catalogs = {
    cs: {
      "property.healthRecords.tags.option.medication": "Léky",
      "property.healthRecords.tags.option.czechOnly": "Jen česky",
    },
    en: {
      "property.healthRecords.tags.option.medication": "Medication",
      "property.healthRecords.tags.option.englishOnly": "English only",
    },
  };

  it("returns the Czech and the English entry of an option both catalogs name", () => {
    expect(catalogOptionLabels(catalogs, "healthRecords", "tags", "medication")).toEqual(["Léky", "Medication"]);
  });

  it("returns only the entry that exists when one catalog names the option", () => {
    expect(catalogOptionLabels(catalogs, "healthRecords", "tags", "czechOnly")).toEqual(["Jen česky"]);
    expect(catalogOptionLabels(catalogs, "healthRecords", "tags", "englishOnly")).toEqual(["English only"]);
  });

  it("returns nothing for an option, property or database the catalogs do not name", () => {
    expect(catalogOptionLabels(catalogs, "healthRecords", "tags", "bylinky")).toEqual([]);
    expect(catalogOptionLabels(catalogs, "healthRecords", "status", "medication")).toEqual([]);
    expect(catalogOptionLabels(catalogs, null, "tags", "medication")).toEqual([]);
  });

  it("returns nothing without catalogs", () => {
    expect(catalogOptionLabels(undefined, "healthRecords", "tags", "medication")).toEqual([]);
  });
});
