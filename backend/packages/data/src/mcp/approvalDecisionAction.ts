import type { PoolClient } from "pg";
import { enqueueJob, CORE_TASK_NAMES } from "@semprec/queue";
import {
  decideApprovalRequest,
  getApprovalRequestForOwner,
  type ApprovalRequest,
  type ApprovalRequestDecision,
} from "./approvalRequestsStore.js";

export interface DecideAndEnqueueResult {
  outcome: "decided" | "unchanged";
  request: ApprovalRequest;
}

export interface DecideApprovalRequestInput {
  approvalRequestId: string;
  decision: ApprovalRequestDecision;
  decidedByUserId: string;
}

/**
 * The only path from a human-facing route handler to `approvalRequestsStore.ts`'s
 * `decideApprovalRequest` — that function is not re-exported from this package's `index.ts`,
 * mirroring `mcpGrantsAdminStore.ts`'s convention: an agent has no write path to decide its own
 * approval request, only an authenticated user-facing handler does.
 *
 * Composes the atomic decision with enqueueing the reserved `approvalExecute` job in the same
 * transaction, so "this request is approved" and "execution will happen" land together —
 * rejection enqueues nothing, per the issue's "rejected requests never execute" criterion. The
 * `jobKey` is derived from the request id, so a retried enqueue collapses onto the same job
 * instead of scheduling a second one.
 *
 * Decide and re-read run in the same transaction, so the outcome cannot race another decision:
 * - `decided`: this call made the transition (and enqueued, on approval);
 * - `unchanged`: the request is already decided by its owner, so the update matched nothing and
 *   the current state is returned;
 * - `null`: the id is unknown, not owned by `decidedByUserId` (issue #1028), or in another tenant.
 *   The caller answers all three identically.
 */
export async function decideAndEnqueueApprovalRequest(
  client: PoolClient,
  input: DecideApprovalRequestInput,
): Promise<DecideAndEnqueueResult | null> {
  const request = await decideApprovalRequest(client, input.approvalRequestId, input.decision, input.decidedByUserId);
  if (!request) {
    const current = await getApprovalRequestForOwner(client, input.approvalRequestId, input.decidedByUserId);
    return current ? { outcome: "unchanged", request: current } : null;
  }

  if (request.status === "approved") {
    await enqueueJob(
      client,
      CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
      { approvalRequestId: request.id },
      { jobKey: `approval-request-execute-${request.id}`, jobKeyMode: "preserve_run_at" },
    );
  }

  return { outcome: "decided", request };
}
