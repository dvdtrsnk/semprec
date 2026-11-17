const SEARCH_SNIPPET_MAX_CHARS = 160;

/** One fragment of 8 to 25 words, no highlight markers, so a client receives plain text. */
const HEADLINE_OPTIONS = 'StartSel="", StopSel="", MaxFragments=1, MaxWords=25, MinWords=8';

/**
 * The `snippet` SQL for a statement with `item_search_index.body` in scope. It reuses the bind parameters of
 * `tsquery` (built from `firstParameter`) and adds none, so no query word is ever SQL text. NULL unless `body` itself
 * matches with the index's vector and tsquery. The excerpt uses the accent-insensitive `czech_simple` prefix part, so
 * a body matching only by `czech` lemmas gets its start as the excerpt. Throws `RangeError` for a query without a word.
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
