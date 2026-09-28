import { describe, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentMessage, ConversationEntry } from "@semprec/agent-runtime";
import { toPiMessages } from "../piConversationHistory.js";

const model = fauxProvider().getModel();

function entries(...messages: AgentMessage[]): ConversationEntry[] {
  return messages.map((message, seq) => ({
    id: `e${seq}`,
    parentId: seq === 0 ? null : `e${seq - 1}`,
    seq,
    timestamp: 100 + seq,
    message,
  }));
}

const assistantToolCall: AgentMessage = {
  kind: "message",
  role: "assistant",
  text: "",
  content: [
    { type: "thinking", thinking: "use echo" },
    { type: "toolCall", id: "call-1", name: "echo", arguments: { value: "hi" } },
  ],
  stopReason: "toolUse",
};

const toolResult: AgentMessage = {
  kind: "tool_result",
  toolCallId: "call-1",
  name: "echo",
  result: { content: [{ type: "text", text: "echoed" }], details: { error: null } },
  isError: false,
};

describe("toPiMessages (issue #647)", () => {
  it("converts assistant messages and tool results, skipping tool_use, turn markers and deltas", () => {
    const converted = toPiMessages(
      entries(
        { kind: "turn_start" },
        { kind: "message_update", type: "text_delta", contentIndex: 0, delta: "x" },
        assistantToolCall,
        { kind: "tool_use", toolCallId: "call-1", name: "echo", arguments: { value: "hi" } },
        toolResult,
        { kind: "turn_end" },
        { kind: "run_status", status: "done" },
      ),
      model,
    );

    expect(converted).toEqual([
      {
        role: "assistant",
        content: assistantToolCall.content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 102,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "echo",
        content: [{ type: "text", text: "echoed" }],
        details: { error: null },
        isError: false,
        timestamp: 104,
      },
    ]);
  });

  it("keeps an assistant message's errorMessage", () => {
    const [converted] = toPiMessages(
      entries({ kind: "message", role: "assistant", content: [], stopReason: "error", errorMessage: "refused" }),
      model,
    );

    expect(converted).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "refused" });
  });

  it("returns no messages for empty history", () => {
    expect(toPiMessages([], model)).toEqual([]);
  });

  it.each<[string, AgentMessage, string]>([
    [
      "a non-assistant message",
      { kind: "message", role: "user", content: [], stopReason: "stop" },
      "is not an assistant message",
    ],
    [
      "malformed assistant content",
      { kind: "message", role: "assistant", content: [{ type: "text" }], stopReason: "stop" },
      "has malformed assistant content",
    ],
    [
      "an unknown stopReason",
      { kind: "message", role: "assistant", content: [], stopReason: "finished" },
      "has an unknown stopReason",
    ],
    [
      "a non-string errorMessage",
      { kind: "message", role: "assistant", content: [], stopReason: "error", errorMessage: 1 },
      "has a non-string errorMessage",
    ],
    [
      "a tool result without its toolCallId",
      { kind: "tool_result", name: "echo", result: { content: [] }, isError: false },
      "is missing its toolCallId, name or isError",
    ],
    [
      "a tool result with malformed content",
      { kind: "tool_result", toolCallId: "c", name: "echo", result: { content: "echoed" }, isError: false },
      "has a malformed tool result",
    ],
  ])("throws on %s", (_label, message, reason) => {
    expect(() => toPiMessages(entries(message), model)).toThrow(
      `conversation entry e0 (kind '${message.kind}') ${reason}`,
    );
  });
});
