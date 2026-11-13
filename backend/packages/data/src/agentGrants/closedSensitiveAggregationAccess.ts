import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import { listRollupSourcesByDatabases } from "../rollup/rollupSources.js";
import { closedDatabaseRefusal } from "../views/closedDatabaseRefusal.js";
import type { SortSpec } from "../views/sortSpec.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { listClosedSensitiveDatabaseIds, readerOfWriter, type DatabaseReader } from "./agentDatabaseAccess.js";

// What an agent may learn about a sensitive database it cannot read, through a database it can (issue #2000): a
// relation property into it or a rollup that aggregates it answers "which records link to X" or "how many records"
// without returning one. The filter compiler refuses the conditions (`views/filterCompiler.ts`), this module refuses
// the sorts and hides the rollup values. All of it is decided for the agent's project only; a person and an external
// client are passed as no closed set and are not touched.

/** The value an agent reads in place of a rollup that aggregates a database it may not read. */
export interface HiddenRollupValue {
  value: null;
  hidden: true;
}

/**
 * The sensitive databases the reader may not read when it is an agent's project, `undefined` for a person and for an
 * external client, which these checks leave alone. Read in the caller's transaction.
 */
export async function closedSensitiveDatabasesOf(
  client: PoolClient,
  reader: DatabaseReader | undefined,
): Promise<ReadonlySet<string> | undefined> {
  return typeof reader === "string" ? listClosedSensitiveDatabaseIds(client, reader) : undefined;
}

/**
 * Refuses a sort by a rollup property of `databaseId` whose source database is in `closed`, with the `ForbiddenError`
 * a filter on it gets. A sort by any other property or by a system timestamp is not looked at, and a missing or empty
 * `closed` set returns without a query.
 */
export async function assertNoSortOverClosedRollup(
  client: PoolClient,
  databaseId: string,
  sortSpecs: readonly SortSpec[],
  closed: ReadonlySet<string> | undefined,
): Promise<void> {
  if (closed === undefined || closed.size === 0 || sortSpecs.length === 0) return;
  const sources = new Map(
    (await listRollupSourcesByDatabases(client, [databaseId])).map((row) => [row.propertyKey, row.sourceDatabaseId]),
  );
  for (const sort of sortSpecs) {
    if (sort.property === undefined) continue; // a system timestamp
    const source = sources.get(sort.property);
    if (source !== undefined && closed.has(source)) throw closedDatabaseRefusal(sort.property, source);
  }
}

/**
 * The items with every rollup whose source database is in `closed` read as `{ value: null, hidden: true }` in
 * `computed`, whether or not the item has a computed value for it, so a missing value says nothing either. The other
 * rollups, the other fields and the item order are unchanged. One query for the page's databases; a missing or empty
 * `closed` set returns the items as they are without one.
 */
export async function hideClosedRollupValues<T extends ItemRow>(
  client: PoolClient,
  items: T[],
  closed: ReadonlySet<string> | undefined,
): Promise<T[]> {
  if (closed === undefined || closed.size === 0 || items.length === 0) return items;
  const hiddenKeysByDatabase = new Map<string, string[]>();
  for (const row of await listRollupSourcesByDatabases(client, [...new Set(items.map((item) => item.databaseId))])) {
    if (!closed.has(row.sourceDatabaseId)) continue;
    hiddenKeysByDatabase.set(row.databaseId, [...(hiddenKeysByDatabase.get(row.databaseId) ?? []), row.propertyKey]);
  }
  if (hiddenKeysByDatabase.size === 0) return items;
  return items.map((item) => {
    const keys = hiddenKeysByDatabase.get(item.databaseId);
    if (keys === undefined) return item;
    const hidden = keys.map((key): [string, HiddenRollupValue] => [key, { value: null, hidden: true }]);
    return { ...item, computed: { ...item.computed, ...Object.fromEntries(hidden) } };
  });
}

/**
 * `hideClosedRollupValues` for the item a write returns to its writer: an agent's write response carries the item's
 * computed values like a read does, so a rollup over a database its project may not read is hidden there too. A
 * person, the system and an external client are returned the item as it is, without a query.
 */
export async function hideClosedRollupValuesForWriter<T extends ItemRow>(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  items: T[],
): Promise<T[]> {
  return hideClosedRollupValues(client, items, await closedSensitiveDatabasesOf(client, readerOfWriter(writer)));
}
