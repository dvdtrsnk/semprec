import { ValidationError } from "../errors.js";
import type { PropertyType } from "../types.js";
import type { FilterCondition, FilterNode } from "./filterTree.js";

/**
 * What the compiler needs to know about one filterable property. A relation property also
 * carries which relation definition it belongs to and which side of it this database's items
 * sit on, since a relation value is an `item_relations` edge rather than a `properties` field.
 */
export interface FilterProperty {
  type: PropertyType;
  relationDefinitionId?: string;
  relationSide?: "a" | "b";
}

export type FilterProperties = Map<string, FilterProperty>;

type RelationCondition = Extract<FilterCondition, { type: "relation_contains" | "relation_not_contains" }>;

function isRelationCondition(node: FilterCondition): node is RelationCondition {
  return node.type === "relation_contains" || node.type === "relation_not_contains";
}

/**
 * A relation condition compiles to an existence check over `item_relations`, never to a
 * `properties` lookup: the relation-definition id and the target item id are both bound
 * parameters, and the only thing interpolated into the SQL text is the `a`/`b` side, which
 * comes from the property's own registered relation definition — never from the filter node.
 */
function compileRelationCondition(node: RelationCondition, property: FilterProperty, params: unknown[]): string {
  if (!property.relationDefinitionId || !property.relationSide) {
    throw new ValidationError(`Relation property '${node.property}' has no relation definition`, { field: node.property });
  }
  const ownSide = property.relationSide === "a" ? "item_a" : "item_b";
  const targetSide = property.relationSide === "a" ? "item_b" : "item_a";
  params.push(property.relationDefinitionId);
  const definitionParam = params.length;
  params.push(node.value);
  const targetParam = params.length;
  const exists = `EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $${definitionParam} AND r.${ownSide} = items.id AND r.${targetSide} = $${targetParam}::uuid)`;
  return node.type === "relation_contains" ? exists : `(NOT ${exists})`;
}

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
function compileCondition(node: FilterCondition, properties: FilterProperties, params: unknown[]): string {
  const property = properties.get(node.property);
  if (!property) {
    throw new ValidationError(`Filter references unknown property '${node.property}'`, { field: node.property });
  }
  if (isRelationCondition(node) !== (property.type === "relation")) {
    throw new ValidationError(
      isRelationCondition(node)
        ? `Condition '${node.type}' requires a relation property, but '${node.property}' is '${property.type}'`
        : `Property '${node.property}' is a relation; filter it with relation_contains/relation_not_contains`,
      { field: node.property },
    );
  }
  if (isRelationCondition(node)) return compileRelationCondition(node, property, params);

  params.push(node.property);
  const keyParam = params.length;
  const textField = `properties ->> $${keyParam}`;
  const jsonField = `properties -> $${keyParam}`;
  const isMultiSelect = property.type === "multi_select";

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

export function compileFilterNode(node: FilterNode, properties: FilterProperties, params: unknown[]): string {
  switch (node.type) {
    case "and":
      return `(${node.nodes.map((n) => compileFilterNode(n, properties, params)).join(" AND ")})`;
    case "or":
      return `(${node.nodes.map((n) => compileFilterNode(n, properties, params)).join(" OR ")})`;
    case "not":
      return `(NOT ${compileFilterNode(node.node, properties, params)})`;
    default:
      return compileCondition(node, properties, params);
  }
}
