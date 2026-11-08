import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleManifestSchema, type ModuleManifest } from "../manifest.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleRegistry } from "../registry.js";
import { loadModuleCatalogs } from "../catalog.js";
import {
  editorConditionSchema,
  editorFieldValueSchema,
  editorFieldDescriptorSchema,
  editorGroupDescriptorSchema,
  editorSchemaDescriptorSchema,
} from "../index.js";

// `../catalog.js`'s named export binding can't be `vi.spyOn`'d directly under vitest's
// ESM module loader, so `vi.mock` with a factory that wraps the real implementation in a
// `vi.fn` is the supported way to observe calls while every test keeps the real behavior.
vi.mock("../catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalog.js")>();
  return {
    ...actual,
    loadModuleCatalogs: vi.fn(actual.loadModuleCatalogs),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

const alwaysActive: () => ReadonlySet<string> = () => new Set(["fixture-good", "fixture-second"]);

describe("ModuleRegistry.loadModule", () => {
  it("exports the editor schemas through the public entry point", () => {
    const field = { key: "name", control: "text", labelKey: "name" };
    const group = { key: "main", fields: [field] };
    expect(editorFieldValueSchema.parse("value")).toBe("value");
    expect(editorConditionSchema.parse({ field: "name", equals: "value" })).toEqual({ field: "name", equals: "value" });
    expect(editorFieldDescriptorSchema.parse(field)).toEqual(field);
    expect(editorGroupDescriptorSchema.parse(group)).toEqual(group);
    expect(editorSchemaDescriptorSchema.parse({ groups: [group] })).toEqual({ groups: [group] });
  });
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

  it("rejects a module tool whose argument schema cannot be projected", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("invalidToolSchemaModule.js"))).rejects.toThrow(
      /invalid argument schema/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a task descriptor missing queueAffinity", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("missingQueueAffinityTaskModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a task descriptor with an unknown queueAffinity value", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("invalidQueueAffinityTaskModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
    expect(registry.listModuleIds()).toEqual([]);
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

describe("ModuleRegistry custom routes (issue #239)", () => {
  it("rejects a custom route colliding on method+path with one already claimed by another module, identifying both owners", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));

    await expect(registry.loadModule(fixturePath("duplicateCustomRouteModule.js"))).rejects.toThrow(
      /Duplicate custom route "GET \/api\/fixture-good\/thing" loading .*: module "fixture-duplicate-custom-route" and module "fixture-good" both register it/,
    );
    expect(registry.listModuleIds()).toEqual(["fixture-good"]);
  });

  it("rejects the same method+path declared twice within one manifest", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("customRouteDuplicateWithinManifestModule.js"))).rejects.toThrow(
      /Duplicate custom route "POST \/api\/fixture-self-dupe\/thing" declared twice in module "fixture-custom-route-duplicate-within-manifest"/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a custom route path outside the flat /api namespace", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("customRouteInvalidPathModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a custom route with no justification", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("customRouteMissingJustificationModule.js"))).rejects.toThrow(
      /invalid manifest/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a custom route referencing a missing handler export", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("customRouteMissingExportModule.js"))).rejects.toThrow(
      /custom route "fixtureMissingExport.thing" references missing export "doesNotExist"/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("resolves custom route definitions to their actual imported handler, active modules only", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("goodModule.js"));

    const definitions = await registry.getCustomRouteDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.moduleId).toBe("fixture-good");
    expect(definitions[0]?.method).toBe("GET");
    expect(definitions[0]?.path).toBe("/api/fixture-good/thing");
    expect(typeof definitions[0]?.handler).toBe("function");

    const inactive = new ModuleRegistry(() => new Set());
    await inactive.loadModule(fixturePath("goodModule.js"));
    expect(await inactive.getCustomRouteDefinitions()).toEqual([]);
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
        queueAffinity: "api",
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
    const definitions = await registry.getAgentToolDefinitions(new Set(["fixtureGood.send"]));
    expect(definitions.map((tool) => tool.name)).toEqual(["fixtureGood.doThing"]);
    expect(definitions[0]?.parseArguments({}).success).toBe(true);
    expect(definitions[0]?.argumentSchema).toMatchObject({ type: "object" });
    expect(await registry.getAgentToolDefinitions(new Set())).toEqual([]);
  });

  it("requires a safe explicit classification and the permission for conditional approval", () => {
    const base = { name: "sample", handlerExport: "handler", argumentSchemaExport: "schema" };
    const valid = (tool: unknown) =>
      moduleManifestSchema.safeParse({
        id: "sample",
        version: "1",
        name: "Sample",
        removable: true,
        systemProject: false,
        databases: [],
        capabilities: [],
        agentTools: [tool],
      }).success;
    expect(valid(base)).toBe(false);
    expect(valid({ ...base, approval: "none", riskClass: "destructive" })).toBe(false);
    expect(valid({ ...base, approval: "none", riskClass: "unclassified" })).toBe(false);
    expect(valid({ ...base, approval: "none", riskClass: "write" })).toBe(true);
    expect(valid({ ...base, approval: "unlessProjectPermitted" })).toBe(false);
    expect(valid({ ...base, approval: "unlessProjectPermitted", projectPermission: "allowed" })).toBe(true);
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

describe("ModuleRegistry.loadModule catalogs (issue #236)", () => {
  it("loads a module's cs/en catalogs from beside its manifest", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-catalog-good"]));
    await registry.loadModule(fixturePath("catalogGood/module.js"));

    expect(await registry.getCatalogs("fixture-catalog-good")).toEqual({
      cs: { "database.fixtureCatalogGood.name": "Fixtura dobrého katalogu" },
      en: { "database.fixtureCatalogGood.name": "Fixture Catalog Good" },
    });
  });

  it("loads a module with no i18n/ directory with empty catalogs, not undefined", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-good"]));
    await registry.loadModule(fixturePath("goodModule.js"));

    expect(await registry.getCatalogs("fixture-good")).toEqual({ cs: {}, en: {} });
  });

  it("returns undefined for an inactive or unknown module id", async () => {
    const registry = new ModuleRegistry(() => new Set());
    await registry.loadModule(fixturePath("catalogGood/module.js"));

    expect(await registry.getCatalogs("fixture-catalog-good")).toBeUndefined();
    expect(await registry.getCatalogs("does-not-exist")).toBeUndefined();
  });

  it("rejects a module with a malformed (invalid JSON) catalog file", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("catalogMalformedJson/module.js"))).rejects.toThrow(
      /malformed i18n catalog/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a module whose catalog has a non-string value", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("catalogNonStringValue/module.js"))).rejects.toThrow(
      /invalid i18n catalog/,
    );
    expect(registry.listModuleIds()).toEqual([]);
  });

  it("rejects a catalog key already claimed by a previously loaded module, without partially registering the rejected module", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(fixturePath("catalogDuplicateKeyA/module.js"));

    await expect(registry.loadModule(fixturePath("catalogDuplicateKeyB/module.js"))).rejects.toThrow(
      /Duplicate i18n catalog key "database.fixtureCatalogShared.name" loading .* \(already claimed by module "fixture-catalog-duplicate-key-a"\)/,
    );
    expect(registry.listModuleIds()).toEqual(["fixture-catalog-duplicate-key-a"]);
  });
});

