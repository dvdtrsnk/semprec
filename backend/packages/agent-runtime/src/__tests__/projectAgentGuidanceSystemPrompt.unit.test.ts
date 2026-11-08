import { describe, expect, it } from "vitest";
import { createProjectAgentGuidanceSystemPromptOverride } from "../projectAgentGuidanceSystemPrompt.js";

describe("createProjectAgentGuidanceSystemPromptOverride (issue #214)", () => {
  it("appends the loaded guidance verbatim under the fixed heading", async () => {
    const override = await createProjectAgentGuidanceSystemPromptOverride(
      async (projectItemId) => (projectItemId === "p1" ? { markdown: "Always run tests first." } : null),
      "p1",
    );

    expect(override("BASE PROMPT")).toBe("BASE PROMPT\n\n## Project-specific guidance\n\nAlways run tests first.");
  });

  it("returns the prompt unchanged when no guidance exists for the project", async () => {
    const override = await createProjectAgentGuidanceSystemPromptOverride(async () => null, "p1");

    expect(override("BASE PROMPT")).toBe("BASE PROMPT");
  });
});
