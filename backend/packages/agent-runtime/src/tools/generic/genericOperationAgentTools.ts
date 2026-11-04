import type { CollectionMetadataResolver } from "@semprec/data";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  generatePermissionManifest,
  getAgentRun,
  readItemPatchChangeMetadata,
  withTransaction,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  GENERIC_OPERATION_NAMES,
  CAPABILITY_IDS,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import type { ToolResultChange } from "../../toolEventPayload.js";

/** Shaped like a pi-agent-core `tool_result` payload — the same local approximation `heartbeatAgentTools.ts`'s `HeartbeatAgentToolResult` uses. */
export interface GenericOperationAgentToolResult {
  error: boolean;
  result: string;
  /** The approval request this call created, when it was deferred to a human. */
  approvalRequestId?: string;
  /** Per-property changes of a successful `item.patch`. */
  changes?: ToolResultChange[];
}

/** Longest string a `changes` entry stores for a `before` or `after` value. */
export const TOOL_CHANGE_VALUE_MAX_LENGTH = 200;

function boundValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > TOOL_CHANGE_VALUE_MAX_LENGTH ? value.slice(0, TOOL_CHANGE_VALUE_MAX_LENGTH) : value;
  }
  if (typeof value === "object" && value !== null) {
    const json = JSON.stringify(value);
    return json.length > TOOL_CHANGE_VALUE_MAX_LENGTH ? json.slice(0, TOOL_CHANGE_VALUE_MAX_LENGTH) : value;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds `changes` for a successful `item.patch` from the operation's own `previous` values (read
 * inside its write transaction) and the call's `properties`. A `longText` property keeps only its
 * key; a key without a reported previous value has no `before`. Missing write-time classification
 * leaves a key without values.
 */
function buildPatchChanges(output: unknown, args: unknown): ToolResultChange[] | undefined {
  if (!isRecord(output) || !isRecord(args) || !isRecord(args.properties)) return undefined;
  const patched = args.properties;
  const previous = isRecord(output.previous) ? output.previous : {};
  const keys = Object.keys(patched);
  if (keys.length === 0) return undefined;
  const eligibility = readItemPatchChangeMetadata(output);
  return keys.map((key): ToolResultChange => {
    if (eligibility?.get(key) !== true) return { key };
    return {
      key,
      ...(Object.hasOwn(previous, key) ? { before: boundValue(previous[key]) } : {}),
      after: boundValue(patched[key]),
    };
  });
}

export type GenericOperationAgentTool = (
  currentRunId: string,
  args: unknown,
  /** `reason`: the agent's reason for an approval-gated call, removed from `args` by the caller; reaches the approval request only. `toolCallId`: the model-runtime tool call, stored on a created approval request. */
  options?: { reason?: string; toolCallId?: string },
) => Promise<GenericOperationAgentToolResult>;

interface AgentContext {
  actor: AuthenticatedActor;
  grantedCapabilities: Set<CapabilityId>;
}

/**
 * Resolves the calling agent's actor identity and granted capabilities strictly from the
 * persisted `agent_run` row for `currentRunId` — never from tool arguments, mirroring
 * `heartbeatAgentTools.ts`'s `resolveCallingProjectItemId` discipline. A run that doesn't exist,
 * or carries no project context, resolves to `null`; every caller below turns that into
 * `owner_violation` before any capability or approval check runs.
 */
async function resolveAgentContext(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  currentRunId: string,
): Promise<AgentContext | null> {
  const run = await getAgentRun(pool, currentRunId);
  const projectItemId = run?.projectItemId;
  if (!run || !projectItemId) return null;

  const manifest = await withTransaction(pool, (client) =>
    generatePermissionManifest(client, projectItemId, { moduleRegistry }),
  );

  return {
    actor: { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId },
    grantedCapabilities: new Set(
      CAPABILITY_IDS.filter((capability) => manifest.grantedCapabilities.includes(capability)),
    ),
  };
}

