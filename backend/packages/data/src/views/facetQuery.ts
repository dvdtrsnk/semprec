// Facets of one database: per requested property or relation path, its choices with item counts. Owns the
// exclude-self filter rewrite and one counting statement per facet.
import type { PoolClient } from "pg";
import type { AreaFilterTemplate } from "@semprec/module-registry";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { requireSingleRow } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { closedDatabaseRefusal } from "./closedDatabaseRefusal.js";
import {
  createCatalogResolver,
  resolveProperty,
  toManifestLocale,
  type CatalogResolver,
  type ResolvedProperty,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, PropertyRow } from "../types.js";
import {
  compileFilterNode,
  resolveFilterCompileContext,
  type FilterCompileContext,
  type FilterProperties,
  type FilterProperty,
} from "./filterCompiler.js";
import { buildFilterProperties } from "./filterProperties.js";
import {
  DATE_RELATIVE_PRESETS,
  filterNodeSchema,
  parseFilterNode,
  type FilterCondition,
  type FilterNode,
} from "./filterTree.js";

/** A property key, or a relation of the database and then a relation of the items that one reaches. */
export type FacetRequest = string | { path: [string, string] };

export interface DatabaseFacetsInput {
  databaseId: string;
  filter?: unknown;
  facets: FacetRequest[];
  /** A second filter tree; each facet then also reports how many of its items match it. */
  extra?: { open: unknown };
}

export interface DatabaseFacetsOptions {
  /** Missing stored labels are read from this language's catalog; English without one. */
  locale?: string;
  now?: Date;
  /**
   * An agent run's Projects item: a filter or facet that reaches, through a relation or rollup, a sensitive database
   * this project may not read is refused with `ForbiddenError`. Set from the run credential, never from a request.
   */
  agentProjectItemId?: string;
}

/** `null` is the choice of the items without a value. */
export interface DatabaseFacetValue {
  value: string | number | boolean | null;
  label?: string;
  color?: string;
  count: number;
}

/** `open` is present exactly when the call carried `extra.open`. */
export type DatabaseFacet = ({ property: string } | { path: [string, string] }) & {
  all: number;
  open?: number;
  values: DatabaseFacetValue[];
};

export interface FacetMetadata {
  catalogResolver: CatalogResolver;
  /** By database key. */
  areaFilters: ReadonlyMap<string, AreaFilterTemplate>;
}

let facetMetadataPromise: Promise<FacetMetadata> | undefined;

/**
 * Built once per process from `loadFullModuleRegistry`, because the choke point is constructed from a pool alone.
 * A failed load is not cached, so the next call retries.
 */
export function loadFacetMetadata(): Promise<FacetMetadata> {
  facetMetadataPromise ??= loadFullModuleRegistry()
    .then(async (registry) => {
      const areaFilters = new Map<string, AreaFilterTemplate>();
      for (const database of await registry.getDatabases()) {
        if (database.areaFilter !== undefined) areaFilters.set(database.key, database.areaFilter);
      }
      return { catalogResolver: await createCatalogResolver(registry), areaFilters };
    })
    .catch((error: unknown) => {
      facetMetadataPromise = undefined;
      throw error;
    });
  return facetMetadataPromise;
}

const FACET_TOP_VALUES = 20;

/** Status-like select keys: their facet lists every option, also one no item holds. */
const GROUP_SELECT_KEYS: ReadonlySet<string> = new Set(["status", "type", "relationship"]);

export type FacetTarget = { kind: "property"; key: string } | { kind: "path"; path: [string, string] };

function isFacetCondition(node: FilterCondition, facet: FacetTarget): boolean {
  if (node.type === "relation_path_contains") {
    return facet.kind === "path" && node.path[0] === facet.path[0] && node.path[1] === facet.path[1];
  }
  return facet.kind === "property" && node.property === facet.key;
}

