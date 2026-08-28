import type { PoolClient } from "pg";

export interface RollupDependencyRow {
  rollupPropertyId: string;
  relationDefinitionId: string;
  sourceDatabaseId: string;
  sourcePropertyKey: string | null;
}

function mapRow(row: {
  rollup_property_id: string;
  relation_definition_id: string;
  source_database_id: string;
  source_property_key: string | null;
}): RollupDependencyRow {
  return {
    rollupPropertyId: row.rollup_property_id,
    relationDefinitionId: row.relation_definition_id,
    sourceDatabaseId: row.source_database_id,
    sourcePropertyKey: row.source_property_key,
  };
}

export interface UpsertRollupDependencyInput {
  rollupPropertyId: string;
  relationDefinitionId: string;
  sourceDatabaseId: string;
  sourcePropertyKey: string | null;
}

/** Must be called in the same transaction as the write to the rollup property (create or config change). */
export async function upsertRollupDependency(client: PoolClient, input: UpsertRollupDependencyInput): Promise<void> {
  await client.query(
    `INSERT INTO rollup_dependencies (rollup_property_id, relation_definition_id, source_database_id, source_property_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rollup_property_id) DO UPDATE
       SET relation_definition_id = EXCLUDED.relation_definition_id,
           source_database_id = EXCLUDED.source_database_id,
           source_property_key = EXCLUDED.source_property_key`,
    [input.rollupPropertyId, input.relationDefinitionId, input.sourceDatabaseId, input.sourcePropertyKey],
  );
}

/** Used when deleting a relation property: which rollups elsewhere depend on this relation. */
export async function findDependenciesByRelationDefinition(
  client: PoolClient,
  relationDefinitionId: string,
): Promise<RollupDependencyRow[]> {
  const { rows } = await client.query(
    `SELECT rollup_property_id, relation_definition_id, source_database_id, source_property_key
     FROM rollup_dependencies WHERE relation_definition_id = $1`,
    [relationDefinitionId],
  );
  return rows.map(mapRow);
}

/** Used when retyping a source property: which rollups depend on it as their targetPropertyKey. */
export async function findDependenciesBySource(
  client: PoolClient,
  sourceDatabaseId: string,
  sourcePropertyKey: string,
): Promise<RollupDependencyRow[]> {
  const { rows } = await client.query(
    `SELECT rollup_property_id, relation_definition_id, source_database_id, source_property_key
     FROM rollup_dependencies WHERE source_database_id = $1 AND source_property_key = $2`,
    [sourceDatabaseId, sourcePropertyKey],
  );
  return rows.map(mapRow);
}

export async function getRollupDependency(client: PoolClient, rollupPropertyId: string): Promise<RollupDependencyRow | null> {
  const { rows } = await client.query(
    `SELECT rollup_property_id, relation_definition_id, source_database_id, source_property_key
     FROM rollup_dependencies WHERE rollup_property_id = $1`,
    [rollupPropertyId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
