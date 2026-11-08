import type { Pool, PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** The most Tasks items one transaction strips `persistent` from. */
const BATCH_SIZE = 500;

/** One committed batch: the next at most `BATCH_SIZE` Tasks items, trashed ones included, that still store the key. */
async function stripBatch(client: PoolClient, tasksDatabaseId: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 AND properties ? 'persistent' ORDER BY id LIMIT $2 FOR UPDATE`,
    [tasksDatabaseId, BATCH_SIZE],
  );
  if (rows.length === 0) return 0;
  // Bulk over the locked ids; every one still has the key under the lock, so each row is changed exactly once.
  const stripped = await client.query(
    `UPDATE items SET properties = properties - 'persistent'
     WHERE database_id = $1 AND id = ANY($2::uuid[]) AND properties ? 'persistent'`,
    [tasksDatabaseId, rows.map((row) => row.id)],
  );
  if (stripped.rowCount !== rows.length) throw new Error("Tasks persistent removal changed an unexpected row count");
  return rows.length;
}

async function stripAll(pool: Pool, tasksDatabaseId: string): Promise<void> {
  for (;;) {
    const stripped = await withTransaction(pool, (client) => stripBatch(client, tasksDatabaseId));
    if (stripped < BATCH_SIZE) return;
  }
}

/**
 * Per-tenant cutover of issue #2009: removes the unused Tasks property `persistent`. It resolves the tenant's Tasks
 * database (a tenant without one is skipped), removes the key `persistent` from the stored properties of every Tasks
 * item that has it, trashed items included, in batches of at most 500 ids, each batch in its own transaction and
 * selected through `properties ? 'persistent'`, then deletes the `persistent` property definition. Until the
 * definition is gone the generic write still accepts the key, so a value written between the last batch and the
 * deletion is removed by one more pass afterwards. Like the Tasks series cutover
 * (docs/adr/2026-11-07-task-series-cutover-uses-bounded-owner-backfill.md), the Tasks module removes the values with
 * SQL as their owner: `updated_at` is not changed and nothing is announced. A second run changes nothing.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runTasksPersistentRemovalCutoverMigration(pool: Pool): Promise<void> {
  const tasksDatabaseId = await withTransaction(pool, async (client) => {
    return (await getDatabaseByModuleId(client, TASKS_MODULE_ID))?.id ?? null;
  });
  if (tasksDatabaseId === null) return;
  await stripAll(pool, tasksDatabaseId);
  await withTransaction(pool, async (client) => {
    // Zero affected rows is the expected outcome of a second run: the definition is already gone.
    const deleted = await client.query("DELETE FROM properties WHERE database_id = $1 AND key = 'persistent'", [
      tasksDatabaseId,
    ]);
    if (deleted.rowCount === null || deleted.rowCount > 1) throw new Error("Unexpected Tasks persistent delete count");
  });
  await stripAll(pool, tasksDatabaseId);
}
