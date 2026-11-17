import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";
import { parseRollupConfig } from "../rollup/config.js";
import type { SortSpec, SystemSortField } from "./sortSpec.js";

export type SortProperties = Map<string, Pick<PropertyRow, "type" | "config">>;

/** A rollup is typed by its aggregation: `earliest`/`latest` produce a timestamp, every other a number. */
export function sortKeyCast(property: Pick<PropertyRow, "type" | "config">): "::numeric" | "::timestamptz" | "" {
  if (property.type === "rollup") {
    const { aggregation } = parseRollupConfig(property.config);
    return aggregation === "earliest" || aggregation === "latest" ? "::timestamptz" : "::numeric";
  }
  return property.type === "number" ? "::numeric" : property.type === "date" ? "::timestamptz" : "";
}

const DATE_ONLY_SORT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/**
 * A `::timestamptz` key reads a date-only string via `::date` at midnight UTC explicitly, so it sorts by day
 * whatever the session's zone.
 */
function castSortKey(valueSql: string, cast: ReturnType<typeof sortKeyCast>): string {
  if (cast !== "::timestamptz") return `(${valueSql})${cast}`;
  return `(CASE WHEN (${valueSql}) ~ '${DATE_ONLY_SORT_PATTERN}' THEN (${valueSql})::date::timestamp AT TIME ZONE 'UTC' ELSE (${valueSql})::timestamptz END)`;
}

/** The SQL collation names come only from this closed list. */
export type SortCollation = "cs-x-icu" | "und-x-icu";

export const DEFAULT_SORT_COLLATION: SortCollation = "und-x-icu";

export function collationForLocale(locale: string | undefined): SortCollation {
  return locale?.split(/[-_]/)[0]?.toLowerCase() === "cs" ? "cs-x-icu" : DEFAULT_SORT_COLLATION;
}

const COLLATED_TYPES: ReadonlySet<string> = new Set(["title", "text", "url"]);

function collateClause(property: Pick<PropertyRow, "type">, collation: SortCollation): string {
  return COLLATED_TYPES.has(property.type) ? ` COLLATE "${collation}"` : "";
}

/** Both are `timestamptz NOT NULL`. */
const SYSTEM_SORT_COLUMNS: Readonly<Record<SystemSortField, string>> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
};

/**
 * The column at full precision, so items within one millisecond keep their real order. A cursor carries the exact
 * six-digit UTC text, which casts back to the same `timestamptz`.
 */
function systemSortExpression(field: SystemSortField): string {
  return SYSTEM_SORT_COLUMNS[field];
}

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
 * The one place a sort key's SQL is built, shared by `compileSort` and `compileSortKeyset` so `ORDER BY` and the
 * keyset predicate never compare different expressions. A rollup reads `items.computed`.
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

/** A select sorts by its stored value's position in `config.options`, not by text. `undefined` for other types. */
export function selectOptionKeys(property: Pick<PropertyRow, "type" | "config">): string[] | undefined {
  if (property.type !== "select") return undefined;
  const options: unknown = property.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    const key = typeof option === "object" && option !== null && "key" in option ? option.key : undefined;
    return typeof key === "string" ? [key] : [];
  });
}

/** One-based; NULL when absent. */
function optionPosition(keysIndex: number, valueSql: string): string {
  return `array_position($${keysIndex}::text[], ${valueSql})`;
}

/** `null` when the value has no option position. */
function cursorOptionText(value: unknown, optionKeys: string[]): string | null {
  const text =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  return text !== null && optionKeys.includes(text) ? text : null;
}

/** The direction is only ever the literal 'ASC'/'DESC' chosen from the validated enum; property keys are bound. */
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
 * "Rows strictly after this tuple" for `compileSort` then `id ASC`, as an OR-of-prefixes expansion. Every key sorts
 * `NULLS LAST`, so after a null `v` no row of that key is strictly later. Cursor values are bound as JSON and read
 * with `#>> '{}'` before the cast, giving the exact text `column ->> key` would; nothing is interpolated.
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
