import { Pool, type PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { withTransaction, requireSingleRow } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { AGENT_RUN_ERROR_CODES, type AgentRunErrorCode } from "./agentRunErrorCodes.js";
import { publishAgentRunInvalidation } from "./agentRunInvalidation.js";
import { raiseAgentHeartbeatProblem, raiseAgentRunProblem } from "../semp/agentProblems.js";
import { SEMP_THREAD_KINDS, type SempThreadKind } from "../semp/sempThreadsListStore.js";

export { AGENT_RUN_ERROR_CODES, type AgentRunErrorCode };

export type TriggeredBy = "user" | "heartbeat" | "supervisor" | "mcp";
export type AgentRunUnit = "invocation" | "session";
export type AgentRunStatus = "running" | "done" | "error";

const TRIGGERED_BY_VALUES: readonly TriggeredBy[] = ["user", "heartbeat", "supervisor", "mcp"];
const AGENT_RUN_UNITS: readonly AgentRunUnit[] = ["invocation", "session"];
const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["running", "done", "error"];

export interface AgentRunRow {
  id: string;
  projectItemId: string | null;
  parentRunId: string | null;
  heartbeatId: string | null;
  retryOfRunId: string | null;
  attempt: number;
  /** `null` for a manual or item-event run. */
  heartbeatOccurrenceId: string | null;
  /** `null` for an MCP run or a run with no thread. */
  threadId: string | null;
  /** Self-reported by the MCP client; display text only, never read by an authorization decision. */
  mcpClientName: string | null;
  triggeredBy: TriggeredBy;
  unit: AgentRunUnit;
  task: string;
  status: AgentRunStatus;
  /** A run closed as `error` holds its `errorCode` here; older error rows keep legacy free text. */
  result: string | null;
  /** Set for `status = 'error'` (rows predating the column read `internal`), `null` otherwise. */
  errorCode: AgentRunErrorCode | null;
  /** Ids and counters only, no user content. */
  errorDetail: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Who this run's writes are attributed to: the session user of a root run that supplied one, else the tenant's
   * user; a delegated run copies its parent's. Agent actor identity is derived from this column alone, never from
   * tool input.
   */
  actorUserId: string;
}

type AgentRunDbRow = {
  id: string;
  project_item_id: string | null;
  parent_run_id: string | null;
  heartbeat_id: string | null;
  retry_of_run_id: string | null;
  heartbeat_occurrence_id: string | null;
  attempt: number;
  thread_id: string | null;
  mcp_client_name: string | null;
  triggered_by: string;
  unit: string;
  task: string;
  status: string;
  result: string | null;
  error_code: string | null;
  error_detail: unknown;
  started_at: Date;
  finished_at: Date | null;
  actor_user_id: string;
};

const AGENT_RUN_ROW_COLUMNS =
  "id, project_item_id, parent_run_id, heartbeat_id, retry_of_run_id, attempt, heartbeat_occurrence_id, thread_id, mcp_client_name, triggered_by, unit, task, status, result, error_code, error_detail, started_at, finished_at, actor_user_id";

function mapErrorCode(row: AgentRunDbRow): AgentRunErrorCode | null {
  if (row.error_code !== null) return assertKnownValue(AGENT_RUN_ERROR_CODES, row.error_code, "error_code");
  return row.status === "error" ? "internal" : null;
}

function parseErrorDetail(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed error_detail in database row");
  return Object.fromEntries(Object.entries(value));
}

function mapRow(row: AgentRunDbRow): AgentRunRow {
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    parentRunId: row.parent_run_id,
    heartbeatId: row.heartbeat_id,
    retryOfRunId: row.retry_of_run_id,
    attempt: row.attempt,
    heartbeatOccurrenceId: row.heartbeat_occurrence_id,
    threadId: row.thread_id,
    mcpClientName: row.mcp_client_name,
    triggeredBy: assertKnownValue(TRIGGERED_BY_VALUES, row.triggered_by, "triggered_by"),
    unit: assertKnownValue(AGENT_RUN_UNITS, row.unit, "unit"),
    task: row.task,
    status: assertKnownValue(AGENT_RUN_STATUSES, row.status, "status"),
    result: row.result,
    errorCode: mapErrorCode(row),
    errorDetail: parseErrorDetail(row.error_detail),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    actorUserId: row.actor_user_id,
  };
}

