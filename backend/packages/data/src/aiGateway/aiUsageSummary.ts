import { requireSingleRow, type Queryable } from "../db/pool.js";
import { getSystemTimezone } from "../systemSettings.js";
import { getGatewaySpend, type GatewaySpend } from "./aiGatewayCallsStore.js";
import { getCurrentTenantAiBudget, type TenantAiBudget } from "./tenantAiBudgetsStore.js";

/** `monthly` wins when both caps are reached, because it blocks for longer. */
export type AiUsageExhaustedWindow = "daily" | "monthly";

/**
 * The tenant's spend (as `getGatewaySpend` computes it for refusals) against its own caps.
 * Operator-wide safety caps are never reported here.
 */
export interface AiUsageSummary {
  /** `false` when the tenant has no budget row: the gateway then refuses every call. */
  hasBudget: boolean;
  spentTodayUsd: number;
  spentMonthUsd: number;
  /** `null` means no cap, never 0. */
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  exhausted: AiUsageExhaustedWindow | null;
  /** Next local day/month boundary in the tenant's timezone; null unless `exhausted` is set. */
  resetsAt: string | null;
}

/** Budget row and spend are both read under the ambient tenant and RLS. */
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
    resetsAt: exhausted === null ? null : (await getAiWindowResetInstant(client, timezone, exhausted)).toISOString(),
  };
}

/** The gateway's `spent >= cap` comparison; a null cap or missing budget row is never exhausted. */
export function findExhaustedWindow(budget: TenantAiBudget | null, spend: GatewaySpend): AiUsageExhaustedWindow | null {
  if (budget === null) return null;
  if (budget.monthlyCapUsd !== null && spend.spentMonth >= budget.monthlyCapUsd) return "monthly";
  if (budget.dailyCapUsd !== null && spend.spentToday >= budget.dailyCapUsd) return "daily";
  return null;
}

/** Truncates on the tenant's wall clock exactly as `getGatewaySpend` does, then converts back to an instant. */
export async function getAiWindowResetInstant(
  client: Queryable,
  timezone: string,
  window: AiUsageExhaustedWindow,
): Promise<Date> {
  const { rows } = await client.query<{ reset_at: Date }>(
    window === "monthly"
      ? `SELECT (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month') AT TIME ZONE $1 AS reset_at`
      : `SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS reset_at`,
    [timezone],
  );
  return requireSingleRow(rows, "AI usage reset instant").reset_at;
}