/**
 * Mirrors `mcpInvokeTool.ts`'s `pendingApprovalResult`: the *tool call itself* is reported as
 * successful (`error: false`) so the agent turn and run complete normally, even though the
 * underlying operation was deferred to a human decision instead of executed.
 */
function pendingApprovalResult(
  err: ApprovalRequiredError,
  operation: GenericOperationName,
): GenericOperationAgentToolResult {
  return {
    error: false,
    result: `Operation '${operation}' requires human approval before it can run. Approval request ${err.details.approvalRequestId} has been created and is awaiting a decision; this call has not been executed.`,
    approvalRequestId: err.details.approvalRequestId,
  };
}

function toolResultFromError(err: unknown, operation: GenericOperationName): GenericOperationAgentToolResult {
  if (err instanceof ApprovalRequiredError) return pendingApprovalResult(err, operation);
  if (err instanceof ChokePointError) return { error: true, result: `${err.code}: ${err.message}` };
  return { error: true, result: err instanceof Error ? err.message : String(err) };
}

function createTool(
  gateway: GenericOperationGateway,
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  operation: GenericOperationName,
): GenericOperationAgentTool {
  return async function invoke(currentRunId, args, options) {
    try {
      const context = await resolveAgentContext(pool, moduleRegistry, currentRunId);
      if (!context) {
        return { error: true, result: "owner_violation: no persisted run context for this agent tool call" };
      }
      const output = await gateway.invoke(operation, context.actor, context.grantedCapabilities, args ?? {}, options);
      const changes = operation === "item.patch" ? buildPatchChanges(output, args) : undefined;
      return { error: false, result: JSON.stringify(output), ...(changes ? { changes } : {}) };
    } catch (err) {
      return toolResultFromError(err, operation);
    }
  };
}

/**
 * One AgentTool per generic operation (issue #220), named verbatim after the operation
 * (`GENERIC_OPERATION_NAMES`) — MCP's own composition root (`services/semprec-api/src/mcp`)
 * prefixes the same names `semprec.` for its own catalog, both dispatching through
 * `createGenericOperationGateway(pool, resolver)` so there is exactly one path into the 30-operation
 * catalog's business logic for this process, alongside REST's own separate
 * `dispatchGenericOperation` (#219) over the same neutral `GenericApplicationPort` (#219's ADR:
 * "one instance per injected Pool" — this composition root's own instance, not REST's).
 *
 * `services/semprec-agents` (issue #91, not yet built) is the eventual composition root that
 * decides, per run, which of these to even expose to a model — `listGrantedGenericOperationAgentTools`
 * below is that discovery counterpart. Every tool here re-checks the grant on every call
 * regardless of whether the caller filtered its catalog first, so a stale or wrongly-filtered
 * catalog can never itself become a bypass.
 */
export function createGenericOperationAgentTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  resolver: CollectionMetadataResolver,
): Record<GenericOperationName, GenericOperationAgentTool> {
  const gateway = createGenericOperationGateway(pool, resolver);
  const tools = {} as Record<GenericOperationName, GenericOperationAgentTool>;
  for (const operation of GENERIC_OPERATION_NAMES) {
    tools[operation] = createTool(gateway, pool, moduleRegistry, operation);
  }
  return tools;
}

/**
 * The operation names visible to `currentRunId` right now: absent, not present-but-forbidden,
 * for an operation whose capability isn't granted to the run's project. Resolves the same
 * persisted-run actor context `createGenericOperationAgentTools`'s tools re-check on every call.
 */
export async function listGrantedGenericOperationAgentTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  currentRunId: string,
  resolver: CollectionMetadataResolver,
): Promise<GenericOperationName[]> {
  const context = await resolveAgentContext(pool, moduleRegistry, currentRunId);
  if (!context) return [];
  return createGenericOperationGateway(pool, resolver).listOperations(context.grantedCapabilities);
}
