import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";
import { RISK_CLASSES, type RiskClass } from "@alldots/shared";
import { AGENT_RUN_ROOT_MAX_HOPS } from "../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { assertKnownValue, assertShape } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { enqueueBadgeRefresh } from "../push/badgeRefreshEnqueue.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { ApprovalOutcomeKind } from "./approvalConflictReason.js";
import { isMcpItemId, parseMcpInvokeFailure, type McpInvokeFailure } from "./mcpFailure.js";

/** Mirrored by the `approval_requests_reason_length_check` constraint. */
export const APPROVAL_REQUEST_REASON_MAX_LENGTH = 500;

export type ApprovalRequestStatus = "pending" | "approved" | "rejected";

export type ApprovalRequestDecision = "approved" | "rejected";

const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = ["pending", "approved", "rejected"];

/**
 * The exactly-once execution state, independent of the decision: `not_approved` -> `queued` (set together with
 * `approved`) -> `succeeded` or `conflict` (the resource changed or its authorization no longer holds).
 */
export type ApprovalRequestExecutionStatus = "not_approved" | "queued" | "succeeded" | "conflict";

const APPROVAL_REQUEST_EXECUTION_STATUSES: readonly ApprovalRequestExecutionStatus[] = [
  "not_approved",
  "queued",
  "succeeded",
  "conflict",
];

/**
 * `kind` is validated against the destructive-operation enum only when a generic-operation request is created; it
 * stays a plain string here so the `mcpInvoke` kind can also fill the `NOT NULL` column.
 */
export interface ApprovalResourceSnapshot {
  kind: string;
  resourceId: string;
  sha256: string | null;
}

/** A template key plus parameters, never rendered text (contract in `approvalDescription.ts`). */
export interface ApprovalDescription {
  key: string;
  params: Record<string, string | number | null>;
  /** Omitted when the action ends no link. */
  breaksLinks?: BreaksLinkEntry[];
  /** Links that follow a broken link's property and lose the value it fed them; omitted when none. */
  endsInheritance?: EndsInheritanceEntry[];
}

/**
 * `propertyKey` is canonical. A link fed by a sender domain has `null` source ids and the domain as
 * `sourceItemName`; a link without any source row has all three `null`. `newValueName` is `null` when the write
 * sets no value.
 */
export interface BreaksLinkEntry {
  itemId: string;
  itemName: string | null;
  propertyKey: string;
  sourceItemId: string | null;
  sourceItemName: string | null;
  sourceDatabaseKey: string | null;
  newValueName: string | null;
}

export interface EndsInheritanceEntry {
  itemId: string;
  propertyKey: string;
  sourceName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isInheritanceEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.propertyKey === "string" &&
    isNullableString(value.sourceName)
  );
}

function isBreaksLinkEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.propertyKey === "string" &&
    isNullableString(value.itemName) &&
    isNullableString(value.sourceItemId) &&
    isNullableString(value.sourceItemName) &&
    isNullableString(value.sourceDatabaseKey) &&
    isNullableString(value.newValueName)
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
        (Array.isArray(value.endsInheritance) && value.endsInheritance.every(isInheritanceEntry))) &&
      (value.breaksLinks === undefined ||
        (Array.isArray(value.breaksLinks) && value.breaksLinks.every(isBreaksLinkEntry))),
    "description",
  );
  return value as unknown as ApprovalDescription;
}

/**
 * An immutable, invocation-time snapshot of one deferred call. `payload` holds everything needed to execute the
 * approved call unchanged and is never re-derived from `agentRunId`, since the grant or registration may have
 * changed since.
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
  /** Set atomically as the execution claim before the deferred call is made. */
  executedAt: string | null;
  executionError: boolean | null;
  executionResult: unknown;
  reason: string | null;
  /** `null` for older requests and paths without one. */
  toolCallId: string | null;
  /** `null` for older requests. */
  description: ApprovalDescription | null;
}

export interface McpInvokeApprovalRequestPayload {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  args: Record<string, unknown>;
}

