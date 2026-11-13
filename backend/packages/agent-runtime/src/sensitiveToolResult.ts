import type { AgentMessage } from "./types.js";

/** What the stored `tool_result` of a content-bearing operation on a sensitive database says instead of its content (issue #1827). */
export const REDACTED_SENSITIVE_MARKER = "[redacted: sensitive]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a `tool_result` message carries the sensitive mark of issue #1827 (`details.sensitive === true`). */
export function carriesSensitiveMark(message: AgentMessage): boolean {
  const { result } = message;
  return isRecord(result) && isRecord(result.details) && result.details.sensitive === true;
}

/**
 * The form of a `tool_result` message that goes into `agent_run_events` (issue #1827). A result whose
 * `details.sensitive` is `true` (set by the generic-operation tools for a content-bearing answer of a
 * sensitive database) keeps its identity fields and its `toolCallId`, so a replay still pairs it with its
 * call, but its content becomes `REDACTED_SENSITIVE_MARKER`, the mark is dropped, and the `before` and
 * `after` values of `details.changes` are dropped with only the changed keys left. Any other result is
 * returned as it is. The message handed in is not modified: the running turn keeps the real result.
 */
export function redactSensitiveToolResult(message: AgentMessage): AgentMessage {
  const { result } = message;
  if (!carriesSensitiveMark(message) || !isRecord(result) || !isRecord(result.details)) return message;
  const details = { ...result.details };
  delete details.sensitive;
  if (Object.hasOwn(details, "changes")) {
    details.changes = Array.isArray(details.changes)
      ? details.changes.flatMap((change: unknown) =>
          isRecord(change) && typeof change.key === "string" ? [{ key: change.key }] : [],
        )
      : [];
  }
  return { ...message, result: { ...result, content: [{ type: "text", text: REDACTED_SENSITIVE_MARKER }], details } };
}
