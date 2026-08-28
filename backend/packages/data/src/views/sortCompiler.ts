import { ValidationError } from "../errors.js";
import type { PropertyType } from "../types.js";
import type { SortSpec } from "./sortSpec.js";

/**
 * Compiles a list of sort specs into an `ORDER BY` fragment, pushing the property key
 * (never the direction, which is only ever the literal 'ASC'/'DESC' chosen below from
 * the already-validated 'asc'|'desc' enum) onto `params`.
 */
export function compileSort(sorts: SortSpec[], propertyTypes: Map<string, PropertyType>, params: unknown[]): string {
  const clauses = sorts.map((sort) => {
    if (!propertyTypes.has(sort.property)) {
      throw new ValidationError(`Sort references unknown property '${sort.property}'`, { field: sort.property });
    }
    const type = propertyTypes.get(sort.property);
    params.push(sort.property);
    const field = `properties ->> $${params.length}`;
    const cast = type === "number" ? "::numeric" : type === "date" ? "::timestamptz" : "";
    const dir = sort.direction === "asc" ? "ASC" : "DESC";
    return `(${field})${cast} ${dir} NULLS LAST`;
  });
  return clauses.join(", ");
}
