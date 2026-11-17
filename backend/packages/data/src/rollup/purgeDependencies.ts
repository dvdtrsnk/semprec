import type { PoolClient } from "pg";

// Kept out of `dependencies.ts`, which the package index re-exports whole; only the archived-database purge uses this.

/** Rollups of `databaseId` itself are excluded; they go with the database. */
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
