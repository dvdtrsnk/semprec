/**
 * The authoritative shared row/result shapes the generic-operation port returns (issue #252).
 * `packages/shared` must not import `packages/data` (that would make the transport-independent
 * catalog depend on a concrete implementation package), so these mirror — rather than import —
 * `packages/data/src/types.ts`'s row shapes. Keep the two in sync by hand; `Item` is pinned
 * verbatim by this issue's Task, and `RelationEdge` by issue #82. See
 * docs/adr/2026-09-17-shared-package-mirrors-rather-than-imports-data-row-types.md for the
 * rationale and the dependency-cruiser rule (`no-shared-data-import`) that enforces it.
 */

/** Mirrors `packages/data/src/types.ts`'s `PROPERTY_TYPES` — the single source of truth for the actual enum lives there; this list must be kept identical. */
export const PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "relation",
  "rollup",
  "files",
  "title",
  "checkbox",
  "time",
  "longText",
  "color",
  "file",
  "url",
  "image",
  "json",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type PropertyOwner = "user" | "system";
export type MigrationStatus = "stable" | "pending" | "running" | "done" | "partial";
export type CreatedBy = "user" | "ai_agent" | "system";

export interface Database {
  id: string;
  key: string | null;
  name: string | null;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  /** Stored pick of a user-created database; null when none was made or for a system database. */
  icon: string | null;
  color: string | null;
  /** True while the user hides the database from the client overview (issue #2002). */
  overviewHidden: boolean;
  /** True for a system database whose data an agent must not read or write by default; set by the system only (issue #1808). */
  sensitive: boolean;
  archivedAt: string | null;
}

export interface Property {
  id: string;
  databaseId: string;
  key: string;
  name: string | null;
  type: PropertyType;
  config: Record<string, unknown>;
  locked: boolean;
  owner: PropertyOwner;
  ownerProcess: string | null;
  migrationStatus: MigrationStatus;
}

export interface View {
  id: string;
  databaseId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  ownerModuleId: string | null;
  createdBy: CreatedBy;
  creatorProjectItemId: string | null;
}

export interface ViewItem {
  viewId: string;
  itemId: string;
  position: number;
}

/** Fixed exactly by this issue's Task. */
/** Mirrors `packages/data`'s `ValueLinkSource`: where an inherited value was taken from (issue #1403). */
export type ItemLinkSource =
  | { kind: "item"; itemId: string; databaseKey: string | null; title: string; propertyKey: string }
  | { kind: "senderDomain"; domain: string; propertyKey: string };

/** Mirrors `packages/data`'s `ValueLinkEntry`: one property's link on an item (issue #1403). */
export interface ItemLink {
  valueKind: "inherited" | "inheritedBroken" | "derived";
  sources: ItemLinkSource[];
  brokenBy: "user" | "agent" | null;
  brokenAt: string | null;
}

export interface ReducedRelationTarget {
  id: string;
  databaseKey: string | null;
  title: string;
  color?: string;
  icon?: string;
}
export interface ExpandedRelationTarget extends ReducedRelationTarget {
  databaseId: string;
  metadata: Record<string, unknown>;
  properties?: Record<string, unknown>;
  blobs?: Record<string, { blobId: string; byteSize: number; mimeType: string; filename: string | null }>;
}

export interface Item {
  automation?: {
    status: "pending" | "found" | "notFound" | "error" | "locked";
    attempts: number;
    lastAttemptAt: string | null;
    errorCode:
      | "budgetExceeded"
      | "mediaUnreadable"
      | "providerFailed"
      | "unknown"
      | "deleted"
      | "sourceUnavailable"
      | "rateLimited"
      | "invalidResponse"
      | null;
    source: "openLibrary" | "googleBooks" | "tmdb" | null;
    nextAttemptAt: string | null;
  };
  derived?: {
    area?: {
      values: Array<{ id: string; title: string; color?: string | null; icon?: string | null }>;
      via: "project";
      projectIds: string[];
    };
    company?: { values: Array<{ id: string; title: string }>; via: "project"; projectIds: string[] };
  };
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  /**
   * When the item was created (ISO 8601), set by the database; no item write changes it. An item that
   * predates the field carries its last update time at the issue #1594 backfill instead.
   */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Present on item reads and queries: true exactly when the item was created from an Inbox proposal. */
  fromInbox?: boolean;
  relations?: Record<string, ExpandedRelationTarget[]>;
  relationsTruncated?: string[];
  /** Present only when the read asked for `include: ["links"]`; keyed by property key, empty when the item has no link. */
  links?: Record<string, ItemLink>;
}

/** Fixed by issue #82. */
export interface RelationEdge {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

/**
 * One live edge seen from one end (issue #1404): `relationPropertyId` and `propertyKey` name the
 * listed item's own property, `targetItemId` the item on the other side, and `targetDatabaseId`
 * that item's database. A paired definition reports the other end under that end's own property.
 */
export interface RelationListEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  targetDatabaseId: string;
  metadata: Record<string, unknown>;
}

/**
 * The page after `page.restoreVersion` (issue #1617): the restored instant as ISO 8601 and the ids
 * of the page's blocks in document order once the restore is applied.
 */
export interface PageRestoreOutput {
  itemId: string;
  at: string;
  blockIds: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** `totalCount` is present only when the query asked for it with `includeCount: true`; it ignores paging and sort. */
export interface ItemPage extends Page<Item> {
  totalCount?: number;
}

/**
 * One group of an `item.count` entry (issue #1709). `key` is the id of a relation target or the stored
 * option key of a select property; `null` is the group of the items that have neither.
 */
export interface ItemCountGroup {
  key: string | null;
  count: number;
}

/**
 * The answer to one `item.count` entry: `count` is the number of items the entry matches and `groups`
 * their split by the entry's `groupBy`, present exactly when the entry named one. `databaseId` repeats
 * the entry's own value.
 */
export interface ItemCountEntry {
  databaseId: string;
  count: number;
  groups?: ItemCountGroup[];
}

/**
 * One choice of a facet of `database.facets` (issue #1759). `value` is a stored option key, a stored text, the id
 * of a related item, `true` or `false` of a checkbox, the name of a relative-date preset or the threshold of a
 * number preset; `null` is the choice of the items without a value. `label` and `color` are present when the
 * stored option, the stored preset or the related item supplies them. `count` is the number of items that hold
 * the choice under the caller's filter without its conditions on the facet itself.
 */
export interface DatabaseFacetValue {
  value: string | number | boolean | null;
  label?: string;
  color?: string;
  count: number;
}

/**
 * The answer to one requested facet of `database.facets`. `property` or `path` repeats the request. `all` is the
 * number of items under the caller's filter without its conditions on the facet itself, and `open`, present
 * exactly when the call carried `extra.open`, the number of those items that also match that filter.
 */
export type DatabaseFacet = ({ property: string } | { path: [string, string] }) & {
  all: number;
  open?: number;
  values: DatabaseFacetValue[];
};
