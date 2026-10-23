import type { Pool, PoolClient } from "pg";
import { requireSingleRow, runAfterCommit } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { notifyAgentRunEvent } from "../realtimeHook.js";
import type { SessionAgentRunsFilter } from "./agentRunsStore.js";

export type AgentRunEventKind =
  "turn_start" | "message" | "tool_use" | "tool_result" | "turn_end" | "run_status" | "compaction";

const AGENT_RUN_EVENT_KINDS: readonly AgentRunEventKind[] = [
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
  "compaction",
];

export interface AgentRunEventRow {
  id: string;
  agentRunId: string;
  kind: AgentRunEventKind;
  payload: unknown;
  at: string;
}

/** The raw `agent_run_events` row shape this module reads back from Postgres. */
type AgentRunEventDbRow = { id: string; agent_run_id: string; kind: string; payload: unknown; at: Date };

function mapRow(row: AgentRunEventDbRow): AgentRunEventRow {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    kind: assertKnownValue(AGENT_RUN_EVENT_KINDS, row.kind, "kind"),
    payload: row.payload,
    at: row.at.toISOString(),
  };
}

/**
 * The bound on one `agent_run_events.payload`, measured as UTF-8 bytes of its JSON
 * serialization. Every reconstruction reads a run's payloads back in full, so an unbounded one
 * (an arbitrarily large MCP `tool_result`) is rejected at the write. 1 MiB is sized so a
 * `compaction` checkpoint — the largest legitimate payload — fits.
 */
const MAX_AGENT_RUN_EVENT_PAYLOAD_BYTES = 1024 * 1024;

/**
 * One row per turn_start/message/tool_use/tool_result/turn_end/run_status — never for
 * message_update deltas. 'compaction' is the one kind never written by the turn loop itself:
 * `@semprec/agent-runtime`'s reconstruction path (#119) inserts it directly, as a checkpoint
 * of a compacted `Entry[]` continuation.
 *
 * A finished (`done`/`error`) run's transcript is complete, so only its terminal `run_status`
 * event — written after the close by design — may still be appended; any other kind throws
 * `ConflictError`. The status check is part of the `INSERT` itself, so a close committed
 * concurrently cannot slip in between a check and the write. An unknown run id throws
 * `NotFoundError`, and a payload over `MAX_AGENT_RUN_EVENT_PAYLOAD_BYTES` throws
 * `ValidationError` before any query runs.
 */
export async function insertAgentRunEvent(
  client: Pool | PoolClient,
  agentRunId: string,
  kind: AgentRunEventKind,
  payload: unknown,
): Promise<AgentRunEventRow> {
  const serialized = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  if (payloadBytes > MAX_AGENT_RUN_EVENT_PAYLOAD_BYTES) {
    throw new ValidationError(
      `agent run event '${kind}' payload is ${payloadBytes} bytes, over the ${MAX_AGENT_RUN_EVENT_PAYLOAD_BYTES}-byte cap`,
    );
  }
  const { rows } = await client.query<AgentRunEventDbRow>(
    `INSERT INTO agent_run_events (agent_run_id, kind, payload)
     SELECT $1::uuid, $2::text, $3::jsonb FROM agent_runs WHERE id = $1::uuid AND (status = 'running' OR $2::text = 'run_status')
     RETURNING id, agent_run_id, kind, payload, at`,
    [agentRunId, kind, serialized],
  );
  if (rows.length > 0) return mapRow(requireSingleRow(rows, "agent_run_events row"));
  const { rows: runRows } = await client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [
    agentRunId,
  ]);
  const run = runRows[0];
  if (!run) throw new NotFoundError(`agent run ${agentRunId} not found`);
  throw new ConflictError(
    `agent run ${agentRunId} is ${run.status}; only run_status events may be appended to a finished run`,
  );
}

/**
 * Appends one durable event and announces its thin reference only after the surrounding
 * transaction commits. The hook belongs to this data owner: realtime wires it to Postgres
 * NOTIFY, so callers never receive or reuse a transaction-scoped client after commit.
 */
export async function insertAndNotifyAgentRunEvent(
  client: Pool | PoolClient,
  agentRunId: string,
  kind: AgentRunEventKind,
  payload: unknown,
): Promise<AgentRunEventRow> {
  const event = await insertAgentRunEvent(client, agentRunId, kind, payload);
  const notify = () => notifyAgentRunEvent({ agentRunId, eventId: event.id });
  if ("release" in client) runAfterCommit(client, notify);
  else notify();
  return event;
}

/** Transcript reconstruction source: every row for a run, in monotonic event-id order. */
export async function listAgentRunEvents(client: Pool | PoolClient, agentRunId: string): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
    [agentRunId],
  );
  return rows.map(mapRow);
}

/**
 * The cursor form used by a realtime agent-run watcher. `id` is a Postgres bigint and is kept as
 * a string at the TypeScript boundary so a browser client never loses precision while resuming.
 */
export async function listAgentRunEventsAfter(
  client: Pool | PoolClient,
  agentRunId: string,
  afterEventId: string,
): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id > $2::bigint
     ORDER BY id ASC`,
    [agentRunId, afterEventId],
  );
  return rows.map(mapRow);
}

/** Fetches one durable event only when it belongs to the run named by its thin realtime reference. */
export async function getAgentRunEventById(
  client: Pool | PoolClient,
  agentRunId: string,
  eventId: string,
): Promise<AgentRunEventRow | null> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id = $2::bigint`,
    [agentRunId, eventId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Reconstruction source for `@semprec/agent-runtime`'s `walkStoredEntries` (#119): every event of
 * one dormant conversation's `unit='session'` runs, bounded to the tail after the latest
 * `compaction` checkpoint. Event ids are a global monotonic `bigserial` and one conversation is
 * woken strictly sequentially, so every event after the latest checkpoint has a larger id than
 * the checkpoint and every event before it a smaller one — the `id >=` bound is therefore exact,
 * not an approximation. The result starts with the `compaction` row itself (when any exists) so
 * the caller's walk still resets on it; with no checkpoint, `COALESCE(..., 0)` returns every
 * event of every session run. Uses `agent_runs_session_wake_idx` (migration 0017) and
 * `agent_run_events_run_idx` (migration 0015).
 */
export async function listSessionAgentRunEventsFromLastCompaction(
  client: Pool | PoolClient,
  filter: SessionAgentRunsFilter,
): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `WITH session_runs AS (
       SELECT id, wake_seq FROM agent_runs
       WHERE project_item_id = $1 AND unit = 'session' AND triggered_by = $2 AND parent_run_id IS NOT DISTINCT FROM $3
     ),
     latest_compaction AS (
       SELECT max(e.id) AS id FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id WHERE e.kind = 'compaction'
     )
     SELECT e.id, e.agent_run_id, e.kind, e.payload, e.at
     FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id
     WHERE e.id >= COALESCE((SELECT id FROM latest_compaction), 0)
     ORDER BY r.wake_seq ASC, e.id ASC`,
    [filter.projectItemId, filter.triggeredBy, filter.parentRunId],
  );
  return rows.map(mapRow);
}
