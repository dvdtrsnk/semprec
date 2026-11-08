import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { AREAS_MODULE_ID } from "./tenDatabaseKeys.js";
import { migrateItemPropertyWithClient } from "../chokePoint/itemMigrationWrites.js";

/** Upgrades the scoped tenant's Areas properties, relations and active values. */
export async function runAreasPropertiesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
    if (!areas) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ key: string }>("SELECT key FROM properties WHERE database_id = $1", [
      areas.id,
    ]);
    const existing = new Set(rows.map((row) => row.key));
    for (const [key, type] of [
      ["icon", "text"],
      ["color", "color"],
      ["position", "number"],
    ] as const) {
      if (existing.has(key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, false, 'user', NULL)`,
        [areas.id, key, type],
      );
    }
    const relations = await client.query(
      `UPDATE relation_definitions SET cardinality = 'one_to_many'
       WHERE property_id_a IN (SELECT id FROM properties WHERE database_id = $1 AND key IN ('company', 'healthRecord'))
         AND cardinality = 'one_to_one'`,
      [areas.id],
    );
    if (
      relations.rowCount === null ||
      !Number.isInteger(relations.rowCount) ||
      relations.rowCount < 0 ||
      relations.rowCount > 2
    ) {
      throw new Error("Unexpected Areas relation cutover count");
    }
    const active = await client.query(
      `UPDATE properties SET config = jsonb_set(config, '{default}', 'true'::jsonb)
       WHERE database_id = $1 AND key = 'active' AND config->'default' IS DISTINCT FROM 'true'::jsonb`,
      [areas.id],
    );
    if (active.rowCount === null || !Number.isInteger(active.rowCount) || active.rowCount < 0 || active.rowCount > 1) {
      throw new Error("Unexpected Areas active property cutover count");
    }
    const items = await client.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND (NOT properties ? 'active' OR properties->'active' = 'null'::jsonb) FOR UPDATE`,
      [areas.id],
    );
    for (const item of items.rows) {
      await migrateItemPropertyWithClient(client, {
        databaseId: areas.id,
        itemId: item.id,
        key: "active",
        change: { kind: "set", value: true },
      });
    }
  });
}