describe("ModuleRegistry.loadModule check ordering (issue #783)", () => {
  it("rejects a module failing assertExportsExist without loading its catalogs", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("missingExportModule.js"))).rejects.toThrow(
      /missing export "doesNotExist"/,
    );
    expect(loadModuleCatalogs).not.toHaveBeenCalled();
  });

  it("rejects a module failing assertDataMigrationsReferenceOwnDatabases without loading its catalogs", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await expect(registry.loadModule(fixturePath("unknownDatabaseKeyDataMigrationModule.js"))).rejects.toThrow(
      /targets database key "notMyDatabase", which this manifest does not declare/,
    );
    expect(loadModuleCatalogs).not.toHaveBeenCalled();
  });

  it("still loads and commits catalogs for a module passing both synchronous checks", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-catalog-good"]));
    const moduleId = await registry.loadModule(fixturePath("catalogGood/module.js"));

    expect(moduleId).toBe("fixture-catalog-good");
    expect(loadModuleCatalogs).toHaveBeenCalledTimes(1);
    expect(await registry.getCatalogs("fixture-catalog-good")).toEqual({
      cs: { "database.fixtureCatalogGood.name": "Fixtura dobrého katalogu" },
      en: { "database.fixtureCatalogGood.name": "Fixture Catalog Good" },
    });
  });
});

