import type { DatabaseRow } from "@semprec/data";

/**
 * The wire shape every database read/write returns (issue #240) — the raw row, with `name`
 * replaced by its localized-metadata resolution (issue #35's `resolveDatabaseName`) so a system
 * database's `name IS NULL` override slot never leaks a literal `null` to a REST caller.
 */
export interface DatabaseEnvelope {
  id: string;
  name: string;
  key: string | null;
  parentItemId: string | null;
  ownerProjectItemId: string | null;
  ownerModuleId: string | null;
  schemaLocked: boolean;
  system: boolean;
  archivedAt: string | null;
}

export function toDatabaseEnvelope(database: DatabaseRow, resolvedName: string): DatabaseEnvelope {
  return {
    id: database.id,
    name: resolvedName,
    key: database.key,
    parentItemId: database.parentItemId,
    ownerProjectItemId: database.ownerProjectItemId,
    ownerModuleId: database.ownerModuleId,
    schemaLocked: database.schemaLocked,
    system: database.system,
    archivedAt: database.archivedAt,
  };
}
