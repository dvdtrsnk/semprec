import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getCurrentTenantAiBudget } from "../aiGateway/tenantAiBudgetsStore.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0070_tenant_ai_budgets.sql"),
  "utf8",
);

interface BudgetRow {
  daily_cap_usd: string | null;
  monthly_cap_usd: string | null;
  updated_by: string | null;
}

let pool: Pool;
let sidePool: Pool;
let dataPool: Pool;

async function readRows(): Promise<BudgetRow[]> {
  const { rows } = await pool.query<BudgetRow>(
    `SELECT daily_cap_usd, monthly_cap_usd, updated_by FROM tenant_ai_budgets WHERE tenant_id = $1`,
    [getTenantZeroId()],
  );
  return rows;
}

/** Replaces the settings item's budget properties with exactly `budgets` (a raw JSON object). */
async function setSettingsBudgets(budgets: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE items SET properties = (properties - 'dailyBudgetUsd' - 'monthlyBudgetUsd') || $1::jsonb
      WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings' AND system)`,
    [JSON.stringify(budgets)],
  );
}

async function reseed(): Promise<void> {
  await pool.query(`DELETE FROM tenant_ai_budgets`);
  await pool.query(MIGRATION_SQL);
}

describe("tenant_ai_budgets", () => {
  beforeAll(async () => {
    pool = getTestPool();
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterAll(async () => {
    await sidePool?.end();
    await dataPool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe("seed", () => {
    it("gives tenant zero the defaults when it has no settings item", async () => {
      await pool.query(MIGRATION_SQL);

      expect(await readRows()).toEqual([{ daily_cap_usd: "50", monthly_cap_usd: null, updated_by: null }]);
    });

    it("copies the caps from the settings item", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({ dailyBudgetUsd: 10, monthlyBudgetUsd: 200 });
      await reseed();

      expect(await readRows()).toEqual([{ daily_cap_usd: "10", monthly_cap_usd: "200", updated_by: null }]);
    });

    it("maps JSON null to NULL", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({ dailyBudgetUsd: null, monthlyBudgetUsd: null });
      await reseed();

      expect(await readRows()).toEqual([{ daily_cap_usd: null, monthly_cap_usd: null, updated_by: null }]);
    });

    it("maps absent keys to 50 and NULL", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({});
      await reseed();

      expect(await readRows()).toEqual([{ daily_cap_usd: "50", monthly_cap_usd: null, updated_by: null }]);
    });

    it("clamps a negative cap to 0", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({ dailyBudgetUsd: -5, monthlyBudgetUsd: -1 });
      await reseed();

      expect(await readRows()).toEqual([{ daily_cap_usd: "0", monthly_cap_usd: "0", updated_by: null }]);
    });

    it("fails naming the property when a cap is neither a number nor null", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({ dailyBudgetUsd: "ten" });
      await pool.query(`DELETE FROM tenant_ai_budgets`);

      await expect(pool.query(MIGRATION_SQL)).rejects.toThrow(/dailyBudgetUsd/);
      expect(await readRows()).toEqual([]);
    });

    it("leaves an existing row unchanged when run again", async () => {
      await seedSystem(pool);
      await setSettingsBudgets({ dailyBudgetUsd: 10, monthlyBudgetUsd: 200 });
      await pool.query(MIGRATION_SQL);
      await pool.query(`UPDATE tenant_ai_budgets SET daily_cap_usd = 7, monthly_cap_usd = NULL`);
      await setSettingsBudgets({ dailyBudgetUsd: 99, monthlyBudgetUsd: 999 });

      await pool.query(MIGRATION_SQL);

      expect(await readRows()).toEqual([{ daily_cap_usd: "7", monthly_cap_usd: null, updated_by: null }]);
    });
  });

  describe("getCurrentTenantAiBudget", () => {
    it("returns the caps as numbers, with null for a NULL cap", async () => {
      await pool.query(
        `INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd) VALUES ($1, 12.5, NULL)`,
        [getTenantZeroId()],
      );

      expect(await getCurrentTenantAiBudget(pool)).toEqual({
        tenantId: getTenantZeroId(),
        dailyCapUsd: 12.5,
        monthlyCapUsd: null,
      });
    });

    it("returns null once the row is deleted", async () => {
      await pool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, 1)`, [getTenantZeroId()]);
      await pool.query(`DELETE FROM tenant_ai_budgets`);

      expect(await getCurrentTenantAiBudget(pool)).toBeNull();
    });
  });

  describe("schema", () => {
    it("rejects a negative cap", async () => {
      await expect(
        pool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, -1)`, [getTenantZeroId()]),
      ).rejects.toThrow(/check constraint/);
      await expect(
        pool.query(`INSERT INTO tenant_ai_budgets (tenant_id, monthly_cap_usd) VALUES ($1, -1)`, [getTenantZeroId()]),
      ).rejects.toThrow(/check constraint/);
    });

    it("is classified as a global table", async () => {
      const { rows } = await pool.query<{ comment: string }>(
        `SELECT obj_description('tenant_ai_budgets'::regclass, 'pg_class') AS comment`,
      );
      expect(rows).toEqual([{ comment: "semprec:tenancy=global" }]);
    });
  });

  describe("role grants", () => {
    beforeEach(async () => {
      await pool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, 1)`, [getTenantZeroId()]);
    });

    it("lets semprec_side read but not write", async () => {
      await expect(sidePool.query(`SELECT * FROM tenant_ai_budgets`)).resolves.toBeDefined();
      await expect(
        sidePool.query(`INSERT INTO tenant_ai_budgets (tenant_id) VALUES (gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`UPDATE tenant_ai_budgets SET daily_cap_usd = 2`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sidePool.query(`DELETE FROM tenant_ai_budgets`)).rejects.toThrow(/permission denied/);
    });

    it("lets semprec_data insert and update but not delete", async () => {
      await expect(dataPool.query(`UPDATE tenant_ai_budgets SET daily_cap_usd = 2`)).resolves.toBeDefined();
      await expect(dataPool.query(`DELETE FROM tenant_ai_budgets`)).rejects.toThrow(/permission denied/);

      await pool.query(`DELETE FROM tenant_ai_budgets`);
      await expect(
        dataPool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, 3)`, [getTenantZeroId()]),
      ).resolves.toBeDefined();
    });
  });
});
