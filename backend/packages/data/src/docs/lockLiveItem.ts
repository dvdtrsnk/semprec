import type { PoolClient } from "pg";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { NotFoundError } from "../errors.js";
import type { ItemRow } from "../types.js";

/**
 * Resolves `itemId` to a live item of the caller's tenant and holds its row locked for the rest of the
 * transaction, so a concurrent trash cannot slip in between this check and the write that follows. A missing,
 * trashed or foreign item is one `NotFoundError`: the read is confined to the caller's tenant by row-level security,
 * so a foreign id is answered exactly like an unknown one.
 */
export async function lockLiveItem(client: PoolClient, itemId: string): Promise<ItemRow> {
  const [visible] = await getItemsByIds(client, [itemId]);
  const locked = visible ? await lockItemById(client, visible.databaseId, itemId) : null;
  if (!locked || locked.deletedAt !== null) {
    throw new NotFoundError("Item not found", { resource: "item", itemId });
  }
  return locked;
}
