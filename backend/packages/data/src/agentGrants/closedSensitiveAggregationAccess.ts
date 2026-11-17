import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import { listRollupSourcesByDatabases } from "../rollup/rollupSources.js";
import { closedDatabaseRefusal } from "../views/closedDatabaseRefusal.js";
import type { SortSpec } from "../views/sortSpec.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { listClosedSensitiveDatabaseIds, readerOfWriter, type DatabaseReader } from "./agentDatabaseAccess.js";

// A relation or rollup into a sensitive database the agent cannot read would answer "which/how many records link
// to X" without returning one. The filter compiler refuses such conditions (`views/filterCompiler.ts`); this module
// refuses the sorts and hides the rollup values. Applies to an agent's project only.

export interface HiddenRollupValue {
  value: null;
  hidden: true;
}

/** Closed sensitive databases for an agent's project; `undefined` for a person or external client. */
export async function closedSensitiveDatabasesOf(
  client: PoolClient,
  reader: DatabaseReader | undefined,
): Promise<ReadonlySet<string> | undefined> {
  return typeof reader === "string" ? listClosedSensitiveDatabaseIds(client, reader) : undefined;
}

/** Refuses a sort by a rollup whose source database is closed, with the same error a filter on it gets. */
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
 * Every rollup whose source database is closed reads as `{ value: null, hidden: true }`, whether or not a value
 * exists, so absence says nothing either. Everything else is unchanged.
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

/** The same for an agent's write response, which carries computed values like a read. */
export async function hideClosedRollupValuesForWriter<T extends ItemRow>(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  items: T[],
): Promise<T[]> {
  return hideClosedRollupValues(client, items, await closedSensitiveDatabasesOf(client, readerOfWriter(writer)));
}
