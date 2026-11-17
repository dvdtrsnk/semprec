import type { PoolClient } from "pg";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";

/**
 * Holds the row lock so a concurrent trash cannot slip between this check and the following write. RLS makes a
 * foreign id answer exactly like an unknown one.
 */
export async function lockLiveItem(client: PoolClient, itemId: string): Promise<ItemRow> {
  const [visible] = await getItemsByIds(client, [itemId]);
  const locked = visible ? await lockItemById(client, visible.databaseId, itemId) : null;
  if (!locked || locked.deletedAt !== null) {
    throw new NotFoundError("Item not found", { resource: "item", itemId });
  }
  return locked;
}
