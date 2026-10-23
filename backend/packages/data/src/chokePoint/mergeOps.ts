type Intersect<Parts extends readonly object[]> = Parts extends readonly [
  infer Head,
  ...infer Rest extends readonly object[],
]
  ? Head & Intersect<Rest>
  : unknown;

/** Intersection of every part's type; `Record<never, never>` for zero parts. */
type MergedOps<Parts extends readonly object[]> = Parts extends readonly [] ? Record<never, never> : Intersect<Parts>;

/**
 * Merges section objects into one, like `{ ...a, ...b }`, except that an own
 * enumerable key present in more than one part throws instead of letting the
 * later part silently overwrite the earlier one. Returns a new object and never
 * mutates a part.
 */
export function mergeOps<Parts extends readonly object[]>(...parts: Parts): MergedOps<Parts> {
  const seen = new Set<PropertyKey>();
  for (const part of parts) {
    for (const key of Reflect.ownKeys(part)) {
      if (!Object.prototype.propertyIsEnumerable.call(part, key)) continue;
      if (seen.has(key)) {
        throw new Error(`mergeOps: duplicate key "${String(key)}" appears in more than one part`);
      }
      seen.add(key);
    }
  }
  // Safe: the keys are pairwise disjoint (checked above), so the merged object
  // carries every part's properties unchanged, which is exactly the intersection.
  return Object.assign({}, ...parts) as MergedOps<Parts>;
}
