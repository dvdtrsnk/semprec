import type { PoolClient } from "pg";

// The source database of every rollup of a set of databases, for deciding what an agent may learn through a rollup.
// Kept out of `rollup/dependencies.ts`, whose exports are the package's public surface.

export interface RollupSourceRow {
  databaseId: string;
  propertyKey: string;
  sourceDatabaseId: string;
}

type RollupSourceDbRow = { database_id: string; key: string; source_database_id: string };

/** One query; none for no database. */
export async function listRollupSourcesByDatabases(
  client: PoolClient,
  databaseIds: readonly string[],
): Promise<RollupSourceRow[]> {
  if (databaseIds.length === 0) return [];
  const { rows } = await client.query<RollupSourceDbRow>(
    `SELECT p.database_id, p.key, rd.source_database_id
     FROM rollup_dependencies rd JOIN properties p ON p.id = rd.rollup_property_id
     WHERE p.database_id = ANY($1::uuid[])`,
    [databaseIds],
  );
  return rows.map((row) => ({
    databaseId: row.database_id,
    propertyKey: row.key,
    sourceDatabaseId: row.source_database_id,
  }));
}
