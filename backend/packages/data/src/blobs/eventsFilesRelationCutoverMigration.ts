import type { Pool, PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

async function insertUserRelationProperty(client: PoolClient, databaseId: string, key: string): Promise<string> {
  // `name` is NULL like the seed's (`relate` passes `name: null`); labels come from the seed i18n.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
     VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, 'user', NULL)
     RETURNING id`,
    [databaseId, key],
  );
  return requireSingleRow(rows, "properties row").id;
}

/**
 * Populated-upgrade cutover for issue #1588: adds the user-owned many-to-many pair `Events.files` /
 * `Files.events` that `seedTenDatabases.ts` declares, to a tenant whose Events and Files databases
 * were seeded before it. Both schemas are `schema_locked`, so the pair is written with raw SQL in the
 * three steps `createRelationPropertyWithClient` takes (both properties, the relation definition with
 * `Events.files` as property A, then each property's config pointing at the definition and the other
 * database), the shape `transcription/transcriptsCatalogCutoverMigration.ts` uses.
 *
 * Idempotent: `Events.files` already present means the pair was created (by the seed or an earlier
 * run, both of which write it in one transaction), and nothing is written. A no-op when the tenant has
 * no Events or no Files database yet; the fresh-install seed creates the pair itself.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runEventsFilesRelationCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!events || !files) return;

    // Excludes concurrent schema reads/writes of `properties` for the rest of the transaction, so the
    // presence check below and the inserts that follow it see the same schema.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'files'",
      [events.id],
    );
    if (existing.rows.length > 0) return;

    const eventsPropertyId = await insertUserRelationProperty(client, events.id, "files");
    const filesPropertyId = await insertUserRelationProperty(client, files.id, "events");
    const relation = await client.query<{ id: string }>(
      `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
       VALUES ($1, $2, 'many_to_many') RETURNING id`,
      [eventsPropertyId, filesPropertyId],
    );
    const relationDefinitionId = requireSingleRow(relation.rows, "relation_definitions row").id;
    for (const [propertyId, targetDatabaseId] of [
      [eventsPropertyId, files.id],
      [filesPropertyId, events.id],
    ] as const) {
      const result = await client.query(
        `UPDATE properties
           SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
         WHERE id = $1`,
        [propertyId, relationDefinitionId, targetDatabaseId],
      );
      requireAffectedRows(result, "Events/Files relation property config");
    }
  });
}
