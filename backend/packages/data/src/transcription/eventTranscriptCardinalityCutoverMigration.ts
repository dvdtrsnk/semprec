import type { Pool } from "pg";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * One-time populated-upgrade cutover for issue #1464: switches `Events.transcript` from
 * `one_to_one` to `one_to_many`, so one Event can hold several transcripts (the parts of one
 * meeting). Events is property A, the "one" side, so the trigger from migration 0013 keeps guarding
 * only `item_b`: a transcript still has at most one Event. A fresh seed already declares
 * `one_to_many` (seedTenDatabases.ts). Follows `emailsSenderPeopleCardinalityCutoverMigration.ts`:
 * the same `properties` lock, then an idempotent update. A tenant without an Events database is
 * skipped. An Events database whose `transcript` relation is missing fails the tenant rather than
 * being passed over silently: the Events seed never produces that shape.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`. Only the
 * definition row changes: no edge is written, moved or removed. Idempotent: the update matches only
 * a definition that is not already `one_to_many`, so a second run changes no row.
 */
export async function runEventTranscriptCardinalityCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return; // not seeded yet; the fresh-install seed declares one_to_many

    // The same lock the other properties cutovers take, held on the shared properties table for
    // the cutover's duration.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ id: string }>(
      `SELECT rd.id FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
        WHERE p.database_id = $1 AND p.key = 'transcript'`,
      [events.id],
    );
    const definition = requireSingleRow(rows, "Events.transcript relation definition");

    // Idempotent UPDATE: zero affected rows is legitimate (the definition is already one_to_many),
    // so rowCount is deliberately not checked.
    await client.query(
      `UPDATE relation_definitions SET cardinality = 'one_to_many'
        WHERE id = $1 AND cardinality <> 'one_to_many'`,
      [definition.id],
    );
  });
}
