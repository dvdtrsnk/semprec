import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";
import { RISK_CLASSES, type RiskClass } from "@semprec/shared";
import { AGENT_RUN_ROOT_MAX_HOPS } from "../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { assertKnownValue, assertShape } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { ApprovalOutcomeKind } from "./approvalConflictReason.js";
import { isMcpItemId, parseMcpInvokeFailure, type McpInvokeFailure } from "./mcpFailure.js";

/** Longest agent-supplied reason, in characters; mirrored by the `approval_requests_reason_length_check` constraint. */
export const APPROVAL_REQUEST_REASON_MAX_LENGTH = 500;

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
 * The localisable description snapshotted on a request (issue #1683): a template key plus
 * parameters, never rendered text. The template contract is documented next to the builders in
 * `approvalDescription.ts`.
 */
export interface ApprovalDescription {
  key: string;
  params: Record<string, string | number | null>;
  /** Links the action would end; filled by the value-link work, omitted until then. */
  endsInheritance?: Array<{ itemId: string; propertyKey: string; sourceName: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInheritanceEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.propertyKey === "string" &&
    typeof value.sourceName === "string"
  );
}

export function assertDescriptionShape(value: unknown): ApprovalDescription | null {
  if (value === null) return null;
  assertShape(
    isRecord(value) &&
      typeof value.key === "string" &&
      isRecord(value.params) &&
      Object.values(value.params).every((v) => v === null || typeof v === "string" || typeof v === "number") &&
      (value.endsInheritance === undefined ||
        (Array.isArray(value.endsInheritance) && value.endsInheritance.every(isInheritanceEntry))),
    "description",
  );
  return value as unknown as ApprovalDescription;
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
  riskClass: RiskClass;
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
  /** The agent's own explanation of why it asked, as plain text; `null` when it gave none. */
  reason: string | null;
  /** The model-runtime tool call that created the request; `null` for older requests and paths without one. */
  toolCallId: string | null;
  /** What the request asks, as a template key and parameters snapshotted at creation; `null` for requests created before issue #1683. */
  description: ApprovalDescription | null;
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
  reason: string | null;
  tool_call_id: string | null;
  description: unknown;
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

function assertNullableString(value: unknown, column: string): string | null {
  assertShape(value === null || typeof value === "string", column);
  return value as string | null;
}

function classifyOutcomePayload(value: unknown): "generic" | "mcp" {
  if (!isRecord(value)) throw new Error("Invalid approval outcome payload");
  if ("operationName" in value) {
    if (typeof value.operationName !== "string" || value.operationName.length === 0) {
      throw new Error("Invalid approval outcome payload");
    }
    return "generic";
  }
  if (!isMcpItemId(value.mcpToolRegistrationId) || !isMcpItemId(value.mcpServerItemId) || !isRecord(value.args)) {
    throw new Error("Invalid approval outcome payload");
  }
  return "mcp";
}

function rowToApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  if (
    isRecord(row.execution_result_jsonb) &&
    "failure" in row.execution_result_jsonb &&
    classifyOutcomePayload(row.payload) === "mcp"
  ) {
    parseMcpInvokeFailure(row.execution_result_jsonb.failure);
    if (row.execution_error !== true || typeof row.execution_result_jsonb.text !== "string") {
      throw new Error("Invalid MCP failure metadata");
    }
  }
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    toolName: row.tool_name,
    riskClass: assertKnownValue(RISK_CLASSES, row.risk_class, "risk_class"),
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
    reason: row.reason,
    toolCallId: assertNullableString(row.tool_call_id, "tool_call_id"),
    description: assertDescriptionShape(row.description),
  };
}

export interface CreatePendingApprovalRequestInput {
  agentRunId: string;
  toolName: string;
  riskClass: RiskClass;
  payload: ApprovalRequestPayload;
  resourceSnapshot: ApprovalResourceSnapshot;
  /** Optional agent-supplied reason (at most `APPROVAL_REQUEST_REASON_MAX_LENGTH` characters); stored as `NULL` when absent. */
  reason?: string | null;
  /** The model-runtime tool call that produced the request; stored as `NULL` when absent. */
  toolCallId?: string | null;
  /** The localisable description, computed by the caller in the same transaction; stored as `NULL` when absent. */
  description?: ApprovalDescription | null;
}

/**
 * Inserts one `pending` request. The caller is responsible for running this inside the same transaction as whatever it must be atomic with.
 * A repeated creation for the same `(agentRunId, toolCallId)` returns the existing request instead of inserting a second row.
 */
