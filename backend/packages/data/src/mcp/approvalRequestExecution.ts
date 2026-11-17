import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createLogger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { executeClaimedMailSendApproval } from "../mail/mailSendApprovalExecution.js";
import type { MailSendAdapterFactory } from "../mail/send.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  claimApprovalRequestExecution,
  getApprovalRequest,
  isGenericOperationApprovalRequestPayload,
  isMailSendApprovalRequestPayload,
  isModuleToolApprovalRequestPayload,
  recordApprovalRequestOutcome,
  settleStaleApprovalRequestClaim,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type GenericOperationApprovalRequestPayload,
} from "./approvalRequestsStore.js";
import { resolveGrantedMcpTool } from "./mcpToolInvocation.js";
import { executeMcpInvocation } from "./mcpToolExecution.js";
import { postApprovalOutcomeMessage } from "./approvalOutcomeMessage.js";
import { publishApprovalRequestChange } from "./approvalRequestRealtime.js";
import { executeClaimedModuleToolApproval } from "./moduleToolApprovalExecution.js";

const logger = createLogger("mcp");

/**
 * Well above the 60 s `tools/call` timeout plus the connect timeout, so an older claim can only belong to a
 * delivery that died before recording an outcome.
 */
const MCP_APPROVAL_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Implemented in `packages/application`; a composition root injects it to avoid an
 * `application -> data -> application` cycle. Rejects a provenance mismatch as `owner_violation`, then runs the
 * same operation binding as every other dispatch, skipping only the already-satisfied approval check.
 */
export type GenericOperationApprovalReplay = (
  pool: Pool,
  request: ApprovalRequest & { payload: GenericOperationApprovalRequestPayload },
) => Promise<ApprovalRequestOutcome>;

export interface HandleApprovalRequestExecuteInput {
  approvalRequestId: string;
}

/**
 * Dispatches by payload kind *before* claiming or locking anything.
 *
 * Generic operation: handed straight to `genericOperationApprovalReplay`, which locks the row and writes the
 * terminal state in its own transaction. Claiming or recording here would race that locked read.
 *
 * mcpInvoke, moduleTool and mail send share the claim protocol. A `null` claim is ambiguous, so
 * `settleStaleApprovalRequestClaim` resolves it: `"settled"` warns and returns, `"in_flight"` throws so the
 * worker's backoff redelivers once the claim can go stale, `"not_claimed"` returns silently. The claim id is the
 * idempotency key, and the outcome write is `queued`-guarded, so a concurrent stale settle wins and the late
 * outcome is discarded (logged).
 *
 * The snapshot fixes *what* is called, never *whether* it may still be: an approval can come hours later, so the
 * grant, registration and server are re-checked after the claim and before connecting. Any mismatch is recorded as
 * `conflict` with no connection opened. Without `moduleRegistry` or `mailSendAdapters` the respective request ends
 * in an error outcome and nothing runs.
 */
export async function handleApprovalRequestExecuteTask(
  pool: Pool,
  input: HandleApprovalRequestExecuteInput,
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
  moduleRegistry?: ModuleRegistry,
  mailSendAdapters?: MailSendAdapterFactory,
): Promise<void> {
  const request = await withTransaction(pool, (client) => getApprovalRequest(client, input.approvalRequestId));
  if (!request) return;

  if (isGenericOperationApprovalRequestPayload(request.payload)) {
    const genericPayload = request.payload;
    if (genericOperationApprovalReplay) {
      await genericOperationApprovalReplay(pool, { ...request, payload: genericPayload });
      return;
    }
    // Without a replay handler, fail the request rather than leave it `queued` forever.
    const recorded = await withTransaction(pool, async (client) => {
      const changed = await recordApprovalRequestOutcome(client, request.id, {
        error: true,
        result: "No generic-operation approval replay handler is configured for this worker.",
      });
      if (changed) {
        await postApprovalOutcomeMessage(client, request, "conflict");
        await publishApprovalRequestChange(client, request);
      }
      return changed;
    });
    if (!recorded) {
      logger.warn(
        { approvalRequestId: request.id },
        "MCP approval outcome discarded: the request was already settled by another delivery",
      );
    }
    return;
  }

  const claimed: ApprovalRequest | null = await withTransaction(pool, (client) =>
    claimApprovalRequestExecution(client, input.approvalRequestId),
  );
  if (!claimed) {
    const verdict = await withTransaction(pool, async (client) => {
      const settled = await settleStaleApprovalRequestClaim(
        client,
        input.approvalRequestId,
        MCP_APPROVAL_CLAIM_STALE_AFTER_MS,
      );
      if (settled === "settled") {
        await postApprovalOutcomeMessage(client, request, "conflict");
        await publishApprovalRequestChange(client, request);
      }
      return settled;
    });
    if (verdict === "settled") {
      logger.warn(
        { approvalRequestId: input.approvalRequestId },
        "settled a stale MCP approval execution claim as conflict",
      );
      return;
    }
    if (verdict === "in_flight") {
      throw new Error(`approval request ${input.approvalRequestId} execution claim is still in flight; retrying later`);
    }
    return;
  }
  if (isModuleToolApprovalRequestPayload(claimed.payload)) {
    await executeClaimedModuleToolApproval(pool, moduleRegistry, claimed, claimed.payload);
    return;
  }
  if (isMailSendApprovalRequestPayload(claimed.payload)) {
    await executeClaimedMailSendApproval(pool, mailSendAdapters, claimed, claimed.payload);
    return;
  }
  // Unreachable (the kind is fixed at creation and handled above), but `claimed` is a separate read, so this check
  // is what narrows its payload without an unchecked `as`.
  if (isGenericOperationApprovalRequestPayload(claimed.payload)) return;

  const payload = claimed.payload;
  const target = await withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, claimed.agentRunId);
    if (!run || !run.projectItemId) return null;
    return resolveGrantedMcpTool(client, run.projectItemId, payload.mcpToolRegistrationId);
  });

  const noLongerAvailableOutcome: ApprovalRequestOutcome = {
    error: true,
    outcomeKind: "toolUnavailable",
    failure: { failureKind: "unavailable", mcpServerItemId: payload.mcpServerItemId },
    result:
      "This MCP tool is no longer available to the requesting project: its grant was revoked, or its registration or server is inactive.",
  };
  let outcome: ApprovalRequestOutcome = noLongerAvailableOutcome;
  if (target && target.mcpServerItemId === payload.mcpServerItemId && target.toolName === claimed.toolName) {
    const invoked = await executeMcpInvocation(
      pool,
      { serverItem: target.serverItem, toolName: claimed.toolName },
      payload.args,
      { idempotencyKey: claimed.id },
    );
    outcome = invoked.error ? { ...invoked, outcomeKind: "callFailed" } : invoked;
  }

  const recorded = await withTransaction(pool, async (client) => {
    const changed = await recordApprovalRequestOutcome(client, claimed.id, outcome);
    if (changed) {
      await postApprovalOutcomeMessage(client, claimed, outcome.error ? "conflict" : "executed");
      await publishApprovalRequestChange(client, claimed);
    }
    return changed;
  });
  if (!recorded) {
    logger.warn(
      { approvalRequestId: claimed.id },
      "MCP approval outcome discarded: the request was already settled by another delivery",
    );
  }
}
