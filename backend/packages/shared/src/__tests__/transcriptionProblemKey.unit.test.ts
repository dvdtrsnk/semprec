import { describe, expect, it } from "vitest";
import { transcriptionProblemKey } from "../transcriptionProblemKey.js";

describe("transcriptionProblemKey (issue gh-1945)", () => {
  it("prefixes the transcript id, so the key cannot collide with another category's key in the tenant", () => {
    expect(transcriptionProblemKey("5b9c1c0e-3f55-4c0e-9d0a-2d3c0c9f1a11")).toBe(
      "transcription:5b9c1c0e-3f55-4c0e-9d0a-2d3c0c9f1a11",
    );
  });

  it("gives two transcripts two keys", () => {
    expect(transcriptionProblemKey("a")).not.toBe(transcriptionProblemKey("b"));
  });
});
