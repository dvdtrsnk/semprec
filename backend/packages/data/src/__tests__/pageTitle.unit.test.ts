import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { normalizePageTitle, PAGE_TITLE_MAX_LENGTH } from "../docs/pageTitle.js";

describe("normalizePageTitle", () => {
  it("turns every run of line breaks into one space and trims the result", () => {
    expect(normalizePageTitle("  Release\nchecklist  ")).toBe("Release checklist");
    expect(normalizePageTitle("a\r\nb")).toBe("a b");
    expect(normalizePageTitle("a\r\n\r\n\nb\rc d e")).toBe("a b c d e");
    expect(normalizePageTitle("\n\nonly trimmed\n")).toBe("only trimmed");
  });

  it("accepts an empty title", () => {
    expect(normalizePageTitle("")).toBe("");
    expect(normalizePageTitle(" \r\n ")).toBe("");
  });

  it("accepts a title of exactly the limit and refuses one character more, counting code points", () => {
    expect(PAGE_TITLE_MAX_LENGTH).toBe(500);
    expect(normalizePageTitle("x".repeat(500))).toHaveLength(500);
    // 500 astral characters are 1000 UTF-16 units but 500 code points.
    expect(Array.from(normalizePageTitle("\u{1F4D3}".repeat(500)))).toHaveLength(500);

    let error: unknown;
    try {
      normalizePageTitle("x".repeat(501));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "title" } });
  });

  it("measures the limit after the normalization, not before", () => {
    expect(normalizePageTitle(`${"x".repeat(500)}\n\n   `)).toHaveLength(500);
  });

  it("cuts an over-long title to the limit, without trailing spaces, when asked to truncate instead of failing", () => {
    expect(normalizePageTitle("x".repeat(600), { truncate: true })).toBe("x".repeat(500));
    // The cut falls inside a run of spaces: they are not left at the end.
    expect(normalizePageTitle(`${"x".repeat(499)} yyyy`, { truncate: true })).toBe("x".repeat(499));
    // A title within the limit is only normalized.
    expect(normalizePageTitle(" a\nb ", { truncate: true })).toBe("a b");
    // Code points, not UTF-16 units, are cut.
    expect(Array.from(normalizePageTitle("\u{1F4D3}".repeat(600), { truncate: true }))).toHaveLength(500);
  });
});
