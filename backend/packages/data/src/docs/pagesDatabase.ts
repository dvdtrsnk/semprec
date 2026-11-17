import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { requireAffectedRows } from "../db/pool.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import type { DatabaseRow } from "../types.js";

export { PAGES_MODULE_ID };

const TITLE_KEY = "title";
const PARENT_ITEM_ID_KEY = "parentItemId";

/**
 * Created on first use under a tenant-keyed transaction advisory lock and re-checked after it, so concurrent first
 * calls create exactly one database.
 */
export async function ensurePagesDatabase(client: PoolClient): Promise<DatabaseRow> {
  const existing = await databasesStore.getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (existing) return existing;

  // Keyed by `app_tenant_default()`, so other tenants never wait.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('pages-database:' || app_tenant_default()::text, 0))",
  );
  const afterLock = await databasesStore.getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (afterLock) return afterLock;

  const database = await databasesStore.createDatabase(client, {
    name: null,
    key: PAGES_MODULE_ID,
    system: true,
    ownerModuleId: PAGES_MODULE_ID,
  });
  await propertiesStore.createProperty(client, {
    databaseId: database.id,
    key: TITLE_KEY,
    name: null,
    type: "title",
    owner: "system",
    ownerProcess: PAGES_MODULE_ID,
  });
  await propertiesStore.createProperty(client, {
    databaseId: database.id,
    key: PARENT_ITEM_ID_KEY,
    name: null,
    type: "text",
    owner: "system",
    ownerProcess: PAGES_MODULE_ID,
  });
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [database.id]),
    "pages database schema lock",
  );
  return { ...database, schemaLocked: true };
}
