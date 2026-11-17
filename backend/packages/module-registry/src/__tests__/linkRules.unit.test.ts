import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../registry.js";
import { moduleManifestSchema } from "../manifest.js";

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

const baseManifest = {
  id: "m",
  version: "1.0.0",
  name: "M",
  removable: true,
  systemProject: false,
  databases: [{ key: "dbOne", name: "One" }],
  capabilities: [],
  agentTools: [],
};

const validRule = {
  key: "rule.one",
  source: { databaseKey: "dbOne", propertyKey: "a" },
  target: { databaseKey: "dbOne", propertyKey: "b" },
  via: { databaseKey: "dbOne", relationKey: "parent" },
};

const allActive = (): ReadonlySet<string> =>
  new Set(["fixture-link-a", "fixture-link-b", "fixture-link-duplicate", "fixture-link-unknown-db"]);

async function load(registry: ModuleRegistry, ...names: string[]): Promise<void> {
  for (const name of names) await registry.loadModule(fixturePath(name));
}

describe("link rule manifest schema", () => {
  it("accepts a valid rule and a manifest without linkRules", () => {
    expect(moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [validRule] }).success).toBe(true);
    expect(moduleManifestSchema.safeParse(baseManifest).success).toBe(true);
  });

  it("rejects unknown fields at every level", () => {
    const withExtra = (rule: object) => moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [rule] }).success;
    expect(withExtra({ ...validRule, filter: {} })).toBe(false);
    expect(withExtra({ ...validRule, source: { ...validRule.source, extra: 1 } })).toBe(false);
    expect(withExtra({ ...validRule, target: { ...validRule.target, extra: 1 } })).toBe(false);
    expect(withExtra({ ...validRule, via: { ...validRule.via, extra: 1 } })).toBe(false);
  });

  it("rejects empty keys", () => {
    const withRule = (rule: object) => moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [rule] }).success;
    expect(withRule({ ...validRule, key: "" })).toBe(false);
    expect(withRule({ ...validRule, source: { databaseKey: "", propertyKey: "a" } })).toBe(false);
    expect(withRule({ ...validRule, via: { databaseKey: "dbOne", relationKey: "" } })).toBe(false);
  });

  it("accepts a rule with a valueFilter that names the relation whose item is left out", () => {
    const rule = { ...validRule, valueFilter: { omit: { databaseKey: "settings", propertyKey: "selfPerson" } } };
    const parsed = moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [rule] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.linkRules).toEqual([rule]);
  });

  it("rejects a valueFilter without omit, with an unknown field or with an empty key", () => {
    const withFilter = (valueFilter: object) =>
      moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [{ ...validRule, valueFilter }] }).success;
    const omit = { databaseKey: "settings", propertyKey: "selfPerson" };
    expect(withFilter({ omit })).toBe(true);
    expect(withFilter({})).toBe(false);
    expect(withFilter({ omit, keep: omit })).toBe(false);
    expect(withFilter({ omit: { ...omit, extra: 1 } })).toBe(false);
    expect(withFilter({ omit: { databaseKey: "", propertyKey: "selfPerson" } })).toBe(false);
    expect(withFilter({ omit: { databaseKey: "settings", propertyKey: "" } })).toBe(false);
    expect(withFilter({ omit: { databaseKey: "settings" } })).toBe(false);
  });
});

const resolverRule = {
  key: "rule.resolved",
  target: { databaseKey: "dbOne", propertyKey: "company" },
  resolverExport: "someResolver",
};

describe("resolver link rule manifest schema", () => {
  const parse = (rule: object) => moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [rule] });

  it("accepts a resolver rule beside a via rule and keeps both as written", () => {
    const parsed = moduleManifestSchema.safeParse({ ...baseManifest, linkRules: [validRule, resolverRule] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.linkRules).toEqual([validRule, resolverRule]);
  });

  it("rejects a resolver rule with an unknown field, a source, a via or an empty key", () => {
    expect(parse({ ...resolverRule, extra: 1 }).success).toBe(false);
    expect(parse({ ...resolverRule, source: validRule.source }).success).toBe(false);
    expect(parse({ ...resolverRule, via: validRule.via }).success).toBe(false);
    expect(parse({ ...resolverRule, resolverExport: "" }).success).toBe(false);
    expect(parse({ ...resolverRule, key: "" }).success).toBe(false);
    expect(parse({ ...resolverRule, target: { ...resolverRule.target, extra: 1 } }).success).toBe(false);
  });

  it("rejects a rule that names both a resolver and a via", () => {
    expect(parse({ ...validRule, resolverExport: "someResolver" }).success).toBe(false);
  });
});

