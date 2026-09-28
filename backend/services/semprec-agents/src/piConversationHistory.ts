import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ConversationEntry } from "@semprec/agent-runtime";

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

function isStopReason(value: unknown): value is StopReason {
  return typeof value === "string" && STOP_REASONS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTextContent(block: Record<string, unknown>): boolean {
  return block.type === "text" && typeof block.text === "string" && isOptionalString(block.textSignature);
}

function isImageContent(block: Record<string, unknown>): boolean {
  return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function isThinkingContent(block: Record<string, unknown>): boolean {
  return (
    block.type === "thinking" &&
    typeof block.thinking === "string" &&
    isOptionalString(block.thinkingSignature) &&
    (block.redacted === undefined || typeof block.redacted === "boolean")
  );
}

function isToolCall(block: Record<string, unknown>): boolean {
  return (
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    isRecord(block.arguments) &&
    isOptionalString(block.thoughtSignature) &&
    isOptionalString(block.namespace)
  );
}

function isAssistantContent(value: unknown): value is (TextContent | ThinkingContent | ToolCall)[] {
  return (
    Array.isArray(value) &&
    value.every((block) => isRecord(block) && (isTextContent(block) || isThinkingContent(block) || isToolCall(block)))
  );
}

function isToolResultContent(value: unknown): value is (TextContent | ImageContent)[] {
  return (
    Array.isArray(value) && value.every((block) => isRecord(block) && (isTextContent(block) || isImageContent(block)))
  );
}

function invalidEntry(entry: ConversationEntry, reason: string): Error {
  return new Error(`conversation entry ${entry.id} (kind '${entry.message.kind}') ${reason}`);
}

/**
 * A stored `message` event keeps the assistant's content and stop reason but not the provider
 * bookkeeping pi's `AssistantMessage` carries; the session's own model stands in for it and the
 * usage is zero, since the tokens were already accounted when the original call was made.
 */
function toAssistantMessage(entry: ConversationEntry, message: AgentMessage, model: Model<Api>): AssistantMessage {
  if (message.role !== "assistant") throw invalidEntry(entry, "is not an assistant message");
  if (!isAssistantContent(message.content)) throw invalidEntry(entry, "has malformed assistant content");
  const stopReason = message.stopReason;
  if (!isStopReason(stopReason)) {
    throw invalidEntry(entry, "has an unknown stopReason");
  }
  if (!isOptionalString(message.errorMessage)) throw invalidEntry(entry, "has a non-string errorMessage");
  return {
    role: "assistant",
    content: message.content,
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
    stopReason,
    ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
    timestamp: entry.timestamp,
  };
}

function toToolResultMessage(entry: ConversationEntry, message: AgentMessage): ToolResultMessage {
  const { toolCallId, name, isError, result } = message;
  if (typeof toolCallId !== "string" || typeof name !== "string" || typeof isError !== "boolean") {
    throw invalidEntry(entry, "is missing its toolCallId, name or isError");
  }
  if (!isRecord(result) || !isToolResultContent(result.content)) {
    throw invalidEntry(entry, "has a malformed tool result");
  }
  return {
    role: "toolResult",
    toolCallId,
    toolName: name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: entry.timestamp,
  };
}

/**
 * Converts reconstructed history (this runtime's persisted `AgentMessage` vocabulary) into the pi
 * `Message`s a resumed `Agent` is seeded with. Only `message` and `tool_result` entries carry
 * conversation content: a `tool_use` repeats the `toolCall` block already in the preceding
 * assistant message's content, and turn markers, streaming deltas and run statuses are not part
 * of the model's context. The history is a boundary (stored JSONB, or a compaction adapter's
 * output), so an entry that does not match pi's shape throws instead of being handed to pi.
 */
export function toPiMessages(entries: ConversationEntry[], model: Model<Api>): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (message.kind === "message") messages.push(toAssistantMessage(entry, message, model));
    else if (message.kind === "tool_result") messages.push(toToolResultMessage(entry, message));
  }
  return messages;
}
