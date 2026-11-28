import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestPool, resetDatabase } from "@alldots/data/testSupport";

/** `serve.ts` refuses a superuser role before touching the pool, leaving no `process_heartbeats` row. */
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
      process.env.ALLDOTS_API_DATABASE_URL = process.env.TEST_DATABASE_URL;

      await expect(import("../serve.js")).rejects.toMatchObject({
        name: "RuntimeRoleAssertionError",
        violations: expect.arrayContaining(["superuser"]),
      });

      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM process_heartbeats WHERE process = 'transcribe'",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await pool.end();
    }
  });
});
