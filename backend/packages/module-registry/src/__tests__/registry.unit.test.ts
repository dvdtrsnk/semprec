import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../registry.js";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

const alwaysActive: () => ReadonlySet<string> = () => new Set(["fixture-good", "fixture-second"]);

describe("ModuleRegistry.loadModule", () => {
  it("loads a structurally valid module and returns only its id", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(fixturePath("goodModule.js"));
    expect(moduleId).toBe("fixture-good");
    expect(registry.listModuleIds()).toEqual(["fixture-good"]);
  });

  it("rejects a manifest missing required fields", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("invalidShapeModule.js"))).rejects.toThrow(/invalid manifest/);
  });

  it("rejects a module referencing a missing handler export", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("missingExportModule.js"))).rejects.toThrow(
      /missing export "doesNotExist"/,
    );
  });

  it("rejects a heartbeat rule kind whose schemaExport isn't schema-shaped (no safeParse)", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("malformedRuleKindSchemaModule.js"))).rejects.toThrow(
      /export "notASchema" is not a schema \(missing a "safeParse" method\)/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a duplicate module id", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateIdModule.js"))).rejects.toThrow(
      /Duplicate module id "fixture-good"/,
    );
  });

  it("rejects a duplicate database key across modules", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateDatabaseKeyModule.js"))).rejects.toThrow(
      /Duplicate database key "fixtureGoodItems"/,
    );
  });

  it("rejects a duplicate agent tool name across modules", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateAgentToolNameModule.js"))).rejects.toThrow(
      /Duplicate agent tool name "fixtureGood.doThing"/,
    );
  });

  it("rejects a duplicate task name across modules", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateTaskNameModule.js"))).rejects.toThrow(
      /Duplicate task name "fixtureGood.processThing"/,
    );
  });

  it("rejects a duplicate worker name across modules", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));
    await expect(registry.loadModule(fixturePath("duplicateWorkerNameModule.js"))).rejects.toThrow(
      /Duplicate worker name "fixtureGood.worker"/,
    );
  });

  it("never partially claims identifiers from a module that ultimately fails to load", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));

    // Collides on its second database key ("fixtureGoodItems"); its first key
    // ("fixturePartialFirst") must not be left claimed even though it was checked first.
    await expect(registry.loadModule(fixturePath("partialCollisionModule.js"))).rejects.toThrow(
      /Duplicate database key "fixtureGoodItems"/,
    );
    expect(registry.listModuleIds()).toEqual(["fixture-good"]);

    // A later, unrelated module reusing that same key must succeed — it was never
    // actually claimed by the rejected module.
    const reclaimedId = await registry.loadModule(fixturePath("reclaimsPartialFirstModule.js"));
    expect(reclaimedId).toBe("fixture-reclaims-partial-first");
  });

  it("rejects a task name colliding with a core-reserved task name", async () => {
    const registry = new ModuleRegistry(alwaysActive, { reservedTaskNames: new Set(["heartbeatSweep"]) });
    await expect(registry.loadModule(fixturePath("reservedTaskNameModule.js"))).rejects.toThrow(
      /task name "heartbeatSweep" loading .* collides with a core-reserved task name/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a heartbeat rule kind colliding with a core-reserved rule kind", async () => {
    const registry = new ModuleRegistry(alwaysActive, {
      reservedHeartbeatRuleKinds: new Set(["dailyTime", "weekly", "everyNDays", "interval", "onItemEvent"]),
    });
    await expect(registry.loadModule(fixturePath("reservedHeartbeatRuleKindModule.js"))).rejects.toThrow(
      /heartbeat rule kind "dailyTime" loading .* collides with a core-reserved heartbeat rule kind/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });
});

