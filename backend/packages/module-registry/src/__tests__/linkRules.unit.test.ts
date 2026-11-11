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
