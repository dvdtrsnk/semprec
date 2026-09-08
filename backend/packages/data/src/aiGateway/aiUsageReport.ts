import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getAiBudgets, getSystemTimezone, type AiBudgets } from "../systemSettings.js";
import type { AgentRunUnit } from "../agentRuns/agentRunsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";

const AGENT_RUN_UNITS: readonly AgentRunUnit[] = ["invocation", "session"];

/** A caller-supplied range wider than this would let one request scan the table unbounded. */
const MAX_RANGE_DAYS = 366;

export interface AiUsageReportInput {
  /** Inclusive lower bound, ISO 8601 timestamp. */
  from: string;
  /** Exclusive upper bound, ISO 8601 timestamp. */
  to: string;
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
  /** null (not 0) when this group's native unit isn't tokens — no token concept applies. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** null (not 0) when this group's native unit isn't audio_seconds. */
  audioSeconds: number | null;
}

export interface DailyCostPoint {
  /** Calendar day in the system's configured timezone (see systemSettings.ts), YYYY-MM-DD — matches the daily budget's own reset boundary. */
  day: string;
  /** Always a number, including 0 for a day with no calls — an explicit zero, not a missing point. */
  costUsd: number;
}

export interface DailyTokenPoint {
  /** Calendar day in the system's configured timezone, YYYY-MM-DD — same boundary as DailyCostPoint. */
  day: string;
  /** Always a number, including 0 — sums only token-native calls, audio-only calls contribute 0. */
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageReport {
  from: string;
  to: string;
  /** One row per (provider, model, nativeUnit, runUnit) combination — kept as separate axes because they're not comparable: audio seconds can't be summed with tokens, and an 'invocation' run's spend isn't 1:1 with a long-lived 'session' run's. */
  rows: AiUsageReportRow[];
  /** Total cost across every row, the one number that IS comparable regardless of native/run unit. */
  totalCostUsd: number;
  /** One point per calendar day in [from, to), for the reference-line graph against dailyBudgetUsd. */
  dailyCostUsd: DailyCostPoint[];
  /** One point per calendar day in [from, to), for the token-usage graph — audio-only days show 0/0. */
  dailyTokenUsage: DailyTokenPoint[];
  budgets: AiBudgets;
}

function assertBoundedRange(from: string, to: string): { fromDate: Date; toDate: Date } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()))
    throw new ValidationError(`'from' is not a valid date: ${from}`, { field: "from" });
  if (Number.isNaN(toDate.getTime())) throw new ValidationError(`'to' is not a valid date: ${to}`, { field: "to" });
  if (toDate <= fromDate) throw new ValidationError("'to' must be after 'from'", { field: "to" });
  const rangeDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (rangeDays > MAX_RANGE_DAYS) {
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
 * (invocation/session, or null for a call outside any run), plus a daily cost series for the
 * budget reference line. Bounded to `MAX_RANGE_DAYS` so a caller can't force an unbounded scan.
 */
export async function getAiUsageReport(client: Queryable, input: AiUsageReportInput): Promise<AiUsageReport> {
  const { fromDate, toDate } = assertBoundedRange(input.from, input.to);
  const timezone = await getSystemTimezone(client);

  const { rows } = await client.query<UsageRow>(
    `SELECT
       c.provider,
       c.model,
       CASE WHEN c.audio_seconds IS NOT NULL THEN 'audio_seconds' ELSE 'tokens' END AS native_unit,
       r.unit AS run_unit,
       COUNT(*) AS call_count,
       SUM(c.cost_usd) AS cost_usd,
       SUM(c.input_tokens) AS input_tokens,
       SUM(c.output_tokens) AS output_tokens,
       SUM(c.audio_seconds) AS audio_seconds
     FROM ai_gateway_calls c
     LEFT JOIN agent_runs r ON r.id = c.agent_run_id
     WHERE c.at >= $1 AND c.at < $2
     GROUP BY c.provider, c.model, native_unit, r.unit
     ORDER BY c.provider, c.model, native_unit, r.unit`,
    [fromDate.toISOString(), toDate.toISOString()],
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

  const { rows: dailyRows } = await client.query<DailyRow>(
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
  );

  const dailyCostUsd: DailyCostPoint[] = dailyRows.map((row) => ({ day: row.day, costUsd: Number(row.cost_usd) }));
  const dailyTokenUsage: DailyTokenPoint[] = dailyRows.map((row) => ({
    day: row.day,
    inputTokens: row.input_tokens === null ? 0 : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens),
  }));
  const totalCostUsd = reportRows.reduce((sum, row) => sum + row.costUsd, 0);
  const budgets = await getAiBudgets(client);

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    rows: reportRows,
    totalCostUsd,
    dailyCostUsd,
    dailyTokenUsage,
    budgets,
  };
}
