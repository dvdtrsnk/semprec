import { describe, expect, it } from "vitest";
import {
  redactAssistantMessage,
  redactReplayedToolCalls,
  redactToolUse,
  storedAssistantMessage,
  toolCallTargetsOf,
} from "../sensitiveMessageRedaction.js";
import type { AgentMessage, ConversationEntry } from "../types.js";

const MARKER = "[redacted: sensitive]";
const PRIVATE = "Private diagnosis";

function entries(...messages: AgentMessage[]): ConversationEntry[] {
  return messages.map((message, seq) => ({
    id: `e${seq}`,
    parentId: seq === 0 ? null : `e${seq - 1}`,
    seq,
    timestamp: 100 + seq,
    message,
  }));
}

describe("redactToolUse (issue #2001)", () => {
  it("replaces the arguments with the marker and keeps the identity of the call and its targets", () => {
    const message: AgentMessage = {
      kind: "tool_use",
      toolCallId: "call-1",
      name: "item_patch",
      operation: "item.patch",
      targetItemId: "item-1",
      arguments: { itemId: "item-1", properties: { name: PRIVATE } },
    };
    const redacted = redactToolUse(message);
    expect(redacted).toEqual({ ...message, arguments: MARKER });
    expect(JSON.stringify(redacted)).not.toContain(PRIVATE);
    expect(message.arguments).toEqual({ itemId: "item-1", properties: { name: PRIVATE } });
  });
});

describe("redactAssistantMessage (issue #2001)", () => {
  const message: AgentMessage = {
    kind: "message",
    role: "assistant",
    text: `Your diagnosis is ${PRIVATE}`,
    content: [
      { type: "thinking", thinking: `the record says ${PRIVATE}`, thinkingSignature: "sig" },
      { type: "text", text: `Your diagnosis is ${PRIVATE}`, textSignature: "sig" },
      { type: "toolCall", id: "call-2", name: "item_get", arguments: { itemId: "item-1", note: PRIVATE } },
      { type: "image", data: PRIVATE, mimeType: "image/png" },
      PRIVATE,
    ],
    stopReason: "toolUse",
    errorMessage: "provider says no",
  };

  it("replaces the text and every text block with the marker, drops thinking and unknown blocks and keeps the role and stop reason", () => {
    expect(redactAssistantMessage(message)).toEqual({
      kind: "message",
      role: "assistant",
      text: MARKER,
      content: [
        { type: "text", text: MARKER },
        { type: "toolCall", id: "call-2", name: "item_get", arguments: { redacted: MARKER } },
      ],
      stopReason: "toolUse",
      errorMessage: "provider says no",
    });
  });

  it("does not leave the value anywhere in the redacted message and does not modify the one it was given", () => {
    const before = structuredClone(message);
    expect(JSON.stringify(redactAssistantMessage(message))).not.toContain(PRIVATE);
    expect(message).toEqual(before);
  });

  it("stores the marker as the text of a message without content blocks", () => {
    expect(redactAssistantMessage({ kind: "message", role: "assistant", text: PRIVATE })).toEqual({
      kind: "message",
      role: "assistant",
      text: MARKER,
    });
  });
});

