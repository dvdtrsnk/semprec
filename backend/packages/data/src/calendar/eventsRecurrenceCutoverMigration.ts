import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_RECURRENCE_PROPERTY_KEY } from "./eventRecurrenceRule.js";

/**
 * Populated-upgrade cutover for issue gh-1817: gives a tenant's Events database the user-owned `recurrence`
 * property, the definition `seedTenDatabases.ts` declares (type `json`, empty config, not locked, no name, no
 * owner process). The schema is `schema_locked`, so direct SQL is the only way in, in one transaction under
 * `LOCK TABLE properties IN EXCLUSIVE MODE` (the pattern of
 * `transcription/transcriptsCatalogCutoverMigration.ts`). No Event row is touched: an Event without the key has
 * no recurrence.
 *
 * Idempotent: a tenant whose Events database already has a property with the key is left as it is. A tenant
 * without an Events database is skipped. Runs once per tenant, in that tenant's scope and under row-level
 * security, via `runTenantCutoverMigrations`.
 */
export async function runEventsRecurrenceCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [events.id, EVENT_RECURRENCE_PROPERTY_KEY],
    );
    if (rows.length > 0) return;
    await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, NULL, 'json', '{}'::jsonb, false, 'user', NULL)`,
      [events.id, EVENT_RECURRENCE_PROPERTY_KEY],
    );
  });
}
