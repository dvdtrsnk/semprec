import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import type { PropertyType } from "../types.js";
import type { FilterCondition, FilterNode } from "./filterTree.js";
import { resolveDayRange, type FilterCompileContext } from "./relativeDates.js";

export type { FilterCompileContext } from "./relativeDates.js";

const DATE_ONLY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/**
 * What the compiler needs to know about one filterable property. A relation property also
 * carries which relation definition it belongs to and which side of it this database's items
 * sit on, since a relation value is an `item_relations` edge rather than a `properties` field.
 */
export interface FilterProperty {
  type: PropertyType;
  relationDefinitionId?: string;
  relationSide?: "a" | "b";
  targetDatabaseId?: string;
  targetRelationProperties?: FilterProperties;
  /** Set for a rollup whose value is a number (any aggregation but `earliest`/`latest`). */
  numericRollup?: boolean;
}

export type FilterProperties = Map<string, FilterProperty>;

type RelationCondition = Extract<FilterCondition, { type: "relation_contains" | "relation_not_contains" }>;
type RelationEmptinessCondition = Extract<FilterCondition, { type: "relation_is_empty" | "relation_is_not_empty" }>;

function isRelationCondition(node: FilterCondition): node is RelationCondition | RelationEmptinessCondition {
  return (
    node.type === "relation_contains" ||
    node.type === "relation_not_contains" ||
    node.type === "relation_is_empty" ||
    node.type === "relation_is_not_empty"
  );
}

function isRelationEmptinessCondition(node: FilterCondition): node is RelationEmptinessCondition {
  return node.type === "relation_is_empty" || node.type === "relation_is_not_empty";
}

/**
 * Emptiness of a relation property: an edge only counts when its other end is a live item of
 * the target database. The definition id and database id are bound parameters; only the
 * `a`/`b` side names, taken from the registered definition, are interpolated. The lateral
 * lookup with `OFFSET 0` pins the join to the target database partition, as in the path filter.
 */
function compileRelationEmptinessCondition(
  node: RelationEmptinessCondition,
  property: FilterProperty,
  params: unknown[],
): string {
  if (!property.relationDefinitionId || !property.relationSide || !property.targetDatabaseId) {
    throw new ValidationError(`Relation property '${node.property}' has no resolvable relation definition`, {
      field: node.property,
    });
  }
  const ownSide = property.relationSide === "a" ? "item_a" : "item_b";
  const targetSide = property.relationSide === "a" ? "item_b" : "item_a";
  params.push(property.relationDefinitionId);
  const definitionParam = params.length;
  params.push(property.targetDatabaseId);
  const databaseParam = params.length;
  const exists = `EXISTS (
    SELECT 1 FROM item_relations r
    CROSS JOIN LATERAL (
      SELECT live.id FROM items live
      WHERE live.database_id = $${databaseParam}::uuid
        AND live.id = r.${targetSide}
        AND live.deleted_at IS NULL
      OFFSET 0
    ) live_target
    WHERE r.relation_definition_id = $${definitionParam}
      AND r.${ownSide} = items.id
  )`;
  return node.type === "relation_is_not_empty" ? exists : `(NOT ${exists})`;
}

/**
 * A relation condition compiles to an existence check over `item_relations`, never to a
 * `properties` lookup: the relation-definition id and the target item id are both bound
 * parameters, and the only thing interpolated into the SQL text is the `a`/`b` side, which
 * comes from the property's own registered relation definition — never from the filter node.
 */
