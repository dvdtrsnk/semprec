import { describe, expect, it } from "vitest";
import { REDACTED_SENSITIVE_MARKER, redactSensitiveToolResult } from "../sensitiveToolResult.js";
import type { AgentMessage } from "../types.js";

const ITEM_JSON = JSON.stringify({ id: "item-1", properties: { name: "Private diagnosis" } });

function toolResult(details: unknown, extra: Record<string, unknown> = {}): AgentMessage {
  return {
    kind: "tool_result",
    toolCallId: "call-1",
    name: "item_get",
    operation: "item.get",
    targetItemId: "item-1",
    result: { content: [{ type: "text", text: ITEM_JSON }], details },
    isError: false,
    ...extra,
  };
}

describe("redactSensitiveToolResult (issue #1827)", () => {
  it("replaces the content of a marked result with the marker, drops the mark and keeps the identity of the call", () => {
    const redacted = redactSensitiveToolResult(toolResult({ error: false, sensitive: true }));
    expect(redacted).toEqual({
      kind: "tool_result",
      toolCallId: "call-1",
      name: "item_get",
      operation: "item.get",
      targetItemId: "item-1",
      result: { content: [{ type: "text", text: "[redacted: sensitive]" }], details: { error: false } },
      isError: false,
    });
    expect(REDACTED_SENSITIVE_MARKER).toBe("[redacted: sensitive]");
    expect(JSON.stringify(redacted)).not.toContain("Private diagnosis");
  });

  it("does not modify the message it was given", () => {
    const message = toolResult({ error: false, sensitive: true });
    const before = structuredClone(message);
    redactSensitiveToolResult(message);
    expect(message).toEqual(before);
  });

  it("returns an unmarked result as it is", () => {
    const message = toolResult({ error: false });
    expect(redactSensitiveToolResult(message)).toBe(message);
  });

  it.each([false, "true", 1, null])("returns a result whose sensitive field is %j as it is", (sensitive) => {
    const message = toolResult({ error: false, sensitive });
    expect(redactSensitiveToolResult(message)).toBe(message);
  });

  it.each([
    ["a result that is not an object", "plain text"],
    ["a result without details", { content: [{ type: "text", text: ITEM_JSON }] }],
    ["details that are not an object", { content: [], details: "sensitive" }],
  ])("returns %s as it is", (_label, result) => {
    const message: AgentMessage = {
      kind: "tool_result",
      toolCallId: "call-1",
      name: "item_get",
      result,
      isError: false,
    };
    expect(redactSensitiveToolResult(message)).toBe(message);
  });

  it("keeps the approval request id and the error flag of a marked result", () => {
    const redacted = redactSensitiveToolResult(
      toolResult({ error: false, approvalRequestId: "request-1", sensitive: true }),
    );
    expect(redacted.result).toEqual({
      content: [{ type: "text", text: "[redacted: sensitive]" }],
      details: { error: false, approvalRequestId: "request-1" },
    });
  });

  it("keeps the id of the item a marked item.create result created, which names no content (issue #1885)", () => {
    const redacted = redactSensitiveToolResult(toolResult({ error: false, sensitive: true, createdItemId: "item-1" }));
    expect(redacted.result).toEqual({
      content: [{ type: "text", text: "[redacted: sensitive]" }],
      details: { error: false, createdItemId: "item-1" },
    });
  });

  it("keeps only the changed keys of a marked item.patch result", () => {
    const redacted = redactSensitiveToolResult(
      toolResult({
        error: false,
        sensitive: true,
        changes: [
          { key: "name", before: "Old private name", after: "New private name" },
          { key: "notes" },
          "not a change",
          { key: 7, before: "x" },
        ],
      }),
    );
    expect(redacted.result).toEqual({
      content: [{ type: "text", text: "[redacted: sensitive]" }],
      details: { error: false, changes: [{ key: "name" }, { key: "notes" }] },
    });
    expect(JSON.stringify(redacted)).not.toMatch(/private/i);
  });

  it("empties changes that are not a list on a marked result", () => {
    const redacted = redactSensitiveToolResult(toolResult({ sensitive: true, changes: "Old private name" }));
    expect(redacted.result).toEqual({
      content: [{ type: "text", text: "[redacted: sensitive]" }],
      details: { changes: [] },
    });
  });

  it("leaves the changes of an unmarked result untouched", () => {
    const details = { error: false, changes: [{ key: "name", before: "a", after: "b" }] };
    const message = toolResult(details);
    expect(redactSensitiveToolResult(message)).toBe(message);
  });
});
