import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getGatewaySpend, getGlobalGatewaySpend } from "../aiGateway/aiGatewayCallsStore.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0073_ai_global_spend.sql"),
  "utf8",
);

let pool: Pool;
let sidePool: Pool;

/** Raw SQL: a row's `at` must be controlled to sit on either side of a window boundary. */
async function insertCall(tenantId: string, costUsd: number, at: string = "now()"): Promise<void> {
  await pool.query(
    `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd, at)
     VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, $2, ${at})`,
    [tenantId, costUsd],
  );
}

interface BudgetRow {
  daily_cap_usd: string | null;
  monthly_cap_usd: string | null;
}

async function readBudget(tenantId: string): Promise<BudgetRow | undefined> {
  const { rows } = await pool.query<BudgetRow>(
    `SELECT daily_cap_usd, monthly_cap_usd FROM tenant_ai_budgets WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0];
}

describe("ai_global_spend", () => {
  beforeAll(async () => {
    pool = getTestPool();
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
  });

  afterAll(async () => {
    await sidePool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe("function", () => {
    it("returns the total over all tenants even when the caller's RLS shows only its own rows", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(pool);
      await insertCall(tenantA, 2);
      await insertCall(tenantB, 3);

      const own = await withTenantTransaction(sidePool, tenantA, (client) => getGatewaySpend(client, "UTC"));
      const global = await withTenantTransaction(sidePool, tenantA, (client) => getGlobalGatewaySpend(client));

      expect(own).toEqual({ spentToday: 2, spentMonth: 2 });
      expect(global).toEqual({ spentToday: 5, spentMonth: 5 });
    });

    it("returns zeros when there is no spend", async () => {
      expect(await getGlobalGatewaySpend(sidePool)).toEqual({ spentToday: 0, spentMonth: 0 });
    });

    it("does not count a row one minute before UTC midnight in the day, only in the month", async () => {
      const tenant = getTenantZeroId();
      await insertCall(
        tenant,
        7,
        "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 minute'",
      );
      await insertCall(tenant, 1);

      const { spentToday, spentMonth } = await getGlobalGatewaySpend(sidePool);

      expect(spentToday).toBe(1);
      // On the first of a UTC month the earlier row belongs to the previous month.
      const { rows } = await pool.query<{ first_of_month: boolean }>(
        `SELECT extract(day FROM now() AT TIME ZONE 'UTC') = 1 AS first_of_month`,
      );
      expect(spentMonth).toBe(rows[0]?.first_of_month ? 1 : 8);
    });

    it("is owned by semprec_router with no EXECUTE for PUBLIC and one for semprec_side", async () => {
      const { rows } = await pool.query<{ owner: string; public_execute: boolean; side: boolean }>(
        `SELECT pg_get_userbyid(proowner) AS owner,
                has_function_privilege('public', oid, 'EXECUTE') AS public_execute,
                has_function_privilege('semprec_side', oid, 'EXECUTE') AS side
           FROM pg_proc WHERE proname = 'ai_global_spend'`,
      );

      expect(rows).toEqual([{ owner: "semprec_router", public_execute: false, side: true }]);
      await expect(getGlobalGatewaySpend(sidePool)).resolves.toBeDefined();
    });
  });

  describe("tenant_ai_budgets re-sync", () => {
    async function setSettingsBudgets(budgets: Record<string, unknown>): Promise<void> {
      await pool.query(
        `UPDATE items SET properties = (properties - 'dailyBudgetUsd' - 'monthlyBudgetUsd') || $1::jsonb
          WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings' AND system)`,
        [JSON.stringify(budgets)],
      );
    }

    it("copies the current settings values into a row no admin has written", async () => {
      await seedSystem(pool);
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 50, monthlyCapUsd: null });
      await setSettingsBudgets({ dailyBudgetUsd: 12, monthlyBudgetUsd: 300 });

      await pool.query(MIGRATION_SQL);

      expect(await readBudget(getTenantZeroId())).toEqual({ daily_cap_usd: "12", monthly_cap_usd: "300" });
    });

    it("maps JSON null to NULL and clamps a negative number to 0", async () => {
      await seedSystem(pool);
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 5, monthlyCapUsd: 5 });
      await setSettingsBudgets({ dailyBudgetUsd: null, monthlyBudgetUsd: -4 });

      await pool.query(MIGRATION_SQL);

      expect(await readBudget(getTenantZeroId())).toEqual({ daily_cap_usd: null, monthly_cap_usd: "0" });
    });

    it("maps absent keys to 50 daily and NULL monthly", async () => {
      await seedSystem(pool);
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 5, monthlyCapUsd: 5 });
      await setSettingsBudgets({});

      await pool.query(MIGRATION_SQL);

      expect(await readBudget(getTenantZeroId())).toEqual({ daily_cap_usd: "50", monthly_cap_usd: null });
    });

    it("leaves a row an admin has written (updated_by set) unchanged", async () => {
      await seedSystem(pool);
      const admin = await createTenantZeroUser(pool);
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 5, monthlyCapUsd: 6 });
      await pool.query(`UPDATE tenant_ai_budgets SET updated_by = $1`, [admin.id]);
      await setSettingsBudgets({ dailyBudgetUsd: 12, monthlyBudgetUsd: 300 });

      await pool.query(MIGRATION_SQL);

      expect(await readBudget(getTenantZeroId())).toEqual({ daily_cap_usd: "5", monthly_cap_usd: "6" });
    });

    it("leaves the row of a tenant without a settings item unchanged", async () => {
      const bare = await createTestTenant(pool);
      await setTenantAiBudget(pool, bare, { dailyCapUsd: 5, monthlyCapUsd: 6 });

      await pool.query(MIGRATION_SQL);

      expect(await readBudget(bare)).toEqual({ daily_cap_usd: "5", monthly_cap_usd: "6" });
    });
  });
});
