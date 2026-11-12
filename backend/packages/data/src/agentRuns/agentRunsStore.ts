import { Pool, type PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { withTransaction, requireSingleRow } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { AGENT_RUN_ERROR_CODES, type AgentRunErrorCode } from "./agentRunErrorCodes.js";

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
  /** The run this one retries (issue #1448); `null` for a run that is not a retry. */
  retryOfRunId: string | null;
  /** The attempt number: 1 unless the creator gave another one (issue #1448). */
  attempt: number;
  /** The scheduled heartbeat occurrence this run was started for (issue #1458); `null` for a manual or item-event run. */
  heartbeatOccurrenceId: string | null;
  /** The Semp thread this run belongs to (issue #1452); `null` for an MCP run or a run with no thread. */
  threadId: string | null;
  triggeredBy: TriggeredBy;
  unit: AgentRunUnit;
  task: string;
  status: AgentRunStatus;
  result: string | null;
  /** Why the run failed: set for `status = 'error'` (a row closed before the column existed reads `internal`), `null` otherwise. */
  errorCode: AgentRunErrorCode | null;
  /** Plain object of ids and counters (no user content) a closer attached to the failure, if any. */
  errorDetail: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * The user this run's writes are attributed to (issue #220) — the authenticated session user
   * for a user-triggered root run that supplied one (`CreateAgentRunInput.userId`), the
   * current tenant's user for a root run with none to capture (`getTenantUserId` — a
   * heartbeat/system-triggered run has no session), and copied from the parent run for every
   * delegated (`parentRunId` set) run. The AgentTool composition root (#220) derives an agent
   * actor's `userId` from this column alone, never from tool input.
   */
  actorUserId: string;
}

/** The raw `agent_runs` row shape this module reads back from Postgres. */
type AgentRunDbRow = {
  id: string;
  project_item_id: string | null;
  parent_run_id: string | null;
  heartbeat_id: string | null;
  retry_of_run_id: string | null;
  heartbeat_occurrence_id: string | null;
  attempt: number;
  thread_id: string | null;
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
  "id, project_item_id, parent_run_id, heartbeat_id, retry_of_run_id, attempt, heartbeat_occurrence_id, thread_id, triggered_by, unit, task, status, result, error_code, error_detail, started_at, finished_at, actor_user_id";

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
  /** The run this one retries (issue #1448). Defaults to null; `createChainedAgentRun` requires it. */
  retryOfRunId?: string | null;
  /** The attempt number (issue #1448). Defaults to 1. */
  attempt?: number;
  /** The scheduled heartbeat occurrence the run is started for (issue #1458). Defaults to null. */
  heartbeatOccurrenceId?: string | null;
  /**
   * The Semp thread the run belongs to (issue #1452). When omitted and `parentRunId` is set, the
   * store copies the parent run's `thread_id`, so every delegation path inherits it; an MCP run
   * leaves it unset and stays NULL.
   */
  threadId?: string | null;
  triggeredBy: TriggeredBy;
  unit?: AgentRunUnit;
  task: string;
  /**
   * The authenticated session user creating this root run (issue #220, AC11). Optional for every
   * root run, including a `triggeredBy: "user"` one: when supplied, `actor_user_id` reflects who
   * actually asked for the run; when omitted, the store falls back to the current
   * tenant's user (`getTenantUserId`). Ignored for a delegated run (`parentRunId` set), which always inherits
   * its parent's `actorUserId` instead.
   */
  userId?: string;
}

/**
 * A delegated run (`parentRunId` set) inherits its supervisor's `actorUserId` unchanged. A root
 * run (no parent) uses `userId` when the caller supplied one — the authenticated session user
 * that actually triggered it (issue #220, AC11) — and falls back to the current
 * tenant's user (`getTenantUserId`) only when it didn't, which is correct for every root producer with no
 * session to capture (a heartbeat/system-triggered run). Throws if neither resolves to a user,
 * since a run with no attributable actor can never pass #220's AgentTool actor-derivation
 * invariant.
 */
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
  return mapRow(requireSingleRow(rows, "agent_runs row"));
}

