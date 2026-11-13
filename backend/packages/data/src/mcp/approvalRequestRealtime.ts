import type { PoolClient } from "pg";
import { requireManagedTransaction, requireSingleRow, runAfterCommit } from "../db/pool.js";
import { notifyInvalidation, publishSempThreadInvalidation } from "../realtimeHook.js";
import {
  insertPendingApprovalRequest,
  type ApprovalRequest,
  type CreatePendingApprovalRequestInput,
} from "./approvalRequestsStore.js";

/**
 * Announces, once the transaction on `client` has committed, that `request` changed: one
 * `approvalRequest` invalidation addressed to the owner of the request (the actor user of its run),
 * and, when the run belongs to a Semp thread, the `sempThread` invalidation of that thread. A
 * rollback announces nothing. Call it in the transaction of the write that changed the request,
 * and only when that write changed a row.
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
  if (run.thread_id !== null) publishSempThreadInvalidation(client, run.tenant_id, run.thread_id);
}

/**
 * `createPendingApprovalRequest` followed by `publishApprovalRequestChange` when the call inserted
 * the row. A repeated creation for the same `(agentRunId, toolCallId)` returns the existing request
 * and announces nothing, because it wrote nothing.
 */
export async function createPendingApprovalRequestAndPublish(
  client: PoolClient,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  const { request, inserted } = await insertPendingApprovalRequest(client, input);
  if (inserted) await publishApprovalRequestChange(client, request);
  return request;
}
