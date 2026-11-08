import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { upsertProcessHeartbeat } from "../../health/processHeartbeats.js";
import { createSystemHealthRouteHandler } from "../systemHealthRouteHandler.js";

let pool: Pool;
let runtimePool: Pool;

const REPORT_KEYS = [
  "agentRunErrors7d",
  "alertingChecks",
  "generatedAt",
  "itemAutomationErrorsByDatabase",
  "mailboxes",
  "processes",
  "queue",
];

/**
 * Issue #170's `schemaCore`-owned `GET /api/system-health` custom-route handler, exercised
 * directly against the real function it thinly wraps (`getSystemHealthReport`). The handler runs
 * in the caller's tenant scope (issue #1052), so this test calls it the way the route does.
 */
describe("system health custom route handler (issue #170, per-tenant since #1052)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("returns a 200 snapshot with exactly the existing keys to a tenant's session", async () => {
    await upsertProcessHeartbeat(pool, { process: "api", pid: 1, version: "1.0.0" }, new Date());
    const tenantB = await createTestTenant(pool);
    const handler = createSystemHealthRouteHandler(runtimePool);

    const result = await runInTenant(tenantB, () => handler());

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
    expect(body).toMatchObject({
      generatedAt: expect.any(String),
      processes: [],
      alertingChecks: [],
      queue: { pending: 0, overdue: 0, permanent: 0 },
      itemAutomationErrorsByDatabase: [],
      agentRunErrors7d: 0,
      mailboxes: [],
    });
  });

  it("rejects a request that reaches the handler without a tenant scope", async () => {
    const handler = createSystemHealthRouteHandler(runtimePool);
    await expect(handler()).rejects.toThrow("requires an active tenant scope");
  });
});
