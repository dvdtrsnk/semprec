import { describe, expect, it } from "vitest";
import { parseServerFrame } from "../serverFrame.js";

describe("document invalidation frames", () => {
  const frame = {
    type: "invalidate",
    scope: "doc",
    docId: "2f1d6a9e-3c1b-4f0e-9a52-7d3b8c1e4a60",
    itemId: "2f1d6a9e-3c1b-4f0e-9a52-7d3b8c1e4a61",
    databaseId: "2f1d6a9e-3c1b-4f0e-9a52-7d3b8c1e4a62",
    lastEditedAt: "2026-11-04T10:00:00.000Z",
  };
  it("parses a complete document frame", () => {
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });
  it.each([
    { ...frame, docId: "bad" },
    { ...frame, itemId: null },
    { ...frame, databaseId: "bad" },
    { ...frame, lastEditedAt: "not a date" },
    { ...frame, lastEditedAt: "2026-02-30T10:00:00.000Z" },
    { type: "invalidate", scope: "doc" },
  ])("rejects malformed document fields", (value) => {
    expect(parseServerFrame(JSON.stringify(value))).toBeNull();
  });
});

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

describe("parseServerFrame approvalRequest invalidation (issue #1789)", () => {
  const approvalRequestId = "2f1d6a9e-3c1b-4f0e-9a52-7d3b8c1e4a60";

  it("parses a well-formed approvalRequest invalidate frame", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "invalidate", scope: "approvalRequest", approvalRequestId })),
    ).toEqual({ type: "invalidate", scope: "approvalRequest", approvalRequestId });
  });

  it.each([
    ["a missing request id", { type: "invalidate", scope: "approvalRequest" }],
    ["a non-string request id", { type: "invalidate", scope: "approvalRequest", approvalRequestId: 7 }],
    ["a non-uuid request id", { type: "invalidate", scope: "approvalRequest", approvalRequestId: "request-1" }],
  ])("ignores %s", (_label, frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toBeNull();
  });
});
