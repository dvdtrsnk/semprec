import { buildItemSearchQuery } from "./itemSearchQuery.js";

// The one match predicate over `item_search_index`, shared by global search and the `q` of database/view queries
// and item counts, so "matches" cannot drift between them. Every value is bound; only fixed fragments are concatenated.

/** Aliased `s` and `i`; callers append their own joins and conditions. */
export const ITEM_SEARCH_MATCH_FROM =
  "item_search_index s JOIN items i ON i.database_id = s.database_id AND i.id = s.item_id";

/** `databaseIdsSql` is a `uuid[]` expression. Ignores `deleted_at`: whether trashed items match is the caller's call. */
export function itemSearchMatchWhere(databaseIdsSql: string, tsquerySql: string): string {
  return `s.database_id = ANY(${databaseIdsSql}) AND i.database_id = ANY(${databaseIdsSql}) AND s.search_vector @@ ${tsquerySql}`;
}

/** Appends its bind values to `params`. */
export type BuildFilterSql = (params: unknown[]) => string | undefined;

/**
 * Items without an index row do not match; text without a searchable word is `FALSE`. Keeps the bare `items.id`
 * reference, so it composes with a compiled filter inside `listItems` and the count functions.
 */
export function andItemSearchMatch(
  buildFilterSql: BuildFilterSql | undefined,
  databaseId: string,
  q: string,
): BuildFilterSql {
  return (params) => {
    const base = buildFilterSql?.(params);
    const matchSql = itemSearchMatchSql(params, databaseId, q);
    return base ? `(${base}) AND ${matchSql}` : matchSql;
  };
}

function itemSearchMatchSql(params: unknown[], databaseId: string, q: string): string {
  const databaseParam = params.length + 1;
  const tsquery = buildItemSearchQuery(q, databaseParam + 1);
  if (tsquery.params.length === 0) return "FALSE";
  params.push(databaseId, ...tsquery.params);
  const databaseIdsSql = `ARRAY[$${databaseParam}::uuid]`;
  return `items.id IN (SELECT i.id FROM ${ITEM_SEARCH_MATCH_FROM} WHERE ${itemSearchMatchWhere(databaseIdsSql, tsquery.sql)})`;
}
