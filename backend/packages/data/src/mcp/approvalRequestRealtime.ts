import type { PoolClient } from "pg";
import { publishAgentRunInvalidation } from "../agentRuns/agentRunInvalidation.js";
import { requireManagedTransaction, requireSingleRow, runAfterCommit } from "../db/pool.js";
import { publishBadgeCountsInvalidation } from "../notifications/notificationInvalidation.js";
import { notifyInvalidation, publishSempThreadInvalidation } from "../realtimeHook.js";
import {
  insertPendingApprovalRequest,
  type ApprovalRequest,
  type CreatePendingApprovalRequestInput,
} from "./approvalRequestsStore.js";

/**
 * After commit (nothing on rollback): `approvalRequest` and `badgeCounts` to the run's actor, `agentRuns` for the
 * run (its display status depends on pending approvals), and `sempThread` when the run has a thread. Call only when
 * the write changed a row.
 */
export async function publishApprovalRequestChange(
  client: PoolClient,
  request: Pick<ApprovalRequest, "id" | "agentRunId">,
): Promise<void> {
  requireManagedTransaction(client);
  const { rows } = await client.query<{ actor_user_id: string; thread_id: string | null; tenant_id: string }>(
    "SELECT actor_user_id, thread_id, tenant_id FROM agent_runs WHERE id = $1",
    [request.agentRunId],
  );
  const run = requireSingleRow(rows, "agent_runs owner lookup for an approval request change");
  runAfterCommit(client, () =>
    notifyInvalidation({ scope: "approvalRequest", approvalRequestId: request.id, userId: run.actor_user_id }),
  );
  publishBadgeCountsInvalidation(client, run.actor_user_id);
  await publishAgentRunInvalidation(client, request.agentRunId);
  if (run.thread_id !== null) publishSempThreadInvalidation(client, run.tenant_id, run.thread_id);
}

/** A repeated `(agentRunId, toolCallId)` wrote nothing, so it announces nothing. */
export async function createPendingApprovalRequestAndPublish(
  client: PoolClient,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  const { request, inserted } = await insertPendingApprovalRequest(client, input);
  if (inserted) await publishApprovalRequestChange(client, request);
  return request;
}