/**
 * The actor identity is the one the run row backed at dispatch, never re-derived at replay, so a mismatch with
 * the run's current provenance is what `owner_violation` detects. `resourceSnapshot` duplicates the column so the
 * payload alone records exactly what was approved.
 */
export interface GenericOperationApprovalRequestPayload {
  operationName: string;
  canonicalInput: unknown;
  actor: { runId: string; agentProjectItemId: string; userId: string };
  resourceSnapshot: ApprovalResourceSnapshot;
}

/** The owning module is resolved from the tool name through `ModuleRegistry` at execution time, never stored. */
export interface ModuleToolApprovalRequestPayload {
  moduleToolName: string;
  args: Record<string, unknown>;
}

export const MAIL_DRAFT_SEND_TOOL_NAME = "mail.draft.send";

/**
 * Cc, Bcc, From and attachments are covered by `draftHash` only. The values stay in this column; client-facing
 * views carry argument names at most.
 */
export interface MailSendApprovalRequestPayload {
  draftId: string;
  draftHash: string;
  mailboxId: string;
  to: Array<{ name?: string; address: string }>;
  subject: string;
  body: string;
}

export type ApprovalRequestPayload =
  | McpInvokeApprovalRequestPayload
  | GenericOperationApprovalRequestPayload
  | ModuleToolApprovalRequestPayload
  | MailSendApprovalRequestPayload;

export function isGenericOperationApprovalRequestPayload(
  payload: ApprovalRequestPayload,
): payload is GenericOperationApprovalRequestPayload {
  return "operationName" in payload;
}

export function isMcpInvokeApprovalRequestPayload(
  payload: ApprovalRequestPayload,
): payload is McpInvokeApprovalRequestPayload {
  return "mcpToolRegistrationId" in payload;
}

export function isModuleToolApprovalRequestPayload(
  payload: ApprovalRequestPayload,
): payload is ModuleToolApprovalRequestPayload {
  return "moduleToolName" in payload;
}

export function isMailSendApprovalRequestPayload(
  payload: ApprovalRequestPayload,
): payload is MailSendApprovalRequestPayload {
  return "draftHash" in payload;
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
  /** Stored as `NULL` when absent. */
  reason?: string | null;
  toolCallId?: string | null;
  /** Computed by the caller in the same transaction. */
  description?: ApprovalDescription | null;
}

/**
 * Run it in the same transaction as whatever it must be atomic with. A repeated `(agentRunId, toolCallId)`
 * returns the existing request.
 */
export async function createPendingApprovalRequest(
  client: Queryable,
  input: CreatePendingApprovalRequestInput,
): Promise<ApprovalRequest> {
  return (await insertPendingApprovalRequest(client, input)).request;
}

/** Also reports whether this call inserted the row; announcers announce only an insert. */
export async function insertPendingApprovalRequest(
  client: Queryable,
  input: CreatePendingApprovalRequestInput,
): Promise<{ request: ApprovalRequest; inserted: boolean }> {
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
    return {
      request: rowToApprovalRequest(requireSingleRow(existing.rows, "approval_requests tool call lookup")),
      inserted: false,
    };
  }
  const created = rowToApprovalRequest(requireSingleRow(rows, "approval_requests insert RETURNING"));
  // Bumps the run's thread in the activity ordering inside the caller's transaction. GREATEST never lowers newer
  // activity (`now()` is the transaction start). A replayed tool call is not new activity.
  await client.query(
    `UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now())
      WHERE id = (SELECT thread_id FROM agent_runs WHERE id = $1)`,
    [input.agentRunId],
  );
  // The actor's pending badge changes.
  const actor = await client.query<{ actor_user_id: string }>("SELECT actor_user_id FROM agent_runs WHERE id = $1", [
    input.agentRunId,
  ]);
  await enqueueBadgeRefresh(
    client,
    requireSingleRow(actor.rows, "agent_runs actor lookup for a new approval request").actor_user_id,
  );
  return { request: created, inserted: true };
}

/** `forUpdate` row-locks the request so a concurrent decide/replay cannot race a half-finished execution. */
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

