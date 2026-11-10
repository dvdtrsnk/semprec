import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { ensureUnplannedArea } from "./seedUnplannedArea.js";
import { AREAS_MODULE_ID } from "./tenDatabaseKeys.js";

export async function runAreasUnplannedCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
    if (!areas) return;
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'systemActive'",
      [areas.id],
    );
    if (rows.length === 0) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, 'systemActive', NULL, 'checkbox', '{}'::jsonb, true, 'user', NULL) RETURNING id`,
        [areas.id],
      );
      requireSingleRow(inserted.rows, "areas systemActive property");
    }
    await ensureUnplannedArea(client, areas.id);
  });
}
