import type { Pool, PoolClient } from "pg";
import { requireSingleRow, runAfterCommit } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { notifyAgentRunEvent } from "../realtimeHook.js";
import { AGENT_RUN_STEP_EVENT_KINDS, AGENT_RUN_STEP_MAX_LIMIT, agentRunStepPageRowLimit } from "./agentRunStepPages.js";
import type { AgentRunRow, SessionAgentRunsFilter } from "./agentRunsStore.js";

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

/** Both ends inclusive; `throughEventId: null` is open at the end. */
export interface AgentRunEventRange {
  fromEventId: string;
  throughEventId: string | null;
}

export interface AgentRunEventRow {
  id: string;
  agentRunId: string;
  kind: AgentRunEventKind;
  payload: unknown;
  at: string;
}

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
 * UTF-8 bytes of the JSON payload. Reconstruction reads payloads in full, so an unbounded one (a huge MCP
 * `tool_result`) is rejected at the write; 1 MiB fits a `compaction` checkpoint, the largest legitimate payload.
 */
const MAX_AGENT_RUN_EVENT_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Never written for message_update deltas. `compaction` is inserted by the agent-runtime reconstruction path, not
 * the turn loop.
 *
 * A finished run accepts only its terminal `run_status` (written after the close); any other kind throws
 * `ConflictError`. The status check is part of the `INSERT`, so a concurrent close cannot slip in between.
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

/** Announces the thin reference only after commit, so callers never reuse a transaction-scoped client. */
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

/** In monotonic event-id order. */
export async function listAgentRunEvents(client: Pool | PoolClient, agentRunId: string): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
    [agentRunId],
  );
  return rows.map(mapRow);
}

/** `id` is a bigint kept as a string so a browser client never loses precision while resuming. */
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

/**
 * A turn that ended in an error stored no `event_to_id`; `throughEventId: null` then reads to the end of the run,
 * which is this turn's last event because the conversation takes the next message only after the error is stored.
 * User messages (user text) and compaction checkpoints (the largest payloads) are filtered out in SQL.
 */
