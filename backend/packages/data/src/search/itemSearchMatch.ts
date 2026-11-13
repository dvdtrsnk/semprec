import { buildItemSearchQuery } from "./itemSearchQuery.js";

// The one match predicate over `item_search_index` (issues #1842 and #1857): an index row joined to its item, kept
// when the row's database is one of the wanted ones and its `search_vector` matches the combined lemma-or-prefix
// tsquery of `buildItemSearchQuery`. Global search (`searchItemsQuery.ts`) and the `q` of a database or view query and
// of an item count (`andItemSearchMatch`) build their SQL from the parts below, so "matches" cannot drift between them.
// Every value reaches the statement as a bound parameter; only fixed fragments are concatenated.

/** The index joined to its item, as `s` and `i`; callers append their own joins and conditions. */
export const ITEM_SEARCH_MATCH_FROM =
  "item_search_index s JOIN items i ON i.database_id = s.database_id AND i.id = s.item_id";

/**
 * The condition that keeps the `s`/`i` rows of `ITEM_SEARCH_MATCH_FROM` whose database is in `databaseIdsSql` (a
 * SQL expression of type `uuid[]`) and whose index vector matches `tsquerySql`. It does not look at `deleted_at`:
 * whether a trashed item may match is the caller's decision.
 */
export function itemSearchMatchWhere(databaseIdsSql: string, tsquerySql: string): string {
  return `s.database_id = ANY(${databaseIdsSql}) AND i.database_id = ANY(${databaseIdsSql}) AND s.search_vector @@ ${tsquerySql}`;
}

/** A condition builder as `listItems`, `countItems` and `countItemsGrouped` take it: it appends its bind values to `params`. */
export type BuildFilterSql = (params: unknown[]) => string | undefined;

/**
 * `buildFilterSql` ANDed with "the item's index row in `databaseId` matches the text `q`". Items without an index
 * row do not match, and text without a searchable word matches nothing (the condition is `FALSE`). The result
 * keeps the item's own `items.id` reference that the filter compiler uses, so it composes with a compiled filter and
 * runs inside `listItems`, `countItems` and `countItemsGrouped` unchanged.
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