describe("redactReplayedToolCalls (issue #2001)", () => {
  const assistant = (id: string, args: unknown): AgentMessage => ({
    kind: "message",
    role: "assistant",
    text: "",
    content: [{ type: "toolCall", id, name: "item_patch", arguments: args }],
    stopReason: "toolUse",
  });

  it("replaces the arguments of a toolCall block whose stored tool_use carries the marker and leaves another call alone", () => {
    const history = entries(
      assistant("call-redacted", { itemId: "item-1", properties: { name: PRIVATE } }),
      { kind: "tool_use", toolCallId: "call-redacted", name: "item_patch", arguments: MARKER },
      assistant("call-open", { itemId: "item-2", properties: { name: "Open note" } }),
      { kind: "tool_use", toolCallId: "call-open", name: "item_patch", arguments: { itemId: "item-2" } },
    );
    const replayed = redactReplayedToolCalls(history);
    expect(replayed[0]?.message.content).toEqual([
      { type: "toolCall", id: "call-redacted", name: "item_patch", arguments: { redacted: MARKER } },
    ]);
    expect(replayed[2]).toBe(history[2]);
    expect(replayed[1]).toBe(history[1]);
    expect(JSON.stringify(replayed)).not.toContain(PRIVATE);
  });

  it("returns the very same entries when no stored tool_use carries the marker", () => {
    const history = entries(assistant("call-open", { itemId: "item-2" }), {
      kind: "tool_use",
      toolCallId: "call-open",
      name: "item_patch",
      arguments: { itemId: "item-2" },
    });
    expect(redactReplayedToolCalls(history)).toBe(history);
  });

  it("ignores a marked tool_use without a call id, and an assistant message without content blocks", () => {
    const history = entries(
      { kind: "message", role: "assistant", text: "plain" },
      { kind: "tool_use", name: "item_patch", arguments: MARKER },
    );
    expect(redactReplayedToolCalls(history)).toBe(history);
  });

  it("leaves a message that is not an assistant toolCall carrier, and a non-record block, as they are", () => {
    const history = entries(
      { kind: "message", role: "assistant", text: "x", content: ["loose text", { type: "text", text: "x" }] },
      { kind: "tool_use", toolCallId: "call-redacted", name: "item_patch", arguments: MARKER },
    );
    const replayed = redactReplayedToolCalls(history);
    expect(replayed[0]?.message.content).toEqual(["loose text", { type: "text", text: "x" }]);
  });
});

describe("toolCallTargetsOf and storedAssistantMessage (issue #2001)", () => {
  const withTargets: AgentMessage = {
    kind: "message",
    role: "assistant",
    text: "",
    content: [
      { type: "toolCall", id: "call-1", name: "item_patch", arguments: { itemId: "item-1", note: PRIVATE } },
      { type: "toolCall", id: "call-2", name: "item_patch", arguments: { itemId: "item-2" } },
      { type: "text", text: "plain" },
    ],
    toolCallTargets: [
      { toolCallId: "call-1", operation: "item.patch", targetItemId: "item-1" },
      { toolCallId: "call-2", operation: "item.create", targetDatabaseId: "db-1", targetItemId: 7 },
      { toolCallId: 3, operation: "item.patch" },
      { operation: "item.patch" },
      null,
    ],
  };

  it("parses the targets from unknown and drops what is not a call identity", () => {
    expect(toolCallTargetsOf(withTargets)).toEqual([
      { toolCallId: "call-1", operation: "item.patch", targetItemId: "item-1" },
      { toolCallId: "call-2", operation: "item.create", targetDatabaseId: "db-1" },
    ]);
    expect(toolCallTargetsOf({ kind: "message", toolCallTargets: "item.patch" })).toEqual([]);
    expect(toolCallTargetsOf({ kind: "message" })).toEqual([]);
  });

  it("redacts the listed toolCall blocks only, drops the targets and does not modify the message", () => {
    const before = structuredClone(withTargets);
    const stored = storedAssistantMessage(withTargets, new Set(["call-1"]));
    expect(stored).toEqual({
      kind: "message",
      role: "assistant",
      text: "",
      content: [
        { type: "toolCall", id: "call-1", name: "item_patch", arguments: { redacted: MARKER } },
        { type: "toolCall", id: "call-2", name: "item_patch", arguments: { itemId: "item-2" } },
        { type: "text", text: "plain" },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain(PRIVATE);
    expect(withTargets).toEqual(before);
  });

  it("only drops the targets when no block is to be redacted, and keeps a message without content", () => {
    expect(storedAssistantMessage(withTargets, new Set()).content).toEqual(withTargets.content);
    expect(storedAssistantMessage(withTargets, new Set())).not.toHaveProperty("toolCallTargets");
    expect(storedAssistantMessage({ kind: "message", text: "x", toolCallTargets: [] }, new Set(["a"]))).toEqual({
      kind: "message",
      text: "x",
    });
  });

  it("drops the targets from a fully redacted message too", () => {
    expect(redactAssistantMessage(withTargets)).not.toHaveProperty("toolCallTargets");
  });
});