export interface CreateAgentRunInput {
  projectItemId?: string | null;
  parentRunId?: string | null;
  heartbeatId?: string | null;
  /** `createChainedAgentRun` requires it. */
  retryOfRunId?: string | null;
  attempt?: number;
  heartbeatOccurrenceId?: string | null;
  /** When omitted and `parentRunId` is set, the parent's `thread_id` is copied, so every delegation inherits it. */
  threadId?: string | null;
  triggeredBy: TriggeredBy;
  unit?: AgentRunUnit;
  task: string;
  /**
   * The session user creating a root run; when omitted, the tenant's user. Ignored for a delegated run, which
   * inherits its parent's actor.
   */
  userId?: string;
}

/** Throws when no user resolves: a run without an attributable actor could never derive an agent actor. */
async function resolveActorUserId(
  client: Pool | PoolClient,
  parent: AgentRunRow | null,
  userId: string | undefined,
): Promise<string> {
  if (parent) return parent.actorUserId;
  if (userId) return userId;
  const tenantUserId = await getTenantUserId(client);
  if (!tenantUserId) throw new Error("Cannot create an agent run: the current tenant has no user");
  return tenantUserId;
}

export async function createAgentRun(client: Pool | PoolClient, input: CreateAgentRunInput): Promise<AgentRunRow> {
  let parent: AgentRunRow | null = null;
  if (input.parentRunId) {
    parent = await getAgentRun(client, input.parentRunId);
    if (!parent) {
      throw new Error(`Cannot create a delegated agent run: parent run '${input.parentRunId}' does not exist`);
    }
  }
  const actorUserId = await resolveActorUserId(client, parent, input.userId);
  const threadId = input.threadId === undefined ? (parent?.threadId ?? null) : input.threadId;
  const { rows } = await client.query<AgentRunDbRow>(
    `INSERT INTO agent_runs (project_item_id, parent_run_id, heartbeat_id, retry_of_run_id, attempt, heartbeat_occurrence_id, thread_id, triggered_by, unit, task, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${AGENT_RUN_ROW_COLUMNS}`,
    [
      input.projectItemId ?? null,
      input.parentRunId ?? null,
      input.heartbeatId ?? null,
      input.retryOfRunId ?? null,
      input.attempt ?? 1,
      input.heartbeatOccurrenceId ?? null,
      threadId,
      input.triggeredBy,
      input.unit ?? "invocation",
      input.task,
      actorUserId,
    ],
  );
  const run = mapRow(requireSingleRow(rows, "agent_runs row"));
  await publishAgentRunInvalidation(client, run.id);
  return run;
}

/**
 * `null` when the run was already retried: the unique key on `(tenant_id, retry_of_run_id)` decides inside the
 * insert, so of two concurrent callers exactly one gets a row. The retry takes the retried run's actor.
 */
export async function createChainedAgentRun(
  client: Pool | PoolClient,
  input: CreateAgentRunInput & { retryOfRunId: string },
): Promise<AgentRunRow | null> {
  const { rows } = await client.query<AgentRunDbRow>(
    `INSERT INTO agent_runs (project_item_id, parent_run_id, heartbeat_id, retry_of_run_id, attempt, heartbeat_occurrence_id, thread_id, triggered_by, unit, task, actor_user_id)
     SELECT $2, $3, $4, r.id, $5, $6, $7, $8, $9, $10, r.actor_user_id
     FROM agent_runs r WHERE r.id = $1
     ON CONFLICT (tenant_id, retry_of_run_id) DO NOTHING
     RETURNING ${AGENT_RUN_ROW_COLUMNS}`,
    [
      input.retryOfRunId,
      input.projectItemId ?? null,
      input.parentRunId ?? null,
      input.heartbeatId ?? null,
      input.attempt ?? 1,
      input.heartbeatOccurrenceId ?? null,
      input.threadId ?? null,
      input.triggeredBy,
      input.unit ?? "invocation",
      input.task,
    ],
  );
  if (rows[0]) {
    const run = mapRow(rows[0]);
    await publishAgentRunInvalidation(client, run.id);
    return run;
  }
  if (!(await getAgentRun(client, input.retryOfRunId))) {
    throw new NotFoundError(`Agent run '${input.retryOfRunId}' not found`);
  }
  return null;
}

