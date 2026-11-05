import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleManifest } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { runOnce } from "@semprec/queue";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
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
    ...["areas", "projects", "tasks", "events", "people", "companies"].map((source, index) => ({
      key: `fixtureChain.hop${index + 1}`,
      source: { databaseKey: source, propertyKey: "name" },
      target: {
        databaseKey: ["projects", "tasks", "events", "people", "companies", "files"][index]!,
        propertyKey: "name",
      },
      via: {
        databaseKey: ["projects", "tasks", "events", "events", "companies", "files"][index]!,
        relationKey: ["area", "project", "actionItems", "people", "people", "companies"][index]!,
      },
    })),
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

  it("replays the registered worker through five hops and stops before a sixth", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const ids = ["areas", "projects", "tasks", "events", "people", "companies", "files"].map((module) => {
        const db = dbs.find((entry) => entry.ownerModuleId === module);
        if (!db) throw new Error(`Missing ${module}`);
        return db.id;
      });
      const items = [];
      for (const [index, databaseId] of ids.entries())
        items.push(await cp.createItem({ databaseId, properties: index === 0 ? { name: "Chain source" } : {} }));
      const viaKeys = ["area", "project", "actionItems", "people", "people", "companies"];
      const sourceSide = new Set([4]);
      const edges = [];
      for (let index = 1; index < ids.length; index++) {
        const callerIndex = sourceSide.has(index) ? index - 1 : index;
        const targetIndex = sourceSide.has(index) ? index : index - 1;
        const property = (await cp.listProperties(ids[callerIndex]!)).find((entry) => entry.key === viaKeys[index - 1]);
        if (!property) throw new Error("Fixture relation missing");
        edges.push({
          relationPropertyId: property.id,
          callerItemId: items[callerIndex]!.id,
          targetItemId: items[targetIndex]!.id,
        });
      }
      for (let index = 6; index >= 2; index--) await cp.createRelation(edges[index - 1]!);
      return { cp, ids, items, firstEdge: edges[0]! };
    });
    const tasks = createCoreTaskList(data, createActionRegistry());
    await runOnce({ pgPool: data, taskList: tasks });
    await runInTenant(tenant, () => fixture.cp.createRelation(fixture.firstEdge));
    await runOnce({ pgPool: data, taskList: tasks });
    await runInTenant(tenant, async () => {
      for (let index = 1; index <= 5; index++)
        expect((await fixture.cp.getItem(fixture.ids[index]!, fixture.items[index]!.id))?.properties.name).toBe(
          "Chain source",
        );
      expect((await fixture.cp.getItem(fixture.ids[6]!, fixture.items[6]!.id))?.properties.name).toBeUndefined();
    });
  });
});
