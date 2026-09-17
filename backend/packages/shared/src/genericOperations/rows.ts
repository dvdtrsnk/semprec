/**
 * The authoritative shared row/result shapes the generic-operation port returns (issue #252).
 * `packages/shared` must not import `packages/data` (that would make the transport-independent
 * catalog depend on a concrete implementation package), so these mirror — rather than import —
 * `packages/data/src/types.ts`'s row shapes. Keep the two in sync by hand; `Item` is pinned
 * verbatim by this issue's Task, and `RelationEdge` by issue #82.
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
export interface Item {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
}

/** Fixed by issue #82. */
export interface RelationEdge {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ItemPage = Page<Item>;
