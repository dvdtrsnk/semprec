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
      process.env.SEMPREC_API_DATABASE_URL = process.env.TEST_DATABASE_URL;

      await expect(import("../serve.js")).rejects.toMatchObject({
        name: "RuntimeRoleAssertionError",
        violations: expect.arrayContaining(["superuser"]),
      });

      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM process_heartbeats WHERE process = 'agents'",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await pool.end();
    }
  });
});