describe("ModuleRegistry resolver link rules", () => {
  const resolverActive = (): ReadonlySet<string> =>
    new Set([
      "fixture-link-resolver",
      "fixture-link-a",
      "fixture-link-resolver-missing",
      "fixture-link-resolver-not-object",
      "fixture-link-resolver-unknown-db",
      "fixture-link-resolver-duplicate",
    ]);

  it("loads a resolver rule next to a via rule and validates both", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await load(registry, "linkRulesResolverModule.js");
    expect(() => registry.validateLinkRules()).not.toThrow();
  });

  it("getLinkRules leaves the resolver rule out and getLinkResolverRules returns it with the module's export", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await load(registry, "linkRulesResolverModule.js");
    expect((await registry.getLinkRules()).map((rule) => rule.key)).toEqual(["fixtureLink.viaBesideResolver"]);
    const exported = (await import(fixturePath("linkRulesResolverModule.js"))) as { fixtureResolver: object };
    expect(await registry.getLinkResolverRules()).toEqual([
      {
        moduleId: "fixture-link-resolver",
        key: "fixtureLink.resolved",
        target: { databaseKey: "linkResolverItems", propertyKey: "company" },
        resolver: exported.fixtureResolver,
      },
    ]);
  });

  it("getLinkResolverRules omits the rules of an inactive module", async () => {
    const active = new Set(["fixture-link-resolver"]);
    const registry = new ModuleRegistry(() => active);
    await load(registry, "linkRulesResolverModule.js");
    expect(await registry.getLinkResolverRules()).toHaveLength(1);
    active.clear();
    expect(await registry.getLinkResolverRules()).toEqual([]);
  });

  it("fails loading a resolver export the module does not have", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await expect(load(registry, "linkRulesResolverMissingExportModule.js")).rejects.toThrow(
      /link rule "fixtureLink.resolverMissing" references missing export "noSuchResolver"/,
    );
  });

  it("fails loading a resolver export that is not an object", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await expect(load(registry, "linkRulesResolverNotObjectModule.js")).rejects.toThrow(
      /link rule "fixtureLink.resolverNotObject" export "notAnObject" is not an object/,
    );
  });

  it("fails validation when the resolver rule's target names a database no loaded module declares", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await load(registry, "linkRulesResolverUnknownDatabaseModule.js");
    expect(() => registry.validateLinkRules()).toThrow(/"fixtureLink.resolverUnknownDatabase".*"noSuchDatabase"/);
  });

  it("fails loading a resolver rule whose key a via rule of another module already claimed", async () => {
    const registry = new ModuleRegistry(resolverActive);
    await load(registry, "linkRulesAModule.js");
    await expect(load(registry, "linkRulesResolverDuplicateKeyModule.js")).rejects.toThrow(
      /Duplicate link rule key "fixtureLink.aToB".*already claimed by module "fixture-link-a"/,
    );
  });
});

