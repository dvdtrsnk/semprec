import type { Queryable } from "../db/pool.js";

export interface TenantAiBudget {
  tenantId: string;
  /** `null` means the daily window has no per-tenant cap. */
  dailyCapUsd: number | null;
  /** `null` means the monthly window has no per-tenant cap. */
  monthlyCapUsd: number | null;
}

interface TenantAiBudgetRow {
  tenant_id: string;
  // `numeric` arrives from pg as a string.
  daily_cap_usd: string | null;
  monthly_cap_usd: string | null;
}

/**
 * The AI budget row of the current scope's tenant (`app_tenant_default()`, the tenant the
 * row-level-security policies resolve). `null` when the tenant has no row — which a caller must
 * treat as "may not spend" — and when no tenant resolves.
 */
export async function getCurrentTenantAiBudget(client: Queryable): Promise<TenantAiBudget | null> {
  const { rows } = await client.query<TenantAiBudgetRow>(
    `SELECT tenant_id, daily_cap_usd, monthly_cap_usd FROM tenant_ai_budgets WHERE tenant_id = app_tenant_default()`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    dailyCapUsd: row.daily_cap_usd === null ? null : Number(row.daily_cap_usd),
    monthlyCapUsd: row.monthly_cap_usd === null ? null : Number(row.monthly_cap_usd),
  };
}
