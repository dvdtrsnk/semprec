import type { PoolClient } from "pg";

export type CaptureChannel = "inbox" | "transcript";

/** Where a confirmed proposal's created items came from; shared by every item one confirm creates. */
export interface ItemOriginSource {
  proposalId: string;
  inboxItemId: string | null;
  sourceTranscriptId: string | null;
  capturedAt: string;
  captureChannel: CaptureChannel;
}

/**
 * Records the origin of each item a confirm created, in the confirm's own transaction. A row that
 * already exists for an item is left untouched, so a replayed write never changes or duplicates it.
 */
export async function insertItemOrigins(
  client: PoolClient,
  itemIds: string[],
  source: ItemOriginSource,
): Promise<void> {
  if (itemIds.length === 0) return;
  await client.query(
    `INSERT INTO item_origins (item_id, proposal_id, inbox_item_id, source_transcript_id, captured_at, capture_channel)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6
     ON CONFLICT (tenant_id, item_id) DO NOTHING`,
    [
      itemIds,
      source.proposalId,
      source.inboxItemId,
      source.sourceTranscriptId,
      source.capturedAt,
      source.captureChannel,
    ],
  );
}

/** Removes the origin row of a permanently deleted item; no row is a legitimate outcome (the item was not created by a proposal). */
export async function deleteItemOrigin(client: PoolClient, itemId: string): Promise<void> {
  await client.query("DELETE FROM item_origins WHERE item_id = $1", [itemId]);
}

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