describe("ModuleRegistry link rules", () => {
  it("fails loading a rule key already claimed by another module", async () => {
    const registry = new ModuleRegistry(allActive);
    await load(registry, "linkRulesAModule.js");
    await expect(load(registry, "linkRulesDuplicateKeyModule.js")).rejects.toThrow(
      /Duplicate link rule key "fixtureLink.aToB".*already claimed by module "fixture-link-a"/,
    );
  });

  it("fails loading a rule key declared twice in one manifest", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-duplicate-within"]));
    await expect(load(registry, "linkRulesDuplicateWithinModule.js")).rejects.toThrow(
      /Duplicate link rule key "fixtureLink.twice".*same manifest/,
    );
  });

  it("validates rules spread over two modules, with two rules sharing a target", async () => {
    const registry = new ModuleRegistry(allActive);
    await load(registry, "linkRulesAModule.js", "linkRulesBModule.js");
    expect(() => registry.validateLinkRules()).not.toThrow();
  });

  it("fails when a rule names a database no loaded module declares, naming the rule", async () => {
    const registry = new ModuleRegistry(allActive);
    await load(registry, "linkRulesUnknownDatabaseModule.js");
    expect(() => registry.validateLinkRules()).toThrow(/"fixtureLink.unknownDatabase".*"noSuchDatabase"/);
  });

  it("fails when a cross-module rule is validated before the other module is loaded", async () => {
    const registry = new ModuleRegistry(allActive);
    await load(registry, "linkRulesAModule.js");
    expect(() => registry.validateLinkRules()).toThrow(/"fixtureLink.aToB".*"linkBItems"/);
  });

  it("fails when via names a database that is neither source nor target", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-unrelated-via"]));
    await load(registry, "linkRulesUnrelatedViaModule.js");
    expect(() => registry.validateLinkRules()).toThrow(/"fixtureLink.unrelatedVia".*"linkViaThree"/);
  });

  it("fails on a two-rule cycle and names both rules", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-two-cycle"]));
    await load(registry, "linkRulesTwoCycleModule.js");
    expect(() => registry.validateLinkRules()).toThrow(
      /cycle: "fixtureLink.twoCycle1" -> "fixtureLink.twoCycle2"|cycle: "fixtureLink.twoCycle2" -> "fixtureLink.twoCycle1"/,
    );
  });

  it("detects a cycle whose rules are declared in different modules", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-a", "fixture-link-cross-cycle"]));
    await load(registry, "linkRulesAModule.js", "linkRulesCrossCycleModule.js");
    expect(() => registry.validateLinkRules()).toThrow(
      /fixtureLink\.aToB.*fixtureLink\.bToA|fixtureLink\.bToA.*fixtureLink\.aToB/,
    );
  });

  it("fails on a three-rule cycle and names all three rules", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-three-cycle"]));
    await load(registry, "linkRulesThreeCycleModule.js");
    let message = "";
    try {
      registry.validateLinkRules();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("cycle");
    for (const key of ["fixtureLink.threeCycle1", "fixtureLink.threeCycle2", "fixtureLink.threeCycle3"]) {
      expect(message).toContain(`"${key}"`);
    }
  });

  it("getLinkRules returns rules with their module id in load order and omits inactive modules", async () => {
    const active = new Set(["fixture-link-a", "fixture-link-b"]);
    const registry = new ModuleRegistry(() => active);
    await load(registry, "linkRulesAModule.js", "linkRulesBModule.js");
    expect((await registry.getLinkRules()).map((rule) => [rule.moduleId, rule.key])).toEqual([
      ["fixture-link-a", "fixtureLink.aToB"],
      ["fixture-link-b", "fixtureLink.bToB"],
    ]);

    active.delete("fixture-link-a");
    expect((await registry.getLinkRules()).map((rule) => rule.key)).toEqual(["fixtureLink.bToB"]);
  });

  it("accepts a valueFilter over a database no module declares and projects it only for the rule that has one", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-link-value-filter"]));
    await load(registry, "linkRulesValueFilterModule.js");
    expect(() => registry.validateLinkRules()).not.toThrow();
    const [filtered, unfiltered] = await registry.getLinkRules();
    expect(filtered).toEqual({
      moduleId: "fixture-link-value-filter",
      key: "fixtureLink.filtered",
      source: { databaseKey: "linkFilterItems", propertyKey: "people" },
      target: { databaseKey: "linkFilterItems", propertyKey: "guests" },
      via: { databaseKey: "linkFilterItems", relationKey: "parent" },
      valueFilter: { omit: { databaseKey: "fixtureSettings", propertyKey: "selfPerson" } },
    });
    expect(unfiltered?.key).toBe("fixtureLink.unfiltered");
    expect(unfiltered && Object.hasOwn(unfiltered, "valueFilter")).toBe(false);
  });

  it("returns no rules for a module without linkRules", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-good"]));
    await registry.loadModule(fixturePath("goodModule.js"));
    expect(await registry.getLinkRules()).toEqual([]);
    expect(() => registry.validateLinkRules()).not.toThrow();
  });
});
