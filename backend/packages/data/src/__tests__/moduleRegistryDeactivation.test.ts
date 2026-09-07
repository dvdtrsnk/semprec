import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";

let pool: Pool;

function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const ALL_MODULE_IDS = ["schemaCore", "views", "docs", "systemDatabases", "library", "mailSync", "inboxPipeline"];

const MANIFEST_PATHS = [
  manifestPath("chokePoint/schemaCoreModuleManifest.js"),
  manifestPath("views/viewsModuleManifest.js"),
  manifestPath("docs/docsModuleManifest.js"),
  manifestPath("seed/systemDatabasesModuleManifest.js"),
  manifestPath("library/libraryModuleManifest.js"),
  manifestPath("mail/mailModuleManifest.js"),
  manifestPath("inbox/inboxModuleManifest.js"),
];

/**
 * Proves the acceptance criterion "deactivation removes all projected participation while
 * preserving stored data" (module-contract issue #115) against real, already-seeded rows —
 * not just in-memory fixtures (that part is `moduleRegistryLoadAll.test.ts` and
 * `module-registry`'s own unit tests). Deactivating a module is purely a registry-projection
 * concern (`ActiveModuleIdsSource`, evaluated fresh on every call) — it never touches storage,
 * so the Books/Movies rows `seedSystem` created stay exactly as they were.
 */
describe("module deactivation preserves stored data (module-contract issue #115)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("excludes a deactivated module's databases and view types from projections while its rows remain in Postgres", async () => {
    const { rows: beforeRows } = await pool.query(
      "SELECT owner_module_id, name, schema_locked FROM databases WHERE owner_module_id = ANY($1::text[]) ORDER BY owner_module_id",
      [[BOOKS_MODULE_ID, MOVIES_MODULE_ID]],
    );
    expect(beforeRows).toHaveLength(2);

    const activeExceptLibrary = new Set(ALL_MODULE_IDS.filter((id) => id !== "library"));
    const registry = new ModuleRegistry(() => activeExceptLibrary);
    for (const path of MANIFEST_PATHS) {
      await registry.loadModule(path);
    }

    const projectedKeys = (await registry.getDatabases()).map((db) => db.key);
    expect(projectedKeys).not.toContain(BOOKS_MODULE_ID);
    expect(projectedKeys).not.toContain(MOVIES_MODULE_ID);
    expect(await registry.getViewTypes()).not.toContain(LIBRARY_GRID_VIEW_TYPE);

    const { rows: afterRows } = await pool.query(
      "SELECT owner_module_id, name, schema_locked FROM databases WHERE owner_module_id = ANY($1::text[]) ORDER BY owner_module_id",
      [[BOOKS_MODULE_ID, MOVIES_MODULE_ID]],
    );
    expect(afterRows).toEqual(beforeRows);
  });
});