export async function listSempTurnEvents(
  client: Pool | PoolClient,
  agentRunId: string,
  fromEventId: string,
  throughEventId: string | null,
): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id >= $2::bigint AND ($3::bigint IS NULL OR id <= $3::bigint)
       AND kind = ANY($4::text[])
     ORDER BY id ASC`,
    [agentRunId, fromEventId, throughEventId, ["turn_start", "turn_end", "message", "tool_use", "tool_result"]],
  );
  return rows.map(mapRow);
}

/**
 * Reads at most `agentRunStepPageRowLimit(stepLimit)` events: a step needs up to two, and the slack leaves room
 * for a block of parallel tool calls. With `range`, the cursor and limit work the same inside the range.
 */
export async function listAgentRunEventsForStepPage(
  client: Pool | PoolClient,
  agentRunId: string,
  afterEventId: string,
  stepLimit: number,
  range?: AgentRunEventRange,
): Promise<{ events: AgentRunEventRow[]; hasMore: boolean }> {
  if (!Number.isInteger(stepLimit) || stepLimit < 1 || stepLimit > AGENT_RUN_STEP_MAX_LIMIT) {
    throw new ValidationError("Invalid agent run step limit");
  }
  const rowLimit = agentRunStepPageRowLimit(stepLimit);
  const { rows } = await client.query<AgentRunEventDbRow>(
    `SELECT id, agent_run_id, kind, payload, at
     FROM agent_run_events
     WHERE agent_run_id = $1 AND id > $2::bigint AND kind = ANY($3::text[])
       AND ($5::bigint IS NULL OR id >= $5::bigint) AND ($6::bigint IS NULL OR id <= $6::bigint)
     ORDER BY id ASC LIMIT $4`,
    [
      agentRunId,
      afterEventId,
      AGENT_RUN_STEP_EVENT_KINDS,
      rowLimit + 1,
      range?.fromEventId ?? null,
      range?.throughEventId ?? null,
    ],
  );
  return { events: rows.slice(0, rowLimit).map(mapRow), hasMore: rows.length > rowLimit };
}

/**
 * Counted in SQL because a page holds only some of the run's events. An approval step is a result whose `details`
 * carry an `approvalRequestId`.
 */
export async function countAgentRunToolSteps(
  client: Pool | PoolClient,
  agentRunId: string,
  range?: AgentRunEventRange,
): Promise<{ toolCount: number; approvalCount: number }> {
  const { rows } = await client.query<{ tool_count: string; approval_count: string }>(
    `SELECT count(DISTINCT payload->>'toolCallId') AS tool_count,
            count(DISTINCT payload->>'toolCallId') FILTER (
              WHERE kind = 'tool_result'
                AND jsonb_typeof(payload #> '{result,details,approvalRequestId}') = 'string'
            ) AS approval_count
     FROM agent_run_events
     WHERE agent_run_id = $1 AND kind IN ('tool_use', 'tool_result')
       AND jsonb_typeof(payload->'toolCallId') = 'string'
       AND ($2::bigint IS NULL OR id >= $2::bigint) AND ($3::bigint IS NULL OR id <= $3::bigint)`,
    [agentRunId, range?.fromEventId ?? null, range?.throughEventId ?? null],
  );
  const row = requireSingleRow(rows, "agent run tool step counts");
  return { toolCount: Number(row.tool_count), approvalCount: Number(row.approval_count) };
}

/**
 * Truncated when the first stored event is not the opening `run_status` of `running` (retention keeps the
 * checkpoint but drops what precedes it). A finished run with no events is truncated; a running one is only about
 * to write its first.
 */
export async function isAgentRunHistoryTruncated(
  client: Pool | PoolClient,
  run: Pick<AgentRunRow, "id" | "status">,
): Promise<boolean> {
  const { rows } = await client.query<{ kind: string; status: string | null }>(
    `SELECT kind, payload->>'status' AS status FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC LIMIT 1`,
    [run.id],
  );
  const first = rows[0];
  if (!first) return run.status !== "running";
  return !(first.kind === "run_status" && first.status === "running");
}

/** Only when the event belongs to the run named by its realtime reference. */
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

/** A replaced message always has its run and range (`regenerateSempReply` requires them). */
const REPLACED_REPLY_RANGES = `SELECT agent_run_id, event_from_id, event_to_id FROM semp_messages
         WHERE thread_id = $1 AND role = 'assistant' AND replaced_by_message_id IS NOT NULL
           AND agent_run_id IS NOT NULL AND event_from_id IS NOT NULL AND event_to_id IS NOT NULL`;

/**
 * Event ids are a global monotonic `bigserial` and a conversation is woken strictly sequentially, so the `id >=`
 * checkpoint bound is exact. The result starts with the checkpoint row so the walk still resets on it; with no
 * checkpoint every session event is returned.
 *
 * For a thread, whole turns replaced by a regeneration are excluded before the limits apply. Compaction rows are
 * never inside such a range (regeneration is refused once a checkpoint follows the reply).
 */
export async function listSessionAgentRunEventsFromLastCompaction(
  client: Pool | PoolClient,
  filter: SessionAgentRunsFilter,
  bounds?: { maxRows: number; maxBytes: number },
): Promise<AgentRunEventRow[]> {
  // A thread's runs and a non-thread session of the same project item stay separate conversations.
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
       ), replaced AS MATERIALIZED (
         ${REPLACED_REPLY_RANGES}
       ), candidates AS MATERIALIZED (
         SELECT e.id, e.agent_run_id, e.kind, e.at, r.wake_seq, octet_length(e.payload::text) AS bytes
         FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id
         WHERE e.id >= COALESCE((SELECT id FROM latest_compaction), 0)
           AND NOT EXISTS (SELECT 1 FROM replaced x WHERE x.agent_run_id = e.agent_run_id AND e.id BETWEEN x.event_from_id AND x.event_to_id)
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
     )${isThread ? `, replaced AS (${REPLACED_REPLY_RANGES})` : ""}
     SELECT e.id, e.agent_run_id, e.kind, e.payload, e.at
     FROM agent_run_events e JOIN session_runs r ON r.id = e.agent_run_id
     WHERE e.id >= COALESCE((SELECT id FROM latest_compaction), 0)${
       isThread
         ? `
       AND NOT EXISTS (SELECT 1 FROM replaced x WHERE x.agent_run_id = e.agent_run_id AND e.id BETWEEN x.event_from_id AND x.event_to_id)`
         : ""
     }
     ORDER BY r.wake_seq ASC, e.id ASC`,
    params,
  );
  return rows.map(mapRow);
}
