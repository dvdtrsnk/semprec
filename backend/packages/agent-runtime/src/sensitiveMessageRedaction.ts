import { REDACTED_SENSITIVE_MARKER } from "./sensitiveToolResult.js";
import type { AgentMessage, ConversationEntry, ToolCallTarget } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pi types `toolCall` arguments as an object. */
const REDACTED_TOOL_CALL_ARGUMENTS = { redacted: REDACTED_SENSITIVE_MARKER };

/** Name, call id and targets stay. */
export function redactToolUse(message: AgentMessage): AgentMessage {
  return { ...message, arguments: REDACTED_SENSITIVE_MARKER };
}

/**
 * Its `text` and text blocks become the marker, thinking blocks are dropped, and a `toolCall` block keeps id and name
 * but not arguments, so the call still pairs with its stored result on replay. Role, stop reason and error message
 * stay.
 */
export function redactAssistantMessage(message: AgentMessage): AgentMessage {
  const redacted: AgentMessage = { ...withoutToolCallTargets(message), text: REDACTED_SENSITIVE_MARKER };
  if (Array.isArray(message.content)) {
    redacted.content = message.content.flatMap((block: unknown): Record<string, unknown>[] => {
      if (!isRecord(block)) return [];
      if (block.type === "text") return [{ type: "text", text: REDACTED_SENSITIVE_MARKER }];
      if (block.type === "toolCall") return [{ ...block, arguments: REDACTED_TOOL_CALL_ARGUMENTS }];
      return [];
    });
  }
  return redacted;
}

function withoutToolCallTargets(message: AgentMessage): AgentMessage {
  const copy = { ...message };
  delete copy.toolCallTargets;
  return copy;
}

/**
 * Parsed from `unknown`: entries without a string call id and operation are dropped; non-string targets are ignored.
 */
export function toolCallTargetsOf(message: AgentMessage): ToolCallTarget[] {
  const { toolCallTargets } = message;
  if (!Array.isArray(toolCallTargets)) return [];
  return toolCallTargets.flatMap((entry: unknown): ToolCallTarget[] => {
    if (!isRecord(entry) || typeof entry.toolCallId !== "string" || typeof entry.operation !== "string") return [];
    return [
      {
        toolCallId: entry.toolCallId,
        operation: entry.operation,
        ...(typeof entry.targetDatabaseId === "string" ? { targetDatabaseId: entry.targetDatabaseId } : {}),
        ...(typeof entry.targetItemId === "string" ? { targetItemId: entry.targetItemId } : {}),
      },
    ];
  });
}

/**
 * `toolCallTargets` never reaches `agent_run_events`; `toolCall` blocks in `redactedCallIds` keep id and name but not
 * arguments.
 */
export function storedAssistantMessage(message: AgentMessage, redactedCallIds: ReadonlySet<string>): AgentMessage {
  const stored = withoutToolCallTargets(message);
  if (redactedCallIds.size === 0 || !Array.isArray(stored.content)) return stored;
  return {
    ...stored,
    content: stored.content.map((block: unknown) =>
      isRecord(block) && block.type === "toolCall" && typeof block.id === "string" && redactedCallIds.has(block.id)
        ? { ...block, arguments: REDACTED_TOOL_CALL_ARGUMENTS }
        : block,
    ),
  };
}

/**
 * Second line of defence for sessions that attach no `toolCallTargets`: a replayed assistant `toolCall` block whose
 * `tool_use` event was stored with the marker gets the marker too, so neither a resumed session nor a compaction sees
 * the arguments. Unchanged entries are returned as they are.
 */
export function redactReplayedToolCalls(entries: ConversationEntry[]): ConversationEntry[] {
  const redactedCallIds = new Set<string>();
  for (const { message } of entries) {
    if (message.kind === "tool_use" && message.arguments === REDACTED_SENSITIVE_MARKER) {
      if (typeof message.toolCallId === "string") redactedCallIds.add(message.toolCallId);
    }
  }
  if (redactedCallIds.size === 0) return entries;
  const carriesRedactedCall = (block: unknown): block is Record<string, unknown> =>
    isRecord(block) && block.type === "toolCall" && typeof block.id === "string" && redactedCallIds.has(block.id);
  return entries.map((entry) => {
    const { message } = entry;
    if (message.kind !== "message" || !Array.isArray(message.content) || !message.content.some(carriesRedactedCall)) {
      return entry;
    }
    const content = message.content.map((block: unknown) =>
      carriesRedactedCall(block) ? { ...block, arguments: REDACTED_TOOL_CALL_ARGUMENTS } : block,
    );
    return { ...entry, message: { ...message, content } };
  });
}
