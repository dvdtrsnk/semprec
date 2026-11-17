import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** Creates the system database first when the tenant was not seeded. Uses the ambient tenant scope. */
export async function createTestModuleItem(pool: Pool, moduleId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const database =
      (await getDatabaseByModuleId(client, moduleId)) ??
      (await createDatabase(client, { name: moduleId, system: true, ownerModuleId: moduleId }));
    const item = await createItemWithClient(client, { databaseId: database.id, properties: {} });
    return item.id;
  });
}

/** Creates the Projects database first when the tenant was not seeded. Uses the ambient tenant scope. */
export async function createTestProjectItem(pool: Pool): Promise<string> {
  return createTestModuleItem(pool, PROJECTS_MODULE_ID);
}
