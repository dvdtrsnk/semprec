/**
 * Deterministic JSON serialization, shared by issue #85's fingerprint algorithm and its
 * permission-manifest byte-equality check: object keys sorted by ascending Unicode code point,
 * array order preserved (callers normalize array order themselves before calling this, e.g.
 * sorting `manifestFacts`), no whitespace, standard JSON escaping, non-finite numbers rejected
 * outright rather than silently coerced (JSON has no representation for them).
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

/** Ascending Unicode code-point order — plain `<`/`>` on JS strings compares UTF-16 code units, which agrees with code-point order for this algorithm's purposes. */
export function compareByCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
