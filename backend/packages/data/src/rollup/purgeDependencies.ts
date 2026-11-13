import type { PoolClient } from "pg";

// Kept out of `dependencies.ts` because that module is re-exported whole from the package index, and this query
// serves the purge of archived databases (issue gh-1875) only.

/**
 * The rollup properties of other databases that stop making sense when `databaseId` is deleted: those that run over a
 * relation property of `databaseId` (`relation_definition_id`) and those that aggregate its items
 * (`source_database_id`). A rollup property of `databaseId` itself is not listed; it goes with the database.
 */
export async function findRollupPropertiesOfOtherDatabasesDependingOn(
  client: PoolClient,
  databaseId: string,
): Promise<{ propertyId: string; databaseId: string; key: string }[]> {
  const { rows } = await client.query<{ property_id: string; database_id: string; key: string }>(
    `SELECT DISTINCT p.id AS property_id, p.database_id, p.key
       FROM rollup_dependencies dependency
       JOIN properties p ON p.id = dependency.rollup_property_id
      WHERE p.database_id <> $1
        AND (dependency.source_database_id = $1
             OR dependency.relation_definition_id IN (
               SELECT definition.id
                 FROM relation_definitions definition
                 JOIN properties side ON side.id IN (definition.property_id_a, definition.property_id_b)
                WHERE side.database_id = $1))`,
    [databaseId],
  );
  return rows.map((row) => ({ propertyId: row.property_id, databaseId: row.database_id, key: row.key }));
}
