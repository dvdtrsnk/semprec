import type { Pool } from "pg";
import type { RiskClass } from "@semprec/shared";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { approvalNotificationBody } from "../notifications/approvalNotificationBody.js";
import { approvalNotificationLinkHref } from "../notifications/approvalNotificationLink.js";
import { writeNotification } from "../notifications/notify.js";
import { buildHeartbeatToolApprovalDescription } from "../scheduler/heartbeatApprovalDescription.js";
import { buildModuleToolApprovalDescription } from "./approvalDescription.js";
import { createPendingApprovalRequestAndPublish } from "./approvalRequestRealtime.js";
import { getApprovalRequestSourceKind } from "./approvalRequestsQueue.js";
import type { ApprovalRequest } from "./approvalRequestsStore.js";

export interface CreateModuleToolApprovalRequestInput {
  agentRunId: string;
  toolName: string;
  riskClass: RiskClass;
  args: Record<string, unknown>;
  /** `null` for a tool that declares no snapshot. */
  snapshotSha256: string | null;
  /** A repeated call returns the existing request. */
  toolCallId: string | null;
}

/**
 * The request and its `approval_pending` notification share one transaction. The description is the generic
 * `approval.moduleTool`, except heartbeat write tools use their own template, which refuses an automation or project
 * the run cannot reach. Announced after commit; a repeated `(agentRunId, toolCallId)` returns the existing request
 * silently. The notification goes to the run's actor, the only user who can decide it.
 */
export async function createModuleToolApprovalRequest(
  pool: Pool,
  input: CreateModuleToolApprovalRequestInput,
): Promise<ApprovalRequest> {
  return withTransaction(pool, async (client) => {
    const description =
      (await buildHeartbeatToolApprovalDescription(client, input)) ??
      buildModuleToolApprovalDescription(input.toolName);
    const created = await createPendingApprovalRequestAndPublish(client, {
      agentRunId: input.agentRunId,
      toolName: input.toolName,
      riskClass: input.riskClass,
      payload: { moduleToolName: input.toolName, args: input.args },
      resourceSnapshot: { kind: "module_tool", resourceId: input.toolName, sha256: input.snapshotSha256 },
      toolCallId: input.toolCallId,
      description,
    });
    const { rows } = await client.query<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM agent_runs WHERE id = $1",
      [created.agentRunId],
    );
    await writeNotification(client, {
      userId: requireSingleRow(rows, "agent_runs actor lookup for a module tool approval").actor_user_id,
      kind: "approval_pending",
      ...approvalNotificationBody(created),
      linkHref: approvalNotificationLinkHref(
        await getApprovalRequestSourceKind(client, created.agentRunId),
        created.id,
      ),
      sourceTable: "approval_requests",
      sourceId: created.id,
      transitionInstance: created.id,
    });
    return created;
  });
}
