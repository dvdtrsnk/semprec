import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { assertRelationCreatableWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let admin: Pool;
let data: Pool;
let tenant: string;
const ruleKey = "fixtureValid.areaNameToProjectName";

describe("link rule propagation", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureLinkRuleValid", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(new URL("./fixtures/linkRuleValidModule.js", import.meta.url).href);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check propagation role", () =>
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
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
    await data?.end();
    await admin?.end();
  });

  it("keeps an existing own value when a via edge is created", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areaDb = databases.find((db) => db.ownerModuleId === "areas");
      const projectDb = databases.find((db) => db.ownerModuleId === "projects");
      if (!areaDb || !projectDb) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areaDb.id, properties: { name: "Source" } });
      const project = await cp.createItem({ databaseId: projectDb.id, properties: { name: "Own" } });
      const via = (await cp.listProperties(projectDb.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      await cp.updateItem({ databaseId: areaDb.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Own");
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'name'", [project.id]),
      );
      expect(links.rowCount).toBe(0);
      expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toEqual([]);
    });
  });

  it("copies an empty target, propagates a change, and does not invalidate an unchanged rerun", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areaDb = databases.find((db) => db.ownerModuleId === "areas");
      const projectDb = databases.find((db) => db.ownerModuleId === "projects");
      if (!areaDb || !projectDb) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areaDb.id, properties: { name: "Source" } });
      const project = await cp.createItem({ databaseId: projectDb.id, properties: {} });
      const via = (await cp.listProperties(projectDb.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Source");
      const links = await withTransaction(data, (client) =>
        client.query<{ id: string; state: string }>(
          "SELECT id, state FROM value_links WHERE item_id = $1 AND property_key = 'name'",
          [project.id],
        ),
      );
      expect(links.rows).toEqual([{ id: expect.any(String), state: "on" }]);
      await cp.updateItem({ databaseId: areaDb.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
        expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Changed");
        expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toHaveLength(1);
        events.length = 0;
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
        expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      const after = await withTransaction(data, (client) =>
        client.query<{ id: string; state: string }>(
          "SELECT id, state FROM value_links WHERE item_id = $1 AND property_key = 'name'",
          [project.id],
        ),
      );
      expect(after.rows).toEqual(links.rows);
      await cp.deleteRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Changed");
      const remaining = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'name'", [project.id]),
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  it("does not create a link during relation admission or mutate a foreign tenant", async () => {
    const foreign = await createTestTenant(admin);
    await runInTenant(foreign, () => seedSystem(data));
    const make = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const cp = createChokePoint(data);
        const databases = await cp.listDatabases();
        const areas = databases.find((db) => db.ownerModuleId === "areas");
        const projects = databases.find((db) => db.ownerModuleId === "projects");
        if (!areas || !projects) throw new Error("Fixture databases missing");
        const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
        const project = await cp.createItem({ databaseId: projects.id, properties: {} });
        const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
        if (!via) throw new Error("Fixture via relation missing");
        return { cp, areas, projects, area, project, via };
      });
    const own = await make(tenant);
    const other = await make(foreign);
    await runInTenant(tenant, async () => {
      await withTransaction(data, (client) =>
        assertRelationCreatableWithClient(client, {
          relationPropertyId: own.via.id,
          callerItemId: own.project.id,
          targetItemId: own.area.id,
        }),
      );
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1", [own.project.id]),
      );
      expect(links.rowCount).toBe(0);
      await own.cp.createRelation({
        relationPropertyId: own.via.id,
        callerItemId: own.project.id,
        targetItemId: own.area.id,
      });
      await handleLinkPropagation(data, { ruleKey, sourceItemId: other.area.id, hop: 1 });
      await handleLinkPropagation(data, { ruleKey, sourceItemId: randomUUID(), hop: 1 });
      expect((await own.cp.getItem(own.projects.id, own.project.id))?.properties.name).toBe("Source");
      expect(await own.cp.getItem(other.projects.id, other.project.id)).toBeNull();
    });
    await runInTenant(foreign, async () => {
      expect((await other.cp.getItem(other.projects.id, other.project.id))?.properties.name).toBeUndefined();
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1", [other.project.id]),
      );
      expect(links.rowCount).toBe(0);
    });
  });
});
