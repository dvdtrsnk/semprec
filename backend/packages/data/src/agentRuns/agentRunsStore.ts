import { Pool, type PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { getEarliestUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { withTransaction } from "../db/pool.js";

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
  triggeredBy: TriggeredBy;
  unit: AgentRunUnit;
  task: string;
  status: AgentRunStatus;
  result: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function mapRow(row: {
  id: string;
  project_item_id: string | null;
  parent_run_id: string | null;
  heartbeat_id: string | null;
  triggered_by: string;
  unit: string;
  task: string;
  status: string;
  result: string | null;
  started_at: Date;
  finished_at: Date | null;
}): AgentRunRow {
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    parentRunId: row.parent_run_id,
    heartbeatId: row.heartbeat_id,
    triggeredBy: assertKnownValue(TRIGGERED_BY_VALUES, row.triggered_by, "triggered_by"),
    unit: assertKnownValue(AGENT_RUN_UNITS, row.unit, "unit"),
    task: row.task,
    status: assertKnownValue(AGENT_RUN_STATUSES, row.status, "status"),
    result: row.result,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export interface CreateAgentRunInput {
  projectItemId?: string | null;
  parentRunId?: string | null;
  heartbeatId?: string | null;
  triggeredBy: TriggeredBy;
  unit?: AgentRunUnit;
  task: string;
}

export async function createAgentRun(client: Pool | PoolClient, input: CreateAgentRunInput): Promise<AgentRunRow> {
  const { rows } = await client.query(
    `INSERT INTO agent_runs (project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at`,
    [
      input.projectItemId ?? null,
      input.parentRunId ?? null,
      input.heartbeatId ?? null,
      input.triggeredBy,
      input.unit ?? "invocation",
      input.task,
    ],
  );
  return mapRow(rows[0]);
}

export async function finishAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "done" | "error",
  result: string | null,
): Promise<void> {
  await client.query(`UPDATE agent_runs SET status = $2, result = $3, finished_at = now() WHERE id = $1`, [
    agentRunId,
    status,
    result,
  ]);
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
 * Silently skips the notification before any account exists (setup not run yet), matching
 * `notifyHeartbeatError`.
 */
export async function finishAgentRunWithErrorNotification(
  client: Pool | PoolClient,
  agentRunId: string,
  result: string | null,
): Promise<void> {
  // `writeNotification` requires an actual transaction client (it's meant to run alongside the
  // source write it dedupes against) — a caller that only has a bare `pool` gets one opened here
  // so the close and the notification still land atomically together.
  if (client instanceof Pool) {
    await withTransaction(client, (c) => finishAgentRunWithErrorNotification(c, agentRunId, result));
    return;
  }
  await finishAgentRun(client, agentRunId, "error", result);
  const userId = await getEarliestUserId(client);
  if (!userId) return;
  await writeNotification(client, {
    userId,
    kind: "agent_run_error",
    linkHref: `?page=agent-run&id=${agentRunId}`,
    sourceTable: "agent_runs",
    sourceId: agentRunId,
    transitionInstance: agentRunId,
  });
}

export async function getAgentRun(client: Pool | PoolClient, id: string): Promise<AgentRunRow | null> {
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** The batched form of `getAgentRun` — for resolving a set of runs (e.g. the approval queue's source-run links) in one query instead of one per row. */
export async function getAgentRunsByIds(client: Pool | PoolClient, ids: string[]): Promise<AgentRunRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(mapRow);
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
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE heartbeat_id = $1 ORDER BY started_at DESC` + (limit !== undefined ? ` LIMIT $2` : ``),
    limit !== undefined ? [heartbeatId, limit] : [heartbeatId],
  );
  return rows.map(mapRow);
}

export interface SessionAgentRunsFilter {
  projectItemId: string;
  triggeredBy: TriggeredBy;
  /** `null` for Semp's own conversation (never delegated); a supervisor run id for a delegated one. */
  parentRunId: string | null;
}

/**
 * Every `unit='session'` run belonging to one dormant conversation, in the order they were
 * woken — the reconstruction source both Semp's own conversation (#118, `triggered_by='user'`,
 * `parent_run_id` null) and a delegated one (#229, `triggered_by='supervisor'`, `parent_run_id`
 * the supervisor run that key's `DelegationRegistry` entry belongs to) walk to rebuild an
 * `Entry[]` tree for a freshly woken session (#119).
 */
export async function listSessionAgentRuns(
  client: Pool | PoolClient,
  filter: SessionAgentRunsFilter,
): Promise<AgentRunRow[]> {
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs
     WHERE project_item_id = $1 AND unit = 'session' AND triggered_by = $2 AND parent_run_id IS NOT DISTINCT FROM $3
     ORDER BY wake_seq ASC`,
    [filter.projectItemId, filter.triggeredBy, filter.parentRunId],
  );
  return rows.map(mapRow);
}

/**
 * Every run still marked `running` — orphaned after a process restart, since the
 * in-memory session registry that would otherwise be driving them is gone. Startup
 * repair (`@semprec/agent-runtime`'s `repairInterruptedRuns`) is the only caller.
 */
export async function listRunningAgentRuns(client: Pool | PoolClient): Promise<AgentRunRow[]> {
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE status = 'running' ORDER BY started_at ASC`,
  );
  return rows.map(mapRow);
}
