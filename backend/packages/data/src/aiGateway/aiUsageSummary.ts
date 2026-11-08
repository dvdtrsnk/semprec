import { requireSingleRow, type Queryable } from "../db/pool.js";
import { getSystemTimezone } from "../systemSettings.js";
import { getGatewaySpend, type GatewaySpend } from "./aiGatewayCallsStore.js";
import { getCurrentTenantAiBudget, type TenantAiBudget } from "./tenantAiBudgetsStore.js";

/** A window whose own per-tenant cap spend has reached. `monthly` wins when both are, because it blocks for longer. */
export type AiUsageExhaustedWindow = "daily" | "monthly";

/**
 * The caller's tenant's spend against its own caps (issue gh-1456). The spend is the figure
 * `getGatewaySpend` returns, the one the gateway refuses with; the caps are the tenant's
 * `tenant_ai_budgets` row. Operator-wide safety caps are never reported here.
 */
export interface AiUsageSummary {
  /** `false` when the tenant has no budget row: the gateway refuses every call then, and both caps are null. */
  hasBudget: boolean;
  spentTodayUsd: number;
  spentMonthUsd: number;
  /** `null` when the daily window has no per-tenant cap. Never 0 for "no cap". */
  dailyCapUsd: number | null;
  /** `null` when the monthly window has no per-tenant cap. Never 0 for "no cap". */
  monthlyCapUsd: number | null;
  /** The window whose cap is reached (`spent >= cap`, the gateway's comparison), or null. */
  exhausted: AiUsageExhaustedWindow | null;
  /**
   * ISO 8601 instant at which the exhausted window resets: the next local midnight for `daily`, the
   * first instant of the next month for `monthly`, both in the tenant's timezone. Null unless
   * `exhausted` is set.
   */
  resetsAt: string | null;
}

/**
 * The summary the usage screen and the account profile show. The budget row is selected by the
 * ambient tenant (`app_tenant_default()`), and the spend is read with `getGatewaySpend` under
 * row-level security, so another tenant's spend never appears. The spend uses the gateway's windows:
 * a reservation counts at its estimate, and a day or month starts at local midnight of the tenant's
 * timezone.
 */
export async function getAiUsageSummary(client: Queryable): Promise<AiUsageSummary> {
  const budget = await getCurrentTenantAiBudget(client);
  const timezone = await getSystemTimezone(client);
  const spend = await getGatewaySpend(client, timezone);
  const exhausted = findExhaustedWindow(budget, spend);
  return {
    hasBudget: budget !== null,
    spentTodayUsd: spend.spentToday,
    spentMonthUsd: spend.spentMonth,
    dailyCapUsd: budget?.dailyCapUsd ?? null,
    monthlyCapUsd: budget?.monthlyCapUsd ?? null,
    exhausted,
    resetsAt: exhausted === null ? null : await resetInstant(client, timezone, exhausted),
  };
}

/**
 * The gateway's comparison, `spent >= cap`, per window. A null cap is no cap, so it never counts as
 * reached, whatever the spend. No budget row means no window is reported as exhausted: the caps are
 * absent, not reached.
 */
function findExhaustedWindow(budget: TenantAiBudget | null, spend: GatewaySpend): AiUsageExhaustedWindow | null {
  if (budget === null) return null;
  if (budget.monthlyCapUsd !== null && spend.spentMonth >= budget.monthlyCapUsd) return "monthly";
  if (budget.dailyCapUsd !== null && spend.spentToday >= budget.dailyCapUsd) return "daily";
  return null;
}

/**
 * The instant the window resets, truncated the same way `getGatewaySpend` truncates the window
 * itself: `now() AT TIME ZONE timezone` puts "now" on the tenant's wall clock, `date_trunc` and
 * `+ interval` move it to the next day or month boundary there, and the second `AT TIME ZONE`
 * converts that local wall-clock midnight back into an instant.
 */
async function resetInstant(client: Queryable, timezone: string, exhausted: AiUsageExhaustedWindow): Promise<string> {
  const { rows } = await client.query<{ reset_at: Date }>(
    exhausted === "monthly"
      ? `SELECT (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month') AT TIME ZONE $1 AS reset_at`
      : `SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS reset_at`,
    [timezone],
  );
  return requireSingleRow(rows, "AI usage reset instant").reset_at.toISOString();
}
