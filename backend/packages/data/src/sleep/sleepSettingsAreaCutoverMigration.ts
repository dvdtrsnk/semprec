import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { SLEEP_SETTINGS_AREA_KEY, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { AREAS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Populated-upgrade cutover for issue gh-1833: adds to the `sleepSettings` database of a tenant that lacks it the
 * one-to-one `area` relation property to the Areas database that `seedSleepModule.ts` creates for a new tenant.
 * The relation is user-owned and has no inverse property (`property_id_b` is null); its property has a null
 * `name`, as the seed's has. No edge is written, so `areaId` stays null until a user sets one.
 *
 * `sleepSettings` is `schema_locked` and `propertiesStore` refuses to change a locked schema, so the property,
 * the relation definition and the property config are written with raw SQL in the three steps
 * `transcription/transcriptsCatalogCutoverMigration.ts` uses. `databases.schema_locked` is not written.
 *
 * One transaction. It does nothing when the tenant has no `sleepSettings` or no Areas database. Otherwise it
 * takes an exclusive lock on `properties` and only then checks for the `area` property, so of two runs the
 * second waits and finds the property the first inserted. A tenant that has the `area` property is left as it
 * is, which makes a second run write nothing; the step does not repair a property that exists.
 *
 * `runTenantCutoverMigrations` calls it for each maintained tenant, inside that tenant's scope.
 */
export async function runSleepSettingsAreaCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const settings = await getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID);
    const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
    if (!settings || !areas) return;

    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [settings.id, SLEEP_SETTINGS_AREA_KEY],
    );
    if (existing.rows.length > 0) return;

    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, 'user', NULL)
       RETURNING id`,
      [settings.id, SLEEP_SETTINGS_AREA_KEY],
    );
    const propertyId = requireSingleRow(property.rows, "properties row").id;
    const relation = await client.query<{ id: string }>(
      `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
       VALUES ($1, NULL, 'one_to_one')
       RETURNING id`,
      [propertyId],
    );
    const relationDefinitionId = requireSingleRow(relation.rows, "relation_definitions row").id;
    const result = await client.query(
      `UPDATE properties
         SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
       WHERE id = $1`,
      [propertyId, relationDefinitionId, areas.id],
    );
    requireAffectedRows(result, "sleepSettings.area config");
  });
}
