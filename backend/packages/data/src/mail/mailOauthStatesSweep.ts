import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/**
 * The `mailOauthStatesSweep` cron task (issue #1483): deletes expired OAuth states and states used
 * more than an hour ago. Runs once per active tenant, each in its own transaction inside that tenant's
 * scope; when any tenant fails, rejects after every tenant was attempted (see `forEachActiveTenant`).
 * Returns the number of rows deleted across tenants.
 */
export async function handleMailOauthStatesSweepTask(pool: Pool): Promise<{ deleted: number }> {
  let deleted = 0;
  await forEachActiveTenant(pool, async () => {
    deleted += await withTransaction(pool, async (client) => {
      const result = await client.query(
        `DELETE FROM mail_oauth_states WHERE expires_at <= now() OR used_at < now() - interval '1 hour'`,
      );
      return result.rowCount ?? 0;
    });
  });
  return { deleted };
}