describe("ModuleRegistry editor schemas (issue #1417)", () => {
  const editorSchema = {
    groups: [
      {
        key: "server",
        fields: [{ key: "name", control: "text", labelKey: "fixture.editor.name.label", required: true }],
      },
    ],
  };

  it("projects the editor schema of an active module", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-editor"]));
    await registry.loadModule(fixturePath("editorSchemaModule.js"));

    expect(await registry.getEditorSchemas()).toEqual([
      { moduleId: "fixture-editor", baseKind: "mcp", schema: editorSchema },
    ]);
  });

  it("omits the editor schema of an inactive module while the module stays loaded", async () => {
    const registry = new ModuleRegistry(() => new Set());
    await registry.loadModule(fixturePath("editorSchemaModule.js"));

    expect(await registry.getEditorSchemas()).toEqual([]);
    expect(registry.listModuleIds()).toEqual(["fixture-editor"]);
  });

  it("returns a copy, so changing a projected schema leaves the registry's schema unchanged", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-editor"]));
    await registry.loadModule(fixturePath("editorSchemaModule.js"));

    const [first] = await registry.getEditorSchemas();
    const firstField = first?.schema.groups[0]?.fields[0];
    if (firstField === undefined) throw new Error("expected the fixture's first field");
    firstField.required = false;

    expect(await registry.getEditorSchemas()).toEqual([
      { moduleId: "fixture-editor", baseKind: "mcp", schema: editorSchema },
    ]);
  });

  it("rejects a second module declaring the same base kind, naming both modules, and keeps the first module registered", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-editor", "fixture-editor-duplicate"]));
    await registry.loadModule(fixturePath("editorSchemaModule.js"));

    await expect(registry.loadModule(fixturePath("editorSchemaDuplicateModule.js"))).rejects.toThrow(
      /Duplicate editor schema base kind "mcp" loading .*: module "fixture-editor-duplicate" and module "fixture-editor" both declare it/,
    );
    expect(registry.listModuleIds()).toEqual(["fixture-editor"]);
    expect(await registry.getEditorSchemas()).toEqual([
      { moduleId: "fixture-editor", baseKind: "mcp", schema: editorSchema },
    ]);
  });

  it("rejects the duplicate base kind even while the first declaring module is inactive", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-editor-duplicate"]));
    await registry.loadModule(fixturePath("editorSchemaModule.js"));

    await expect(registry.loadModule(fixturePath("editorSchemaDuplicateModule.js"))).rejects.toThrow(
      /Duplicate editor schema base kind "mcp"/,
    );
  });
});

