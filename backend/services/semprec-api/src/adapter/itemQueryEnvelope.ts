import type { QueryViewResult } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/** The wire shape `POST /api/databases/:id/query` and `POST /api/views/:id/query` both return (issue #157). */
export interface ItemQueryEnvelope {
  items: ItemEnvelope[];
  nextCursor: string | null;
  /** Present only when the request set `includeCount: true`. */
  totalCount?: number;
}

export function toItemQueryEnvelope(result: QueryViewResult): ItemQueryEnvelope {
  const envelope: ItemQueryEnvelope = { items: result.items.map(toItemEnvelope), nextCursor: result.nextCursor };
  if (result.totalCount !== undefined) envelope.totalCount = result.totalCount;
  return envelope;
}
