import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { requireAffectedRows } from "../db/pool.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import type { DatabaseRow } from "../types.js";

export { PAGES_MODULE_ID };

/** Property keys of a Pages item: the mirrored title and the id of the host item or parent page. */
const TITLE_KEY = "title";
const PARENT_ITEM_ID_KEY = "parentItemId";

/**
 * Returns the tenant's hidden `pages` system database (`docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md`),
 * creating it on first use: the system database with key `pages` and no name, its two system-owned properties
 * (`title`, `parentItemId`, owner process `pages`), then `schema_locked`. Creation takes a transaction-scoped advisory
 * lock keyed by the tenant and looks again after it, so two concurrent first calls of one tenant create exactly one
 * database: the later one waits for the first one's commit and then finds its database.
 */
export async function ensurePagesDatabase(client: PoolClient): Promise<DatabaseRow> {
  const existing = await databasesStore.getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (existing) return existing;

  // The tenant comes from the connection's scope (`app_tenant_default()`), so another tenant's first call does not wait.
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
