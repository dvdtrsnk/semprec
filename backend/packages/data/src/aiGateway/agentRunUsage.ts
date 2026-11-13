import type { Queryable } from "../db/pool.js";
import { getModelDisplayCatalogs, resolveModelDisplayName } from "./modelDisplayNames.js";

/** What one model cost a run (issue #1822). Every number covers the run's calls of the model that did not fail. */
export interface AgentRunModelUsage {
  provider: string;
  model: string;
  /** Localized model family name; the raw model id when the family is not recognized. */
  displayName: string;
  callCount: number;
  /** The sum of the calls' input tokens; 0 when none of them has a token count, as while every call is reserved. */
  inputTokens: number;
  /** The sum of the calls' output tokens; 0 like `inputTokens`. */
  outputTokens: number;
  /** The sum of the calls' audio seconds; `null` when none of them carries audio seconds. */
  audioSeconds: number | null;
  /** The sum of the calls' `cost_usd`; a reserved call counts at its estimate. */
  costUsd: number;
}

/** The AI spend of one agent run (issue #1822). */
export interface AgentRunUsage {
  /** The sum of `cost_usd` over the run's calls that did not fail; a reserved call counts at its estimate. */
  totalCostUsd: number;
  /** True when a call of the run is still `reserved`, so the cost includes an estimate. */
  estimated: boolean;
  /** One entry per (provider, model), ordered by cost descending, then by model and provider. */
  perModel: AgentRunModelUsage[];
}

/**
 * Aggregates the `ai_gateway_calls` rows of the run `runId` that did not fail, per (provider, model)
 * (issue #1822). Only calls recorded with that run's id count: the calls of runs it delegated to are
 * not included. `locale` is the caller's `users.locale`, in which the model names are written. A run
 * without such calls returns no entry, a total of 0 and `estimated: false`; so does a run of another
 * tenant, whose calls row-level security hides.
 */
export async function getAgentRunUsage(client: Queryable, runId: string, locale: string): Promise<AgentRunUsage> {
  // Sums of integer and numeric columns arrive as strings; the total is summed in Postgres so that
  // it is the exact decimal sum of the model costs.
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
     WHERE agent_run_id = $1 AND status <> 'failed'
     GROUP BY provider, model
     ORDER BY SUM(cost_usd) DESC, model, provider`,
    [runId],
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
