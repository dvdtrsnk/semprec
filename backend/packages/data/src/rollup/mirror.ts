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
 * A DELETE on a property a rollup aggregates (its `targetPropertyKey`) must be rejected, not leave
 * the dependency pointing at a key no property has — as with a relation, the user's path is to
 * delete the rollup first, then the source property.
 */
export async function assertSourceDeletable(
  client: PoolClient,
  sourceDatabaseId: string,
  sourcePropertyKey: string,
): Promise<void> {
  const dependents = await findDependenciesBySource(client, sourceDatabaseId, sourcePropertyKey);
  if (dependents.length > 0) {
    throw new ValidationError("Cannot delete a property that dependent rollups still aggregate", {
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