export async function getRetrySuccessorId(client: Pool | PoolClient, runId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM agent_runs WHERE retry_of_run_id = $1", [runId]);
  return rows[0]?.id ?? null;
}

/** Highest `attempt`, ties by `started_at`. */
export async function getLatestRunOfOccurrence(
  client: Pool | PoolClient,
  occurrenceId: string,
): Promise<AgentRunRow | null> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs
     WHERE heartbeat_occurrence_id = $1
     ORDER BY attempt DESC, started_at DESC
     LIMIT 1`,
    [occurrenceId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Follows `retry_of_run_id` to the start of the chain. */
export async function getRetryChainFirstRunId(client: Pool | PoolClient, runId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, retry_of_run_id FROM agent_runs WHERE id = $1
       UNION
       SELECT r.id, r.retry_of_run_id FROM agent_runs r JOIN chain c ON r.id = c.retry_of_run_id
     )
     SELECT id FROM chain WHERE retry_of_run_id IS NULL`,
    [runId],
  );
  const first = rows[0];
  if (!first) throw new NotFoundError(`agent run ${runId} not found`);
  return first.id;
}

/**
 * The `status = 'running'` guard is in the `UPDATE`, so of two concurrent closers exactly one wins and the row
 * keeps the first outcome; the loser gets `false` (a normal outcome to log, not an error).
 *
 * An `error` close stores only the canonical `errorCode` (as both `error_code` and `result`), so no exception
 * text or user content stays in the row. Only a close this call performed announces the run.
 */
