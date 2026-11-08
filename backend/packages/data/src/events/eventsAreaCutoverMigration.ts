import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { AREAS_MODULE_ID, EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export async function runEventsAreaCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!areas || !events) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'events'",
      [areas.id],
    );
    if (existing.rows.length > 0) return;
    const properties: string[] = [];
    for (const [databaseId, key] of [
      [areas.id, "events"],
      [events.id, "area"],
    ] as const) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, 'user', NULL) RETURNING id`,
        [databaseId, key],
      );
      properties.push(requireSingleRow(result.rows, "properties row").id);
    }
    const [areaPropertyId, eventPropertyId] = properties;
    if (!areaPropertyId || !eventPropertyId) throw new Error("Missing relation properties");
    const relation = await client.query<{ id: string }>(
      `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
       VALUES ($1, $2, 'one_to_many') RETURNING id`,
      [areaPropertyId, eventPropertyId],
    );
    const relationId = requireSingleRow(relation.rows, "relation_definitions row").id;
    for (const [propertyId, targetId] of [
      [areaPropertyId, events.id],
      [eventPropertyId, areas.id],
    ] as const) {
      const result = await client.query(
        `UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
         WHERE id = $1`,
        [propertyId, relationId, targetId],
      );
      requireAffectedRows(result, "relation property config");
    }
  });
}
