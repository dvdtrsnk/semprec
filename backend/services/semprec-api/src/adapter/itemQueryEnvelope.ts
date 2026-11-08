import type { Pool } from "pg";
import type { ItemRow, ItemValueLinks } from "@semprec/data";
import type { Item } from "@semprec/shared";
import { toItemEnvelopes, type ItemEnvelope } from "./itemEnvelope.js";

/** A query page whose items carry `links` only when the request asked for `include=links` (issue #1403). */
interface ItemQueryResult {
  items: (ItemRow & { links?: ItemValueLinks; derived?: Item["derived"]; automation?: Item["automation"] })[];
  nextCursor: string | null;
  totalCount?: number;
}

/** The wire shape `POST /api/databases/:id/query` and `POST /api/views/:id/query` both return (issue #157). */
export interface ItemQueryEnvelope {
  items: ItemEnvelope[];
  nextCursor: string | null;
  /** Present only when the request set `includeCount: true`. */
  totalCount?: number;
}

/** Fills each item's `blobs` with one blob lookup for the whole page; run it inside the caller's tenant scope. */
export async function toItemQueryEnvelope(pool: Pool, result: ItemQueryResult): Promise<ItemQueryEnvelope> {
  const envelope: ItemQueryEnvelope = {
    items: await toItemEnvelopes(pool, result.items),
    nextCursor: result.nextCursor,
  };
  if (result.totalCount !== undefined) envelope.totalCount = result.totalCount;
  return envelope;
}
