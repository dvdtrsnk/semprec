import { ValidationError } from "../errors.js";

/**
 * `items.computed` is shared by two writers: the rollup engine (keyed by the rollup
 * property's own key) and modules caching derived values (transcription, Inbox
 * summaries, ...) under keys they declare in their manifest's `computedKeys`. A
 * temporary stand-in for that manifest-driven registry (issue #29, same pattern as
 * `ActionRegistry`): a plain set of declared keys, empty until a module system exists
 * to populate it. The guard it enables — refusing a property key that collides with a
 * declared module cache key, and refusing a module write under an undeclared key — is
 * in scope for this issue even though the registry it reads from is not.
 * `assertNoComputedKeyCollision` below is that property-key collision guard.
 * Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md
 */
export type ComputedKeyRegistry = Set<string>;

export function createComputedKeyRegistry(): ComputedKeyRegistry {
  return new Set();
}

/** `items.computed` is a shared namespace between rollup values and declared module cache keys — see computedKeyRegistry.ts. */
export function assertNoComputedKeyCollision(registry: ComputedKeyRegistry, key: string): void {
  if (registry.has(key)) {
    throw new ValidationError(`Property key '${key}' collides with a declared module cache key`, { field: key });
  }
}
