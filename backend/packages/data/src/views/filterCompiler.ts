import { ValidationError } from "../errors.js";
import type { PropertyType } from "../types.js";
import type { FilterCondition, FilterNode } from "./filterTree.js";

/** Escapes LIKE metacharacters so a `contains`/`starts_with`/`ends_with` value can never inject its own wildcard. Paired with `ESCAPE '\'` in the compiled SQL. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Compiles one condition node into a SQL/JSONB predicate. Every value — including the
 * property *key* itself — is pushed onto `params` and referenced as `$N`; nothing from
 * the node is ever concatenated into the SQL text. That, plus the closed condition set
 * validated by filterTree.ts, is what makes a filter incapable of SQL injection.
 */
function compileCondition(node: FilterCondition, propertyTypes: Map<string, PropertyType>, params: unknown[]): string {
  if (!propertyTypes.has(node.property)) {
    throw new ValidationError(`Filter references unknown property '${node.property}'`, { field: node.property });
  }
  params.push(node.property);
  const keyParam = params.length;
  const textField = `properties ->> $${keyParam}`;
  const jsonField = `properties -> $${keyParam}`;
  const isMultiSelect = propertyTypes.get(node.property) === "multi_select";

  switch (node.type) {
    case "equals":
      params.push(String(node.value));
      return `${textField} = $${params.length}`;
    case "not_equals":
      params.push(String(node.value));
      return `(${textField} IS DISTINCT FROM $${params.length})`;
    case "contains":
      params.push(`%${escapeLikePattern(node.value)}%`);
      return `${textField} ILIKE $${params.length} ESCAPE '\\'`;
    case "not_contains":
      params.push(`%${escapeLikePattern(node.value)}%`);
      return `(${textField} IS NULL OR ${textField} NOT ILIKE $${params.length} ESCAPE '\\')`;
    case "starts_with":
      params.push(`${escapeLikePattern(node.value)}%`);
      return `${textField} ILIKE $${params.length} ESCAPE '\\'`;
    case "ends_with":
      params.push(`%${escapeLikePattern(node.value)}`);
      return `${textField} ILIKE $${params.length} ESCAPE '\\'`;
    case "is_empty":
      // A multi_select stores a jsonb array; `properties ->> key` on it never yields NULL
      // or '' (it renders as the text "[]"), so emptiness must be checked on the jsonb form.
      return isMultiSelect
        ? `(${jsonField} IS NULL OR ${jsonField} = 'null'::jsonb OR ${jsonField} = '[]'::jsonb)`
        : `(${textField} IS NULL OR ${textField} = '')`;
    case "is_not_empty":
      return isMultiSelect
        ? `(${jsonField} IS NOT NULL AND ${jsonField} != 'null'::jsonb AND ${jsonField} != '[]'::jsonb)`
        : `(${textField} IS NOT NULL AND ${textField} != '')`;
    case "before":
      params.push(node.value);
      return `(${textField})::timestamptz < $${params.length}::timestamptz`;
    case "after":
      params.push(node.value);
      return `(${textField})::timestamptz > $${params.length}::timestamptz`;
    case "on_or_before":
      params.push(node.value);
      return `(${textField})::timestamptz <= $${params.length}::timestamptz`;
    case "on_or_after":
      params.push(node.value);
      return `(${textField})::timestamptz >= $${params.length}::timestamptz`;
    case "date_range": {
      params.push(node.value.from);
      const from = params.length;
      params.push(node.value.to);
      const to = params.length;
      return `(${textField})::timestamptz BETWEEN $${from}::timestamptz AND $${to}::timestamptz`;
    }
    case "in": {
      params.push(node.value);
      // multi_select stores a jsonb array; `in` means "overlaps any of the given values".
      // Every other type stores a scalar; `in` means plain membership.
      return isMultiSelect ? `${jsonField} ?| $${params.length}::text[]` : `${textField} = ANY($${params.length}::text[])`;
    }
  }
}

export function compileFilterNode(node: FilterNode, propertyTypes: Map<string, PropertyType>, params: unknown[]): string {
  switch (node.type) {
    case "and":
      return `(${node.nodes.map((n) => compileFilterNode(n, propertyTypes, params)).join(" AND ")})`;
    case "or":
      return `(${node.nodes.map((n) => compileFilterNode(n, propertyTypes, params)).join(" OR ")})`;
    case "not":
      return `(NOT ${compileFilterNode(node.node, propertyTypes, params)})`;
    default:
      return compileCondition(node, propertyTypes, params);
  }
}
