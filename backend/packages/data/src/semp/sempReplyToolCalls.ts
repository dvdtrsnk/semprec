import {
  parseToolEventPayload,
  type GenericOperationName,
  type McpToolEventIdentity,
  type ToolResultEventPayload,
} from "@semprec/shared";
import type { AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import { isRedactedResult, toolResultFailed } from "../agentRuns/agentRunStepPages.js";

/**
 * One tool call of a Semp turn as the reply summaries (issues #1860 and #1885) read it: the stored
 * `tool_use` and `tool_result` events matched on `toolCallId`. Neither the arguments nor the result are part
 * of what a summary stores; they are read only to take structured facts from them.
 */
export interface SempToolCall {
  toolCallId: string;
  /** The id of the call's first stored event; ids are bigints kept as strings. */
  firstEventId: string;
  /** The model-facing name of the tool. */
  name: string;
  /** Set for a generic operation. */
  operation: GenericOperationName | undefined;
  /** Set for an MCP tool. */
  mcp: McpToolEventIdentity | undefined;
  /** The call's arguments; `{}` when the call event is missing or its arguments are no object. */
  args: Readonly<Record<string, unknown>>;
  /** The item and database the call's arguments name; set for a generic operation only, never for an MCP tool. */
  targetItemId: string | undefined;
  targetDatabaseId: string | undefined;
  /** When the call's first stored event was written. */
  startedAt: string;
  /** The parsed result; `null` for a call that has none (the turn ended before it returned). */
  result: ToolResultEventPayload | null;
  /** When the result was stored; `null` without a result. */
  resultAt: string | null;
  /** The result says the call failed (`isError` or `details.error`). */
  failed: boolean;
  /** The stored result is the marker of a result redacted as sensitive (issue #1827). */
  redacted: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `value` as a lower-case uuid, else `null`: ids that the model wrote into arguments are only looked up when they are one. */
export function sempUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Matches the tool events of one turn on `toolCallId`, in the order of each call's first event. A result whose
 * call event is outside the events (or malformed) is still a call. An event that does not parse is skipped.
 */
export function pairSempToolCalls(events: readonly AgentRunEventRow[]): SempToolCall[] {
  const calls: SempToolCall[] = [];
  const open = new Map<string, SempToolCall>();
  for (const event of events) {
    if (event.kind === "tool_use") {
      const use = parseToolEventPayload("tool_use", event.payload);
      if (!use) continue;
      const generic = use.operation !== undefined;
      const call: SempToolCall = {
        toolCallId: use.toolCallId,
        firstEventId: event.id,
        name: use.name,
        operation: use.operation,
        mcp: use.mcp,
        args: isRecord(use.arguments) ? use.arguments : {},
        targetItemId: generic ? use.targetItemId : undefined,
        targetDatabaseId: generic ? use.targetDatabaseId : undefined,
        startedAt: event.at,
        result: null,
        resultAt: null,
        failed: false,
        redacted: false,
      };
      calls.push(call);
      open.set(use.toolCallId, call);
    } else if (event.kind === "tool_result") {
      const result = parseToolEventPayload("tool_result", event.payload);
      if (!result) continue;
      let call = open.get(result.toolCallId);
      if (call) {
        open.delete(result.toolCallId);
      } else {
        call = {
          toolCallId: result.toolCallId,
          firstEventId: event.id,
          name: result.name,
          operation: result.operation,
          mcp: result.mcp,
          args: {},
          targetItemId: result.operation !== undefined ? result.targetItemId : undefined,
          targetDatabaseId: result.operation !== undefined ? result.targetDatabaseId : undefined,
          startedAt: event.at,
          result: null,
          resultAt: null,
          failed: false,
          redacted: false,
        };
        calls.push(call);
      }
      call.result = result;
      call.resultAt = event.at;
      call.failed = toolResultFailed(event.payload);
      call.redacted = isRedactedResult(result.result);
    }
  }
  return calls;
}

/** The first text block of a stored pi result (`{ content: [{ type: "text", text }] }`), else `null`. */
function firstResultText(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  for (const block of result.content as unknown[]) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

/**
 * The item a successful item operation answered with, from its stored result (`Item.id`, `Item.databaseId`).
 * `null` for a call without a result, a redacted result and an answer that is not such a JSON object: a
 * result is the operation's output text, so a text that is not JSON is an expected outcome, not an error.
 */
export function sempToolCallResultItem(call: SempToolCall): { id: string; databaseId: string } | null {
  if (call.result === null || call.redacted) return null;
  const text = firstResultText(call.result.result);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.databaseId !== "string") return null;
  return { id: parsed.id, databaseId: parsed.databaseId };
}

/**
 * The id of the item a successful `item.create` created: the id of its result, else the `createdItemId` the tool
 * kept in the result's details, which is stored whole when the result text is redacted as sensitive (a create in a
 * sensitive database). The id names nothing of the item's content; callers still look it up in the tenant's scope.
 */
export function sempToolCallCreatedItemId(call: SempToolCall): string | null {
  return sempUuid(sempToolCallResultItem(call)?.id ?? call.result?.details?.createdItemId);
}

/** Whether the call ended by creating an approval request instead of running (`details.approvalRequestId`). */
export function sempToolCallApprovalRequestId(call: SempToolCall): string | undefined {
  return call.result?.details?.approvalRequestId;
}
