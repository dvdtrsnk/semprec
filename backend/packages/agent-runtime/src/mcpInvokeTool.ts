import type { Pool } from "pg";
import { isRiskClass } from "@alldots/shared";
import { Ajv, type ValidateFunction } from "ajv";
import {
  resolveGrantedMcpTool,
  createPendingApprovalRequestAndPublish,
  approvalNotificationBody,
  approvalNotificationLinkHref,
  buildMcpInvokeApprovalDescription,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  withTransaction,
  executeMcpInvocation,
  getApprovalRequestSourceKind,
  getTenantUserId,
  writeNotification,
  type McpToolInvocationTarget,
  type McpInvokeResult,
  type McpInvokeArgs,
  type McpInvokeOptions,
} from "@alldots/data";

export type { McpInvokeResult, McpInvokeArgs, McpInvokeOptions } from "@alldots/data";
export { executeMcpInvocation } from "@alldots/data";

/** An MCP result that also names the approval request the call created, when it was deferred to a human. */
export type McpInvokeToolResult = McpInvokeResult & { approvalRequestId?: string };

export type McpInvokeTool = (
  args: McpInvokeArgs,
  signal?: AbortSignal,
  /** `toolCallId`: the model-runtime tool call, stored on an approval request the call creates. */
  invokeOptions?: { toolCallId?: string },
) => Promise<McpInvokeToolResult>;

/**
 * The outbound MCP-invoke adapter in two steps: `resolveMcpInvocation` resolves the registration against the project's
 * current grants and validates `args` before any transport is touched; `executeMcpInvocation` connects, calls
 * `tools/call` and closes. An approval gate sits between them (`createApprovalGatedMcpInvokeTool`); a resolved
 * invocation carries `target.requiresApproval` and `target.riskClass` for it.
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

/** Bounds how many compiled schemas the agents process holds. */
const MAX_COMPILED_SCHEMAS = 256;

interface CompiledSchemaEntry {
  updatedAt: string;
  /** `null` when compilation failed, so a broken schema is not recompiled on every call. */
  validate: ValidateFunction | null;
}

/** Insertion-order eviction: re-`set`ting a key moves it to the end, so `.keys().next().value` is the oldest entry. */
const compiledSchemas = new Map<string, CompiledSchemaEntry>();

