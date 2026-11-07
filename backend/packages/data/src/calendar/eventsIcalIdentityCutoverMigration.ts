import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { ICAL_UID_DOMAIN } from "./eventIcalIdentityTransform.js";

/** The two Events properties of issue #1599, exactly as `seedTenDatabases.ts` declares them. */
const ICAL_PROPERTIES = [
  { key: "icalUid", type: "text" },
  { key: "icalSequence", type: "number" },
] as const;

/** Events backfilled per transaction. */
const BACKFILL_BATCH_SIZE = 500;

/**
 * Populated-upgrade cutover for issue #1599, after the Events properties cutover of #1416. First, in
 * one transaction under `LOCK TABLE properties IN EXCLUSIVE MODE`, it inserts the system-owned, locked
 * `icalUid` and `icalSequence` definitions into a tenant's Events database when absent (the schema is
 * `schema_locked`, so direct SQL is the only way in; name, config and owner are the seed's). Then it
 * gives every Event without an `icalUid`, trashed ones included, `icalUid` `<item id>@semprec` and
 * `icalSequence` 0, in batches of 500 ids with one transaction each. `NOT (properties ? 'icalUid')` is
 * the filter and the idempotency check, so a second run writes nothing, and an Event that already has
 * a UID (one created by the Events transform) keeps it. `updated_at` is not changed: the values are
 * system-derived, and moving the version would turn clients' next writes into conflicts.
 *
 * A tenant without an Events database is skipped. Runs once per tenant, in that tenant's scope and
 * under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runEventsIcalIdentityCutoverMigration(pool: Pool): Promise<void> {
  const eventsDatabaseId = await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return null;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
      [events.id, ICAL_PROPERTIES.map((property) => property.key)],
    );
    const existing = new Set(rows.map((row) => row.key));
    for (const property of ICAL_PROPERTIES) {
      if (existing.has(property.key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, true, 'system', NULL)`,
        [events.id, property.key, property.type],
      );
    }
    return events.id;
  });
  if (eventsDatabaseId === null) return;

  for (;;) {
    const updated = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `WITH batch AS (
           SELECT id FROM items
            WHERE database_id = $1 AND NOT (properties ? 'icalUid')
            ORDER BY id
            LIMIT $2
              FOR UPDATE
         )
         UPDATE items
            SET properties = items.properties
              || jsonb_build_object('icalUid', items.id::text || $3, 'icalSequence', 0)
           FROM batch
          WHERE items.database_id = $1 AND items.id = batch.id AND NOT (items.properties ? 'icalUid')`,
        [eventsDatabaseId, BACKFILL_BATCH_SIZE, `@${ICAL_UID_DOMAIN}`],
      );
      // Zero is the normal outcome once every Event has a UID, so the count only decides whether to continue.
      return result.rowCount ?? 0;
    });
    if (updated < BACKFILL_BATCH_SIZE) return;
  }
}
