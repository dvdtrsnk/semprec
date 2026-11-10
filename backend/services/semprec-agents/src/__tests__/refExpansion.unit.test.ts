import { describe, expect, it } from "vitest";
import { boundRefSections, MAX_REF_CONTEXT_CHARS, MAX_TURN_REF_CONTEXT_CHARS } from "../refExpansionLimits.js";

describe("reference context limits", () => {
  it("keeps short sections in order without a truncation notice", () => {
    expect(boundRefSections(["first", "second"])).toBe("first\n\nsecond");
  });

  it("marks and bounds an oversized individual reference", () => {
    const result = boundRefSections(["a".repeat(MAX_REF_CONTEXT_CHARS + 1)]);
    expect(result).toHaveLength(MAX_REF_CONTEXT_CHARS);
    expect(result).toMatch(/\n\[truncated\]$/);
  });

  it("preserves a long reference when short neighbors leave room for it", () => {
    const long = "a".repeat(7_000);
    expect(boundRefSections([long, ...Array.from({ length: 19 }, () => "b")])).toBe(
      [long, ...Array.from({ length: 19 }, () => "b")].join("\n\n"),
    );
  });

  it("bounds and marks the whole turn even when each reference fits", () => {
    const result = boundRefSections(Array.from({ length: 5 }, () => "b".repeat(MAX_REF_CONTEXT_CHARS)));
    expect(result.length).toBeLessThanOrEqual(MAX_TURN_REF_CONTEXT_CHARS);
    expect(result.match(/\[truncated\]/g)).toHaveLength(5);
    expect(result).toMatch(/\n\[truncated\]$/);
  });
});
