/**
 * Row/result shapes the generic-operation port returns. `packages/shared` must not import `packages/data`, so these
 * mirror `packages/data/src/types.ts` and must be kept in sync by hand (enforced by the dependency-cruiser rule
 * `no-shared-data-import`; see docs/architecture/edges-io-and-errors.md#application-port).
 */
import type { FilterNode } from "./filterSort.js";

/** Must stay identical to `packages/data`'s `PROPERTY_TYPES`. */
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
  /** True while the user hides the database from the client overview. */
  overviewHidden: boolean;
  /** True for a system database an agent must not read or write by default; set by the system only. */
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

/** Mirrors `packages/data`'s `ValueLinkSource`: where an inherited value was taken from. */
export type ItemLinkSource =
  | { kind: "item"; itemId: string; databaseKey: string | null; title: string; propertyKey: string }
  | { kind: "senderDomain"; domain: string; propertyKey: string };

/** Mirrors `packages/data`'s `ValueLinkEntry`. */
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
/**
 * A relation target in a database the reading agent's project may not read: its id only. People read every target in
 * full.
 */
export interface HiddenRelationTarget {
  id: string;
  hidden: true;
}
/** One target of an expanded relation property. */
export type ItemRelationTarget = ExpandedRelationTarget | HiddenRelationTarget;

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
  /** Set by the database; no item write changes it. */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The optimistic-concurrency token a patch passes back as `ifVersion`; a decimal integer string. */
  version: string;
  /** Present on item reads and queries: true exactly when the item was created from an Inbox proposal. */
  fromInbox?: boolean;
  relations?: Record<string, ItemRelationTarget[]>;
  relationsTruncated?: string[];
  /** Present only when the read asked for `include: ["links"]`; keyed by property key, empty when the item has no link. */
  links?: Record<string, ItemLink>;
}

export interface RelationEdge {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

/**
 * One live edge seen from one end: `relationPropertyId`/`propertyKey` name the listed item's own property. A paired
 * definition reports the other end under that end's own property.
 */
export interface VisibleRelationListEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  targetDatabaseId: string;
  metadata: Record<string, unknown>;
}

/** An edge into a database the reading agent's project may not read: no target database and no edge metadata. */
export interface HiddenRelationListEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  hidden: true;
}

export type RelationListEntry = VisibleRelationListEntry | HiddenRelationListEntry;

/**
 * `via` says whether the records connect to the record itself (`direct`) or through a project of it (`project`).
 * `filter` selects exactly those records in a query of the database; it is `null` for the Threads database, which a
 * client opens by the record's id. `databaseKey` is `null` for a user-created database.
 */
export interface RelatedCollection {
  databaseKey: string | null;
  databaseId: string;
  count: number;
  via: "direct" | "project";
  filter: FilterNode | null;
}

/** The restored instant (ISO 8601) and the page's block ids in document order after the restore. */
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

/** `key` is a relation target id or a select option key; `null` groups the items with neither. */
export interface ItemCountGroup {
  key: string | null;
  count: number;
}

/** `groups` is present exactly when the entry named a `groupBy`. */
export interface ItemCountEntry {
  databaseId: string;
  count: number;
  groups?: ItemCountGroup[];
}

/**
 * One facet choice: an option key, a text, a related item id, a checkbox boolean, a relative-date preset name or a
 * number preset threshold; `null` means no value. `count` is under the caller's filter without its conditions on this
 * facet.
 */
export interface DatabaseFacetValue {
  value: string | number | boolean | null;
  label?: string;
  color?: string;
  count: number;
}

/**
 * `all` counts items under the caller's filter without its conditions on this facet; `open`, present only with
 * `extra.open`, counts those that also match that filter.
 */
export type DatabaseFacet = ({ property: string } | { path: [string, string] }) & {
  all: number;
  open?: number;
  values: DatabaseFacetValue[];
};
