import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { EVENT_OCCURRENCE_DATE_PROPERTY_KEY, EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";

/** The two Events properties of issue gh-1843, exactly as `seedTenDatabases.ts` declares them. */
const OCCURRENCE_PROPERTIES = [
  { key: EVENT_SERIES_ID_PROPERTY_KEY, type: "text" },
  { key: EVENT_OCCURRENCE_DATE_PROPERTY_KEY, type: "date" },
] as const;

/**
 * Populated-upgrade cutover for issue gh-1843: gives a tenant's Events database the system-owned `seriesId` and
 * `occurrenceDate` properties that a materialized occurrence carries, with the definitions `seedTenDatabases.ts`
 * declares (types `text` and `date`, empty config, not locked, owner process `calendar`). The schema is
 * `schema_locked`, so direct SQL is the only way in, in one transaction under `LOCK TABLE properties IN EXCLUSIVE
 * MODE` (the pattern of `eventsRecurrenceCutoverMigration.ts`). No Event row is touched: an Event without the keys is
 * not an occurrence item.
 *
 * Idempotent: a key the Events database already has is left as it is. A tenant without an Events database is
 * skipped. Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runEventsOccurrenceCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
      [events.id, OCCURRENCE_PROPERTIES.map((property) => property.key)],
    );
    const existing = new Set(rows.map((row) => row.key));
    for (const property of OCCURRENCE_PROPERTIES) {
      if (existing.has(property.key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, false, 'system', $4)`,
        [events.id, property.key, property.type, CALENDAR_MODULE_ID],
      );
    }
  });
}
