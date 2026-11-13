import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { LIBRARY_GRID_VIEW_TYPE, registerLibraryGridViewType } from "../views/libraryGridViewType.js";
import {
  BOOKS_LIBRARY_CONTRACT,
  COVER_OVERRIDE_KEY,
  COVER_REMOVED_KEY,
  COVER_SOURCE_KEY,
  LIBRARY_COVER_SOURCES,
  MOVIES_LIBRARY_CONTRACT,
  type LibraryModuleContract,
} from "./libraryModuleContract.js";

/** The properties `seedLibraryModule.ts` seeds for the user-owned cover of a fresh tenant, in the same shape. */
const COVER_OVERRIDE_PROPERTIES = [
  { key: COVER_OVERRIDE_KEY, type: "image", config: {} },
  { key: COVER_REMOVED_KEY, type: "checkbox", config: {} },
  { key: COVER_SOURCE_KEY, type: "select", config: { options: LIBRARY_COVER_SOURCES.map((key) => ({ key })) } },
] as const;

const COVER_OVERRIDE_CONTRACT_KEYS = ["coverOverrideKey", "coverRemovedKey", "coverSourceKey"] as const;

/** The contract keys the stored config `config` does not name yet, with the value the contract gives them. */
function missingContractKeys(contract: LibraryModuleContract, config: Record<string, unknown>): Record<string, string> {
  const missing: Record<string, string> = {};
  for (const name of COVER_OVERRIDE_CONTRACT_KEYS) {
    const value = contract[name];
    if (value !== undefined && !Object.hasOwn(config, name)) missing[name] = value;
  }
  return missing;
}

/**
 * Per-tenant cutover of issue #1793 for a tenant seeded before the user-owned cover properties: adds
 * `coverOverride`, `coverRemoved` and `coverSource` to the locked schemas of Books and Movies, and the keys that
 * name them to the config of the database's `library-grid` views. A missing database is skipped. A property that
 * exists is left as it is and a view config that already names a key keeps its value, so a second run changes
 * nothing. The properties go in by direct SQL under the table lock, like `libraryBooksYearIsbnCutoverMigration.ts`:
 * the schemas are locked. The view configs go through `viewsStore.patchView`, the one writer of `views.config`, so
 * the merged config is checked by the `library-grid` view type's schema like any other view write.
 */
export async function runLibraryCoverOverrideCutoverMigration(pool: Pool): Promise<void> {
  const viewTypeRegistry = createViewTypeRegistry();
  registerLibraryGridViewType(viewTypeRegistry);
  await withTransaction(pool, async (client) => {
    for (const [moduleId, contract] of [
      [BOOKS_MODULE_ID, BOOKS_LIBRARY_CONTRACT],
      [MOVIES_MODULE_ID, MOVIES_LIBRARY_CONTRACT],
    ] as const) {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (!database) continue;
      await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
      const { rows } = await client.query<{ key: string }>(
        "SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
        [database.id, COVER_OVERRIDE_PROPERTIES.map((property) => property.key)],
      );
      const existing = new Set(rows.map((row) => row.key));
      for (const property of COVER_OVERRIDE_PROPERTIES) {
        if (existing.has(property.key)) continue;
        await client.query(
          `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
           VALUES ($1, $2, NULL, $3, $4::jsonb, false, 'user', NULL)`,
          [database.id, property.key, property.type, JSON.stringify(property.config)],
        );
      }
      for (const view of await viewsStore.listViewsByDatabase(client, database.id)) {
        if (view.type !== LIBRARY_GRID_VIEW_TYPE) continue;
        // Only the absent keys are patched, so a value the tenant's view already holds is kept.
        const missing = missingContractKeys(contract, view.config);
        if (Object.keys(missing).length === 0) continue;
        await viewsStore.patchView(client, view.id, { config: missing }, viewTypeRegistry);
      }
    }
  });
}
