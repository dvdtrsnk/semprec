import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/**
 * Resolved problems whose `resolved_at` is older than this are deleted by
 * `handleSempProblemsPruneTask` (issue #1558). Active problems are never deleted, however old.
 */
export const SEMP_PROBLEMS_RETENTION_DAYS = 30;

/** Rows deleted per transaction, so one sweep never holds a lock or a transaction open over an unbounded row count. */
const PRUNE_DELETE_BATCH_SIZE = 1000;

/**
 * Deletes the resolved problems past the retention window in batches, each in its own
 * transaction. Runs in the tenant scope the caller established: row-level security and the
 * `app_tenant_default()` filter narrow every delete to that tenant.
 */
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

/**
 * The `sempProblemsPrune` daily core task (issue #1558): for every active tenant, deletes the
 * tenant's problems resolved more than `SEMP_PROBLEMS_RETENTION_DAYS` days ago. Returns the total
 * deleted across tenants; when any tenant fails, rejects after every tenant was attempted (see
 * `forEachActiveTenant`).
 */
export async function handleSempProblemsPruneTask(pool: Pool): Promise<{ deleted: number }> {
  let deleted = 0;
  await forEachActiveTenant(pool, async () => {
    deleted += await pruneResolvedProblemsInScope(pool);
  });
  return { deleted };
}
