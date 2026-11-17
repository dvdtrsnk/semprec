import type { AgentMessage } from "./types.js";

/** Replaces the content of a stored `tool_result` of a content-bearing operation on a sensitive database. */
export const REDACTED_SENSITIVE_MARKER = "[redacted: sensitive]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `details.sensitive === true`. */
export function carriesSensitiveMark(message: AgentMessage): boolean {
  const { result } = message;
  return isRecord(result) && isRecord(result.details) && result.details.sensitive === true;
}

/**
 * The `agent_run_events` form of a `tool_result`. A result with `details.sensitive` keeps its identity fields and
 * `toolCallId` (so a replay still pairs it), but its content becomes `REDACTED_SENSITIVE_MARKER`, the mark is dropped,
 * and `details.changes` keeps only the changed keys. Other results are returned as they are. The input is not modified:
 * the running turn keeps the real result.
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
