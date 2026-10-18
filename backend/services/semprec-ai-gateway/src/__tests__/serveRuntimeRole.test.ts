import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";

/**
 * Issue #1051: `serve.ts` refuses to start under a superuser database role before it touches the
 * pool, so the superuser `TEST_DATABASE_URL` must reject with `RuntimeRoleAssertionError` and leave
 * no `process_heartbeats` row behind for this process.
 */
describe("serve.ts startup runtime role check", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("refuses a superuser database URL before any query runs", async () => {
    const pool = getTestPool();
    try {
      await resetDatabase(pool);
      // The same startup env `startupConfig.unit.test.ts` uses; resolveStartupConfig reads all of
      // it before serve.ts creates the pool.
      Object.assign(process.env, {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        AI_GATEWAY_INTERNAL_TOKEN: "token",
        AI_GATEWAY_STRUCTURED_PROVIDER: "anthropic",
        AI_GATEWAY_STRUCTURED_MODEL: "claude-sonnet-5",
        AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK: "1",
        AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK: "1",
        PYANNOTEAI_API_KEY: "pyannote-key",
        DEEPINFRA_API_KEY: "deepinfra-key",
        ANTHROPIC_API_KEY: "anthropic-key",
        AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR: "1",
        AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR: "1",
        AI_GLOBAL_DAILY_CAP_USD: "25",
        AI_GLOBAL_MONTHLY_CAP_USD: "400.5",
      });

      await expect(import("../serve.js")).rejects.toMatchObject({
        name: "RuntimeRoleAssertionError",
        violations: expect.arrayContaining(["superuser"]),
      });

      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM process_heartbeats WHERE process = 'ai-gateway'",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await pool.end();
    }
  });
});
