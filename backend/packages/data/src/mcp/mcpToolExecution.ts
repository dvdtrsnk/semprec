import type { Pool } from "pg";
import { createLogger } from "@alldots/shared";
import { connectMcpServer, type McpClientHandle } from "./mcpConnectionFactory.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  McpConnectionAuthenticationError,
  McpConnectionError,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
} from "./mcpConnectionError.js";
import type { McpToolInvocationTarget } from "./mcpToolInvocation.js";
import { recordMcpConnectionFailure, recordMcpConnectionSuccess } from "./mcpServerConnectionStateStore.js";
import type { McpInvokeFailure } from "./mcpFailure.js";
import type { McpHttpObservation } from "./mcpHttpFailureObservation.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
export { MCP_FAILURE_KINDS } from "./mcpFailure.js";
export type { McpFailureKind, McpInvokeFailure } from "./mcpFailure.js";

const logger = createLogger("mcp");

/** Shaped like a pi-agent-core `tool_result` payload. */
export type McpInvokeResult =
  { error: false; result: string; failure?: never } | { error: true; result: string; failure?: McpInvokeFailure };

export type McpInvokeArgs = Record<string, unknown>;

export interface McpInvokeOptions {
  actorId?: string;
  /**
   * Sent as `_meta.idempotencyKey` so a de-duplicating server can recognise a redelivered call. This process never
   * re-calls a claimed request; the key is for the server's benefit only.
   */
  idempotencyKey?: string;
}

/** Matches the SDK default, stated so the bound is visible here. */
const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * `McpConnectionError` messages are fixed and secret-free; anything else gets a generic message instead of its
 * possibly server-influenced text.
 */
function safeInvokeErrorMessage(err: unknown): string {
  if (err instanceof McpConnectionError) return err.message;
  return "MCP tool call failed for an unexpected reason";
}

/** Whether `err` is an HTTP 401/403 rejection from the server, on connect or on `tools/call`. */
function isAuthRejection(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof McpConnectionError) return err.httpStatus === 401 || err.httpStatus === 403;
  if (err instanceof StreamableHTTPError || err instanceof SseError || err instanceof McpError) {
    return err.code === 401 || err.code === 403;
  }
  return false;
}

function classifyFailure(err: unknown, mcpServerItemId: string, observedStatus?: 401 | 403): McpInvokeFailure {
  if (err instanceof McpConnectionError) {
    if (err.reason === "connect_timeout") {
      return { failureKind: "timeout", mcpServerItemId, timeoutMs: MCP_DEFAULT_CONNECT_TIMEOUT_MS };
    }
    if (err.reason === "address_not_allowed") return { failureKind: "connection", mcpServerItemId };
    if (
      err instanceof McpConnectionAuthenticationError ||
      err.reason === "credential_decryption_failed" ||
      isAuthRejection(err)
    ) {
      return { failureKind: "auth", mcpServerItemId };
    }
    return { failureKind: "connection", mcpServerItemId };
  }
  if (err instanceof McpError && err.code === Number(ErrorCode.RequestTimeout)) {
    return { failureKind: "timeout", mcpServerItemId, timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS };
  }
  if (isAuthRejection(err) || observedStatus !== undefined) return { failureKind: "auth", mcpServerItemId };
  return { failureKind: "toolError", mcpServerItemId };
}

function formatContentBlock(block: unknown): string {
  if (typeof block !== "object" || block === null || !("type" in block)) return "[content omitted]";
  const type = block.type;
  if (type === "text") {
    const text = "text" in block ? block.text : undefined;
    return typeof text === "string" ? text : "[content omitted]";
  }
  if (type === "image" || type === "audio") {
    const mimeType = "mimeType" in block ? block.mimeType : undefined;
    return `[${type} content${typeof mimeType === "string" ? `, ${mimeType}` : ""} omitted]`;
  }
  if ("uri" in block) {
    const uri = block.uri;
    return `[resource${typeof uri === "string" ? ` ${uri}` : ""} omitted]`;
  }
  return "[content omitted]";
}

function formatCallToolResult(result: unknown, mcpServerItemId: string): McpInvokeResult {
  const formatted = formatCallToolContent(result);
  return formatted.error ? { ...formatted, failure: { failureKind: "toolError", mcpServerItemId } } : formatted;
}

function formatCallToolContent(result: unknown): McpInvokeResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Invalid MCP tool result");
  }
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const text = content
    .map(formatContentBlock)
    .filter((part) => part.length > 0)
    .join("\n");
  const formattedText =
    text.length > 0
      ? text
      : "structuredContent" in result && result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : "";
  return "isError" in result && result.isError === true
    ? { error: true, result: formattedText }
    : { error: false, result: formattedText };
}

/** Best-effort: a recording failure is logged (error name and server id only) and never changes the result. */
async function recordConnectionOutcome(record: () => Promise<void>, serverItemId: string): Promise<void> {
  try {
    await record();
  } catch (err) {
    logger.warn(
      { errName: err instanceof Error ? err.name : typeof err, mcpServerItemId: serverItemId },
      "recording the MCP connection outcome failed",
    );
  }
}

/**
 * Assumes `target` is already authorized (freshly resolved or an approved snapshot); it does not re-check. Only
 * `serverItem` and `toolName` are read, so the approval job can pass a partial object. An aborted `signal` resolves
 * as an error result. The connection is always closed.
 */
export async function executeMcpInvocation(
  pool: Pool,
  target: Pick<McpToolInvocationTarget, "serverItem" | "toolName">,
  args: McpInvokeArgs,
  options: McpInvokeOptions = {},
  signal?: AbortSignal,
): Promise<McpInvokeResult> {
  let handle: McpClientHandle | undefined;
  let observation: McpHttpObservation | undefined;
  try {
    handle = await connectMcpServer(pool, target.serverItem, {
      actorId: options.actorId,
      purpose: "mcp_tool_invoke",
    });
    await recordConnectionOutcome(() => recordMcpConnectionSuccess(pool, target.serverItem.id), target.serverItem.id);
    observation = handle.beginHttpObservation?.();
    const connected = handle;
    const call = () =>
      connected.client.callTool(
        {
          name: target.toolName,
          arguments: args,
          ...(options.idempotencyKey !== undefined ? { _meta: { idempotencyKey: options.idempotencyKey } } : {}),
        },
        undefined,
        { signal, timeout: MCP_TOOL_CALL_TIMEOUT_MS },
      );
    const callResult = await (observation ? observation.run(call) : call());
    return formatCallToolResult(callResult, target.serverItem.id);
  } catch (err) {
    // `handle` is set only once the connect succeeded, so a `McpConnectionError` here is a failed connect.
    if (handle === undefined && err instanceof McpConnectionError) {
      const { reason } = err;
      await recordConnectionOutcome(
        () => recordMcpConnectionFailure(pool, target.serverItem.id, reason),
        target.serverItem.id,
      );
    }
    if (signal?.aborted) return { error: true, result: "MCP tool call was cancelled before it completed" };
    return {
      error: true,
      result: safeInvokeErrorMessage(err),
      failure: classifyFailure(err, target.serverItem.id, observation?.status(err)),
    };
  } finally {
    observation?.close();
    // A close failure is only logged, so it cannot turn a successful call into a job failure.
    try {
      await handle?.close();
    } catch {
      logger.warn({ mcpServerItemId: target.serverItem.id }, "MCP connection close failed after tools/call");
    }
  }
}
