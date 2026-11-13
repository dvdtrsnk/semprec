// Owns the choke point's read of an item's live relation edges (issue #1404, `relation.list`): which
// relation properties the item has, the edges each one reads from the item's own side, and whether
// each target may still be pointed at. It writes nothing and knows nothing about which transport asked.
// Constrained by: docs/adr/2026-09-17-generic-application-service-port.md
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

/** One live edge seen from one end: the listed item's own relation property and the item on the other side. */
export interface VisibleItemRelationEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  targetDatabaseId: string;
  metadata: Record<string, unknown>;
}

/**
 * An edge to an item in a database the reading agent's project may not read (issue #1810): the listed item's own
 * property and the target's id, and neither the target's database nor the edge's metadata. Only an agent read
 * produces it.
 */
export interface HiddenItemRelationEntry {
  relationPropertyId: string;
  propertyKey: string;
  targetItemId: string;
  hidden: true;
}

export type ItemRelationEntry = VisibleItemRelationEntry | HiddenItemRelationEntry;

/** One of the item's own relation properties, with the definition it reads and which side of that definition it is. */
interface ReadableSide {
  property: PropertyRow;
  definitionId: string;
  isSideA: boolean;
}

/** A total order over entries: (property key, target id) pairs are unique, so two distinct entries never compare equal. */
function byPropertyKeyThenTarget(a: ItemRelationEntry, b: ItemRelationEntry): number {
  if (a.propertyKey !== b.propertyKey) return a.propertyKey < b.propertyKey ? -1 : 1;
  return a.targetItemId < b.targetItemId ? -1 : 1;
}

/**
 * The live edges of `itemId`, read from its own side and ordered by property key, then target id.
 *
 * `relationPropertyId`, when given, must be one of the item's own relation properties; any other id
 * (a property of another database, or a non-relation one) fails with `validation_failed` on that
 * field. An edge is omitted when its target is soft-deleted or its database is archived.
 *
 * Returns `null` when the item does not exist, is in the trash, or belongs to another tenant. The
 * three answer alike, so the caller reports one not-found for all of them. An agent (a `reader` that is its project,
 * issue #1810) or an external client (issue #1998) needs `read` access to the database of the listed item, else the read is refused as `forbidden`,
 * and sees an edge to an item in a database it may not read as a `HiddenItemRelationEntry`.
 *
 * Runs a fixed number of queries whatever the number of relation properties: the item, the
 * database's properties, the definitions of the relation ones, their edges and the live targets.
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
  if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, item.databaseId, "read");

  const relationProperties = (await propertiesStore.listPropertiesByDatabase(client, item.databaseId)).filter(
    (property) => property.type === "relation",
  );
  // Stored uuids are lower-case; a uuid-typed input is matched the way the database matches it, whatever its case.
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
  // A relation property with no definition has no edges: an edge is only ever stored against one.
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

  // Side A of a definition is `item_a` and side B is `item_b`, so the item's own end decides which
  // column it sits in and the other column is the target. A one-directional definition has side A only.
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
  const entries: ItemRelationEntry[] = [];
  for (const { side, edge, targetItemId } of candidates) {
    const targetDatabaseId = liveTargets.get(targetItemId);
    if (targetDatabaseId === undefined) continue;
    if (unreadable?.has(targetDatabaseId)) {
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
