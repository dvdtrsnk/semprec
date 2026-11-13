import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
} from "../chokePoint/relationPropertyOps.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { registerLibraryGridViewType, LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import {
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import {
  BOOKS_LIBRARY_CONTRACT,
  COVER_OVERRIDE_KEY,
  COVER_REMOVED_KEY,
  COVER_SOURCE_KEY,
  LIBRARY_COVER_SOURCES,
  MOVIES_LIBRARY_CONTRACT,
  type LibraryModuleContract,
} from "../library/libraryModuleContract.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

// Issue #145: every shipped catalog option `s` becomes `{ key: s }` — see seedTenDatabases.ts's
// copy of this helper for the full rationale.
function selectConfig(options: string[], colors: Record<string, string> = {}): Record<string, unknown> {
  return { options: options.map((key) => ({ key, ...(colors[key] ? { color: colors[key] } : {}) })) };
}

/**
 * The rating filter presets of Books and Movies (issue #1622): "5 stars", "4 and up", "3 and up" and "No rating"
 * (empty or 0), labelled from `library/i18n`. Seeded here for a fresh install and written to existing tenants by
 * `ratingFilterPresetsCutoverMigration.ts`.
 */
export function ratingFilterPresetsConfig(databaseKey: typeof BOOKS_MODULE_ID | typeof MOVIES_MODULE_ID): {
  filterPresets: Array<{ value: number; op: "gte"; labelKey: string }>;
  emptyPreset: { labelKey: string; matchZero: boolean };
} {
  return {
    filterPresets: [5, 4, 3].map((value) => ({
      value,
      op: "gte" as const,
      labelKey: `property.${databaseKey}.rating.preset.${value}`,
    })),
    emptyPreset: { labelKey: `property.${databaseKey}.rating.preset.none`, matchZero: true },
  };
}

/**
 * The user-owned cover properties of Books and Movies (issue #1793). The system-owned `cover` has one writer, the
 * library metadata job, so the cover a user chooses or removes lives in these three: the cover shown is nothing
 * when `coverRemoved`, else `coverOverride` when set, else `cover`. `libraryCoverOverrideCutoverMigration.ts`
 * adds the same properties to a tenant seeded before them.
 */
function coverOverrideSpecs(): PropSpec[] {
  return [
    { key: COVER_OVERRIDE_KEY, name: null, type: "image", owner: "user" },
    { key: COVER_REMOVED_KEY, name: null, type: "checkbox", owner: "user" },
    {
      key: COVER_SOURCE_KEY,
      name: null,
      type: "select",
      owner: "user",
      config: selectConfig([...LIBRARY_COVER_SOURCES]),
    },
  ];
}

interface PropSpec {
  key: string;
  name: string | null;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createDb(client: PoolClient, ownerModuleId: string, ownerProjectItemId: string): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, {
    name: null,
    key: ownerModuleId,
    system: true,
    ownerModuleId,
    ownerProjectItemId,
  });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      name: spec.name,
      type: spec.type,
      owner: spec.owner,
      config: spec.config,
    });
  }
}

/** actionConfig shared by both of a database's library-metadata heartbeats — see libraryMetadataActions.ts's schema. */
function metadataActionConfig(databaseId: string, contract: LibraryModuleContract): Record<string, unknown> {
  return {
    databaseId,
    source: contract === BOOKS_LIBRARY_CONTRACT ? "openLibrary" : "tmdb",
    ...(contract === BOOKS_LIBRARY_CONTRACT
      ? { authorKey: "author", yearKey: "year", isbnKey: "isbn" }
      : { yearKey: "year", typeKey: "type" }),
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

  const relate = (input: CreateRelationPropertyInput) =>
    createRelationPropertyWithClient(client, input, undefined, computedKeyRegistry);

  const booksProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Books",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[BOOKS_MODULE_ID],
    },
  });
  const books = await createDb(client, BOOKS_MODULE_ID, booksProject.id);
  await createProps(client, books.id, [
    { key: "name", name: null, type: "title", owner: "user" },
    { key: "author", name: null, type: "text", owner: "user" },
    { key: "year", name: null, type: "number", owner: "user" },
    { key: "isbn", name: null, type: "text", owner: "user" },
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql) — coverKey.
    { key: "cover", name: null, type: "image", owner: "system" },
    ...coverOverrideSpecs(),
    { key: "rating", name: null, type: "number", owner: "user", config: ratingFilterPresetsConfig(BOOKS_MODULE_ID) },
    {
      key: "status",
      name: null,
      type: "select",
      owner: "user",
      config: {
        ...selectConfig(["toRead", "reading", "read"], { toRead: "#8E8E93", reading: "#007AFF", read: "#34C759" }),
        default: "toRead",
      },
    },
  ]);

  const moviesProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Movies/TV",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[MOVIES_MODULE_ID],
    },
  });
  const movies = await createDb(client, MOVIES_MODULE_ID, moviesProject.id);
  await createProps(client, movies.id, [
    { key: "name", name: null, type: "title", owner: "user" },
    // Deviation from the previous (mock) model: sortable/filterable as a range, not text.
    { key: "year", name: null, type: "number", owner: "user" },
    // "Movie" vs. "Series" stays just a label next to statusKey — no season/episode structure.
    { key: "type", name: null, type: "select", owner: "user", config: selectConfig(["movie", "series"]) },
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql) — coverKey.
    { key: "cover", name: null, type: "image", owner: "system" },
    ...coverOverrideSpecs(),
    { key: "rating", name: null, type: "number", owner: "user", config: ratingFilterPresetsConfig(MOVIES_MODULE_ID) },
    { key: "secondaryRating", name: null, type: "number", owner: "system" },
    { key: "sourceUrl", name: null, type: "url", owner: "system" },
    {
      key: "status",
      name: null,
      type: "select",
      owner: "user",
      config: {
        ...selectConfig(["planned", "watching", "watched"], {
          planned: "#8E8E93",
          watching: "#007AFF",
          watched: "#34C759",
        }),
        default: "planned",
      },
    },
    // In-progress series stay free text here — no dedicated season/episode structure (out of scope).
    { key: "notes", name: null, type: "longText", owner: "user" },
  ]);

  // Movies -> People ("Watched with"): the 1-5 rating belongs to the relationship itself,
  // not either side — written into item_relations.metadata as `{ rating }` on each edge
  // (issue #25), not as a property here.
  await relate({
    sourceDatabaseId: movies.id,
    key: "watchedWith",
    name: null,
    targetDatabaseId: peopleDatabaseId,
    cardinality: "many_to_many",
  });

  await client.query(`UPDATE databases SET schema_locked = true WHERE id = ANY($1::uuid[])`, [[books.id, movies.id]]);

  const instances: Array<{
    database: DatabaseRow;
    contract: LibraryModuleContract;
    name: string;
    projectItemId: string;
  }> = [
    { database: books, contract: BOOKS_LIBRARY_CONTRACT, name: "Books", projectItemId: booksProject.id },
    { database: movies, contract: MOVIES_LIBRARY_CONTRACT, name: "Movies/TV", projectItemId: moviesProject.id },
  ];

  for (const { database, contract, name, projectItemId } of instances) {
    await viewsStore.createView(
      client,
      {
        databaseId: database.id,
        type: LIBRARY_GRID_VIEW_TYPE,
        name,
        isDefault: true,
        createdBy: "system",
        config: { ...contract },
      },
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
