import { z } from "zod";
import type { PoolClient } from "pg";
import type { PropertyRow } from "../types.js";
import { getRelationDefinitionsByPropertyIds } from "../chokePoint/relationsStore.js";
import type { FilterProperties } from "./filterCompiler.js";

/**
 * Resolves filter metadata in at most two batched queries: the database's relation
 * definitions, then its targets' relation properties and definitions, one level deep.
 */
export async function buildFilterProperties(client: PoolClient, properties: PropertyRow[]): Promise<FilterProperties> {
  const relationProperties = properties.filter((property) => property.type === "relation");
  const definitions = await getRelationDefinitionsByPropertyIds(
    client,
    relationProperties.map((property) => property.id),
  );

  const targetIds = new Map<string, string>();
  for (const property of relationProperties) {
    const parsed = z.uuid().safeParse(property.config.targetDatabaseId);
    if (parsed.success) targetIds.set(property.id, parsed.data);
  }
  const targets = new Map<string, FilterProperties>();
  if (targetIds.size > 0) {
    const { rows } = await client.query<{
      database_id: string;
      key: string;
      definition_id: string | null;
      side: "a" | "b" | null;
    }>(
      `SELECT p.database_id, p.key, rd.id AS definition_id,
         CASE WHEN rd.property_id_a = p.id THEN 'a' WHEN rd.property_id_b = p.id THEN 'b' END AS side
       FROM properties p
       LEFT JOIN relation_definitions rd ON rd.property_id_a = p.id OR rd.property_id_b = p.id
       WHERE p.database_id = ANY($1::uuid[]) AND p.type = 'relation'`,
      [[...new Set(targetIds.values())]],
    );
    for (const row of rows) {
      let relations = targets.get(row.database_id);
      if (!relations) {
        relations = new Map();
        targets.set(row.database_id, relations);
      }
      relations.set(row.key, {
        type: "relation",
        relationDefinitionId: row.definition_id ?? undefined,
        relationSide: row.side ?? undefined,
      });
    }
  }

  const filterProperties: FilterProperties = new Map();
  for (const property of properties) {
    if (property.type !== "relation") {
      filterProperties.set(property.key, { type: property.type });
      continue;
    }
    const definition = definitions.get(property.id);
    filterProperties.set(property.key, {
      type: property.type,
      targetDatabaseId: targetIds.get(property.id),
      targetRelationProperties: targets.get(targetIds.get(property.id) ?? ""),
      relationDefinitionId: definition?.id,
      relationSide: definition ? (definition.propertyIdA === property.id ? "a" : "b") : undefined,
    });
  }
  return filterProperties;
}