export async function createPendingApprovalRequest(
  client: Queryable,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  const toolCallId = input.toolCallId ?? null;
  const { rows } = await client.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, resource_snapshot, reason, tool_call_id, description)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, agent_run_id, tool_call_id) WHERE tool_call_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.agentRunId,
      input.toolName,
      input.riskClass,
      JSON.stringify(input.payload),
      JSON.stringify(input.resourceSnapshot),
      input.reason ?? null,
      toolCallId,
      input.description ? JSON.stringify(input.description) : null,
    ],
  );
  if (rows.length === 0 && toolCallId !== null) {
    const existing = await client.query<ApprovalRequestRow>(
      `SELECT * FROM approval_requests WHERE agent_run_id = $1 AND tool_call_id = $2`,
      [input.agentRunId, toolCallId],
    );
    return rowToApprovalRequest(requireSingleRow(existing.rows, "approval_requests tool call lookup"));
  }
  const created = rowToApprovalRequest(requireSingleRow(rows, "approval_requests insert RETURNING"));
  // Raise the requesting run's thread to the top of the activity ordering (issue #1728). Runs in the
  // caller's transaction, so a rollback drops it with the request; GREATEST never lowers a newer
  // activity committed after this transaction started (`now()` is the transaction start time). A
  // run without a thread matches no row. A replayed tool call (conflict above) is not new activity.
  await client.query(
    `UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now())
      WHERE id = (SELECT thread_id FROM agent_runs WHERE id = $1)`,
    [input.agentRunId],
  );
  return created;
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
 * The approval queue's source list for one owner (issue #132, owner-scoped by issue #1028): every
 * still-`pending` request whose run is owned by `ownerUserId`, oldest first — the same FIFO order a
 * human triage list expects. Decided requests never appear here; a caller that needs one anyway
 * (e.g. rendering the authoritative outcome of a raced decision) already holds it from the decide
 * response, not from this list.
 */
export async function listPendingApprovalRequests(client: Queryable, ownerUserId: string): Promise<ApprovalRequest[]> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `SELECT ar.* FROM approval_requests ar
       JOIN agent_runs r ON r.id = ar.agent_run_id
      WHERE ar.status = 'pending' AND r.actor_user_id = $1
      ORDER BY ar.requested_at ASC`,
    [ownerUserId],
  );
  return rows.map(rowToApprovalRequest);
}

/** The kinds of source an approval request can have (issue #1766). */
export const APPROVAL_REQUEST_SOURCE_KINDS = ["chat", "tick", "mcp"] as const;
export type ApprovalRequestSourceKind = (typeof APPROVAL_REQUEST_SOURCE_KINDS)[number];

/** Where a page of `listApprovalRequestsPage` continues: the last row's ordering instant with microseconds, and its id. */
export interface ApprovalRequestListCursor {
  at: string;
  id: string;
}

const LIST_CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Decodes a `nextCursor` of `listApprovalRequestsPage`. A value of another shape is a
 * `ValidationError` on `cursor`, and so is an instant that is no calendar time or lies in year
 * zero: Postgres would refuse both as a `timestamptz`.
 */
export function parseApprovalRequestListCursor(value: string): ApprovalRequestListCursor {
  const match = /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? LIST_CURSOR_SHAPE.exec(Buffer.from(value, "base64url").toString("utf8"))
    : null;
  const at = match?.[1];
  const id = match?.[2];
  if (
    at === undefined ||
    id === undefined ||
    at.startsWith("0000-") ||
    !Number.isFinite(Date.parse(at)) ||
    new Date(at).toISOString() !== `${at.slice(0, 23)}Z`
  ) {
    throw new ValidationError("Invalid 'cursor'", { field: "cursor" });
  }
  return { at, id };
}

export interface ListApprovalRequestsPageInput {
  ownerUserId: string;
  /**
   * `pending`: the requests waiting for a decision. `decided`: the approved and the rejected ones
   * that have a decision time (see `LIST_STATUS_SQL`).
   */
  status: "pending" | "decided";
  /** Only requests whose source is of one of these kinds; `null` is every source. */
  sourceKinds: readonly ApprovalRequestSourceKind[] | null;
  /**
   * Only requests that contain this text, without regard to case or diacritics (see
   * `listApprovalRequestsPage`). `null` is no filter, and so is a text of which removing the
   * diacritics leaves nothing.
   */
  search: string | null;
  /** The direction of the ordering instant: `requested_at` of a pending request, `decided_at` of a decided one. */
  order: "asc" | "desc";
  cursor: ApprovalRequestListCursor | null;
  limit: number;
}