/**
 * Creates the retry of `input.retryOfRunId` and returns it, or `null` when that run was already
 * retried. The unique key on `(tenant_id, retry_of_run_id)` decides this inside the insert
 * (`ON CONFLICT DO NOTHING`), so of two concurrent callers exactly one gets a row. The new run
 * takes its `actor_user_id` from the retried run. Throws `NotFoundError` when the retried run does
 * not exist in the current tenant.
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
  if (rows[0]) return mapRow(rows[0]);
  if (!(await getAgentRun(client, input.retryOfRunId))) {
    throw new NotFoundError(`Agent run '${input.retryOfRunId}' not found`);
  }
  return null;
}

/** The id of the run that retries `runId`, or `null` when it was not retried. */
export async function getRetrySuccessorId(client: Pool | PoolClient, runId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM agent_runs WHERE retry_of_run_id = $1", [runId]);
  return rows[0]?.id ?? null;
}

/**
 * The run of a heartbeat occurrence with the highest `attempt` (ties by `started_at`), or `null`
 * when no run was started for it yet (issue #1458).
 */
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

/**
 * Closes a run that is still `running` and reports whether this call did it. The `status =
 * 'running'` guard lives in the `UPDATE` itself, so of two concurrent closers exactly one wins
 * and the row keeps the first status, result and `finished_at`. Losing that race (the run was
 * already `done`/`error`) is a normal outcome the caller logs, not an error: it returns `false`.
 * Throws `NotFoundError` only when no run with that id exists at all.
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
  result: string | null,
  errorCode: AgentRunErrorCode,
  errorDetail?: Record<string, unknown>,
): Promise<boolean>;
export async function finishAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "done" | "error",
  result: string | null,
  errorCode?: AgentRunErrorCode,
  errorDetail?: Record<string, unknown>,
): Promise<boolean> {
  const detail = parseErrorDetail(errorDetail ?? null);
  const updated = await client.query(
    `UPDATE agent_runs SET status = $2, result = $3, error_code = $4, error_detail = $5, finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [agentRunId, status, result, status === "error" ? (errorCode ?? null) : null, detail],
  );
  if (updated.rowCount === 1) return true;
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [agentRunId]);
  if (rows.length === 0) throw new NotFoundError(`agent run ${agentRunId} not found`);
  return false;
}

/**
 * `finishAgentRun(..., "error", ...)` plus the reference `agent_run_error` notification (issue
 * #149), in the same transaction — every producer that closes a run as `error` (startup-sweep
 * repair, a budget rejection or any other unrecoverable failure surfacing from the model call,
 * a heartbeat-triggered run) calls this one function instead of `finishAgentRun` directly, so the
 * kind has exactly one producer path regardless of how many call sites reach it.
 *
 * `transitionInstance` is the run's own id: an `agent_runs` row finishes at most once (its
 * `status` only ever leaves `running` a single time), so replaying the same close — a retried
 * caller after a crash before it observed success — is necessarily the same transition, while a
 * different run failing always has a different id.
 *
 * Returns `finishAgentRun`'s result: when the close lost to another writer (`false`), the run's
 * outcome was already decided elsewhere and no notification is written.
 *
 * Silently skips the notification when the current tenant has no user, matching
 * `notifyHeartbeatError`.
 */
export async function finishAgentRunWithErrorNotification(
  client: Pool | PoolClient,
  agentRunId: string,
  result: string | null,
  errorCode: AgentRunErrorCode,
  errorDetail?: Record<string, unknown>,
): Promise<boolean> {
  // `writeNotification` requires an actual transaction client (it's meant to run alongside the
  // source write it dedupes against) — a caller that only has a bare `pool` gets one opened here
  // so the close and the notification still land atomically together.
  if (client instanceof Pool) {
    return withTransaction(client, (c) =>
      finishAgentRunWithErrorNotification(c, agentRunId, result, errorCode, errorDetail),
    );
  }
  const closed = await finishAgentRun(client, agentRunId, "error", result, errorCode, errorDetail);
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
  return true;
}

