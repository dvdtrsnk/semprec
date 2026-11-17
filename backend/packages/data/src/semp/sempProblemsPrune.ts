import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/** Retention of resolved problems; active problems are never deleted. */
export const SEMP_PROBLEMS_RETENTION_DAYS = 30;

/** Bounds the rows and lock time of each transaction. */
const PRUNE_DELETE_BATCH_SIZE = 1000;

/** One transaction per batch; RLS and `app_tenant_default()` narrow every delete to the caller's tenant. */
async function pruneResolvedProblemsInScope(pool: Pool): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batchDeleted = await withTransaction(pool, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM semp_problems WHERE id IN (
           SELECT id FROM semp_problems
           WHERE tenant_id = (SELECT app_tenant_default())
             AND resolved_at IS NOT NULL
             AND resolved_at < now() - make_interval(days => $1)
           ORDER BY resolved_at, id
           LIMIT $2
         )`,
        [SEMP_PROBLEMS_RETENTION_DAYS, PRUNE_DELETE_BATCH_SIZE],
      );
      return rowCount ?? 0;
    });
    deleted += batchDeleted;
    if (batchDeleted < PRUNE_DELETE_BATCH_SIZE) return deleted;
  }
}

/** Rejects after all tenants were attempted if any failed. */
export async function handleSempProblemsPruneTask(pool: Pool): Promise<{ deleted: number }> {
  let deleted = 0;
  await forEachActiveTenant(pool, async () => {
    deleted += await pruneResolvedProblemsInScope(pool);
  });
  return { deleted };
}
