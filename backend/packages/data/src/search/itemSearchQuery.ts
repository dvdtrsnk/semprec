import { normalizeSearchPhone } from "./phoneNormalization.js";

/** A digit run long enough to be a phone number, possibly written with spaces, brackets or dashes. */
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}])(?:\+|00)?\d[\d ()-]*\d(?![\p{L}\p{N}])/gu;

/**
 * Builds a parameterized tsquery expression and its values, starting at the given bind position: one parameter per
 * term, every term required, and each term's SQL depending on its bind position alone. A term matches as a Czech word,
 * as the prefix of a simple one, and in the forms the text parser gives numbers: with a leading minus or plus (it
 * indexes `AB-1234`, `2026-11-22` and `+420` as `-1234`, `-22` and `+420`) and with the Czech country code (phone
 * properties are indexed as international digits). A phone number written with a prefix or separators becomes one
 * normalized term; a run of digits typed together stays as typed (unless it starts with `00`), so an order or invoice
 * number is found.
 */
export function buildItemSearchQuery(text: string, firstParameter = 1): { sql: string; params: string[] } {
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) throw new RangeError("Invalid parameter position");
  const phonesJoined = text.replace(PHONE_CANDIDATE, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9) return candidate;
    // Typed together, digits stay as typed unless they start with the international `00` prefix.
    return /^\d+$/.test(candidate) && !candidate.startsWith("00") ? candidate : normalizeSearchPhone(candidate);
  });
  const params = phonesJoined.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (params.length === 0) return { sql: "''::tsquery", params };
  const sql = params
    .map((_, index) => {
      const bind = `$${firstParameter + index}`;
      return (
        `(to_tsquery('czech', ${bind}) || to_tsquery('czech_simple', ${bind} || ':*')` +
        ` || to_tsquery('czech_simple', '-' || ${bind}) || to_tsquery('czech_simple', '+' || ${bind})` +
        ` || to_tsquery('czech_simple', '420' || ${bind}))`
      );
    })
    .join(" && ");
  return { sql: `(${sql})`, params };
}