/**
 * `forUpdate` row-locks the run so a concurrent write to its `project_item_id`/`actor_user_id`
 * blocks until the caller's transaction commits or rolls back — `replayApprovedGenericOperation`
 * holds this lock across its provenance check and the operation it re-checks provenance for, so
 * the two can't be split by a race. `forUpdate: true` requires a `PoolClient`, not the broader
 * `Pool | PoolClient`, matching `getTaskRecurrence`'s two-overload pattern: `FOR UPDATE` against a
 * bare `Pool` acquires and immediately auto-commit-releases the lock on that single statement,
 * silently defeating the whole point of locking.
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

/** The batched form of `getAgentRun` — for resolving a set of runs (e.g. the approval queue's source-run links) in one query instead of one per row. */
export async function getAgentRunsByIds(client: Pool | PoolClient, ids: string[]): Promise<AgentRunRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(mapRow);
}

/** How many parent hops `getRootAgentRuns` follows for one run before it stops climbing. */
export const AGENT_RUN_ROOT_MAX_HOPS = 32;

/**
 * The root run of each of `runs`, keyed by the id of the given run: the run reached by following
 * `parent_run_id` until a run has no parent. A run without a parent is its own root.
 *
 * The walk has the loop shape of
 * `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md` (one read per level, a
 * missing link stops the walk instead of failing it), for many runs at once: each level reads the
 * parents of all chains that are still climbing in one query, so the number of queries follows the
 * depth of the deepest chain and not the number of runs. A chain stops at the last run it reached
 * when that run's parent is not visible, and after `AGENT_RUN_ROOT_MAX_HOPS` hops. The hop limit
 * stands in for that decision's visited set: it also ends a cycle. The run returned for a chain
 * that stopped early still names a parent.
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

/**
 * The audit trail: run history for a heartbeat is a query over agent_runs, no second
 * run-log table. `limit`, when given, bounds the result to the most recent N runs
 * (issue #135's `heartbeat.history`) — omitted, the call returns the full history, as
 * every caller before that issue relied on.
 */
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

/**
 * The most recently started run of a heartbeat whose `status` is still `running`, or `null`. The
 * manual trigger (issue #1453) reads it to refuse a second run while this one is active.
 */
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

/**
 * Identifies one dormant conversation's `unit='session'` runs — the filter both Semp's own
 * conversation (#118, `triggered_by='user'`, `parent_run_id` null) and a delegated one (#229,
 * `triggered_by='supervisor'`, `parent_run_id` the supervisor run that key's `DelegationRegistry`
 * entry belongs to) pass to `@semprec/data`'s `listSessionAgentRunEventsFromLastCompaction`
 * (`agentRunEventsStore.ts`) to rebuild an `Entry[]` tree for a freshly woken session (#119).
 */
export type SessionAgentRunsFilter =
  | {
      projectItemId: string;
      triggeredBy: TriggeredBy;
      /** `null` for Semp's own conversation (never delegated); a supervisor run id for a delegated one. */
      parentRunId: string | null;
    }
  | {
      /**
       * A thread's main conversation (#1560): the user runs of `threadId` with no parent. A delegated
       * session inherits `thread_id` (#1452) but has a `parent_run_id`, so it never matches this form.
       */
      threadId: string;
      triggeredBy: "user";
      parentRunId: null;
    };

/**
 * Every run still marked `running` that is visible in the current tenant scope — orphaned after a
 * process restart, since the in-memory session registry that would otherwise be driving them is
 * gone. Startup repair (`@semprec/agent-runtime`'s `repairInterruptedRuns`) is the only caller and
 * calls it once per active tenant.
 */
export async function listRunningAgentRuns(client: Pool | PoolClient): Promise<AgentRunRow[]> {
  const { rows } = await client.query<AgentRunDbRow>(
    `SELECT ${AGENT_RUN_ROW_COLUMNS}
     FROM agent_runs WHERE status = 'running' ORDER BY started_at ASC`,
  );
  return rows.map(mapRow);
}