function containsFacetCondition(node: FilterNode, facet: FacetTarget): boolean {
  switch (node.type) {
    case "and":
    case "or":
      return node.nodes.some((child) => containsFacetCondition(child, facet));
    case "not":
      return containsFacetCondition(node.node, facet);
    default:
      return isFacetCondition(node, facet);
  }
}

/**
 * `filter` without its conditions on the facet itself; `undefined` when nothing remains. Only conditions reached
 * from the root through `and` nodes are removed; one inside an `or` or `not` cannot be removed without changing
 * what the rest matches, so it is refused.
 */
export function excludeFacetConditions(filter: FilterNode, facet: FacetTarget): FilterNode | undefined {
  switch (filter.type) {
    case "and": {
      const kept = filter.nodes.flatMap((child) => {
        const rest = excludeFacetConditions(child, facet);
        return rest === undefined ? [] : [rest];
      });
      return kept.length > 0 ? { type: "and", nodes: kept } : undefined;
    }
    case "or":
    case "not":
      if (containsFacetCondition(filter, facet)) {
        throw new ValidationError("A condition on the facet itself inside 'or' or 'not' cannot be left out", {
          field: "filter",
        });
      }
      return filter;
    default:
      return isFacetCondition(filter, facet) ? undefined : filter;
  }
}

function areaFilterNames(template: AreaFilterTemplate, facet: FacetTarget): boolean {
  switch (template.type) {
    case "and":
    case "or":
      return template.nodes.some((node) => areaFilterNames(node, facet));
    case "relation_contains":
      return facet.kind === "property" && template.property === facet.key;
    case "relation_path_contains":
      return facet.kind === "path" && template.path[0] === facet.path[0] && template.path[1] === facet.path[1];
    case "relation_is_empty":
      return false;
  }
}

type RequestedFacet =
  { kind: "path"; path: [string, string] } | { kind: "property"; key: string; property: PropertyRow };

interface FacetScope {
  databaseId: string;
  filterProperties: FilterProperties;
  context: FilterCompileContext | undefined;
  /** The caller's filter without its conditions on the facet itself. */
  filter: FilterNode | undefined;
  open: FilterNode | undefined;
  /** `undefined` for a person. */
  closedDatabaseIds: ReadonlySet<string> | undefined;
}

interface FacetStatement {
  params: unknown[];
  bind: (value: unknown) => string;
  /** Live items of the database under the scope's filter; no item of an archived database. */
  where: string;
  /** `false` when the call has no `extra.open`. */
  openSql: string;
}

/** The items table keeps its own name because a compiled filter refers to `items.id`, `properties` and `computed`. */
function startStatement(scope: FacetScope): FacetStatement {
  const params: unknown[] = [scope.databaseId];
  const conditions = [
    "items.database_id = $1",
    "items.deleted_at IS NULL",
    "EXISTS (SELECT 1 FROM databases faceted WHERE faceted.id = $1 AND faceted.archived_at IS NULL)",
  ];
  if (scope.filter) {
    conditions.push(
      compileFilterNode(scope.filter, scope.filterProperties, params, scope.context, scope.closedDatabaseIds),
    );
  }
  const openSql = scope.open
    ? compileFilterNode(scope.open, scope.filterProperties, params, scope.context, scope.closedDatabaseIds)
    : "false";
  return {
    params,
    bind: (value) => {
      params.push(value);
      return `$${params.length}`;
    },
    where: conditions.join(" AND "),
    openSql,
  };
}

interface CountedValues {
  all: number;
  open: number;
  none: number;
  values: { value: string; count: number; label: string | null; color: string | null }[];
}

interface CountedValueRow {
  kind: "total" | "none" | "value";
  value: string | null;
  count: string;
  open: string;
  label: string | null;
  color: string | null;
}

/**
 * `counted` has one row per value, one NULL-value row for items without one, and the total row from the empty
 * grouping set (present whatever the input). An item with several values counts in each and once in the total.
 */
