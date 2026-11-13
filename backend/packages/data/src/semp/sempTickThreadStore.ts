import type { PoolClient } from "pg";
import type { AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { finishAgentRun, finishAgentRunWithErrorNotification } from "../agentRuns/agentRunsStore.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { requireSingleRow } from "../db/pool.js";
import { allocateSempMessageTimestamp } from "./sempMessageOrder.js";
import { sempMessageSearchVectorSql } from "./sempMessageSearch.js";

export interface TickThreadRef {
  id: string;
  tenantId: string;
}

/**
 * Returns the tick thread of a heartbeat, creating it on first use. `DO UPDATE` (not `DO NOTHING`)
 * so a concurrent or repeated call gets the existing row's id back; it also bumps
 * `last_activity_at`. Rides the partial unique index `semp_threads_tick_heartbeat_uq`.
 */
export async function getOrCreateTickThread(client: PoolClient, heartbeatId: string): Promise<TickThreadRef> {
  const { rows } = await client.query<{ id: string; tenant_id: string }>(
    `INSERT INTO semp_threads (kind, heartbeat_id)
     VALUES ('tick', $1)
     ON CONFLICT (tenant_id, heartbeat_id) WHERE kind = 'tick'
     DO UPDATE SET last_activity_at = now()
     RETURNING id, tenant_id`,
    [heartbeatId],
  );
  const row = requireSingleRow(rows, "semp_threads row");
  return { id: row.id, tenantId: row.tenant_id };
}

export type TickRunOutcome =
  { status: "done"; result: string | null } | { status: "error"; errorCode: AgentRunErrorCode };

/**
 * Closes a heartbeat run and writes its assistant message into the tick thread, in the caller's
 * transaction: either both land or neither does. An `error` outcome goes through
 * `finishAgentRunWithErrorNotification`, so the `agent_run_error` notification stays with the close.
 * When the run was already closed by another writer nothing is written and `false` is returned.
 * The message carries no error code yet; the reply error codes arrive with #1907.
 */
export async function finishTickRunWithMessage(
  client: PoolClient,
  input: { thread: TickThreadRef; agentRunId: string; outcome: TickRunOutcome },
): Promise<boolean> {
  const { thread, agentRunId, outcome } = input;
  const closed =
    outcome.status === "done"
      ? await finishAgentRun(client, agentRunId, "done", outcome.result)
      : await finishAgentRunWithErrorNotification(client, agentRunId, outcome.errorCode);
  if (!closed) return false;
  const createdAt = await allocateSempMessageTimestamp(client, thread.id);
  await client.query(
    `INSERT INTO semp_messages (thread_id, role, text, search_vector, agent_run_id, event_from_id, event_to_id, status, created_at)
     SELECT $1, 'assistant', $2::text, ${sempMessageSearchVectorSql("$2::text")}, $3, MIN(e.id), MAX(e.id), $4, $5::timestamptz
     FROM (SELECT 1) AS one
     LEFT JOIN agent_run_events e ON e.agent_run_id = $3`,
    [thread.id, outcome.status === "done" ? outcome.result : null, agentRunId, outcome.status, createdAt],
  );
  await client.query(`UPDATE semp_threads SET last_activity_at = now() WHERE id = $1`, [thread.id]);
  publishSempThreadInvalidation(client, thread.tenantId, thread.id);
  return true;
}
