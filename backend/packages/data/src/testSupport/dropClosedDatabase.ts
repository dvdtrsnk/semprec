import { expect, vi } from "vitest";
import type { Pool } from "pg";

/**
 * Drops a scratch database after every pool that pointed at it was ended, without `WITH (FORCE)`.
 *
 * `pool.end()` may resolve before the sockets of its idle clients finish closing, so the backends of the pool can
 * still be registered when the drop runs: the drop would fail with "database is being accessed by other users", or,
 * forced, terminate a client that then reports 57P01 on a pool that has no listener. The drop therefore waits until
 * `pg_stat_activity` shows no backend of the database. It never terminates one: a backend that is still there after
 * the wait is a pool the test did not end, and the test must fail on it.
 */
export async function dropClosedDatabase(admin: Pool, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Invalid fixture database name");
  await vi.waitFor(
    async () => {
      const { rows } = await admin.query<{ remaining: number }>(
        "SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      expect(rows).toEqual([{ remaining: 0 }]);
    },
    { timeout: 5000, interval: 10 },
  );
  await admin.query(`DROP DATABASE "${name}"`);
}
