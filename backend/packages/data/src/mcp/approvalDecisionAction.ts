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
 * Whichever way a mail send request was decided, the draft's other pending requests are closed as superseded: each
 * is told to its thread as rejected, loses its notification and is announced to its owner.
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
 * The only route-facing path to `decideApprovalRequest` (which `index.ts` does not export), so an agent cannot
 * decide its own request.
 *
 * Decision and `approvalExecute` enqueue share one transaction, so approval and scheduled execution land together;
 * rejection enqueues nothing. The `jobKey` derives from the request id, so a retried enqueue collapses.
 * - `decided`: this call made the transition, resolved the notifications, announces after commit and refreshes
 *   the owner's badge; a mail send also supersedes the draft's other pending requests.
 * - `unchanged`: the caller owns the run but the request is no longer pending; nothing is announced.
 * - `null`: unknown, not owned by `decidedByUserId`, or another tenant; the caller answers all three alike.
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
  await enqueueBadgeRefresh(client, input.decidedByUserId);

  return { outcome: "decided", request };
}
