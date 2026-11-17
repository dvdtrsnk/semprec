import { beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry, resolveCatalogLabel } from "@semprec/module-registry";
import { resolveProperty } from "../manifest/catalogResolution.js";
import type { PropertyRow, PropertyType } from "../types.js";

/** The systemDatabases module's cs/en catalogs, loaded and resolved through the registry. */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const SYSTEM_DATABASES_PATH = manifestPath("seed/systemDatabasesModuleManifest.js");

describe("systemDatabases reference i18n catalog (issue #236)", () => {
  beforeAll(async () => {
    // Warms the cold manifest import once so test timing does not depend on order.
    await import(SYSTEM_DATABASES_PATH);
  }, 30_000);

  it("loads the Tasks database's cs/en catalog entries", async () => {
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(SYSTEM_DATABASES_PATH);

    const catalogs = await registry.getCatalogs("systemDatabases");
    expect(catalogs?.en["database.tasks.name"]).toBe("Tasks");
    expect(catalogs?.cs["database.tasks.name"]).toBe("Úkoly");
    expect(catalogs?.en["property.tasks.status.option.notDone"]).toBe("Open");
    // The open status reads "Nehotovo" / "Open", and `missed` "Nesplněno" / "Missed".
    expect(catalogs?.cs["property.tasks.status.option.notDone"]).toBe("Nehotovo");
    expect(catalogs?.en["property.tasks.status.option.missed"]).toBe("Missed");
    expect(catalogs?.cs["property.tasks.status.option.missed"]).toBe("Nesplněno");

    expect(catalogs?.en["database.areas.name"]).toBe("Areas");
    expect(catalogs?.cs["database.areas.name"]).toBe("Oblasti");

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

  // Labels are resolved from the catalog at read time; the stored name is null and keys never change.
  function row(key: string, type: PropertyType, optionKeys: string[] = []): PropertyRow {
    return {
      id: `${key}-id`,
      databaseId: "database",
      key,
      name: null,
      type,
      config: { options: optionKeys.map((optionKey) => ({ key: optionKey })) },
      owner: "system",
      ownerProcess: null,
      locked: false,
      migrationStatus: "stable",
    };
  }

  it.each([
    ["projects", "area", "relation", "Oblast", "Area"],
    ["projects", "date", "date", "Termín", "Deadline"],
    ["areas", "company", "relation", "Firmy", "Companies"],
    ["areas", "healthRecord", "relation", "Zdravotní záznamy", "Health records"],
    ["healthRecords", "subject", "text", "Kdo", undefined],
    ["healthRecords", "files", "files", "Přílohy", undefined],
    ["journal", "type", "select", "Období", undefined],
  ] as const)("resolves %s.%s property name through the catalogs", async (db, key, type, cs, en) => {
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(SYSTEM_DATABASES_PATH);
    const catalogs = await registry.getCatalogs("systemDatabases");

    expect(resolveProperty(row(key, type as PropertyType), db, catalogs, "cs").name).toBe(cs);
    if (en !== undefined) expect(resolveProperty(row(key, type as PropertyType), db, catalogs, "en").name).toBe(en);
  });

  it.each([
    ["people", "relationship", "girlfriend", "Partnerka"],
    ["healthRecords", "status", "monitoring", "Sleduje se"],
    ["healthRecords", "type", "condition", "Stav"],
    ["healthRecords", "tags", "dentalHygiene", "Dentální hygiena"],
    ["events", "type", "event", "Událost"],
    ["journal", "type", "quarter", "Kvartál"],
  ] as const)("resolves the %s.%s option %s to its Czech label while the key stays", async (db, key, option, cs) => {
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(SYSTEM_DATABASES_PATH);
    const catalogs = await registry.getCatalogs("systemDatabases");

    const resolved = resolveProperty(row(key, "select", [option]), db, catalogs, "cs");
    expect(resolved.options).toEqual([{ key: option, label: cs }]);
  });
});