export function finishAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "done",
  result: string | null,
): Promise<boolean>;
export function finishAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "error",
  errorCode: AgentRunErrorCode,
  errorDetail?: Record<string, unknown>,
): Promise<boolean>;
export async function finishAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "done" | "error",
  resultOrErrorCode: string | null,
  errorDetail?: Record<string, unknown>,
): Promise<boolean> {
  const detail = parseErrorDetail(errorDetail ?? null);
  const errorCode =
    status === "error" ? assertKnownValue(AGENT_RUN_ERROR_CODES, resultOrErrorCode ?? "", "error code") : null;
  const updated = await client.query(
    `UPDATE agent_runs SET status = $2, result = $3, error_code = $4, error_detail = $5, finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [agentRunId, status, errorCode ?? resultOrErrorCode, errorCode, detail],
  );
  if (updated.rowCount === 1) {
    await publishAgentRunInvalidation(client, agentRunId);
    return true;
  }
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [agentRunId]);
  if (rows.length === 0) throw new NotFoundError(`agent run ${agentRunId} not found`);
  return false;
}

/**
 * The single producer path for `agent_run_error`: every error close goes through here so the notification and
 * the run's `agents` problem land in the same transaction as the close.
 *
 * `transitionInstance` is the run id: a run leaves `running` once, so a replayed close is the same transition.
 * A lost close (`false`) writes nothing. Skips notification and problem when the tenant has no user.
 */
export async function finishAgentRunWithErrorNotification(
  client: Pool | PoolClient,
  agentRunId: string,
  errorCode: AgentRunErrorCode,
  errorDetail?: Record<string, unknown>,
): Promise<boolean> {
  // `writeNotification` needs a transaction client, so a bare pool gets one here to keep the close and the
  // notification atomic.
  if (client instanceof Pool) {
    return withTransaction(client, (c) => finishAgentRunWithErrorNotification(c, agentRunId, errorCode, errorDetail));
  }
  const closed = await finishAgentRun(client, agentRunId, "error", errorCode, errorDetail);
  if (!closed) return false;
  const userId = await getTenantUserId(client);
  if (!userId) return true;
  await writeNotification(client, {
    userId,
    kind: "agent_run_error",
    linkHref: `?page=agent-run&id=${agentRunId}`,
    sourceTable: "agent_runs",
    sourceId: agentRunId,
    transitionInstance: agentRunId,
  });
  await raiseFailedRunProblem(client, userId, agentRunId);
  return true;
}

/**
 * A heartbeat tick raises its heartbeat's problem (merging the tick's other reports); a supervisor or MCP run
 * raises its retry chain's. A dangling project item is dropped by `raiseAgentRunProblem`, so the close never
 * fails on it.
 */
async function raiseFailedRunProblem(client: PoolClient, userId: string, agentRunId: string): Promise<void> {
  const run = await getAgentRun(client, agentRunId);
  if (!run) throw new NotFoundError(`agent run ${agentRunId} not found`);
  if (run.heartbeatId !== null) {
    await raiseAgentHeartbeatProblem(client, { userId, heartbeatId: run.heartbeatId, occurrenceKey: run.id });
    return;
  }
  // A chat turn is a problem per reply; a heartbeat-triggered run without a heartbeat has no tick to report.
  if (run.triggeredBy === "user" || run.triggeredBy === "heartbeat") return;
  await raiseAgentRunProblem(client, {
    userId,
    firstRunId: await getRetryChainFirstRunId(client, run.id),
    failedRunId: run.id,
    projectItemId: run.projectItemId,
  });
}

/** In characters as the `mcp_client_name` check counts them. */
const MCP_CLIENT_NAME_MAX_LENGTH = 64;

/**
 * Strips control characters and surrounding whitespace, then cuts by code points so a surrogate pair is never
 * split. `null` when nothing is left.
 */
function sanitizeMcpClientName(name: string): string | null {
  const cleaned = name.replace(/\p{Cc}/gu, "").trim();
  let kept = "";
  let length = 0;
  for (const character of cleaned) {
    if (length === MCP_CLIENT_NAME_MAX_LENGTH) break;
    kept += character;
    length += 1;
  }
  const sanitized = kept.trimEnd();
  return sanitized === "" ? null : sanitized;
}

/** A name of only control characters and whitespace clears the column. */
export async function setAgentRunMcpClientName(client: Pool | PoolClient, runId: string, name: string): Promise<void> {
  const updated = await client.query(`UPDATE agent_runs SET mcp_client_name = $2 WHERE id = $1`, [
    runId,
    sanitizeMcpClientName(name),
  ]);
  if (updated.rowCount !== 1) throw new NotFoundError(`agent run ${runId} not found`);
}

/**
 * `forUpdate` row-locks the run so a concurrent change of `project_item_id`/`actor_user_id` waits for the
 * caller's transaction; approved-operation replay holds it across its provenance check and the operation. It
 * requires a `PoolClient`: on a bare `Pool` the lock would be released as soon as the statement auto-commits.
 */
export function getAgentRun(client: PoolClient, id: string, forUpdate: true): Promise<AgentRunRow | null>;
export function getAgentRun(client: Pool | PoolClient, id: string, forUpdate?: false): Promise<AgentRunRow | null>;
export async function getAgentRun(
  client: Pool | PoolClient,
  id: string,
  forUpdate = false,
): Promise<AgentRunRow | null> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getAgentRunsByIds(client: Pool | PoolClient, ids: string[]): Promise<AgentRunRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(mapRow);
}

export const AGENT_RUN_ROOT_MAX_HOPS = 32;

/**
 * Each level reads the parents of all still-climbing chains in one query, so the query count follows the deepest
 * chain, not the number of runs. A chain stops at an invisible parent or after `AGENT_RUN_ROOT_MAX_HOPS` (which
 * also ends a cycle); the run returned for a chain stopped early still names a parent.
 */
export async function getRootAgentRuns(
  client: Pool | PoolClient,
  runs: AgentRunRow[],
): Promise<Map<string, AgentRunRow>> {
  const reached = new Map(runs.map((run) => [run.id, run]));
  let climbing = runs.map((run) => run.id);
  for (let hop = 0; hop < AGENT_RUN_ROOT_MAX_HOPS && climbing.length > 0; hop += 1) {
    const parentIds = new Set(climbing.flatMap((runId) => reached.get(runId)?.parentRunId ?? []));
    const parents = new Map((await getAgentRunsByIds(client, [...parentIds])).map((run) => [run.id, run]));
    climbing = climbing.filter((runId) => {
      const parentId = reached.get(runId)?.parentRunId;
      const parent = parentId ? parents.get(parentId) : undefined;
      if (parent) reached.set(runId, parent);
      return parent !== undefined;
    });
  }
  return reached;
}

/** Heartbeat history is a query over agent_runs, not a separate log table. Without `limit`, the full history. */
export async function listAgentRunsByHeartbeat(
  client: Pool | PoolClient,
  heartbeatId: string,
  limit?: number,
): Promise<AgentRunRow[]> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE heartbeat_id = $1 ORDER BY started_at DESC` + (limit !== undefined ? ` LIMIT $2` : ``),
    limit !== undefined ? [heartbeatId, limit] : [heartbeatId],
  );
  return rows.map(mapRow);
}

