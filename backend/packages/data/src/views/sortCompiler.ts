import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";
import { parseRollupConfig } from "../rollup/config.js";
import type { SortSpec } from "./sortSpec.js";

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

function lookupSortProperty(sort: SortSpec, properties: SortProperties): Pick<PropertyRow, "type" | "config"> {
  const property = properties.get(sort.property);
  if (!property) {
    throw new ValidationError(`Sort references unknown property '${sort.property}'`, { field: sort.property });
  }
  return property;
}

/** Builds the row and cursor expressions together, sharing the bound select option array. */
function sortKeyExpression(
  sort: SortSpec,
  property: Pick<PropertyRow, "type" | "config">,
  params: unknown[],
  cursorValue?: string,
): { expression: string; cursorExpression: string | undefined } {
  params.push(sort.property);
  const column = property.type === "rollup" ? "computed" : "properties";
  const value = `(${column} ->> $${params.length})`;
  if (property.type === "select") {
    const options: unknown[] = Array.isArray(property.config.options) ? property.config.options : [];
    const keys = options.flatMap((option: unknown) =>
      typeof option === "object" && option !== null && "key" in option && typeof option.key === "string"
        ? [option.key]
        : [],
    );
    params.push(keys);
    const array = `$${params.length}::text[]`;
    return {
      expression: `array_position(${array}, ${value})`,
      cursorExpression: cursorValue === undefined ? undefined : `array_position(${array}, ${cursorValue})`,
    };
  }
  const cast = sortKeyCast(property);
  return {
    expression: `${value}${cast}`,
    cursorExpression: cursorValue === undefined ? undefined : `${cursorValue}${cast}`,
  };
}

/**
 * Compiles a list of sort specs into an `ORDER BY` fragment, pushing the property key
 * (never the direction, which is only ever the literal 'ASC'/'DESC' chosen below from
 * the already-validated 'asc'|'desc' enum) onto `params`.
 */
export function compileSort(sorts: SortSpec[], properties: SortProperties, params: unknown[]): string {
  const clauses = sorts.map((sort) => {
    const dir = sort.direction === "asc" ? "ASC" : "DESC";
    return `${sortKeyExpression(sort, lookupSortProperty(sort, properties), params).expression} ${dir} NULLS LAST`;
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
 * Selects compare option positions; an unknown cursor value has a null position and
 * resumes among null positions by the remaining keys and id. Nothing from the cursor
 * is interpolated into the SQL.
 */
export function compileSortKeyset(
  sorts: SortSpec[],
  properties: SortProperties,
  cursor: { values: unknown[]; id: string },
  params: unknown[],
): string {
  const keys = sorts.map((sort, index) => {
    const property = lookupSortProperty(sort, properties);
    const value = cursor.values[index] ?? null;
    if (value === null) {
      const { expression } = sortKeyExpression(sort, property, params);
      return { after: "FALSE", same: `${expression} IS NULL` };
    }
    params.push(JSON.stringify(value));
    const cursorValue = `($${params.length}::jsonb #>> '{}')`;
    const { expression, cursorExpression: bound } = sortKeyExpression(sort, property, params, cursorValue);
    const op = sort.direction === "asc" ? ">" : "<";
    return {
      after: `(${bound} IS NOT NULL AND (${expression} ${op} ${bound} OR ${expression} IS NULL))`,
      same: `${expression} IS NOT DISTINCT FROM ${bound}`,
    };
  });
  params.push(cursor.id);
  const idAfter = `id > $${params.length}`;

  const branches = keys.map((key, index) => [...keys.slice(0, index).map((k) => k.same), key.after].join(" AND "));
  branches.push([...keys.map((k) => k.same), idAfter].join(" AND "));
  return `(${branches.map((branch) => `(${branch})`).join(" OR ")})`;
}
