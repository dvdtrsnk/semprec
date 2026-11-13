// The facets of one database (issue #1759): for each requested property, or relation path, its choices with
// the number of items that hold each one. It owns the exclude-self rewrite of the caller's filter and the one
// counting statement per facet. It does not own the filter grammar (filterTree.ts), the compilation of a
// filter to SQL (filterCompiler.ts) or the transaction it runs in (chokePoint/itemReads.ts).
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

/** A requested facet: the key of a property of the database, or a relation of it and then a relation of the items that one reaches. */
export type FacetRequest = string | { path: [string, string] };

export interface DatabaseFacetsInput {
  databaseId: string;
  /** A filter tree (filterTree.ts), validated here. */
  filter?: unknown;
  facets: FacetRequest[];
  /** `open` is a second filter tree, validated here; each facet then also reports how many of its items match it. */
  extra?: { open: unknown };
}

export interface DatabaseFacetsOptions {
  /** The caller's `users.locale`. A label that is not stored is read from the catalog of this language; English without one. */
  locale?: string;
  /** The clock relative dates are evaluated at; defaults to the current time. */
  now?: Date;
  /**
   * The Projects item of an agent's run (issue #2000): a filter, a relation facet or a path facet that reaches a
   * sensitive database this project may not read, through a relation property or a rollup, is refused with a
   * `ForbiddenError`. Set by the application layer from the run credential, never read from a request. This does not
   * decide the access to the faceted database itself.
   */
  agentProjectItemId?: string;
}

/** One choice of a facet. `null` is the choice of the items without a value. */
export interface DatabaseFacetValue {
  value: string | number | boolean | null;
  label?: string;
  color?: string;
  count: number;
}

/** The answer to one requested facet; `open` is present exactly when the call carried `extra.open`. */
export type DatabaseFacet = ({ property: string } | { path: [string, string] }) & {
  all: number;
  open?: number;
  values: DatabaseFacetValue[];
};

/** What the facets read from the module manifests. */
export interface FacetMetadata {
  catalogResolver: CatalogResolver;
  /** The declared area filter of each system database that has one, by database key (issue #1597). */
  areaFilters: ReadonlyMap<string, AreaFilterTemplate>;
}

let facetMetadataPromise: Promise<FacetMetadata> | undefined;

/**
 * The catalogs and the declared area filters the facets read, built once per process from a module registry
 * that `loadFullModuleRegistry` builds: the choke point is constructed from a pool alone and has no registry of
 * a composition root. A failed load is not cached, so the next call retries.
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

/** Most choices a text facet lists, and most related items a relation or path facet lists. */
const FACET_TOP_VALUES = 20;

/**
 * The keys of the status-like select properties (issue #1759 calls them group selects). A facet of a select
 * property with one of these keys lists every option, also one that no item holds.
 */
const GROUP_SELECT_KEYS: ReadonlySet<string> = new Set(["status", "type", "relationship"]);

/** What a facet is counted over: one property of the database, or the items reached through two relations. */
export type FacetTarget = { kind: "property"; key: string } | { kind: "path"; path: [string, string] };

/** A `relation_path_contains` condition is on a path facet with the same two keys; any other condition is on the property facet of its `property`. */
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
 * The filter a facet is counted under: `filter` without the conditions on the facet itself. A condition is left
 * out when it is the root or is reached from the root through `and` nodes alone, which includes every direct
 * child of a top-level `and`; an `and` that loses all its children is left out with them, and `undefined` means
 * that nothing remains. A condition on the facet inside an `or` or a `not` cannot be left out without changing
 * what the rest of that node matches, so it is refused on `filter`.
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

/** Whether the declared area filter takes the area through this property or path. */
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

/** A requested facet with the property a property facet names. */
type RequestedFacet =
  { kind: "path"; path: [string, string] } | { kind: "property"; key: string; property: PropertyRow };

/** What every facet of one call shares, and the filter of the one facet being counted. */
interface FacetScope {
  databaseId: string;
  filterProperties: FilterProperties;
  context: FilterCompileContext | undefined;
  /** The caller's filter without its conditions on the facet itself. */
  filter: FilterNode | undefined;
  /** The `extra.open` filter. */
  open: FilterNode | undefined;
  /** The sensitive databases the agent's project may not read (issue #2000); `undefined` for a person. */
  closedDatabaseIds: ReadonlySet<string> | undefined;
}

interface FacetStatement {
  params: unknown[];
  /** Binds one more parameter and returns its placeholder. */
  bind: (value: unknown) => string;
  /** Matches the live items of the database under the scope's filter, and no item of an archived database. */
  where: string;
  /** Whether an item matches `extra.open`; `false` when the call has none. */
  openSql: string;
}

