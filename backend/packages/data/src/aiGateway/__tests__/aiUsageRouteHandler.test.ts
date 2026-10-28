import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  setTenantAiBudget,
} from "../../testSupport/testDb.js";
import { createUser as createAccount } from "../../auth/usersStore.js";
import { requireAffectedRows, withTransaction } from "../../db/pool.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createProperty } from "../../chokePoint/propertiesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { recordTokenGatewayCall } from "../aiGatewayCallsStore.js";
import { createAiUsageRouteHandler } from "../aiUsageRouteHandler.js";
import { ValidationError } from "../../errors.js";

let pool: Pool;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

/**
 * Issue #239's `schemaCore`-owned `GET /api/ai-usage` custom-route handler, exercised directly
 * against the real function it thinly wraps (#121's `getAiUsageReport`).
 */
describe("ai usage custom route handler (issue #239)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reports usage for the requested range, a thin mapping onto getAiUsageReport", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "task", unit: "invocation" });
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1,
      agentRunId: run.id,
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const handler = createAiUsageRouteHandler(pool);
    const result = await handler({ req: { url: `/api/ai-usage?from=${from}&to=${to}` } });

    expect(result.status).toBe(200);
    const body = result.body as { totalCostUsd: number };
    expect(body.totalCostUsd).toBe(1);
  });

  it("rejects a request missing the `from`/`to` query parameters", async () => {
    const handler = createAiUsageRouteHandler(pool);
    await expect(handler({ req: { url: "/api/ai-usage" } })).rejects.toThrow(ValidationError);
  });
});

