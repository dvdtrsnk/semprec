import { ValidationError } from "../errors.js";
import type { PropertyType } from "../types.js";
import type { SortSpec } from "./sortSpec.js";

function castFor(type: PropertyType | undefined): string {
  return type === "number" ? "::numeric" : type === "date" ? "::timestamptz" : "";
}

/**
 * The one place a sort key's SQL expression is built — `(properties ->> $key)::cast` —
 * shared by `compileSort` and `compileSortKeyset` so the `ORDER BY` and the keyset
 * predicate that resumes it can never compare different expressions. Pushes the
 * property key onto `params`.
 */
function sortKeyExpression(sort: SortSpec, propertyTypes: Map<string, PropertyType>, params: unknown[]): string {
  if (!propertyTypes.has(sort.property)) {
    throw new ValidationError(`Sort references unknown property '${sort.property}'`, { field: sort.property });
  }
  params.push(sort.property);
  return `(properties ->> $${params.length})${castFor(propertyTypes.get(sort.property))}`;
}

/**
 * Compiles a list of sort specs into an `ORDER BY` fragment, pushing the property key
 * (never the direction, which is only ever the literal 'ASC'/'DESC' chosen below from
 * the already-validated 'asc'|'desc' enum) onto `params`.
 */
export function compileSort(sorts: SortSpec[], propertyTypes: Map<string, PropertyType>, params: unknown[]): string {
  const clauses = sorts.map((sort) => {
    const dir = sort.direction === "asc" ? "ASC" : "DESC";
    return `${sortKeyExpression(sort, propertyTypes, params)} ${dir} NULLS LAST`;
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
 * so it is the exact text `properties ->> key` would have produced for the stored value.
 * Nothing from the cursor is interpolated into the SQL.
 */
export function compileSortKeyset(
  sorts: SortSpec[],
  propertyTypes: Map<string, PropertyType>,
  cursor: { values: unknown[]; id: string },
  params: unknown[],
): string {
  const keys = sorts.map((sort, index) => {
    const expression = sortKeyExpression(sort, propertyTypes, params);
    const value = cursor.values[index] ?? null;
    if (value === null) return { after: "FALSE", same: `${expression} IS NULL` };
    params.push(JSON.stringify(value));
    const bound = `($${params.length}::jsonb #>> '{}')${castFor(propertyTypes.get(sort.property))}`;
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
