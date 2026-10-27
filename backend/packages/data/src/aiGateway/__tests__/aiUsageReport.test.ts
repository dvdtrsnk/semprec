import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { requireAffectedRows, withTransaction } from "../../db/pool.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createProperty } from "../../chokePoint/propertiesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { recordTokenGatewayCall } from "../aiGatewayCallsStore.js";
import { createAiUsageRouteHandler } from "../aiUsageRouteHandler.js";

const FROM = "2026-01-01T23:00:00.000Z";
const TO = "2026-01-02T23:00:00.000Z";
const EARLY = "2020-01-01T00:00:00.000Z";
const LATE = "2021-01-01T00:00:00.000Z";

describe("AI usage account metadata (gh-1376)", () => {
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

  async function userAt(tenantId: string, at: string): Promise<void> {
    const user = await createUser(admin, {
      email: `${tenantId}@example.com`,
      passwordHash: "unused",
      tenantId,
    });
    // The production account writer cannot backdate migration-era account timestamps.
    requireAffectedRows(
      await admin.query<{ id: string }>("UPDATE users SET created_at = $2 WHERE id = $1 RETURNING id", [user.id, at]),
      "backdating test account",
    );
  }

  async function callAt(tenantId: string, at: string): Promise<void> {
    await runInTenant(tenantId, async () => {
      const call = await recordTokenGatewayCall(runtime, {
        provider: "anthropic",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 1,
      });
      // The accounting writer stamps now; historical calls cannot be created through its API.
      requireAffectedRows(
        await runtime.query<{ id: string }>("UPDATE ai_gateway_calls SET at = $2 WHERE id = $1 RETURNING id", [
          call.id,
          at,
        ]),
        "backdating test call",
      );
    });
  }

  async function report(tenantId = tenant) {
    return runInTenant(tenantId, () =>
      createAiUsageRouteHandler(runtime)({ req: { url: `/api/ai-usage?from=${FROM}&to=${TO}` } }),
    );
  }

  it("uses the first call when it predates the user, even outside the report range", async () => {
    await userAt(tenant, LATE);
    await callAt(tenant, EARLY);
    await callAt(tenant, LATE);
    expect(await report()).toMatchObject({ status: 200, body: { accountStartedAt: EARLY } });
  });

  it("uses the user when it predates the first call", async () => {
    await userAt(tenant, EARLY);
    await callAt(tenant, LATE);
    expect(await report()).toMatchObject({ body: { accountStartedAt: EARLY } });
  });

  it("uses the user when there are no calls", async () => {
    await userAt(tenant, EARLY);
    expect(await report()).toMatchObject({ body: { accountStartedAt: EARLY } });
  });

  it("uses the first call when there is no user", async () => {
    await callAt(tenant, EARLY);
    expect(await report()).toMatchObject({ body: { accountStartedAt: EARLY } });
  });

  it("falls back to the normalized from when both sources are empty", async () => {
    const result = await runInTenant(tenant, () =>
      createAiUsageRouteHandler(runtime)({ req: { url: `/api/ai-usage?from=2026-01-02T00:00:00%2B01:00&to=${TO}` } }),
    );
    expect(result).toMatchObject({ body: { accountStartedAt: FROM, from: FROM } });
  });

  it("returns the current tenant timezone after its setting changes", async () => {
    await userAt(tenant, EARLY);
    const settings = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const db = await createDatabase(client, { name: "Settings", system: true, ownerModuleId: "systemSettings" });
        await createProperty(client, { databaseId: db.id, key: "timezone", name: null, type: "text" });
        const item = await createItemWithClient(client, { databaseId: db.id, properties: { timezone: "UTC" } });
        return { databaseId: db.id, itemId: item.id };
      }),
    );
    expect(await report()).toMatchObject({ body: { timezone: "UTC" } });
    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateItemWithClient(client, { ...settings, propertiesPatch: { timezone: "America/New_York" } }),
      ),
    );
    expect(await report()).toMatchObject({ body: { timezone: "America/New_York" } });
  });

  it("excludes older foreign users and calls on the runtime role, including the empty-tenant fallback", async () => {
    const foreign = await createTestTenant(admin);
    await userAt(foreign, EARLY);
    await callAt(foreign, EARLY);
    expect(await report()).toMatchObject({ body: { accountStartedAt: FROM } });
    await userAt(tenant, LATE);
    await callAt(tenant, "2022-01-01T00:00:00.000Z");
    expect(await report()).toMatchObject({ body: { accountStartedAt: LATE } });
    expect(await report(foreign)).toMatchObject({ body: { accountStartedAt: EARLY } });
  });

  it("preserves every previous response field alongside the additive metadata", async () => {
    await userAt(tenant, EARLY);
    await callAt(tenant, "2026-01-02T12:00:00.000Z");
    expect(await report()).toEqual({
      status: 200,
      body: {
        accountStartedAt: EARLY,
        timezone: "Europe/Prague",
        from: FROM,
        to: TO,
        rows: [
          {
            provider: "anthropic",
            model: "test-model",
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
        dailyCostUsd: [{ day: "2026-01-02", costUsd: 1 }],
        dailyTokenUsage: [{ day: "2026-01-02", inputTokens: 10, outputTokens: 5 }],
        budgets: { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 },
      },
    });
  });
});
