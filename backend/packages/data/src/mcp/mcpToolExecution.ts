import type { Pool } from "pg";
import { createLogger } from "@semprec/shared";
import { connectMcpServer, type McpClientHandle } from "./mcpConnectionFactory.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpConnectionError, MCP_DEFAULT_CONNECT_TIMEOUT_MS } from "./mcpConnectionError.js";
import type { McpToolInvocationTarget } from "./mcpToolInvocation.js";
import { recordMcpConnectionFailure, recordMcpConnectionSuccess } from "./mcpServerConnectionStateStore.js";

const logger = createLogger("mcp");

/** Shaped like a pi-agent-core `tool_result` payload — see `delegateTool.ts`'s own comment for the same convention. */
export interface McpInvokeResult {
  error: boolean;
  result: string;
  /** Present only when `error` is true and the failure was not a cancellation by the run's signal. */
  failure?: McpInvokeFailure;
}

export const MCP_FAILURE_KINDS = ["timeout", "unavailable", "connection", "auth", "toolError"] as const;

export type McpFailureKind = (typeof MCP_FAILURE_KINDS)[number];

/** Machine-readable reason for a failed MCP call; carries ids and numbers only, never an exception message. */
export interface McpInvokeFailure {
  failureKind: McpFailureKind;
  /** Omitted only for `unavailable`, where no server item was loaded. */
  mcpServerItemId?: string;
  timeoutMs?: number;
}

export type McpInvokeArgs = Record<string, unknown>;

export interface McpInvokeOptions {
  /** Forwarded to `connectMcpServer`'s `credential_access_log.actor_id`. */
  actorId?: string;
  /**
   * Sent as `_meta.idempotencyKey` on the `tools/call` request — the MCP-permitted request
   * metadata slot — so a server that de-duplicates can recognise a redelivered call (issue #693:
   * the approval-execution job passes the claimed request's id here). This process never re-calls
   * a request it has already claimed; the key exists purely for the server's own benefit.
   */
  idempotencyKey?: string;
}

/**
 * Bounds one `tools/call`. The SDK already defaults to 60 s; stating it here keeps the bound
 * visible at the call site instead of depending on a library default.
 */
const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * Maps a transport/invoke failure to a fixed, secret-free message. `McpConnectionError`'s own
 * `message` is already built from fixed wording plus non-secret identifiers (see
 * `mcpConnectionFactory.ts`), so it's safe to surface verbatim; anything else (an SDK-level
 * `tools/call` failure, a bug) gets a generic message instead of that error's own possibly
 * server-influenced `message`.
 */
function safeInvokeErrorMessage(err: unknown): string {
  if (err instanceof McpConnectionError) return err.message;
  return "MCP tool call failed for an unexpected reason";
}

/** Whether `err` is an HTTP 401/403 rejection from the server, on connect or on `tools/call`. */
function isAuthRejection(err: unknown): boolean {
  if (err instanceof McpConnectionError) return err.httpStatus === 401 || err.httpStatus === 403;
  if (err instanceof StreamableHTTPError || err instanceof SseError || err instanceof McpError) {
    return err.code === 401 || err.code === 403;
  }
  return false;
}

function classifyFailure(err: unknown, mcpServerItemId: string): McpInvokeFailure {
  if (err instanceof McpConnectionError) {
    if (err.reason === "credential_decryption_failed" || isAuthRejection(err)) {
      return { failureKind: "auth", mcpServerItemId };
    }
    if (err.reason === "connect_timeout") {
      return { failureKind: "timeout", mcpServerItemId, timeoutMs: MCP_DEFAULT_CONNECT_TIMEOUT_MS };
    }
    return { failureKind: "connection", mcpServerItemId };
  }
  if (isAuthRejection(err)) return { failureKind: "auth", mcpServerItemId };
  if (err instanceof McpError && err.code === Number(ErrorCode.RequestTimeout)) {
    return { failureKind: "timeout", mcpServerItemId, timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS };
  }
  return { failureKind: "toolError", mcpServerItemId };
}

