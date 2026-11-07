import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";
import { parseRollupConfig } from "../rollup/config.js";
import type { SortSpec, SystemSortField } from "./sortSpec.js";

/** What the sort compiler needs to know about one sortable property, keyed by property key. */
export type SortProperties = Map<string, Pick<PropertyRow, "type" | "config">>;

/**
 * The cast a sort key's text is compared under. A rollup's value is typed by its aggregation, not
 * its property type: `earliest`/`latest` produce a timestamp, every other aggregation a number.
 */
export function sortKeyCast(property: Pick<PropertyRow, "type" | "config">): "::numeric" | "::timestamptz" | "" {
  if (property.type === "rollup") {
    const { aggregation } = parseRollupConfig(property.config);
    return aggregation === "earliest" || aggregation === "latest" ? "::timestamptz" : "::numeric";
  }
  return property.type === "number" ? "::numeric" : property.type === "date" ? "::timestamptz" : "";
}

const DATE_ONLY_SORT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/**
 * Applies a sort key's cast to the SQL text `valueSql`. A `::timestamptz` key reads a date-only
 * string through `::date` first and places it at midnight UTC explicitly, so it sorts by day
 * whatever the session's zone (a plain `date::timestamptz` would use the session zone).
 */
function castSortKey(valueSql: string, cast: ReturnType<typeof sortKeyCast>): string {
  if (cast !== "::timestamptz") return `(${valueSql})${cast}`;
  return `(CASE WHEN (${valueSql}) ~ '${DATE_ONLY_SORT_PATTERN}' THEN (${valueSql})::date::timestamp AT TIME ZONE 'UTC' ELSE (${valueSql})::timestamptz END)`;
}

/** The ICU collations a text sort may use; the SQL names come only from this closed list. */
export type SortCollation = "cs-x-icu" | "und-x-icu";

/** The neutral collation, used for every locale but Czech and for callers without a user. */
export const DEFAULT_SORT_COLLATION: SortCollation = "und-x-icu";

/** Maps a `users.locale` to its collation: Czech sorts by the Czech alphabet, anything else (or no locale) neutrally. */
export function collationForLocale(locale: string | undefined): SortCollation {
  return locale?.split(/[-_]/)[0]?.toLowerCase() === "cs" ? "cs-x-icu" : DEFAULT_SORT_COLLATION;
}

const COLLATED_TYPES: ReadonlySet<string> = new Set(["title", "text", "url"]);

/** `COLLATE "<name>"` for a text-like sort key, empty for every other type. */
function collateClause(property: Pick<PropertyRow, "type">, collation: SortCollation): string {
  return COLLATED_TYPES.has(property.type) ? ` COLLATE "${collation}"` : "";
}

/** The `items` column a system sort key orders by; both are `timestamptz NOT NULL`. */
const SYSTEM_SORT_COLUMNS: Readonly<Record<SystemSortField, string>> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
};

/**
 * A system key's SQL expression: its column truncated to milliseconds. An item's `createdAt`/`updatedAt`
 * (and so a cursor built from it) is that column read through a JavaScript `Date`, which keeps exactly
 * the whole milliseconds (the microseconds are dropped, never rounded up), so the cursor value equals
 * this expression for its row. Comparing the untruncated column would skip or repeat rows that share a
 * millisecond. The column name comes only from `SYSTEM_SORT_COLUMNS`.
 */
function systemSortExpression(field: SystemSortField): string {
  return `date_trunc('milliseconds', ${SYSTEM_SORT_COLUMNS[field]})`;
}

/** One sort key resolved against the database: a system timestamp, or a property with its type and config. */
type ResolvedSortKey =
  | { kind: "system"; field: SystemSortField }
  | { kind: "property"; key: string; property: Pick<PropertyRow, "type" | "config"> };

function resolveSortKey(sort: SortSpec, properties: SortProperties): ResolvedSortKey {
  if (sort.system !== undefined) return { kind: "system", field: sort.system };
  const property = properties.get(sort.property);
  if (!property) {
    throw new ValidationError(`Sort references unknown property '${sort.property}'`, { field: sort.property });
  }
  return { kind: "property", key: sort.property, property };
}

/**
 * The one place a sort key's SQL expression is built — `(column ->> $key)::cast` for a property, the
 * truncated column for a system key — shared by `compileSort` and `compileSortKeyset` so the `ORDER BY`
 * and the keyset predicate that resumes it can never compare different expressions. A rollup's value
 * lives in `items.computed` (the recompute worker's column), every other property's in
 * `items.properties`. Pushes a property key onto `params`; a system key pushes nothing.
 */
