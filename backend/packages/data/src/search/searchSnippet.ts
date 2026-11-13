/** The longest excerpt a search result carries, in characters. */
const SEARCH_SNIPPET_MAX_CHARS = 160;

/**
 * The `ts_headline` options of an excerpt: one fragment of 8 to 25 words, and no highlight markers, so a client
 * receives plain text. A constant of this module, written into the statement as a literal.
 */
const HEADLINE_OPTIONS = 'StartSel="", StopSel="", MaxFragments=1, MaxWords=25, MinWords=8';

/**
 * The SQL expression of the `snippet` of an item-backed search result (issue #1996), for a statement that reads
 * `item_search_index` and so has its `body` column in scope. `tsquery` is the output of `buildItemSearchQuery` for
 * this statement, and `firstParameter` is the bind position it was built from: the expression refers to the bind
 * parameters that hold the words of the query and adds none of its own, so no word of the query is ever part of the
 * SQL text.
 *
 * The excerpt exists only when the `body` itself matches: the same combined `czech` and `czech_simple` vector and the
 * same tsquery as the index match. Otherwise (a result found only through its title or other properties, or an item
 * without a body) the expression is NULL. The excerpt is built by `ts_headline` over `body` with the `czech_simple`
 * prefix part of the query, which finds a word by its start without regard to accents, and cut to
 * `SEARCH_SNIPPET_MAX_CHARS` characters. A body that matches only through the lemmas of the `czech` configuration has
 * no word `czech_simple` finds, and its excerpt then is the start of the body.
 *
 * Throws a `RangeError` for a query without a word, which has no tsquery to build an excerpt from.
 */
export function buildSearchSnippetSql(
  tsquery: { sql: string; params: readonly string[] },
  firstParameter: number,
): string {
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) throw new RangeError("Invalid parameter position");
  if (tsquery.params.length === 0) throw new RangeError("A search excerpt needs at least one word");
  const prefixQuery = tsquery.params
    .map((_, index) => `to_tsquery('czech_simple', $${firstParameter + index} || ':*')`)
    .join(" && ");
  return `CASE WHEN body IS NOT NULL AND (to_tsvector('czech', body) || to_tsvector('czech_simple', body)) @@ ${tsquery.sql}
    THEN left(ts_headline('czech_simple', body, ${prefixQuery}, '${HEADLINE_OPTIONS}'), ${SEARCH_SNIPPET_MAX_CHARS})
    ELSE NULL END`;
}
