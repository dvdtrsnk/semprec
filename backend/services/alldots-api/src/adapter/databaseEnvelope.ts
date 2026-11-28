import type { CollectionMetadata, DatabaseRow } from "@alldots/data";

/**
 * `name` is replaced by its localized-metadata resolution, so a system database's `name IS NULL`
 * override slot never reaches a REST caller as `null`.
 */
export interface DatabaseEnvelope {
  id: string;
  name: string;
  searchPlaceholder: string | null;
  key: string | null;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  archivedAt: string | null;
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
  /** The two orders stay as declared. */
  overviewHidden: boolean;
  /** A system database whose data an agent must not read or write by default. */
  sensitive: boolean;
  /**
   * The view type the module manifest declares for the default view, such as `gallery` for
   * `recipes`; `null` when none is declared and for a user-created database. It is the declaration,
   * not a read of the stored views.
   */
  defaultViewType: string | null;
}

/** The wire envelope does not carry the purge deadline. */
export function toDatabaseEnvelope(
  database: Omit<DatabaseRow, "purgeAt">,
  resolvedName: string,
  searchPlaceholder: string | null,
  metadata: CollectionMetadata,
  defaultViewType: string | null,
): DatabaseEnvelope {
  return {
    id: database.id,
    name: resolvedName,
    searchPlaceholder,
    key: database.key,
    parentItemId: database.parentItemId,
    ownerProjectItemId: database.ownerProjectItemId,
    ownerModuleId: database.ownerModuleId,
    schemaLocked: database.schemaLocked,
    system: database.system,
    archivedAt: database.archivedAt,
    icon: metadata.icon,
    color: metadata.color,
    overviewOrder: metadata.overviewOrder,
    switcherOrder: metadata.switcherOrder,
    clientVisible: metadata.clientVisible,
    overviewHidden: metadata.overviewHidden,
    sensitive: database.sensitive,
    defaultViewType,
  };
}
