import type { Pool } from "pg";
import { createLogger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  claimApprovalRequestExecution,
  getApprovalRequest,
  isGenericOperationApprovalRequestPayload,
  recordApprovalRequestOutcome,
  settleStaleApprovalRequestClaim,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type GenericOperationApprovalRequestPayload,
} from "./approvalRequestsStore.js";
import { resolveGrantedMcpTool } from "./mcpToolInvocation.js";
import { executeMcpInvocation } from "./mcpToolExecution.js";

const logger = createLogger("mcp");

/**
 * Comfortably above the MCP SDK's 60 s `tools/call` timeout (`mcpToolExecution.ts`'s
 * `MCP_TOOL_CALL_TIMEOUT_MS`) plus `connectMcpServer`'s own connect timeout, so a claim older
 * than this can only belong to a delivery that died before it could record an outcome — never one
 * still genuinely in flight.
 */
const MCP_APPROVAL_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Replays one approved generic-operation request (issue #220): reloads the request and the
 * persisted `agent_run` provenance it was snapshotted from, rejects a mismatch as
 * `owner_violation`, then invokes the same `GENERIC_OPERATION_BINDINGS` entry REST/MCP/AgentTool
 * dispatch through, bypassing only the already-satisfied approval check. Lives in
 * `packages/application` (needs `createGenericApplicationService`), so `packages/data`'s worker
 * can't call it directly without an `application -> data -> application` cycle — a composition
 * root injects its own instance here the same way it already injects `mailSyncAdapters`/
 * `pushSenders` into `createCoreTaskList`.
 */
export type GenericOperationApprovalReplay = (
  pool: Pool,
  request: ApprovalRequest & { payload: GenericOperationApprovalRequestPayload },
) => Promise<ApprovalRequestOutcome>;

export interface HandleApprovalRequestExecuteInput {
  approvalRequestId: string;
}

/**
 * The `approvalExecute` job's handler (issue #131, restructured for #89's exactly-once
 * protocol): dispatches by the request's payload kind *before* claiming or locking anything,
 * since the two kinds now settle their terminal state completely differently.
 *
 * A generic-operation payload (the five destructive ops, #89) is handed straight to
 * `genericOperationApprovalReplay`: that function opens its own single transaction, row-locks the
 * request itself, and — whether it succeeds, conflicts, or finds the row already terminal —
 * writes `execution_status`/`execution_result`/`executed_at` inside that same transaction. This
 * handler does nothing further for that kind; calling `claimApprovalRequestExecution` or
 * `recordApprovalRequestOutcome` first would race the executor's own locked read and double-write
 * the terminal columns.
 *
 * An mcpInvoke payload follows issue #693's exactly-once protocol. `claimApprovalRequestExecution`
 * is the atomic `UPDATE ... WHERE executed_at IS NULL AND execution_status = 'queued'`: a request
 * that is not `approved`/`queued`, or was already claimed by a previous delivery, sees `claimed
 * === null`. That is ambiguous on its own — it could mean "rejected/unknown", "a delivery is
 * still running", or "a delivery died mid-flight and never recorded an outcome" — so a null claim
 * falls through to `settleStaleApprovalRequestClaim`, which tells those apart by how long the
 * claim has been held: `"settled"` (it just wrote `conflict` for a claim older than
 * `MCP_APPROVAL_CLAIM_STALE_AFTER_MS`) logs a warning and returns; `"in_flight"` (a claim younger
 * than that) throws a retriable error so graphile-worker's default backoff redelivers the job
 * later, once the claim has had time to go stale if the original delivery really did die;
 * `"not_claimed"` (rejected, unknown, or already terminal) returns silently, same as today. Once
 * claimed, `executeMcpInvocation` is called with the claim id as its idempotency key, and
 * `recordApprovalRequestOutcome` records the result — guarded on `execution_status = 'queued'`, so
 * if `settleStaleApprovalRequestClaim` already terminalized this same row from a concurrent stale
 * sweep, the outcome write finds it no longer `queued` and is discarded (logged, not thrown).
 *
 * The approval snapshot (`payload`) fixes *what* is called — args, tool, server — never *whether*
 * it may still be called: that is re-derived from current state at execution time (issue #694),
 * after the claim and before any connection is opened, via the same three-way check
 * `resolveGrantedMcpTool` performs at request time (grant still `granted`, registration still
 * `active`, server item still `active`) — re-run here because a human can approve hours after the
 * request, long enough for any of the three to have changed. A missing run, a run with no
 * `projectItemId`, no resolved target, or a resolved target whose server or tool no longer matches
 * the snapshotted payload are all treated identically: recorded as a `conflict` outcome, no
 * connection opened.
 */
export async function handleApprovalRequestExecuteTask(
  pool: Pool,
  input: HandleApprovalRequestExecuteInput,
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
): Promise<void> {
  const request = await withTransaction(pool, (client) => getApprovalRequest(client, input.approvalRequestId));
  if (!request) return;

  if (isGenericOperationApprovalRequestPayload(request.payload)) {
    const genericPayload = request.payload;
    if (genericOperationApprovalReplay) {
      await genericOperationApprovalReplay(pool, { ...request, payload: genericPayload });
      return;
    }
    // No replay handler configured: fail the request instead of leaving it `queued` forever with no way to progress.
    const recorded = await withTransaction(pool, (client) =>
      recordApprovalRequestOutcome(client, request.id, {
        error: true,
        result: "No generic-operation approval replay handler is configured for this worker.",
      }),
    );
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
    const verdict = await withTransaction(pool, (client) =>
      settleStaleApprovalRequestClaim(client, input.approvalRequestId, MCP_APPROVAL_CLAIM_STALE_AFTER_MS),
    );
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
  // `isGenericOperationApprovalRequestPayload(claimed.payload)` can never be true here — the
  // early return above already handles every generic-operation payload, and a payload's kind is
  // fixed at row-creation time, so `claimed` (re-read by id from `claimApprovalRequestExecution`)
  // carries the same kind `request` did. The check still has to run: `claimed` is a distinct read
  // from `request`, so TypeScript can't carry that invariant across them, and this is what
  // narrows `claimed.payload` to `McpInvokeApprovalRequestPayload` below without an unchecked `as`.
  if (isGenericOperationApprovalRequestPayload(claimed.payload)) return;

  const payload = claimed.payload;
  const target = await withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, claimed.agentRunId);
    if (!run || !run.projectItemId) return null;
    return resolveGrantedMcpTool(client, run.projectItemId, payload.mcpToolRegistrationId);
  });

  const noLongerAvailableOutcome: ApprovalRequestOutcome = {
    error: true,
    result:
      "This MCP tool is no longer available to the requesting project: its grant was revoked, or its registration or server is inactive.",
  };
  const outcome: ApprovalRequestOutcome =
    target && target.mcpServerItemId === payload.mcpServerItemId && target.toolName === claimed.toolName
      ? await executeMcpInvocation(pool, { serverItem: target.serverItem, toolName: claimed.toolName }, payload.args, {
          idempotencyKey: claimed.id,
        })
      : noLongerAvailableOutcome;

  const recorded = await withTransaction(pool, (client) => recordApprovalRequestOutcome(client, claimed.id, outcome));
  if (!recorded) {
    logger.warn(
      { approvalRequestId: claimed.id },
      "MCP approval outcome discarded: the request was already settled by another delivery",
    );
  }
}
