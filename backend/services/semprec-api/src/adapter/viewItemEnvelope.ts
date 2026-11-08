import type { ViewItemRow } from "@semprec/data";

/** The wire shape a curated view's membership add/reposition/remove returns (issue #155). */
export interface ViewItemEnvelope {
  viewId: string;
  itemId: string;
  position: number;
}

export function toViewItemEnvelope(viewItem: ViewItemRow): ViewItemEnvelope {
  return { viewId: viewItem.viewId, itemId: viewItem.itemId, position: viewItem.position };
}
