import type { PoolClient } from "pg";
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

/** One account in the admin overview: its tenant's caps (null when no row exists) and its tenant's spend in UTC windows. */
export interface AdminAiBudgetAccount {
  userId: string;
  email: string;
  hasBudget: boolean;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  spentTodayUsd: number;
  spentMonthUsd: number;
}

interface AdminAiBudgetAccountRow {
  user_id: string;
  email: string;
  daily_cap_usd: string | null;
  monthly_cap_usd: string | null;
  has_budget: boolean;
  spent_today_usd: string | null;
  spent_month_usd: string | null;
}

/**
 * Every account with its tenant's caps and spend (issue #1039), oldest account first. Spend comes
 * from `ai_tenant_spend()`, a router function, because the admin plane runs in system scope where
 * row-level security hides every tenant's `ai_gateway_calls` rows (migration 0076). An account whose
 * tenant has no budget row reports `hasBudget: false` and null caps; its spend is still shown.
 */
export async function listTenantAiBudgetOverview(client: Queryable): Promise<AdminAiBudgetAccount[]> {
  const { rows } = await client.query<AdminAiBudgetAccountRow>(
    `SELECT u.id AS user_id, u.email,
            b.daily_cap_usd, b.monthly_cap_usd,
            b.tenant_id IS NOT NULL AS has_budget,
            s.spent_today_usd, s.spent_month_usd
       FROM users u
       JOIN tenants t ON t.id = COALESCE(u.tenant_id, app_sole_tenant())
       LEFT JOIN tenant_ai_budgets b ON b.tenant_id = t.id
       LEFT JOIN ai_tenant_spend() s ON s.tenant_id = t.id
      ORDER BY u.created_at, u.id`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    hasBudget: row.has_budget,
    dailyCapUsd: row.daily_cap_usd === null ? null : Number(row.daily_cap_usd),
    monthlyCapUsd: row.monthly_cap_usd === null ? null : Number(row.monthly_cap_usd),
    spentTodayUsd: Number(row.spent_today_usd ?? 0),
    spentMonthUsd: Number(row.spent_month_usd ?? 0),
  }));
}

export interface SetTenantAiBudgetInput {
  tenantId: string;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  updatedBy: string;
}

export interface SetTenantAiBudgetResult extends TenantAiBudget {
  updatedAt: string;
}

interface SetTenantAiBudgetRow extends TenantAiBudgetRow {
  updated_at: Date;
}

/**
 * The only writer of `tenant_ai_budgets` (issue #1039): an upsert of one tenant's caps. Runs on the
 * caller's client so the caller can record the audit row in the same transaction. The caller has
 * already validated both caps as `null` or a finite number >= 0, the column's domain.
 */
export async function setTenantAiBudget(
  client: PoolClient,
  input: SetTenantAiBudgetInput,
): Promise<SetTenantAiBudgetResult> {
  const { rows } = await client.query<SetTenantAiBudgetRow>(
    `INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET daily_cap_usd = EXCLUDED.daily_cap_usd,
           monthly_cap_usd = EXCLUDED.monthly_cap_usd,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING tenant_id, daily_cap_usd, monthly_cap_usd, updated_at`,
    [input.tenantId, input.dailyCapUsd, input.monthlyCapUsd, input.updatedBy],
  );
  const row = rows[0];
  if (!row) throw new Error("tenant_ai_budgets upsert returned no row");
  return {
    tenantId: row.tenant_id,
    dailyCapUsd: row.daily_cap_usd === null ? null : Number(row.daily_cap_usd),
    monthlyCapUsd: row.monthly_cap_usd === null ? null : Number(row.monthly_cap_usd),
    updatedAt: row.updated_at.toISOString(),
  };
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
