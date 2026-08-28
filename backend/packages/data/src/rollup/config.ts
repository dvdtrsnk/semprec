import { ValidationError } from "../errors.js";
import type { PropertyRow, PropertyType } from "../types.js";

export const ROLLUP_AGGREGATIONS = [
  "count",
  "count_filled",
  "count_empty",
  "percent_filled",
  "percent_empty",
  "sum",
  "avg",
  "min",
  "max",
  "earliest",
  "latest",
] as const;
export type RollupAggregation = (typeof ROLLUP_AGGREGATIONS)[number];

export interface RollupConfig {
  relationPropertyKey: string;
  targetPropertyKey?: string;
  aggregation: RollupAggregation;
}

const NUMBER_ONLY: ReadonlySet<RollupAggregation> = new Set(["sum", "avg", "min", "max"]);
const DATE_ONLY: ReadonlySet<RollupAggregation> = new Set(["earliest", "latest"]);
const NO_TARGET: ReadonlySet<RollupAggregation> = new Set(["count"]);

export function parseRollupConfig(raw: Record<string, unknown>): RollupConfig {
  const { relationPropertyKey, targetPropertyKey, aggregation } = raw;
  if (typeof relationPropertyKey !== "string" || !relationPropertyKey) {
    throw new ValidationError("rollup config.relationPropertyKey must be a non-empty string", { field: "relationPropertyKey" });
  }
  if (typeof aggregation !== "string" || !ROLLUP_AGGREGATIONS.includes(aggregation as RollupAggregation)) {
    throw new ValidationError(`rollup config.aggregation must be one of ${ROLLUP_AGGREGATIONS.join(", ")}`, {
      field: "aggregation",
    });
  }
  if (targetPropertyKey !== undefined && typeof targetPropertyKey !== "string") {
    throw new ValidationError("rollup config.targetPropertyKey must be a string", { field: "targetPropertyKey" });
  }
  return {
    relationPropertyKey,
    targetPropertyKey: targetPropertyKey as string | undefined,
    aggregation: aggregation as RollupAggregation,
  };
}

function assertTargetTypeCompatible(aggregation: RollupAggregation, targetType: PropertyType): void {
  if (NUMBER_ONLY.has(aggregation) && targetType !== "number") {
    throw new ValidationError(`aggregation '${aggregation}' requires a number targetPropertyKey`, {
      field: "targetPropertyKey",
    });
  }
  if (DATE_ONLY.has(aggregation) && targetType !== "date") {
    throw new ValidationError(`aggregation '${aggregation}' requires a date targetPropertyKey`, {
      field: "targetPropertyKey",
    });
  }
}

export interface ValidatedRollupConfig {
  config: RollupConfig;
  relationProperty: PropertyRow;
  targetProperty: PropertyRow | null;
}

/**
 * Validates a rollup property's config against its own database's properties and the
 * relation's target database's properties. Does not touch `rollup_dependencies` —
 * callers persist that row themselves in the same transaction as the property write.
 */
export function validateRollupConfig(
  raw: Record<string, unknown>,
  sameDatabaseProperties: PropertyRow[],
  targetDatabaseProperties: PropertyRow[],
): ValidatedRollupConfig {
  const config = parseRollupConfig(raw);

  const relationProperty = sameDatabaseProperties.find((p) => p.key === config.relationPropertyKey);
  if (!relationProperty || relationProperty.type !== "relation") {
    throw new ValidationError(`relationPropertyKey '${config.relationPropertyKey}' must be a relation property of the same database`, {
      field: "relationPropertyKey",
    });
  }

  if (NO_TARGET.has(config.aggregation)) {
    return { config, relationProperty, targetProperty: null };
  }

  if (!config.targetPropertyKey) {
    throw new ValidationError(`aggregation '${config.aggregation}' requires targetPropertyKey`, { field: "targetPropertyKey" });
  }
  const targetProperty = targetDatabaseProperties.find((p) => p.key === config.targetPropertyKey);
  if (!targetProperty) {
    throw new ValidationError(`targetPropertyKey '${config.targetPropertyKey}' not found in the relation's target database`, {
      field: "targetPropertyKey",
    });
  }
  if (targetProperty.type === "rollup" || targetProperty.type === "relation") {
    throw new ValidationError("targetPropertyKey must not itself be a rollup or relation property (no transitive chains)", {
      field: "targetPropertyKey",
    });
  }
  assertTargetTypeCompatible(config.aggregation, targetProperty.type);

  return { config, relationProperty, targetProperty };
}

/** Used by mirror-lifecycle validation when a *different* rollup's target property is being retyped. */
export function assertAggregationCompatibleWithType(aggregation: RollupAggregation, newType: PropertyType): void {
  if (newType === "rollup" || newType === "relation") {
    throw new ValidationError("a rollup's targetPropertyKey cannot be retyped to rollup or relation", { field: "type" });
  }
  assertTargetTypeCompatible(aggregation, newType);
}
