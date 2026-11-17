/**
 * Deterministic JSON for drift fingerprints and the permission-manifest byte-equality check: keys sorted by Unicode
 * code point, array order preserved (callers normalize it), no whitespace, standard escaping, non-finite numbers
 * rejected instead of coerced.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalizeJson: cannot serialize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareByCodePoint);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonicalizeJson: cannot serialize a value of type ${typeof value}`);
}

/** Plain `<`/`>` compares UTF-16 code units, which agrees with code-point order for this purpose. */
export function compareByCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
