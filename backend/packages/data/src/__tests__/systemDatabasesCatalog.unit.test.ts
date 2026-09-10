import { describe, expect, it } from "vitest";
import { ModuleRegistry, resolveCatalogLabel } from "@semprec/module-registry";

/**
 * The systemDatabases module's cs/en catalogs, covering all ten system databases (issue
 * #146, building on the reference Tasks catalog issue #236 shipped) — proving the registry
 * loads and resolves them correctly end to end.
 */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const SYSTEM_DATABASES_PATH = manifestPath("seed/systemDatabasesModuleManifest.js");

describe("systemDatabases reference i18n catalog (issue #236)", () => {
  it("loads the Tasks database's cs/en catalog entries", async () => {
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(SYSTEM_DATABASES_PATH);

    const catalogs = await registry.getCatalogs("systemDatabases");
    expect(catalogs?.en["database.tasks.name"]).toBe("Tasks");
    expect(catalogs?.cs["database.tasks.name"]).toBe("Úkoly");
    expect(catalogs?.en["property.tasks.status.option.notDone"]).toBe("Not done");
    expect(catalogs?.cs["property.tasks.status.option.notDone"]).toBe("Nesplněno");

    expect(catalogs?.en["database.areas.name"]).toBe("Areas");
    expect(catalogs?.cs["database.areas.name"]).toBe("Oblasti");

    // A key with no entry in either locale falls all the way through to the raw key.
    expect(catalogs?.en["database.notARealDatabase.name"]).toBeUndefined();
  });

  it("resolves a Tasks label through the full override -> locale -> English -> raw-key chain", async () => {
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(SYSTEM_DATABASES_PATH);
    const catalogs = await registry.getCatalogs("systemDatabases");

    expect(resolveCatalogLabel(null, catalogs?.cs, catalogs?.en ?? {}, "database.tasks.name")).toBe("Úkoly");
    expect(resolveCatalogLabel(null, catalogs?.en, catalogs?.en ?? {}, "database.tasks.name")).toBe("Tasks");
    expect(resolveCatalogLabel("Custom name", catalogs?.cs, catalogs?.en ?? {}, "database.tasks.name")).toBe(
      "Custom name",
    );
    expect(resolveCatalogLabel(null, catalogs?.cs, catalogs?.en ?? {}, "database.areas.name")).toBe("Oblasti");
    expect(resolveCatalogLabel(null, catalogs?.cs, catalogs?.en ?? {}, "database.notARealDatabase.name")).toBe(
      "database.notARealDatabase.name",
    );
  });
});
