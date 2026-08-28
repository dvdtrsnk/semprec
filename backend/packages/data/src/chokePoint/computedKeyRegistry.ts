/**
 * `items.computed` is shared by two writers: the rollup engine (keyed by the rollup
 * property's own key) and modules caching derived values (transcription, Inbox
 * summaries, ...) under keys they declare in their manifest's `computedKeys`. A
 * temporary stand-in for that manifest-driven registry (issue #29, same pattern as
 * `ActionRegistry`): a plain set of declared keys, empty until a module system exists
 * to populate it. The guard it enables — refusing a property key that collides with a
 * declared module cache key, and refusing a module write under an undeclared key — is
 * in scope for this issue even though the registry it reads from is not.
 */
export type ComputedKeyRegistry = Set<string>;

export function createComputedKeyRegistry(): ComputedKeyRegistry {
  return new Set();
}
