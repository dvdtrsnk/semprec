import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

export type ApprovalRequestStatus = "pending" | "approved" | "rejected";

/** The only two transitions a decision can make a `pending` request into. */
export type ApprovalRequestDecision = "approved" | "rejected";

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
  /** Set atomically as an execution claim (issue #131) before the deferred call is made — see 0022's migration comment. */
  executedAt: string | null;
  executionError: boolean | null;
  executionResult: string | null;
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
  executed_at: string | null;
  execution_error: boolean | null;
  execution_result: string | null;
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
    executedAt: row.executed_at,
    executionError: row.execution_error,
    executionResult: row.execution_result,
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

/**
 * The single atomic decision transition (issue #131): `pending` -> `approved`/`rejected`, one
 * `UPDATE ... WHERE status = 'pending'`. Returns `null` when the row doesn't exist or is no
 * longer `pending` — a caller cannot tell those two apart from this call alone (call
 * `getApprovalRequest` if it needs to), which is exactly what makes a retried decision a
 * deterministic no-op instead of a second transition: two concurrent decisions on the same row
 * race on this one `UPDATE`, and only one can ever see `rowCount > 0`.
 *
 * Deliberately **not** re-exported from this package's `index.ts` — see
 * `mcpGrantsAdminStore.ts`'s header for the same convention. Only `approvalDecisionAction.ts`'s
 * wrapper (which composes this with enqueueing the execution job in the same transaction) is
 * reachable from a route handler; an agent has no path to decide its own approval request.
 */
export async function decideApprovalRequest(
  client: Queryable,
  id: string,
  decision: ApprovalRequestDecision,
  decidedBy: string,
): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `UPDATE approval_requests
        SET status = $2, decided_at = now(), decided_by = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, decision, decidedBy],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

/**
 * Claims one `approved` request for execution: sets `executed_at` iff it is still unset. A
 * redelivered `approvalExecute` job (queue retry, or a second worker) sees `rowCount === 0` and
 * treats it as a no-op instead of invoking the deferred tool call twice — see 0022's migration
 * comment. This is a best-effort single-attempt claim, not the exactly-once transactional
 * protocol issue #89 will add; it exists so #89 can replace it without touching the decision
 * state machine above.
 */
export async function claimApprovalRequestExecution(client: Queryable, id: string): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `UPDATE approval_requests
        SET executed_at = now()
      WHERE id = $1 AND status = 'approved' AND executed_at IS NULL
      RETURNING *`,
    [id],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

export interface ApprovalRequestOutcome {
  error: boolean;
  result: string;
}

/** Records the deferred call's outcome on the already-claimed row — the audit trail's final write. */
export async function recordApprovalRequestOutcome(
  client: Queryable,
  id: string,
  outcome: ApprovalRequestOutcome,
): Promise<void> {
  await client.query(`UPDATE approval_requests SET execution_error = $2, execution_result = $3 WHERE id = $1`, [
    id,
    outcome.error,
    outcome.result,
  ]);
}
