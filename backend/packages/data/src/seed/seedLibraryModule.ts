import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { createRelationPropertyWithClient, type CreateRelationPropertyInput } from "../chokePoint/chokePoint.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { registerLibraryGridViewType, LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, LIBRARY_METADATA_TRIGGER_ACTION_ID } from "../library/libraryMetadataActions.js";
import { BOOKS_LIBRARY_CONTRACT, MOVIES_LIBRARY_CONTRACT, type LibraryModuleContract } from "../library/libraryModuleContract.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";

function selectConfig(options: string[]): Record<string, unknown> {
  return { options };
}

interface PropSpec {
  key: string;
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createDb(client: PoolClient, name: string, ownerModuleId: string, ownerProjectItemId: string): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, { name, system: true, ownerModuleId, ownerProjectItemId });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, { databaseId, key: spec.key, name: spec.name, type: spec.type, owner: spec.owner, config: spec.config });
  }
}

/** actionConfig shared by both of a database's library-metadata heartbeats — see libraryMetadataActions.ts's schema. */
function metadataActionConfig(databaseId: string, contract: LibraryModuleContract): Record<string, unknown> {
  return {
    databaseId,
    source: "none", // no external metadata source is wired up yet — see libraryMetadataJob.ts's noop fetcher.
    coverKey: contract.coverKey,
    secondaryRatingKey: contract.secondaryRatingKey,
    sourceUrlKey: contract.sourceUrlKey,
  };
}

export interface LibraryModuleResult {
  books: DatabaseRow;
  movies: DatabaseRow;
}

/**
 * Seeds Books and Movies/TV (issue #25) as two concrete instantiations of the generic
 * "library module" contract — same shape, different property keys and ownership — each
 * as its own full system project (its own Project item + AGENT.md + heartbeats), the same
 * class as Email or Personal finance, not a catalog entry from the ten hardcoded databases.
 *
 * Must run after `seedTenDatabasesInTransaction` (needs the already-created Projects and
 * People databases) and after "System settings" exists (heartbeat creation reads the
 * system timezone) — see the call site in seedSystem.ts. The Movies -> People relation is
 * deliberately one-directional (no inverse property on People) precisely because People's
 * schema is already locked by the time this runs, the same reason several ten-database
 * relations (e.g. Files -> Areas) are one-directional rather than bidirectional.
 */
export async function seedLibraryModuleInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
  peopleDatabaseId: string,
  viewTypeRegistry: ViewTypeRegistry,
  computedKeyRegistry: ComputedKeyRegistry,
): Promise<LibraryModuleResult> {
  registerLibraryGridViewType(viewTypeRegistry);

  const relate = (input: CreateRelationPropertyInput) => createRelationPropertyWithClient(client, input, computedKeyRegistry);

  const booksProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Books",
      systemActive: true,
      agents:
        "Purpose: catalog books the user is reading or has read.\n" +
        "Allowed: create a Books item (name/author/rating/status) via the generic create-item endpoint.\n" +
        "Not allowed: write 'cover' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n" +
        "General instructions: use the same create-item path as the UI; there is no separate AI path.",
    },
  });
  const books = await createDb(client, "Books", BOOKS_MODULE_ID, booksProject.id);
  await createProps(client, books.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "author", name: "Author", type: "text", owner: "user" },
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql) — coverKey.
    { key: "cover", name: "Cover", type: "image", owner: "system" },
    { key: "rating", name: "Rating", type: "number", owner: "user" },
    { key: "status", name: "Status", type: "select", owner: "user", config: selectConfig(["toRead", "reading", "read"]) },
  ]);

  const moviesProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Movies/TV",
      systemActive: true,
      agents:
        "Purpose: catalog movies and TV series watched or planned to watch.\n" +
        "Allowed: create a Movies/TV item (name/year/type/rating/status) via the generic create-item endpoint, and link 'Watched with' to a Person with a 1-5 rating on the relation.\n" +
        "Not allowed: write 'cover'/'secondaryRating'/'sourceUrl' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n" +
        "General instructions: use the same create-item path as the UI; there is no separate AI path.",
    },
  });
  const movies = await createDb(client, "Movies/TV", MOVIES_MODULE_ID, moviesProject.id);
  await createProps(client, movies.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // Deviation from the previous (mock) model: sortable/filterable as a range, not text.
    { key: "year", name: "Year", type: "number", owner: "user" },
    // "Movie" vs. "Series" stays just a label next to statusKey — no season/episode structure.
    { key: "type", name: "Type", type: "select", owner: "user", config: selectConfig(["movie", "series"]) },
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql) — coverKey.
    { key: "cover", name: "Cover", type: "image", owner: "system" },
    { key: "rating", name: "Rating", type: "number", owner: "user" },
    { key: "secondaryRating", name: "Critics' rating", type: "number", owner: "system" },
    { key: "sourceUrl", name: "Source", type: "url", owner: "system" },
    { key: "status", name: "Status", type: "select", owner: "user", config: selectConfig(["planned", "watching", "watched"]) },
    // In-progress series stay free text here — no dedicated season/episode structure (out of scope).
    { key: "notes", name: "Notes", type: "longText", owner: "user" },
  ]);

  // Movies -> People ("Watched with"): the 1-5 rating belongs to the relationship itself,
  // not either side — written into item_relations.metadata as `{ rating }` on each edge
  // (issue #25), not as a property here.
  await relate({
    databaseId: movies.id,
    key: "watchedWith",
    name: "Watched with",
    targetDatabaseId: peopleDatabaseId,
    cardinality: "many_to_many",
  });

  await client.query(`UPDATE databases SET schema_locked = true WHERE id = ANY($1::uuid[])`, [[books.id, movies.id]]);

  const instances: Array<{ database: DatabaseRow; contract: LibraryModuleContract; name: string; projectItemId: string }> = [
    { database: books, contract: BOOKS_LIBRARY_CONTRACT, name: "Books", projectItemId: booksProject.id },
    { database: movies, contract: MOVIES_LIBRARY_CONTRACT, name: "Movies/TV", projectItemId: moviesProject.id },
  ];

  for (const { database, contract, name, projectItemId } of instances) {
    await viewsStore.createView(
      client,
      { databaseId: database.id, type: LIBRARY_GRID_VIEW_TYPE, name, isDefault: true, createdBy: "system", config: { ...contract } },
      viewTypeRegistry,
    );

    const actionConfig = metadataActionConfig(database.id, contract);
    await createHeartbeat(client, {
      projectItemId,
      name: `${name} cover/metadata processing`,
      rule: { kind: "onItemEvent", databaseId: database.id, event: "create" },
      actionId: LIBRARY_METADATA_TRIGGER_ACTION_ID,
      actionConfig,
    });
    await createHeartbeat(client, {
      projectItemId,
      name: `${name} metadata retry sweep`,
      rule: { kind: "dailyTime", at: "04:00" },
      actionId: LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
      actionConfig,
    });
  }

  return { books, movies };
}
