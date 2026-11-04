import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { PEOPLE_MODULE_ID } from "./tenDatabaseKeys.js";

export async function runPeoplePhonesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!people) return;
    await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'phones', NULL, 'longText', '{}'::jsonb, false, 'user', NULL)
       ON CONFLICT (database_id, key) DO NOTHING`,
      [people.id],
    );
  });
}