function compileRelationCondition(node: RelationCondition, property: FilterProperty, params: unknown[]): string {
  if (!property.relationDefinitionId || !property.relationSide) {
    throw new ValidationError(`Relation property '${node.property}' has no relation definition`, {
      field: node.property,
    });
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

/** Two registered relations with a live intermediate item, pinned to its database partition. */
function compileRelationPathCondition(
  node: Extract<FilterCondition, { type: "relation_path_contains" }>,
  properties: FilterProperties,
  params: unknown[],
): string {
  const first = properties.get(node.path[0]);
  const second = first?.targetRelationProperties?.get(node.path[1]);
  if (
    first?.type !== "relation" ||
    !first.relationDefinitionId ||
    !first.relationSide ||
    !first.targetDatabaseId ||
    second?.type !== "relation" ||
    !second.relationDefinitionId ||
    !second.relationSide
  ) {
    throw new ValidationError("Filter requires a resolvable two-relation path", { field: "filter" });
  }
  const firstOwn = first.relationSide === "a" ? "item_a" : "item_b";
  const firstTarget = first.relationSide === "a" ? "item_b" : "item_a";
  const secondOwn = second.relationSide === "a" ? "item_a" : "item_b";
  const secondTarget = second.relationSide === "a" ? "item_b" : "item_a";
  params.push(first.relationDefinitionId);
  const firstParam = params.length;
  params.push(first.targetDatabaseId);
  const databaseParam = params.length;
  params.push(second.relationDefinitionId);
  const secondParam = params.length;
  params.push(node.value);
  const valueParam = params.length;
  return `EXISTS (
    SELECT 1 FROM item_relations path_first
    CROSS JOIN LATERAL (
      SELECT intermediate.id FROM items intermediate
      WHERE intermediate.database_id = $${databaseParam}::uuid
        AND intermediate.id = path_first.${firstTarget}
        AND intermediate.deleted_at IS NULL
      OFFSET 0
    ) path_intermediate
    WHERE path_first.relation_definition_id = $${firstParam}
      AND path_first.${firstOwn} = items.id
      AND EXISTS (
        SELECT 1 FROM item_relations path_second
        WHERE path_second.relation_definition_id = $${secondParam}
          AND path_second.${secondOwn} = path_intermediate.id
          AND path_second.${secondTarget} = $${valueParam}::uuid
      )
  )`;
}

/**
 * The cast a date condition compares under: `::date` when every operand is a date-only string, so
 * the comparison never goes through an instant and never depends on a time zone; `::timestamptz`
 * as soon as one operand carries a time.
 */
function dateComparisonCast(operands: string[]): "::date" | "::timestamptz" {
  return operands.every((operand) => new RegExp(DATE_ONLY_PATTERN).test(operand)) ? "::date" : "::timestamptz";
}

/** The calendar day of a stored date value in the tenant zone: a date-only string as written, a timestamp via AT TIME ZONE; empty or missing is NULL. */
function dayExpression(field: string, zoneParam: number): string {
  return `(CASE WHEN NULLIF(${field}, '') IS NULL THEN NULL WHEN ${field} ~ '${DATE_ONLY_PATTERN}' THEN (${field})::date ELSE ((${field})::timestamptz AT TIME ZONE $${zoneParam}::text)::date END)`;
}

/**
 * Compiles `date_relative` to day-range comparisons. The bounds come from the compile context
 * (zone and clock) and are bound as parameters, so no clock call appears in the SQL. A null or
 * missing value yields NULL and never matches. With `endProperty` the interval
 * [property, endProperty or property] must intersect the range.
 */
function compileDateRelative(
  node: Extract<FilterCondition, { type: "date_relative" }>,
  properties: FilterProperties,
  params: unknown[],
  context: FilterCompileContext | undefined,
): string {
  if (!context) {
    throw new ValidationError("A relative date filter needs the tenant time zone and clock", { field: node.property });
  }
  for (const key of node.endProperty ? [node.property, node.endProperty] : [node.property]) {
    const property = properties.get(key);
    if (!property) throw new ValidationError(`Filter references unknown property '${key}'`, { field: key });
    if (property.type !== "date") {
      throw new ValidationError(
        `Condition 'date_relative' requires a date property, but '${key}' is '${property.type}'`,
        { field: key },
      );
    }
  }
  params.push(context.zone);
  const zoneParam = params.length;
  const field = (key: string): string => {
    params.push(key);
    return `properties ->> $${params.length}`;
  };
  const startField = field(node.property);
  const start = dayExpression(startField, zoneParam);
  const range = resolveDayRange(node.preset, context);
  const clauses: string[] = [`${start} IS NOT NULL`];
  if (node.preset === "beforeNow") {
    // A timestamp is compared as an instant, a date-only value as day < D.
    params.push(context.now.toISOString());
    const nowParam = params.length;
    params.push(range.to);
    const toParam = params.length;
    clauses.push(
      `(CASE WHEN ${startField} ~ '${DATE_ONLY_PATTERN}' THEN (${startField})::date <= $${toParam}::date ELSE (${startField})::timestamptz < $${nowParam}::timestamptz END)`,
    );
    return `(${clauses.join(" AND ")})`;
  }
  if (range.from !== undefined) {
    const end = node.endProperty ? `COALESCE(${dayExpression(field(node.endProperty), zoneParam)}, ${start})` : start;
    params.push(range.from);
    clauses.push(`${end} >= $${params.length}::date`);
  }
  if (range.to !== undefined) {
    params.push(range.to);
    clauses.push(`${start} <= $${params.length}::date`);
  }
  return `(${clauses.join(" AND ")})`;
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
function compileCondition(
  node: FilterCondition,
  properties: FilterProperties,
  params: unknown[],
  context: FilterCompileContext | undefined,
): string {
  if (node.type === "date_relative") return compileDateRelative(node, properties, params, context);
  if (node.type === "relation_path_contains") return compileRelationPathCondition(node, properties, params);
  const property = properties.get(node.property);
  if (!property) {
    throw new ValidationError(`Filter references unknown property '${node.property}'`, { field: node.property });
  }
  if (isRelationCondition(node) !== (property.type === "relation")) {
    throw new ValidationError(
      isRelationCondition(node)
        ? `Condition '${node.type}' requires a relation property, but '${node.property}' is '${property.type}'`
        : `Property '${node.property}' is a relation; filter it with relation_contains/relation_not_contains or relation_is_empty/relation_is_not_empty`,
      { field: node.property },
    );
  }
  if (isRelationEmptinessCondition(node)) return compileRelationEmptinessCondition(node, property, params);
  if (isRelationCondition(node)) return compileRelationCondition(node, property, params);

  params.push(node.property);
  const keyParam = params.length;
  // A rollup's value is written by the recompute worker into `items.computed`, never `properties`.
  const column = property.type === "rollup" ? "computed" : "properties";
  const textField = `${column} ->> $${keyParam}`;
  const jsonField = `${column} -> $${keyParam}`;
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
    case "before": {
      params.push(node.value);
      const cast = dateComparisonCast([node.value]);
      return `(${textField})${cast} < $${params.length}${cast}`;
    }
    case "after": {
      params.push(node.value);
      const cast = dateComparisonCast([node.value]);
      return `(${textField})${cast} > $${params.length}${cast}`;
    }
    case "on_or_before": {
      params.push(node.value);
      const cast = dateComparisonCast([node.value]);
      return `(${textField})${cast} <= $${params.length}${cast}`;
    }
    case "on_or_after": {
      params.push(node.value);
      const cast = dateComparisonCast([node.value]);
      return `(${textField})${cast} >= $${params.length}${cast}`;
    }
    case "date_range": {
      params.push(node.value.from);
      const from = params.length;
      params.push(node.value.to);
      const to = params.length;
      const cast = dateComparisonCast([node.value.from, node.value.to]);
      return `(${textField})${cast} BETWEEN $${from}${cast} AND $${to}${cast}`;
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (!(property.type === "number" || (property.type === "rollup" && property.numericRollup))) {
        throw new ValidationError(
          `Condition '${node.type}' requires a number or numeric rollup property, but '${node.property}' is '${property.type}'`,
          { field: node.property },
        );
      }
      params.push(node.value);
      const operator = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[node.type];
      // CASE (unlike AND) guarantees a stored non-number never reaches the cast; a missing key is not a number either.
      return `(CASE WHEN jsonb_typeof(${jsonField}) = 'number' THEN (${textField})::numeric ${operator} $${params.length}::numeric ELSE false END)`;
    }
    case "in": {
      params.push(node.value);
      // multi_select stores a jsonb array; `in` means "overlaps any of the given values".
      // Every other type stores a scalar; `in` means plain membership.
      return isMultiSelect
        ? `${jsonField} ?| $${params.length}::text[]`
        : `${textField} = ANY($${params.length}::text[])`;
    }
  }
}

/** `context` carries the tenant zone and clock; only `date_relative` conditions need it. */
export function compileFilterNode(
  node: FilterNode,
  properties: FilterProperties,
  params: unknown[],
  context?: FilterCompileContext,
): string {
  switch (node.type) {
    case "and":
      return `(${node.nodes.map((n) => compileFilterNode(n, properties, params, context)).join(" AND ")})`;
    case "or":
      return `(${node.nodes.map((n) => compileFilterNode(n, properties, params, context)).join(" OR ")})`;
    case "not":
      return `(NOT ${compileFilterNode(node.node, properties, params, context)})`;
    default:
      return compileCondition(node, properties, params, context);
  }
}

/** True when the tree contains a condition whose result depends on the clock. */
function filterUsesClock(node: FilterNode): boolean {
  switch (node.type) {
    case "and":
    case "or":
      return node.nodes.some(filterUsesClock);
    case "not":
      return filterUsesClock(node.node);
    default:
      return node.type === "date_relative";
  }
}

/** Reads the tenant zone (only when the tree needs it) and pairs it with the clock. */
export async function resolveFilterCompileContext(
  client: Queryable,
  node: FilterNode,
  now?: Date,
): Promise<FilterCompileContext | undefined> {
  if (!filterUsesClock(node)) return undefined;
  return { zone: await getSystemTimezone(client), now: now ?? new Date() };
}
