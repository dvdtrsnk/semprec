import { buildItemSearchQuery } from "../search/itemSearchQuery.js";

/**
 * Code points of a message the search vector covers. Postgres refuses a tsvector over 1 MiB, and message length
 * is unbounded, so without this a long pasted log would make the storing statement fail. 50,000 leaves ample room
 * even for one-letter words and several Hunspell lemmas per word. The text itself is stored whole.
 */
export const SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS = 50_000;

/**
 * SQL for `semp_messages.search_vector` of `textSql`: one combined `czech` + `czech_simple` vector (the shape of
 * `item_search_index.search_vector`) over the bounded prefix; NULL text gives NULL. Every writer of message text
 * uses it in the statement writing the text. `textSql` is a fixed fragment, never caller input.
 */
export function sempMessageSearchVectorSql(textSql: string): string {
  const indexed = `left(${textSql}, ${SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS})`;
  return `to_tsvector('czech', ${indexed}) || to_tsvector('czech_simple', ${indexed})`;
}

/**
 * Subquery of the `(tenant_id, thread_id)` pairs of threads whose non-system messages together contain every
 * `buildItemSearchQuery` term (lemma or prefix), bound in order from `firstParameter`. Null without terms.
 *
 * One message cannot carry the AND when words are spread over messages, so it reads messages matching any term
 * (GIN-indexable) and keeps threads covering all terms. Messages are read through RLS.
 */
export function buildSempThreadMessageSearch(
  text: string,
  firstParameter: number,
): { sql: string; params: string[] } | null {
  const { params } = buildItemSearchQuery(text, firstParameter);
  if (params.length === 0) return null;
  // The piece's SQL depends only on its bind position, so a fixed word stands in for the term and the builder
  // makes exactly one parameter.
  const pieces = params.map((_, index) => buildItemSearchQuery("term", firstParameter + index).sql);
  const anyTerm = pieces.join(" || ");
  const everyTerm = pieces.map((piece) => `bool_or(sm.search_vector @@ ${piece})`).join(" AND ");
  const sql = `SELECT sm.tenant_id, sm.thread_id FROM semp_messages sm
      WHERE sm.system_key IS NULL AND sm.search_vector @@ (${anyTerm})
      GROUP BY sm.tenant_id, sm.thread_id
     HAVING ${everyTerm}`;
  return { sql, params };
}
