import type { ItemRow, ItemValueLinks } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/** A query page whose items carry `links` only when the request asked for `include=links` (issue #1403). */
interface ItemQueryResult {
  items: (ItemRow & { links?: ItemValueLinks })[];
  nextCursor: string | null;
}

/** The wire shape `POST /api/databases/:id/query` and `POST /api/views/:id/query` both return (issue #157). */
export interface ItemQueryEnvelope {
  items: ItemEnvelope[];
  nextCursor: string | null;
}

export function toItemQueryEnvelope(result: ItemQueryResult): ItemQueryEnvelope {
  return { items: result.items.map(toItemEnvelope), nextCursor: result.nextCursor };
}
