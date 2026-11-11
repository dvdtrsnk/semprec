import type { Pool, PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { HEALTH_RECORDS_MODULE_ID, TASKS_MODULE_ID } from "./tenDatabaseKeys.js";

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
 * Populated-upgrade cutover for issue #1836: adds the user-owned many-to-many pair `Tasks.healthRecords` /
 * `HealthRecords.tasks` that `seedTenDatabases.ts` declares, to a tenant whose Tasks and Health records
 * databases were seeded before it. Both schemas are `schema_locked`, so the pair is written with raw SQL in
 * the three steps `createRelationPropertyWithClient` takes (both properties, the relation definition with
 * `Tasks.healthRecords` as property A, then each property's config pointing at the definition and the other
 * database), the shape `blobs/eventsFilesRelationCutoverMigration.ts` uses. `databases.schema_locked` is not
 * written.
 *
 * Idempotent: when `Tasks.healthRecords` is already present, nothing is written. A no-op when the tenant has
 * no Tasks or no Health records database; the fresh-install seed creates the pair itself.
 *
 * `runTenantCutoverMigrations` calls it for each maintained tenant, inside that tenant's scope.
 */
export async function runHealthRecordTasksCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    const healthRecords = await getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID);
    if (!tasks || !healthRecords) return;

    // Held until the transaction ends, so no other run and no property write can add the pair between the
    // presence check below and the inserts that follow it.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'healthRecords'",
      [tasks.id],
    );
    if (existing.rows.length > 0) return;

    const tasksPropertyId = await insertUserRelationProperty(client, tasks.id, "healthRecords");
    const healthRecordsPropertyId = await insertUserRelationProperty(client, healthRecords.id, "tasks");
    const relation = await client.query<{ id: string }>(
      `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
       VALUES ($1, $2, 'many_to_many') RETURNING id`,
      [tasksPropertyId, healthRecordsPropertyId],
    );
    const relationDefinitionId = requireSingleRow(relation.rows, "relation_definitions row").id;
    for (const [propertyId, targetDatabaseId] of [
      [tasksPropertyId, healthRecords.id],
      [healthRecordsPropertyId, tasks.id],
    ] as const) {
      const result = await client.query(
        `UPDATE properties
           SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
         WHERE id = $1`,
        [propertyId, relationDefinitionId, targetDatabaseId],
      );
      requireAffectedRows(result, "Tasks/Health records relation property config");
    }
  });
}
