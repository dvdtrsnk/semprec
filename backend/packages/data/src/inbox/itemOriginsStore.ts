import type { PoolClient } from "pg";

export type CaptureChannel = "inbox" | "transcript";

/** Where a confirmed proposal's created items came from; shared by every item one confirm creates. */
export interface ItemOriginSource {
  proposalId: string;
  inboxItemId: string | null;
  sourceTranscriptId: string | null;
  capturedAt: string | null;
  captureTimeBasis: "inboxCapture" | "unknown";
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
    `INSERT INTO item_origins (item_id, proposal_id, inbox_item_id, source_transcript_id, captured_at, capture_channel, capture_time_basis)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6, $7
     ON CONFLICT (tenant_id, item_id) DO NOTHING`,
    [
      itemIds,
      source.proposalId,
      source.inboxItemId,
      source.sourceTranscriptId,
      source.capturedAt,
      source.captureChannel,
      source.captureTimeBasis,
    ],
  );
}

/** Removes the origin row of a permanently deleted item; no row is a legitimate outcome (the item was not created by a proposal). */
export async function deleteItemOrigin(client: PoolClient, itemId: string): Promise<void> {
  await client.query("DELETE FROM item_origins WHERE item_id = $1", [itemId]);
}

/**
 * Removes the origin rows of `itemIds` that belong to the proposal `proposalId`, in the caller's transaction, and
 * returns how many it removed. An item with no row of that proposal is skipped: the undo of a confirmed card
 * (issue #1943) names every item it trashes, and a card that wrote no origin row (a `mailThread` card) has none.
 */
export async function deleteItemOriginsOfProposal(
  client: PoolClient,
  proposalId: string,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const { rowCount } = await client.query(
    "DELETE FROM item_origins WHERE proposal_id = $1 AND item_id = ANY($2::uuid[])",
    [proposalId, itemIds],
  );
  return rowCount ?? 0;
}
