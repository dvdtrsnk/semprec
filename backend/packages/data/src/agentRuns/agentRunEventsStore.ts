import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";

export type AgentRunEventKind = "turn_start" | "message" | "tool_use" | "tool_result" | "turn_end" | "run_status" | "compaction";

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

function mapRow(row: {
  id: string;
  agent_run_id: string;
  kind: string;
  payload: unknown;
  at: Date;
}): AgentRunEventRow {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    kind: assertKnownValue(AGENT_RUN_EVENT_KINDS, row.kind, "kind"),
    payload: row.payload,
    at: row.at.toISOString(),
  };
}

/**
 * One row per turn_start/message/tool_use/tool_result/turn_end/run_status — never for
 * message_update deltas. 'compaction' is the one kind never written by the turn loop itself:
 * `@semprec/agent-runtime`'s reconstruction path (#119) inserts it directly, as a checkpoint
 * of a compacted `Entry[]` continuation.
 */
export async function insertAgentRunEvent(
  client: Pool | PoolClient,
  agentRunId: string,
  kind: AgentRunEventKind,
  payload: unknown,
): Promise<AgentRunEventRow> {
  const { rows } = await client.query(
    `INSERT INTO agent_run_events (agent_run_id, kind, payload)
     VALUES ($1, $2, $3)
     RETURNING id, agent_run_id, kind, payload, at`,
    [agentRunId, kind, JSON.stringify(payload)],
  );
  return mapRow(rows[0]);
}

/** Transcript reconstruction source: every row for a run, in monotonic event-id order. */
export async function listAgentRunEvents(client: Pool | PoolClient, agentRunId: string): Promise<AgentRunEventRow[]> {
  const { rows } = await client.query(
    `SELECT id, agent_run_id, kind, payload, at FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
    [agentRunId],
  );
  return rows.map(mapRow);
}

/**
 * Batch form of `listAgentRunEvents` for `@semprec/agent-runtime`'s reconstruction path (#119),
 * which otherwise issues one round trip per prior session run it walks. Ordered by
 * `(agent_run_id, id)` so a caller grouping by run still sees each run's own events in
 * monotonic order.
 */
export async function listAgentRunEventsByRunIds(client: Pool | PoolClient, agentRunIds: string[]): Promise<AgentRunEventRow[]> {
  if (agentRunIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT id, agent_run_id, kind, payload, at FROM agent_run_events WHERE agent_run_id = ANY($1) ORDER BY agent_run_id, id ASC`,
    [agentRunIds],
  );
  return rows.map(mapRow);
}
