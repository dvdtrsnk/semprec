import type { PoolClient } from "pg";
import type { AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { finishAgentRun, finishAgentRunWithErrorNotification } from "../agentRuns/agentRunsStore.js";
import { listSempTurnEvents } from "../agentRuns/agentRunEventsStore.js";
import { deriveReplyOutcome } from "../agentRuns/replyOutcome.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { requireSingleRow } from "../db/pool.js";
import { raiseAgentHeartbeatProblem } from "./agentProblems.js";
import { allocateSempMessageTimestamp } from "./sempMessageOrder.js";
import { sempMessageSearchVectorSql } from "./sempMessageSearch.js";
import { projectSempReplySteps } from "./sempReplySteps.js";

export interface TickThreadRef {
  id: string;
  tenantId: string;
  heartbeatId: string;
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
  return { id: row.id, tenantId: row.tenant_id, heartbeatId };
}

/**
 * The tick thread of a heartbeat, or `null` while the heartbeat has not run: the thread is created by
 * `getOrCreateTickThread` when a run starts, and this read never creates it.
 */
export async function findTickThread(client: PoolClient, heartbeatId: string): Promise<TickThreadRef | null> {
  const { rows } = await client.query<{ id: string; tenant_id: string }>(
    "SELECT id, tenant_id FROM semp_threads WHERE kind = 'tick' AND heartbeat_id = $1",
    [heartbeatId],
  );
  const row = rows[0];
  return row ? { id: row.id, tenantId: row.tenant_id, heartbeatId } : null;
}

export type TickRunOutcome =
  { status: "done"; result: string | null } | { status: "error"; errorCode: AgentRunErrorCode };

/**
 * Whether the reply the run wrote left a failed tool call (issue #1890's `deriveReplyOutcome`), derived from
 * the steps of the run's events between `eventFromId` and `eventToId` as a chat reply's steps are. Nothing the
 * outcome depends on (status, operation, tool, error code, MCP registration) is read from the targets the
 * calls point at, so the lookup of them is left out.
 */
async function replyLeftFailedToolCall(
  client: PoolClient,
  agentRunId: string,
  eventFromId: string,
  eventToId: string,
): Promise<boolean> {
  const events = await listSempTurnEvents(client, agentRunId, eventFromId, eventToId);
  const steps = projectSempReplySteps({
    events,
    targets: { items: new Map(), databases: new Map(), properties: new Map() },
  });
  return deriveReplyOutcome(steps).outcome === "incomplete";
}

/**
 * Closes a heartbeat run and writes its assistant message into the tick thread, in the caller's
 * transaction: either both land or neither does. An `error` outcome goes through
 * `finishAgentRunWithErrorNotification`, so the `agent_run_error` notification and the heartbeat's problem
 * (issue #1911) stay with the close. A `done` outcome whose reply left a failed tool call raises the same
 * heartbeat problem with the message write, because no `agent_run_error` appears for a run that ended `done`
 * (the tenant's user is who it is shown to; a tenant with none raises nothing, as for the notification).
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
  const { rows } = await client.query<{ event_from_id: string | null; event_to_id: string | null }>(
    `INSERT INTO semp_messages (thread_id, role, text, search_vector, agent_run_id, event_from_id, event_to_id, status, created_at)
     SELECT $1, 'assistant', $2::text, ${sempMessageSearchVectorSql("$2::text")}, $3, MIN(e.id), MAX(e.id), $4, $5::timestamptz
     FROM (SELECT 1) AS one
     LEFT JOIN agent_run_events e ON e.agent_run_id = $3
     RETURNING event_from_id, event_to_id`,
    [thread.id, outcome.status === "done" ? outcome.result : null, agentRunId, outcome.status, createdAt],
  );
  const written = requireSingleRow(rows, "semp_messages row");
  if (outcome.status === "done" && written.event_from_id !== null && written.event_to_id !== null) {
    if (await replyLeftFailedToolCall(client, agentRunId, written.event_from_id, written.event_to_id)) {
      const userId = await getTenantUserId(client);
      if (userId) {
        await raiseAgentHeartbeatProblem(client, {
          userId,
          heartbeatId: thread.heartbeatId,
          occurrenceKey: agentRunId,
        });
      }
    }
  }
  await client.query(`UPDATE semp_threads SET last_activity_at = now() WHERE id = $1`, [thread.id]);
  publishSempThreadInvalidation(client, thread.tenantId, thread.id);
  return true;
}