/** A reliable guard only for a caller holding the draft's Emails item lock, which every creation takes. */
export async function findPendingMailSendApprovalRequest(
  client: Queryable,
  draftId: string,
): Promise<ApprovalRequest | null> {
  const { rows } = await client.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests
      WHERE status = 'pending' AND payload ? 'draftHash' AND payload ->> 'draftId' = $1
      ORDER BY requested_at ASC, id ASC
      LIMIT 1`,
    [draftId],
  );
  return rows[0] ? rowToApprovalRequest(rows[0]) : null;
}

/**
 * The others become `rejected` with no decider and `{ supersededBy }` as result, and never execute. Returns each
 * closed request with its run's owner.
 */
export async function supersedePendingMailSendApprovalRequests(
  client: Queryable,
  draftId: string,
  decidedRequestId: string,
): Promise<Array<{ request: ApprovalRequest; ownerUserId: string }>> {
  const { rows, rowCount } = await client.query<ApprovalRequestRow & { owner_user_id: string }>(
    `UPDATE approval_requests
        SET status = 'rejected', decided_at = now(), execution_result_jsonb = $3::jsonb
      WHERE status = 'pending' AND payload ? 'draftHash' AND payload ->> 'draftId' = $1 AND id <> $2
      RETURNING *, (SELECT r.actor_user_id FROM agent_runs r WHERE r.id = approval_requests.agent_run_id) AS owner_user_id`,
    [draftId, decidedRequestId, JSON.stringify({ supersededBy: decidedRequestId })],
  );
  if (rowCount === 0) return [];
  return rows.map((row) => ({ request: rowToApprovalRequest(row), ownerUserId: row.owner_user_id }));
}

/** The payload (the call's arguments) is deliberately left out. */
export interface ApprovalRequestStateView {
  id: string;
  status: ApprovalRequestStatus;
  executionStatus: ApprovalRequestExecutionStatus;
  /** Read only for its discriminators (`approvalConflictReason`). */
  executionResult: unknown;
}

type ApprovalRequestStateRow = Pick<
  ApprovalRequestRow,
  "id" | "status" | "execution_status" | "execution_result_jsonb"
>;

function rowToApprovalRequestState(row: ApprovalRequestStateRow): ApprovalRequestStateView {
  return {
    id: row.id,
    status: assertKnownValue(APPROVAL_REQUEST_STATUSES, row.status, "status"),
    executionStatus: assertKnownValue(APPROVAL_REQUEST_EXECUTION_STATUSES, row.execution_status, "execution_status"),
    executionResult: row.execution_result_jsonb,
  };
}

/** One query. Invisible ids are absent; `ids` must be uuids (the caller checks). */
export async function listApprovalRequestStatesByIds(
  client: Queryable,
  ids: readonly string[],
): Promise<ApprovalRequestStateView[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<ApprovalRequestStateRow>(
    `SELECT id, status, execution_status, execution_result_jsonb FROM approval_requests WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(rowToApprovalRequestState);
}

/** Another user's request and an unknown id are both absent, so the caller cannot tell them apart. */
export async function listApprovalRequestStatesByIdsForOwner(
  client: Queryable,
  ids: readonly string[],
  ownerUserId: string,
): Promise<ApprovalRequestStateView[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<ApprovalRequestStateRow>(
    `SELECT ar.id, ar.status, ar.execution_status, ar.execution_result_jsonb
       FROM approval_requests ar
       JOIN agent_runs r ON r.id = ar.agent_run_id
      WHERE ar.id = ANY($1::uuid[]) AND r.actor_user_id = $2`,
    [ids, ownerUserId],
  );
  return rows.map(rowToApprovalRequestState);
}

/** Oldest first. Decided requests never appear. */
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

export const APPROVAL_REQUEST_SOURCE_KINDS = ["chat", "tick", "mcp"] as const;
export type ApprovalRequestSourceKind = (typeof APPROVAL_REQUEST_SOURCE_KINDS)[number];

