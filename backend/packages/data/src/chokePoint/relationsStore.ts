import { DatabaseError, type PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow } from "../db/pool.js";
import { CardinalityViolationError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRelationRow, RelationDefinitionRow } from "../types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { visibleDatabaseIds } from "./itemsStore.js";

/** The custom SQLSTATE the `enforce_relation_cardinality` trigger raises on a cardinality conflict. */
const CARDINALITY_VIOLATION_ERRCODE = "SC001";

function isCardinalityViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === CARDINALITY_VIOLATION_ERRCODE;
}

const CARDINALITIES: readonly RelationDefinitionRow["cardinality"][] = ["one_to_one", "one_to_many", "many_to_many"];

type RelationDefinitionDbRow = {
  id: string;
  property_id_a: string;
  property_id_b: string | null;
  cardinality: string;
};

function mapRelationDefinitionRow(row: RelationDefinitionDbRow): RelationDefinitionRow {
  return {
    id: row.id,
    propertyIdA: row.property_id_a,
    propertyIdB: row.property_id_b,
    cardinality: assertKnownValue(CARDINALITIES, row.cardinality, "cardinality"),
  };
}

type ItemRelationDbRow = {
  id: string;
  relation_definition_id: string;
  item_a: string;
  item_b: string;
  metadata: Record<string, unknown>;
};

function mapItemRelationRow(row: ItemRelationDbRow): ItemRelationRow {
  return {
    id: row.id,
    relationDefinitionId: row.relation_definition_id,
    itemA: row.item_a,
    itemB: row.item_b,
    metadata: row.metadata,
  };
}

export interface CreateRelationDefinitionInput {
  propertyIdA: string;
  propertyIdB?: string;
  cardinality?: RelationDefinitionRow["cardinality"];
}

export async function createRelationDefinition(
  client: PoolClient,
  input: CreateRelationDefinitionInput,
): Promise<RelationDefinitionRow> {
  const { rows } = await client.query<RelationDefinitionDbRow>(
    `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
     VALUES ($1, $2, $3)
     RETURNING id, property_id_a, property_id_b, cardinality`,
    [input.propertyIdA, input.propertyIdB ?? null, input.cardinality ?? "many_to_many"],
  );
  return mapRelationDefinitionRow(requireSingleRow(rows, "relation row"));
}

