import { z } from "zod";
import { requireSingleRow, type Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import type { AgentRunUnit } from "../agentRuns/agentRunsStore.js";
import { getCurrentTenantAiBudget } from "./tenantAiBudgetsStore.js";
import { getModelDisplayCatalogs, resolveModelDisplayName, resolveOperationLabel } from "./modelDisplayNames.js";

/** Operations whose native unit is audio seconds; every other operation (including NULL) is token-native. */
const AUDIO_OPERATIONS: readonly string[] = ["transcription_transcribe", "transcription_diarize"];

/** Daily reports retain the existing range cap; monthly reports span account history. */
const MAX_RANGE_DAYS = 366;

export interface AiUsageReportInput {
  /** Inclusive lower bound, ISO 8601 timestamp. */
  from: string;
  /** Exclusive upper bound, ISO 8601 timestamp. */
  to: string;
  granularity?: "day" | "month";
  /** Locale of the caller's `users.locale`, used for model display names; defaults to `en`. */
  locale?: string;
}

export type NativeUnit = "tokens" | "audio_seconds";

export interface AiUsageReportRow {
  provider: string;
  model: string;
  nativeUnit: NativeUnit;
  /** null when a call isn't tied to any agent_run (e.g. a standalone transcription/embedding). */
  runUnit: AgentRunUnit | null;
  callCount: number;
  costUsd: number;
  /** A number for a token group (0 while every call is reserved); null when this group's native unit isn't tokens. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** A number for an audio group (0 while every call is reserved); null when this group's native unit isn't audio_seconds. */
  audioSeconds: number | null;
}

/** The caller's own AI caps as the report shows them. `null` means no per-tenant cap for that window. */
export interface AiUsageBudgets {
  dailyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
}

export interface DailyCostPoint {
  /** Calendar day in the caller's tenant's settings timezone (see systemSettings.ts), YYYY-MM-DD — matches the daily budget's own reset boundary. */
  day: string;
  /** Always a number, including 0 for a day with no calls — an explicit zero, not a missing point. */
  costUsd: number;
}

export interface DailyTokenPoint {
  /** Calendar day in the caller's tenant's settings timezone, YYYY-MM-DD — same boundary as DailyCostPoint. */
  day: string;
  /** Always a number, including 0 — sums only token-native calls, audio-only calls contribute 0. */
  inputTokens: number;
  outputTokens: number;
}

export interface MonthlyCostPoint {
  /** Calendar month in the tenant timezone, YYYY-MM. */
  month: string;
  costUsd: number;
}

/** One line per (provider, model) over the range, run units merged. */
export interface AiUsageByModel {
  provider: string;
  model: string;
  /** Localized model family name; the raw model id when the family is not recognized. */
  displayName: string;
  callCount: number;
  costUsd: number;
  /** null for an audio-only model. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** null for a token-only model. */
  audioSeconds: number | null;
  /** Sorted distinct operation keys the model was used for; a NULL operation is reported as `other`. */
  operations: string[];
}

/** One line per merged operation over the range. */
export interface AiUsageByOperation {
  /** Canonical operation key after merging; a NULL operation is `other`. */
  operation: string;
  /** Localized label; the raw key when the catalog does not know the operation. */
  label: string;
  costUsd: number;
  /** Fraction of `totalCostUsd` between 0 and 1; 0 for every entry when the total is 0. */
  share: number;
  /** Non-failed calls only. */
  callCount: number;
}

export interface AiUsageReport {
  accountStartedAt: string;
  timezone: string;
  from: string;
  to: string;
  /** One row per (provider, model, nativeUnit, runUnit) combination — kept as separate axes because they're not comparable: audio seconds can't be summed with tokens, and an 'invocation' run's spend isn't 1:1 with a long-lived 'session' run's. */
  rows: AiUsageReportRow[];
  /** One entry per (provider, model), ordered by cost descending then model. */
  byModel: AiUsageByModel[];
  /** One entry per merged operation, ordered by cost descending then operation. */
  byOperation: AiUsageByOperation[];
  /** True when any non-failed call in [from, to) is still `reserved`, so its cost is an estimate. */
  estimated: boolean;
  /** Total cost across every row, the one number that IS comparable regardless of native/run unit. */
  totalCostUsd: number;
  /** Daily granularity: one point per calendar day in [from, to); empty for monthly reports. */
  dailyCostUsd: DailyCostPoint[];
  /** Daily granularity: token counts per calendar day; empty for monthly reports. */
  dailyTokenUsage: DailyTokenPoint[];
  monthlyCostUsd?: MonthlyCostPoint[];
  budgets: AiUsageBudgets;
}

function assertRange(from: string, to: string, granularity: "day" | "month"): { fromDate: Date; toDate: Date } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()))
    throw new ValidationError(`'from' is not a valid date: ${from}`, { field: "from" });
  if (Number.isNaN(toDate.getTime())) throw new ValidationError(`'to' is not a valid date: ${to}`, { field: "to" });
  if (toDate <= fromDate) throw new ValidationError("'to' must be after 'from'", { field: "to" });
  const rangeDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (granularity === "day" && rangeDays > MAX_RANGE_DAYS) {
    throw new ValidationError(`Date range cannot exceed ${MAX_RANGE_DAYS} days`, { field: "to" });
  }
  return { fromDate, toDate };
}

const usageRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  native_unit: z.enum(["tokens", "audio_seconds"]),
  run_unit: z.enum(["invocation", "session"]).nullable(),
  call_count: z.string(),
  cost_usd: z.string(),
  input_tokens: z.string().nullable(),
  output_tokens: z.string().nullable(),
  audio_seconds: z.string().nullable(),
});
const modelRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  call_count: z.string(),
  cost_usd: z.string(),
  input_tokens: z.string().nullable(),
  output_tokens: z.string().nullable(),
  audio_seconds: z.string().nullable(),
  operations: z.array(z.string()),
});
const operationRowSchema = z.object({ operation: z.string(), call_count: z.string(), cost_usd: z.string() });
const dailyRowSchema = z.object({
  day: z.string(),
  cost_usd: z.string(),
  input_tokens: z.string().nullable(),
  output_tokens: z.string().nullable(),
});
const monthlyRowSchema = z.object({ month: z.string(), cost_usd: z.string() });
const aggregateRowSchema = z.object({
  account_started_at: z.iso.datetime({ offset: true }).nullable(),
  rows: z.array(usageRowSchema),
  models: z.array(modelRowSchema),
  operations: z.array(operationRowSchema),
  daily: z.array(dailyRowSchema),
  monthly: z.array(monthlyRowSchema),
  estimated: z.boolean(),
  total_cost_usd: z.string(),
});

/**
 * The read model behind #121's utilization report: `ai_gateway_calls` aggregated by provider,
 * model, native unit (tokens vs audio_seconds), and the originating `agent_runs.unit`
 * (invocation/session, or null for a call outside any run), plus a daily or monthly cost series.
 * Daily ranges are capped at `MAX_RANGE_DAYS`; monthly points start no earlier than the account month.
 */