describe("related collection order", () => {
  const base = {
    id: "related",
    name: "Related",
    version: "1.0.0",
    removable: true,
    systemProject: false,
    databases: [],
    capabilities: [],
    agentTools: [],
    viewTypes: [],
    migrations: [],
  } satisfies ModuleManifest;
  const manifestWith = (relatedOrder: unknown) => ({
    ...base,
    databases: [{ key: "projects", name: "Projects", relatedOrder }],
  });

  it.each([{ order: [], omit: [] }, { order: ["tasks"] }, { order: ["tasks", "unknown"], omit: ["journal"] }])(
    "accepts valid related order without requiring every key to be known: %s",
    (relatedOrder) => {
      expect(moduleManifestSchema.safeParse(manifestWith(relatedOrder)).success).toBe(true);
    },
  );
  it.each([
    { order: [""] },
    { order: [], omit: [""] },
    { order: ["tasks", "tasks"] },
    { order: [], omit: ["tasks", "tasks"] },
    { order: ["tasks"], omit: ["tasks"] },
    { omit: ["tasks"] },
  ])("rejects empty strings and duplicates within or across lists: %s", (relatedOrder) => {
    expect(moduleManifestSchema.safeParse(manifestWith(relatedOrder)).success).toBe(false);
  });

  let directory: string;
  let ordinal = 0;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "semprec-related-order-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function load(registry: ModuleRegistry, manifest: ModuleManifest) {
    const path = join(directory, `manifest-${ordinal++}.mjs`);
    await writeFile(path, `export const manifest = ${JSON.stringify(manifest)};`);
    await registry.loadModule(pathToFileURL(path).href);
  }
  async function createRegistry() {
    const active = new Set(["related", "optional"]);
    const registry = new ModuleRegistry(() => active);
    await load(registry, {
      ...base,
      databases: [
        {
          key: "projects",
          name: "Projects",
          relatedOrder: {
            order: ["people", "optionalItems", "unknown"],
            omit: ["tasks", "optionalHidden", "missingOmit"],
          },
        },
        { key: "people", name: "People", relatedOrder: { order: ["projects", "tasks"] } },
        { key: "tasks", name: "Tasks" },
        { key: "empty", name: "Empty", relatedOrder: { order: [] } },
      ],
    });
    await load(registry, {
      ...base,
      id: "optional",
      name: "Optional",
      databases: [
        { key: "optionalItems", name: "Optional items" },
        { key: "optionalHidden", name: "Optional hidden" },
      ],
    });
    return { registry, active };
  }
  it("projects a copy of the full declaration and leaves undeclared fields absent", async () => {
    const { registry } = await createRegistry();
    const databases = await registry.getDatabases();
    const relatedOrder = databases.find((db) => db.key === "projects")?.relatedOrder;
    expect(relatedOrder).toEqual({
      order: ["people", "optionalItems", "unknown"],
      omit: ["tasks", "optionalHidden", "missingOmit"],
    });
    expect(databases.find((db) => db.key === "tasks")).not.toHaveProperty("relatedOrder");
    if (!relatedOrder?.omit) throw new Error("Expected the projected lists");
    relatedOrder.order.push("mutated");
    relatedOrder.omit.push("mutatedOmit");
    expect((await registry.getDatabases()).find((db) => db.key === "projects")?.relatedOrder).toEqual({
      order: ["people", "optionalItems", "unknown"],
      omit: ["tasks", "optionalHidden", "missingOmit"],
    });
  });
  it("filters unknown/inactive keys in both lists and rechecks activation on every call", async () => {
    const { registry, active } = await createRegistry();
    expect(await registry.getRelatedOrder("projects")).toEqual({
      order: ["people", "optionalItems"],
      omit: ["tasks", "optionalHidden"],
    });
    active.delete("optional");
    expect(await registry.getRelatedOrder("projects")).toEqual({ order: ["people"], omit: ["tasks"] });
    active.add("optional");
    expect(await registry.getRelatedOrder("projects")).toEqual({
      order: ["people", "optionalItems"],
      omit: ["tasks", "optionalHidden"],
    });
  });
  it("omits Tasks only for Projects and defaults an absent omit to an empty list", async () => {
    const { registry } = await createRegistry();
    expect((await registry.getRelatedOrder("projects"))?.order).not.toContain("tasks");
    expect(await registry.getRelatedOrder("people")).toEqual({ order: ["projects", "tasks"], omit: [] });
    const resolved = await registry.getRelatedOrder("people");
    resolved?.order.push("mutated");
    expect(await registry.getRelatedOrder("people")).toEqual({ order: ["projects", "tasks"], omit: [] });
  });
  it("returns undefined for undeclared, unknown or inactive source databases, preserving a declared empty list", async () => {
    const { registry, active } = await createRegistry();
    expect(await registry.getRelatedOrder("tasks")).toBeUndefined();
    expect(await registry.getRelatedOrder("unknown")).toBeUndefined();
    expect(await registry.getRelatedOrder("empty")).toEqual({ order: [], omit: [] });
    active.delete("related");
    expect(await registry.getRelatedOrder("projects")).toBeUndefined();
  });
});