export async function getRelationDefinition(client: PoolClient, id: string): Promise<RelationDefinitionRow | null> {
  const { rows } = await client.query<RelationDefinitionDbRow>(
    `SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRelationDefinitionRow(rows[0]) : null;
}

/** Batched `getRelationDefinitionByPropertyId`, keyed by property id, for filter compilation. */
export async function getRelationDefinitionsByPropertyIds(
  client: PoolClient,
  propertyIds: string[],
): Promise<Map<string, RelationDefinitionRow>> {
  if (propertyIds.length === 0) return new Map();
  const { rows } = await client.query<RelationDefinitionDbRow>(
    `SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions
     WHERE property_id_a = ANY($1::uuid[]) OR property_id_b = ANY($1::uuid[])`,
    [propertyIds],
  );

  const byPropertyId = new Map<string, RelationDefinitionRow>();
  const requested = new Set(propertyIds);
  for (const row of rows) {
    const definition = mapRelationDefinitionRow(row);
    if (requested.has(definition.propertyIdA)) byPropertyId.set(definition.propertyIdA, definition);
    if (definition.propertyIdB && requested.has(definition.propertyIdB))
      byPropertyId.set(definition.propertyIdB, definition);
  }
  return byPropertyId;
}

export async function getRelationDefinitionByPropertyId(
  client: PoolClient,
  propertyId: string,
): Promise<RelationDefinitionRow | null> {
  const { rows } = await client.query<RelationDefinitionDbRow>(
    `SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions
     WHERE property_id_a = $1 OR property_id_b = $1`,
    [propertyId],
  );
  return rows[0] ? mapRelationDefinitionRow(rows[0]) : null;
}

/** A relation with both sides in `databaseId` has none; both its properties go with the database. */
export async function listPairedPropertiesOfOtherDatabases(
  client: PoolClient,
  databaseId: string,
): Promise<{ propertyId: string; databaseId: string; key: string }[]> {
  const { rows } = await client.query<{ property_id: string; database_id: string; key: string }>(
    `SELECT DISTINCT other.id AS property_id, other.database_id, other.key
       FROM relation_definitions definition
       JOIN properties mine ON mine.id IN (definition.property_id_a, definition.property_id_b)
       JOIN properties other
         ON other.id = CASE WHEN mine.id = definition.property_id_a THEN definition.property_id_b ELSE definition.property_id_a END
      WHERE mine.database_id = $1 AND other.database_id <> $1`,
    [databaseId],
  );
  return rows.map((row) => ({ propertyId: row.property_id, databaseId: row.database_id, key: row.key }));
}

/**
 * Relation properties of other databases that point at `databaseId` (`config.targetDatabaseId`):
 * every relation property outside it that would point at a deleted database, one-directional
 * relations (which `listPairedPropertiesOfOtherDatabases` never meets) included.
 */
export async function listRelationPropertiesTargetingDatabase(
  client: PoolClient,
  databaseId: string,
): Promise<{ propertyId: string; databaseId: string; key: string }[]> {
  const { rows } = await client.query<{ property_id: string; database_id: string; key: string }>(
    `SELECT id AS property_id, database_id, key
       FROM properties
      WHERE type = 'relation' AND database_id <> $1 AND config->>'targetDatabaseId' = $1::text`,
    [databaseId],
  );
  return rows.map((row) => ({ propertyId: row.property_id, databaseId: row.database_id, key: row.key }));
}

export interface CreateItemRelationInput {
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata?: Record<string, unknown>;
}

export async function createItemRelation(client: PoolClient, input: CreateItemRelationInput): Promise<ItemRelationRow> {
  return (await createItemRelationReportingInsert(client, input)).edge;
}

/** Also reports whether this call inserted the edge (false: it existed and only its metadata was replaced). */
export async function createItemRelationReportingInsert(
  client: PoolClient,
  input: CreateItemRelationInput,
): Promise<{ edge: ItemRelationRow; inserted: boolean }> {
  const definition = await getRelationDefinition(client, input.relationDefinitionId);
  if (!definition) throw new NotFoundError(`Relation definition ${input.relationDefinitionId} not found`);

  try {
    const { rows } = await client.query<ItemRelationDbRow & { inserted: boolean }>(
      `INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (relation_definition_id, item_a, item_b) DO UPDATE SET metadata = EXCLUDED.metadata
       RETURNING id, relation_definition_id, item_a, item_b, metadata, (xmax = 0) AS inserted`,
      [input.relationDefinitionId, input.itemA, input.itemB, JSON.stringify(input.metadata ?? {})],
    );
    const row = requireSingleRow(rows, "relation row");
    return { edge: mapItemRelationRow(row), inserted: row.inserted };
  } catch (err) {
    if (isCardinalityViolation(err)) {
      throw new CardinalityViolationError(
        `Relation ${input.relationDefinitionId} (${definition.cardinality}) rejected item_a=${input.itemA}/item_b=${input.itemB}: cardinality violation`,
        {
          relationDefinitionId: input.relationDefinitionId,
          cardinality: definition.cardinality,
          itemA: input.itemA,
          itemB: input.itemB,
        },
      );
    }
    throw err;
  }
}

/** Never replaces a concurrent edge's metadata. */
export async function insertItemRelationIfAbsent(
  client: PoolClient,
  input: CreateItemRelationInput,
): Promise<ItemRelationRow | null> {
  const definition = await getRelationDefinition(client, input.relationDefinitionId);
  if (!definition) throw new NotFoundError(`Relation definition ${input.relationDefinitionId} not found`);
  try {
    const { rows } = await client.query<ItemRelationDbRow>(
      `INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (relation_definition_id, item_a, item_b) DO NOTHING
       RETURNING id, relation_definition_id, item_a, item_b, metadata`,
      [input.relationDefinitionId, input.itemA, input.itemB, JSON.stringify(input.metadata ?? {})],
    );
    return rows[0] ? mapItemRelationRow(rows[0]) : null;
  } catch (err) {
    if (isCardinalityViolation(err)) {
      throw new CardinalityViolationError(
        `Relation ${input.relationDefinitionId} (${definition.cardinality}) rejected item_a=${input.itemA}/item_b=${input.itemB}: cardinality violation`,
        {
          relationDefinitionId: input.relationDefinitionId,
          cardinality: definition.cardinality,
          itemA: input.itemA,
          itemB: input.itemB,
        },
      );
    }
    throw err;
  }
}

/** Full replacement (never a JSON merge); `null` when the normalized tuple has no row. */
export async function updateItemRelationMetadata(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
  metadata: Record<string, unknown>,
): Promise<ItemRelationRow | null> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `UPDATE item_relations SET metadata = $4::jsonb
     WHERE relation_definition_id = $1 AND item_a = $2 AND item_b = $3
     RETURNING id, relation_definition_id, item_a, item_b, metadata`,
    [relationDefinitionId, itemA, itemB, JSON.stringify(metadata)],
  );
  return rows[0] ? mapItemRelationRow(rows[0]) : null;
}

/** The edge's full row by tuple without removing it, e.g. for a destructive-approval snapshot. */
export async function getItemRelationByTuple(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
): Promise<ItemRelationRow | null> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = $1 AND item_a = $2 AND item_b = $3`,
    [relationDefinitionId, itemA, itemB],
  );
  return rows[0] ? mapItemRelationRow(rows[0]) : null;
}