type SempReplyStatus = "queued" | "running" | "done" | "error";

const SEMP_REPLY_STATUSES: readonly SempReplyStatus[] = ["queued", "running", "done", "error"];

/** The latest attempt of one assistant message of a user-started `session` run. */
export interface ProjectAgentRunAnswer {
  messageId: string;
  /** The message's `created_at` once retention removed the first event. */
  startedAt: string;
  durationMs: number | null;
  status: SempReplyStatus;
  errorCode: AgentRunErrorCode | null;
  /** Validated by `replyOutcomeOfStoredSteps`. */
  steps: unknown;
  attempt: number;
  userText: string | null;
  systemKey: string | null;
  threadKind: SempThreadKind;
}

/** Several rows of one chat run share the run's fields and differ in `answer`. */
export type ProjectAgentRunListEntry = AgentRunRow & { answer: ProjectAgentRunAnswer | null };

type ProjectAgentRunListDbRow = AgentRunDbRow & {
  answer_message_id: string | null;
  answer_started_at: Date | null;
  answer_duration_ms: number | null;
  answer_status: string | null;
  answer_error_code: string | null;
  answer_steps: unknown;
  answer_attempt: number | null;
  answer_user_text: string | null;
  answer_system_key: string | null;
  answer_thread_kind: string | null;
};

function runColumnsOf(alias: string): string {
  return AGENT_RUN_ROW_COLUMNS.split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");
}

function mapAnswer(row: ProjectAgentRunListDbRow): ProjectAgentRunAnswer | null {
  if (row.answer_message_id === null) return null;
  if (row.answer_started_at === null || row.answer_attempt === null) {
    throw new Error("Malformed answer in database row");
  }
  return {
    messageId: row.answer_message_id,
    startedAt: row.answer_started_at.toISOString(),
    durationMs: row.answer_duration_ms,
    status: assertKnownValue(SEMP_REPLY_STATUSES, row.answer_status ?? "null", "Semp message status"),
    errorCode:
      row.answer_error_code === null
        ? null
        : assertKnownValue(AGENT_RUN_ERROR_CODES, row.answer_error_code, "Semp message error_code"),
    steps: row.answer_steps,
    attempt: row.answer_attempt,
    userText: row.answer_user_text,
    systemKey: row.answer_system_key,
    threadKind: assertKnownValue(SEMP_THREAD_KINDS, row.answer_thread_kind ?? "null", "thread kind"),
  };
}

/**
 * Newest first (row start, then run id, then message id). Other actors' runs and `supervisor` sub-runs are
 * excluded.
 *
 * A multi-attempt heartbeat occurrence is one row: the highest `attempt`, then later `started_at`, then greater
 * `id` for determinism. Earlier attempts are dropped by a per-row probe of `agent_runs_occurrence_idx` before
 * `LIMIT` applies.
 *
 * A user-started `session` run with assistant messages is replaced by one row per answer, standing at its turn's
 * start. Attempts replying to the same message collapse into the highest `attempt`; a message replying to no
 * message is its own answer. A session run without assistant messages stays one row; one whose messages were all
 * replaced by attempts in other runs has none.
 *
 * Both row kinds are cut at `limit` separately, merged and cut again, so neither crowds out the other. Answers
 * are sorted by a start time no index covers, so all of the project's session answers are read for the sort.
 * Row-level security hides other tenants' projects, which return no rows.
 */
