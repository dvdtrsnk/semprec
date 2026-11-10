import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The calendar properties of an Event (issue #1416), mirroring the Events property list in
 * `seedTenDatabases.ts` (names are NULL there too; labels come from the seed i18n).
 */
const CALENDAR_PROPERTIES = [
  { key: "endDate", type: "date", locked: false, owner: "user" },
  { key: "timeFrom", type: "time", locked: false, owner: "user" },
  { key: "timeTo", type: "time", locked: false, owner: "user" },
  { key: "time", type: "time", locked: true, owner: "system" },
  { key: "place", type: "text", locked: false, owner: "user" },
  { key: "url", type: "url", locked: false, owner: "user" },
  { key: "description", type: "longText", locked: false, owner: "user" },
  { key: "alertMinutes", type: "number", locked: false, owner: "user" },
  { key: "travelMinutes", type: "number", locked: false, owner: "user" },
] as const;

/**
 * Populated-upgrade cutover for issue #1416: adds the calendar properties that `seedTenDatabases.ts`
 * now declares to an Events database seeded by an older build. The Events schema is locked once
 * seeded, so only this code-level migration (direct SQL) may change it. Idempotent (inserts only
 * absent keys, leaves existing properties and items untouched) and a no-op when the tenant has
 * no Events database yet.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runEventsCalendarPropertiesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return; // fresh install: the seed creates the target shape

    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ key: string }>(`SELECT key FROM properties WHERE database_id = $1`, [
      events.id,
    ]);
    const existing = new Set(rows.map((row) => row.key));
    for (const property of CALENDAR_PROPERTIES) {
      if (existing.has(property.key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, $4, $5, NULL)`,
        [events.id, property.key, property.type, property.locked, property.owner],
      );
    }
  });
}
