import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { insertItem } from "../chokePoint/itemsStore.js";

export async function ensureUnplannedArea(client: PoolClient, areasDatabaseId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('unplanned-area:' || $1::text, 0))", [
    areasDatabaseId,
  ]);
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties->'systemActive' = 'true'::jsonb LIMIT 1",
    [areasDatabaseId],
  );
  if (existing.rows.length > 0) return;
  const catalogs = await loadModuleCatalogs(import.meta.url);
  const name = resolveCatalogLabel(null, catalogs.cs, catalogs.en, "seed.areas.unplanned.name");
  await insertItem(client, { databaseId: areasDatabaseId, properties: { name, active: true, systemActive: true } });
}
