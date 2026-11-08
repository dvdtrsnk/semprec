const itemPatchChangeMetadata = Symbol("itemPatchChangeMetadata");

/** Carries only write-time content eligibility; symbols do not enter JSON output. */
export function attachItemPatchChangeMetadata<T extends object>(
  result: T,
  eligibility: ReadonlyMap<string, boolean>,
): T {
  Object.defineProperty(result, itemPatchChangeMetadata, {
    value: new Map(eligibility),
    enumerable: true,
    configurable: true,
  });
  return result;
}

/** Reads the internal write-time classification, rejecting absent or malformed carriers. */
export function readItemPatchChangeMetadata(value: unknown): ReadonlyMap<string, boolean> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate: unknown = Reflect.get(value, itemPatchChangeMetadata);
  if (!(candidate instanceof Map)) return undefined;
  const result = new Map<string, boolean>();
  for (const [key, allowed] of candidate) {
    if (typeof key !== "string" || typeof allowed !== "boolean") return undefined;
    result.set(key, allowed);
  }
  return result;
}
