import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleManifest } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

export const manifest: ModuleManifest = {
  id: "fixtureValueLinkUnion",
  version: "1.0.0",
  name: "Fixture Value Link Union",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureUnion.projectCompanies",
      source: { databaseKey: "projects", propertyKey: "company" },
      target: { databaseKey: "files", propertyKey: "companies" },
      via: { databaseKey: "files", relationKey: "projects" },
    },
  ],
};

let admin: Pool;
let data: Pool;
let tenant: string;

describe("value link via-edge union", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureValueLinkUnion", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(import.meta.url);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check union role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(data));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await data?.end();
    await admin?.end();
  });

  it("unions two sources, recomputes after unlinking and retains the last value as own", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const id = (module: string) => {
        const row = dbs.find((db) => db.ownerModuleId === module);
        if (!row) throw new Error(`Missing ${module}`);
        return row.id;
      };
      const projects = id("projects"),
        files = id("files"),
        companies = id("companies");
      const prop = async (databaseId: string, key: string) => {
        const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key}`);
        return property.id;
      };
      const companyProperty = await prop(projects, "company");
      const via = await prop(files, "projects");
      const targetProperty = await prop(files, "companies");
      const firstCompany = await cp.createItem({ databaseId: companies, properties: { name: "One" } });
      const secondCompany = await cp.createItem({ databaseId: companies, properties: { name: "Two" } });
      const firstProject = await cp.createItem({ databaseId: projects, properties: { name: "First" } });
      const secondProject = await cp.createItem({ databaseId: projects, properties: { name: "Second" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "File" } });
      for (const [project, company] of [
        [firstProject, firstCompany],
        [secondProject, secondCompany],
      ] as const)
        await cp.createRelation({
          relationPropertyId: companyProperty,
          callerItemId: project.id,
          targetItemId: company.id,
        });
      const attach = (projectId: string) =>
        cp.createRelation({ relationPropertyId: via, callerItemId: file.id, targetItemId: projectId });
      const detach = (projectId: string) =>
        cp.deleteRelation({ relationPropertyId: via, callerItemId: file.id, targetItemId: projectId });
      const targets = async () =>
        (await cp.listItemRelations(file.id))
          ?.filter((edge) => edge.relationPropertyId === targetProperty)
          .map((edge) => edge.targetItemId)
          .sort();
      const links = () =>
        withTransaction(data, (client) =>
          client.query<{ state: string }>(
            "SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'companies'",
            [file.id],
          ),
        );
      await attach(firstProject.id);
      expect(await targets()).toEqual([firstCompany.id]);
      expect((await links()).rows).toEqual([{ state: "on" }]);
      await attach(secondProject.id);
      expect(await targets()).toEqual([firstCompany.id, secondCompany.id].sort());
      await detach(firstProject.id);
      expect(await targets()).toEqual([secondCompany.id]);
      await detach(secondProject.id);
      expect(await targets()).toEqual([secondCompany.id]);
      expect((await links()).rowCount).toBe(0);
    });
  });
});
