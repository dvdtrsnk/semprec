import type { PoolClient } from "pg";
import { enqueueJob, CORE_TASK_NAMES } from "@semprec/queue";
import { decideApprovalRequest, type ApprovalRequest, type ApprovalRequestDecision } from "./approvalRequestsStore.js";

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
 * `jobKey` is derived from the request id, so a retried enqueue (e.g. this function called twice
 * for the same already-approved id, which can't happen through `decideApprovalRequest`'s own
 * `WHERE status = 'pending'` guard, but could from a caller retrying after a network timeout)
 * collapses onto the same job instead of scheduling a second one.
 *
 * Returns `null` when the row is not `pending` (unknown id, or already decided) — the caller
 * treats a repeated decision as a deterministic no-op rather than an error.
 */
export async function decideAndEnqueueApprovalRequest(
  client: PoolClient,
  input: DecideApprovalRequestInput,
): Promise<ApprovalRequest | null> {
  const request = await decideApprovalRequest(client, input.approvalRequestId, input.decision, input.decidedByUserId);
  if (!request) return null;

  if (request.status === "approved") {
    await enqueueJob(
      client,
      CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
      { approvalRequestId: request.id },
      { jobKey: `approval-request-execute-${request.id}`, jobKeyMode: "preserve_run_at" },
    );
  }

  return request;
}
