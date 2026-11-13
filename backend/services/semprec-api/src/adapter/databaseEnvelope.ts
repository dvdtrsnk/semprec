import type { CollectionMetadata, DatabaseRow } from "@semprec/data";

/**
 * The wire shape every database read/write returns (issue #240) — the raw row, with `name`
 * replaced by its localized-metadata resolution (issue #35's `resolveDatabaseName`) so a system
 * database's `name IS NULL` override slot never leaks a literal `null` to a REST caller.
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
  /** True while the user hides the database from the overview (issue #2002); the two orders stay as declared. */
  overviewHidden: boolean;
  /** True for a system database whose data an agent must not read or write by default (issue #1808). */
  sensitive: boolean;
  /**
   * The view type the database's module manifest declares for its default view (issue #1707), such as
   * `gallery` for `recipes`. `null` when the manifest declares none and for a user-created database. It is
   * the declaration, not a read of the stored views.
   */
  defaultViewType: string | null;
}

/**
 * `database` is a `DatabaseRow` without its purge deadline (`purgeAt`, issue gh-1875), which the wire envelope does not
 * carry: the generic-operations `Database` that the database routes hold has no such field either.
 */
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
