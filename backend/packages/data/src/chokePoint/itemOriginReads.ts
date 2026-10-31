// Owns the Inbox-origin stamp on item reads: one set-based lookup of `item_origins` per page. The
// rows are written by the inbox domain (inbox/itemOriginsStore.ts); this module only reads them, so
// the choke point never imports the inbox domain (chokepoint-knows-no-domain).
import type { PoolClient } from "pg";

/**
 * Stamps `fromInbox` on a page of items from one set-based lookup: true exactly when the item has an
 * origin row captured through the Inbox. Rows are tenant-scoped by row-level security; an empty page
 * issues no query.
 */
export async function withFromInbox<T extends { id: string }>(
  client: PoolClient,
  items: T[],
): Promise<Array<T & { fromInbox: boolean }>> {
  if (items.length === 0) return [];
  const { rows } = await client.query<{ item_id: string }>(
    "SELECT item_id FROM item_origins WHERE item_id = ANY($1::uuid[]) AND capture_channel = 'inbox'",
    [items.map((item) => item.id)],
  );
  const fromInbox = new Set(rows.map((row) => row.item_id));
  return items.map((item) => ({ ...item, fromInbox: fromInbox.has(item.id) }));
}
