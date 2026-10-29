import { describe, expect, it } from "vitest";
import { composeProjectAgentGuidanceMarkdown, type ProjectAgentGuidanceSections } from "../projectAgentGuidance.js";

const EMPTY: ProjectAgentGuidanceSections = { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" };

describe("composeProjectAgentGuidanceMarkdown (issue #1449)", () => {
  it("renders the four reserved headings in order, one blank line apart, ending with one newline", () => {
    const markdown = composeProjectAgentGuidanceMarkdown({
      purpose: "A",
      allowed: "B",
      notAllowed: "C",
      generalInstructions: "D",
    });
    expect(markdown).toBe("## Purpose\nA\n\n## Allowed\nB\n\n## Not allowed\nC\n\n## General instructions\nD\n");
  });

  it("lists the sections in canonical order whatever the order of the object's keys", () => {
    const markdown = composeProjectAgentGuidanceMarkdown({
      generalInstructions: "D",
      notAllowed: "C",
      allowed: "B",
      purpose: "A",
    });
    expect(markdown.indexOf("## Purpose")).toBeLessThan(markdown.indexOf("## Allowed"));
    expect(markdown.indexOf("## Allowed")).toBeLessThan(markdown.indexOf("## Not allowed"));
    expect(markdown.indexOf("## Not allowed")).toBeLessThan(markdown.indexOf("## General instructions"));
  });

  it("omits an empty section together with its heading", () => {
    const markdown = composeProjectAgentGuidanceMarkdown({ ...EMPTY, allowed: "B", generalInstructions: "D" });
    expect(markdown).toBe("## Allowed\nB\n\n## General instructions\nD\n");
    expect(markdown).not.toContain("## Purpose");
    expect(markdown).not.toContain("## Not allowed");
  });

  it("trims each section's text, and omits a section that is only whitespace", () => {
    const markdown = composeProjectAgentGuidanceMarkdown({
      ...EMPTY,
      purpose: "  A  \n",
      allowed: "\n \t \n",
    });
    expect(markdown).toBe("## Purpose\nA\n");
  });

  it("renders the empty string when every section is empty", () => {
    expect(composeProjectAgentGuidanceMarkdown(EMPTY)).toBe("");
  });
});
