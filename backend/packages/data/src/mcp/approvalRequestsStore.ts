import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";
import { assertKnownValue, assertShape } from "../dbRowValidation.js";

export type ApprovalRequestStatus = "pending" | "approved" | "rejected";

/** The only two transitions a decision can make a `pending` request into. */
export type ApprovalRequestDecision = "approved" | "rejected";

const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = ["pending", "approved", "rejected"];

/**
 * The exactly-once execution protocol's own state machine (issue #89), independent of the
 * approval decision above: `not_approved` (default) -> `queued` (set atomically alongside
 * `status: 'approved'`) -> `succeeded` (the mutation committed) or `conflict` (a terminal
 * revalidation failure — the resource changed or its authorization no longer holds). A
 * populated-upgrade row that predates this column is `legacy_terminal` and never executes.
 */
export type ApprovalRequestExecutionStatus = "not_approved" | "queued" | "succeeded" | "conflict" | "legacy_terminal";

const APPROVAL_REQUEST_EXECUTION_STATUSES: readonly ApprovalRequestExecutionStatus[] = [
  "not_approved",
  "queued",
  "succeeded",
  "conflict",
  "legacy_terminal",
];

/**
 * The persisted `{ kind, resourceId, sha256 }` shape every approval request now carries
 * (issue #89). `kind` is validated against the closed five-destructive-operation enum only by
 * `DestructiveApprovalPreflight` at the point a *new* generic-operation request is created — this
 * store-level type stays a plain string so the still-live `mcpInvoke` request kind (and a
 * populated-upgrade's `legacy_unavailable` kind) can also satisfy the column's `NOT NULL`
 * constraint without widening it into a union this module has no reason to know about.
 */
export interface ApprovalResourceSnapshot {
  kind: string;
  resourceId: string;
  sha256: string | null;
}

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
  resourceSnapshot: ApprovalResourceSnapshot;
  executionStatus: ApprovalRequestExecutionStatus;
  /** Set atomically as an execution claim (issue #131) before the deferred call is made — see 0022's migration comment. */
  executedAt: string | null;
  executionError: boolean | null;
  executionResult: unknown;
}

/** The outbound third-party-MCP-tool-invoke payload shape (issue #130) — the resolved target's identity plus the model-supplied arguments. */
export interface McpInvokeApprovalRequestPayload {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  args: Record<string, unknown>;
}

/**
 * The inbound generic-operation payload shape (issue #220, `resourceSnapshot` added by #89): the
 * operation name, its already-validated canonical input, the exact actor identity
 * `agentRunsStore`'s persisted `agent_run` row backed at dispatch time — never re-derived from
 * `agentRunId` at replay, so a mismatch between this snapshot and the run's current provenance is
 * what `owner_violation` detects at `approvalExecute` time — and the same resource snapshot
 * persisted in the row's own `resource_snapshot` column, duplicated into the payload so the
 * payload alone is a self-contained record of exactly what was approved.
 */
export interface GenericOperationApprovalRequestPayload {
  operationName: string;
  canonicalInput: unknown;
  actor: { runId: string; agentProjectItemId: string; userId: string };
  resourceSnapshot: ApprovalResourceSnapshot;
}

export type ApprovalRequestPayload = McpInvokeApprovalRequestPayload | GenericOperationApprovalRequestPayload;

export function isGenericOperationApprovalRequestPayload(
  payload: ApprovalRequestPayload,
): payload is GenericOperationApprovalRequestPayload {
  return "operationName" in payload;
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
  resource_snapshot: ApprovalResourceSnapshot;
  execution_status: string;
  executed_at: string | null;
  execution_error: boolean | null;
  execution_result_jsonb: unknown;
}

function assertResourceSnapshotShape(value: ApprovalResourceSnapshot): ApprovalResourceSnapshot {
  assertShape(
    typeof value === "object" &&
      value !== null &&
      typeof value.kind === "string" &&
      typeof value.resourceId === "string" &&
      (value.sha256 === null || typeof value.sha256 === "string"),
    "resource_snapshot",
  );
  return value;
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
    resourceSnapshot: assertResourceSnapshotShape(row.resource_snapshot),
    executionStatus: assertKnownValue(APPROVAL_REQUEST_EXECUTION_STATUSES, row.execution_status, "execution_status"),
    executedAt: row.executed_at,
    executionError: row.execution_error,
    executionResult: row.execution_result_jsonb,
  };
}

export interface CreatePendingApprovalRequestInput {
  agentRunId: string;
  toolName: string;
  riskClass: string;
  payload: ApprovalRequestPayload;
  resourceSnapshot: ApprovalResourceSnapshot;
}

/** Inserts one `pending` request. The caller is responsible for running this inside the same transaction as whatever it must be atomic with. */
export async function createPendingApprovalRequest(
  client: Queryable,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, resource_snapshot)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [
      input.agentRunId,
      input.toolName,
      input.riskClass,
      JSON.stringify(input.payload),
      JSON.stringify(input.resourceSnapshot),
    ],
  );
  return rowToApprovalRequest(requireSingleRow(rows, "approval_requests insert RETURNING"));
}

