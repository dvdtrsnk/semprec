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

/**
 * The one place a sort key's SQL expression is built — `(column ->> $key)::cast` —
 * shared by `compileSort` and `compileSortKeyset` so the `ORDER BY` and the keyset
 * predicate that resumes it can never compare different expressions. A rollup's value
 * lives in `items.computed` (the recompute worker's column), every other property's in
 * `items.properties`. Pushes the property key onto `params`.
 */
function sortKeyExpression(sort: SortSpec, property: Pick<PropertyRow, "type" | "config">, params: unknown[]): string {
  params.push(sort.property);
  const column = property.type === "rollup" ? "computed" : "properties";
  return `(${column} ->> $${params.length})${sortKeyCast(property)}`;
}

/**
 * Compiles a list of sort specs into an `ORDER BY` fragment, pushing the property key
 * (never the direction, which is only ever the literal 'ASC'/'DESC' chosen below from
 * the already-validated 'asc'|'desc' enum) onto `params`.
 */
export function compileSort(sorts: SortSpec[], properties: SortProperties, params: unknown[]): string {
  const clauses = sorts.map((sort) => {
    const dir = sort.direction === "asc" ? "ASC" : "DESC";
    return `${sortKeyExpression(sort, lookupSortProperty(sort, properties), params)} ${dir} NULLS LAST`;
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
): string {
  const keys = sorts.map((sort, index) => {
    const property = lookupSortProperty(sort, properties);
    const expression = sortKeyExpression(sort, property, params);
    const value = cursor.values[index] ?? null;
    if (value === null) return { after: "FALSE", same: `${expression} IS NULL` };
    params.push(JSON.stringify(value));
    const bound = `($${params.length}::jsonb #>> '{}')${sortKeyCast(property)}`;
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