describe("database quick filters, default sorts and collection and picker filters (issue #1647)", () => {
  const filter = { type: "in", property: "status", value: ["done"] };
  const declared = {
    key: "projects",
    name: "Projects",
    quickFilters: [
      { key: "active", labelKey: "quickFilter.projects.active", filter, isDefault: true },
      { key: "past", labelKey: "quickFilter.projects.past", sort: [{ property: "date", direction: "desc" }] },
      { key: "all", labelKey: "quickFilter.projects.all" },
    ],
    defaultSort: { property: "date", direction: "asc" },
    dateLabels: { pastLabelKey: "dateLabel.projects.past", noDateLabelKey: "dateLabel.projects.noDate" },
    collectionFilter: { type: "is_empty", property: "systemActive" },
    pickerFilter: { type: "and", nodes: [{ type: "is_empty", property: "systemActive" }] },
  };
  const base = {
    id: "quickFilters",
    version: "1.0.0",
    name: "Quick filters",
    removable: true,
    systemProject: false,
    capabilities: [],
    agentTools: [],
  };
  function manifestWith(database: Record<string, unknown>): unknown {
    return { ...base, databases: [database] };
  }

  let directory: string;
  let ordinal = 0;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "semprec-quick-filters-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function load(registry: ModuleRegistry, manifest: unknown): Promise<void> {
    const path = join(directory, `manifest-${ordinal++}.mjs`);
    await writeFile(path, `export const manifest = ${JSON.stringify(manifest)};`);
    await registry.loadModule(pathToFileURL(path).href);
  }

  it("loads the declarations and projects a copy of them; a database without any projects none", async () => {
    const registry = new ModuleRegistry(() => new Set(["quickFilters"]));
    await load(registry, { ...base, databases: [declared, { key: "plain", name: "Plain" }] });
    const databases = await registry.getDatabases();
    expect(databases).toEqual([
      { moduleId: "quickFilters", ...declared },
      { moduleId: "quickFilters", key: "plain", name: "Plain" },
    ]);
    // Editing a projection cannot change what the next projection returns.
    databases[0]?.quickFilters?.splice(0);
    const collectionFilter = databases[0]?.collectionFilter;
    if (collectionFilter) collectionFilter.property = "changed";
    expect((await registry.getDatabases())[0]).toEqual({ moduleId: "quickFilters", ...declared });
  });

  it("rejects a manifest declaring two default quick filters when the module is loaded", async () => {
    const registry = new ModuleRegistry(() => new Set(["quickFilters"]));
    const twoDefaults = {
      ...declared,
      quickFilters: [
        { key: "active", labelKey: "a", isDefault: true },
        { key: "done", labelKey: "b", isDefault: true },
      ],
    };
    await expect(load(registry, manifestWith(twoDefaults))).rejects.toThrow(/invalid manifest/);
    expect(registry.listModuleIds()).toEqual([]);
    expect(moduleManifestSchema.safeParse(manifestWith(twoDefaults)).error?.issues).toEqual([
      expect.objectContaining({
        path: ["databases", 0, "quickFilters"],
        message: "At most one quick filter may be the default",
      }),
    ]);
  });

  it("rejects duplicate quick-filter keys within one database", () => {
    const duplicate = {
      ...declared,
      quickFilters: [
        { key: "all", labelKey: "a" },
        { key: "all", labelKey: "b" },
      ],
    };
    expect(moduleManifestSchema.safeParse(manifestWith(duplicate)).error?.issues).toEqual([
      expect.objectContaining({
        path: ["databases", 0, "quickFilters", 1, "key"],
        message: "Duplicate quick filter key 'all'",
      }),
    ]);
  });

  it("accepts a single default, no default, and the same chip key in two databases", () => {
    expect(moduleManifestSchema.safeParse(manifestWith(declared)).success).toBe(true);
    const noDefault = { ...declared, quickFilters: [{ key: "all", labelKey: "a", isDefault: false }] };
    expect(moduleManifestSchema.safeParse(manifestWith(noDefault)).success).toBe(true);
    const twoDatabases = { ...base, databases: [declared, { ...declared, key: "other" }] };
    expect(moduleManifestSchema.safeParse(twoDatabases).success).toBe(true);
  });

  it.each([
    ["a quick filter whose filter is an array", { quickFilters: [{ key: "a", labelKey: "a", filter: [filter] }] }],
    ["a quick filter whose filter is a string", { quickFilters: [{ key: "a", labelKey: "a", filter: "status=done" }] }],
    ["a null collection filter", { collectionFilter: null }],
    ["a picker filter that is a number", { pickerFilter: 1 }],
    ["a quick filter without a label key", { quickFilters: [{ key: "a" }] }],
    ["a quick filter with an unknown field", { quickFilters: [{ key: "a", labelKey: "a", label: "A" }] }],
    ["a default sort with an unknown direction", { defaultSort: { property: "date", direction: "up" } }],
    [
      "a quick-filter sort with an empty property",
      { quickFilters: [{ key: "a", labelKey: "a", sort: [{ property: "", direction: "asc" }] }] },
    ],
    ["date labels missing the no-date key", { dateLabels: { pastLabelKey: "p" } }],
  ])("rejects %s", (_name, change) => {
    expect(moduleManifestSchema.safeParse(manifestWith({ key: "projects", name: "Projects", ...change })).success).toBe(
      false,
    );
  });

  describe("opaque filters are bounded JSON objects", () => {
    /** `levels` objects nested in one another, the outermost first: `{ child: { child: { type: "leaf" } } }`. */
    function nestedObjects(levels: number): Record<string, unknown> {
      let value: Record<string, unknown> = { type: "leaf" };
      for (let level = 1; level < levels; level += 1) value = { child: value };
      return value;
    }
    /** A root object holding `arrays` arrays nested in one another, around one string. */
    function nestedArrays(arrays: number): Record<string, unknown> {
      let value: unknown = "leaf";
      for (let level = 0; level < arrays; level += 1) value = [value];
      return { nodes: value };
    }
    /** A root object with `values - 1` numeric properties: `values` values in all, the root included. */
    function flatObject(values: number): Record<string, unknown> {
      return Object.fromEntries(Array.from({ length: values - 1 }, (_, index) => [`k${index}`, index]));
    }
    /** A root holding one array that holds `shared` twice: 2 + 2 × (values of `shared`) values. */
    function twoAliases(sharedValues: number): Record<string, unknown> {
      const shared = flatObject(sharedValues);
      return { nodes: [shared, shared] };
    }
    function parsesAsCollectionFilter(collectionFilter: unknown): boolean {
      return moduleManifestSchema.safeParse(manifestWith({ key: "projects", name: "Projects", collectionFilter }))
        .success;
    }
    class FilterNode {
      type = "is_empty";
    }
    class FilterNodes extends Array<unknown> {}

    const selfCycle: Record<string, unknown> = { type: "and", nodes: [] };
    selfCycle.self = selfCycle;
    const arrayCycle: Record<string, unknown> = { type: "and" };
    arrayCycle.nodes = [{ type: "or", nodes: [arrayCycle] }];
    const sparse: unknown[] = ["a"];
    sparse[2] = "c";
    const arrayWithExtra = Object.assign(["a"], { extra: true });
    const hidden: Record<string, unknown> = { type: "is_empty" };
    Object.defineProperty(hidden, "property", { value: "systemActive", enumerable: false });

    it.each([
      ["a Date", new Date(0)],
      ["a class instance", new FilterNode()],
      ["a Map", new Map([["type", "is_empty"]])],
      ["a nested Date", { type: "in", value: new Date(0) }],
      ["a nested class instance", { type: "and", nodes: [new FilterNode()] }],
      ["a nested boxed string", { type: "in", value: new String("done") }],
      ["a nested function", { type: "in", value: () => "done" }],
      ["a nested undefined", { type: "in", value: undefined }],
      ["a nested symbol", { type: "in", value: Symbol("done") }],
      ["a symbol key", { type: "in", [Symbol("key")]: "done" }],
      ["a nested bigint", { type: "in", value: 1n }],
      ["a nested NaN", { type: "in", value: Number.NaN }],
      ["a nested Infinity", { type: "in", value: Number.POSITIVE_INFINITY }],
      ["a nested -Infinity", { type: "in", value: Number.NEGATIVE_INFINITY }],
      ["an object that contains itself", selfCycle],
      ["an object that contains itself through an array", arrayCycle],
      ["an array with a hole", { type: "in", value: sparse }],
      ["an array with a property beyond its indices", { type: "in", value: arrayWithExtra }],
      ["an Array subclass instance", { type: "and", nodes: FilterNodes.from([{ type: "is_empty" }]) }],
      ["a non-enumerable property", hidden],
      ["33 nested objects", nestedObjects(33)],
      ["a root object around 32 nested arrays", nestedArrays(32)],
      ["1025 values", flatObject(1025)],
      ["one value shared on two paths, counted on each, past 1024 values", twoAliases(512)],
    ])("refuses %s", (_name, collectionFilter) => {
      expect(parsesAsCollectionFilter(collectionFilter)).toBe(false);
    });

    it.each([
      ["a null-prototype root", Object.assign(Object.create(null) as Record<string, unknown>, { type: "is_empty" })],
      ["32 nested objects", nestedObjects(32)],
      ["a root object around 31 nested arrays", nestedArrays(31)],
      ["1024 values", flatObject(1024)],
      ["one acyclic value shared on two paths, 1024 values counted on each", twoAliases(511)],
      ["strings, booleans, null and finite numbers, with -0", { a: "s", b: true, c: null, d: 1.5, e: -0, f: [] }],
    ])("accepts %s", (_name, collectionFilter) => {
      expect(parsesAsCollectionFilter(collectionFilter)).toBe(true);
    });

    it("reads no accessor while refusing it", () => {
      let read = false;
      const accessor = {
        type: "is_empty",
        get property(): string {
          read = true;
          return "systemActive";
        },
      };
      expect(parsesAsCollectionFilter(accessor)).toBe(false);
      expect(read).toBe(false);
    });

    it.each([
      [
        "a quick filter's filter",
        { quickFilters: [{ key: "a", labelKey: "a", filter: { type: "in", value: () => 1 } }] },
      ],
      ["a collection filter", { collectionFilter: { type: "in", value: () => 1 } }],
      ["a picker filter", { pickerFilter: { type: "in", value: () => 1 } }],
    ])("refuses a function inside %s", (_name, change) => {
      expect(
        moduleManifestSchema.safeParse(manifestWith({ key: "projects", name: "Projects", ...change })).error?.issues,
      ).toEqual([
        expect.objectContaining({ message: "must be a JSON object of at most 32 nested levels and 1024 values" }),
      ]);
    });

    it("refuses a module whose manifest declares a function inside a filter when it is loaded", async () => {
      const registry = new ModuleRegistry(() => new Set(["quickFilters"]));
      const path = join(directory, `manifest-${ordinal++}.mjs`);
      await writeFile(
        path,
        [
          `export const manifest = ${JSON.stringify(manifestWith({ key: "projects", name: "Projects" }))};`,
          `manifest.databases[0].pickerFilter = { type: "in", property: "status", value: () => "done" };`,
        ].join("\n"),
      );
      await expect(registry.loadModule(pathToFileURL(path).href)).rejects.toThrow(/invalid manifest/);
      expect(registry.listModuleIds()).toEqual([]);
      expect(await registry.getDatabases()).toEqual([]);
    });
  });
});
