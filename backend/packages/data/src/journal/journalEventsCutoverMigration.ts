import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { JOURNAL_EVENT_LINKS_OWNER_PROCESS } from "./journalOwnerProcesses.js";

/**
 * Per-tenant cutover of issue #1609: adds the Journal `events` relation to Events, as seeded for a fresh tenant
 * (`seed/seedTenDatabases.ts`): `many_to_many`, one-directional, owner `system` with owner process
 * `journalEventLinks`. Journal is schema-locked, so the property, its relation definition and its config are
 * written with direct SQL, like `journalProjectCutoverMigration.ts`. A tenant without Journal or Events, or whose
 * Journal already has `events`, is left unchanged, so a second run changes nothing.
 */
export async function runJournalEventsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!journal || !events) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'events'",
      [journal.id],
    );
    if (existing.rows.length) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'events', NULL, 'relation', '{}'::jsonb, false, 'system', $2) RETURNING id`,
      [journal.id, JOURNAL_EVENT_LINKS_OWNER_PROCESS],
    );
    const property = requireSingleRow(inserted.rows, "journal events property");
    const relations = await client.query<{ id: string }>(
      "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, NULL, 'many_to_many') RETURNING id",
      [property.id],
    );
    const relation = requireSingleRow(relations.rows, "journal events relation");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, events.id],
    );
    requireAffectedRows(configured, "journal events config");
  });
}
