import { expect, vi } from "vitest";
import type { Pool } from "pg";

/**
 * Drops a scratch database after its pools were ended, without `WITH (FORCE)`. `pool.end()` may resolve before idle
 * sockets close, so this waits until `pg_stat_activity` shows no backend of the database (forcing would terminate a
 * client that then reports 57P01). It never terminates one: a lingering backend is a pool the test did not end.
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
