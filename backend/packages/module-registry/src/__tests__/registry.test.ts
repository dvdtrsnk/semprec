import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../registry.js";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

const alwaysActive: () => ReadonlySet<string> = () => new Set(["fixture-good", "fixture-second"]);

describe("ModuleRegistry.loadModule", () => {
  it("loads a structurally valid module and returns its manifest", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const manifest = await registry.loadModule(fixturePath("goodModule.js"));
    expect(manifest.id).toBe("fixture-good");
    expect(registry.listModuleIds()).toEqual(["fixture-good"]);
  });

  it("rejects a manifest missing required fields", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("invalidShapeModule.js"))).rejects.toThrow(/invalid manifest/);
  });

  it("rejects a module referencing a missing handler export", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("missingExportModule.js"))).rejects.toThrow(/missing export "doesNotExist"/);
  });

  it("rejects a duplicate module id", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateIdModule.js"))).rejects.toThrow(/Duplicate module id "fixture-good"/);
  });

  it("rejects a duplicate database key across modules", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateDatabaseKeyModule.js"))).rejects.toThrow(/Duplicate database key "fixtureGoodItems"/);
  });
});

describe("ModuleRegistry projections", () => {
  async function loadBoth(getActiveModuleIds: () => ReadonlySet<string> | Promise<ReadonlySet<string>>): Promise<ModuleRegistry> {
    const registry = new ModuleRegistry(getActiveModuleIds);
    await registry.loadModule(fixturePath("goodModule.js"));
    await registry.loadModule(fixturePath("secondModule.js"));
    return registry;
  }

  it("expose only per-aspect projections, filtered to active modules", async () => {
    const registry = await loadBoth(alwaysActive);

    expect(await registry.getDatabases()).toEqual([
      { moduleId: "fixture-good", key: "fixtureGoodItems", name: "Fixture Good Items" },
      { moduleId: "fixture-second", key: "fixtureSecondItems", name: "Fixture Second Items" },
    ]);
    expect(await registry.getViewTypes()).toEqual(["fixture-good-view"]);
    expect(await registry.getHeartbeatActions()).toEqual(["fixtureGood.heartbeat"]);
    expect(await registry.getHeartbeatRuleKinds()).toEqual(["onItemEvent"]);
    expect(await registry.getMigrations()).toEqual([{ moduleId: "fixture-good", migration: "0001_fixture_good.sql" }]);
    expect(await registry.getSystemProjectModuleIds()).toEqual(["fixture-good"]);

    const tasks = await registry.getTasks();
    expect(tasks).toEqual([
      { moduleId: "fixture-good", name: "fixtureGood.processThing", payloadSchemaExport: "processThingPayloadSchema", handlerExport: "handleProcessThing" },
    ]);

    const workers = await registry.getWorkers();
    expect(workers).toEqual([{ moduleId: "fixture-good", name: "fixtureGood.worker", handlerExport: "runWorker" }]);

    // Every returned projection object is a narrow, ad-hoc shape — none of them is (or
    // contains) the full ModuleManifest, e.g. no "capabilities"/"agentTools" keys leak
    // into the database projection.
    expect(Object.keys((await registry.getDatabases())[0])).toEqual(["moduleId", "key", "name"]);
  });

  it("drops an inactive module from every projection", async () => {
    const registry = await loadBoth(() => new Set(["fixture-second"]));

    expect(await registry.getDatabases()).toEqual([{ moduleId: "fixture-second", key: "fixtureSecondItems", name: "Fixture Second Items" }]);
    expect(await registry.getViewTypes()).toEqual([]);
    expect(await registry.getSystemProjectModuleIds()).toEqual([]);
    expect(await registry.listActiveModuleIds()).toEqual(["fixture-second"]);
  });

  it("filters out an agent tool entirely when its capability isn't granted, rather than marking it denied", async () => {
    const registry = await loadBoth(alwaysActive);

    expect(await registry.getAgentTools(new Set(["fixtureGood.send"]))).toEqual([
      { moduleId: "fixture-good", name: "fixtureGood.doThing", handlerExport: "handleDoThing" },
    ]);
    expect(await registry.getAgentTools(new Set())).toEqual([]);
  });

  it("re-evaluates activation on every call instead of caching it at load time", async () => {
    let active = new Set<string>();
    const registry = await loadBoth(() => active);

    expect(await registry.getDatabases()).toEqual([]);
    active = new Set(["fixture-good"]);
    expect(await registry.getDatabases()).toEqual([{ moduleId: "fixture-good", key: "fixtureGoodItems", name: "Fixture Good Items" }]);
  });
});
