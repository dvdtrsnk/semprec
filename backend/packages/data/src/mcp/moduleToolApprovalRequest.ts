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
  /** The tool's manifest name. */
  toolName: string;
  riskClass: RiskClass;
  /** The arguments the tool's schema accepted. */
  args: Record<string, unknown>;
  /** The snapshot hash read at request time (`ResolvedModuleAgentTool.snapshotOf`); `null` for a tool that declares no snapshot. */
  snapshotSha256: string | null;
  /** The model-runtime tool call that produced the request; a repeated call returns the existing request. */
  toolCallId: string | null;
}

/**
 * Creates the `pending` approval request of a deferred module agent tool call (issue #1791) and,
 * in the same transaction, its `approval_pending` notification linked by source (issue #1787), so a
 * rollback drops both. The request records the localisable description (issue #1683), the tool call
 * (issue #1618) and the snapshot hash, and raises the requesting run's thread in the activity order
 * (issue #1728, `insertPendingApprovalRequest`). The description is the generic `approval.moduleTool`, or
 * for the heartbeat write tools their own template (issue #1846, `buildHeartbeatToolApprovalDescription`),
 * which refuses an automation or a project the run cannot reach. The new request is announced after the commit
 * (`createPendingApprovalRequestAndPublish`); a repeated `(agentRunId, toolCallId)` returns the
 * existing request and announces nothing. The notification goes to the actor of the requesting run,
 * the only user who can decide the request (`decideApprovalRequest`).
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
