import type { Pool, PoolClient } from "pg";

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
}

export interface RecordTokenCallInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentRunId?: string | null;
}

export interface RecordAudioCallInput {
  provider: string;
  model: string;
  audioSeconds: number;
  costUsd: number;
  agentRunId?: string | null;
}

function mapRow(row: {
  id: string;
  at: Date;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: string | null;
  cost_usd: string;
  agent_run_id: string | null;
}): AiGatewayCallRow {
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
  };
}

/** complete()/embed() accounting: native unit is tokens, audio_seconds stays NULL (not 0 — no audio concept applies). */
export async function recordTokenGatewayCall(
  client: Pool | PoolClient,
  input: RecordTokenCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id)
     VALUES ($1, $2, $3, $4, NULL, $5, $6)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id`,
    [input.provider, input.model, input.inputTokens, input.outputTokens, input.costUsd, input.agentRunId ?? null],
  );
  return mapRow(rows[0]);
}

/** transcribe()/diarize() accounting: native unit is audio seconds, both token columns stay NULL (not 0 — no token concept applies). */
export async function recordAudioGatewayCall(
  client: Pool | PoolClient,
  input: RecordAudioCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id`,
    [input.provider, input.model, input.audioSeconds, input.costUsd, input.agentRunId ?? null],
  );
  return mapRow(rows[0]);
}

export interface GatewaySpend {
  spentToday: number;
  spentMonth: number;
}

/** Calendar-day and calendar-month spend in one query, per #120's budget check. */
export async function getGatewaySpend(client: Pool | PoolClient): Promise<GatewaySpend> {
  const { rows } = await client.query<{ spent_today: string; spent_month: string }>(
    `SELECT
       COALESCE(SUM(cost_usd) FILTER (WHERE at >= date_trunc('day', now())), 0)  AS spent_today,
       COALESCE(SUM(cost_usd), 0)                                               AS spent_month
     FROM ai_gateway_calls
     WHERE at >= date_trunc('month', now())`,
  );
  return { spentToday: Number(rows[0].spent_today), spentMonth: Number(rows[0].spent_month) };
}
