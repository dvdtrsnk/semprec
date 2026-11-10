import { describe, expect, it } from "vitest";
import { isUniqueViolation, assertValidPropertyConfig } from "../propertiesStore.js";

const CONSTRAINT = "properties_database_id_key_key";

describe("isUniqueViolation", () => {
  it("is true for a 23505 error naming the constraint", () => {
    expect(isUniqueViolation({ code: "23505", constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("is false for a 23505 error naming another constraint", () => {
    expect(isUniqueViolation({ code: "23505", constraint: "other" }, CONSTRAINT)).toBe(false);
  });

  it("is false for the right constraint with another code", () => {
    expect(isUniqueViolation({ code: "23503", constraint: CONSTRAINT }, CONSTRAINT)).toBe(false);
  });

  it("is false for null, undefined, a string and an object without code", () => {
    expect(isUniqueViolation(null, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(undefined, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation("23505", CONSTRAINT)).toBe(false);
    expect(isUniqueViolation({ constraint: CONSTRAINT }, CONSTRAINT)).toBe(false);
  });
});

describe("property config defaults", () => {
  it.each([
    ["text", { default: "" }],
    ["number", { default: 0 }],
    ["checkbox", { default: false }],
    ["select", { default: "done", options: [{ key: "done" }] }],
    ["multi_select", { default: "done", options: [{ key: "done" }] }],
    ["date", { default: "today" }],
    ["date", { default: "today", includeTime: false }],
  ] as const)("accepts %s default %j", (type, config) => {
    expect(() => assertValidPropertyConfig(type, config)).not.toThrow();
  });

  it.each([
    ["text", { default: 1 }],
    ["text", { default: null }],
    ["text", { default: undefined }],
    ["text", { default: {} }],
    ["text", { default: [] }],
    ["number", { default: "1" }],
    ["number", { default: Infinity }],
    ["number", { default: NaN }],
    ["checkbox", { default: "true" }],
    ["select", { default: "unknown", options: [{ key: "done" }] }],
    ["multi_select", { default: ["done"], options: [{ key: "done" }] }],
    ["select", { default: "done" }],
    ["date", { default: "today", includeTime: true }],
    ["date", { default: "2026-01-01" }],
    ["title", { default: "title" }],
    ["relation", { default: "id" }],
  ] as const)("rejects %s default %j on config", (type, config) => {
    expect(() => assertValidPropertyConfig(type, config)).toThrow(
      expect.objectContaining({
        code: "validation_failed",
        details: { field: "config" },
      }),
    );
  });

  it("allows absent defaults and absent config", () => {
    expect(() => assertValidPropertyConfig("date", { includeTime: true })).not.toThrow();
    expect(() => assertValidPropertyConfig("relation", undefined)).not.toThrow();
  });
});

describe("select option colors", () => {
  it.each(["select", "multi_select"] as const)("normalizes %s colors on write", (type) => {
    const config = { options: [{ key: "red", color: "#ff3b30" }, { key: "plain" }] };
    assertValidPropertyConfig(type, config);
    expect(config.options).toEqual([{ key: "red", color: "#FF3B30" }, { key: "plain" }]);
  });
  it.each(["red", "#FFF", "#GGGGGG", 1, null, undefined])("rejects invalid color %j", (color) => {
    expect(() => assertValidPropertyConfig("select", { options: [{ key: "x", color }] })).toThrow(
      expect.objectContaining({ code: "validation_failed", details: { field: "config" } }),
    );
  });
});

describe("number filter presets (issue #1622)", () => {
  const preset = { value: 5, op: "gte", labelKey: "property.books.rating.preset.5" };
  const emptyPreset = { labelKey: "property.books.rating.preset.none", matchZero: true };
  const rejected = expect.objectContaining({ code: "validation_failed", status: 400, details: { field: "config" } });

  it.each([
    [{ filterPresets: [preset] }],
    [{ filterPresets: [preset, { value: 15, op: "lte", labelKey: "k", label: "Up to 15 min" }], emptyPreset }],
    [{ filterPresets: [preset], emptyPreset: { ...emptyPreset, label: "No rating" }, default: 0 }],
    [{ filterPresets: Array.from({ length: 10 }, (_, value) => ({ value, op: "gte", labelKey: "k" })) }],
  ])("accepts %j on a number property", (config) => {
    expect(() => assertValidPropertyConfig("number", config)).not.toThrow();
  });

  it.each([
    ["op eq", { filterPresets: [{ ...preset, op: "eq" }] }],
    ["a non-numeric value", { filterPresets: [{ ...preset, value: "5" }] }],
    ["an infinite value", { filterPresets: [{ ...preset, value: Infinity }] }],
    ["an empty array", { filterPresets: [] }],
    ["more than 10 presets", { filterPresets: Array.from({ length: 11 }, () => preset) }],
    ["an unknown preset key", { filterPresets: [{ ...preset, color: "#FF0000" }] }],
    ["an empty labelKey", { filterPresets: [{ ...preset, labelKey: "" }] }],
    ["an empty label", { filterPresets: [{ ...preset, label: "" }] }],
    ["a filterPresets object", { filterPresets: preset }],
    ["emptyPreset without filterPresets", { emptyPreset }],
    ["an unknown emptyPreset key", { filterPresets: [preset], emptyPreset: { ...emptyPreset, value: 0 } }],
    ["emptyPreset without matchZero", { filterPresets: [preset], emptyPreset: { labelKey: "k" } }],
  ])("rejects %s with 400 on config", (_case, config) => {
    expect(() => assertValidPropertyConfig("number", config)).toThrow(rejected);
  });

  it.each(["text", "select", "date"] as const)("rejects presets on a %s property", (type) => {
    expect(() => assertValidPropertyConfig(type, { filterPresets: [preset] })).toThrow(rejected);
    expect(() => assertValidPropertyConfig(type, { emptyPreset })).toThrow(rejected);
  });

  it("leaves a number config without presets alone", () => {
    expect(() => assertValidPropertyConfig("number", { default: 3 })).not.toThrow();
  });
});
