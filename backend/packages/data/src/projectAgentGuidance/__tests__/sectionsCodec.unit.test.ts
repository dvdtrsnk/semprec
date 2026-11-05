import { describe, expect, it } from "vitest";
import {
  composeProjectAgentGuidanceMarkdown,
  findReservedHeading,
  parseProjectAgentGuidanceMarkdown,
} from "@semprec/shared";

describe("project guidance section codec", () => {
  it("round trips all sections through canonical Markdown", () => {
    const sections = {
      purpose: "Purpose",
      allowed: "Do this",
      notAllowed: "Avoid that",
      generalInstructions: "Other guidance",
    };
    expect(parseProjectAgentGuidanceMarkdown(composeProjectAgentGuidanceMarkdown(sections))).toEqual(sections);
  });
  it("retains preamble in general instructions", () => {
    expect(
      parseProjectAgentGuidanceMarkdown("Legacy text\n\n## Allowed\nSomething\n\n## General instructions\nMore\n"),
    ).toEqual({
      purpose: "",
      allowed: "Something",
      notAllowed: "",
      generalInstructions: "Legacy text\n\nMore",
    });
  });
  it("rejects whole reserved heading lines in every section, including fenced text", () => {
    const empty = { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" };
    expect(findReservedHeading(empty)).toBeNull();
    for (const key of ["purpose", "allowed", "notAllowed", "generalInstructions"] as const) {
      expect(findReservedHeading({ ...empty, [key]: "```\n## Allowed\n```" })).toBe(key);
    }
    expect(findReservedHeading({ ...empty, allowed: "## Allowed suffix" })).toBeNull();
  });
});