export async function tryLockRelationDefinition(client: PoolClient, definitionId: string): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked",
    [definitionId],
  );
  if (typeof rows[0]?.locked !== "boolean") throw new Error("Missing relation admission result");
  return rows[0].locked;
}

/** Locks the addressed source side of a relation snapshot in deterministic edge order. */
export async function lockRelationSnapshotEdgesNowait(
  client: PoolClient,
  definitionId: string,
  callerId: string,
  side: "a" | "b",
): Promise<ItemRelationRow[]> {
  // The interpolated column is chosen only from these two fixed SQL identifiers.
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = $1 AND ${side === "a" ? "item_a" : "item_b"} = $2
     ORDER BY id FOR UPDATE NOWAIT`,
    [definitionId, callerId],
  );
  const schema = z.object({
    id: z.string(),
    relation_definition_id: z.string(),
    item_a: z.string(),
    item_b: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  });
  return rows.map((row) => mapItemRelationRow(schema.parse(row)));
}

export async function lockExistingRelationNowait(
  client: PoolClient,
  definitionId: string,
  itemA: string,
  itemB: string,
): Promise<void> {
  await client.query<{ id: string }>(
    "SELECT id FROM item_relations WHERE relation_definition_id = $1 AND item_a = $2 AND item_b = $3 FOR UPDATE NOWAIT",
    [definitionId, itemA, itemB],
  );
}

export async function deleteItemRelation(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
): Promise<ItemRelationRow | null> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `DELETE FROM item_relations WHERE relation_definition_id = $1 AND item_a = $2 AND item_b = $3
     RETURNING id, relation_definition_id, item_a, item_b, metadata`,
    [relationDefinitionId, itemA, itemB],
  );
  return rows[0] ? mapItemRelationRow(rows[0]) : null;
}

/** From either side; relations are stored once, undirected. */
export async function listRelationsForItem(
  client: PoolClient,
  relationDefinitionId: string,
  itemId: string,
): Promise<ItemRelationRow[]> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`,
    [relationDefinitionId, itemId],
  );
  return rows.map(mapItemRelationRow);
}

/**
 * Batched `listRelationsForItem` for one definition. An edge's `itemA`/`itemB` may each be one of
 * `itemIds` or its counterpart, so a caller grouping by item must check both sides.
 */
export async function listRelationsForItems(
  client: PoolClient,
  relationDefinitionId: string,
  itemIds: string[],
): Promise<ItemRelationRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<ItemRelationDbRow>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = $1 AND (item_a = ANY($2::uuid[]) OR item_b = ANY($2::uuid[]))`,
    [relationDefinitionId, itemIds],
  );
  return rows.map(mapItemRelationRow);
}

/** Across a set of definitions, from either side, in one query. The caller keeps the edges its side reads. */
export async function listRelationEdgesForItemOnDefinitions(
  client: PoolClient,
  relationDefinitionIds: string[],
  itemId: string,
): Promise<ItemRelationRow[]> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = ANY($1::uuid[]) AND (item_a = $2 OR item_b = $2)`,
    [relationDefinitionIds, itemId],
  );
  return rows.map(mapItemRelationRow);
}

/** The definitions `countRelationEdgesToTargets` counts, by the stored side the targets sit on. */
export interface RelationEdgeTargetSides {
  /** The caller's property is side A. */
  targetOnSideB: readonly string[];
  /** The caller's property is side B. */
  targetOnSideA: readonly string[];
}

