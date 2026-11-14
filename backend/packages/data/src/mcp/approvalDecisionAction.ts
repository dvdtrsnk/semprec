import type { PoolClient } from "pg";
import { enqueueJob, CORE_TASK_NAMES } from "@semprec/queue";
import {
  decideApprovalRequest,
  getApprovalRequestForOwner,
  isMailSendApprovalRequestPayload,
  supersedePendingMailSendApprovalRequests,
  type ApprovalRequest,
  type ApprovalRequestDecision,
} from "./approvalRequestsStore.js";
import { resolveNotificationsBySource } from "../notifications/notificationsStore.js";
import { enqueueBadgeRefresh } from "../push/badgeRefreshEnqueue.js";
import { postApprovalOutcomeMessage } from "./approvalOutcomeMessage.js";
import { publishApprovalRequestChange } from "./approvalRequestRealtime.js";

export interface DecideAndEnqueueResult {
  outcome: "decided" | "unchanged";
  request: ApprovalRequest;
}

/**
 * A decided mail send request closes the other pending requests of its draft as superseded (issue gh-1913,
 * `supersedePendingMailSendApprovalRequests`), whichever way it was decided: each one is told to its thread as
 * rejected, loses its notification and is announced to its owner. Any other kind of request closes nothing.
 */
async function closeSupersededMailSendRequests(client: PoolClient, decided: ApprovalRequest): Promise<void> {
  if (!isMailSendApprovalRequestPayload(decided.payload)) return;
  for (const { request, ownerUserId } of await supersedePendingMailSendApprovalRequests(
    client,
    decided.payload.draftId,
    decided.id,
  )) {
    await postApprovalOutcomeMessage(client, request, "rejected");
    await resolveNotificationsBySource(client, { sourceTable: "approval_requests", sourceId: request.id });
    await publishApprovalRequestChange(client, request);
    await enqueueBadgeRefresh(client, ownerUserId);
  }
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
 * - `decided`: this call made the transition (and enqueued, on approval), and resolved the
 *   request's notifications in the same transaction, and announced the change to its owner through
 *   `publishApprovalRequestChange` once the transaction commits, and enqueued the debounced badge refresh of
 *   the owner (issue #1891); a decided mail send request also closes the other pending requests of its draft as
 *   superseded (issue gh-1913);
 * - `unchanged`: the caller owns the request's run but it is no longer pending — whoever recorded
 *   that decision (the owner, or a system path such as a migration that left `decided_by` NULL) —
 *   so the update matched nothing, the current state is returned and nothing is announced;
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
  if (request.status === "rejected") await postApprovalOutcomeMessage(client, request, "rejected");
  await closeSupersededMailSendRequests(client, request);

  await resolveNotificationsBySource(client, { sourceTable: "approval_requests", sourceId: request.id });
  await publishApprovalRequestChange(client, request);
  // The decided request leaves the pending count, so the badge of its owner changes (issue #1891).
  await enqueueBadgeRefresh(client, input.decidedByUserId);

  return { outcome: "decided", request };
}
