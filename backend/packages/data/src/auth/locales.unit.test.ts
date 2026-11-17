import { describe, expect, it } from "vitest";
import { isSupportedLocale, SUPPORTED_LOCALES } from "./locales.js";

describe("supported locales (issue #1704)", () => {
  it("lists Czech and English", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["cs", "en"]);
  });

  it.each(["cs", "en"])("accepts %s", (value) => {
    expect(isSupportedLocale(value)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["another language", "de"],
    ["an empty string", ""],
    ["an upper-case code", "EN"],
    ["a code with surrounding whitespace", " cs "],
    ["a region-qualified code", "en-US"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an array holding a supported code", ["cs"]],
    ["an object", { locale: "cs" }],
  ])("refuses %s", (_name, value) => {
    expect(isSupportedLocale(value)).toBe(false);
  });
});