/** One grouped query; an id with no edge is absent from the map (read it as zero). */
export async function countRelationEdgesToTargets(
  client: PoolClient,
  sides: RelationEdgeTargetSides,
  targetItemIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (targetItemIds.length === 0 || (sides.targetOnSideA.length === 0 && sides.targetOnSideB.length === 0)) {
    return counts;
  }
  const { rows } = await client.query<{ target_id: string; edge_count: number }>(
    `SELECT target_id, count(*)::int AS edge_count FROM (
       SELECT item_b AS target_id FROM item_relations WHERE relation_definition_id = ANY($1::uuid[])
       UNION ALL
       SELECT item_a AS target_id FROM item_relations WHERE relation_definition_id = ANY($2::uuid[])
     ) edges
     WHERE target_id = ANY($3::uuid[])
     GROUP BY target_id`,
    [sides.targetOnSideB, sides.targetOnSideA, targetItemIds],
  );
  for (const row of rows) counts.set(row.target_id, row.edge_count);
  return counts;
}

/**
 * Those of `itemIds` a relation may still point at: live and in a non-archived database. An absent id
 * is trashed, archived, missing, or another tenant's.
 */
export async function listLiveRelationTargets(
  client: PoolClient,
  itemIds: string[],
): Promise<{ id: string; databaseId: string }[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await client.query<{ id: string; database_id: string }>(
    `SELECT i.id, i.database_id FROM items i
     JOIN databases d ON d.id = i.database_id
     WHERE i.id = ANY($1::uuid[]) AND i.database_id = ANY($2::uuid[])
       AND i.deleted_at IS NULL AND d.archived_at IS NULL`,
    [itemIds, await visibleDatabaseIds(client)],
  );
  return rows.map((row) => ({ id: row.id, databaseId: row.database_id }));
}

/** Across all definitions; used by the soft-delete/restore rollup trigger. */
export async function listAllRelationsForItem(client: PoolClient, itemId: string): Promise<ItemRelationRow[]> {
  const { rows } = await client.query<ItemRelationDbRow>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations WHERE item_a = $1 OR item_b = $1`,
    [itemId],
  );
  return rows.map(mapItemRelationRow);
}

export function otherSide(relation: ItemRelationRow, itemId: string): string {
  if (relation.itemA === itemId) return relation.itemB;
  if (relation.itemB === itemId) return relation.itemA;
  throw new ValidationError(`Item ${itemId} is not part of relation ${relation.id}`);
}

/** Internal primitives for the mail-thread structural handoff. */
export async function lockThreadMergeEdges(client: PoolClient, itemId: string): Promise<ItemRelationRow[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE tenant_id = app_tenant_default() AND (item_a = $1 OR item_b = $1)
     ORDER BY relation_definition_id, item_a, item_b FOR UPDATE`,
    [itemId],
  );
  return z
    .array(
      z.object({
        id: z.uuid(),
        relation_definition_id: z.uuid(),
        item_a: z.uuid(),
        item_b: z.uuid(),
        metadata: z.record(z.string(), z.unknown()),
      }),
    )
    .parse(rows)
    .map(mapItemRelationRow);
}

export async function insertThreadMergeEdgeIfAbsent(
  client: PoolClient,
  input: CreateItemRelationInput,
): Promise<ItemRelationRow | null> {
  const definition = await getRelationDefinition(client, input.relationDefinitionId);
  if (!definition) throw new NotFoundError("Relation definition not found");
  try {
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (relation_definition_id, item_a, item_b) DO NOTHING
       RETURNING id, relation_definition_id, item_a, item_b, metadata`,
      [input.relationDefinitionId, input.itemA, input.itemB, JSON.stringify(input.metadata ?? {})],
    );
    if (!rows[0]) return null;
    return mapItemRelationRow(
      z
        .object({
          id: z.uuid(),
          relation_definition_id: z.uuid(),
          item_a: z.uuid(),
          item_b: z.uuid(),
          metadata: z.record(z.string(), z.unknown()),
        })
        .parse(rows[0]),
    );
  } catch (error) {
    if (isCardinalityViolation(error))
      throw new CardinalityViolationError("Relation cardinality violation", {
        relationDefinitionId: definition.id,
        cardinality: definition.cardinality,
        itemA: input.itemA,
        itemB: input.itemB,
      });
    throw error;
  }
}
