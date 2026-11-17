import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { getGatewaySpend, getGlobalGatewaySpend } from "../aiGateway/aiGatewayCallsStore.js";

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
});
