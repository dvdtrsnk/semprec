import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { migrateItemPropertyWithClient } from "../chokePoint/itemMigrationWrites.js";
import { PROJECTS_MODULE_ID } from "./tenDatabaseKeys.js";

/** Adds the locked system schema property and numbers missing live pins in the scoped tenant. */
export async function runProjectsPinnedOrderCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id=$1 AND key='pinnedOrder'",
      [projects.id],
    );
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO properties (database_id,key,name,type,config,locked,owner,owner_process)
        VALUES ($1,'pinnedOrder',NULL,'number','{}'::jsonb,false,'user',NULL)`,
        [projects.id],
      );
    }
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id=$1 AND deleted_at IS NULL
       AND properties->'pinned'='true'::jsonb AND properties->>'pinnedOrder' IS NULL
       ORDER BY (properties->>'name') COLLATE "cs-x-icu" ASC NULLS LAST, id FOR UPDATE`,
      [projects.id],
    );
    for (const [index, row] of rows.entries()) {
      await migrateItemPropertyWithClient(client, {
        databaseId: projects.id,
        itemId: row.id,
        key: "pinnedOrder",
        change: { kind: "set", value: index + 1 },
      });
    }
  });
}
