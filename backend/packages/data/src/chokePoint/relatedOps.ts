// Owns the choke point's read of the collections related to one record (issue #1839, `relation.related`): for
// each database, how many live records are connected to the record, and the filter that selects them. It writes
// nothing and knows nothing about which transport asked.
// Constrained by:
// - docs/adr/2026-09-17-generic-application-service-port.md
// - docs/adr/2026-11-12-per-database-agent-grants.md
// - docs/adr/2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases.md
import type { PoolClient } from "pg";
import {
  assertReaderDatabaseAccess,
  listUnreadableDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { compareCollections, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { AREAS_MODULE_ID, COMPANIES_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import { compileFilterNode } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import type { FilterNode } from "../views/filterTree.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import { relatedRowContributorsFor, type RelatedCollectionRow } from "./relatedContributors.js";
import {
  areaRoutes,
  areaThreadsRoute,
  companyRoutes,
  projectRoutes,
  type RelatedRoute,
  type RelatedRoutes,
} from "./relatedRoutes.js";

/** What the read needs of the manifests; a resolver that declares no related order or area filter declares none. */
export type RelatedResolver = Pick<CollectionMetadataResolver, "resolve" | "relatedOrder" | "areaFilter">;

/** The records of one database that the viewed record is directly connected to, and the properties that connect them. */
interface DirectCollectionRow {
  database_id: string;
  count: number;
  property_keys: string[];
}

/**
 * The records connected to the viewed record through every relation property that points at its database, counted
 * once per database whichever property reaches them. A relation property belongs to the database that holds it
 * and points at the database on the other side: side A of a definition reads `item_b` from `item_a`, side B the
 * reverse. A property that points at the viewed record's database therefore sits on the connected records, and a
 * one-directional relation, which has side A only, is found from its target side as well. A relation the viewed
 * record's database holds with no property on the other side cannot be selected by a filter of that other
 * database, so it gives no row. A record counts while it is not in the Trash; the caller leaves out the databases
 * that are archived.
 */
const DIRECT_COLLECTIONS_SQL = `
  WITH pointing AS (
    SELECT p.database_id, p.key, rd.id AS definition_id, (rd.property_id_a = p.id) AS is_side_a
    FROM properties p
    JOIN relation_definitions rd ON rd.property_id_a = p.id OR rd.property_id_b = p.id
    WHERE p.type = 'relation' AND p.config ->> 'targetDatabaseId' = $1::text
  ),
  hits AS (
    SELECT pointing.database_id, pointing.key, edge.item_a AS item_id
    FROM pointing
    JOIN item_relations edge ON edge.relation_definition_id = pointing.definition_id AND edge.item_b = $2::uuid
    WHERE pointing.is_side_a
    UNION ALL
    SELECT pointing.database_id, pointing.key, edge.item_b AS item_id
    FROM pointing
    JOIN item_relations edge ON edge.relation_definition_id = pointing.definition_id AND edge.item_a = $2::uuid
    WHERE NOT pointing.is_side_a
  )
  SELECT hits.database_id::text AS database_id,
         count(DISTINCT hits.item_id)::int AS count,
         array_agg(DISTINCT hits.key ORDER BY hits.key) AS property_keys
  FROM hits
  JOIN items live ON live.database_id = hits.database_id AND live.id = hits.item_id AND live.deleted_at IS NULL
  GROUP BY hits.database_id`;

/** The filter that selects the records of a database connected to the viewed record through `propertyKeys`. */
function directFilter(propertyKeys: readonly string[], itemId: string): FilterNode {
  const nodes: FilterNode[] = propertyKeys.map((property) => ({ type: "relation_contains", property, value: itemId }));
  return nodes.length === 1 ? nodes[0]! : { type: "or", nodes };
}

/** The number of live records of the database that `filter` selects, counted by the statement `item.count` runs. */
async function countSelected(client: PoolClient, databaseId: string, filter: FilterNode): Promise<number> {
  const properties = await buildFilterProperties(
    client,
    await propertiesStore.listPropertiesByDatabase(client, databaseId),
  );
  const { count } = await itemsStore.countItemsGrouped(client, databaseId, {
    buildFilterSql: (params) => compileFilterNode(filter, properties, params),
  });
  return count;
}

/** The routes of the viewed record that replace the directly connected records of a database, by database key. */
function routesOf(
  viewed: DatabaseRow,
  itemId: string,
  databases: readonly DatabaseRow[],
  resolver: RelatedResolver,
): RelatedRoutes {
  if (viewed.key === COMPANIES_MODULE_ID) return companyRoutes(itemId);
  if (viewed.key === PROJECTS_MODULE_ID) return projectRoutes(itemId);
  if (viewed.key !== AREAS_MODULE_ID) return new Map();

  const declarations = databases.flatMap((database) => {
    const template = resolver.areaFilter?.(database);
    return database.key !== null && template !== undefined ? [{ databaseKey: database.key, template }] : [];
  });
  const routes = areaRoutes(itemId, declarations);
  if (databases.some((database) => database.key === THREADS_MODULE_ID) && !routes.has(THREADS_MODULE_ID)) {
    routes.set(THREADS_MODULE_ID, areaThreadsRoute(itemId));
  }
  return routes;
}

/**
 * Whether a collection may be listed: a user-created database, a client-visible system database and the Threads
 * database. Every other system database is internal. The mail module does not make Threads client-visible, but the
 * related orders of the manifests list it and this operation gives it a row of its own.
 */
function isListable(database: DatabaseRow, resolver: RelatedResolver): boolean {
  return database.key === THREADS_MODULE_ID || resolver.resolve(database).clientVisible;
}

/**
 * Orders two rows: the databases the declared `order` lists, in that order, then the other system databases by
 * display order, then user-created databases by name.
 */
function compareRows(
  a: { database: DatabaseRow },
  b: { database: DatabaseRow },
  order: readonly string[],
  resolver: RelatedResolver,
): number {
  const rank = (database: DatabaseRow): number => {
    const listed = database.key === null ? -1 : order.indexOf(database.key);
    if (listed >= 0) return listed;
    return database.system ? order.length : order.length + 1;
  };
  const rankDifference = rank(a.database) - rank(b.database);
  if (rankDifference !== 0) return rankDifference;
  const orderable = (database: DatabaseRow) => {
    const { switcherOrder, overviewOrder } = resolver.resolve(database);
    return { id: database.id, name: database.name ?? database.key ?? database.id, switcherOrder, overviewOrder };
  };
  return compareCollections(orderable(a.database), orderable(b.database));
}

/**
 * The collections related to `itemId`, ordered as the viewed record's database declares (issue #1517): the
 * declared `order` first, then the other client-visible system databases by display order, then user-created
 * databases by name, and never a database the declaration omits. A collection is left out when it is empty,
 * archived or internal (a system database that is not client-visible, other than Threads), and, for a `reader` (an
 * agent's project, issue #1810, or an external client on `/mcp`, issue #1998), when the reader may not read the
 * database. The reader also needs `read` access to the database of the viewed record (and, for an agent, to the
 * sensitive databases the record is linked to when its own database inherits sensitivity, issue #1999), else the
 * read is refused as `forbidden`.
 *
 * A database that has a route (`relatedRoutes.ts`) is counted by the route's filter, and the other databases by the
 * records connected to the viewed record. The `count` of a row built here is the number of records its `filter`
 * selects; the Threads database has no filter, a client opens it by the viewed record's id. Rows the contributors
 * registered for the viewed record's database (`relatedContributors.ts`) replace the row of their database.
 *
 * Returns `null` when the item does not exist, is in the Trash, or belongs to another tenant; the three answer alike.
 */
export async function listRelatedWithClient(
  client: PoolClient,
  itemId: string,
  resolver: RelatedResolver,
  reader?: DatabaseReader,
): Promise<RelatedCollectionRow[] | null> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) return null;
  if (reader !== undefined) {
    await assertReaderDatabaseAccess(client, reader, item.databaseId, "read", undefined, item.id);
  }
  const viewed = await databasesStore.getDatabase(client, item.databaseId);
  if (!viewed) throw new Error(`The database ${item.databaseId} of item ${item.id} is missing`);
  const databases = await databasesStore.listAllDatabases(client);
  const databasesById = new Map(databases.map((database) => [database.id, database]));

  const rows = new Map<string, RelatedCollectionRow>();
  const { rows: direct } = await client.query<DirectCollectionRow>(DIRECT_COLLECTIONS_SQL, [viewed.id, item.id]);
  for (const row of direct) {
    const database = databasesById.get(row.database_id);
    if (!database) continue;
    rows.set(database.id, {
      databaseKey: database.key,
      databaseId: database.id,
      count: row.count,
      via: "direct",
      filter: directFilter(row.property_keys, item.id),
    });
  }

  const routes = routesOf(viewed, item.id, databases, resolver);
  for (const [databaseKey, route] of routes) {
    const database = databases.find((candidate) => candidate.key === databaseKey);
    if (!database) continue;
    await applyRoute(client, rows, database, route);
  }

  if (viewed.key !== null) {
    for (const contributor of relatedRowContributorsFor(viewed.key)) {
      const row = await contributor({ client, itemId: item.id, databaseId: viewed.id, databaseKey: viewed.key });
      if (row !== null) rows.set(row.databaseId, row);
    }
  }

  const unreadable = reader !== undefined ? await listUnreadableDatabaseIds(client, reader) : new Set<string>();
  const declaredOrder = resolver.relatedOrder?.(viewed);
  const omitted = new Set(declaredOrder?.omit ?? []);
  const listed = [...rows.values()].flatMap((row) => {
    const database = databasesById.get(row.databaseId);
    if (!database || row.count <= 0 || unreadable.has(database.id)) return [];
    if (database.key !== null && omitted.has(database.key)) return [];
    if (!isListable(database, resolver)) return [];
    return [{ database, row }];
  });
  listed.sort((a, b) => compareRows(a, b, declaredOrder?.order ?? [], resolver));
  return listed.map(({ database, row }) => ({
    ...row,
    filter: database.key === THREADS_MODULE_ID ? null : row.filter,
  }));
}

/** Replaces the directly connected records of `database` with the records `route` selects, dropping the row if none. */
async function applyRoute(
  client: PoolClient,
  rows: Map<string, RelatedCollectionRow>,
  database: DatabaseRow,
  route: RelatedRoute,
): Promise<void> {
  const count = await countSelected(client, database.id, route.filter);
  if (count === 0) {
    rows.delete(database.id);
    return;
  }
  rows.set(database.id, {
    databaseKey: database.key,
    databaseId: database.id,
    count,
    via: route.via,
    filter: route.filter,
  });
}
