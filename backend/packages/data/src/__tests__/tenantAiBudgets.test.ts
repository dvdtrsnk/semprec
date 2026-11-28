import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { getCurrentTenantAiBudget } from "../aiGateway/tenantAiBudgetsStore.js";

let pool: Pool;
let sidePool: Pool;
let dataPool: Pool;

describe("tenant_ai_budgets", () => {
  beforeAll(async () => {
    pool = getTestPool();
    sidePool = await createRuntimeRolePool(pool, "alldots_side");
    dataPool = await createRuntimeRolePool(pool, "alldots_data");
  });

  afterAll(async () => {
    await sidePool?.end();
    await dataPool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
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
      expect(rows).toEqual([{ comment: "alldots:tenancy=global" }]);
    });
  });

  describe("role grants", () => {
    beforeEach(async () => {
      await pool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, 1)`, [getTenantZeroId()]);
    });

    it("lets alldots_side read but not write", async () => {
      await expect(sidePool.query(`SELECT * FROM tenant_ai_budgets`)).resolves.toBeDefined();
      await expect(
        sidePool.query(`INSERT INTO tenant_ai_budgets (tenant_id) VALUES (gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`UPDATE tenant_ai_budgets SET daily_cap_usd = 2`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sidePool.query(`DELETE FROM tenant_ai_budgets`)).rejects.toThrow(/permission denied/);
    });

    it("lets alldots_data insert and update but not delete", async () => {
      await expect(dataPool.query(`UPDATE tenant_ai_budgets SET daily_cap_usd = 2`)).resolves.toBeDefined();
      await expect(dataPool.query(`DELETE FROM tenant_ai_budgets`)).rejects.toThrow(/permission denied/);

      await pool.query(`DELETE FROM tenant_ai_budgets`);
      await expect(
        dataPool.query(`INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd) VALUES ($1, 3)`, [getTenantZeroId()]),
      ).resolves.toBeDefined();
    });
  });
});
