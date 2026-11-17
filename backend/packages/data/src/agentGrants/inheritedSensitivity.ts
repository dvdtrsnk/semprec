import type { PoolClient } from "pg";
import { SENSITIVITY_INHERITING_MODULE_IDS } from "../seed/sensitiveDatabaseKeys.js";

// An item of the Files, Transcripts or Inbox system database linked to an item of a sensitive database is treated
// as sensitive: an agent needs access to every such linked database too. This module only finds the links;
// `agentDatabaseAccess.ts` decides.

interface LinkRow {
  item_id: string;
  database_id: string;
}

/**
 * For each inheriting item, the sensitive databases it is linked to (either edge direction, other endpoint not
 * soft-deleted). The items themselves are not filtered by `deleted_at`: a trashed file stays as sensitive, so trash
 * reads and restores decide like live reads.
 */
export async function sensitiveSourceDatabaseIdsByItem(
  client: PoolClient,
  itemIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byItem = new Map<string, string[]>();
  if (itemIds.length === 0) return byItem;
  const { rows } = await client.query<LinkRow>(
    `SELECT DISTINCT self.id AS item_id, other_db.id AS database_id
     FROM items self
     JOIN databases self_db ON self_db.id = self.database_id AND self_db.system AND self_db.owner_module_id = ANY($2::text[])
     JOIN item_relations e ON e.item_a = self.id OR e.item_b = self.id
     JOIN items other ON other.id = CASE WHEN e.item_a = self.id THEN e.item_b ELSE e.item_a END AND other.deleted_at IS NULL
     JOIN databases other_db ON other_db.id = other.database_id AND other_db.sensitive
     WHERE self.id = ANY($1::uuid[])
     ORDER BY self.id, other_db.id`,
    [itemIds, SENSITIVITY_INHERITING_MODULE_IDS],
  );
  for (const row of rows) {
    const databaseIds = byItem.get(row.item_id) ?? [];
    databaseIds.push(row.database_id);
    byItem.set(row.item_id, databaseIds);
  }
  return byItem;
}

export async function sensitiveSourceDatabaseIds(client: PoolClient, itemId: string): Promise<string[]> {
  return (await sensitiveSourceDatabaseIdsByItem(client, [itemId])).get(itemId.toLowerCase()) ?? [];
}

/** The ids among `itemIds` linked to one of `databaseIds` (typically the databases the project may not read). */
export async function itemIdsLinkedToDatabases(
  client: PoolClient,
  itemIds: readonly string[],
  databaseIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (databaseIds.size === 0) return new Set();
  const links = await sensitiveSourceDatabaseIdsByItem(client, itemIds);
  return new Set([...links].filter(([, sourceIds]) => sourceIds.some((id) => databaseIds.has(id))).map(([id]) => id));
}