function formatContentBlock(block: unknown): string {
  if (typeof block !== "object" || block === null || !("type" in block)) return "[content omitted]";
  const type = (block as { type?: unknown }).type;
  if (type === "text") {
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? text : "[content omitted]";
  }
  if (type === "image" || type === "audio") {
    const mimeType = (block as { mimeType?: unknown }).mimeType;
    return `[${type} content${typeof mimeType === "string" ? `, ${mimeType}` : ""} omitted]`;
  }
  if ("uri" in block) {
    const uri = (block as { uri?: unknown }).uri;
    return `[resource${typeof uri === "string" ? ` ${uri}` : ""} omitted]`;
  }
  return "[content omitted]";
}

/** `handle.client.callTool`'s result shape — the MCP SDK doesn't export this as a standalone type usable without its zod schema, so this is the narrow subset actually read here. */
interface CallToolResultLike {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function formatCallToolResult(result: CallToolResultLike, mcpServerItemId: string): McpInvokeResult {
  const formatted = formatCallToolContent(result);
  return formatted.error ? { ...formatted, failure: { failureKind: "toolError", mcpServerItemId } } : formatted;
}

function formatCallToolContent(result: CallToolResultLike): McpInvokeResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map(formatContentBlock)
    .filter((part) => part.length > 0)
    .join("\n");
  if (text.length > 0) return { error: result.isError === true, result: text };
  if (result.structuredContent !== undefined) {
    return { error: result.isError === true, result: JSON.stringify(result.structuredContent) };
  }
  return { error: result.isError === true, result: "" };
}

/**
 * Best-effort (issue #1450): a failure to record the connection outcome is logged and never
 * changes the invocation result. Logs the error name and the server id only.
 */
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
 * Opens a connection through the #231 factory, calls `tools/call`, and always closes the
 * connection again — on both the success and failure path, matching `connectMcpServer`'s own
 * try/finally contract. Assumes `target` was already authorized (either just resolved by
 * `resolveMcpInvocation`, or reconstructed from an approved `approval_requests` snapshot by
 * issue #131's execution job); it does not re-check authorization itself. Only `serverItem` and
 * `toolName` are read, so a caller that has just those two (the approval-execution job doesn't
 * have a full, freshly-resolved `McpToolInvocationTarget`) can pass a matching partial object.
 * `signal` cancels an in-flight `tools/call` (an aborted agent run passes its own), which then
 * resolves as an error result like any other failed call. `options.idempotencyKey`, when set, is
 * sent as `_meta.idempotencyKey` on the call — see `McpInvokeOptions`'s docstring. A `close()`
 * failure after the call never overrides the result the `try`/`catch` above already produced —
 * see that block's own comment.
 */
export async function executeMcpInvocation(
  pool: Pool,
  target: Pick<McpToolInvocationTarget, "serverItem" | "toolName">,
  args: McpInvokeArgs,
  options: McpInvokeOptions = {},
  signal?: AbortSignal,
): Promise<McpInvokeResult> {
  let handle: McpClientHandle | undefined;
  try {
    handle = await connectMcpServer(pool, target.serverItem, {
      actorId: options.actorId,
      purpose: "mcp_tool_invoke",
    });
    await recordConnectionOutcome(() => recordMcpConnectionSuccess(pool, target.serverItem.id), target.serverItem.id);
    const callResult = await handle.client.callTool(
      {
        name: target.toolName,
        arguments: args,
        ...(options.idempotencyKey !== undefined ? { _meta: { idempotencyKey: options.idempotencyKey } } : {}),
      },
      undefined,
      { signal, timeout: MCP_TOOL_CALL_TIMEOUT_MS },
    );
    return formatCallToolResult(callResult as CallToolResultLike, target.serverItem.id);
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
      failure: classifyFailure(err, target.serverItem.id),
    };
  } finally {
    // A close failure must never replace the `try`'s return value or the `catch`'s error result
    // above — only log it, so a rejecting `close()` after a successful `tools/call` can't turn a
    // successful outcome into a job failure (issue #693).
    try {
      await handle?.close();
    } catch (err) {
      logger.warn({ err }, "MCP connection close failed after tools/call");
    }
  }
}
