import { describe, expect, it } from "vitest";
import { parseServerFrame } from "../serverFrame.js";

describe("parseServerFrame sempThread invalidation (issue #1395)", () => {
  const threadId = "2f1d6a9e-3c1b-4f0e-9a52-7d3b8c1e4a60";

  it("parses a well-formed sempThread invalidate frame", () => {
    expect(parseServerFrame(JSON.stringify({ type: "invalidate", scope: "sempThread", threadId }))).toEqual({
      type: "invalidate",
      scope: "sempThread",
      threadId,
    });
  });

  it.each([
    ["a missing thread id", { type: "invalidate", scope: "sempThread" }],
    ["a non-string thread id", { type: "invalidate", scope: "sempThread", threadId: 7 }],
    ["an unknown scope", { type: "invalidate", scope: "semp", threadId }],
  ])("ignores %s", (_label, frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toBeNull();
  });

  it("ignores non-JSON input", () => {
    expect(parseServerFrame("{not json")).toBeNull();
  });
});
