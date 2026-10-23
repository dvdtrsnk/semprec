import type { Pool } from "pg";
import { Ajv, type ValidateFunction } from "ajv";
import {
  resolveGrantedMcpTool,
  createPendingApprovalRequest,
  withTransaction,
  executeMcpInvocation,
  getTenantUserId,
  writeNotification,
  type McpToolInvocationTarget,
  type McpInvokeResult,
  type McpInvokeArgs,
  type McpInvokeOptions,
} from "@semprec/data";

export type { McpInvokeResult, McpInvokeArgs, McpInvokeOptions } from "@semprec/data";
export { executeMcpInvocation } from "@semprec/data";

export type McpInvokeTool = (args: McpInvokeArgs, signal?: AbortSignal) => Promise<McpInvokeResult>;

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

/** Bounds how many compiled schemas the agents process holds at once (issue #696's acceptance criterion). */
const MAX_COMPILED_SCHEMAS = 256;

interface CompiledSchemaEntry {
  updatedAt: string;
  /** `null` when the schema failed to compile, so a broken schema isn't recompiled on every call — see `validateArguments`. */
  validate: ValidateFunction | null;
}

/**
 * Keyed by `mcpToolRegistrationId`, insertion-order-evicted once past `MAX_COMPILED_SCHEMAS`:
 * a `Map`'s iteration order is insertion order, and re-`set`ting an existing key moves it to the
 * end, so `.keys().next().value` is always the least-recently-inserted (LRU-by-insertion) entry.
 */
const compiledSchemas = new Map<string, CompiledSchemaEntry>();

function compileSchema(schema: object, registrationId: string, updatedAt: string): CompiledSchemaEntry {
  // A fresh Ajv instance per compile (rather than one shared, module-level instance) so a
  // schema carrying its own `$id` can never collide with another registration's `$id` already
  // registered on the same instance — the second `compile()` of a repeated `$id` on a shared
  // instance throws "schema with key or id ... already exists".
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ValidateFunction | null;
  try {
    validate = ajv.compile(schema);
  } catch {
    validate = null;
  }
  const entry: CompiledSchemaEntry = { updatedAt, validate };

  compiledSchemas.delete(registrationId);
  compiledSchemas.set(registrationId, entry);
  if (compiledSchemas.size > MAX_COMPILED_SCHEMAS) {
    const oldestKey = compiledSchemas.keys().next().value;
    if (oldestKey !== undefined) compiledSchemas.delete(oldestKey);
  }
  return entry;
}

/**
 * Compiles a granted tool's registered schema once per registration version instead of on every
 * call: a cache miss, or a `target.toolSchemaUpdatedAt` that no longer matches the cached entry
 * (the next "Synchronize tools" pass, #125, changed the schema), triggers a fresh compile; an
 * unchanged registration reuses the previously compiled validator.
 */
function validateArguments(target: McpToolInvocationTarget, args: McpInvokeArgs): string | null {
  const { toolSchema: schema, mcpToolRegistrationId, toolSchemaUpdatedAt } = target;
  if (typeof schema !== "object" || schema === null) {
    return "the tool's registered schema is not a valid JSON Schema object";
  }

  let entry = compiledSchemas.get(mcpToolRegistrationId);
  if (!entry || entry.updatedAt !== toolSchemaUpdatedAt) {
    entry = compileSchema(schema, mcpToolRegistrationId, toolSchemaUpdatedAt);
  }
  if (!entry.validate) {
    return "the tool's registered schema could not be compiled";
  }

  const validate = entry.validate;
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

  const validationError = validateArguments(target, args);
  if (validationError !== null) {
    return rejection(`Invalid arguments for MCP tool '${target.toolName}': ${validationError}`);
  }

  return { ok: true, target, args };
}

/**
 * Composes `resolveMcpInvocation` + `executeMcpInvocation` into one `(args) => result` function
 * bound to a single granted tool, following `delegateTool.ts`'s factory-closure convention.
 * Suitable wherever no approval gate needs to sit between resolution and execution; a
 * composition root that does need one calls the two steps separately instead — see
 * `createApprovalGatedMcpInvokeTool` below, the composition root issue #130 adds for exactly
 * that gate.
 */
