export type PropertyOwner = "user" | "system";
export type MigrationStatus = "stable" | "pending" | "running" | "done" | "partial";

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
