import type { QueryViewResult } from "@semprec/data";
import { toItemEnvelope, type ItemEnvelope } from "./itemEnvelope.js";

/** The wire shape `POST /api/databases/:id/query` and `POST /api/views/:id/query` both return (issue #157). */
export interface ItemQueryEnvelope {
  items: ItemEnvelope[];
  nextCursor: string | null;
}

export function toItemQueryEnvelope(result: QueryViewResult): ItemQueryEnvelope {
  return { items: result.items.map(toItemEnvelope), nextCursor: result.nextCursor };
}
