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
 * Deletes the Tasks `persistent` definition once every writer that may have validated against it has ended.
 *
 * Every item write validates its keys against the definitions it reads in its own write transaction
 * (`listPropertiesByDatabase` in `createItemWithClient`/`updateItemWithClient`), at READ COMMITTED; that read holds
 * ACCESS SHARE on `properties` until the writer's transaction ends. ACCESS EXCLUSIVE is the one mode that conflicts
 * with it, so the lock is granted only when every transaction that has read `properties` has committed or rolled back:
 * a writer that validated `persistent` and then paused has stored its value by then. Readers and writers arriving
 * while the lock is held or waited for queue behind it, and once the deletion commits they no longer see the
 * definition, so the generic write refuses the key. The lock is global (`properties` holds every tenant's
 * definitions); `lock_timeout` bounds each wait to acquire it, not how long it is held or how long schema reads wait
 * in total. One attempt: a timeout (SQLSTATE 55P03) rolls this transaction back and fails the cutover.
 */
async function deleteDefinitionAfterValidatedWriters(client: PoolClient, tasksDatabaseId: string): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("LOCK TABLE properties IN ACCESS EXCLUSIVE MODE");
  // Zero affected rows means another run deleted it first.
  const deleted = await client.query("DELETE FROM properties WHERE database_id = $1 AND key = 'persistent'", [
    tasksDatabaseId,
  ]);
  if (deleted.rowCount === null || deleted.rowCount > 1) throw new Error("Unexpected Tasks persistent delete count");
}

/**
 * Per-tenant cutover of issue #2009: removes the unused Tasks property `persistent`. It resolves the tenant's Tasks
 * database (a tenant without one is skipped) and removes the key `persistent` from the stored properties of every
 * Tasks item that has it, trashed items included, in batches of at most 500 ids, each batch in its own committed
 * transaction and selected through `properties ? 'persistent'`. It then deletes the definition in a transaction of its
 * own, after the lock in `deleteDefinitionAfterValidatedWriters` has waited out every writer that validated against
 * it, and strips once more in batches: what a drained writer stored is removed, and no write can store the key
 * afterwards. Like the Tasks series cutover (docs/adr/2026-11-07-task-series-cutover-uses-bounded-owner-backfill.md),
 * the Tasks module removes the values with SQL as their owner: `updated_at` is not changed and nothing is announced.
 * A second run changes nothing and, the definition being gone, takes no lock.
 *
 * Contract step with a Task-called-for compatibility exception: the previous release still copies `persistent` into
 * the next instance of a recurring task, so once the definition is gone its recurring completion fails, during the
 * deploy window and after a rollback, until a fix-forward. If the lock times out, the batches already stripped stay
 * committed, the definition stays, and a rerun continues; the cutover is not atomic as a whole. See
 * docs/adr/2026-11-09-persistent-removal-drains-validated-writers-with-a-properties-lock.md.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runTasksPersistentRemovalCutoverMigration(pool: Pool): Promise<void> {
  const tasksDatabaseId = await withTransaction(pool, async (client) => {
    return (await getDatabaseByModuleId(client, TASKS_MODULE_ID))?.id ?? null;
  });
  if (tasksDatabaseId === null) return;
  await stripAll(pool, tasksDatabaseId);
  // Once the definition is gone nothing can validate the key any more, so a later run takes no lock.
  const defined = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query("SELECT 1 FROM properties WHERE database_id = $1 AND key = 'persistent'", [
      tasksDatabaseId,
    ]);
    return (rowCount ?? 0) > 0;
  });
  if (defined) {
    await withTransaction(pool, (client) => deleteDefinitionAfterValidatedWriters(client, tasksDatabaseId));
  }
  await stripAll(pool, tasksDatabaseId);
}
