import { describe, expect, it } from "vitest";
import { GENERIC_OPERATION_NAMES } from "@semprec/shared";
import { parseToolEventPayload } from "../toolEventPayload.js";

const use = { toolCallId: "call-1", name: "item_patch", arguments: { itemId: "item-1" } };
const result = { toolCallId: "call-1", name: "item_patch", result: { content: [] }, isError: false };
const mcp = { toolRegistrationId: "reg-1", serverItemId: "server-1", serverName: "Server", toolName: "search" };

describe("parseToolEventPayload", () => {
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
