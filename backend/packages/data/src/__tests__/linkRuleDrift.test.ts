import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createDriftCheckAction,
  findInvalidLinkRuleReferences,
  findOrphanedOwnerProcessProperties,
  LINK_RULE_SCHEMA_DRIFT_FINDING_KIND,
} from "../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

function fixtureUrl(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

async function registryWith(...fixtures: Array<[id: string, file: string]>): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set(fixtures.map(([id]) => id)));
  for (const [, file] of fixtures) await registry.loadModule(fixtureUrl(file));
  return registry;
}

let pool: Pool;
let chokePoint: ChokePoint;

describe("link rule schema drift", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns nothing for a valid rule over the seeded ten databases", async () => {
    const registry = await registryWith(["fixtureLinkRuleValid", "linkRuleValidModule.js"]);
    const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
    expect(findings).toEqual([]);
  });

  it("does not use another tenant's properties for link rules or owner drift", async () => {
    const tenantB = await createTestTenant(pool);
    const db = await chokePoint.createDatabase({ name: "Owner drift fixture" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "orphan",
      name: "Orphan",
      type: "text",
      owner: "system",
      ownerProcess: "unknown",
    });
    const registry = await registryWith(["fixtureLinkRuleValid", "linkRuleValidModule.js"]);
    const runtime = await createRuntimeRolePool(pool, "semprec_side");
    try {
      for (const clientPool of [runtime, pool]) {
        await withTenantTransaction(clientPool, tenantB, async (client) => {
          const findings = await findInvalidLinkRuleReferences(client, registry);
          expect(findings.map((finding) => finding.reason)).toEqual([
            "missingSourceProperty",
            "missingTargetProperty",
            "missingViaProperty",
          ]);
          expect(await findOrphanedOwnerProcessProperties(client, new Set())).toEqual([]);
        });
      }
    } finally {
      await runtime.end();
    }
  });

  it("flags a misspelled property key, a misspelled or non-relation via, and a relation to the wrong database", async () => {
    const registry = await registryWith(["fixtureLinkRuleInvalid", "linkRuleInvalidModule.js"]);
    const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
    expect(findings).toEqual([
      {
        ruleKey: "fixtureInvalid.misspelledSource",
        moduleId: "fixtureLinkRuleInvalid",
        reason: "missingSourceProperty",
        property: "areas.nme",
      },
      {
        ruleKey: "fixtureInvalid.misspelledVia",
        moduleId: "fixtureLinkRuleInvalid",
        reason: "missingViaProperty",
        property: "projects.areaa",
      },
      {
        ruleKey: "fixtureInvalid.viaNotRelation",
        moduleId: "fixtureLinkRuleInvalid",
        reason: "viaNotRelation",
        property: "projects.name",
      },
      {
        ruleKey: "fixtureInvalid.wrongDirection",
        moduleId: "fixtureLinkRuleInvalid",
        reason: "viaDoesNotLeadToOtherDatabase",
        property: "areas.company",
      },
    ]);
  });

  it("ignores rules of inactive modules", async () => {
    const registry = new ModuleRegistry(() => new Set());
    await registry.loadModule(fixtureUrl("linkRuleInvalidModule.js"));
    const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
    expect(findings).toEqual([]);
  });

  it("reports a missing target property", async () => {
    const registry = await registryWith(["fixtureLinkRuleValid", "linkRuleValidModule.js"]);
    const rule = (await registry.getLinkRules())[0];
    if (!rule) throw new Error("Missing link rule fixture");
    const spy = vi
      .spyOn(registry, "getLinkRules")
      .mockResolvedValue([{ ...rule, target: { ...rule.target, propertyKey: "missingTarget" } }]);
    try {
      const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
      expect(findings).toContainEqual(
        expect.objectContaining({ reason: "missingTargetProperty", property: "projects.missingTarget" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a link_rule_schema_drift finding from the drift check action", async () => {
    const project = await chokePoint.createDatabase({ name: "Drift projects" });
    const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
    const registry = await registryWith(["fixtureLinkRuleInvalid", "linkRuleInvalidModule.js"]);

    await createDriftCheckAction(pool, { moduleRegistry: registry, locale: "en" })({}, {
      projectItemId: projectItem.id,
    } as never);

    const { rows } = await pool.query<{ payload: { invalidLinkRules: Array<{ ruleKey: string }> } }>(
      `SELECT payload FROM manifest_drift_findings WHERE kind = $1`,
      [LINK_RULE_SCHEMA_DRIFT_FINDING_KIND],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.invalidLinkRules.map((finding) => finding.ruleKey)).toEqual([
      "fixtureInvalid.misspelledSource",
      "fixtureInvalid.misspelledVia",
      "fixtureInvalid.viaNotRelation",
      "fixtureInvalid.wrongDirection",
    ]);
  });

  it("reports nothing for the full registry; guards every rule declared later", async () => {
    const registry = await loadFullModuleRegistry();
    const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
    expect(findings).toEqual([]);
  });

  it("the full registry guard detects newly declared invalid schema references", async () => {
    const registry = await loadFullModuleRegistry();
    const invalid = await registryWith(["fixtureLinkRuleInvalid", "linkRuleInvalidModule.js"]);
    const rules = [...(await registry.getLinkRules()), ...(await invalid.getLinkRules())];
    const spy = vi.spyOn(registry, "getLinkRules").mockResolvedValue(rules);
    try {
      const findings = await withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry));
      expect(findings.map((finding) => finding.reason)).toContain("missingSourceProperty");
      expect(findings.map((finding) => finding.reason)).toContain("missingViaProperty");
    } finally {
      spy.mockRestore();
    }
  });
});
