import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
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
});
