export type PropertyOwner = "user" | "system";
export type MigrationStatus = "stable" | "pending" | "running" | "done" | "partial";

/** One vocabulary shared by `views.created_by` and `doc_updates.created_by`, not a per-table enum. */
export type CreatedBy = "user" | "ai_agent" | "system";

/** `formula` is deliberately not a property type. */
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
  // Single `{ blobId }` pointer into `blobs`; distinct from the unused `files` (plural) above.
  "file",
  "url",
  // Also `{ blobId }`, but its own type so a client renders a cover image rather than an attachment link.
  "image",
  // Arbitrary JSON object/array (e.g. Processing proposals' `proposal`/`history`), distinct from string types.
  "json",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface DatabaseRow {
  id: string;
  /** Stable English camelCase identifier; set only for system databases. */
  key: string | null;
  /**
   * For a system database, null means "use the translation catalog", not "no name". User databases must have a
   * name, enforced by `createDatabase`, not by a DB constraint.
   */
  name: string | null;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  icon: string | null;
  color: string | null;
  /** The user hid the database from the client overview. */
  overviewHidden: boolean;
  /** A system database an agent must not read or write by default; set by the system only. */
  sensitive: boolean;
  archivedAt: string | null;
  /**
   * When the nightly sweep deletes an archived database for good. Null while not archived, and until the sweep
   * first sees a database archived without one.
   */
  purgeAt: string | null;
}

/**
 * `key` is the stable English camelCase token that values and filters store and compare; never rewritten. `label`
 * is only present for an option a user added or renamed (an override of the shipped catalog label).
 */
export interface SelectOption {
  key: string;
  label?: string;
}

export interface PropertyRow {
  id: string;
  databaseId: string;
  key: string;
  /** Nullable for a built-in property of a system database, as `DatabaseRow.name`. */
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
  /** `items.created_at`, set by the database; no item write changes it. */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set by reads only: true when the item was created from an Inbox proposal. Absent on write results. */
  fromInbox?: boolean;
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
  /** null exactly for a curated view (`config.membership = 'manual'`, the `views_curated_no_db` CHECK). */
  databaseId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  ownerModuleId: string | null;
  createdBy: CreatedBy;
  /**
   * The Projects item of the agent that created the view; null for 'user'/'system' views. An 'ai_agent' view without
   * it is writable by no agent but still user-adoptable.
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
  /** Time of the last recorded edit; equals `createdAt` when no edit was recorded. */
  lastEditedAt: string;
  lastEditedBy: CreatedBy | null;
}

/**
 * A blob in object storage, shared by Files, library covers and mail attachments. `byteSize` is a string because
 * pg returns `bigint` as string to avoid precision loss past 2^53.
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