export async function listProjectAgentRuns(
  client: Pool | PoolClient,
  input: { projectItemId: string; actorUserId: string; limit: number },
): Promise<ProjectAgentRunListEntry[]> {
  const { rows } = await client.query<ProjectAgentRunListDbRow>(
    `WITH chat_runs AS (
       SELECT id, thread_id FROM agent_runs
       WHERE project_item_id = $1 AND actor_user_id = $2 AND triggered_by = 'user' AND unit = 'session'
     ),
     answers AS (
       SELECT m.id AS message_id, c.id AS run_id, COALESCE(first_event.at, m.created_at) AS started_at
       FROM chat_runs c
       JOIN semp_messages m ON m.thread_id = c.thread_id AND m.agent_run_id = c.id AND m.role = 'assistant'
       LEFT JOIN agent_run_events first_event ON first_event.id = m.event_from_id AND first_event.agent_run_id = c.id
       WHERE m.reply_to_message_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM semp_messages later
         JOIN chat_runs later_run ON later_run.id = later.agent_run_id
         WHERE later.thread_id = m.thread_id AND later.role = 'assistant'
           AND later.reply_to_message_id = m.reply_to_message_id AND later.attempt > m.attempt)
     ),
     page AS (
       SELECT * FROM (
         (SELECT ${runColumnsOf("r")}, NULL::uuid AS message_id, r.started_at AS row_started_at
          FROM agent_runs r
          WHERE r.project_item_id = $1 AND r.actor_user_id = $2 AND r.triggered_by <> 'supervisor'
            AND (r.heartbeat_occurrence_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM agent_runs later
              WHERE later.heartbeat_occurrence_id = r.heartbeat_occurrence_id
                AND (later.attempt, later.started_at, later.id) > (r.attempt, r.started_at, r.id)))
            AND NOT (r.unit = 'session' AND r.triggered_by = 'user' AND EXISTS (
              SELECT 1 FROM semp_messages own
              WHERE own.thread_id = r.thread_id AND own.agent_run_id = r.id AND own.role = 'assistant'))
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT $3)
         UNION ALL
         (SELECT ${runColumnsOf("r")}, top.message_id, top.started_at AS row_started_at
          FROM (SELECT message_id, run_id, started_at FROM answers
                ORDER BY started_at DESC, run_id DESC, message_id DESC
                LIMIT $3) top
          JOIN agent_runs r ON r.id = top.run_id)
       ) merged
       ORDER BY row_started_at DESC, id DESC, message_id DESC NULLS LAST
       LIMIT $3
     )
     SELECT ${runColumnsOf("p")},
            a.id AS answer_message_id, p.row_started_at AS answer_started_at, a.duration_ms AS answer_duration_ms,
            a.status AS answer_status, a.error_code AS answer_error_code, a.steps AS answer_steps,
            a.attempt AS answer_attempt,
            CASE WHEN replied.role = 'user' THEN replied.text END AS answer_user_text,
            CASE WHEN replied.role = 'system' THEN replied.system_key END AS answer_system_key,
            t.kind AS answer_thread_kind
     FROM page p
     LEFT JOIN semp_messages a ON a.id = p.message_id
     LEFT JOIN semp_messages replied ON replied.id = a.reply_to_message_id
     LEFT JOIN semp_threads t ON t.id = a.thread_id
     ORDER BY p.row_started_at DESC, p.id DESC, p.message_id DESC NULLS LAST`,
    [input.projectItemId, input.actorUserId, input.limit],
  );
  return rows.map((row) => ({ ...mapRow(row), answer: mapAnswer(row) }));
}

/** Ordered by occurrence, `attempt`, `started_at`, `id`. */
export async function listRunsOfOccurrences(
  client: Pool | PoolClient,
  occurrenceIds: readonly string[],
): Promise<AgentRunRow[]> {
  if (occurrenceIds.length === 0) return [];
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs
     WHERE heartbeat_occurrence_id = ANY($1::uuid[])
     ORDER BY heartbeat_occurrence_id, attempt, started_at, id`,
    [occurrenceIds],
  );
  return rows.map(mapRow);
}

/** The manual trigger reads it to refuse a second concurrent run. */
export async function getRunningAgentRunOfHeartbeat(
  client: Pool | PoolClient,
  heartbeatId: string,
): Promise<AgentRunRow | null> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE heartbeat_id = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [heartbeatId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Selects one dormant conversation's `unit='session'` runs for `listSessionAgentRunEventsFromLastCompaction`. */
export type SessionAgentRunsFilter =
  | {
      projectItemId: string;
      triggeredBy: TriggeredBy;
      /** `null` for Semp's own conversation; a supervisor run id for a delegated one. */
      parentRunId: string | null;
    }
  | {
      /**
       * A thread's main conversation. A delegated session inherits `thread_id` but has a `parent_run_id`, so it never
       * matches.
       */
      threadId: string;
      triggeredBy: "user";
      parentRunId: null;
    };

/** Orphans of a process restart. Startup repair calls it once per active tenant. */
export async function listRunningAgentRuns(client: Pool | PoolClient): Promise<AgentRunRow[]> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE status = 'running' ORDER BY started_at ASC`,
  );
  return rows.map(mapRow);
}
