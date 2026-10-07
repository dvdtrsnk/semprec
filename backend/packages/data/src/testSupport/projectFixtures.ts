import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Creates an item in the Projects database of the ambient tenant scope and returns its id, creating
 * the (system) Projects database first when the tenant was not seeded.
 */
export async function createTestProjectItem(pool: Pool): Promise<string> {
  return withTransaction(pool, async (client) => {
    const database =
      (await getDatabaseByModuleId(client, PROJECTS_MODULE_ID)) ??
      (await createDatabase(client, { name: PROJECTS_MODULE_ID, system: true, ownerModuleId: PROJECTS_MODULE_ID }));
    const item = await createItemWithClient(client, { databaseId: database.id, properties: {} });
    return item.id;
  });
}
