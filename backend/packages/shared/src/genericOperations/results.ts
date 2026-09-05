import type { DatabaseRow, ItemRelationRow, ItemRow, PropertyRow, ViewItemRow, ViewRow } from "@semprec/data";

/**
 * The authoritative row shapes the data/application layer returns, named once here so every
 * transport (REST, AgentTool, MCP) projects the same rows. They are aliases of the data
 * package's row types on purpose: a second, hand-written copy would be free to drift.
 */
export type Database = DatabaseRow;
export type Property = PropertyRow;
export type View = ViewRow;
export type ViewItem = ViewItemRow;
export type Item = ItemRow;
/** #211's normalized relation edge: `(relationPropertyId, callerItemId, targetItemId)` stored as definition/item A/item B. */
export type RelationEdge = ItemRelationRow;

/** Keyset page envelope shared by every list/query operation. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ItemPage = Page<Item>;

/** Adapter-level results of the idempotent void deletes underneath them. */
export interface PropertyDeleted {
  deleted: true;
  propertyId: string;
}

export interface ViewDeleted {
  deleted: true;
  viewId: string;
}

export interface ViewItemDeleted {
  deleted: true;
  viewId: string;
  itemId: string;
}

export interface RelationDeleted {
  deleted: true;
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
}