function countedValuesSql(statement: FacetStatement, storedSql: string, source: string): string {
  return `WITH matched AS (
      SELECT items.id, ${storedSql} AS stored, (${statement.openSql}) AS is_open FROM items WHERE ${statement.where}
    ), valued AS (
      SELECT matched.id, matched.is_open, facet.value AS facet_value
      FROM matched LEFT JOIN LATERAL (${source}) facet ON true
    ), counted AS (
      SELECT GROUPING(facet_value) = 1 AS is_total, facet_value,
             count(DISTINCT id) AS item_count, count(DISTINCT id) FILTER (WHERE is_open) AS open_count
      FROM valued GROUP BY GROUPING SETS ((facet_value), ())
    )`;
}

function readCountedValues(rows: CountedValueRow[]): CountedValues {
  const total = requireSingleRow(
    rows.filter((row) => row.kind === "total"),
    "facet total",
  );
  const none = rows.find((row) => row.kind === "none");
  return {
    all: Number(total.count),
    open: Number(total.open),
    none: none ? Number(none.count) : 0,
    values: rows.flatMap((row) =>
      row.kind === "value" && row.value !== null
        ? [{ value: row.value, count: Number(row.count), label: row.label, color: row.color }]
        : [],
    ),
  };
}

/**
 * A `multiple` property counts each distinct non-empty text of its JSON array. Missing, JSON null and the empty
 * string are no value. With `top`, the most frequent first (ties in byte order); otherwise all, in byte order.
 */
async function countStoredValues(
  client: PoolClient,
  scope: FacetScope,
  propertyKey: string,
  shape: { multiple: boolean; top?: number },
): Promise<CountedValues> {
  const statement = startStatement(scope);
  const source = shape.multiple
    ? `SELECT DISTINCT element.value
       FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(matched.stored) = 'array' THEN matched.stored ELSE '[]'::jsonb END
       ) AS element(value)
       WHERE NULLIF(element.value, '') IS NOT NULL`
    : `SELECT NULLIF(matched.stored #>> '{}', '') AS value`;
  const order = shape.top === undefined ? `facet_value COLLATE "C"` : `item_count DESC, facet_value COLLATE "C"`;
  const limit = shape.top === undefined ? "" : `WHERE NOT is_value OR ordinal <= ${statement.bind(shape.top)}::int`;
  const { rows } = await client.query<CountedValueRow>(
    `${countedValuesSql(statement, `items.properties -> ${statement.bind(propertyKey)}`, source)}, ranked AS (
       SELECT counted.*, (NOT is_total AND facet_value IS NOT NULL) AS is_value,
              ROW_NUMBER() OVER (PARTITION BY is_total, facet_value IS NULL ORDER BY ${order}) AS ordinal
       FROM counted
     )
     SELECT CASE WHEN is_total THEN 'total' WHEN is_value THEN 'value' ELSE 'none' END AS kind,
            facet_value AS value, item_count::text AS count, open_count::text AS open,
            NULL::text AS label, NULL::text AS color
     FROM ranked ${limit}
     ORDER BY ordinal`,
    statement.params,
  );
  return readCountedValues(rows);
}

interface RelationHop {
  definitionId: string;
  ownColumn: "item_a" | "item_b";
  targetColumn: "item_a" | "item_b";
  targetDatabaseId: string;
}

/** `undefined` for anything but a relation property with a registered definition, side and target database. */
function relationHop(property: FilterProperty | undefined): RelationHop | undefined {
  if (
    property?.type !== "relation" ||
    !property.relationDefinitionId ||
    !property.relationSide ||
    !property.targetDatabaseId
  ) {
    return undefined;
  }
  return {
    definitionId: property.relationDefinitionId,
    ownColumn: property.relationSide === "a" ? "item_a" : "item_b",
    targetColumn: property.relationSide === "a" ? "item_b" : "item_a",
    targetDatabaseId: property.targetDatabaseId,
  };
}

function assertHopNotClosed(key: string, hop: RelationHop, closedDatabaseIds: ReadonlySet<string> | undefined): void {
  if (closedDatabaseIds?.has(hop.targetDatabaseId)) throw closedDatabaseRefusal(key, hop.targetDatabaseId);
}

