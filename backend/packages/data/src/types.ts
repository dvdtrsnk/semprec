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
  // Added by issue #101: an arbitrary JSON object/array value (Processing proposals'
  // `proposal`/`history`) — distinct from `text`/`longText` so a client can tell
  // "structured data" apart from "renders as a string" without inspecting the value shape.
  "json",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface DatabaseRow {
  id: string;
  /** Stable unique English camelCase identifier (issue #235) — set only for system databases; null for user-created ones. */
  key: string | null;
  /**
   * Nullable for a system database (issue #235): a null value is an override slot for the
   * translation catalog #146 ships, not a "no name" state — until #147 wires the resolver, a
   * serializer needing a display string falls back to `key`. `system: false` databases are
   * still required to carry a name by application validation (databasesStore.createDatabase),
   * not by a DB constraint.
   */
  name: string | null;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  archivedAt: string | null;
}

/**
 * One `select`/`multi_select` catalog entry (issue #145). `key` is the stable English
 * camelCase token item property values and typed filters store/compare against — never
 * rewritten by this shape change. `label` is present only for an option a user added or
 * renamed at runtime (not part of the shipped catalog): an explicit override, the same
 * role `DatabaseRow.name`/`PropertyRow.name` play one level up (issue #235). A shipped
 * catalog option carries no `label` at all; until #147 wires the translation-catalog
 * resolver, a serializer needing a display string for it falls back to the raw `key`.
 */
export interface SelectOption {
  key: string;
  label?: string;
}

export interface PropertyRow {
  id: string;
  databaseId: string;
  key: string;
  /** Nullable for a built-in property of a system database (issue #235) — see `DatabaseRow.name`. */
  name: string | null;
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
  /**
   * The owning Projects item id of the concrete agent that created this view (issue #87) —
   * null for every 'user'/'system' view and for an 'ai_agent' view created before this column
   * existed (a "legacy" AI view, unwritable by any agent but still user-adoptable).
   */
  creatorProjectItemId: string | null;
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
