import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createPendingApprovalRequest,
  getAgentRun,
  getApprovalRequest,
  isGenericOperationApprovalRequestPayload,
  withTransaction,
  type ApprovalRequest,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import {
  GENERIC_OPERATION_BINDINGS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericApplicationPort,
  type GenericOperationName,
  type InputByOperation,
  type OutputByOperation,
} from "@semprec/shared";
import { createGenericApplicationService } from "./genericApplicationService.js";

function isGranted(operation: GenericOperationName, grantedCapabilities: ReadonlySet<CapabilityId>): boolean {
  return grantedCapabilities.has(OPERATION_METADATA[operation].requiresCapability);
}

function assertCompleteAgentIdentity(actor: AuthenticatedActor): void {
  if ((actor.runId === undefined) !== (actor.agentProjectItemId === undefined)) {
    throw new ForbiddenError(
      "An agent actor must carry both runId and agentProjectItemId together, or neither",
      undefined,
      "owner_violation",
    );
  }
}

function parseInput<K extends GenericOperationName>(operation: K, raw: unknown): InputByOperation[K] {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    input: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: InputByOperation[K] }
        | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
    };
  };
  const parsed = binding.input.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue !== undefined && firstIssue.path.length > 0 ? firstIssue.path.join(".") : undefined;
    throw new ValidationError(
      firstIssue?.message ?? "Request failed validation",
      field === undefined ? undefined : { field },
    );
  }
  return parsed.data;
}

async function invokeBinding<K extends GenericOperationName>(
  service: GenericApplicationPort,
  operation: K,
  actor: AuthenticatedActor,
  input: InputByOperation[K],
): Promise<OutputByOperation[K]> {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    invoke(
      service: GenericApplicationPort,
      actor: AuthenticatedActor,
      input: InputByOperation[K],
    ): Promise<OutputByOperation[K]>;
  };
  return binding.invoke(service, actor, input);
}

export interface GenericOperationGateway {
  /** The operations visible given `grantedCapabilities` — an ungranted one is simply absent, never present-but-forbidden. */
  listOperations(grantedCapabilities: ReadonlySet<CapabilityId>): GenericOperationName[];
  /**
   * Dispatches one operation for an agent actor (`actor.runId`/`actor.agentProjectItemId` set):
   * capability-gates, then approval-gates a destructive operation by queuing a pending approval
   * request and throwing `ApprovalRequiredError` — the AgentTool composition root (#220) catches
   * that specifically and returns a synthetic success instead of surfacing it, matching
   * `mcpInvokeTool.ts`'s existing dual-path convention; MCP surfaces it as a JSON-RPC error, same
   * as REST does for its own (never approval-gated, since a REST actor never carries
   * `agentProjectItemId`) `ChokePointError`s.
   */
  invoke<K extends GenericOperationName>(
    operation: K,
    actor: AuthenticatedActor,
    grantedCapabilities: ReadonlySet<CapabilityId>,
    raw: unknown,
  ): Promise<OutputByOperation[K]>;
}

/**
 * The one gateway both the AgentTool (`packages/agent-runtime`) and MCP (`services/semprec-api`)
 * composition roots construct over their own injected `Pool` (issue #220), sitting between
 * capability/approval and the neutral `GenericApplicationPort` (#219). REST's own
 * `dispatchGenericOperation` (services/semprec-api/src/adapter/genericBinding.ts) calls the port
 * directly without this gate — a REST human actor never carries `agentProjectItemId`, the one
 * condition this gate's approval check keys on, so this gate would only ever be a no-op there.
 */
export function createGenericOperationGateway(pool: Pool): GenericOperationGateway {
  const service = createGenericApplicationService(pool);

  return {
    listOperations(grantedCapabilities) {
      return GENERIC_OPERATION_NAMES.filter((operation) => isGranted(operation, grantedCapabilities));
    },

    async invoke(operation, actor, grantedCapabilities, raw) {
      if (!isGranted(operation, grantedCapabilities)) {
        throw new NotFoundError(`Unknown operation '${operation}'`);
      }
      assertCompleteAgentIdentity(actor);

      const input = parseInput(operation, raw);
      const metadata = OPERATION_METADATA[operation];

      if (metadata.requiresApproval && actor.runId !== undefined && actor.agentProjectItemId !== undefined) {
        const payload: GenericOperationApprovalRequestPayload = {
          operationName: operation,
          canonicalInput: input,
          actor: { runId: actor.runId, agentProjectItemId: actor.agentProjectItemId, userId: actor.userId },
        };
        const request = await withTransaction(pool, (client) =>
          createPendingApprovalRequest(client, {
            agentRunId: actor.runId!,
            toolName: operation,
            riskClass: metadata.riskClass!,
            payload,
          }),
        );
        throw new ApprovalRequiredError(`Operation '${operation}' requires human approval before it can run.`, {
          approvalRequestId: request.id,
          link: `?page=approvals&id=${request.id}`,
        });
      }

      return invokeBinding(service, operation, actor, input);
    },
  };
}

/**
 * Replays one `approved` generic-operation approval request (issue #220, the `approvalExecute`
 * counterpart to `createGenericOperationGateway`'s approval-request creation): reloads the
 * request and the persisted `agent_run` its payload was snapshotted against, rejects a mismatch
 * as `owner_violation` rather than executing against stale provenance, then dispatches the same
 * binding REST/MCP/AgentTool dispatch through — bypassing only the already-satisfied approval
 * check, never validation, capability, or authz. A composition root passes this to
 * `createCoreTaskList`'s `genericOperationApprovalReplay` parameter; `packages/data`'s worker
 * can't call it directly without an `application -> data -> application` import cycle.
 */
export async function replayApprovedGenericOperation(
  pool: Pool,
  request: ApprovalRequest & { payload: GenericOperationApprovalRequestPayload },
): Promise<{ error: boolean; result: string }> {
  try {
    const reloaded = await getApprovalRequest(pool, request.id);
    if (!reloaded || !isGenericOperationApprovalRequestPayload(reloaded.payload)) {
      throw new NotFoundError(`Approval request '${request.id}' not found`);
    }
    const { actor, operationName, canonicalInput } = reloaded.payload;
    const run = await getAgentRun(pool, reloaded.agentRunId);
    if (
      !run ||
      reloaded.agentRunId !== actor.runId ||
      run.projectItemId !== actor.agentProjectItemId ||
      run.actorUserId !== actor.userId
    ) {
      throw new ForbiddenError(
        `Approval request '${request.id}' no longer matches its run's persisted provenance`,
        undefined,
        "owner_violation",
      );
    }

    const service = createGenericApplicationService(pool);
    const operation = operationName as GenericOperationName;
    const output = await invokeBinding(service, operation, actor, canonicalInput as InputByOperation[typeof operation]);
    return { error: false, result: JSON.stringify(output) };
  } catch (err) {
    if (err instanceof ChokePointError) return { error: true, result: `${err.code}: ${err.message}` };
    return { error: true, result: err instanceof Error ? err.message : String(err) };
  }
}
