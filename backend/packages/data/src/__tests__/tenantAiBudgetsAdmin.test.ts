import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { listTenantAiBudgetOverview, setTenantAiBudget } from "../aiGateway/tenantAiBudgetsStore.js";
import { withTransaction } from "../db/pool.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let dataPool: Pool;
let sidePool: Pool;

/** Raw SQL: a row's `at` and `status` must be controlled to sit on either side of a window boundary. */
async function insertCall(tenantId: string, costUsd: number, at: string, status = "settled"): Promise<void> {
  await pool.query(
    `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd, at, status)
     VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, $2, ${at}, $3)`,
    [tenantId, costUsd, status],
  );
}

async function newAccount(tenantId: string): Promise<string> {
  const user = await createUser(pool, {
    email: `budget-${randomUUID()}@example.test`,
    passwordHash: await hashPassword("s3cret-password"),
    tenantId,
    role: "member",
  });
  return user.id;
}

describe("tenant AI budgets: admin writer and overview (issue #1039)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
  });

  afterAll(async () => {
    await sidePool?.end();
    await dataPool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it("creates the tenant's budget row on first write and updates it in place on the second", async () => {
    const tenantId = await createTestTenant(pool);
    const adminId = await newAccount(tenantId);

    const first = await withTransaction(pool, (client) =>
      setTenantAiBudget(client, { tenantId, dailyCapUsd: 5, monthlyCapUsd: 40, updatedBy: adminId }),
    );
    expect(first).toMatchObject({ tenantId, dailyCapUsd: 5, monthlyCapUsd: 40 });

    const second = await withTransaction(pool, (client) =>
      setTenantAiBudget(client, { tenantId, dailyCapUsd: null, monthlyCapUsd: 12.5, updatedBy: adminId }),
    );
    expect(second).toMatchObject({ tenantId, dailyCapUsd: null, monthlyCapUsd: 12.5 });

    const { rows } = await pool.query<{ updated_by: string }>(
      "SELECT updated_by FROM tenant_ai_budgets WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toEqual([{ updated_by: adminId }]);
  });

  it("reports each account's caps and its tenant's spend in UTC windows, and hasBudget false without a row", async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const tenantC = await createTestTenant(pool);
    // users.tenant_id is unique, so every account needs a tenant of its own.
    const adminId = await newAccount(await createTestTenant(pool));
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const accountC = await newAccount(tenantC);

    await withTransaction(pool, (client) =>
      setTenantAiBudget(client, { tenantId: tenantA, dailyCapUsd: 5, monthlyCapUsd: 40, updatedBy: adminId }),
    );

    // Tenant A: today (UTC) 1.50 settled, 0.25 reserved, one failed at 0; 2.00 earlier this month.
    // The earlier call sits at the first instant of the UTC month, which is "today" only on its first day.
    await insertCall(tenantA, 1.5, "now()");
    await insertCall(tenantA, 0.25, "now()", "reserved");
    await insertCall(tenantA, 0, "now()", "failed");
    await insertCall(tenantA, 2, "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
    await insertCall(tenantB, 3, "now()");

    const overview = await listTenantAiBudgetOverview(dataPool);
    const byId = new Map(overview.map((account) => [account.userId, account]));

    expect(byId.get(accountA)).toMatchObject({
      hasBudget: true,
      dailyCapUsd: 5,
      monthlyCapUsd: 40,
      spentTodayUsd: 1.75,
      spentMonthUsd: 3.75,
    });
    expect(byId.get(accountB)).toMatchObject({
      hasBudget: false,
      dailyCapUsd: null,
      monthlyCapUsd: null,
      spentTodayUsd: 3,
      spentMonthUsd: 3,
    });
    expect(byId.get(accountC)).toMatchObject({ hasBudget: false, spentTodayUsd: 0, spentMonthUsd: 0 });
  });

  it("keeps ai_tenant_spend() callable by semprec_data only, as a SECURITY DEFINER function owned by semprec_router", async () => {
    const { rows } = await pool.query<{ owner: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef, p.proconfig
         FROM pg_proc p WHERE p.proname = 'ai_tenant_spend'`,
    );
    expect(rows).toEqual([{ owner: "semprec_router", prosecdef: true, proconfig: ["search_path=pg_catalog, public"] }]);

    await expect(sidePool.query("SELECT * FROM ai_tenant_spend()")).rejects.toThrow(/permission denied/);
    await expect(dataPool.query("SELECT * FROM ai_tenant_spend()")).resolves.toBeDefined();
  });
});
