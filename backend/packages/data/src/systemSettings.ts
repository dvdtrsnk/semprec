import type { PoolClient } from "pg";
import { NotFoundError } from "./errors.js";
import type { Queryable } from "./db/pool.js";

/** Stable identifier for the singleton "System settings" database — see seed/seedSystem.ts. */
export const SYSTEM_SETTINGS_MODULE_ID = "systemSettings";
export const DEFAULT_TIMEZONE = "Europe/Prague";
export const DEFAULT_DAILY_BUDGET_USD = 50;

export async function getSystemSettingsDatabaseId(client: Queryable): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM databases WHERE owner_module_id = $1 AND system = true`,
    [SYSTEM_SETTINGS_MODULE_ID],
  );
  if (!rows[0]) throw new NotFoundError("System settings database has not been seeded");
  return rows[0].id;
}

export async function getSystemSettingsItemId(client: PoolClient): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM items WHERE database_id = $1 LIMIT 1`, [databaseId]);
  if (!rows[0]) throw new NotFoundError("System settings row has not been seeded");
  return rows[0].id;
}

export async function getSystemTimezone(client: PoolClient): Promise<string> {
  const databaseId = await getSystemSettingsDatabaseId(client);
  const { rows } = await client.query<{ properties: { timezone?: string } }>(
    `SELECT properties FROM items WHERE database_id = $1 LIMIT 1`,
    [databaseId],
  );
  return rows[0]?.properties.timezone ?? DEFAULT_TIMEZONE;
}

export interface AiBudgets {
  /** Null means uncapped, distinct from an unseeded property (which falls back to the default). */
  dailyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
}

/**
 * The gateway's dual budget caps (#120). A property that is explicitly `null` means "uncapped"
 * and must be respected as such; only a genuinely missing key (an install caught between
 * upgrading and 0019_settings_ai_budgets.sql running) falls back to the hardcoded default.
 */
export async function getAiBudgets(client: Queryable): Promise<AiBudgets> {
  const databaseId = await getSystemSettingsDatabaseId(client).catch((err) => {
    if (err instanceof NotFoundError) return null; // system not seeded yet (e.g. a bare test pool) — fall back to the defaults below
    throw err;
  });
  if (databaseId === null) return { dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD, monthlyBudgetUsd: null };

  const { rows } = await client.query<{ properties: { dailyBudgetUsd?: number | null; monthlyBudgetUsd?: number | null } }>(
    `SELECT properties FROM items WHERE database_id = $1 LIMIT 1`,
    [databaseId],
  );
  const properties = rows[0]?.properties ?? {};
  return {
    dailyBudgetUsd: properties.dailyBudgetUsd === undefined ? DEFAULT_DAILY_BUDGET_USD : properties.dailyBudgetUsd,
    monthlyBudgetUsd: properties.monthlyBudgetUsd === undefined ? null : properties.monthlyBudgetUsd,
  };
}
