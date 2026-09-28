import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

/**
 * #620: a row is `reserved` at the caller's estimate before the provider call, then either
 * `settled` with the real usage or `failed` at cost 0 when the call rejects.
 */
export type AiGatewayCallStatus = "reserved" | "settled" | "failed";

const AI_GATEWAY_CALL_STATUSES: readonly AiGatewayCallStatus[] = ["reserved", "settled", "failed"];

export interface AiGatewayCallRow {
  id: string;
  at: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number;
  agentRunId: string | null;
  /** Set only by #215's `POST /internal/complete` route; null for every other caller. */
  projectItemId: string | null;
  operation: string | null;
  status: AiGatewayCallStatus;
}

export interface RecordTokenCallInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentRunId?: string | null;
  /** #215: always set together, or not at all — the structured-completion route sets both. */
  projectItemId?: string | null;
  operation?: string | null;
}

/** Audio calls never carry an agent_run_id — there is no agent-run attribution for transcription/diarization. */
export interface RecordAudioCallInput {
  provider: string;
  model: string;
  audioSeconds: number;
  costUsd: number;
}

/** The raw `ai_gateway_calls` row shape this module reads back from Postgres. */
type AiGatewayCallDbRow = {
  id: string;
  at: Date;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: string | null;
  cost_usd: string;
  agent_run_id: string | null;
  project_item_id: string | null;
  operation: string | null;
  status: string;
};

function mapRow(row: AiGatewayCallDbRow): AiGatewayCallRow {
  return {
    id: row.id,
    at: row.at.toISOString(),
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
    costUsd: Number(row.cost_usd),
    agentRunId: row.agent_run_id,
    projectItemId: row.project_item_id,
    operation: row.operation,
    status: assertKnownValue(AI_GATEWAY_CALL_STATUSES, row.status, "ai_gateway_calls status"),
  };
}

/** complete()/embed() accounting: native unit is tokens, audio_seconds stays NULL (not 0 — no audio concept applies). */
export async function recordTokenGatewayCall(
  client: Pool | PoolClient,
  input: RecordTokenCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status`,
    [
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.costUsd,
      input.agentRunId ?? null,
      input.projectItemId ?? null,
      input.operation ?? null,
    ],
  );
  return mapRow(requireSingleRow(rows, "ai_gateway_calls row"));
}

/** transcribe()/diarize() accounting: native unit is audio seconds, both token columns stay NULL (not 0 — no token concept applies). */
export async function recordAudioGatewayCall(
  client: Pool | PoolClient,
  input: RecordAudioCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation)
     VALUES ($1, $2, NULL, NULL, $3, $4, NULL, NULL, NULL)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status`,
    [input.provider, input.model, input.audioSeconds, input.costUsd],
  );
  return mapRow(requireSingleRow(rows, "ai_gateway_calls row"));
}

export interface ReserveGatewayCallInput {
  provider: string;
  model: string;
  /** The caller's upper-bound estimate; counted against the budget until the row is settled or failed. */
  estimatedCostUsd: number;
  agentRunId?: string | null;
  projectItemId?: string | null;
  operation?: string | null;
}

/** Inserts a `reserved` row at the estimate, with every usage column NULL until it is settled. */
export async function reserveGatewayCall(
  client: Pool | PoolClient,
  input: ReserveGatewayCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status)
     VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, $6, 'reserved')
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status`,
    [
      input.provider,
      input.model,
      input.estimatedCostUsd,
      input.agentRunId ?? null,
      input.projectItemId ?? null,
      input.operation ?? null,
    ],
  );
  return mapRow(requireSingleRow(rows, "ai_gateway_calls reservation"));
}

/**
 * Replaces a `reserved` row's estimate with the real token usage. Returns `null` when no `reserved`
 * row matched (already settled or failed, or gone) — the caller decides what that means.
 */
export async function settleTokenGatewayCall(
  client: Pool | PoolClient,
  id: string,
  input: { inputTokens: number; outputTokens: number; costUsd: number },
): Promise<AiGatewayCallRow | null> {
  const result = await client.query<AiGatewayCallDbRow>(
    `UPDATE ai_gateway_calls SET status = 'settled', input_tokens = $2, output_tokens = $3, cost_usd = $4
     WHERE id = $1 AND status = 'reserved'
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status`,
    [id, input.inputTokens, input.outputTokens, input.costUsd],
  );
  if (result.rowCount === 0) return null;
  return mapRow(requireSingleRow(result.rows, `reserved ai_gateway_calls row ${id}`));
}

/**
 * Replaces a `reserved` row's estimate with the real audio usage; the token columns stay NULL.
 * Returns `null` when no `reserved` row matched.
 */
export async function settleAudioGatewayCall(
  client: Pool | PoolClient,
  id: string,
  input: { audioSeconds: number; costUsd: number },
): Promise<AiGatewayCallRow | null> {
  const result = await client.query<AiGatewayCallDbRow>(
    `UPDATE ai_gateway_calls SET status = 'settled', audio_seconds = $2, cost_usd = $3
     WHERE id = $1 AND status = 'reserved'
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status`,
    [id, input.audioSeconds, input.costUsd],
  );
  if (result.rowCount === 0) return null;
  return mapRow(requireSingleRow(result.rows, `reserved ai_gateway_calls row ${id}`));
}

/**
 * Marks a `reserved` row `failed` at cost 0, so every `SUM(cost_usd)` (budget, usage report)
 * excludes it without a status filter. Throws when the row is not `reserved`. Auto-committed on
 * the `Pool` (docs/adr/2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure.md):
 * the failure record must survive whatever the failed call's caller rolls back, or the row would
 * keep its estimate against the budget.
 */
export async function failGatewayCall(pool: Pool, id: string): Promise<void> {
  const result = await pool.query(
    `UPDATE ai_gateway_calls SET status = 'failed', cost_usd = 0 WHERE id = $1 AND status = 'reserved'`,
    [id],
  );
  requireAffectedRows(result, `failing reserved ai_gateway_calls row ${id}`);
}

export interface GatewaySpend {
  spentToday: number;
  spentMonth: number;
}

/**
 * Calendar-day and calendar-month spend in one query, per #120's budget check. Boundaries are
 * computed in the system's configured `timezone` (not the Postgres session timezone, typically
 * UTC), so a daily budget resets at local midnight rather than UTC midnight: `now() AT TIME ZONE
 * timezone` shifts "now" onto that zone's wall clock, `date_trunc` truncates it there, and the
 * second `AT TIME ZONE timezone` converts the local midnight back into the UTC instant that
 * `ai_gateway_calls.at` (timestamptz) is compared against. Every row counts at its `cost_usd`:
 * a `reserved` row at the caller's estimate (so in-flight calls count against the cap), a
 * `settled` row at its real cost, and a `failed` row at 0.
 */
export async function getGatewaySpend(client: Pool | PoolClient, timezone: string): Promise<GatewaySpend> {
  const { rows } = await client.query<{ spent_today: string; spent_month: string }>(
    `SELECT
       COALESCE(SUM(cost_usd) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1), 0)  AS spent_today,
       COALESCE(SUM(cost_usd), 0)                                                                               AS spent_month
     FROM ai_gateway_calls
     WHERE at >= date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1`,
    [timezone],
  );
  const totals = requireSingleRow(rows, "ai_gateway_calls spend totals");
  return { spentToday: Number(totals.spent_today), spentMonth: Number(totals.spent_month) };
}
