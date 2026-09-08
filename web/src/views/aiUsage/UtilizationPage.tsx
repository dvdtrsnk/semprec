import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate, type MessageKey } from "../../i18n/index.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import type {
  AiUsageOperations,
  AiUsageReport,
  AiUsageRow,
  DailyCostPoint,
  DailyTokenPoint,
} from "../../api/aiUsageOperations.js";

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

/** [from, to) covering the last `days` calendar days up to (and including) today, UTC-aligned. */
function defaultRange(days: number): { from: string; to: string } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(to.getTime() - days * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

const RUN_UNIT_KEYS: Record<string, MessageKey> = {
  invocation: "aiUsage.run.invocation",
  session: "aiUsage.run.session",
};

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function CostByDayChart({
  points,
  dailyBudgetUsd,
}: {
  points: readonly DailyCostPoint[];
  dailyBudgetUsd: number | null;
}) {
  const width = 600;
  const height = 160;
  const padding = 8;
  const maxCost = Math.max(...points.map((p) => p.costUsd), dailyBudgetUsd ?? 0, 0.01);
  const barWidth = points.length > 0 ? (width - padding * 2) / points.length : 0;
  const scale = (value: number) => (value / maxCost) * (height - padding * 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="ai-usage__chart" role="img" aria-label="cost-per-day">
      {points.map((point, index) => {
        const barHeight = scale(point.costUsd);
        const exceeded = dailyBudgetUsd !== null && point.costUsd > dailyBudgetUsd;
        return (
          <rect
            key={point.day}
            x={padding + index * barWidth}
            y={height - padding - barHeight}
            width={Math.max(barWidth - 2, 1)}
            height={barHeight}
            className={exceeded ? "ai-usage__bar ai-usage__bar--exceeded" : "ai-usage__bar"}
          >
            <title>{`${point.day}: ${formatUsd(point.costUsd)}`}</title>
          </rect>
        );
      })}
      {dailyBudgetUsd !== null ? (
        <line
          x1={padding}
          x2={width - padding}
          y1={height - padding - scale(dailyBudgetUsd)}
          y2={height - padding - scale(dailyBudgetUsd)}
          className="ai-usage__budget-line"
        >
          <title>{`daily budget: ${formatUsd(dailyBudgetUsd)}`}</title>
        </line>
      ) : null}
    </svg>
  );
}

/** Stacked input/output token bars per day, mirroring CostByDayChart's layout but with two series instead of a budget line. */
function TokenUsageByDayChart({ points }: { points: readonly DailyTokenPoint[] }) {
  const width = 600;
  const height = 160;
  const padding = 8;
  const maxTokens = Math.max(...points.map((p) => p.inputTokens + p.outputTokens), 1);
  const barWidth = points.length > 0 ? (width - padding * 2) / points.length : 0;
  const scale = (value: number) => (value / maxTokens) * (height - padding * 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="ai-usage__chart" role="img" aria-label="tokens-per-day">
      {points.map((point, index) => {
        const inputHeight = scale(point.inputTokens);
        const outputHeight = scale(point.outputTokens);
        const x = padding + index * barWidth;
        const barW = Math.max(barWidth - 2, 1);
        return (
          <g key={point.day}>
            <rect
              x={x}
              y={height - padding - inputHeight}
              width={barW}
              height={inputHeight}
              className="ai-usage__bar ai-usage__bar--input-tokens"
            >
              <title>{`${point.day}: ${point.inputTokens} input tokens`}</title>
            </rect>
            <rect
              x={x}
              y={height - padding - inputHeight - outputHeight}
              width={barW}
              height={outputHeight}
              className="ai-usage__bar ai-usage__bar--output-tokens"
            >
              <title>{`${point.day}: ${point.outputTokens} output tokens`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function amountCell(t: ReturnType<typeof useTranslate>, row: AiUsageRow): string {
  if (row.nativeUnit === "audio_seconds") {
    return t("aiUsage.unit.audioSeconds", { seconds: row.audioSeconds ?? 0 });
  }
  return t("aiUsage.unit.tokens", { input: row.inputTokens ?? 0, output: row.outputTokens ?? 0 });
}

function runLabel(t: ReturnType<typeof useTranslate>, runUnit: AiUsageRow["runUnit"]): string {
  if (runUnit === null) return t("aiUsage.run.none");
  return t(RUN_UNIT_KEYS[runUnit] ?? "aiUsage.run.none");
}

function UsageTable({ rows }: { rows: readonly AiUsageRow[] }) {
  const t = useTranslate();
  return (
    <table className="ai-usage__table">
      <caption>{t("aiUsage.table.title")}</caption>
      <thead>
        <tr>
          <th>{t("aiUsage.table.provider")}</th>
          <th>{t("aiUsage.table.model")}</th>
          <th>{t("aiUsage.table.run")}</th>
          <th>{t("aiUsage.table.calls")}</th>
          <th>{t("aiUsage.table.amount")}</th>
          <th>{t("aiUsage.table.cost")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.provider}-${row.model}-${row.nativeUnit}-${row.runUnit ?? "none"}-${index}`}>
            <td>{row.provider}</td>
            <td>{row.model}</td>
            <td>{runLabel(t, row.runUnit)}</td>
            <td>{row.callCount}</td>
            <td>{amountCell(t, row)}</td>
            <td>{formatUsd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BudgetSummary({ report }: { report: AiUsageReport }) {
  const t = useTranslate();
  const exceededDays = report.dailyCostUsd.filter(
    (point) => report.budgets.dailyBudgetUsd !== null && point.costUsd > report.budgets.dailyBudgetUsd,
  ).length;

  return (
    <dl className="ai-usage__budgets">
      <div>
        <dt>{t("aiUsage.totalCost", { from: report.from.slice(0, 10), to: report.to.slice(0, 10) })}</dt>
        <dd>{formatUsd(report.totalCostUsd)}</dd>
      </div>
      <div>
        <dt>
          {report.budgets.dailyBudgetUsd === null
            ? t("aiUsage.dailyBudget.none")
            : t("aiUsage.dailyBudget.set", { amount: formatUsd(report.budgets.dailyBudgetUsd) })}
        </dt>
      </div>
      <div>
        <dt>
          {report.budgets.monthlyBudgetUsd === null
            ? t("aiUsage.monthlyBudget.uncapped")
            : t("aiUsage.monthlyBudget.set", { amount: formatUsd(report.budgets.monthlyBudgetUsd) })}
        </dt>
      </div>
      {exceededDays > 0 ? (
        <div>
          <dt>{t("aiUsage.capExceeded", { count: exceededDays })}</dt>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The System page's Utilization graph (issue #121): cost and token/audio usage aggregated
 * from `GET /api/ai-usage`, with an explicit daily-budget reference line on the cost chart
 * and explicit text for an uncapped monthly budget rather than leaving it blank. Audio-only
 * calls (no comparable token count) are called out by unit rather than shown as 0 tokens.
 */
export function UtilizationPage({ operations }: { operations: AiUsageOperations }) {
  const t = useTranslate();
  const { from, to } = defaultRange(DEFAULT_RANGE_DAYS);
  const { resource, reload } = useAsyncResource(() => operations.getAiUsageReport(from, to), [from, to]);

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const report = resource.value;
  if (report.rows.length === 0) return <EmptyState message={t("aiUsage.empty")} />;

  return (
    <section className="ai-usage">
      <h1>{t("aiUsage.title")}</h1>
      <BudgetSummary report={report} />
      <h2>{t("aiUsage.chart.costPerDay")}</h2>
      <CostByDayChart points={report.dailyCostUsd} dailyBudgetUsd={report.budgets.dailyBudgetUsd} />
      <h2>{t("aiUsage.chart.tokensPerDay")}</h2>
      <TokenUsageByDayChart points={report.dailyTokenUsage} />
      <UsageTable rows={report.rows} />
    </section>
  );
}
