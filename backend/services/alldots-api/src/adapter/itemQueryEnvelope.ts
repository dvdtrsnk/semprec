import type { Pool } from "pg";
import type { ItemRow, ItemValueLinks } from "@alldots/data";
import type { Item } from "@alldots/shared";
import { toItemEnvelopes, type ItemEnvelope } from "./itemEnvelope.js";

interface ItemQueryResult {
  items: (ItemRow & { links?: ItemValueLinks; derived?: Item["derived"]; automation?: Item["automation"] })[];
  nextCursor: string | null;
  totalCount?: number;
}

export interface ItemQueryEnvelope {
  items: ItemEnvelope[];
  nextCursor: string | null;
  /** Present only when the request set `includeCount: true`. */
  totalCount?: number;
}

/** One blob lookup for the whole page; run it inside the caller's tenant scope. */
export async function toItemQueryEnvelope(pool: Pool, result: ItemQueryResult): Promise<ItemQueryEnvelope> {
  const envelope: ItemQueryEnvelope = {
    items: await toItemEnvelopes(pool, result.items),
    nextCursor: result.nextCursor,
  };
  if (result.totalCount !== undefined) envelope.totalCount = result.totalCount;
  return envelope;
}