/** The last row's ordering instant (with microseconds) and its id. */
export interface ApprovalRequestListCursor {
  at: string;
  id: string;
}

const LIST_CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Rejects other shapes and instants Postgres would refuse as `timestamptz` (non-calendar or year zero). */
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
  /** `decided`: approved and rejected requests that have a decision time. */
  status: "pending" | "decided";
  /** `null` is every source. */
  sourceKinds: readonly ApprovalRequestSourceKind[] | null;
  /** Case- and diacritic-insensitive. `null`, or a text that is empty after removing diacritics, is no filter. */
  search: string | null;
  /** `requested_at` for pending, `decided_at` for decided. */
  order: "asc" | "desc";
  cursor: ApprovalRequestListCursor | null;
  limit: number;
}

/** A decided row without `decided_at` has no place in the order and is in neither list. */
const LIST_STATUS_SQL = {
  pending: { predicate: "ar.status = 'pending'", orderedAt: "ar.requested_at" },
  decided: { predicate: "ar.status <> 'pending' AND ar.decided_at IS NOT NULL", orderedAt: "ar.decided_at" },
} as const;

/**
 * `root` is the run reached via `parent_run_id` within `AGENT_RUN_ROOT_MAX_HOPS` (empty when the run has a
 * thread). Only this module's constants are bound to `hopsParameter`. Shared by list and count so both derive
 * the source kind by one rule.
 */
function sourceJoinSql(hopsParameter: string): string {
  return `LEFT JOIN semp_threads t ON t.tenant_id = r.tenant_id AND t.id = r.thread_id
       LEFT JOIN LATERAL (
         WITH RECURSIVE climb AS (
           SELECT r.parent_run_id, r.triggered_by, r.heartbeat_id, 0 AS hops
            WHERE t.id IS NULL
           UNION ALL
           SELECT parent.parent_run_id, parent.triggered_by, parent.heartbeat_id, climb.hops + 1
             FROM climb
             JOIN agent_runs parent ON parent.tenant_id = r.tenant_id AND parent.id = climb.parent_run_id
            WHERE climb.hops < ${hopsParameter}::int
         )
         SELECT triggered_by, heartbeat_id FROM climb ORDER BY hops DESC LIMIT 1
       ) root ON true`;
}

/** Same rule as `loadApprovalSources`. */
const SOURCE_KIND_SQL = `CASE WHEN t.kind = 'tick' THEN 'tick'
                     WHEN t.id IS NOT NULL THEN 'chat'
                     WHEN root.triggered_by = 'mcp' THEN 'mcp'
                     WHEN root.triggered_by = 'heartbeat' THEN 'tick'
                     ELSE 'chat' END`;

const LIST_ORDER_SQL = {
  asc: { direction: "ASC", after: ">" },
  desc: { direction: "DESC", after: "<" },
} as const;

/**
 * Ordered by `input.status`/`input.order` with the id as tie-break. `sourceKinds` and `search` apply before the
 * page is cut, so a page is short only when nothing more matches.
 *
 * `search` is an `unaccent` + `ILIKE` substring match over: `tool_name`, string values in `description.params`,
 * the chat thread title, the item thread's Inbox text, and the tick thread's (or root run's) heartbeat name. Never
 * `payload` (no argument value), nor the template key, parameter names or `endsInheritance`. The text is bound,
 * folded first, then `\`, `%` and `_` are escaped so each matches only itself.
 */
export async function listApprovalRequestsPage(
  client: PoolClient,
  input: ListApprovalRequestsPageInput,
): Promise<{ requests: ApprovalRequest[]; nextCursor: string | null }> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  // Closed unions select constant SQL fragments; every value is bound.
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
       ${sourceJoinSql("$8")}
       LEFT JOIN project_heartbeats h ON h.tenant_id = r.tenant_id
              AND h.id = COALESCE(t.heartbeat_id,
                                  CASE WHEN root.triggered_by = 'heartbeat' THEN root.heartbeat_id END)
       LEFT JOIN items subject ON subject.tenant_id = t.tenant_id AND subject.database_id = $6::uuid
              AND subject.id = t.subject_inbox_item_id AND subject.deleted_at IS NULL
      WHERE r.actor_user_id = $1
        AND ${predicate}
        AND ($2::text[] IS NULL OR ${SOURCE_KIND_SQL} = ANY($2::text[]))
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