/**
 * The SQL of the two lists. A pending request is ordered by `requested_at`. A decided one is ordered
 * by `decided_at`, which `decideApprovalRequest` sets in the statement that decides the request. A
 * decided row without it has no place in the order and is in neither list. The one-time cutover of
 * issue #89 (`approvalRequestExecutionStatusCutoverMigration.ts`) left such rows: it rejected the
 * requests that were pending when it ran and set no decision time.
 */
const LIST_STATUS_SQL = {
  pending: { predicate: "ar.status = 'pending'", orderedAt: "ar.requested_at" },
  decided: { predicate: "ar.status <> 'pending' AND ar.decided_at IS NOT NULL", orderedAt: "ar.decided_at" },
} as const;

/** The SQL of the two directions: the sort keyword, and the comparison that selects the rows after a cursor. */
const LIST_ORDER_SQL = {
  asc: { direction: "ASC", after: ">" },
  desc: { direction: "DESC", after: "<" },
} as const;

/**
 * One page of the requests of `ownerUserId`'s runs (issue #1785), in the order of `input.status` and
 * `input.order` with the request id as the tie-break, and `nextCursor` set while more rows follow.
 * Owner scoping is that of `listPendingApprovalRequests`: the request's run has `ownerUserId` as its
 * actor.
 *
 * `sourceKinds` and `search` are applied in the query, before the page is cut, so a page is short
 * only when no further row matches. The query derives the source kind by the rule of
 * `loadApprovalSources` (`approvalRequestsQueue.ts`): the kind of the run's thread, and for a run
 * without a thread the `triggered_by` of the run that following `parent_run_id` reaches within
 * `AGENT_RUN_ROOT_MAX_HOPS` hops.
 *
 * `search` keeps the requests that contain it as a substring, compared through `unaccent` and
 * `ILIKE`, in one of: the tool or operation name (`tool_name`), a string value at any depth of
 * `description.params`, the stored title of the run's chat thread, the current text of the Inbox
 * item of its item thread, and the current name of the heartbeat of its tick thread or, without a
 * thread, of its root heartbeat run. Nothing else is searched: not `payload`, and so no argument
 * value, and of `description` neither the template key, the parameter names nor `endsInheritance`.
 *
 * The search text is a bound parameter and the pattern is built from it in the query: the text is
 * folded with `unaccent` first, and a backslash, `%` and `_` in the folded text are escaped after
 * that, so each matches only itself.
 */
export async function listApprovalRequestsPage(
  client: PoolClient,
  input: ListApprovalRequestsPageInput,
): Promise<{ requests: ApprovalRequest[]; nextCursor: string | null }> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  // `status` and `order` are closed unions that select constant SQL fragments; every value is bound.
  const { predicate, orderedAt } = LIST_STATUS_SQL[input.status];
  const { direction, after } = LIST_ORDER_SQL[input.order];
  const { rows } = await client.query<ApprovalRequestRow & { cursor_at: string }>(
    `WITH needle AS MATERIALIZED (
       SELECT CASE WHEN folded.text <> ''
                   THEN '%' || replace(replace(replace(folded.text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
              END AS pattern
         FROM (SELECT unaccent($5::text) AS text) folded
     )
     SELECT ar.*, to_char(${orderedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM approval_requests ar
       JOIN agent_runs r ON r.tenant_id = ar.tenant_id AND r.id = ar.agent_run_id
       CROSS JOIN needle
       LEFT JOIN semp_threads t ON t.tenant_id = r.tenant_id AND t.id = r.thread_id
       LEFT JOIN LATERAL (
         WITH RECURSIVE climb AS (
           SELECT r.parent_run_id, r.triggered_by, r.heartbeat_id, 0 AS hops
            WHERE t.id IS NULL
           UNION ALL
           SELECT parent.parent_run_id, parent.triggered_by, parent.heartbeat_id, climb.hops + 1
             FROM climb
             JOIN agent_runs parent ON parent.tenant_id = r.tenant_id AND parent.id = climb.parent_run_id
            WHERE climb.hops < $8::int
         )
         SELECT triggered_by, heartbeat_id FROM climb ORDER BY hops DESC LIMIT 1
       ) root ON true
       LEFT JOIN project_heartbeats h ON h.tenant_id = r.tenant_id
              AND h.id = COALESCE(t.heartbeat_id,
                                  CASE WHEN root.triggered_by = 'heartbeat' THEN root.heartbeat_id END)
       LEFT JOIN items subject ON subject.tenant_id = t.tenant_id AND subject.database_id = $6::uuid
              AND subject.id = t.subject_inbox_item_id AND subject.deleted_at IS NULL
      WHERE r.actor_user_id = $1
        AND ${predicate}
        AND ($2::text[] IS NULL
             OR CASE WHEN t.kind = 'tick' THEN 'tick'
                     WHEN t.id IS NOT NULL THEN 'chat'
                     WHEN root.triggered_by = 'mcp' THEN 'mcp'
                     WHEN root.triggered_by = 'heartbeat' THEN 'tick'
                     ELSE 'chat' END = ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR (${orderedAt}, ar.id) ${after} ($3::timestamptz, $4::uuid))
        AND (needle.pattern IS NULL
             OR unaccent(ar.tool_name) ILIKE needle.pattern ESCAPE '\\'
             OR unaccent(t.title) ILIKE needle.pattern ESCAPE '\\'
             OR unaccent(h.name) ILIKE needle.pattern ESCAPE '\\'
             OR unaccent(CASE WHEN jsonb_typeof(subject.properties -> 'text') = 'string'
                              THEN subject.properties ->> 'text' END) ILIKE needle.pattern ESCAPE '\\'
             OR EXISTS (
                  SELECT 1
                    FROM jsonb_path_query(ar.description -> 'params', '$.** ? (@.type() == "string")') AS param(value)
                   WHERE unaccent(param.value #>> '{}') ILIKE needle.pattern ESCAPE '\\'))
      ORDER BY ${orderedAt} ${direction}, ar.id ${direction}
      LIMIT $7`,
    [
      input.ownerUserId,
      input.sourceKinds === null ? null : [...input.sourceKinds],
      input.cursor?.at ?? null,
      input.cursor?.id ?? null,
      input.search,
      inbox?.id ?? null,
      input.limit + 1,
      AGENT_RUN_ROOT_MAX_HOPS,
    ],
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    requests: page.map(rowToApprovalRequest),
    nextCursor:
      rows.length > input.limit && last ? Buffer.from(`${last.cursor_at}|${last.id}`).toString("base64url") : null,
  };
}

