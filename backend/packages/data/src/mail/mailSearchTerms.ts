import type { SearchObject } from "imapflow";

/** The words of a free-text mail search as a provider search is given them: all `include` and none of `exclude`. */
export interface MailSearchTerms {
  include: string[];
  exclude: string[];
}

/** Terms past these are left out of a provider search; the local search still reads the whole text. */
const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 100;

const TOKEN = /(-?)(?:"([^"]*)"?|(\S+))/g;

/**
 * Reads the free text of `parseMailSearchQuery` as `websearch_to_tsquery` does: a quoted phrase is one term, a leading
 * `-` excludes a word or phrase, the word `or` joins nothing (a provider search asks for every term). Quotes and
 * backslashes never reach a term, so no provider syntax can be formed from them.
 */
export function parseMailSearchTerms(freeText: string): MailSearchTerms {
  const terms: MailSearchTerms = { include: [], exclude: [] };
  let count = 0;
  for (const match of freeText.matchAll(TOKEN)) {
    const raw = (match[2] ?? match[3] ?? "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    if (raw === "" || (match[2] === undefined && raw.toLowerCase() === "or")) continue;
    if (count === MAX_TERMS) break;
    const term = Array.from(raw).slice(0, MAX_TERM_LENGTH).join("");
    (match[1] === "-" ? terms.exclude : terms.include).push(term);
    count++;
  }
  return terms;
}

export function hasMailSearchTerms(terms: MailSearchTerms): boolean {
  return terms.include.length > 0;
}

/**
 * The terms in US-ASCII, for a server that refuses `CHARSET UTF-8`: diacritics dropped (`účet` → `ucet`), any other
 * non-ASCII character removed, and a term left empty dropped.
 */
export function asciiFoldedMailSearchTerms(terms: MailSearchTerms): MailSearchTerms {
  const fold = (list: string[]) =>
    list.flatMap((term) => {
      const folded = term
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/[^\x20-\x7e]/g, "")
        .trim();
      return folded === "" ? [] : [folded];
    });
  return { include: fold(terms.include), exclude: fold(terms.exclude) };
}

function isAsciiMailSearchTerms(terms: MailSearchTerms): boolean {
  return [...terms.include, ...terms.exclude].every((term) => /^[\x20-\x7e]*$/.test(term));
}

/**
 * Every included term as `TEXT` and every excluded one as `NOT TEXT`, ANDed: imapflow takes a single-element `or` as
 * its element, so each further key nests in the one before.
 */
function textSearchQuery(terms: MailSearchTerms): SearchObject {
  const keys: SearchObject[] = [
    ...terms.include.map((text) => ({ text })),
    ...terms.exclude.map((text) => ({ not: { text } })),
  ];
  return (
    keys.reduceRight<SearchObject | undefined>((next, key) => (next ? { ...key, or: [next] } : key), undefined) ?? {}
  );
}

/**
 * Runs `search` with the terms' `UID SEARCH` queries in turn until the server accepts one (`search` answers `false` for
 * a refused command): imapflow sends `CHARSET UTF-8` itself for a non-ASCII term, and for a server that refuses it the
 * terms follow folded to US-ASCII. Rejects when every query is refused. Called with at least one included term.
 */
export async function searchTextUntilAccepted(
  terms: MailSearchTerms,
  search: (query: SearchObject) => Promise<number[] | false>,
): Promise<number[]> {
  const folded = asciiFoldedMailSearchTerms(terms);
  const queries =
    isAsciiMailSearchTerms(terms) || folded.include.length === 0
      ? [textSearchQuery(terms)]
      : [textSearchQuery(terms), textSearchQuery(folded)];
  for (const query of queries) {
    const found = await search(query);
    if (found !== false) return found;
  }
  throw new Error("IMAP text search refused");
}

/** The string `id` of each listed provider hit, at most `limit`; anything else in the list is no message. */
export function searchHitIds(list: unknown, limit: number): string[] {
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (ids.length === limit) break;
    const id: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "id") : undefined;
    if (typeof id === "string" && id.length > 0 && id.length <= 1024) ids.push(id);
  }
  return ids;
}