describe("ModuleRegistry projections", () => {
  async function loadBoth(
    getActiveModuleIds: () => ReadonlySet<string> | Promise<ReadonlySet<string>>,
  ): Promise<ModuleRegistry> {
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
    expect(await registry.getHeartbeatRuleKinds()).toEqual(["fixtureGood.onWidgetTick"]);
    expect(await registry.getMigrations()).toEqual([{ moduleId: "fixture-good", migration: "0001_fixture_good.sql" }]);
    expect(await registry.getDataMigrations()).toEqual([
      {
        moduleId: "fixture-good",
        databaseKey: "fixtureGoodItems",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        converterExport: "convertFixtureGoodItem",
      },
    ]);
    expect(await registry.getSystemProjectModuleIds()).toEqual(["fixture-good"]);

    const tasks = await registry.getTasks();
    expect(tasks).toEqual([
      {
        moduleId: "fixture-good",
        name: "fixtureGood.processThing",
        payloadSchemaExport: "processThingPayloadSchema",
        handlerExport: "handleProcessThing",
      },
    ]);

    const workers = await registry.getWorkers();
    expect(workers).toEqual([{ moduleId: "fixture-good", name: "fixtureGood.worker", handlerExport: "runWorker" }]);

    // Every returned projection object is a narrow, ad-hoc shape — none of them is (or
    // contains) the full ModuleManifest, e.g. no "capabilities"/"agentTools" keys leak
    // into the database projection.
    expect(Object.keys((await registry.getDatabases())[0]!)).toEqual(["moduleId", "key", "name"]);
  });

  it("drops an inactive module from every projection", async () => {
    const registry = await loadBoth(() => new Set(["fixture-second"]));

    expect(await registry.getDatabases()).toEqual([
      { moduleId: "fixture-second", key: "fixtureSecondItems", name: "Fixture Second Items" },
    ]);
    expect(await registry.getViewTypes()).toEqual([]);
    expect(await registry.getSystemProjectModuleIds()).toEqual([]);
    expect(await registry.listActiveModuleIds()).toEqual(["fixture-second"]);
  });

  it("collects capabilities from active modules only, deduplicated across modules", async () => {
    const registry = await loadBoth(alwaysActive);
    // "fixtureGood.send" is declared by both fixtures but appears once.
    expect(await registry.getCapabilities()).toEqual(["fixtureGood.send", "fixtureSecond.onlyHere"]);

    const onlySecond = await loadBoth(() => new Set(["fixture-second"]));
    expect(await onlySecond.getCapabilities()).toEqual(["fixtureGood.send", "fixtureSecond.onlyHere"]);
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
    expect(await registry.getDatabases()).toEqual([
      { moduleId: "fixture-good", key: "fixtureGoodItems", name: "Fixture Good Items" },
    ]);
  });

  it("resolves task definitions to their actual imported schema/handler, active modules only", async () => {
    const registry = await loadBoth(alwaysActive);
    const definitions = await registry.getTaskDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.moduleId).toBe("fixture-good");
    expect(definitions[0]?.name).toBe("fixtureGood.processThing");
    expect(typeof definitions[0]?.handler).toBe("function");
    expect(typeof definitions[0]?.payloadSchema.parse).toBe("function");

    const inactive = await loadBoth(() => new Set(["fixture-second"]));
    expect(await inactive.getTaskDefinitions()).toEqual([]);
  });

  it("resolves heartbeat rule kind definitions to their actual imported schema/calculator, active modules only", async () => {
    const registry = await loadBoth(alwaysActive);
    const definitions = await registry.getHeartbeatRuleKindDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.moduleId).toBe("fixture-good");
    expect(definitions[0]?.kind).toBe("fixtureGood.onWidgetTick");
    expect(typeof definitions[0]?.nextFireAt).toBe("function");
    expect(typeof definitions[0]?.schema.safeParse).toBe("function");

    const inactive = await loadBoth(() => new Set(["fixture-second"]));
    expect(await inactive.getHeartbeatRuleKindDefinitions()).toEqual([]);
  });

  it("resolves data migration definitions to their actual imported converter, active modules only", async () => {
    const registry = await loadBoth(alwaysActive);
    const definitions = await registry.getDataMigrationDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      moduleId: "fixture-good",
      databaseKey: "fixtureGoodItems",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(typeof definitions[0]?.converter).toBe("function");

    const inactive = await loadBoth(() => new Set(["fixture-second"]));
    expect(await inactive.getDataMigrationDefinitions()).toEqual([]);
  });
});

describe("ModuleRegistry data migration validation", () => {
  it("rejects a data migration whose converterExport is missing", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("missingDataMigrationConverterModule.js"))).rejects.toThrow(
      /missing export "doesNotExist"/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a data migration targeting a database key this manifest doesn't declare", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("unknownDatabaseKeyDataMigrationModule.js"))).rejects.toThrow(
      /targets database key "notMyDatabase", which this manifest does not declare/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects the same (databaseKey, fromVersion, toVersion) declared twice in one manifest", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("duplicateDataMigrationModule.js"))).rejects.toThrow(
      /Duplicate data migration for database key "fixtureDupItems" \(1\.0\.0 -> 2\.0\.0\)/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });
});
