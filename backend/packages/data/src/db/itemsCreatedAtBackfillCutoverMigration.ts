import type { Pool } from "pg";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { withTransaction } from "./pool.js";

/** Rows updated per transaction. */
const ITEMS_CREATED_AT_BACKFILL_BATCH_SIZE = 500;

/**
 * Per-tenant data cutover for issue #1594: approximates the unknown creation time of every item that
 * existed before `0143_items_created_at.sql` by its last change time. That migration gave such a row
 * `created_at` = the time of the ALTER, later than its own `updated_at`; a row inserted after it has
 * `created_at <= updated_at` (both default to the inserting transaction's `now()`, and every later
 * write only moves `updated_at` forward). So `created_at > updated_at` is both the filter and the
 * idempotency check: a backfilled row no longer matches, and a second run updates nothing.
 *
 * Only `created_at` is written: `updated_at` is the optimistic-concurrency version, and changing it would
 * turn every client's next `ifVersion` write into a conflict. Each batch of at most
 * `ITEMS_CREATED_AT_BACKFILL_BATCH_SIZE` rows of one database is locked and updated in its own
 * transaction, so no transaction holds many row locks or a long lock window; the database ids come from
 * the tenant's visible databases, so every statement names its partition.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runItemsCreatedAtBackfillCutoverMigration(pool: Pool): Promise<void> {
  const databaseIds = await withTransaction(pool, (client) => visibleDatabaseIds(client));
  for (const databaseId of databaseIds) {
    for (;;) {
      const updated = await withTransaction(pool, async (client) => {
        const result = await client.query(
          `WITH batch AS (
             SELECT id FROM items
              WHERE database_id = $1 AND created_at > updated_at
              ORDER BY id
              LIMIT $2
                FOR UPDATE
           )
           UPDATE items SET created_at = items.updated_at
             FROM batch
            WHERE items.database_id = $1 AND items.id = batch.id AND items.created_at > items.updated_at`,
          [databaseId, ITEMS_CREATED_AT_BACKFILL_BATCH_SIZE],
        );
        // Zero is the normal outcome once a database is done, so the count only decides whether to continue.
        return result.rowCount ?? 0;
      });
      if (updated < ITEMS_CREATED_AT_BACKFILL_BATCH_SIZE) break;
    }
  }
}
