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
  // Added by issue #24 for the ten hardcoded databases:
  "title",
  "checkbox",
  "time",
  "longText",
  "color",
  // Single blob pointer (`{ blobId }` over the shared `blobs` table) — distinct
  // from the pre-existing, still-unused `files` (plural) type above.
  "file",
  "url",
  // Added by issue #25: also `{ blobId }` over `blobs`, like `file` — kept as its own
  // type (not a reuse of `file`) so a client can tell "renders as a cover image" apart
  // from "renders as a generic attachment link" without inspecting the value shape.
  "image",
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

/** 'page' = block tree (rich content); 'canvas' = flat map of typed surface elements. */
export type DocKind = "page" | "canvas";

export interface DocRow {
  id: string;
  itemId: string;
  kind: DocKind;
  createdAt: string;
}

/**
 * A blob stored in object storage (MinIO); shared across Files, library cover images
 * (issue #25), and email attachments (issue #26). `byteSize` is `string`, not `number`:
 * the pg driver returns `bigint` columns as strings by default to avoid silent precision
 * loss past 2^53, and this column is `bigint` on purpose (uploads run into gigabytes).
 */
export interface BlobRow {
  id: string;
  mimeType: string;
  byteSize: string;
  storageKey: string;
  sourceUrl: string | null;
  contentHash: string | null;
  createdAt: string;
}