/**
 * Starts the one statement of a facet. The items table is read under its own name, because a compiled filter
 * refers to `items.id` and to the bare `properties` and `computed` columns.
 */
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

/** The counts of a facet whose choices are values: stored ones or related items. */
interface CountedValues {
  all: number;
  open: number;
  /** The items without a value. */
  none: number;
  /** The values in the order the statement returned them. */
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
 * The common table expressions of a value facet. `matched` holds the counted items with `storedSql` as `stored`,
 * `source` is a subquery over one `matched` row that returns its values as `value`, and `counted` has one row per
 * value, one row with a NULL value for the items without one, and the total row, which the empty grouping set
 * yields whatever the input. An item with several values is counted in each of them and once in the total.
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
 * Counts the stored values of one property in one statement. A `multiple` property stores a JSON array and an
 * item counts in each distinct non-empty text of it; anything else stores one value. A missing value, JSON null
 * and the empty string are no value, and so is, for a `multiple` property, an array without a non-empty text and
 * a value that is not an array. With `top` only the `top` most frequent values are returned, the most frequent
 * first and equal counts in byte order; without it every value, in byte order.
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

/** One relation step: the definition, the sides of its edges and the database of the items it reaches. */
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

/** Refuses a facet over a relation into a sensitive database the agent's project may not read (issue #2000). */
function assertHopNotClosed(key: string, hop: RelationHop, closedDatabaseIds: ReadonlySet<string> | undefined): void {
  if (closedDatabaseIds?.has(hop.targetDatabaseId)) throw closedDatabaseRefusal(key, hop.targetDatabaseId);
}

/**
 * Counts the items a relation, or a path of two relations, reaches, in one statement. A reached item counts
 * while it is not soft-deleted and its database is not archived, and on a path the same holds for the item in
 * between; an item of the faceted database whose every edge ends elsewhere has no value.
 *
 * With `everyTarget` every live item of the reached database is returned, also one with count 0; without it the
 * `FACET_TOP_VALUES` most frequent ones. Either way the most frequent comes first and equal counts are ordered
 * by id. `label` is the reached item's value of the title property of its database. `color` is, for an item of
 * the Projects system database, the `color` of the live area its `area` relation points at, and for an item of
 * any other database that has a `color` property its own value of it.
 *
 * Only the `item_a`/`item_b` column names of the hops are interpolated, and `relationHop` picks them from those
 * two fixed identifiers by the side of the registered definition. Every id is a bound parameter; the `title`
 * type and the `area` and `color` keys are constants of the statement.
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
  /** How many of the facet's items match the condition at `index`. */
  at(index: number): number;
}

/**
 * How many of the facet's items match each of `conditions`, in one statement: every item is paired with one
 * probe per condition, and the probes that hold are counted by name. A probe no item matches has no row and
 * counts 0.
 */
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

/**
 * The related items as facet choices, then the items that reach none. An item without a title is labelled with
 * the empty string, and a stored color that is not `#RRGGBB` is left out.
 */
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

/**
 * The choices of a select or multi-select property: its options in `config.options` order with their label and
 * color (every option when `everyOption`, otherwise the ones an item holds), then any other stored value in byte
 * order without a label, then the items without a value.
 */
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

/** The filter an empty number preset stands for: no value, and with `matchZero` also the number 0. */
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
 * Computes the requested facets of `database` in the caller's transaction, in request order, one counting
 * statement per facet. Every facet is counted over the live items of the database under the caller's filter
 * without its conditions on the facet itself (`excludeFacetConditions`); `all` is their number and `open` the
 * number of those that also match `extra.open`. An archived database has no such item, so every count is 0.
 *
 * What a facet lists depends on the property:
 * - a select: the options an item holds, or every option for a status-like key (`GROUP_SELECT_KEYS`), then the
 *   items without a value; a multi-select: the options an item holds, then the items without a value;
 * - a text: the 20 most frequent values;
 * - a checkbox: `true`, then `false`, which also holds the items without a value;
 * - a date: each named relative-date preset that an item matches, then `null` when an item has no date;
 * - a number: each valid stored filter preset with its label, counted by the preset's comparison, then the
 *   stored empty preset as `null`;
 * - a relation or a path: the 20 related items most items reach, then the items that reach none. When the
 *   area filter the database's module manifest declares (issue #1597) takes the area through that relation or
 *   path, every item of the reached database is listed instead, also one no item reaches.
 *
 * An unknown key, a property of another type and a relation or path that cannot be resolved are refused on
 * `facets`.
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

  // One read of the tenant zone for the whole call, and only when a filter or a date facet needs the clock.
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
      // Either hop can reach a closed database: it would list its records (issue #2000). The first is checked before
      // the properties of its database are read for the second.
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
