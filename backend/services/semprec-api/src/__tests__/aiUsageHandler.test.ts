import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { recordTokenGatewayCall } from "@semprec/data";
import { createAiUsageRequestListener } from "../aiUsageHandler.js";

const AUTH_TOKEN = "test-token";

let pool: Pool;

describe("createAiUsageRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(createAiUsageRequestListener(pool, { authToken: AUTH_TOKEN }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects a request with no bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/ai-usage?from=2026-01-01T00:00:00Z&to=2026-12-30T00:00:00Z`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/ai-usage?from=2026-01-01T00:00:00Z&to=2026-12-30T00:00:00Z`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the aggregated usage report for an authenticated request", async () => {
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 1.5,
    });

    const res = await fetch(`${baseUrl}/api/ai-usage?from=2026-01-01T00:00:00Z&to=2026-12-30T00:00:00Z`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { totalCostUsd: number; rows: unknown[] };
    expect(body.totalCostUsd).toBeCloseTo(1.5);
    expect(body.rows).toHaveLength(1);
  });

  it("maps a validation error from an invalid range to a 400 response", async () => {
    const res = await fetch(`${baseUrl}/api/ai-usage?from=not-a-date&to=2026-01-02T00:00:00Z`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("is not a valid date");
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(res.status).toBe(404);
  });
});
