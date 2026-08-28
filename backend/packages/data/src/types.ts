export type PropertyOwner = "user" | "system";
export type MigrationStatus = "stable" | "pending" | "running" | "done" | "partial";

/** Shared across `views.created_by` and (per a later issue) `doc_updates.created_by` — one vocabulary, not a per-table enum. */
export type CreatedBy = "user" | "ai_agent" | "system";

/** v1 property types. `formula` is deliberately excluded — see the issue's "Formula" section. */
export const PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "relation",
  "rollup",
  "files",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface DatabaseRow {
  id: string;
  name: string;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  archivedAt: string | null;
}

export interface PropertyRow {
  id: string;
  databaseId: string;
  key: string;
  name: string;
  type: PropertyType;
  config: Record<string, unknown>;
  locked: boolean;
  owner: PropertyOwner;
  ownerProcess: string | null;
  migrationStatus: MigrationStatus;
}

export interface RelationDefinitionRow {
  id: string;
  propertyIdA: string;
  propertyIdB: string | null;
  cardinality: "one_to_one" | "one_to_many" | "many_to_many";
}

export interface ItemRow {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ItemRelationRow {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

export interface ViewRow {
  id: string;
  /** null exactly for a curated view (config.membership = 'manual') — see the `views_curated_no_db` CHECK. */
  databaseId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  ownerModuleId: string | null;
  createdBy: CreatedBy;
}

export interface ViewItemRow {
  viewId: string;
  itemId: string;
  position: number;
}
