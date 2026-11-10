import { normalizeSearchPhone } from "./phoneNormalization.js";

/** Builds a parameterized tsquery expression and its values, starting at the given bind position. */
export function buildItemSearchQuery(text: string, firstParameter = 1): { sql: string; params: string[] } {
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) throw new RangeError("Invalid parameter position");
  const phonesJoined = text.replace(/(?<![\p{L}\p{N}])(?:\+|00)?\d[\d ()-]*\d(?![\p{L}\p{N}])/gu, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 9 ? normalizeSearchPhone(candidate) : candidate;
  });
  const params = phonesJoined.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (params.length === 0) return { sql: "''::tsquery", params };
  const sql = params
    .map((_, index) => {
      const bind = `$${firstParameter + index}`;
      return `(to_tsquery('czech', ${bind}) || to_tsquery('czech_simple', ${bind} || ':*'))`;
    })
    .join(" && ");
  return { sql: `(${sql})`, params };
}