/** Matches `listApprovalRequestsPage` for `status: "pending"` without search, by the same status and source rules. */
export async function countPendingApprovalRequests(
  client: Queryable,
  input: { ownerUserId: string; sourceKinds: readonly ApprovalRequestSourceKind[] | null },
): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM approval_requests ar
       JOIN agent_runs r ON r.tenant_id = ar.tenant_id AND r.id = ar.agent_run_id
       ${sourceJoinSql("$3")}
      WHERE r.actor_user_id = $1
        AND ${LIST_STATUS_SQL.pending.predicate}
        AND ($2::text[] IS NULL OR ${SOURCE_KIND_SQL} = ANY($2::text[]))`,
    [input.ownerUserId, input.sourceKinds === null ? null : [...input.sourceKinds], AGENT_RUN_ROOT_MAX_HOPS],
  );
  return requireSingleRow(rows, "approval_requests pending count").count;
}

/** A foreign or unknown id both return `null`, so the caller cannot tell them apart. */
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
 * A single `UPDATE ... WHERE status = 'pending'` also conditioned on `decidedBy` being the run's actor, so two
 * concurrent decisions race on one row and only one wins. `null` when unknown, no longer pending, or not the
 * actor (the caller re-reads with `getApprovalRequestForOwner` if needed).
 *
 * Not re-exported from `index.ts`: only `approvalDecisionAction.ts` (which enqueues execution in the same
 * transaction) is reachable from a route, so an agent has no path to decide its own request.
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
  // Zero rows is a legitimate outcome the caller answers itself.
  if (rowCount === 0) return null;
  return rowToApprovalRequest(requireSingleRow(rows, "approval_requests decide RETURNING"));
}

/**
 * Sets `executed_at` only while unset and `queued`, so a redelivered `approvalExecute` job gets `null` instead of
 * invoking the deferred call twice. `queued` + `executed_at` set is the exclusive "executing" state.
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
   * When set, `execution_result_jsonb` holds `{ text, outcomeKind }` so `approvalConflictReason` can tell causes
   * apart; otherwise the plain text.
   */
  outcomeKind?: ApprovalOutcomeKind;
  failure?: McpInvokeFailure;
}

/**
 * The final write for a claimed mcpInvoke call and for the unclaimed generic-operation "no replay handler"
 * fallback, which is why `executed_at` is `COALESCE`d here. A failed outcome settles to `conflict`, never
 * `succeeded`, so replay idempotency cannot mistake it for success.
 *
 * Guarded on `execution_status = 'queued'`: a second delivery, or one after `settleStaleApprovalRequestClaim`,
 * must discard its result rather than overwrite a settled outcome. `false` is expected; the caller logs it.
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

export type StaleApprovalClaimSettlement = "settled" | "in_flight" | "not_claimed";

/**
 * A crash or transient error between claim and `recordApprovalRequestOutcome` would leave the row claimed
 * forever, unable to tell whether the call ran. Settles to `conflict` (the only terminal failure the `CHECK`
 * allows); the result text marks it as an unknown outcome.
 *
 * `"in_flight"` when still within `staleAfterMs` (retry later); `"not_claimed"` when never stale-claimed
 * (give up quietly).
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
 * Runs inside the caller's transaction on an already-locked row and never throws, so that transaction commits.
 * Also sets the legacy `execution_error` column for readers still keyed off it. The `queued` guard turns a
 * caller bug on an already-terminal row into a thrown error instead of a silent overwrite.
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
 * In the caller's transaction so the replayed mutation and its terminal state commit together. Same legacy column
 * and `queued` guard as `terminalizeApprovalRequestAsConflict`: the row lock rules out concurrent writers but not
 * a caller bug.
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
