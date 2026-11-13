// The registry of extra rows a module adds to the related collections of one record type (issue #1839,
// `relation.related`). A module registers a function for the key of a database; `listRelatedWithClient` calls the
// functions registered for the viewed record's database and lists the rows they return with its own. The registry
// is empty in this issue: the mail thread counts of people (#1874) register the first contributor. The shape of the
// registry, the replace-the-row rule, the read-only contract of the supplied client and where a module registers are
// decided in docs/adr/2026-11-13-related-rows-are-contributed-through-a-per-process-registry.md.
import type { PoolClient } from "pg";
import type { FilterNode } from "../views/filterTree.js";

/** One related collection of a record: `count` records of the database are connected to it. */
export interface RelatedCollectionRow {
  databaseKey: string | null;
  databaseId: string;
  count: number;
  /** Whether the records are connected to the viewed record itself (`direct`) or through a project of it (`project`). */
  via: "direct" | "project";
  /** The filter tree that selects exactly the counted records in a query of the database; `null` when none can. */
  filter: FilterNode | null;
}

/** The record a contributor is asked about, and the transaction it reads in. */
export interface RelatedContributorContext {
  client: PoolClient;
  itemId: string;
  databaseId: string;
  databaseKey: string;
}

/**
 * Returns the extra row for the record, or `null` for none. The row replaces the row the generic read built for the
 * same database; it still goes through the exclusion of empty, archived, internal and unreadable collections, the
 * order and the agent's grants like every other row.
 */
export type RelatedRowContributor = (context: RelatedContributorContext) => Promise<RelatedCollectionRow | null>;

const contributorsByDatabaseKey = new Map<string, RelatedRowContributor[]>();

/**
 * Registers `contributor` for records of the database with key `databaseKey`. Returns the function that removes it
 * again.
 */
export function registerRelatedRowContributor(databaseKey: string, contributor: RelatedRowContributor): () => void {
  const registered = contributorsByDatabaseKey.get(databaseKey) ?? [];
  contributorsByDatabaseKey.set(databaseKey, [...registered, contributor]);
  return () => {
    const remaining = (contributorsByDatabaseKey.get(databaseKey) ?? []).filter((entry) => entry !== contributor);
    if (remaining.length === 0) contributorsByDatabaseKey.delete(databaseKey);
    else contributorsByDatabaseKey.set(databaseKey, remaining);
  };
}

/** The contributors registered for the database key, in registration order. */
export function relatedRowContributorsFor(databaseKey: string): readonly RelatedRowContributor[] {
  return contributorsByDatabaseKey.get(databaseKey) ?? [];
}
