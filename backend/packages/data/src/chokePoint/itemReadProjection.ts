import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import { projectItemForRead } from "./hooks.js";

/** Resolves owners in the caller's tenant transaction, once per distinct database on the page. */
export async function projectItemsForRead<T extends ItemRow>(client: PoolClient, items: T[]): Promise<T[]> {
  if (items.length === 0) return [];
  const { rows } = await client.query<{ id: string; owner_module_id: string | null }>(
    "SELECT id, owner_module_id FROM databases WHERE id = ANY($1::uuid[])",
    [[...new Set(items.map((item) => item.databaseId))]],
  );
  const owners = new Map(rows.map((row) => [row.id, row.owner_module_id]));
  return items.map((item) => projectItemForRead(item, owners.get(item.databaseId) ?? null));
}
