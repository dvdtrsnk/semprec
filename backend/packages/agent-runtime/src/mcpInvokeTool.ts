import type { Pool } from "pg";
import { Ajv, type ValidateFunction } from "ajv";
import {
  connectMcpServer,
  resolveGrantedMcpTool,
  withTransaction,
  McpConnectionError,
  type McpClientHandle,
  type McpToolInvocationTarget,
} from "@semprec/data";

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

export type McpInvokeTool = (args: McpInvokeArgs) => Promise<McpInvokeResult>;

/**
 * The outbound MCP-invoke adapter (issue #128): resolves `mcpToolRegistrationId` against
 * `projectItemId`'s current grants, validates `args` against the tool's synchronized schema,
 * and rejects before ever touching a transport (`resolveMcpInvocation`) — or, once that passes,
 * opens a connection through the #231 factory, calls `tools/call`, and closes it again
 * (`executeMcpInvocation`). Split into these two steps (rather than one function) so a future
 * approval-queue composition root can insert its waiting/execution state between them: a
 * resolved-but-not-yet-executed invocation already carries `target.requiresApproval` and
 * `target.riskClass` — the approval metadata this issue's Task says to feed forward — without
 * this file implementing any waiting itself. `createMcpInvokeTool` composes both directly for a
 * tool that doesn't need that gate.
 */
export interface ResolvedMcpInvocation {
  ok: true;
  target: McpToolInvocationTarget;
  args: McpInvokeArgs;
}

export interface RejectedMcpInvocation {
  ok: false;
  result: McpInvokeResult;
}

export type McpInvocationResolution = ResolvedMcpInvocation | RejectedMcpInvocation;

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compiles fresh on every call rather than caching by registration id: a tool's schema can
 * change between calls (the next "Synchronize tools" pass, #125), and this adapter always
 * re-validates against whatever `resolveMcpInvocation` just read, not a stale compiled copy.
 */
function validateArguments(schema: unknown, args: McpInvokeArgs): string | null {
  if (typeof schema !== "object" || schema === null) {
    return "the tool's registered schema is not a valid JSON Schema object";
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch {
    return "the tool's registered schema could not be compiled";
  }
  if (validate(args)) return null;
  const errors = validate.errors ?? [];
  if (errors.length === 0) return "arguments do not match the tool's schema";
  return errors.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("; ");
}

function rejection(result: string): RejectedMcpInvocation {
  return { ok: false, result: { error: true, result } };
}

/**
 * Re-derives authorization and validates arguments before any transport is touched. Both
 * `projectItemId` and `mcpToolRegistrationId` must come from server-derived run context (the
 * per-run permission manifest's `McpAgentToolProjection`), never from `args` or any other
 * model-supplied value — see `mcpToolInvocation.ts`'s own header comment for why a spoofed id
 * must fail exactly like an unknown or revoked one.
 */
export async function resolveMcpInvocation(
  pool: Pool,
  projectItemId: string,
  mcpToolRegistrationId: string,
  args: McpInvokeArgs,
): Promise<McpInvocationResolution> {
  const target = await withTransaction(pool, (client) =>
    resolveGrantedMcpTool(client, projectItemId, mcpToolRegistrationId),
  );
  if (!target) {
    return rejection("This MCP tool is unavailable: it is unknown, inactive, or no longer granted to this project.");
  }

  const validationError = validateArguments(target.toolSchema, args);
  if (validationError !== null) {
    return rejection(`Invalid arguments for MCP tool '${target.toolName}': ${validationError}`);
  }

  return { ok: true, target, args };
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
 * try/finally contract. Assumes `target` was just produced by `resolveMcpInvocation` (or an
 * equivalent freshly-resolved grant); it does not re-check authorization itself.
 */
export async function executeMcpInvocation(
  pool: Pool,
  target: McpToolInvocationTarget,
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

/**
 * Composes `resolveMcpInvocation` + `executeMcpInvocation` into one `(args) => result` function
 * bound to a single granted tool, following `delegateTool.ts`'s factory-closure convention.
 * Suitable wherever no approval gate needs to sit between resolution and execution; a
 * composition root that does need one calls the two steps separately instead.
 */
export function createMcpInvokeTool(
  pool: Pool,
  projectItemId: string,
  mcpToolRegistrationId: string,
  options: McpInvokeOptions = {},
): McpInvokeTool {
  return async function invoke(args) {
    const resolution = await resolveMcpInvocation(pool, projectItemId, mcpToolRegistrationId, args);
    if (!resolution.ok) return resolution.result;
    return executeMcpInvocation(pool, resolution.target, resolution.args, options);
  };
}
