import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { AREAS_MODULE_ID } from "./tenDatabaseKeys.js";

/** Adds the three missing Areas properties to each scoped tenant's locked system schema. */
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
  });
}
