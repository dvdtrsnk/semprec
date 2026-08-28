import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import type { PropertyType } from "../types.js";
import { getProperty } from "../chokePoint/propertiesStore.js";
import { findDependenciesByRelationDefinition, findDependenciesBySource } from "./dependencies.js";
import { assertAggregationCompatibleWithType, parseRollupConfig } from "./config.js";

/**
 * A DELETE on a relation property must be rejected, not silently invalidate dependent
 * rollups — the user's path is two explicit steps: delete the rollup, then the relation.
 */
export async function assertRelationDeletable(client: PoolClient, relationDefinitionId: string): Promise<void> {
  const dependents = await findDependenciesByRelationDefinition(client, relationDefinitionId);
  if (dependents.length > 0) {
    throw new ValidationError("Cannot delete a relation property that dependent rollups still reference", {
      dependentRollups: dependents.map((d) => d.rollupPropertyId),
    });
  }
}

/**
 * A PATCH changing a source property's type must be rejected if it would leave a
 * dependent rollup's aggregation incompatible with the new type.
 */
export async function assertSourceRetypeAllowed(
  client: PoolClient,
  sourceDatabaseId: string,
  sourcePropertyKey: string,
  newType: PropertyType,
): Promise<void> {
  const dependents = await findDependenciesBySource(client, sourceDatabaseId, sourcePropertyKey);
  if (dependents.length === 0) return;

  const incompatible: string[] = [];
  for (const dependency of dependents) {
    const rollupProperty = await getProperty(client, dependency.rollupPropertyId);
    if (!rollupProperty) continue;
    const config = parseRollupConfig(rollupProperty.config);
    try {
      assertAggregationCompatibleWithType(config.aggregation, newType);
    } catch {
      incompatible.push(dependency.rollupPropertyId);
    }
  }
  if (incompatible.length > 0) {
    throw new ValidationError("Cannot retype a property that dependent rollups still reference incompatibly", {
      dependentRollups: incompatible,
    });
  }
}