/**
 * The request only when its run is owned by `ownerUserId` (issue #1028). A foreign or unknown id
 * both return `null`, so the caller cannot tell them apart.
 */
export async function getApprovalRequestForOwner(
  client: Queryable,
  id: string,
  ownerUserId: string,
): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `SELECT ar.* FROM approval_requests ar
       JOIN agent_runs r ON r.id = ar.agent_run_id
      WHERE ar.id = $1 AND r.actor_user_id = $2`,
    [id, ownerUserId],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

/**
 * The single atomic decision transition (issue #131): `pending` -> `approved`/`rejected`, one
 * `UPDATE ... WHERE status = 'pending'`, also conditioned on `decidedBy` being the run's actor
 * (issue #1028). Returns `null` when no row matches: the id is unknown, the request is no longer
 * `pending`, or `decidedBy` is not the run's actor. This call cannot tell those apart; the caller
 * re-reads with `getApprovalRequestForOwner` if it needs to. A retried decision is a deterministic
 * no-op instead of a second transition: two concurrent decisions on the same row race on this one
 * `UPDATE`, and only one can ever see `rowCount > 0`.
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
  const { rows, rowCount } = await client.query<ApprovalRequestRow>(
    `UPDATE approval_requests
        SET status = $2, decided_at = now(), decided_by = $3,
            execution_status = CASE WHEN $2 = 'approved' THEN 'queued' ELSE execution_status END
      WHERE id = $1 AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM agent_runs r
           WHERE r.id = approval_requests.agent_run_id AND r.actor_user_id = $3
        )
      RETURNING *`,
    [id, decision, decidedBy],
  );
  // Zero rows is a legitimate outcome here (unknown, already decided, or not the run's actor), so it
  // is read explicitly rather than requireAffectedRows-ed: the caller turns it into its own answer.
  if (rowCount === 0) return null;
  return rowToApprovalRequest(requireSingleRow(rows, "approval_requests decide RETURNING"));
}

/**
 * Claims one `approved` request for execution: sets `executed_at` iff it is still unset and the
 * request is still `queued`. A redelivered `approvalExecute` job (queue retry, or a second
 * worker) sees `rowCount === 0` and treats it as a no-op instead of invoking the deferred tool
 * call twice — see 0022's migration comment. This claim is the exclusive "executing" marker for
 * the row (`queued` + `executed_at` set, per that same migration's documented state); a second
 * delivery arriving while it holds sees `null` here, not a fresh claim.
 */