export async function getAiUsageReport(client: Queryable, input: AiUsageReportInput): Promise<AiUsageReport> {
  const granularity = input.granularity ?? "day";
  const { fromDate, toDate } = assertRange(input.from, input.to, granularity);
  const timezone = await getSystemTimezone(client);
  // One statement snapshot covers every value derived from calls, including account start and calendar series.
  const result = await client.query<{ data: unknown }>(
    `WITH account AS (
       SELECT LEAST((SELECT MIN(created_at) FROM users WHERE tenant_id = app_tenant_default()),
                    (SELECT MIN(at) FROM ai_gateway_calls)) AS account_started_at
     ), classified AS MATERIALIZED (
       SELECT c.provider, c.model, c.operation, c.status, c.at, c.cost_usd,
              c.input_tokens, c.output_tokens, c.audio_seconds,
              COALESCE(c.operation = ANY($3::text[]), false) AS is_audio, r.unit AS run_unit
       FROM ai_gateway_calls c LEFT JOIN agent_runs r ON r.id = c.agent_run_id
       WHERE c.at >= $1 AND c.at < $2
     ), usage_rows AS (
       SELECT provider, model, CASE WHEN is_audio THEN 'audio_seconds' ELSE 'tokens' END AS native_unit,
              run_unit, COUNT(*)::text AS call_count, SUM(cost_usd)::text AS cost_usd,
              CASE WHEN is_audio THEN NULL ELSE COALESCE(SUM(input_tokens), 0)::text END AS input_tokens,
              CASE WHEN is_audio THEN NULL ELSE COALESCE(SUM(output_tokens), 0)::text END AS output_tokens,
              CASE WHEN is_audio THEN COALESCE(SUM(audio_seconds), 0)::text ELSE NULL END AS audio_seconds
       FROM classified WHERE status <> 'failed' GROUP BY provider, model, is_audio, run_unit
     ), models AS (
       SELECT provider, model, COUNT(*)::text AS call_count, SUM(cost_usd)::text AS cost_usd,
              CASE WHEN BOOL_AND(is_audio) THEN NULL ELSE COALESCE(SUM(input_tokens) FILTER (WHERE NOT is_audio), 0)::text END AS input_tokens,
              CASE WHEN BOOL_AND(is_audio) THEN NULL ELSE COALESCE(SUM(output_tokens) FILTER (WHERE NOT is_audio), 0)::text END AS output_tokens,
              CASE WHEN BOOL_OR(is_audio) THEN COALESCE(SUM(audio_seconds) FILTER (WHERE is_audio), 0)::text ELSE NULL END AS audio_seconds,
              ARRAY_AGG(DISTINCT COALESCE(operation, 'other') ORDER BY COALESCE(operation, 'other')) AS operations,
              SUM(cost_usd) AS sort_cost
       FROM classified WHERE status <> 'failed' GROUP BY provider, model
     ), operations AS (
       SELECT CASE COALESCE(operation, 'other')
                WHEN 'agent_behavior_drift' THEN 'agent_guidance_drift'
                WHEN 'voice_transcribe_stream' THEN 'voice'
                WHEN 'voice_synthesize' THEN 'voice'
                ELSE COALESCE(operation, 'other') END AS operation,
              COUNT(*)::text AS call_count, SUM(cost_usd)::text AS cost_usd
       FROM classified WHERE status <> 'failed' GROUP BY 1
     ), days AS (
       SELECT generate_series(date_trunc('day', $1::timestamptz AT TIME ZONE $4),
         date_trunc('day', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $4), interval '1 day') AS day
       WHERE $5 = 'day'
     ), daily_totals AS (
       SELECT date_trunc('day', at AT TIME ZONE $4) AS day, SUM(cost_usd) AS cost_usd,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM classified GROUP BY 1
     ), daily AS (
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day, COALESCE(daily_totals.cost_usd, 0)::text AS cost_usd,
              daily_totals.input_tokens::text AS input_tokens, daily_totals.output_tokens::text AS output_tokens
       FROM days LEFT JOIN daily_totals ON daily_totals.day = days.day
     ), months AS (
       SELECT generate_series(
         GREATEST(date_trunc('month', $1::timestamptz AT TIME ZONE $4),
                  date_trunc('month', COALESCE(account.account_started_at, $1::timestamptz) AT TIME ZONE $4)),
         date_trunc('month', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $4), interval '1 month') AS month
       FROM account WHERE $5 = 'month'
     ), monthly_totals AS (
       SELECT date_trunc('month', at AT TIME ZONE $4) AS month, SUM(cost_usd) AS cost_usd
       FROM classified GROUP BY 1
     ), monthly AS (
       SELECT to_char(months.month, 'YYYY-MM') AS month, COALESCE(monthly_totals.cost_usd, 0)::text AS cost_usd
       FROM months LEFT JOIN monthly_totals ON monthly_totals.month = months.month
     )
     SELECT jsonb_build_object(
       'account_started_at', (SELECT account_started_at FROM account),
       'rows', COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY provider, model, native_unit, run_unit) FROM usage_rows u), '[]'::jsonb),
       'models', COALESCE((SELECT jsonb_agg(to_jsonb(m) - 'sort_cost' ORDER BY sort_cost DESC, model, provider) FROM models m), '[]'::jsonb),
       'operations', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM operations o), '[]'::jsonb),
       'daily', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY day) FROM daily d), '[]'::jsonb),
       'monthly', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY month) FROM monthly m), '[]'::jsonb),
       'estimated', COALESCE((SELECT BOOL_OR(status = 'reserved') FROM classified WHERE status <> 'failed'), false),
       'total_cost_usd', COALESCE((SELECT SUM(cost_usd) FROM classified WHERE status <> 'failed'), 0)::text
     ) AS data`,
    [fromDate.toISOString(), toDate.toISOString(), AUDIO_OPERATIONS, timezone, granularity],
  );
  const raw = requireSingleRow(result.rows, "AI usage aggregate").data;
  const aggregate = aggregateRowSchema.parse(raw);
  const accountStartedAt = aggregate.account_started_at === null ? null : new Date(aggregate.account_started_at);
  const reportRows: AiUsageReportRow[] = aggregate.rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    nativeUnit: row.native_unit,
    runUnit: row.run_unit,
    callCount: Number(row.call_count),
    costUsd: Number(row.cost_usd),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
  }));
  const catalogs = await getModelDisplayCatalogs();
  const locale = input.locale ?? "en";
  const byModel: AiUsageByModel[] = aggregate.models.map((row) => ({
    provider: row.provider,
    model: row.model,
    displayName: resolveModelDisplayName(catalogs, locale, row.model),
    callCount: Number(row.call_count),
    costUsd: Number(row.cost_usd),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
    operations: row.operations,
  }));
  const totalCostUsd = Number(aggregate.total_cost_usd);
  const byOperation: AiUsageByOperation[] = aggregate.operations
    .map((row) => {
      const costUsd = Number(row.cost_usd);
      return {
        operation: row.operation,
        label: resolveOperationLabel(catalogs, locale, row.operation),
        costUsd,
        share: totalCostUsd === 0 ? 0 : costUsd / totalCostUsd,
        callCount: Number(row.call_count),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  const dailyCostUsd: DailyCostPoint[] = aggregate.daily.map((row) => ({
    day: row.day,
    costUsd: Number(row.cost_usd),
  }));
  const dailyTokenUsage: DailyTokenPoint[] = aggregate.daily.map((row) => ({
    day: row.day,
    inputTokens: row.input_tokens === null ? 0 : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens),
  }));
  const monthlyCostUsd: MonthlyCostPoint[] | undefined =
    granularity === "month"
      ? aggregate.monthly.map((row) => ({ month: row.month, costUsd: Number(row.cost_usd) }))
      : undefined;
  const estimated = aggregate.estimated;
  // A tenant without a tenant_ai_budgets row may not spend (the gateway refuses every call), so its
  // effective cap is 0, never null: null would render as "uncapped".
  const tenantBudget = await getCurrentTenantAiBudget(client);
  const budgets: AiUsageBudgets = tenantBudget
    ? { dailyBudgetUsd: tenantBudget.dailyCapUsd, monthlyBudgetUsd: tenantBudget.monthlyCapUsd }
    : { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 };

  return {
    accountStartedAt: accountStartedAt?.toISOString() ?? fromDate.toISOString(),
    timezone,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    rows: reportRows,
    byModel,
    byOperation,
    estimated,
    totalCostUsd,
    dailyCostUsd,
    dailyTokenUsage,
    ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
    budgets,
  };
}
