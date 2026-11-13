import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "./genericOperations/operationNames.js";

export interface McpToolEventIdentity {
  toolRegistrationId: string;
  serverItemId: string;
  serverName: string;
  toolName: string;
}

export type ToolEventMetadata =
  { operation: GenericOperationName; mcp?: never } | { mcp: McpToolEventIdentity; operation?: never };

interface ToolEventPayload {
  toolCallId: string;
  name: string;
  operation?: GenericOperationName;
  mcp?: McpToolEventIdentity;
  targetDatabaseId?: string;
  targetItemId?: string;
}

export interface ToolUseEventPayload extends ToolEventPayload {
  arguments: unknown;
}

/** One changed property of a successful `item.patch`; `before`/`after` are absent for `longText` and `before` also when the operation reported no previous value. */
export interface ToolResultChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

/** Structured fields of the stored pi result's `details`, so readers never parse the result text. */
export interface ToolResultDetails {
  approvalRequestId?: string;
  changes?: ToolResultChange[];
  /** The `ChokePointError.code` of a failed generic operation. */
  errorCode?: string;
  /** The failure kind of a failed MCP tool call (issue #1444). */
  failureKind?: string;
  /** The id of the item a successful `item.create` created; unlike the result text it is kept when that is redacted as sensitive. */
  createdItemId?: string;
}

export interface ToolResultEventPayload extends ToolEventPayload {
  result: unknown;
  isError: boolean;
  details?: ToolResultDetails;
}

function parseChange(value: unknown): ToolResultChange | null {
  if (!isRecord(value) || typeof value.key !== "string") return null;
  return {
    key: value.key,
    ...(Object.hasOwn(value, "before") ? { before: value.before } : {}),
    ...(Object.hasOwn(value, "after") ? { after: value.after } : {}),
  };
}

/** Lenient on purpose: a malformed `changes` entry is dropped, a malformed field is ignored, nothing throws. */
function parseResultDetails(result: unknown): ToolResultDetails | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const { approvalRequestId, changes, errorCode, failureKind, createdItemId } = result.details;
  const parsedChanges = Array.isArray(changes)
    ? changes.map(parseChange).filter((change): change is ToolResultChange => change !== null)
    : undefined;
  const details: ToolResultDetails = {
    ...(typeof approvalRequestId === "string" ? { approvalRequestId } : {}),
    ...(parsedChanges !== undefined ? { changes: parsedChanges } : {}),
    ...(typeof errorCode === "string" ? { errorCode } : {}),
    ...(typeof failureKind === "string" ? { failureKind } : {}),
    ...(typeof createdItemId === "string" ? { createdItemId } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpIdentity(value: unknown): value is McpToolEventIdentity {
  return (
    isRecord(value) &&
    typeof value.toolRegistrationId === "string" &&
    typeof value.serverItemId === "string" &&
    typeof value.serverName === "string" &&
    typeof value.toolName === "string"
  );
}

export function parseToolEventPayload(kind: "tool_use", payload: unknown): ToolUseEventPayload | null;
export function parseToolEventPayload(kind: "tool_result", payload: unknown): ToolResultEventPayload | null;
export function parseToolEventPayload(
  kind: string,
  payload: unknown,
): ToolUseEventPayload | ToolResultEventPayload | null;
/** Validates stored JSON without inferring identity from a legacy model-facing name. */
export function parseToolEventPayload(
  kind: string,
  payload: unknown,
): ToolUseEventPayload | ToolResultEventPayload | null {
  if (!isRecord(payload) || typeof payload.toolCallId !== "string" || typeof payload.name !== "string") return null;
  if (payload.kind !== undefined && payload.kind !== kind) return null;
  const operation = GENERIC_OPERATION_NAMES.find((name) => name === payload.operation);
  if (payload.operation !== undefined && operation === undefined) return null;
  if (payload.mcp !== undefined && !isMcpIdentity(payload.mcp)) return null;
  if (operation !== undefined && payload.mcp !== undefined) return null;
  if (payload.targetDatabaseId !== undefined && typeof payload.targetDatabaseId !== "string") return null;
  if (payload.targetItemId !== undefined && typeof payload.targetItemId !== "string") return null;
  const common: ToolEventPayload = {
    toolCallId: payload.toolCallId,
    name: payload.name,
    ...(operation !== undefined ? { operation } : {}),
    ...(isMcpIdentity(payload.mcp) ? { mcp: payload.mcp } : {}),
    ...(typeof payload.targetDatabaseId === "string" ? { targetDatabaseId: payload.targetDatabaseId } : {}),
    ...(typeof payload.targetItemId === "string" ? { targetItemId: payload.targetItemId } : {}),
  };
  if (kind === "tool_use" && Object.hasOwn(payload, "arguments")) return { ...common, arguments: payload.arguments };
  if (kind === "tool_result" && Object.hasOwn(payload, "result") && typeof payload.isError === "boolean") {
    const details = parseResultDetails(payload.result);
    return { ...common, result: payload.result, isError: payload.isError, ...(details ? { details } : {}) };
  }
  return null;
}
