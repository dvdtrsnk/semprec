import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleCatalogs } from "@semprec/module-registry";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";

/**
 * Enumerates every system database, property, option, view type, and agent tool key from
 * the actual seeded state (issue #146) and fails when a key is missing from either locale
 * of its owning module's catalog — the "moving Czech labels without semantic changes and
 * adding complete English labels" acceptance criterion, checked mechanically rather than
 * by manual review of each catalog file.
 */
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

/** The non-built-in view types this issue covers, each owned by a different manifest than "views". */
const NON_BUILTIN_VIEW_TYPE_OWNERS: Record<string, string> = {
  [TEMPORAL_SWITCHER_VIEW_TYPE]: "systemDatabases",
  [LIBRARY_GRID_VIEW_TYPE]: "library",
  [MAILBOX_CLIENT_VIEW_TYPE]: "mailSync",
  [JOURNAL_INBOX_VIEW_TYPE]: "inboxPipeline",
};

interface PropertyRow {
  key: string;
  type: string;
  config: { options?: Array<{ key: string }> };
}

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let registry: ModuleRegistry;
const catalogsByModuleId = new Map<string, ModuleCatalogs>();

function assertLabel(catalogs: ModuleCatalogs | undefined, moduleId: string, key: string): void {
  expect(catalogs, `module "${moduleId}" has no loaded catalogs`).toBeDefined();
  for (const locale of ["cs", "en"] as const) {
    const value = catalogs?.[locale][key];
    expect(value, `missing "${locale}" catalog entry "${key}" (owning module "${moduleId}")`).toBeTypeOf("string");
    expect(
      (value ?? "").length > 0,
      `catalog entry "${key}" (owning module "${moduleId}", locale "${locale}") is empty`,
    ).toBe(true);
  }
}

describe("system i18n catalog coverage (issue #146)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);

    registry = new ModuleRegistry(() => new Set(ALL_MODULE_IDS));
    for (const path of MANIFEST_PATHS) {
      await registry.loadModule(path);
    }
    for (const moduleId of ALL_MODULE_IDS) {
      const catalogs = await registry.getCatalogs(moduleId);
      if (catalogs) catalogsByModuleId.set(moduleId, catalogs);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("has a cs and en label for every manifest-declared database", async () => {
    const databases = await registry.getDatabases();
    expect(databases.length).toBeGreaterThan(0);
    for (const db of databases) {
      assertLabel(catalogsByModuleId.get(db.moduleId), db.moduleId, `database.${db.key}.name`);
    }
  });

  it("has a cs and en label for every property and select/multi_select option seeded under a manifest-declared database", async () => {
    const databases = await registry.getDatabases();
    let checkedProperties = 0;
    let checkedOptions = 0;

    for (const db of databases) {
      const { rows } = await pool.query<PropertyRow>(
        `SELECT p.key, p.type, p.config
         FROM properties p
         JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = $1`,
        [db.key],
      );
      expect(rows.length, `database "${db.key}" (module "${db.moduleId}") seeded no properties`).toBeGreaterThan(0);

      for (const row of rows) {
        assertLabel(catalogsByModuleId.get(db.moduleId), db.moduleId, `property.${db.key}.${row.key}.name`);
        checkedProperties += 1;

        if (row.type === "select" || row.type === "multi_select") {
          for (const option of row.config.options ?? []) {
            assertLabel(
              catalogsByModuleId.get(db.moduleId),
              db.moduleId,
              `property.${db.key}.${row.key}.option.${option.key}`,
            );
            checkedOptions += 1;
          }
        }
      }
    }

    expect(checkedProperties).toBeGreaterThan(0);
    expect(checkedOptions).toBeGreaterThan(0);
  });

  it("has a cs and en label for every built-in and manifest-declared view type", async () => {
    for (const viewType of BUILTIN_VIEW_TYPES) {
      assertLabel(catalogsByModuleId.get("views"), "views", `viewType.${viewType}.name`);
    }
    for (const [viewType, moduleId] of Object.entries(NON_BUILTIN_VIEW_TYPE_OWNERS)) {
      assertLabel(catalogsByModuleId.get(moduleId), moduleId, `viewType.${viewType}.name`);
    }

    const declaredViewTypes = await registry.getViewTypes();
    expect(declaredViewTypes.sort()).toEqual(
      [...BUILTIN_VIEW_TYPES, ...Object.keys(NON_BUILTIN_VIEW_TYPE_OWNERS)].sort(),
    );
  });

  it("has a cs and en label for every manifest-declared agent tool", async () => {
    const tools = await registry.getAgentTools(new Set());
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      assertLabel(catalogsByModuleId.get(tool.moduleId), tool.moduleId, `agentTool.${tool.name}.label`);
    }
  });
});
