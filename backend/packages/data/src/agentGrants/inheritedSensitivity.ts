import type { PoolClient } from "pg";
import { SENSITIVITY_INHERITING_MODULE_IDS } from "../seed/sensitiveDatabaseKeys.js";

// Sensitivity inherited through relation edges (issue #1999): an item of the Files, Transcripts or Inbox system
// database that is linked to an item of a sensitive database is treated as sensitive, and an agent needs the same
// access to every sensitive database it is linked to as to the item's own database. This module only answers which
// sensitive databases an item is linked to; `agentDatabaseAccess.ts` turns the answer into the access decision.

interface LinkRow {
  item_id: string;
  database_id: string;
}

/**
 * For each of `itemIds` that belongs to a sensitivity-inheriting database (`SENSITIVITY_INHERITING_MODULE_IDS`, a
 * system database) and is linked to a sensitive database, the ids of those sensitive databases, in one query. An
 * item that inherits nothing has no entry. A link is a row of `item_relations` in either direction (an edge has no
 * deleted state of its own) whose other endpoint is not soft-deleted. The items asked about are not filtered by `deleted_at`:
 * a trashed file stays as sensitive as it was, so a read of the trash and a restore decide like a live read.
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

/**
 * The ids of the sensitive databases an item of an inheriting database is linked to through live edges, both
 * directions, endpoints not soft-deleted; empty for an item that is not linked to one and for an item of any other
 * database. One query.
 */
export async function sensitiveSourceDatabaseIds(client: PoolClient, itemId: string): Promise<string[]> {
  return (await sensitiveSourceDatabaseIdsByItem(client, [itemId])).get(itemId.toLowerCase()) ?? [];
}

/**
 * The ids among `itemIds` that are linked to a sensitive database in `databaseIds` (`sensitiveSourceDatabaseIdsByItem`
 * decides what a link is), in one query. An agent's read hides these items when `databaseIds` are the databases its
 * project may not read.
 */
export async function itemIdsLinkedToDatabases(
  client: PoolClient,
  itemIds: readonly string[],
  databaseIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (databaseIds.size === 0) return new Set();
  const links = await sensitiveSourceDatabaseIdsByItem(client, itemIds);
  return new Set([...links].filter(([, sourceIds]) => sourceIds.some((id) => databaseIds.has(id))).map(([id]) => id));
}