function compileSchema(schema: object, registrationId: string, updatedAt: string): CompiledSchemaEntry {
  // A fresh Ajv per compile: a schema's own `$id` would otherwise collide with another registration's on a shared
  // instance ("schema with key or id ... already exists").
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

/** Compiles once per registration version: a miss or a changed `target.toolSchemaUpdatedAt` recompiles. */
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

function rejection(result: string, failure?: McpInvokeResult["failure"]): RejectedMcpInvocation {
  return { ok: false, result: { error: true, result, ...(failure ? { failure } : {}) } };
}

/**
 * `projectItemId` and `mcpToolRegistrationId` must come from server-derived run context, never from model-supplied
 * values; a spoofed id must fail exactly like an unknown or revoked one (see `mcpToolInvocation.ts`).
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
    // No registration was resolved, so no server item id is known to attach.
    return rejection("This MCP tool is unavailable: it is unknown, inactive, or no longer granted to this project.", {
      failureKind: "unavailable",
    });
  }

  const validationError = validateArguments(target, args);
  if (validationError !== null) {
    return rejection(`Invalid arguments for MCP tool '${target.toolName}': ${validationError}`);
  }

  return { ok: true, target, args };
}

/**
 * `resolveMcpInvocation` + `executeMcpInvocation` bound to one granted tool, for callers that need no approval gate.
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
 * Reserved argument an agent may add to an approval-gated MCP call to say why it asks. A third-party tool's parameters
 * are free-form, so a plain `reason` could collide; the wrapper removes this key before validation, storage and
 * invocation.
 */
export const MCP_APPROVAL_REASON_KEY = "alldotsReason";

type ReasonExtraction = { ok: true; args: McpInvokeArgs; reason: string | null } | { ok: false; error: string };

function extractReason(args: McpInvokeArgs): ReasonExtraction {
  if (!(MCP_APPROVAL_REASON_KEY in args)) return { ok: true, args, reason: null };
  const { [MCP_APPROVAL_REASON_KEY]: raw, ...rest } = args;
  if (raw === undefined || raw === null) return { ok: true, args: rest, reason: null };
  if (typeof raw !== "string" || Array.from(raw).length > APPROVAL_REQUEST_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Invalid argument '${MCP_APPROVAL_REASON_KEY}': it must be a string of at most ${APPROVAL_REQUEST_REASON_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, args: rest, reason: raw };
}

/** Shaped like a real result with `error: false` (a request now exists) so the turn and run complete as `done`. */
function pendingApprovalResult(requestId: string, toolName: string): McpInvokeToolResult {
  return {
    error: false,
    approvalRequestId: requestId,
    result: `Tool '${toolName}' requires human approval before it can run. Approval request ${requestId} has been created and is awaiting a decision; this call has not been executed.`,
  };
}

/**
 * Resolves and validates like `createMcpInvokeTool`; when the target `requiresApproval`, inserts one `pending`
 * `approval_requests` row snapshotting the tool name, risk class and exact resolved invocation, and returns a synthetic
 * success carrying the request id instead of executing.
 *
 * The `approval_pending` notification is written in the same transaction. Its `transitionInstance` is the new request's
 * id: a create is one-shot, so that id is as unique as the row. The notification is skipped before any account exists.
 * The request is announced to its owner after commit through the process's realtime publisher; a replayed tool call
 * returns the existing request and announces nothing.
 */
export function createApprovalGatedMcpInvokeTool(
  pool: Pool,
  agentRunId: string,
  projectItemId: string,
  mcpToolRegistrationId: string,
  options: McpInvokeOptions = {},
  knownServerItemId?: string,
): McpInvokeTool {
  if (
    knownServerItemId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(knownServerItemId)
  ) {
    throw new Error("Invalid MCP server item id");
  }
  return async function invoke(rawArgs, signal, invokeOptions) {
    const extracted = extractReason(rawArgs);
    if (!extracted.ok) return { error: true, result: extracted.error };
    const { args, reason } = extracted;

    const resolution = await resolveMcpInvocation(pool, projectItemId, mcpToolRegistrationId, args);
    if (!resolution.ok) {
      const result = resolution.result;
      if (result.failure?.failureKind === "unavailable" && knownServerItemId !== undefined) {
        return {
          error: true,
          result: result.result,
          failure: { failureKind: "unavailable", mcpServerItemId: knownServerItemId },
        };
      }
      return result;
    }

    const { target } = resolution;
    if (target.requiresApproval) {
      const request = await withTransaction(pool, async (client) => {
        const created = await createPendingApprovalRequestAndPublish(client, {
          agentRunId,
          toolName: target.toolName,
          riskClass: isRiskClass(target.riskClass) ? target.riskClass : "unclassified",
          payload: {
            mcpToolRegistrationId: target.mcpToolRegistrationId,
            mcpServerItemId: target.mcpServerItemId,
            args: resolution.args,
          },
          // mcpInvoke has no destructive-operation resource to snapshot; this placeholder only satisfies `NOT NULL`.
          resourceSnapshot: { kind: "mcp_invoke", resourceId: mcpToolRegistrationId, sha256: null },
          reason,
          toolCallId: invokeOptions?.toolCallId ?? null,
          description: buildMcpInvokeApprovalDescription(
            typeof target.serverItem.properties.name === "string" ? target.serverItem.properties.name : null,
            target.toolName,
          ),
        });
        const userId = await getTenantUserId(client);
        if (userId) {
          await writeNotification(client, {
            userId,
            kind: "approval_pending",
            ...approvalNotificationBody(created),
            linkHref: approvalNotificationLinkHref(
              await getApprovalRequestSourceKind(client, created.agentRunId),
              created.id,
            ),
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
