// The registry of extra rows a module adds to the related collections of one record type, keyed by
// database key. `listRelatedWithClient` lists the rows returned by the contributors registered for the
// viewed record's database alongside its own.
import type { PoolClient } from "pg";
import type { FilterNode } from "../views/filterTree.js";

/** One related collection of a record: `count` records of the database are connected to it. */
export interface RelatedCollectionRow {
  databaseKey: string | null;
  databaseId: string;
  count: number;
  /** Whether the records connect to the viewed record itself or through one of its projects. */
  via: "direct" | "project";
  /** Selects exactly the counted records in a query of the database; `null` when none can. */
  filter: FilterNode | null;
}

export interface RelatedContributorContext {
  client: PoolClient;
  itemId: string;
  databaseId: string;
  databaseKey: string;
}

/**
 * Returns the extra row for the record, or `null`. It replaces the generic row for the same database
 * and still goes through the exclusion of empty, archived, internal and unreadable collections, the
 * ordering and the agent's grants.
 */
export type RelatedRowContributor = (context: RelatedContributorContext) => Promise<RelatedCollectionRow | null>;

const contributorsByDatabaseKey = new Map<string, RelatedRowContributor[]>();

/** Returns the function that unregisters `contributor`. */
export function registerRelatedRowContributor(databaseKey: string, contributor: RelatedRowContributor): () => void {
  const registered = contributorsByDatabaseKey.get(databaseKey) ?? [];
  contributorsByDatabaseKey.set(databaseKey, [...registered, contributor]);
  return () => {
    const remaining = (contributorsByDatabaseKey.get(databaseKey) ?? []).filter((entry) => entry !== contributor);
    if (remaining.length === 0) contributorsByDatabaseKey.delete(databaseKey);
    else contributorsByDatabaseKey.set(databaseKey, remaining);
  };
}

/** In registration order. */
export function relatedRowContributorsFor(databaseKey: string): readonly RelatedRowContributor[] {
  return contributorsByDatabaseKey.get(databaseKey) ?? [];
}