describe("monthly AI usage (gh-1462)", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  async function userAt(at: string) {
    const user = await createAccount(admin, { email: "monthly@example.com", passwordHash: "unused", tenantId: tenant });
    // The account writer cannot backdate historical account creation.
    requireAffectedRows(
      await admin.query<{ id: string }>("UPDATE users SET created_at = $2 WHERE id = $1 RETURNING id", [user.id, at]),
      "backdating account",
    );
  }

  async function callAt(at: string, costUsd = 1, tenantId = tenant) {
    await runInTenant(tenantId, async () => {
      const call = await recordTokenGatewayCall(runtime, {
        provider: "anthropic",
        model: "monthly-test",
        inputTokens: 10,
        outputTokens: 5,
        costUsd,
      });
      // The accounting writer stamps now and cannot create historical timestamps.
      requireAffectedRows(
        await runtime.query<{ id: string }>("UPDATE ai_gateway_calls SET at = $2 WHERE id = $1 RETURNING id", [
          call.id,
          at,
        ]),
        "backdating call",
      );
    });
  }

  async function timezone(value: string) {
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const db = await createDatabase(client, { name: "Settings", system: true, ownerModuleId: "systemSettings" });
        await createProperty(client, { databaseId: db.id, key: "timezone", name: null, type: "text" });
        await createItemWithClient(client, { databaseId: db.id, properties: { timezone: value } });
      }),
    );
  }

  function report(from: string, to: string, granularity: string | undefined = "month", tenantId = tenant) {
    const params = new URLSearchParams({ from, to });
    if (granularity !== undefined) params.set("granularity", granularity);
    return runInTenant(tenantId, () =>
      createAiUsageRouteHandler(runtime)({ req: { url: `/api/ai-usage?${params.toString()}` } }),
    );
  }

  it("returns continuous months beyond 366 days bounded by account start, with zeros and unchanged aggregates", async () => {
    await timezone("UTC");
    await userAt("2024-02-12T00:00:00Z");
    await callAt("2024-02-15T00:00:00Z", 2);
    await callAt("2025-04-03T00:00:00Z", 3);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 7, monthlyCapUsd: 90 });
    const months = [
      "2024-02",
      "2024-03",
      "2024-04",
      "2024-05",
      "2024-06",
      "2024-07",
      "2024-08",
      "2024-09",
      "2024-10",
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
    ];
    expect(await report("2000-01-01T00:00:00Z", "2025-05-01T00:00:00Z")).toEqual({
      status: 200,
      body: {
        accountStartedAt: "2024-02-12T00:00:00.000Z",
        timezone: "UTC",
        from: "2000-01-01T00:00:00.000Z",
        to: "2025-05-01T00:00:00.000Z",
        rows: [
          {
            provider: "anthropic",
            model: "monthly-test",
            nativeUnit: "tokens",
            runUnit: null,
            callCount: 2,
            costUsd: 5,
            inputTokens: 20,
            outputTokens: 10,
            audioSeconds: null,
          },
        ],
        totalCostUsd: 5,
        dailyCostUsd: [],
        dailyTokenUsage: [],
        monthlyCostUsd: months.map((month) => ({
          month,
          costUsd: month === "2024-02" ? 2 : month === "2025-04" ? 3 : 0,
        })),
        budgets: { dailyBudgetUsd: 7, monthlyBudgetUsd: 90 },
      },
    });
  });

  it("buckets 23:30 local month end into the tenant month and excludes the local end instant", async () => {
    await timezone("America/New_York");
    await userAt("2024-01-01T00:00:00Z");
    await callAt("2024-02-01T04:30:00Z", 2);
    await callAt("2024-02-01T05:00:00Z", 8);
    expect(await report("2024-01-01T05:00:00Z", "2024-02-01T05:00:00Z")).toMatchObject({
      body: { monthlyCostUsd: [{ month: "2024-01", costUsd: 2 }], totalCostUsd: 2 },
    });
    expect(await report("2024-01-01T05:00:00Z", "2024-03-01T05:00:00Z")).toMatchObject({
      body: {
        monthlyCostUsd: [
          { month: "2024-01", costUsd: 2 },
          { month: "2024-02", costUsd: 8 },
        ],
        totalCostUsd: 10,
      },
    });
  });

  it("starts at the from month and sums only calls within partial boundary months", async () => {
    await timezone("UTC");
    await callAt("2023-01-01T00:00:00Z", 9);
    await callAt("2024-02-09T00:00:00Z", 8);
    await callAt("2024-02-10T00:00:00Z", 2);
    await callAt("2024-03-02T00:00:00Z", 3);
    await callAt("2024-03-03T00:00:00Z", 7);
    expect(await report("2024-02-10T00:00:00Z", "2024-03-03T00:00:00Z")).toMatchObject({
      body: {
        monthlyCostUsd: [
          { month: "2024-02", costUsd: 2 },
          { month: "2024-03", costUsd: 3 },
        ],
        totalCostUsd: 5,
      },
    });
  });

  it("returns no months when the account starts after the requested months", async () => {
    await userAt("2025-01-01T00:00:00Z");
    expect(await report("2024-01-01T00:00:00Z", "2024-03-01T00:00:00Z")).toMatchObject({
      body: { monthlyCostUsd: [], dailyCostUsd: [], dailyTokenUsage: [], rows: [], totalCostUsd: 0 },
    });
  });

  it("uses from as the start for an empty account and excludes foreign history and costs", async () => {
    await timezone("UTC");
    const foreign = await createTestTenant(admin);
    await callAt("2020-01-01T00:00:00Z", 5, foreign);
    await callAt("2024-02-01T00:00:00Z", 7, foreign);
    expect(await report("2024-02-01T00:00:00Z", "2024-04-01T00:00:00Z")).toMatchObject({
      body: {
        accountStartedAt: "2024-02-01T00:00:00.000Z",
        monthlyCostUsd: [
          { month: "2024-02", costUsd: 0 },
          { month: "2024-03", costUsd: 0 },
        ],
        rows: [],
        totalCostUsd: 0,
      },
    });
    expect(await report("2024-02-01T00:00:00Z", "2024-02-29T23:00:00Z", "month", foreign)).toMatchObject({
      body: { monthlyCostUsd: [{ month: "2024-02", costUsd: 7 }], totalCostUsd: 7 },
    });
  });

  it.each([undefined, "day"])("preserves the exact daily shape for granularity %s", async (granularity) => {
    await timezone("UTC");
    await userAt("2024-01-01T00:00:00Z");
    await callAt("2024-02-01T12:00:00Z");
    // Pass undefined explicitly without the helper's monthly default.
    const params = new URLSearchParams({ from: "2024-02-01T00:00:00Z", to: "2024-02-02T00:00:00Z" });
    if (granularity !== undefined) params.set("granularity", granularity);
    expect(
      await runInTenant(tenant, () =>
        createAiUsageRouteHandler(runtime)({ req: { url: `/api/ai-usage?${params.toString()}` } }),
      ),
    ).toEqual({
      status: 200,
      body: {
        accountStartedAt: "2024-01-01T00:00:00.000Z",
        timezone: "UTC",
        from: "2024-02-01T00:00:00.000Z",
        to: "2024-02-02T00:00:00.000Z",
        rows: [
          {
            provider: "anthropic",
            model: "monthly-test",
            nativeUnit: "tokens",
            runUnit: null,
            callCount: 1,
            costUsd: 1,
            inputTokens: 10,
            outputTokens: 5,
            audioSeconds: null,
          },
        ],
        totalCostUsd: 1,
        dailyCostUsd: [{ day: "2024-02-01", costUsd: 1 }],
        dailyTokenUsage: [{ day: "2024-02-01", inputTokens: 10, outputTokens: 5 }],
        budgets: { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 },
      },
    });
  });

  it.each(["", "week", "Month"])(
    "rejects invalid granularity %s with status 400 and the field",
    async (granularity) => {
      await expect(report("2024-01-01", "2024-01-02", granularity)).rejects.toMatchObject({
        name: "ValidationError",
        status: 400,
        details: { field: "granularity" },
      });
    },
  );

  it.each(["default", "day"])("retains the 366-day cap for %s", async (granularity) => {
    const params = new URLSearchParams({ from: "2024-01-01T00:00:00Z", to: "2025-01-02T00:00:00Z" });
    if (granularity === "day") params.set("granularity", granularity);
    await expect(
      runInTenant(tenant, () =>
        createAiUsageRouteHandler(runtime)({ req: { url: `/api/ai-usage?${params.toString()}` } }),
      ),
    ).rejects.toMatchObject({ status: 400, details: { field: "to" } });
    expect(await report("2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "day")).toMatchObject({ status: 200 });
  });

  it.each([
    ["invalid", "2024-01-02", "from"],
    ["2024-01-01", "invalid", "to"],
    ["2024-01-02", "2024-01-01", "to"],
    ["2024-01-01", "2024-01-01", "to"],
  ])("retains monthly range validation for %s to %s", async (from, to, field) => {
    await expect(report(from, to)).rejects.toMatchObject({ status: 400, details: { field } });
  });
});
