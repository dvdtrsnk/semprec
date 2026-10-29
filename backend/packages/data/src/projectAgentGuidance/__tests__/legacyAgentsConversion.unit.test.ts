import { describe, expect, it } from "vitest";
import { composeProjectAgentGuidanceMarkdown } from "@semprec/shared";
import { legacyAgentsTextToSections } from "../legacyAgentsConversion.js";

describe("legacyAgentsTextToSections (issue #1449)", () => {
  it("splits the four labelled sections, each running until the next label", () => {
    expect(legacyAgentsTextToSections("Purpose: A\nAllowed: B\nNot allowed: C\nGeneral instructions: D")).toEqual({
      purpose: "A",
      allowed: "B",
      notAllowed: "C",
      generalInstructions: "D",
    });
  });

  it("puts a text with no label entirely into General instructions", () => {
    expect(legacyAgentsTextToSections("Just a free-form note.\nSecond line.")).toEqual({
      purpose: "",
      allowed: "",
      notAllowed: "",
      generalInstructions: "Just a free-form note.\nSecond line.",
    });
  });

  it("prepends the text before the first label to General instructions", () => {
    expect(legacyAgentsTextToSections("Preamble.\nPurpose: A\nGeneral instructions: D")).toEqual({
      purpose: "A",
      allowed: "",
      notAllowed: "",
      generalInstructions: "Preamble.\nD",
    });
  });

  it("appends a repeated label to its section", () => {
    expect(legacyAgentsTextToSections("Allowed: first\nPurpose: A\nAllowed: second")).toEqual({
      purpose: "A",
      allowed: "first\nsecond",
      notAllowed: "",
      generalInstructions: "",
    });
  });

  it("keeps the lines of one section, including a blank line inside it", () => {
    expect(legacyAgentsTextToSections("Allowed: one\n\ntwo\nNot allowed: C").allowed).toBe("one\n\ntwo");
  });

  it("matches labels case-sensitively, so a lowercase label stays text", () => {
    expect(legacyAgentsTextToSections("purpose: not a label")).toEqual({
      purpose: "",
      allowed: "",
      notAllowed: "",
      generalInstructions: "purpose: not a label",
    });
  });

  it("matches a label only at the start of a line", () => {
    expect(legacyAgentsTextToSections("Use Purpose: here, not a label").generalInstructions).toBe(
      "Use Purpose: here, not a label",
    );
  });

  it("does not read 'Not allowed:' as 'Allowed:'", () => {
    const sections = legacyAgentsTextToSections("Not allowed: C");
    expect(sections.allowed).toBe("");
    expect(sections.notAllowed).toBe("C");
  });

  it("accepts a label with no space after its colon", () => {
    expect(legacyAgentsTextToSections("Purpose:A\nAllowed:B").purpose).toBe("A");
  });

  it("accepts CRLF line endings", () => {
    expect(legacyAgentsTextToSections("Purpose: A\r\nAllowed: B\r\n")).toEqual({
      purpose: "A",
      allowed: "B",
      notAllowed: "",
      generalInstructions: "",
    });
  });

  it("converts a label with no content to empty sections, which compose to the empty document", () => {
    const sections = legacyAgentsTextToSections("Purpose:");
    expect(sections.purpose).toBe("");
    expect(composeProjectAgentGuidanceMarkdown(sections)).toBe("");
  });
});
