import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId } from "../systemSettings.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0019_settings_ai_budgets.sql"),
  "utf8",
);

let pool: Pool;

async function readSettingsItemProperties(databaseId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM items WHERE database_id = $1`,
    [databaseId],
  );
  return rows[0]?.properties;
}

describe("0019_settings_ai_budgets migration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("backfills dailyBudgetUsd/monthlyBudgetUsd onto a settings row provisioned before this migration existed", async () => {
    // seedSystem.ts no longer creates the two properties (#1059), so a freshly seeded settings
    // database already has the pre-#120 shape an install provisioned before 0019 would have.
    await seedSystem(pool);
    const databaseId = await getSystemSettingsDatabaseId(pool);

    await pool.query(MIGRATION_SQL);

    const settings = await readSettingsItemProperties(databaseId);
    expect(settings).toMatchObject({ dailyBudgetUsd: 50, monthlyBudgetUsd: null });

    const { rows } = await pool.query<{ key: string; type: string; locked: boolean; owner: string }>(
      `SELECT key, type, locked, owner FROM properties
        WHERE database_id = $1 AND key IN ('dailyBudgetUsd', 'monthlyBudgetUsd') ORDER BY key`,
      [databaseId],
    );
    expect(rows).toEqual([
      { key: "dailyBudgetUsd", type: "number", locked: true, owner: "user" },
      { key: "monthlyBudgetUsd", type: "number", locked: true, owner: "user" },
    ]);

    const { rows: dbRows } = await pool.query<{ schema_locked: boolean }>(
      `SELECT schema_locked FROM databases WHERE id = $1`,
      [databaseId],
    );
    expect(dbRows[0]!.schema_locked).toBe(true);

    // Idempotent: re-running must not error or disturb a value the user already changed.
    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{dailyBudgetUsd}', '10') WHERE database_id = $1`,
      [databaseId],
    );
    await pool.query(MIGRATION_SQL);
    expect((await readSettingsItemProperties(databaseId))?.dailyBudgetUsd).toBe(10);
  });

  it("is a no-op when the system settings database has not been seeded yet", async () => {
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
