import type { AgentRunEventRow } from "@semprec/data";

const IDENTITY_FIELDS = ["operation", "mcp", "targetDatabaseId", "targetItemId"] as const;

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The `tool_use` payloads of a run's log that have no `tool_result` yet. A call carrying a
 * `toolCallId` is paired by that id; a call without one is paired by a `tool_result` that also
 * has no id, matched one for one in order.
 */
export function findDanglingToolUses(events: readonly AgentRunEventRow[]): Record<string, unknown>[] {
  const resultIds = new Set<string>();
  let anonymousResults = 0;
  for (const event of events) {
    if (event.kind !== "tool_result") continue;
    const { toolCallId } = payloadRecord(event.payload);
    if (typeof toolCallId === "string") resultIds.add(toolCallId);
    else anonymousResults += 1;
  }
  const dangling: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const toolUse = payloadRecord(event.payload);
    if (typeof toolUse.toolCallId === "string") {
      if (!resultIds.has(toolUse.toolCallId)) dangling.push(toolUse);
    } else if (anonymousResults > 0) {
      anonymousResults -= 1;
    } else {
      dangling.push(toolUse);
    }
  }
  return dangling;
}

/**
 * The synthetic result for an unmatched `tool_use`, in the shape a tool call that returned an
 * error result is stored in (`toolCallId`, `name`, `result: {content, details}`, `isError`).
 * Only the call's identity fields are copied; `arguments` and any other field are not.
 */
export function syntheticToolResult(toolUse: Record<string, unknown>, text: string): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) {
    if (toolUse[field] !== undefined) identity[field] = toolUse[field];
  }
  return {
    kind: "tool_result",
    ...(toolUse.toolCallId !== undefined ? { toolCallId: toolUse.toolCallId } : {}),
    name: typeof toolUse.name === "string" ? toolUse.name : "",
    ...identity,
    result: { content: [{ type: "text", text }], details: { error: true } },
    isError: true,
  };
}