export async function claimApprovalRequestExecution(client: Queryable, id: string): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `UPDATE approval_requests
        SET executed_at = now()
      WHERE id = $1 AND status = 'approved' AND executed_at IS NULL AND execution_status = 'queued'
      RETURNING *`,
    [id],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

export interface ApprovalRequestOutcome {
  error: boolean;
  result: string;
  /**
   * Why a failed MCP outcome failed. When set, `execution_result_jsonb` holds `{ text, outcomeKind }`
   * so `approvalConflictReason` can tell the causes apart; when absent it holds the plain text.
   */
  outcomeKind?: ApprovalOutcomeKind;
  failure?: McpInvokeFailure;
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
 *
 * Guarded on `execution_status = 'queued'` like every other targeted UPDATE in this file, and
 * returns whether it actually wrote instead of throwing on zero rows (issue #693): a second
 * delivery's outcome, or one that arrives after `settleStaleApprovalRequestClaim` already
 * terminalized the row, finds it no longer `queued` and must discard its result rather than
 * overwrite an already-settled outcome. `false` is a legitimate, expected result here — the
 * caller logs the discard instead of treating it as an error.
 */
export async function recordApprovalRequestOutcome(
  client: Queryable,
  id: string,
  outcome: ApprovalRequestOutcome,
): Promise<boolean> {
  const failure = outcome.failure === undefined ? undefined : parseMcpInvokeFailure(outcome.failure);
  if (failure && !outcome.error) throw new Error("Invalid MCP failure metadata");
  const result = await client.query(
    `UPDATE approval_requests
        SET execution_error = $2, execution_result_jsonb = $3::jsonb,
            execution_status = CASE WHEN $2 THEN 'conflict' ELSE 'succeeded' END,
            executed_at = COALESCE(executed_at, now())
      WHERE id = $1 AND execution_status = 'queued'`,
    [
      id,
      outcome.error,
      JSON.stringify(
        outcome.outcomeKind || failure
          ? {
              text: outcome.result,
              ...(outcome.outcomeKind ? { outcomeKind: outcome.outcomeKind } : {}),
              ...(failure ? { failure } : {}),
            }
          : outcome.result,
      ),
    ],
  );
  return result.rowCount === 1;
}

/** What `settleStaleApprovalRequestClaim` returns can distinguish. */
export type StaleApprovalClaimSettlement = "settled" | "in_flight" | "not_claimed";

/**
 * Settles a claim (`execution_status = 'queued'` with `executed_at` set — see
 * `claimApprovalRequestExecution`'s docstring for that state's meaning) that has outlived
 * `staleAfterMs` without an outcome ever being recorded for it (issue #693): a process crash or a
 * transient database error between the claim and `recordApprovalRequestOutcome` otherwise leaves
 * the row claimed forever, with no later delivery able to tell whether the tool call ran.
 * `conflict` is the only terminal failure value `execution_status`'s `CHECK` constraint allows,
 * so that is what a stale claim settles to — its `execution_result_jsonb` text is what
 * distinguishes this "unknown outcome" case for a reader from an ordinary revalidation conflict.
 *
 * Returns `"settled"` when this call performed that write. Otherwise re-reads the row to tell
 * apart the two reasons it didn't: `"in_flight"` when the claim is still within `staleAfterMs` (a
 * delivery may genuinely still be running), and `"not_claimed"` when the row was never in the
 * stale-claimed state at all (rejected, unknown, already terminal) — the caller treats those two
 * outcomes differently (retry later vs. give up quietly).
 */
export async function settleStaleApprovalRequestClaim(
  client: Queryable,
  id: string,
  staleAfterMs: number,
): Promise<StaleApprovalClaimSettlement> {
  const unknownOutcome: { text: string; outcomeKind: ApprovalOutcomeKind } = {
    text: "The deferred MCP tool call was claimed by an earlier delivery that never recorded its outcome; the tool may or may not have run.",
    outcomeKind: "staleClaim",
  };
  const result = await client.query(
    `UPDATE approval_requests
        SET execution_status = 'conflict', execution_error = true, execution_result_jsonb = $2::jsonb
      WHERE id = $1 AND status = 'approved' AND execution_status = 'queued' AND executed_at IS NOT NULL
        AND executed_at < now() - make_interval(secs => $3 / 1000.0)`,
    [id, JSON.stringify(unknownOutcome), staleAfterMs],
  );
  if (result.rowCount === 1) return "settled";

  const { rows } = await client.query<Pick<ApprovalRequestRow, "execution_status" | "executed_at">>(
    `SELECT execution_status, executed_at FROM approval_requests WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row && row.execution_status === "queued" && row.executed_at !== null) return "in_flight";
  return "not_claimed";
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
