import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

export type ApprovalRequestStatus = "pending" | "approved" | "rejected";

const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = ["pending", "approved", "rejected"];

/**
 * `approval_requests` (issue #130 baseline): one immutable, invocation-time snapshot per
 * deferred MCP tool call. `payload` is exactly what a later issue needs to execute the
 * approved call unchanged — the resolved target's identity plus the model-supplied
 * arguments — never re-derived from `agentRunId` at decision time, since the underlying
 * grant or registration may have since changed.
 *
 * This issue only creates and reads pending requests; deciding one (`status` moving to
 * `approved`/`rejected`, `decidedAt`/`decidedBy`) and executing it are out of scope here.
 */
export interface ApprovalRequest {
  id: string;
  agentRunId: string;
  toolName: string;
  riskClass: string;
  payload: ApprovalRequestPayload;
  status: ApprovalRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** The exact deferred choke-point payload: enough to re-issue the call once approved, unchanged. */
export interface ApprovalRequestPayload {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  args: Record<string, unknown>;
}

interface ApprovalRequestRow {
  id: string;
  agent_run_id: string;
  tool_name: string;
  risk_class: string;
  payload: ApprovalRequestPayload;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function rowToApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    toolName: row.tool_name,
    riskClass: row.risk_class,
    payload: row.payload,
    status: assertKnownValue(APPROVAL_REQUEST_STATUSES, row.status, "status"),
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export interface CreatePendingApprovalRequestInput {
  agentRunId: string;
  toolName: string;
  riskClass: string;
  payload: ApprovalRequestPayload;
}

/** Inserts one `pending` request. The caller is responsible for running this inside the same transaction as whatever it must be atomic with. */
export async function createPendingApprovalRequest(
  client: Queryable,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [input.agentRunId, input.toolName, input.riskClass, JSON.stringify(input.payload)],
  );
  return rowToApprovalRequest(rows[0]);
}

export async function getApprovalRequest(client: Queryable, id: string): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(`SELECT * FROM approval_requests WHERE id = $1`, [id]);
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}
