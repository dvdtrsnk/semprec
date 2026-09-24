import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_TIMEZONE,
  getAiBudgets,
  getAiBudgetsWithTimezone,
  getSystemSettingsDatabaseId,
} from "../systemSettings.js";

let pool: Pool;

async function setSettings(properties: Record<string, unknown>): Promise<void> {
  const databaseId = await getSystemSettingsDatabaseId(pool);
  await pool.query(`UPDATE items SET properties = properties || $2::jsonb WHERE database_id = $1`, [
    databaseId,
    JSON.stringify(properties),
  ]);
}

describe("getAiBudgetsWithTimezone", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns the budgets and the timezone from the same settings row", async () => {
    await seedSystem(pool);
    await setSettings({ dailyBudgetUsd: 12, monthlyBudgetUsd: 200, timezone: "America/New_York" });

    expect(await getAiBudgetsWithTimezone(pool)).toEqual({
      dailyBudgetUsd: 12,
      monthlyBudgetUsd: 200,
      timezone: "America/New_York",
    });
  });

  it("keeps an explicit null budget as uncapped rather than defaulting it", async () => {
    await seedSystem(pool);
    await setSettings({ dailyBudgetUsd: null, monthlyBudgetUsd: null });

    const result = await getAiBudgetsWithTimezone(pool);
    expect(result.dailyBudgetUsd).toBeNull();
    expect(result.monthlyBudgetUsd).toBeNull();
  });

  it("falls back to the defaults for keys the settings row does not carry", async () => {
    await seedSystem(pool);
    const databaseId = await getSystemSettingsDatabaseId(pool);
    await pool.query(
      `UPDATE items SET properties = properties - 'dailyBudgetUsd' - 'monthlyBudgetUsd' - 'timezone' WHERE database_id = $1`,
      [databaseId],
    );

    expect(await getAiBudgetsWithTimezone(pool)).toEqual({
      dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD,
      monthlyBudgetUsd: null,
      timezone: DEFAULT_TIMEZONE,
    });
  });

  it("falls back to every default before the system is seeded", async () => {
    expect(await getAiBudgetsWithTimezone(pool)).toEqual({
      dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD,
      monthlyBudgetUsd: null,
      timezone: DEFAULT_TIMEZONE,
    });
  });

  it("agrees with getAiBudgets on the budget part", async () => {
    await seedSystem(pool);
    await setSettings({ dailyBudgetUsd: 7, monthlyBudgetUsd: null });

    const { timezone: _timezone, ...budgets } = await getAiBudgetsWithTimezone(pool);
    expect(budgets).toEqual(await getAiBudgets(pool));
  });
});
