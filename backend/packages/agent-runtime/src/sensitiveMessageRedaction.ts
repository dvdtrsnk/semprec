import { REDACTED_SENSITIVE_MARKER } from "./sensitiveToolResult.js";
import type { AgentMessage, ConversationEntry, ToolCallTarget } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a stored `toolCall` content block of an assistant message keeps as its arguments: pi types them as an object. */
const REDACTED_TOOL_CALL_ARGUMENTS = { redacted: REDACTED_SENSITIVE_MARKER };

/** A `tool_use` message with its arguments replaced by the marker; the name, the call id and the targets stay. */
export function redactToolUse(message: AgentMessage): AgentMessage {
  return { ...message, arguments: REDACTED_SENSITIVE_MARKER };
}

/**
 * An assistant `message` with everything the model said replaced (issue #2001): its `text` and every text block
 * of its `content` become the marker, thinking blocks are dropped, and a `toolCall` block keeps its id and name
 * but not its arguments, so the call still pairs with its stored result on a replay. The role, the stop reason
 * and the error message stay.
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
 * The `toolCallTargets` an assistant `message` carries from its session (`ToolCallTarget`), parsed from `unknown`:
 * an entry without a string call id and operation is dropped, a target that is not a string is ignored.
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
 * The stored form of an assistant `message` (issue #2001): `toolCallTargets` is a steering field of the session and
 * never reaches `agent_run_events`; the `toolCall` blocks whose ids are in `redactedCallIds` keep their id and name
 * but not their arguments, so the call still pairs with its stored result. Everything else stays as it is.
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
 * Brings the assistant messages of a reconstructed history in line with the stored `tool_use` events (issue #2001).
 * The assistant message of a call is stored before the call starts; `createSensitiveTurnRedactor` already stores its
 * `toolCall` block redacted when the session names the operation and targets of the call. This is the second line
 * for a session that does not: a `toolCall` block still holding the arguments that its own `tool_use` event,
 * stored later, replaced by the marker gets the same replacement for every call id of a `tool_use` stored with the
 * marker as its arguments, so neither a resumed session nor a compaction ever sees the arguments. Entries that
 * need no change are returned as they are.
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
