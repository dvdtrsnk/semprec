import { normalizeSearchPhone } from "./phoneNormalization.js";

/** A digit run long enough to be a phone number, possibly written with spaces, brackets or dashes. */
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}])(?:\+|00)?\d[\d ()-]*\d(?![\p{L}\p{N}])/gu;
const TERM = /[\p{L}\p{N}]+/gu;

/**
 * Builds a parameterized tsquery expression and its values, starting at the given bind position. Every word must
 * match, as a Czech word or as the prefix of a simple one. Two forms of a number are also accepted, because the text
 * parser indexes them differently from how they are typed:
 * - a number the parser read as a signed integer (`AB-1234`, `2026-11-22` and `+420 605` index `-1234`, `-22` and
 *   `+420`), so a run of digits also matches with a leading minus or plus;
 * - a run of at least nine digits, which is matched as the normalized phone number or as its digit groups written out,
 *   so an order or invoice number is found as well as a phone number.
 */
export function buildItemSearchQuery(text: string, firstParameter = 1): { sql: string; params: string[] } {
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) throw new RangeError("Invalid parameter position");
  const params: string[] = [];
  const bind = (value: string): string => {
    params.push(value);
    return `$${firstParameter + params.length - 1}`;
  };
  const term = (word: string): string => {
    const value = bind(word);
    const signed = /^\p{N}+$/u.test(word)
      ? ` || to_tsquery('czech_simple', '-' || ${value}) || to_tsquery('czech_simple', '+' || ${value})`
      : "";
    return `(to_tsquery('czech', ${value}) || to_tsquery('czech_simple', ${value} || ':*')${signed})`;
  };
  const allOf = (words: readonly string[]): string => words.map(term).join(" && ");

  const groups: string[] = [];
  let rest = 0;
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    groups.push(...(text.slice(rest, match.index).match(TERM) ?? []).map(term));
    const candidate = match[0];
    const digitGroups = candidate.match(TERM) ?? [];
    if (candidate.replace(/\D/g, "").length >= 9) {
      groups.push(`(${term(normalizeSearchPhone(candidate))} || (${allOf(digitGroups)}))`);
    } else {
      groups.push(...digitGroups.map(term));
    }
    rest = match.index + candidate.length;
  }
  groups.push(...(text.slice(rest).match(TERM) ?? []).map(term));
  if (groups.length === 0) return { sql: "''::tsquery", params };
  return { sql: `(${groups.join(" && ")})`, params };
}
