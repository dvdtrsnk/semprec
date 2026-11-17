import type { PoolClient } from "pg";
import type { AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import {
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getRetryChainFirstRunId,
} from "../agentRuns/agentRunsStore.js";
import { listSempTurnEvents } from "../agentRuns/agentRunEventsStore.js";
import { deriveReplyOutcome } from "../agentRuns/replyOutcome.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { requireSingleRow } from "../db/pool.js";
import { raiseAgentHeartbeatProblem, resolveAgentHeartbeatProblem, resolveAgentRunProblem } from "./agentProblems.js";
import { allocateSempMessageTimestamp } from "./sempMessageOrder.js";
import { sempMessageSearchVectorSql } from "./sempMessageSearch.js";
import { projectSempReplySteps } from "./sempReplySteps.js";

export interface TickThreadRef {
  id: string;
  tenantId: string;
  heartbeatId: string;
}

/**
 * `DO UPDATE` rather than `DO NOTHING` so a concurrent or repeated call gets the existing id back (and bumps
 * `last_activity_at`). Relies on the partial unique index `semp_threads_tick_heartbeat_uq`.
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

/** `null` while the heartbeat has not run; this read never creates the thread. */
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
 * Derived from the run's steps between `eventFromId` and `eventToId` as for a chat reply. The outcome depends
 * on nothing read from the call targets, so their lookup is skipped.
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
 * Closes a heartbeat run and writes its assistant message in the caller's transaction, so both land or neither.
 * An `error` outcome goes through `finishAgentRunWithErrorNotification`, keeping the notification and heartbeat
 * problem with the close. A `done` reply that left a failed tool call raises the heartbeat problem itself, since
 * no `agent_run_error` exists for it. Any other `done` resolves the heartbeat and retry-chain problems. Returns
 * `false` and writes nothing when another writer already closed the run.
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
  if (outcome.status === "done") {
    const leftFailedToolCall =
      written.event_from_id !== null &&
      written.event_to_id !== null &&
      (await replyLeftFailedToolCall(client, agentRunId, written.event_from_id, written.event_to_id));
    if (leftFailedToolCall) {
      const userId = await getTenantUserId(client);
      if (userId) {
        await raiseAgentHeartbeatProblem(client, {
          userId,
          heartbeatId: thread.heartbeatId,
          occurrenceKey: agentRunId,
        });
      }
    } else {
      await resolveAgentHeartbeatProblem(client, thread.heartbeatId);
      await resolveAgentRunProblem(client, await getRetryChainFirstRunId(client, agentRunId));
    }
  }
  await client.query(`UPDATE semp_threads SET last_activity_at = now() WHERE id = $1`, [thread.id]);
  publishSempThreadInvalidation(client, thread.tenantId, thread.id);
  return true;
}
