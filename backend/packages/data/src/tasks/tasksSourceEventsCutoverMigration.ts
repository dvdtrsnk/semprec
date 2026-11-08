import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export async function runTasksSourceEventsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!tasks || !events) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'sourceEvents'",
      [tasks.id],
    );
    if (existing.rows.length) return;
    const definitions = await client.query<{ id: string | null; property_id_b: string | null }>(
      `SELECT r.id, r.property_id_b FROM properties p LEFT JOIN relation_definitions r ON r.property_id_a = p.id
       WHERE p.database_id = $1 AND p.key = 'actionItems'`,
      [events.id],
    );
    if (!definitions.rows.length) return;
    const relation = requireSingleRow(definitions.rows, "actionItems relation");
    if (!relation.id || relation.property_id_b !== null)
      throw new Error("Incompatible actionItems relation definition");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'sourceEvents', NULL, 'relation', '{}'::jsonb, false, 'user', NULL) RETURNING id`,
      [tasks.id],
    );
    const property = requireSingleRow(inserted.rows, "sourceEvents property");
    const linked = await client.query(
      "UPDATE relation_definitions SET property_id_b = $2 WHERE id = $1 AND property_id_b IS NULL",
      [relation.id, property.id],
    );
    requireAffectedRows(linked, "actionItems inverse");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, events.id],
    );
    requireAffectedRows(configured, "sourceEvents config");
  });
}
