import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { PROJECTS_OWNER_PROCESS } from "../projects/projectWriteTransform.js";
import { PROJECTS_MODULE_ID } from "./tenDatabaseKeys.js";

export async function runProjectsCompletedAtCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return;
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'completedAt'",
      [projects.id],
    );
    if (rows.length > 0) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'completedAt', NULL, 'date', '{}'::jsonb, false, 'system', $2) RETURNING id`,
      [projects.id, PROJECTS_OWNER_PROCESS],
    );
    requireSingleRow(inserted.rows, "projects completedAt property");
  });
}
