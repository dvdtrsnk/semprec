import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { DEFAULT_TIMEZONE, getAiBudgets, getSystemSettingsDatabaseId, getSystemTimezone } from "../systemSettings.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

describe("settings properties read-side validation", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  async function setRaw(path: string, jsonValue: string): Promise<void> {
    const databaseId = await getSystemSettingsDatabaseId(pool);
    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, $2::text[], $3::jsonb) WHERE database_id = $1`,
      [databaseId, `{${path}}`, jsonValue],
    );
  }

  it("rejects a non-string timezone instead of returning it as a string", async () => {
    await setRaw("timezone", "42");

    await expect(getSystemTimezone(pool)).rejects.toThrow("Malformed system settings properties in database row");
  });

  it("rejects a non-numeric budget", async () => {
    await setRaw("monthlyBudgetUsd", '"lots"');

    await expect(getAiBudgets(pool)).rejects.toThrow("Malformed system settings properties in database row");
  });

  it("resolves the default timezone when the key is absent", async () => {
    const databaseId = await getSystemSettingsDatabaseId(pool);
    await pool.query(`UPDATE items SET properties = properties - 'timezone' WHERE database_id = $1`, [databaseId]);

    expect(await getSystemTimezone(pool)).toBe(DEFAULT_TIMEZONE);
  });

  it("keeps an explicit null dailyBudgetUsd as uncapped", async () => {
    await setRaw("dailyBudgetUsd", "null");

    expect((await getAiBudgets(pool)).dailyBudgetUsd).toBeNull();
  });
});
