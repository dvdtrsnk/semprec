import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from "./displayName.js";

/** The `ValidationError` a refused value raises; any other outcome fails the test. */
function refusalOf(value: unknown): ValidationError {
  try {
    normalizeDisplayName(value);
  } catch (err) {
    if (err instanceof ValidationError) return err;
    throw err;
  }
  throw new Error(`expected normalizeDisplayName to refuse ${JSON.stringify(value)}`);
}

describe("normalizeDisplayName (issue #1513)", () => {
  it("gives null for an absent or null value", () => {
    expect(normalizeDisplayName(undefined)).toBeNull();
    expect(normalizeDisplayName(null)).toBeNull();
  });

  it("trims surrounding whitespace before it stores the name", () => {
    expect(normalizeDisplayName("  David  ")).toBe("David");
  });

  it("accepts a name of exactly the maximum length", () => {
    const name = "a".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(normalizeDisplayName(name)).toBe(name);
  });

  it("refuses a name one character over the maximum, with the field named", () => {
    const err = refusalOf("a".repeat(DISPLAY_NAME_MAX_LENGTH + 1));
    expect(err.details).toEqual({ field: "displayName" });
  });

  it("counts the length after trimming, so padding does not count against the maximum", () => {
    expect(normalizeDisplayName(`  ${"a".repeat(DISPLAY_NAME_MAX_LENGTH)}  `)).toBe(
      "a".repeat(DISPLAY_NAME_MAX_LENGTH),
    );
  });

  it("counts code points, so 80 astral characters (160 UTF-16 units) are accepted", () => {
    const name = "😀".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(name.length).toBe(DISPLAY_NAME_MAX_LENGTH * 2);
    expect(normalizeDisplayName(name)).toBe(name);
  });

  it("refuses 81 astral characters", () => {
    expect(refusalOf("😀".repeat(DISPLAY_NAME_MAX_LENGTH + 1)).details).toEqual({ field: "displayName" });
  });

  it("refuses an empty string and a whitespace-only string as blank, not as NULL", () => {
    for (const value of ["", "   ", "\t\n"]) {
      expect(refusalOf(value).details).toEqual({ field: "displayName" });
    }
  });

  it("refuses a name containing a NUL character, which Postgres text cannot store", () => {
    const err = refusalOf("Da\u0000vid");
    expect(err.details).toEqual({ field: "displayName" });
  });

  it.each([
    ["a number", 42],
    ["a boolean", true],
    ["an array", ["David"]],
    ["an object", { name: "David" }],
  ])("refuses %s with the field named", (_label, value) => {
    expect(refusalOf(value).details).toEqual({ field: "displayName" });
  });
});
