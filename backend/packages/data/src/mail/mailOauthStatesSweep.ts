import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/**
 * Deletes expired states and states used more than an hour ago, one transaction per active tenant; rejects after
 * every tenant was attempted when any failed.
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
