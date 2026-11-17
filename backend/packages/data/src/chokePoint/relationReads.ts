// The read of an item's live relation edges: its relation properties, the edges each reads from the
// item's own side, and whether each target may still be pointed at. Nothing here writes.
import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import type { ItemRelationRow, PropertyRow } from "../types.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import {
  assertReaderDatabaseAccess,
  listUnreadableDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { itemIdsLinkedToDatabases } from "../agentGrants/inheritedSensitivity.js";

/** One live edge seen from the listed item's own relation property. */
export interface VisibleItemRelationEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  targetDatabaseId: string;
  metadata: Record<string, unknown>;
}

/**
 * An edge into a database the reading agent's project may not read: the listed item's property and
 * the target's id, never the target's database or the edge's metadata.
 */
export interface HiddenItemRelationEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  hidden: true;
}

export type ItemRelationEntry = VisibleItemRelationEntry | HiddenItemRelationEntry;

interface ReadableSide {
  property: PropertyRow;
  definitionId: string;
  isSideA: boolean;
}

/** A total order: (property key, target id) pairs are unique. */
function byPropertyKeyThenTarget(a: ItemRelationEntry, b: ItemRelationEntry): number {
  if (a.propertyKey !== b.propertyKey) return a.propertyKey < b.propertyKey ? -1 : 1;
  return a.targetItemId < b.targetItemId ? -1 : 1;
}

/**
 * The live edges of `itemId` from its own side, ordered by property key, then target id.
 *
 * `relationPropertyId`, when given, must be one of the item's own relation properties, else
 * `validation_failed` on that field. Edges to trashed targets or archived databases are omitted.
 *
 * `null` when the item does not exist, is trashed, or belongs to another tenant, indistinguishably. A
 * `reader` needs `read` on the item's database (else `forbidden`) and sees edges into databases it
 * may not read as `HiddenItemRelationEntry`.
 *
 * A fixed number of queries whatever the number of relation properties.
 */
export function listItemRelationsWithClient(
  client: PoolClient,
  itemId: string,
  relationPropertyId?: string,
): Promise<VisibleItemRelationEntry[] | null>;
export function listItemRelationsWithClient(
  client: PoolClient,
  itemId: string,
  relationPropertyId: string | undefined,
  reader: DatabaseReader | undefined,
): Promise<ItemRelationEntry[] | null>;
export async function listItemRelationsWithClient(
  client: PoolClient,
  itemId: string,
  relationPropertyId?: string,
  reader?: DatabaseReader,
): Promise<ItemRelationEntry[] | null> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) return null;
  if (reader !== undefined) {
    await assertReaderDatabaseAccess(client, reader, item.databaseId, "read", undefined, item.id);
  }

  const relationProperties = (await propertiesStore.listPropertiesByDatabase(client, item.databaseId)).filter(
    (property) => property.type === "relation",
  );
  // Stored uuids are lower-case; match a uuid input whatever its case, as the database does.
  const wantedId = relationPropertyId?.toLowerCase();
  const properties =
    wantedId === undefined ? relationProperties : relationProperties.filter((property) => property.id === wantedId);
  if (wantedId !== undefined && properties.length === 0) {
    throw new ValidationError(`Relation property ${wantedId} is not a relation property of this item's database`, {
      field: "relationPropertyId",
    });
  }

  const definitions = await relationsStore.getRelationDefinitionsByPropertyIds(
    client,
    properties.map((property) => property.id),
  );
  // An edge is only ever stored against a definition.
  const sides: ReadableSide[] = properties.flatMap((property) => {
    const definition = definitions.get(property.id);
    if (!definition) return [];
    return [{ property, definitionId: definition.id, isSideA: definition.propertyIdA === property.id }];
  });
  if (sides.length === 0) return [];

  const edges = await relationsStore.listRelationEdgesForItemOnDefinitions(
    client,
    [...new Set(sides.map((side) => side.definitionId))],
    itemId,
  );
  const edgesByDefinition = new Map<string, ItemRelationRow[]>();
  for (const edge of edges) {
    const bucket = edgesByDefinition.get(edge.relationDefinitionId);
    if (bucket) bucket.push(edge);
    else edgesByDefinition.set(edge.relationDefinitionId, [edge]);
  }

  // Side A is `item_a`, side B `item_b`; the item's own end decides its column and the other is the
  // target. A one-directional definition has side A only.
  const candidates: Array<{ side: ReadableSide; edge: ItemRelationRow; targetItemId: string }> = [];
  for (const side of sides) {
    for (const edge of edgesByDefinition.get(side.definitionId) ?? []) {
      const ownEnd = side.isSideA ? edge.itemA : edge.itemB;
      if (ownEnd !== itemId.toLowerCase()) continue;
      candidates.push({ side, edge, targetItemId: side.isSideA ? edge.itemB : edge.itemA });
    }
  }

  const liveTargets = new Map(
    (await relationsStore.listLiveRelationTargets(client, [...new Set(candidates.map((c) => c.targetItemId))])).map(
      (target) => [target.id, target.databaseId] as const,
    ),
  );
  const unreadable = reader !== undefined ? await listUnreadableDatabaseIds(client, reader) : undefined;
  // A target inheriting sensitivity from a database the agent may not read is hidden as if in it.
  const hiddenInherited =
    typeof reader === "string" && unreadable !== undefined
      ? await itemIdsLinkedToDatabases(client, [...liveTargets.keys()], unreadable)
      : new Set<string>();
  const entries: ItemRelationEntry[] = [];
  for (const { side, edge, targetItemId } of candidates) {
    const targetDatabaseId = liveTargets.get(targetItemId);
    if (targetDatabaseId === undefined) continue;
    if (unreadable?.has(targetDatabaseId) || hiddenInherited.has(targetItemId)) {
      entries.push({
        relationPropertyId: side.property.id,
        propertyKey: side.property.key,
        targetItemId,
        hidden: true,
      });
      continue;
    }
    entries.push({
      relationPropertyId: side.property.id,
      propertyKey: side.property.key,
      targetItemId,
      targetDatabaseId,
      metadata: edge.metadata,
    });
  }
  return entries.sort(byPropertyKeyThenTarget);
}
