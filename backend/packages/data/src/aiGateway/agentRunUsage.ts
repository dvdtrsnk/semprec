import type { Queryable } from "../db/pool.js";
import { getModelDisplayCatalogs, resolveModelDisplayName } from "./modelDisplayNames.js";

/** What one model cost a run, over the run's calls of that model that did not fail. */
export interface AgentRunModelUsage {
  provider: string;
  model: string;
  displayName: string;
  callCount: number;
  /** 0 when no call has a token count yet (e.g. every call still reserved). */
  inputTokens: number;
  outputTokens: number;
  /** `null` when no call carries audio seconds. */
  audioSeconds: number | null;
  /** A reserved call counts at its estimate. */
  costUsd: number;
}

export interface AgentRunUsage {
  totalCostUsd: number;
  /** True when a call is still `reserved`, so the cost includes an estimate. */
  estimated: boolean;
  /** Ordered by cost descending, then model, then provider. */
  perModel: AgentRunModelUsage[];
}

/**
 * Non-failed `ai_gateway_calls` of `runId` per (provider, model). Calls of delegated runs are not
 * included; another tenant's run yields nothing because RLS hides its calls.
 *
 * With `sempMessageId`, only that message's calls count (one reply of a conversation run). A call
 * without a run id still counts when the message belongs to the run: speech-to-text rows of a
 * spoken question are attributed to the reply before its run exists.
 */
export async function getAgentRunUsage(
  client: Queryable,
  runId: string,
  locale: string,
  sempMessageId?: string,
): Promise<AgentRunUsage> {
  // The total is summed in Postgres so it is the exact decimal sum of the model costs.
  const { rows } = await client.query<{
    provider: string;
    model: string;
    call_count: string;
    input_tokens: string;
    output_tokens: string;
    audio_seconds: string | null;
    cost_usd: string;
    total_cost_usd: string;
    reserved: boolean;
  }>(
    `SELECT provider, model,
            COUNT(*)::text AS call_count,
            COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            SUM(audio_seconds)::text AS audio_seconds,
            SUM(cost_usd)::text AS cost_usd,
            (SUM(SUM(cost_usd)) OVER ())::text AS total_cost_usd,
            BOOL_OR(status = 'reserved') AS reserved
     FROM ai_gateway_calls
     WHERE status <> 'failed'
       AND (
         ($2::uuid IS NULL AND agent_run_id = $1)
         OR ($2::uuid IS NOT NULL AND semp_message_id = $2::uuid AND (
           agent_run_id = $1
           OR (agent_run_id IS NULL AND EXISTS (SELECT 1 FROM semp_messages WHERE id = $2::uuid AND agent_run_id = $1))
         ))
       )
     GROUP BY provider, model
     ORDER BY SUM(cost_usd) DESC, model, provider`,
    [runId, sempMessageId ?? null],
  );
  const catalogs = await getModelDisplayCatalogs();
  return {
    totalCostUsd: Number(rows[0]?.total_cost_usd ?? 0),
    estimated: rows.some((row) => row.reserved),
    perModel: rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      displayName: resolveModelDisplayName(catalogs, locale, row.model),
      callCount: Number(row.call_count),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
      costUsd: Number(row.cost_usd),
    })),
  };
}
