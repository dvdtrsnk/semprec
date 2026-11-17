import type { ViewItemRow } from "@semprec/data";

export interface ViewItemEnvelope {
  viewId: string;
  itemId: string;
  position: number;
}

export function toViewItemEnvelope(viewItem: ViewItemRow): ViewItemEnvelope {
  return { viewId: viewItem.viewId, itemId: viewItem.itemId, position: viewItem.position };
}
