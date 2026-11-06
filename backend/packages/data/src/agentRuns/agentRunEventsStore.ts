import type { Pool, PoolClient } from "pg";
import { requireSingleRow, runAfterCommit } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { notifyAgentRunEvent } from "../realtimeHook.js";
import type { SessionAgentRunsFilter } from "./agentRunsStore.js";

export type AgentRunEventKind =
  "turn_start" | "message" | "tool_use" | "tool_result" | "turn_end" | "run_status" | "compaction" | "user_message";

const AGENT_RUN_EVENT_KINDS: readonly AgentRunEventKind[] = [
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
  "compaction",
  "user_message",
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
 * One row per turn_start/user_message/message/tool_use/tool_result/turn_end/run_status — never for
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
  rowLimit?: number,
  scope?: { threadId: string; sempMessageId: string; throughEventId?: string },
): Promise<AgentRunEventRow[]> {
  if (rowLimit !== undefined && (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 257)) {
    throw new ValidationError("Invalid agent run event row limit");
  }
  if (scope !== undefined) {
    validateSempEventScope(scope);
    if (
      scope.throughEventId !== undefined &&
      (typeof scope.throughEventId !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(scope.throughEventId) ||
        BigInt(scope.throughEventId) > 9_223_372_036_854_775_807n)
    )
      throw new ValidationError("Invalid agent run event upper bound");
    const params: unknown[] = [agentRunId, afterEventId, scope.threadId, scope.sempMessageId];
    if (scope.throughEventId !== undefined) params.push(scope.throughEventId);
    if (rowLimit !== undefined) params.push(rowLimit);
    const { rows } = await client.query<AgentRunEventDbRow>(
      `SELECT e.id, e.agent_run_id, e.kind, e.payload, e.at
       FROM agent_run_events e
       JOIN semp_messages m ON m.tenant_id = e.tenant_id AND m.agent_run_id = e.agent_run_id
         AND m.thread_id = $3::uuid AND m.id = $4::uuid AND m.role = 'assistant'
       WHERE e.agent_run_id = $1 AND e.id > $2::bigint AND m.event_from_id IS NOT NULL
         AND e.id >= m.event_from_id
         AND ((m.status = 'running' AND m.event_to_id IS NULL)
           OR (m.status IN ('done', 'error') AND m.event_to_id IS NOT NULL AND e.id <= m.event_to_id))
         ${scope.throughEventId === undefined ? "" : "AND e.id <= $5::bigint"}
       ORDER BY e.id ASC${rowLimit === undefined ? "" : ` LIMIT $${scope.throughEventId === undefined ? 5 : 6}`}`,
      params,
    );
    return rows.map(mapRow);
  }
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id > $2::bigint
     ORDER BY id ASC${rowLimit === undefined ? "" : " LIMIT $3"}`,
    rowLimit === undefined ? [agentRunId, afterEventId] : [agentRunId, afterEventId, rowLimit],
  );
  return rows.map(mapRow);
}

/** Fetches one durable event only when it belongs to the run named by its thin realtime reference. */
export async function getAgentRunEventById(
  client: Pool | PoolClient,
  agentRunId: string,
  eventId: string,
  scope?: { threadId: string; sempMessageId: string },
): Promise<AgentRunEventRow | null> {
  if (scope !== undefined) {
    validateSempEventScope(scope);
    const { rows } = await client.query<AgentRunEventDbRow>(
      `SELECT e.id, e.agent_run_id, e.kind, e.payload, e.at
       FROM agent_run_events e
       JOIN semp_messages m ON m.tenant_id = e.tenant_id AND m.agent_run_id = e.agent_run_id
         AND m.thread_id = $3::uuid AND m.id = $4::uuid AND m.role = 'assistant'
       WHERE e.agent_run_id = $1 AND e.id = $2::bigint AND m.event_from_id IS NOT NULL
         AND e.id >= m.event_from_id
         AND ((m.status = 'running' AND m.event_to_id IS NULL)
           OR (m.status IN ('done', 'error') AND m.event_to_id IS NOT NULL AND e.id <= m.event_to_id))`,
      [agentRunId, eventId, scope.threadId, scope.sempMessageId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id = $2::bigint`,
    [agentRunId, eventId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

function validateSempEventScope(scope: { threadId: string; sempMessageId: string }): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !scope ||
    typeof scope.threadId !== "string" ||
    typeof scope.sempMessageId !== "string" ||
    !uuid.test(scope.threadId) ||
    !uuid.test(scope.sempMessageId)
  )
    throw new ValidationError("Invalid Semp event scope");
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
  bounds?: { maxRows: number; maxBytes: number },
): Promise<AgentRunEventRow[]> {
  // A thread's main conversation is keyed by `thread_id` (agent_runs_thread_wake_idx); the project-item
  // form never picks those runs up, so a thread's runs and a non-thread session of the same project
  // item stay separate conversations.
  const isThread = "threadId" in filter;
  const sessionRunsWhere = isThread
    ? `thread_id = $1 AND unit = 'session' AND triggered_by = 'user' AND parent_run_id IS NULL`
    : `project_item_id = $1 AND unit = 'session' AND triggered_by = $2 AND parent_run_id IS NOT DISTINCT FROM $3
       AND NOT (thread_id IS NOT NULL AND triggered_by = 'user' AND parent_run_id IS NULL)`;
  const params =
    "threadId" in filter ? [filter.threadId] : [filter.projectItemId, filter.triggeredBy, filter.parentRunId];
  if (bounds) {
    if (
      !("threadId" in filter) ||
      !Number.isSafeInteger(bounds.maxRows) ||
      bounds.maxRows < 1 ||
      !Number.isSafeInteger(bounds.maxBytes) ||
      bounds.maxBytes < 1
    )
      throw new Error("Invalid history bounds");
    const result = await client.query<{
      overflow: boolean;
      id: string | null;
      agent_run_id: string | null;
      kind: string | null;
      payload: unknown;
      at: Date | null;
    }>(
      `WITH session_runs AS MATERIALIZED (
         SELECT id, wake_seq FROM agent_runs WHERE ${sessionRunsWhere}
       ), latest_compaction AS (
         SELECT max(e.id) AS id FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id WHERE e.kind = 'compaction'
       ), candidates AS MATERIALIZED (
         SELECT e.id, e.agent_run_id, e.kind, e.at, r.wake_seq, octet_length(e.payload::text) AS bytes
         FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id
         WHERE e.id >= COALESCE((SELECT id FROM latest_compaction), 0)
         ORDER BY r.wake_seq, e.id LIMIT $2
       ), budget AS (
         SELECT count(*) > $3 OR COALESCE(sum(bytes), 0) > $4 AS overflow FROM candidates
       )
       SELECT budget.overflow, c.id, c.agent_run_id, c.kind, CASE WHEN budget.overflow THEN NULL ELSE e.payload END AS payload, c.at
       FROM budget LEFT JOIN candidates c ON NOT budget.overflow
       LEFT JOIN agent_run_events e ON e.id = c.id AND e.agent_run_id = c.agent_run_id
       ORDER BY c.wake_seq, c.id`,
      [filter.threadId, bounds.maxRows + 1, bounds.maxRows, bounds.maxBytes],
    );
    if (result.rows[0]?.overflow) throw new Error("Semp conversation history exceeds replay limits");
    return result.rows.flatMap((row) => {
      if (row.id === null) return [];
      if (row.agent_run_id === null || row.kind === null || row.at === null)
        throw new Error("Malformed conversation history row");
      return [mapRow({ id: row.id, agent_run_id: row.agent_run_id, kind: row.kind, payload: row.payload, at: row.at })];
    });
  }
  const { rows } = await client.query<AgentRunEventDbRow>(
    `WITH session_runs AS (
       SELECT id, wake_seq FROM agent_runs
       WHERE ${sessionRunsWhere}
     ),
     latest_compaction AS (
       SELECT max(e.id) AS id FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id WHERE e.kind = 'compaction'
     )
     SELECT e.id, e.agent_run_id, e.kind, e.payload, e.at
     FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id
     WHERE e.id >= COALESCE((SELECT id FROM latest_compaction), 0)
     ORDER BY r.wake_seq ASC, e.id ASC`,
    params,
  );
  return rows.map(mapRow);
}
