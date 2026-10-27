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
