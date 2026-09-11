import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { recordTokenGatewayCall } from "../aiGatewayCallsStore.js";
import { createAiUsageRouteHandler } from "../aiUsageRouteHandler.js";
import { ValidationError } from "../../errors.js";

let pool: Pool;

/**
 * Issue #239's `schemaCore`-owned `GET /api/ai-usage` custom-route handler, exercised directly
 * against the real function it thinly wraps (#121's `getAiUsageReport`).
 */
describe("ai usage custom route handler (issue #239)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
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
