import type { PoolClient } from "pg";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRelationRow, RelationDefinitionRow } from "../types.js";

const CARDINALITIES: readonly RelationDefinitionRow["cardinality"][] = ["one_to_one", "one_to_many", "many_to_many"];

function mapRelationDefinitionRow(row: {
  id: string;
  property_id_a: string;
  property_id_b: string | null;
  cardinality: string;
}): RelationDefinitionRow {
  if (!(CARDINALITIES as readonly string[]).includes(row.cardinality)) {
    throw new Error(`Unknown cardinality in database row: '${row.cardinality}'`);
  }
  return {
    id: row.id,
    propertyIdA: row.property_id_a,
    propertyIdB: row.property_id_b,
    cardinality: row.cardinality as RelationDefinitionRow["cardinality"],
  };
}

function mapItemRelationRow(row: {
  id: string;
  relation_definition_id: string;
  item_a: string;
  item_b: string;
  metadata: Record<string, unknown>;
}): ItemRelationRow {
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
  const { rows } = await client.query(
    `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
     VALUES ($1, $2, $3)
     RETURNING id, property_id_a, property_id_b, cardinality`,
    [input.propertyIdA, input.propertyIdB ?? null, input.cardinality ?? "many_to_many"],
  );
  return mapRelationDefinitionRow(rows[0]);
}

export async function getRelationDefinition(client: PoolClient, id: string): Promise<RelationDefinitionRow | null> {
  const { rows } = await client.query(
    `SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRelationDefinitionRow(rows[0]) : null;
}

export async function getRelationDefinitionByPropertyId(
  client: PoolClient,
  propertyId: string,
): Promise<RelationDefinitionRow | null> {
  const { rows } = await client.query(
    `SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions
     WHERE property_id_a = $1 OR property_id_b = $1`,
    [propertyId],
  );
  return rows[0] ? mapRelationDefinitionRow(rows[0]) : null;
}

export interface CreateItemRelationInput {
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata?: Record<string, unknown>;
}

export async function createItemRelation(client: PoolClient, input: CreateItemRelationInput): Promise<ItemRelationRow> {
  const definition = await getRelationDefinition(client, input.relationDefinitionId);
  if (!definition) throw new NotFoundError(`Relation definition ${input.relationDefinitionId} not found`);

  const { rows } = await client.query(
    `INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (relation_definition_id, item_a, item_b) DO UPDATE SET metadata = EXCLUDED.metadata
     RETURNING id, relation_definition_id, item_a, item_b, metadata`,
    [input.relationDefinitionId, input.itemA, input.itemB, JSON.stringify(input.metadata ?? {})],
  );
  return mapItemRelationRow(rows[0]);
}

export async function deleteItemRelation(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
): Promise<ItemRelationRow | null> {
  const { rows } = await client.query(
    `DELETE FROM item_relations WHERE relation_definition_id = $1 AND item_a = $2 AND item_b = $3
     RETURNING id, relation_definition_id, item_a, item_b, metadata`,
    [relationDefinitionId, itemA, itemB],
  );
  return rows[0] ? mapItemRelationRow(rows[0]) : null;
}

/** Every edge for `itemId` on this relation, from either side (relations are stored once, undirected in storage). */
export async function listRelationsForItem(
  client: PoolClient,
  relationDefinitionId: string,
  itemId: string,
): Promise<ItemRelationRow[]> {
  const { rows } = await client.query(
    `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations
     WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`,
    [relationDefinitionId, itemId],
  );
  return rows.map(mapItemRelationRow);
}

/** Every edge `itemId` participates in, across all relation definitions — used for the soft-delete/restore rollup trigger. */
export async function listAllRelationsForItem(client: PoolClient, itemId: string): Promise<ItemRelationRow[]> {
  const { rows } = await client.query(
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
