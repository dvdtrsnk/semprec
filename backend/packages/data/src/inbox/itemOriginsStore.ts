import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import type { ItemRow } from "../types.js";

export type CaptureChannel = "inbox" | "transcript";

export type CaptureTimeBasis = "inboxCapture" | "unknown";

const CAPTURE_CHANNELS: readonly string[] = ["inbox", "transcript"];
const CAPTURE_TIME_BASES: readonly string[] = ["inboxCapture", "unknown"];

function isCaptureChannel(value: string): value is CaptureChannel {
  return CAPTURE_CHANNELS.includes(value);
}

function isCaptureTimeBasis(value: string): value is CaptureTimeBasis {
  return CAPTURE_TIME_BASES.includes(value);
}

/** Shared by every item one confirm creates. */
export interface ItemOriginSource {
  proposalId: string;
  inboxItemId: string | null;
  sourceTranscriptId: string | null;
  capturedAt: string | null;
  captureTimeBasis: CaptureTimeBasis;
  captureChannel: CaptureChannel;
}

/** An existing row is left untouched, so a replayed write never changes or duplicates it. */
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

/**
 * Items with no row of that proposal are skipped: the undo of a confirmed card names every item it trashes, and some
 * cards (`mailThread`) write no origin rows.
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

export interface OriginSibling {
  itemId: string;
  /** Falls back to the item id when there is no title value. */
  label: string;
}

export interface ItemOrigin {
  proposalId: string;
  /** Null for a transcript card and when the source was never recorded. */
  inboxItemId: string | null;
  /** Always null for the basis `unknown`. */
  capturedAt: string | null;
  captureTimeBasis: CaptureTimeBasis;
  captureChannel: CaptureChannel;
  /** Null for a transcript origin and when the Inbox item is gone, trashed or has no text. */
  sourceText: string | null;
  /** Oldest first, ties by id; uncapped. */
  siblings: OriginSibling[];
}

interface OriginDbRow {
  proposal_id: string;
  inbox_item_id: string | null;
  captured_at: Date | null;
  capture_time_basis: string;
  capture_channel: string;
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function labelOf(client: PoolClient, titleKeys: Map<string, string | null>, item: ItemRow): Promise<string> {
  if (!titleKeys.has(item.databaseId)) {
    const title = (await listPropertiesByDatabase(client, item.databaseId)).find(({ type }) => type === "title");
    titleKeys.set(item.databaseId, title?.key ?? null);
  }
  const titleKey = titleKeys.get(item.databaseId);
  const value = titleKey ? item.properties[titleKey] : undefined;
  return typeof value === "string" && value.length > 0 ? value : item.id;
}

/**
 * `null` for a missing, trashed or not-proposal-created item; callers cannot tell those apart, so another tenant's id
 * answers as unknown. Read-only.
 */
export async function readItemOrigin(client: PoolClient, itemId: string): Promise<ItemOrigin | null> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) return null;
  const { rows } = await client.query<OriginDbRow>(
    `SELECT proposal_id, inbox_item_id, captured_at, capture_time_basis, capture_channel
       FROM item_origins WHERE item_id = $1`,
    [itemId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!isCaptureChannel(row.capture_channel) || !isCaptureTimeBasis(row.capture_time_basis)) {
    throw new Error(`item_origins row of item ${itemId} holds an unknown channel or time basis`);
  }

  let sourceText: string | null = null;
  if (row.capture_channel === "inbox" && row.inbox_item_id !== null) {
    const [source] = await itemsStore.getItemsByIds(client, [row.inbox_item_id]);
    const text = source?.properties.text;
    sourceText = typeof text === "string" ? text : null;
  }

  const { rows: siblingRows } = await client.query<{ item_id: string }>(
    "SELECT item_id FROM item_origins WHERE proposal_id = $1 AND item_id <> $2",
    [row.proposal_id, itemId],
  );
  const siblingItems = (
    await itemsStore.getItemsByIds(
      client,
      siblingRows.map((sibling) => sibling.item_id),
    )
  ).sort((left, right) => compareAscii(left.createdAt, right.createdAt) || compareAscii(left.id, right.id));
  const titleKeys = new Map<string, string | null>();
  const siblings: OriginSibling[] = [];
  for (const sibling of siblingItems) {
    siblings.push({ itemId: sibling.id, label: await labelOf(client, titleKeys, sibling) });
  }

  return {
    proposalId: row.proposal_id,
    inboxItemId: row.inbox_item_id,
    capturedAt: row.captured_at === null ? null : row.captured_at.toISOString(),
    captureTimeBasis: row.capture_time_basis,
    captureChannel: row.capture_channel,
    sourceText,
    siblings,
  };
}