export function createMcpInvokeTool(
  pool: Pool,
  projectItemId: string,
  mcpToolRegistrationId: string,
  options: McpInvokeOptions = {},
): McpInvokeTool {
  return async function invoke(args, signal) {
    const resolution = await resolveMcpInvocation(pool, projectItemId, mcpToolRegistrationId, args);
    if (!resolution.ok) return resolution.result;
    return executeMcpInvocation(pool, resolution.target, resolution.args, options, signal);
  };
}

/**
 * Formats the synthetic result a caller sees for a call this issue deferred to a human: shaped
 * exactly like a real `McpInvokeResult` (`error: false` — the *tool call itself* succeeded in the
 * sense that a request now exists, even though the underlying tool has not run) so the agent
 * turn and run complete normally as `done`, per the issue's Task, instead of the run treating
 * this as a failure.
 */
function pendingApprovalResult(requestId: string, toolName: string): McpInvokeResult {
  return {
    error: false,
    result: `Tool '${toolName}' requires human approval before it can run. Approval request ${requestId} has been created and is awaiting a decision; this call has not been executed.`,
  };
}

/**
 * The approval-gated composition root (issue #130): resolves and validates exactly like
 * `createMcpInvokeTool`, but when the resolved target's `requiresApproval` is set, transactionally
 * inserts one `pending` `approval_requests` row — snapshotting the tool name, current risk class,
 * and the exact resolved invocation (registration/server ids and arguments) needed to execute it
 * later — instead of calling `executeMcpInvocation`, and returns a synthetic success result
 * carrying the new request's id. A tool that doesn't require approval continues straight through
 * to `executeMcpInvocation`, unaffected by this gate.
 *
 * The insert also writes the reference `approval_pending` notification (issue #149) in the same
 * transaction: rolling back the request rolls back the notification with it. `transitionInstance`
 * is the new request's own freshly generated id — a create is a one-shot event with no retry of
 * "the same" transition to dedupe against, so the id doubling as both `sourceId` and
 * `transitionInstance` is exactly as unique as the row it names. Silently skips the notification
 * before any account exists, matching `notifyHeartbeatError`.
 */
export function createApprovalGatedMcpInvokeTool(
  pool: Pool,
  agentRunId: string,
  projectItemId: string,
  mcpToolRegistrationId: string,
  options: McpInvokeOptions = {},
): McpInvokeTool {
  return async function invoke(args, signal) {
    const resolution = await resolveMcpInvocation(pool, projectItemId, mcpToolRegistrationId, args);
    if (!resolution.ok) return resolution.result;

    const { target } = resolution;
    if (target.requiresApproval) {
      const request = await withTransaction(pool, async (client) => {
        const created = await createPendingApprovalRequest(client, {
          agentRunId,
          toolName: target.toolName,
          riskClass: target.riskClass,
          payload: {
            mcpToolRegistrationId: target.mcpToolRegistrationId,
            mcpServerItemId: target.mcpServerItemId,
            args: resolution.args,
          },
          // mcpInvoke requests have no destructive-operation resource to snapshot (issue #89 only
          // introduced that concept for the five generic-operation kinds) — this placeholder just
          // satisfies the column's `NOT NULL` constraint without claiming a hash that doesn't exist.
          resourceSnapshot: { kind: "mcp_invoke", resourceId: mcpToolRegistrationId, sha256: null },
        });
        const userId = await getTenantUserId(client);
        if (userId) {
          await writeNotification(client, {
            userId,
            kind: "approval_pending",
            titleParams: { toolName: created.toolName },
            linkHref: `?page=approvals&user=${userId}`,
            sourceTable: "approval_requests",
            sourceId: created.id,
            transitionInstance: created.id,
          });
        }
        return created;
      });
      return pendingApprovalResult(request.id, target.toolName);
    }

    return executeMcpInvocation(pool, target, resolution.args, options, signal);
  };
}