function sortKeyExpression(key: ResolvedSortKey, params: unknown[], collation: SortCollation): string {
  if (key.kind === "system") return systemSortExpression(key.field);
  const { property } = key;
  const optionKeys = selectOptionKeys(property);
  if (optionKeys) params.push(optionKeys);
  const keysIndex = params.length;
  params.push(key.key);
  if (optionKeys) return optionPosition(keysIndex, `properties ->> $${params.length}`);
  const column = property.type === "rollup" ? "computed" : "properties";
  return `${castSortKey(`${column} ->> $${params.length}`, sortKeyCast(property))}${collateClause(property, collation)}`;
}

/**
 * The declared option keys of a `select` property, in `config.options` order, or `undefined` for
 * any other type. A select sorts by the position of its stored value in this array, not by the
 * value's text. Entries without a string key are skipped.
 */
function selectOptionKeys(property: Pick<PropertyRow, "type" | "config">): string[] | undefined {
  if (property.type !== "select") return undefined;
  const options: unknown = property.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    const key = typeof option === "object" && option !== null && "key" in option ? option.key : undefined;
    return typeof key === "string" ? [key] : [];
  });
}

/** Position of the text `valueSql` in the key array bound at `$keysIndex` (one-based); NULL when absent. */
function optionPosition(keysIndex: number, valueSql: string): string {
  return `array_position($${keysIndex}::text[], ${valueSql})`;
}

/** The text `properties ->> key` would produce for a cursor value, or `null` when it has no option position. */
function cursorOptionText(value: unknown, optionKeys: string[]): string | null {
  const text =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  return text !== null && optionKeys.includes(text) ? text : null;
}

/**
 * Compiles a list of sort specs into an `ORDER BY` fragment, pushing the property key
 * (never the direction, which is only ever the literal 'ASC'/'DESC' chosen below from
 * the already-validated 'asc'|'desc' enum) onto `params`.
 */
export function compileSort(
  sorts: SortSpec[],
  properties: SortProperties,
  params: unknown[],
  collation: SortCollation = DEFAULT_SORT_COLLATION,
): string {
  const clauses = sorts.map((sort) => {
    const dir = sort.direction === "asc" ? "ASC" : "DESC";
    return `${sortKeyExpression(resolveSortKey(sort, properties), params, collation)} ${dir} NULLS LAST`;
  });
  return clauses.join(", ");
}

/**
 * Compiles the "rows strictly after this tuple" predicate for the order `compileSort`
 * produces followed by `id ASC`: the OR-of-prefixes expansion
 * `(k1 AFTER v1) OR (k1 SAME v1 AND k2 AFTER v2) OR ... OR (k1 SAME v1 AND ... AND id > $id)`.
 * Every key sorts `NULLS LAST`, so after a non-null `v` come greater (asc) / smaller (desc)
 * values and all nulls, while after a null `v` no row of that key is strictly later.
 *
 * Each cursor value is bound as JSON and read back with `#>> '{}'` before the key's cast,
 * so it is the exact text `column ->> key` would have produced for the stored value.
 * Nothing from the cursor is interpolated into the SQL.
 */
export function compileSortKeyset(
  sorts: SortSpec[],
  properties: SortProperties,
  cursor: { values: unknown[]; id: string },
  params: unknown[],
  collation: SortCollation = DEFAULT_SORT_COLLATION,
): string {
  const keys = sorts.map((sort, index) => {
    const key = resolveSortKey(sort, properties);
    const expression = sortKeyExpression(key, params, collation);
    const optionKeys = key.kind === "property" ? selectOptionKeys(key.property) : undefined;
    const rawValue = cursor.values[index] ?? null;
    const value = optionKeys && rawValue !== null ? cursorOptionText(rawValue, optionKeys) : rawValue;
    if (value === null) return { after: "FALSE", same: `${expression} IS NULL` };
    params.push(JSON.stringify(value));
    const boundText = `$${params.length}::jsonb #>> '{}'`;
    let bound =
      key.kind === "system"
        ? `(${boundText})::timestamptz`
        : `${castSortKey(boundText, sortKeyCast(key.property))}${collateClause(key.property, collation)}`;
    if (optionKeys) {
      params.push(optionKeys);
      bound = optionPosition(params.length, boundText);
    }
    const op = sort.direction === "asc" ? ">" : "<";
    return {
      after: `(${expression} ${op} ${bound} OR ${expression} IS NULL)`,
      same: `${expression} = ${bound}`,
    };
  });
  params.push(cursor.id);
  const idAfter = `id > $${params.length}`;

  const branches = keys.map((key, index) => [...keys.slice(0, index).map((k) => k.same), key.after].join(" AND "));
  branches.push([...keys.map((k) => k.same), idAfter].join(" AND "));
  return `(${branches.map((branch) => `(${branch})`).join(" OR ")})`;
}