/** `forUpdate` row-locks the request for the duration of the caller's transaction — `approvalExecute`'s locked revalidate-then-mutate protocol (issue #89) needs this so a concurrent decide/replay can't observe or race a half-finished execution. */
export async function getApprovalRequest(
  client: Queryable,
  id: string,
  forUpdate = false,
): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

/**
 * The global approval queue's source list (issue #132): every still-`pending` request across
 * every project, oldest first — the same FIFO order a human triage list expects. Decided
 * requests never appear here; a caller that needs one anyway (e.g. rendering the authoritative
 * outcome of a raced decision) already holds it from the decide response, not from this list.
 */
export async function listPendingApprovalRequests(client: Queryable): Promise<ApprovalRequest[]> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY requested_at ASC`,
  );
  return rows.map(rowToApprovalRequest);
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
        SET status = $2, decided_at = now(), decided_by = $3,
            execution_status = CASE WHEN $2 = 'approved' THEN 'queued' ELSE execution_status END
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

/**
 * Records a deferred call's outcome — the audit trail's final write for the mcpInvoke path
 * (already claimed, so `executed_at` is set there) and for the generic-operation "no replay
 * handler configured" fallback (never claimed, since that path bypasses
 * `claimApprovalRequestExecution` entirely — see `approvalRequestExecution.ts`'s header comment
 * — so `executed_at` must be stamped here instead). `COALESCE` keeps the mcpInvoke path's
 * original claim timestamp rather than overwriting it. `execution_status` settles to `succeeded`
 * only when `outcome.error` is false, and to `conflict` otherwise — the same terminal-state
 * vocabulary issue #89 introduced for generic-operation requests — so a failed outcome (e.g. "no
 * generic-operation approval replay handler is configured") is never recorded as `succeeded` and
 * can never be replayed by `replayApprovedGenericOperation`'s idempotency check as a false
 * success.
 */
export async function recordApprovalRequestOutcome(
  client: Queryable,
  id: string,
  outcome: ApprovalRequestOutcome,
): Promise<void> {
  const result = await client.query(
    `UPDATE approval_requests
        SET execution_error = $2, execution_result_jsonb = $3::jsonb,
            execution_status = CASE WHEN $2 THEN 'conflict' ELSE 'succeeded' END,
            executed_at = COALESCE(executed_at, now())
      WHERE id = $1`,
    [id, outcome.error, JSON.stringify(outcome.result)],
  );
  requireAffectedRows(result, `recording approval request '${id}' outcome`);
}

/**
 * Writes the terminal `conflict` outcome on an already-locked row (issue #89's
 * `ApprovedOperationExecutor`, `replayApprovedGenericOperation` in `packages/application`), inside
 * the caller's own transaction — never throws, so the transaction that wrote it commits. The sole
 * owner of `approval_requests` writes, per the single-writer ownership model; a caller outside
 * this module must never issue its own `UPDATE approval_requests` for this transition. Also sets
 * the legacy `execution_error` column so it stays in sync with `execution_status` for any reader
 * still keyed off it — the same pairing `recordApprovalRequestOutcome` maintains for the mcpInvoke
 * path. Guards on `execution_status = 'queued'` like every other targeted UPDATE in this file
 * guards on current state — a caller bug that passes an id already in a terminal state must not
 * silently overwrite it; `requireAffectedRows` turns that into a thrown error instead.
 */
export async function terminalizeApprovalRequestAsConflict(
  client: Queryable,
  id: string,
  details: Record<string, unknown>,
): Promise<{ error: true; result: string }> {
  const executionResult = { error: { code: "version_conflict", details } };
  const result = await client.query(
    `UPDATE approval_requests
        SET execution_status = 'conflict', execution_error = true, execution_result_jsonb = $2::jsonb,
            executed_at = now()
      WHERE id = $1 AND execution_status = 'queued'`,
    [id, JSON.stringify(executionResult)],
  );
  requireAffectedRows(result, `terminalizing approval request '${id}' as conflict`);
  return { error: true, result: JSON.stringify(executionResult) };
}

/**
 * Writes the terminal `succeeded` outcome on an already-locked row, inside the caller's own
 * transaction, so the mutation `replayApprovedGenericOperation` (`packages/application`) just ran
 * and its terminal-state write land in the same commit — see that function's header comment for
 * why both must be atomic. The sole owner of `approval_requests` writes; see
 * `terminalizeApprovalRequestAsConflict` above for the same rationale, including the legacy
 * `execution_error` column and the `execution_status = 'queued'` guard — the row being
 * `FOR UPDATE`-locked already rules out a concurrent writer, but not a caller bug that invokes
 * this on an id already in a terminal state.
 */
export async function markApprovalRequestExecutionSucceeded(
  client: Queryable,
  id: string,
  result: unknown,
): Promise<{ error: false; result: string }> {
  const executionResult = { result };
  const updateResult = await client.query(
    `UPDATE approval_requests
        SET execution_status = 'succeeded', execution_error = false, execution_result_jsonb = $2::jsonb,
            executed_at = now()
      WHERE id = $1 AND execution_status = 'queued'`,
    [id, JSON.stringify(executionResult)],
  );
  requireAffectedRows(updateResult, `marking approval request '${id}' succeeded`);
  return { error: false, result: JSON.stringify(executionResult) };
}
