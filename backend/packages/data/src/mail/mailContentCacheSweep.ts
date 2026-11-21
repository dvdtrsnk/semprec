import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { deleteExpiredMailContentCache } from "./mailContentCacheStore.js";

/**
 * Deletes expired on-demand message bodies, one transaction per active tenant; rejects after every tenant was attempted
 * when any failed.
 */
export async function handleMailContentCacheSweepTask(pool: Pool): Promise<{ deleted: number }> {
  let deleted = 0;
  await forEachActiveTenant(pool, async () => {
    deleted += await withTransaction(pool, (client) => deleteExpiredMailContentCache(client));
  });
  return { deleted };
}
