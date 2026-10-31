import { requireSingleRow, type Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import type { AgentRunUnit } from "../agentRuns/agentRunsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { getCurrentTenantAiBudget } from "./tenantAiBudgetsStore.js";
import { getModelDisplayCatalogs, resolveModelDisplayName, resolveOperationLabel } from "./modelDisplayNames.js";

/** Operations whose native unit is audio seconds; every other operation (including NULL) is token-native. */
const AUDIO_OPERATIONS: readonly string[] = ["transcription_transcribe", "transcription_diarize"];

const AGENT_RUN_UNITS: readonly AgentRunUnit[] = ["invocation", "session"];

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

interface UsageRow {
  provider: string;
  model: string;
  native_unit: NativeUnit;
  run_unit: AgentRunUnit | null;
  call_count: string;
  cost_usd: string;
  input_tokens: string | null;
  output_tokens: string | null;
  audio_seconds: string | null;
  has_reserved: boolean;
}

interface ByModelRow {
  provider: string;
  model: string;
  call_count: string;
  cost_usd: string;
  input_tokens: string | null;
  output_tokens: string | null;
  audio_seconds: string | null;
  operations: string[];
}

interface ByOperationRow {
  operation: string;
  call_count: string;
  cost_usd: string;
}

/** Operations recorded under several keys that the report shows as one activity. */
const MERGED_OPERATIONS: Readonly<Record<string, string>> = {
  agent_behavior_drift: "agent_guidance_drift",
  voice_transcribe_stream: "voice",
  voice_synthesize: "voice",
};

interface MonthlyRow {
  month: string;
  cost_usd: string;
}

interface DailyRow {
  day: string;
  cost_usd: string;
  input_tokens: string | null;
  output_tokens: string | null;
}

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
  const { rows: accountRows } = await client.query<{ account_started_at: Date | null }>(
    `SELECT LEAST(
       (SELECT MIN(created_at) FROM users WHERE tenant_id = app_tenant_default()),
       (SELECT MIN(at) FROM ai_gateway_calls)
     ) AS account_started_at`,
  );
  const accountStartedAt = requireSingleRow(accountRows, "AI usage account start").account_started_at;

  const { rows } = await client.query<UsageRow>(
    `WITH classified AS (
       SELECT
         c.provider,
         c.model,
         COALESCE(c.operation = ANY($3::text[]), false) AS is_audio,
         r.unit AS run_unit,
         c.cost_usd,
         c.input_tokens,
         c.output_tokens,
         c.audio_seconds,
         c.status
       FROM ai_gateway_calls c
       LEFT JOIN agent_runs r ON r.id = c.agent_run_id
       WHERE c.at >= $1 AND c.at < $2 AND c.status <> 'failed'
     )
     SELECT
       provider,
       model,
       CASE WHEN is_audio THEN 'audio_seconds' ELSE 'tokens' END AS native_unit,
       run_unit,
       COUNT(*) AS call_count,
       SUM(cost_usd) AS cost_usd,
       CASE WHEN is_audio THEN NULL ELSE COALESCE(SUM(input_tokens), 0) END AS input_tokens,
       CASE WHEN is_audio THEN NULL ELSE COALESCE(SUM(output_tokens), 0) END AS output_tokens,
       CASE WHEN is_audio THEN COALESCE(SUM(audio_seconds), 0) ELSE NULL END AS audio_seconds,
       BOOL_OR(status = 'reserved') AS has_reserved
     FROM classified
     GROUP BY provider, model, is_audio, run_unit
     ORDER BY provider, model, native_unit, run_unit`,
    [fromDate.toISOString(), toDate.toISOString(), AUDIO_OPERATIONS],
  );

  const reportRows: AiUsageReportRow[] = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    nativeUnit: row.native_unit,
    runUnit: row.run_unit === null ? null : assertKnownValue(AGENT_RUN_UNITS, row.run_unit, "run_unit"),
    callCount: Number(row.call_count),
    costUsd: Number(row.cost_usd),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
  }));

  const { rows: modelRows } = await client.query<ByModelRow>(
    `WITH classified AS (
       SELECT
         provider,
         model,
         COALESCE(operation, 'other') AS operation,
         COALESCE(operation = ANY($3::text[]), false) AS is_audio,
         cost_usd,
         input_tokens,
         output_tokens,
         audio_seconds
       FROM ai_gateway_calls
       WHERE at >= $1 AND at < $2 AND status <> 'failed'
     )
     SELECT
       provider,
       model,
       COUNT(*) AS call_count,
       SUM(cost_usd) AS cost_usd,
       CASE WHEN BOOL_AND(is_audio) THEN NULL ELSE COALESCE(SUM(input_tokens) FILTER (WHERE NOT is_audio), 0) END AS input_tokens,
       CASE WHEN BOOL_AND(is_audio) THEN NULL ELSE COALESCE(SUM(output_tokens) FILTER (WHERE NOT is_audio), 0) END AS output_tokens,
       CASE WHEN BOOL_OR(is_audio) THEN COALESCE(SUM(audio_seconds) FILTER (WHERE is_audio), 0) ELSE NULL END AS audio_seconds,
       ARRAY_AGG(DISTINCT operation ORDER BY operation) AS operations
     FROM classified
     GROUP BY provider, model
     ORDER BY SUM(cost_usd) DESC, model, provider`,
    [fromDate.toISOString(), toDate.toISOString(), AUDIO_OPERATIONS],
  );
  const catalogs = await getModelDisplayCatalogs();
  const locale = input.locale ?? "en";
  const byModel: AiUsageByModel[] = modelRows.map((row) => ({
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

  const { rows: operationRows } = await client.query<ByOperationRow>(
    `SELECT COALESCE(operation, 'other') AS operation, COUNT(*) AS call_count, SUM(cost_usd) AS cost_usd
     FROM ai_gateway_calls
     WHERE at >= $1 AND at < $2 AND status <> 'failed'
     GROUP BY 1`,
    [fromDate.toISOString(), toDate.toISOString()],
  );
  const mergedOperations = new Map<string, { costUsd: number; callCount: number }>();
  for (const row of operationRows) {
    const key = MERGED_OPERATIONS[row.operation] ?? row.operation;
    const entry = mergedOperations.get(key) ?? { costUsd: 0, callCount: 0 };
    entry.costUsd += Number(row.cost_usd);
    entry.callCount += Number(row.call_count);
    mergedOperations.set(key, entry);
  }
  const operationsTotalCostUsd = [...mergedOperations.values()].reduce((sum, entry) => sum + entry.costUsd, 0);
  const byOperation: AiUsageByOperation[] = [...mergedOperations.entries()]
    .map(([operation, entry]) => ({
      operation,
      label: resolveOperationLabel(catalogs, locale, operation),
      costUsd: entry.costUsd,
      share: operationsTotalCostUsd === 0 ? 0 : entry.costUsd / operationsTotalCostUsd,
      callCount: entry.callCount,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));

  let monthlyCostUsd: MonthlyCostPoint[] | undefined;
  let dailyRows: DailyRow[] = [];
  if (granularity === "month") {
    const { rows: monthlyRows } = await client.query<MonthlyRow>(
      `WITH months AS (
         SELECT generate_series(
           GREATEST(
             date_trunc('month', $1::timestamptz AT TIME ZONE $3),
             date_trunc('month', $4::timestamptz AT TIME ZONE $3)
           ),
           date_trunc('month', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3),
           interval '1 month'
         ) AS month
       ), monthly AS (
         SELECT date_trunc('month', at AT TIME ZONE $3) AS month, SUM(cost_usd) AS cost_usd
         FROM ai_gateway_calls
         WHERE at >= $1 AND at < $2
         GROUP BY 1
       )
       SELECT to_char(months.month, 'YYYY-MM') AS month, COALESCE(monthly.cost_usd, 0) AS cost_usd
       FROM months LEFT JOIN monthly ON monthly.month = months.month
       ORDER BY months.month`,
      [
        fromDate.toISOString(),
        toDate.toISOString(),
        timezone,
        accountStartedAt?.toISOString() ?? fromDate.toISOString(),
      ],
    );
    monthlyCostUsd = monthlyRows.map((row) => ({ month: row.month, costUsd: Number(row.cost_usd) }));
  } else {
    ({ rows: dailyRows } = await client.query<DailyRow>(
      `WITH days AS (
       SELECT generate_series(
         date_trunc('day', $1::timestamptz AT TIME ZONE $3),
         date_trunc('day', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3),
         interval '1 day'
       ) AS day
     ),
     daily AS (
       SELECT
         date_trunc('day', at AT TIME ZONE $3) AS day,
         SUM(cost_usd) AS cost_usd,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens
       FROM ai_gateway_calls
       WHERE at >= $1 AND at < $2
       GROUP BY 1
     )
     SELECT
       to_char(days.day, 'YYYY-MM-DD') AS day,
       COALESCE(daily.cost_usd, 0) AS cost_usd,
       daily.input_tokens,
       daily.output_tokens
     FROM days LEFT JOIN daily ON daily.day = days.day
     ORDER BY days.day`,
      [fromDate.toISOString(), toDate.toISOString(), timezone],
    ));
  }

  const dailyCostUsd: DailyCostPoint[] = dailyRows.map((row) => ({ day: row.day, costUsd: Number(row.cost_usd) }));
  const dailyTokenUsage: DailyTokenPoint[] = dailyRows.map((row) => ({
    day: row.day,
    inputTokens: row.input_tokens === null ? 0 : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens),
  }));
  const estimated = rows.some((row) => row.has_reserved);
  const totalCostUsd = reportRows.reduce((sum, row) => sum + row.costUsd, 0);
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
