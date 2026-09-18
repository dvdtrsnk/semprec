import { describe, expect, it, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { upsertProcessHeartbeat } from "../../health/processHeartbeats.js";
import { createSystemHealthRouteHandler } from "../systemHealthRouteHandler.js";

let pool: Pool;

/**
 * Issue #170's `schemaCore`-owned `GET /api/system-health` custom-route handler, exercised
 * directly against the real function it thinly wraps (`getSystemHealthReport`).
 */
describe("system health custom route handler (issue #170)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns a 200 snapshot with every reported source", async () => {
    await upsertProcessHeartbeat(pool, { process: "api", pid: 1, version: "1.0.0" }, new Date());
    const handler = createSystemHealthRouteHandler(pool);

    const result = await handler();

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body).toMatchObject({
      processes: expect.any(Array),
      alertingChecks: expect.any(Array),
      queue: { pending: expect.any(Number), overdue: expect.any(Number), permanent: expect.any(Number) },
      itemAutomationErrorsByDatabase: expect.any(Array),
      agentRunErrors7d: expect.any(Number),
      mailboxes: expect.any(Array),
    });
  });
});
