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

describe("parseServerFrame mailThread invalidation (issue #1816)", () => {
  const threadId = "9d0c7a52-5b1e-4f3a-8c26-1e4b7d9a3f05";

  it("parses a well-formed mailThread invalidate frame and round-trips what the server sends", () => {
    const frame = { type: "invalidate", scope: "mailThread", threadId } as const;
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("keeps only the thread id of the frame", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "invalidate", scope: "mailThread", threadId, subject: "private" })),
    ).toEqual({ type: "invalidate", scope: "mailThread", threadId });
  });

  it.each([
    ["a missing thread id", { type: "invalidate", scope: "mailThread" }],
    ["a null thread id", { type: "invalidate", scope: "mailThread", threadId: null }],
    ["a numeric thread id", { type: "invalidate", scope: "mailThread", threadId: 7 }],
    ["an object thread id", { type: "invalidate", scope: "mailThread", threadId: { id: threadId } }],
  ])("ignores %s", (_label, frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toBeNull();
  });
});

describe("parseServerFrame inboxCards invalidation (issue #1811)", () => {
  const cardId = "6b2f0c1e-8a47-4d63-b1f5-0e9d3c7a5b12";

  it.each(["created", "updated", "closed"] as const)("parses a well-formed inboxCards %s frame", (op) => {
    expect(parseServerFrame(JSON.stringify({ type: "invalidate", scope: "inboxCards", op, cardId }))).toEqual({
      type: "invalidate",
      scope: "inboxCards",
      op,
      cardId,
    });
  });

  it("drops fields beyond the catalog, so no card content reaches the caller", () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: "invalidate", scope: "inboxCards", op: "updated", cardId, status: "proposed" }),
      ),
    ).toEqual({ type: "invalidate", scope: "inboxCards", op: "updated", cardId });
  });

  it.each([
    ["a missing card id", { type: "invalidate", scope: "inboxCards", op: "closed" }],
    ["a non-string card id", { type: "invalidate", scope: "inboxCards", op: "closed", cardId: 7 }],
    ["a non-uuid card id", { type: "invalidate", scope: "inboxCards", op: "closed", cardId: "card-1" }],
    ["a missing operation", { type: "invalidate", scope: "inboxCards", cardId }],
    ["an unknown operation", { type: "invalidate", scope: "inboxCards", op: "deleted", cardId }],
    ["a non-string operation", { type: "invalidate", scope: "inboxCards", op: 1, cardId }],
  ])("ignores %s", (_label, frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toBeNull();
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
