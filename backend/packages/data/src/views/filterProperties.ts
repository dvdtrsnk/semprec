import type { PoolClient } from "pg";
import type { PropertyRow } from "../types.js";
import { getRelationDefinitionsByPropertyIds } from "../chokePoint/relationsStore.js";
import type { FilterProperties } from "./filterCompiler.js";

/**
 * Resolves a database's properties into what the filter compiler needs. Scalar properties
 * only carry their type; a relation property is additionally paired with its relation
 * definition and the side its own database sits on, which is what lets a `relation_contains`
 * condition compile to an `item_relations` existence check (issue #96's folder filtering).
 *
 * The relation definitions are fetched in one batched query rather than one per property:
 * this runs on every filtered read, and a database like Emails carries four relation
 * properties whose definitions would otherwise be four separate round trips.
 */
export async function buildFilterProperties(client: PoolClient, properties: PropertyRow[]): Promise<FilterProperties> {
  const relationProperties = properties.filter((property) => property.type === "relation");
  const definitions = await getRelationDefinitionsByPropertyIds(
    client,
    relationProperties.map((property) => property.id),
  );

  const filterProperties: FilterProperties = new Map();
  for (const property of properties) {
    if (property.type !== "relation") {
      filterProperties.set(property.key, { type: property.type });
      continue;
    }
    const definition = definitions.get(property.id);
    filterProperties.set(property.key, {
      type: property.type,
      relationDefinitionId: definition?.id,
      relationSide: definition ? (definition.propertyIdA === property.id ? "a" : "b") : undefined,
    });
  }
  return filterProperties;
}
