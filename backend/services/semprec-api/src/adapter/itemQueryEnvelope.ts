import type { ItemRow, ItemValueLinks } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/** A query page whose items carry `links` only when the request asked for `include=links` (issue #1403). */
interface ItemQueryResult {
  items: (ItemRow & { links?: ItemValueLinks })[];
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

export function toItemQueryEnvelope(result: ItemQueryResult): ItemQueryEnvelope {
  const envelope: ItemQueryEnvelope = { items: result.items.map(toItemEnvelope), nextCursor: result.nextCursor };
  if (result.totalCount !== undefined) envelope.totalCount = result.totalCount;
  return envelope;
}
