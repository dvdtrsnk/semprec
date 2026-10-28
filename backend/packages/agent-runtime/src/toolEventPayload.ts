import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "@semprec/shared";

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

export interface ToolResultEventPayload extends ToolEventPayload {
  result: unknown;
  isError: boolean;
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
    return { ...common, result: payload.result, isError: payload.isError };
  }
  return null;
}
