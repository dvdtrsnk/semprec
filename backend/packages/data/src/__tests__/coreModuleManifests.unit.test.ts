import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "@semprec/module-registry";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { TEN_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";

/**
 * Load tests (module-contract issue #226) proving each retrofit manifest for the schema/data
 * core, views, docs, and ten-system-databases modules actually loads through
 * `ModuleRegistry.loadModule()` and passes its load-time structural validation — never that
 * a `ModuleManifest` object merely type-checks. Each module is loaded into its own registry
 * so a failure in one never masks or is masked by another; the four together also prove none
 * of the four collide with each other on module id/name (the fourth-loaded manifest -
 * `systemDatabases` - would fail first, since it declares the most identifiers).
 */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const SCHEMA_CORE_PATH = manifestPath("chokePoint/schemaCoreModuleManifest.js");
const VIEWS_PATH = manifestPath("views/viewsModuleManifest.js");
const DOCS_PATH = manifestPath("docs/docsModuleManifest.js");
const SYSTEM_DATABASES_PATH = manifestPath("seed/systemDatabasesModuleManifest.js");

const alwaysActive: () => ReadonlySet<string> = () => new Set(["schemaCore", "views", "docs", "systemDatabases"]);

describe("core module manifests (module-contract issue #226)", () => {
  it("loads the schema/data core manifest and declares no databases, plus its ungated heartbeat agent tools", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(SCHEMA_CORE_PATH);

    expect(moduleId).toBe("schemaCore");
    expect(await registry.getDatabases()).toEqual([]);
    expect(await registry.getAgentTools(new Set())).toEqual([
      { moduleId: "schemaCore", name: "heartbeat.list", handlerExport: "createHeartbeatListTool" },
      { moduleId: "schemaCore", name: "heartbeat.history", handlerExport: "createHeartbeatHistoryTool" },
      { moduleId: "schemaCore", name: "heartbeat.trigger", handlerExport: "createHeartbeatTriggerTool" },
    ]);
    expect(await registry.getMigrations()).toEqual([{ moduleId: "schemaCore", migration: "0001_core_schema.sql" }]);
  });

  it("loads the views manifest and projects the built-in view types", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(VIEWS_PATH);

    expect(moduleId).toBe("views");
    expect(await registry.getViewTypes()).toEqual([...BUILTIN_VIEW_TYPES]);
    expect(await registry.getDatabases()).toEqual([]);
  });

  it("loads the docs manifest and declares no core-reserved task or heartbeat names", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(DOCS_PATH);

    expect(moduleId).toBe("docs");
    expect(await registry.getTasks()).toEqual([]);
    expect(await registry.getHeartbeatActions()).toEqual([]);
    expect(await registry.getMigrations()).toEqual([
      { moduleId: "docs", migration: "0003_docs.sql" },
      { moduleId: "docs", migration: "0036_doc_history_retention.sql" },
    ]);
  });

  it("loads the ten-system-databases manifest with all ten existing database keys and Journal's view type", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(SYSTEM_DATABASES_PATH);

    expect(moduleId).toBe("systemDatabases");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual([...TEN_DATABASE_MODULE_IDS].sort());
    expect(await registry.getViewTypes()).toEqual([TEMPORAL_SWITCHER_VIEW_TYPE]);
  });

  it("loads all four manifests together into one registry with no id/name/database-key collisions", async () => {
    const registry = new ModuleRegistry(alwaysActive);

    await registry.loadModule(SCHEMA_CORE_PATH);
    await registry.loadModule(VIEWS_PATH);
    await registry.loadModule(DOCS_PATH);
    await registry.loadModule(SYSTEM_DATABASES_PATH);

    expect(registry.listModuleIds().sort()).toEqual(["docs", "schemaCore", "systemDatabases", "views"]);
    expect((await registry.getDatabases()).length).toBe(TEN_DATABASE_MODULE_IDS.length);
  });
});
