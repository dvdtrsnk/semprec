import { DatabaseError, type PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow } from "../db/pool.js";
import { CardinalityViolationError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRelationRow, RelationDefinitionRow } from "../types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { visibleDatabaseIds } from "./itemsStore.js";

/** The custom SQLSTATE `enforce_relation_cardinality` (0013_relation_cardinality.sql) raises on a cardinality conflict. */
const CARDINALITY_VIOLATION_ERRCODE = "SC001";

function isCardinalityViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === CARDINALITY_VIOLATION_ERRCODE;
}

const CARDINALITIES: readonly RelationDefinitionRow["cardinality"][] = ["one_to_one", "one_to_many", "many_to_many"];

/** The raw `relation_definitions` row shape this module reads back from Postgres. */
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

/** The raw `item_relations` row shape this module reads back from Postgres. */
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

/**
 * The batched form of `getRelationDefinitionByPropertyId`: one query for a whole set of
 * relation properties, keyed by the property id each definition was looked up under. Used
 * when compiling a filter, where a database's relation properties would otherwise be
 * resolved one query at a time.
 */
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

export interface CreateItemRelationInput {
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata?: Record<string, unknown>;
}

export async function createItemRelation(client: PoolClient, input: CreateItemRelationInput): Promise<ItemRelationRow> {
  return (await createItemRelationReportingInsert(client, input)).edge;
}

/** `createItemRelation` that also reports whether this call inserted the edge (false: it existed and only its metadata was replaced). */
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

/** Insert the normalized tuple only when absent; never replace a concurrent edge's metadata. */
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

/** Full-replacement metadata update for an existing edge; returns `null` if the normalized tuple has no row (never merges JSON). */
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

/** Read-only counterpart to `deleteItemRelation`'s tuple lookup — used where the caller needs the edge's own `id` (and full row) without removing it, e.g. a destructive-approval snapshot (issue #89). */
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

/** Every edge for `itemId` on this relation, from either side (relations are stored once, undirected in storage). */
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
 * The batched form of `listRelationsForItem`: one query for every edge any of `itemIds` sits
 * on for a single relation definition, instead of one query per item. Added for issue #271's
 * explicit in-scope requirement — its Task lists "a bulk relations read alongside the
 * existing [relationsStore] helpers" as one of the two reads `deleteInboxTypeWithClient`
 * needs to stop issuing one `listRelationsForItem` call per referencing Inbox item — not a
 * speculative general-purpose addition. A returned edge's `itemA`/`itemB` may each be either
 * one of `itemIds` or its counterpart on the other side — a caller grouping by which of
 * `itemIds` an edge belongs to must check both sides itself, the same as `otherSide`
 * requires for the single-item form.
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

/**
 * Every edge `itemId` sits on, across a set of relation definitions, from either side — one query
 * however many definitions are listed (issue #1404). The caller keeps the edges its own side reads.
 */
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

/**
 * The items among `itemIds` that a relation may still point at (issue #1404): not in the trash and
 * in a database that is not archived, each with its database id. An id absent from the result is
 * trashed, in an archived database, missing, or another tenant's (row-level security hides it).
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

/** Every edge `itemId` participates in, across all relation definitions — used for the soft-delete/restore rollup trigger. */
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
