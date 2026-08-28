import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";

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

export async function getAgentRun(client: Pool | PoolClient, id: string): Promise<AgentRunRow | null> {
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** The audit trail: run history for a heartbeat is a query over agent_runs, no second run-log table. */
export async function listAgentRunsByHeartbeat(client: Pool | PoolClient, heartbeatId: string): Promise<AgentRunRow[]> {
  const { rows } = await client.query(
    `SELECT id, project_item_id, parent_run_id, heartbeat_id, triggered_by, unit, task, status, result, started_at, finished_at
     FROM agent_runs WHERE heartbeat_id = $1 ORDER BY started_at DESC`,
    [heartbeatId],
  );
  return rows.map(mapRow);
}