/**
 * Counts the live items a relation or two-relation path reaches (the middle item must be live too), most frequent
 * first, ties by id; `everyTarget` returns every live item of the reached database, also with count 0. `color` is
 * the area color for a Projects item, otherwise the item's own `color`. Only the fixed `item_a`/`item_b` column
 * names are interpolated; every id is a bound parameter.
 */
async function countRelationTargets(
  client: PoolClient,
  scope: FacetScope,
  hops: [RelationHop] | [RelationHop, RelationHop],
  everyTarget: boolean,
): Promise<CountedValues> {
  const statement = startStatement(scope);
  const { bind } = statement;
  const [first, second] = hops;
  const liveDatabase = (alias: string, databaseParam: string): string =>
    `EXISTS (SELECT 1 FROM databases ${alias} WHERE ${alias}.id = ${databaseParam}::uuid AND ${alias}.archived_at IS NULL)`;
  const firstDatabase = bind(first.targetDatabaseId);
  const firstDefinition = bind(first.definitionId);
  let reachedDatabase = firstDatabase;
  let source = `SELECT reached.id AS value
       FROM item_relations edge
       JOIN items reached
         ON reached.database_id = ${firstDatabase}::uuid AND reached.id = edge.${first.targetColumn}
        AND reached.deleted_at IS NULL
       WHERE edge.relation_definition_id = ${firstDefinition}::uuid AND edge.${first.ownColumn} = matched.id
         AND ${liveDatabase("reached_database", firstDatabase)}`;
  if (second) {
    reachedDatabase = bind(second.targetDatabaseId);
    source = `SELECT reached.id AS value
       FROM item_relations first_edge
       JOIN items between_item
         ON between_item.database_id = ${firstDatabase}::uuid AND between_item.id = first_edge.${first.targetColumn}
        AND between_item.deleted_at IS NULL
       JOIN item_relations second_edge
         ON second_edge.relation_definition_id = ${bind(second.definitionId)}::uuid
        AND second_edge.${second.ownColumn} = between_item.id
       JOIN items reached
         ON reached.database_id = ${reachedDatabase}::uuid AND reached.id = second_edge.${second.targetColumn}
        AND reached.deleted_at IS NULL
       WHERE first_edge.relation_definition_id = ${firstDefinition}::uuid
         AND first_edge.${first.ownColumn} = matched.id
         AND ${liveDatabase("between_database", firstDatabase)}
         AND ${liveDatabase("reached_database", reachedDatabase)}`;
  }
  const candidates = everyTarget
    ? `SELECT every_item.id, COALESCE(counted.item_count, 0) AS item_count,
              COALESCE(counted.open_count, 0) AS open_count
       FROM items every_item
       LEFT JOIN counted ON NOT counted.is_total AND counted.facet_value = every_item.id
       WHERE every_item.database_id = ${reachedDatabase}::uuid AND every_item.deleted_at IS NULL
         AND ${liveDatabase("every_database", reachedDatabase)}`
    : `SELECT counted.facet_value AS id, counted.item_count, counted.open_count
       FROM counted WHERE NOT counted.is_total AND counted.facet_value IS NOT NULL`;
  const limit = everyTarget ? "" : `WHERE ranked.ordinal <= ${bind(FACET_TOP_VALUES)}::int`;
  const { rows } = await client.query<CountedValueRow>(
    `${countedValuesSql(statement, "NULL::jsonb", source)}, candidates AS (${candidates}), ranked AS (
       SELECT candidates.*, ROW_NUMBER() OVER (ORDER BY candidates.item_count DESC, candidates.id) AS ordinal
       FROM candidates
     )
     SELECT 'value'::text AS kind, ranked.ordinal, listed.id::text AS value, ranked.item_count::text AS count,
            ranked.open_count::text AS open,
            listed.properties ->> (
              SELECT title.key FROM properties title
              WHERE title.database_id = ${reachedDatabase}::uuid AND title.type = 'title'
              ORDER BY title.key LIMIT 1
            ) AS label,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM databases projects
                WHERE projects.id = ${reachedDatabase}::uuid AND projects.system
                  AND projects.key = ${bind(PROJECTS_MODULE_ID)}
              ) THEN (
                SELECT area.properties ->> 'color'
                FROM properties area_property
                JOIN relation_definitions area_definition
                  ON area_property.id IN (area_definition.property_id_a, area_definition.property_id_b)
                JOIN item_relations area_edge ON area_edge.relation_definition_id = area_definition.id
                JOIN items area
                  ON area.database_id = (area_property.config ->> 'targetDatabaseId')::uuid
                 AND area.deleted_at IS NULL
                 AND area.id = CASE WHEN area_definition.property_id_a = area_property.id
                                    THEN area_edge.item_b ELSE area_edge.item_a END
                JOIN databases area_database
                  ON area_database.id = area.database_id AND area_database.archived_at IS NULL
                WHERE area_property.database_id = ${reachedDatabase}::uuid
                  AND area_property.key = 'area' AND area_property.type = 'relation'
                  AND listed.id = CASE WHEN area_definition.property_id_a = area_property.id
                                       THEN area_edge.item_a ELSE area_edge.item_b END
                ORDER BY area.id LIMIT 1
              )
              WHEN EXISTS (
                SELECT 1 FROM properties own_color
                WHERE own_color.database_id = ${reachedDatabase}::uuid AND own_color.key = 'color'
              ) THEN listed.properties ->> 'color'
            END AS color
     FROM ranked
     JOIN items listed ON listed.database_id = ${reachedDatabase}::uuid AND listed.id = ranked.id
     ${limit}
     UNION ALL
     SELECT CASE WHEN counted.is_total THEN 'total' ELSE 'none' END, 0, NULL,
            counted.item_count::text, counted.open_count::text, NULL, NULL
     FROM counted WHERE counted.is_total OR counted.facet_value IS NULL
     ORDER BY ordinal`,
    statement.params,
  );
  return readCountedValues(rows);
}

