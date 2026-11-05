import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { assertRelationCreatableWithClient } from "../chokePoint/relationOps.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { enqueueLinkPropagation, handleLinkPropagation } from "../valueLinks/linkPropagation.js";
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

  it("updates live linked targets while leaving a user-broken link and value untouched", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Initial" } });
      const live = await cp.createItem({ databaseId: projects.id, properties: {} });
      const broken = await cp.createItem({ databaseId: projects.id, properties: {} });
      for (const item of [live, broken])
        await cp.createRelation({ relationPropertyId: via.id, callerItemId: item.id, targetItemId: area.id });
      await cp.updateItem(
        { databaseId: projects.id, itemId: broken.id, propertiesPatch: { name: "Own choice" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      await cp.updateItem({ databaseId: areas.id, itemId: area.id, propertiesPatch: { name: "New source" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projects.id, live.id))?.properties.name).toBe("New source");
      expect((await cp.getItem(projects.id, broken.id))?.properties.name).toBe("Own choice");
      expect(events.some((event) => event.scope === "item" && event.itemId === live.id)).toBe(true);
      expect(events.some((event) => event.scope === "item" && event.itemId === broken.id)).toBe(false);
      const rows = await withTransaction(data, (client) =>
        client.query<{ item_id: string; state: string }>(
          "SELECT item_id, state FROM value_links WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
          [[live.id, broken.id]],
        ),
      );
      expect(rows.rows).toEqual(
        [
          { item_id: live.id, state: "on" },
          { item_id: broken.id, state: "broken" },
        ].sort((a, b) => a.item_id.localeCompare(b.item_id)),
      );
    });
  });

  it("recomputes from live sources when the queued source is trashed", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Original" } });
      const other = await cp.createItem({ databaseId: areas.id, properties: { name: "Original" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: area.id });
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: other.id });
      expect((await cp.getItem(projects.id, target.id))?.properties.name).toBe("Original");
      await cp.updateItem({ databaseId: areas.id, itemId: other.id, propertiesPatch: { name: "Remaining" } });
      await withTransaction(data, (client) =>
        itemDeleteWithClient(client, areas.id, area.id, {
          queueAffinity: createActionQueueAffinity(),
        }),
      );
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projects.id, target.id))?.properties.name).toBe("Remaining");
      expect(events.some((event) => event.scope === "item" && event.itemId === target.id)).toBe(true);
      const links = await withTransaction(data, (client) =>
        client.query<{ state: string }>("SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'name'", [
          target.id,
        ]),
      );
      expect(links.rows).toEqual([{ state: "on" }]);
    });
  });

  it("commits separate keyset pages for more than one hundred linked targets", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Initial" } });
      const targets: string[] = [];
      for (let index = 0; index < 101; index++) {
        const target = await cp.createItem({ databaseId: projects.id, properties: {} });
        await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: area.id });
        targets.push(target.id);
      }
      await cp.updateItem({ databaseId: areas.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      let commits = 0;
      const originals = new Map<PoolClient, PoolClient["query"]>();
      const onAcquire = (client: PoolClient) => {
        if (originals.has(client)) return;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = client.query;
        originals.set(client, original);
        Object.defineProperty(client, "query", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            if (args[0] === "COMMIT") commits++;
            return Reflect.apply(original, client, args);
          },
        });
      };
      data.on("acquire", onAcquire);
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        data.off("acquire", onAcquire);
        for (const [client, original] of originals)
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: original,
          });
      }
      expect(commits).toBe(2);
      const result = await withTransaction(data, (client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) AND properties->>'name' = 'Changed'",
          [projects.id, targets],
        ),
      );
      expect(result.rows).toEqual([{ count: "101" }]);
    });
  });

  it("keys equal budgets per trusted tenant, keeps distinct hops, and rejects unscoped callers", async () => {
    const foreign = await createTestTenant(admin);
    const source = randomUUID();
    const enqueue = (tenantId: string, hop: number) =>
      runInTenant(tenantId, () =>
        withTransaction(data, (client) => enqueueLinkPropagation(client, ruleKey, source, hop)),
      );
    await enqueue(tenant, 1);
    await enqueue(tenant, 1);
    await enqueue(tenant, 2);
    await enqueue(foreign, 1);
    const client = await data.connect();
    try {
      await expect(enqueueLinkPropagation(client, ruleKey, source, 1)).rejects.toThrow("requires a tenant scope");
      await expect(enqueueLinkPropagation(client, ruleKey, source, 6)).rejects.toThrow("requires a tenant scope");
      await expect(
        runAsSystem("test:reject-system-propagation", () => enqueueLinkPropagation(client, ruleKey, source, 1)),
      ).rejects.toThrow("requires a tenant scope");
      await expect(
        runAsSystem("test:reject-system-propagation", () => enqueueLinkPropagation(client, ruleKey, source, 6)),
      ).rejects.toThrow("requires a tenant scope");
    } finally {
      client.release();
    }
    const result = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'valueLinksPropagate' ORDER BY key",
    );
    expect(result.rows.map((row) => row.key)).toEqual(
      [
        `valueLinksPropagate:${tenant}:${ruleKey}:${source}:1`,
        `valueLinksPropagate:${tenant}:${ruleKey}:${source}:2`,
        `valueLinksPropagate:${foreign}:${ruleKey}:${source}:1`,
      ].sort(),
    );
  });
});
