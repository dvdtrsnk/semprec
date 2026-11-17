import { ValidationError } from "../errors.js";

/**
 * `items.computed` is shared by the rollup engine (keyed by the rollup property's key) and modules
 * caching derived values under keys they declare in their manifest's `computedKeys`. A property key
 * must not collide with a declared module cache key, and a module may not write an undeclared key.
 */
export type ComputedKeyRegistry = Set<string>;

export function createComputedKeyRegistry(): ComputedKeyRegistry {
  return new Set();
}

export function assertNoComputedKeyCollision(registry: ComputedKeyRegistry, key: string): void {
  if (registry.has(key)) {
    throw new ValidationError(`Property key '${key}' collides with a declared module cache key`, { field: key });
  }
}
