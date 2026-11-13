import { describe, expect, it } from "vitest";
import { GENERIC_OPERATION_NAMES, parseToolEventPayload as sharedParser } from "@semprec/shared";
import { parseToolEventPayload } from "../toolEventPayload.js";

const use = { toolCallId: "call-1", name: "item_patch", arguments: { itemId: "item-1" } };
const result = { toolCallId: "call-1", name: "item_patch", result: { content: [] }, isError: false };
const mcp = { toolRegistrationId: "reg-1", serverItemId: "server-1", serverName: "Server", toolName: "search" };

describe("parseToolEventPayload", () => {
  it("uses the same shared parser through the runtime compatibility export", () => {
    expect(parseToolEventPayload).toBe(sharedParser);
  });
  it.each(GENERIC_OPERATION_NAMES)("accepts the canonical operation %s", (operation) => {
    expect(parseToolEventPayload("tool_use", { ...use, operation })).toEqual({ ...use, operation });
  });

  it.each(["tool_use", "tool_result"] as const)(
    "accepts enriched %s and legacy rows without guessing identity",
    (kind) => {
      const payload = kind === "tool_use" ? use : result;
      expect(parseToolEventPayload(kind, payload)).toEqual(payload);
      expect(
        parseToolEventPayload(kind, { ...payload, mcp, targetDatabaseId: "db-1", targetItemId: "item-1" }),
      ).toEqual({
        ...payload,
        mcp,
        targetDatabaseId: "db-1",
        targetItemId: "item-1",
      });
      expect(parseToolEventPayload(kind, { ...payload, operation: "item.patch" })).toEqual({
        ...payload,
        operation: "item.patch",
      });
    },
  );

  it.each<unknown>([
    null,
    [],
    "bad",
    1,
    {},
    { ...use, toolCallId: 1 },
    { ...use, name: null },
    { ...use, operation: "item_patch" },
    { ...use, operation: null },
    { ...use, mcp: null },
    { ...use, mcp: [] },
    { ...use, mcp: { ...mcp, serverName: 1 } },
    ...Object.keys(mcp).map((key) => ({
      ...use,
      mcp: Object.fromEntries(Object.entries(mcp).filter(([name]) => name !== key)),
    })),
    { ...use, operation: "item.patch", mcp },
    { ...use, targetItemId: 1 },
    { ...use, targetDatabaseId: null },
    { toolCallId: "c", name: "n" },
    { ...use, kind: "tool_result" },
  ])("returns null for malformed use payload %#", (payload) => {
    expect(parseToolEventPayload("tool_use", payload)).toBeNull();
  });

  it.each<unknown>([
    { ...result, isError: "false" },
    { toolCallId: "c", name: "n", isError: true },
    { ...result, targetItemId: false },
    { ...result, mcp: { ...mcp, toolRegistrationId: 1 } },
  ])("returns null for malformed result payload %#", (payload) => {
    expect(parseToolEventPayload("tool_result", payload)).toBeNull();
  });

  it("rejects a non-tool kind", () => {
    expect(parseToolEventPayload("message", use)).toBeNull();
  });
});

describe("parseToolEventPayload result details (issue #1527)", () => {
  it("reads approvalRequestId and changes from the stored result details", () => {
    const changes = [{ key: "due", before: "a", after: "b" }, { key: "body" }];
    const stored = {
      ...result,
      result: { content: [], details: { error: false, approvalRequestId: "req-1", changes } },
    };
    expect(parseToolEventPayload("tool_result", stored)).toEqual({
      ...stored,
      details: { approvalRequestId: "req-1", changes },
    });
  });

  it("drops a malformed changes entry and ignores a malformed id instead of throwing", () => {
    const stored = {
      ...result,
      result: { details: { approvalRequestId: 5, changes: [{ key: 1 }, "x", null, { key: "k", after: 2 }] } },
    };
    expect(parseToolEventPayload("tool_result", stored)).toEqual({
      ...stored,
      details: { changes: [{ key: "k", after: 2 }] },
    });
  });

  it("reads the errorCode of a failed generic operation and the failureKind of a failed MCP call (issues #1860, #1444)", () => {
    const code = { ...result, result: { details: { error: true, errorCode: "version_conflict" } } };
    const kind = { ...result, result: { details: { error: true, failureKind: "timeout" } } };
    expect(parseToolEventPayload("tool_result", code)).toEqual({ ...code, details: { errorCode: "version_conflict" } });
    expect(parseToolEventPayload("tool_result", kind)).toEqual({ ...kind, details: { failureKind: "timeout" } });
  });

  it("ignores an errorCode or failureKind that is not a string", () => {
    const stored = { ...result, result: { details: { error: true, errorCode: 5, failureKind: { kind: "x" } } } };
    expect(parseToolEventPayload("tool_result", stored)).toEqual(stored);
  });

  it("reads the createdItemId of a created item and ignores one that is not a string (issue #1885)", () => {
    const created = { ...result, result: { details: { error: false, createdItemId: "item-1" } } };
    const odd = { ...result, result: { details: { error: false, createdItemId: 7 } } };
    expect(parseToolEventPayload("tool_result", created)).toEqual({ ...created, details: { createdItemId: "item-1" } });
    expect(parseToolEventPayload("tool_result", odd)).toEqual(odd);
  });

  it("has no details for a result without them", () => {
    expect(parseToolEventPayload("tool_result", { ...result, result: { details: { error: false } } })).toEqual({
      ...result,
      result: { details: { error: false } },
    });
  });
});
