type Intersect<Parts extends readonly object[]> = Parts extends readonly [
  infer Head,
  ...infer Rest extends readonly object[],
]
  ? Head & Intersect<Rest>
  : unknown;

type MergedOps<Parts extends readonly object[]> = Parts extends readonly [] ? Record<never, never> : Intersect<Parts>;

/** Like `{ ...a, ...b }`, but a key present in more than one part throws instead of being overwritten. */
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
  // Safe: the keys are pairwise disjoint (checked above).
  return Object.assign({}, ...parts) as MergedOps<Parts>;
}
