import type { Pool } from "pg";
import { connectMcpServer, type McpClientHandle } from "./mcpConnectionFactory.js";
import { McpConnectionError } from "./mcpConnectionError.js";
import type { McpToolInvocationTarget } from "./mcpToolInvocation.js";

/** Shaped like a pi-agent-core `tool_result` payload — see `delegateTool.ts`'s own comment for the same convention. */
export interface McpInvokeResult {
  error: boolean;
  result: string;
}

export type McpInvokeArgs = Record<string, unknown>;

export interface McpInvokeOptions {
  /** Forwarded to `connectMcpServer`'s `credential_access_log.actor_id`. */
  actorId?: string;
}

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

function formatCallToolResult(result: CallToolResultLike): McpInvokeResult {
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
 * Opens a connection through the #231 factory, calls `tools/call`, and always closes the
 * connection again — on both the success and failure path, matching `connectMcpServer`'s own
 * try/finally contract. Assumes `target` was already authorized (either just resolved by
 * `resolveMcpInvocation`, or reconstructed from an approved `approval_requests` snapshot by
 * issue #131's execution job); it does not re-check authorization itself. Only `serverItem` and
 * `toolName` are read, so a caller that has just those two (the approval-execution job doesn't
 * have a full, freshly-resolved `McpToolInvocationTarget`) can pass a matching partial object.
 */
export async function executeMcpInvocation(
  pool: Pool,
  target: Pick<McpToolInvocationTarget, "serverItem" | "toolName">,
  args: McpInvokeArgs,
  options: McpInvokeOptions = {},
): Promise<McpInvokeResult> {
  let handle: McpClientHandle | undefined;
  try {
    handle = await connectMcpServer(pool, target.serverItem, {
      actorId: options.actorId,
      purpose: "mcp_tool_invoke",
    });
    const callResult = await handle.client.callTool({ name: target.toolName, arguments: args });
    return formatCallToolResult(callResult as CallToolResultLike);
  } catch (err) {
    return { error: true, result: safeInvokeErrorMessage(err) };
  } finally {
    await handle?.close();
  }
}
