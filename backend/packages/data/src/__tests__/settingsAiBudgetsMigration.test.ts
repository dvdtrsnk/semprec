import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getAiBudgets, getSystemSettingsDatabaseId } from "../systemSettings.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0019_settings_ai_budgets.sql"),
  "utf8",
);

let pool: Pool;

describe("0019_settings_ai_budgets migration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("backfills dailyBudgetUsd/monthlyBudgetUsd onto a settings row provisioned before this migration existed", async () => {
    // seedSystem.ts already creates the two properties for a fresh install; roll a settings
    // row back to the pre-#120 shape (as an already-provisioned install would have) so the
    // migration's own backfill path — not seedSystem's — is what's under test.
    await seedSystem(pool);
    const client = await pool.connect();
    try {
      const databaseId = await getSystemSettingsDatabaseId(client);
      await client.query(`UPDATE databases SET schema_locked = false WHERE id = $1`, [databaseId]);
      await client.query(`DELETE FROM properties WHERE database_id = $1 AND key IN ('dailyBudgetUsd', 'monthlyBudgetUsd')`, [databaseId]);
      await client.query(`UPDATE items SET properties = properties - 'dailyBudgetUsd' - 'monthlyBudgetUsd' WHERE database_id = $1`, [databaseId]);
      await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [databaseId]);
    } finally {
      client.release();
    }

    await pool.query(MIGRATION_SQL);

    const client2 = await pool.connect();
    try {
      const budgets = await getAiBudgets(client2);
      expect(budgets).toEqual({ dailyBudgetUsd: 50, monthlyBudgetUsd: null });

      const { rows } = await client2.query<{ type: string; locked: boolean; owner: string }>(
        `SELECT type, locked, owner FROM properties WHERE database_id = $1 AND key = 'dailyBudgetUsd'`,
        [await getSystemSettingsDatabaseId(client2)],
      );
      expect(rows[0]).toEqual({ type: "number", locked: true, owner: "user" });

      const { rows: dbRows } = await client2.query<{ schema_locked: boolean }>(`SELECT schema_locked FROM databases WHERE id = $1`, [
        await getSystemSettingsDatabaseId(client2),
      ]);
      expect(dbRows[0].schema_locked).toBe(true);
    } finally {
      client2.release();
    }

    // Idempotent: re-running must not error or disturb a value the user already changed.
    await pool.query(`UPDATE items SET properties = jsonb_set(properties, '{dailyBudgetUsd}', '10') WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings')`);
    await pool.query(MIGRATION_SQL);
    const client3 = await pool.connect();
    try {
      expect((await getAiBudgets(client3)).dailyBudgetUsd).toBe(10);
    } finally {
      client3.release();
    }
  });

  it("is a no-op when the system settings database has not been seeded yet", async () => {
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