interface MatchCounts {
  all: number;
  open: number;
  at(index: number): number;
}

/** One statement: every item is paired with one probe per condition; a probe no item matches counts 0. */
async function countMatches(client: PoolClient, scope: FacetScope, conditions: FilterNode[]): Promise<MatchCounts> {
  const statement = startStatement(scope);
  const probes = [
    `(${statement.bind("all")}::text, true)`,
    `(${statement.bind("open")}::text, ${statement.openSql})`,
    ...conditions.map((condition, index) => {
      const matches = compileFilterNode(
        condition,
        scope.filterProperties,
        statement.params,
        scope.context,
        scope.closedDatabaseIds,
      );
      return `(${statement.bind(String(index))}::text, ${matches})`;
    }),
  ];
  const { rows } = await client.query<{ name: string; count: string }>(
    `SELECT probe.name, count(*)::text AS count
     FROM items CROSS JOIN LATERAL (VALUES ${probes.join(", ")}) AS probe(name, matches)
     WHERE ${statement.where} AND probe.matches
     GROUP BY probe.name`,
    statement.params,
  );
  const byName = new Map(rows.map((row) => [row.name, Number(row.count)]));
  const count = (name: string): number => byName.get(name) ?? 0;
  return { all: count("all"), open: count("open"), at: (index) => count(String(index)) };
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** An item without a title gets the empty label; a stored color that is not `#RRGGBB` is dropped. */
function relationValues(counted: CountedValues): DatabaseFacetValue[] {
  return [
    ...counted.values.map((entry) => ({
      value: entry.value,
      label: entry.label ?? "",
      ...(entry.color !== null && COLOR_PATTERN.test(entry.color) ? { color: entry.color } : {}),
      count: entry.count,
    })),
    { value: null, count: counted.none },
  ];
}

/** Options in `config.options` order, then other stored values in byte order unlabelled, then the items without a value. */
function optionValues(resolved: ResolvedProperty, counted: CountedValues, everyOption: boolean): DatabaseFacetValue[] {
  const options = resolved.options ?? [];
  const optionKeys = new Set(options.map((option) => option.key));
  const counts = new Map(counted.values.map((entry) => [entry.value, entry.count]));
  return [
    ...options
      .filter((option) => everyOption || counts.has(option.key))
      .map((option) => ({
        value: option.key,
        label: option.label,
        ...(option.color === undefined ? {} : { color: option.color }),
        count: counts.get(option.key) ?? 0,
      })),
    ...counted.values
      .filter((entry) => !optionKeys.has(entry.value))
      .map((entry) => ({ value: entry.value, count: entry.count })),
    { value: null, count: counted.none },
  ];
}

function emptyNumberCondition(propertyKey: string, matchZero: boolean): FilterNode {
  const empty: FilterNode = { type: "is_empty", property: propertyKey };
  if (!matchZero) return empty;
  const zero: FilterNode = {
    type: "and",
    nodes: [
      { type: "lte", property: propertyKey, value: 0 },
      { type: "gte", property: propertyKey, value: 0 },
    ],
  };
  return { type: "or", nodes: [empty, zero] };
}

/**
 * Computes the requested facets in the caller's transaction, one statement per facet, each counted under the
 * caller's filter minus its own conditions. Selects list held options (every option for `GROUP_SELECT_KEYS`), text
 * the top 20 values, checkbox `true`/`false` (false includes no value), date the matching relative presets, number
 * its stored presets, and a relation or path the top 20 reached items, or every reached item when the module's
 * declared area filter goes through it. Unresolvable keys are refused on `facets`.
 */
export async function computeDatabaseFacets(
  client: PoolClient,
  database: DatabaseRow,
  input: Omit<DatabaseFacetsInput, "databaseId">,
  metadata: FacetMetadata,
  options: DatabaseFacetsOptions = {},
  closedDatabaseIds?: ReadonlySet<string>,
): Promise<DatabaseFacet[]> {
  const properties = await listPropertiesByDatabase(client, database.id);
  const filterProperties = await buildFilterProperties(client, properties);
  const filter = input.filter === undefined ? undefined : parseFilterNode(input.filter);
  let open: FilterNode | undefined;
  if (input.extra !== undefined) {
    const parsed = filterNodeSchema.safeParse(input.extra.open);
    if (!parsed.success) throw new ValidationError("Invalid 'extra.open' filter tree", { field: "extra.open" });
    open = parsed.data;
  }

  const requested = input.facets.map((request): RequestedFacet => {
    if (typeof request !== "string") return { kind: "path", path: request.path };
    const property = properties.find((candidate) => candidate.key === request);
    if (!property) throw new ValidationError("A facet names no property of the database", { field: "facets" });
    return { kind: "property", key: request, property };
  });

  // The tenant zone is read once, and only when a filter or date facet needs the clock.
  const clocked: FilterNode[] = [filter, open].filter((node) => node !== undefined);
  for (const facet of requested) {
    if (facet.kind === "property" && facet.property.type === "date") {
      clocked.push({ type: "date_relative", property: facet.key, preset: "today" });
    }
  }
  const context =
    clocked.length > 0
      ? await resolveFilterCompileContext(client, { type: "and", nodes: clocked }, options.now)
      : undefined;

  const catalogs = await metadata.catalogResolver.getCatalogsForDbKey(database.key);
  const locale = toManifestLocale(options.locale ?? "en");
  const areaFilter = database.system && database.key !== null ? metadata.areaFilters.get(database.key) : undefined;

  const facets: DatabaseFacet[] = [];
  for (const facet of requested) {
    const scope: FacetScope = {
      databaseId: database.id,
      filterProperties,
      context,
      filter: filter === undefined ? undefined : excludeFacetConditions(filter, facet),
      open,
      closedDatabaseIds,
    };
    const answer = (counts: { all: number; open: number }, values: DatabaseFacetValue[]): DatabaseFacet => ({
      ...(facet.kind === "property" ? { property: facet.key } : { path: facet.path }),
      all: counts.all,
      ...(open === undefined ? {} : { open: counts.open }),
      values,
    });
    const everyArea = areaFilter !== undefined && areaFilterNames(areaFilter, facet);

    if (facet.kind === "path") {
      const first = relationHop(filterProperties.get(facet.path[0]));
      // Either hop can reach a closed database; the first is checked before the second's properties are read.
      if (first) assertHopNotClosed(facet.path[0], first, closedDatabaseIds);
      const second = first
        ? relationHop(
            (await buildFilterProperties(client, await listPropertiesByDatabase(client, first.targetDatabaseId))).get(
              facet.path[1],
            ),
          )
        : undefined;
      if (!first || !second) {
        throw new ValidationError("A path facet requires a resolvable two-relation path", { field: "facets" });
      }
      assertHopNotClosed(facet.path[1], second, closedDatabaseIds);
      const counted = await countRelationTargets(client, scope, [first, second], everyArea);
      facets.push(answer(counted, relationValues(counted)));
      continue;
    }

    const { property } = facet;
    switch (property.type) {
      case "select":
      case "multi_select": {
        const multiple = property.type === "multi_select";
        const counted = await countStoredValues(client, scope, property.key, { multiple });
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        facets.push(answer(counted, optionValues(resolved, counted, !multiple && GROUP_SELECT_KEYS.has(property.key))));
        break;
      }
      case "text": {
        const counted = await countStoredValues(client, scope, property.key, {
          multiple: false,
          top: FACET_TOP_VALUES,
        });
        facets.push(
          answer(
            counted,
            counted.values.map((entry) => ({ value: entry.value, count: entry.count })),
          ),
        );
        break;
      }
      case "relation": {
        const hop = relationHop(filterProperties.get(property.key));
        if (!hop) {
          throw new ValidationError("A relation facet requires a resolvable relation definition", {
            field: "facets",
          });
        }
        assertHopNotClosed(property.key, hop, closedDatabaseIds);
        const counted = await countRelationTargets(client, scope, [hop], everyArea);
        facets.push(answer(counted, relationValues(counted)));
        break;
      }
      case "checkbox": {
        const counted = await countMatches(client, scope, [{ type: "equals", property: property.key, value: true }]);
        const checked = counted.at(0);
        facets.push(
          answer(counted, [
            { value: true, count: checked },
            { value: false, count: counted.all - checked },
          ]),
        );
        break;
      }
      case "date": {
        const counted = await countMatches(client, scope, [
          ...DATE_RELATIVE_PRESETS.map((preset): FilterNode => ({
            type: "date_relative",
            property: property.key,
            preset,
          })),
          { type: "is_empty", property: property.key },
        ]);
        const values: DatabaseFacetValue[] = DATE_RELATIVE_PRESETS.map((preset, index) => ({
          value: preset,
          count: counted.at(index),
        }));
        values.push({ value: null, count: counted.at(DATE_RELATIVE_PRESETS.length) });
        facets.push(
          answer(
            counted,
            values.filter((entry) => entry.count > 0),
          ),
        );
        break;
      }
      case "number": {
        const { filterPresets = [], emptyPreset } = resolveProperty(property, database.key, catalogs, locale).config;
        const conditions = filterPresets.map((preset): FilterNode => ({
          type: preset.op,
          property: property.key,
          value: preset.value,
        }));
        if (emptyPreset) conditions.push(emptyNumberCondition(property.key, emptyPreset.matchZero));
        const counted = await countMatches(client, scope, conditions);
        const values: DatabaseFacetValue[] = filterPresets.map((preset, index) => ({
          value: preset.value,
          label: preset.label,
          count: counted.at(index),
        }));
        if (emptyPreset) {
          values.push({ value: null, label: emptyPreset.label, count: counted.at(filterPresets.length) });
        }
        facets.push(answer(counted, values));
        break;
      }
      default:
        throw new ValidationError(`A '${property.type}' property cannot be a facet`, { field: "facets" });
    }
  }
  return facets;
}
