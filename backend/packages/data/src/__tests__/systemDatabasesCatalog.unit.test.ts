import { describe, expect, it } from "vitest";
import { ModuleRegistry, resolveCatalogLabel } from "@semprec/module-registry";

/**
 * The reference module's cs/en catalogs (issue #236): systemDatabases ships the Tasks
 * database's translations only — the other nine system databases stay uncovered until
 * issue #146 — proving the registry loads and resolves them correctly end to end.
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

    // A database this reference catalog doesn't yet cover (issue #146's job) has no entry —
    // resolving it falls all the way through to the raw key.
    expect(catalogs?.en["database.areas.name"]).toBeUndefined();
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
    expect(resolveCatalogLabel(null, catalogs?.cs, catalogs?.en ?? {}, "database.areas.name")).toBe(
      "database.areas.name",
    );
  });
});
